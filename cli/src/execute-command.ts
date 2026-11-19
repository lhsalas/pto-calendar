/**
 * The operations of the read-only PTO CLI.
 *
 * Every operation checks its non-secret arguments before a single store, prompt
 * or request is touched. The local store and the HTTP client are reached only
 * through the public entry points of the shared packages: the credential of one
 * resolved profile, the trusted origin it is bound to, and a projected
 * `PTO_API_ORIGIN` / `PTO_API_TOKEN` pair from the trusted process environment.
 *
 * The result is a finished, allowlisted DTO. The renderer that formats it has no
 * credential, no digest and no raw cause, so nothing it prints can be a secret
 * this module did not already remove.
 */

import { createHash } from 'node:crypto';

import {
  AgentAuthError,
  createAgentAuth,
  readSecretInput,
  type AgentAuth,
  type AgentAuthCredential,
  type AgentAuthEnvironment,
  type AgentAuthErrorCode,
  type AgentAuthOptions,
  type RemoveProfileResult,
  type ResolveInput,
  type SecretInputSource,
} from '@pto-calendar/agent-auth';
import {
  createPtoClient,
  PtoApiError,
  type ListAllClientResult,
  type ListAllQuery,
  type PtoClient,
  type PtoClientOptions,
  type PtoDetail,
  type PtoPageItem,
  type PtoUserSummary,
} from '@pto-calendar/api-client';

import {
  CLI_SCHEMA_VERSION,
  LIST_TIMEOUT_MS,
  MAX_PAGES,
  MAX_PAGE_SIZE,
  MAX_RECORDS,
  READ_TIMEOUT_MS,
  type CliErrorCode,
  type CliFailure,
  type CliResult,
  type CliSuccessFor,
  type CommandKind,
  type ListData,
  type Operation,
  type ReadAuthOptions,
} from './contract.js';

/** The inputs of one operation. The environment is read only through its pair. */
export interface OperationContext {
  readonly env: NodeJS.ProcessEnv;
  readonly input: SecretInputSource;
  /** True only when both stdin and stderr are terminals. */
  readonly interactive: boolean;
  readonly signal: AbortSignal;
  /** Shows the fixed prompt label on stderr. It is called only after the hidden reader starts. */
  readonly prompt: (message: string) => void;
}

/** The API surface a read command may use. It has no write method at all. */
export type ReadClient = Pick<PtoClient, 'getIdentity' | 'listAll' | 'getDetail'>;

/**
 * The seam the tests use to replace the stores and the transport.
 *
 * The public path passes the real factories of the shared packages. Nothing
 * outside this module can choose a store, a header or a URL through it.
 */
export interface ExecuteDependencies {
  readonly createAuth: (options?: AgentAuthOptions) => AgentAuth;
  readonly createClient: (options: PtoClientOptions) => ReadClient;
  /** A monotonic clock in milliseconds. */
  readonly now: () => number;
}

const DEFAULT_DEPENDENCIES: ExecuteDependencies = {
  createAuth: createAgentAuth,
  createClient: createPtoClient,
  now: performance.now.bind(performance),
};

/** The number of GET retries the shared client may spend inside its own budget. */
const READ_RETRIES = 2;

/** The longest date range the API accepts, in days, inclusive. */
const MAX_RANGE_DAYS = 366;

const DAY_MS = 86_400_000;

/** The length of the secret component at the end of a personal access token. */
const SECRET_LENGTH = 64;

/** The fixed label of the hidden prompt. It is the only text this module asks to show. */
const SECRET_PROMPT = 'Paste the personal access token, then press Enter (input is hidden): ';

/** The placeholder that replaces any displayed secret-shaped text. */
const REDACTED = '[redacted]';

/** A category and a fixed, safe message. Nothing else is ever shown. */
interface ErrorMapping {
  readonly code: CliErrorCode;
  readonly message: string;
}

/** The HTTP correlation of a failure. Each field is null when it is unavailable. */
interface Correlation {
  readonly status: number | null;
  readonly requestId: string | null;
  readonly retryAfterMs: number | null;
}

const NO_CORRELATION: Correlation = { status: null, requestId: null, retryAfterMs: null };

/** The fixed texts of this module. None of them carries an argument, a path or a token. */
const TEXT = {
  cancelled: 'The command was cancelled.',
  unexpected: 'An unexpected local error occurred. No further details are available.',
  profile: 'Use a profile name of 1 to 32 lowercase letters, digits, underscores or hyphens.',
  origin: 'Use an https origin, or an explicitly allowed loopback http origin.',
  storage: 'Choose keyring or file storage.',
  flag: 'Check the command flags and try again.',
  bound: 'Use a whole number within the documented range for this option.',
  uuid: 'Use a canonical UUID for the entry or owner.',
  dates: 'Use real calendar dates in YYYY-MM-DD form.',
  dateOrder: 'The end date must not be before the start date.',
  dateSpan: 'The date range must cover at most 366 days, inclusive.',
  ownerConflict: 'Choose either --mine or --owner, not both.',
  tokenSource: 'Provide the token with --token-stdin, or run in an interactive terminal.',
  hiddenInput:
    'Hidden entry needs an interactive terminal that can hide input. Use --token-stdin with exactly one line instead.',
  prompt: 'The secret prompt could not be shown. Nothing was read.',
  profileMissing: 'No local profile with this name exists.',
  unconfirmed:
    'The local removal could not be confirmed. Check the local profile before retrying; removal never revokes the token on the server.',
  removed:
    'The credential was removed from this machine. This does not revoke the token on the server: revoke or replace it in the signed-in browser UI.',
  incomplete:
    'The calendar read is incomplete. Rows already read are included as partial data; missing rows are not confirmed absent.',
} as const;

const CANCELLED: ErrorMapping = { code: 'CANCELLED', message: TEXT.cancelled };
const INCOMPLETE: ErrorMapping = { code: 'INCOMPLETE', message: TEXT.incomplete };
const UNEXPECTED: ErrorMapping = { code: 'LOCAL', message: TEXT.unexpected };

/** Every failure of the local store, mapped to one category and one fixed message. */
const AGENT_AUTH_MAPPING: Record<AgentAuthErrorCode, ErrorMapping> = {
  INVALID_PROFILE: { code: 'USAGE', message: TEXT.profile },
  INVALID_ORIGIN: { code: 'USAGE', message: TEXT.origin },
  INVALID_TOKEN: {
    code: 'AUTH',
    message: 'The secret input is not a valid personal access token.',
  },
  INVALID_OPTIONS: {
    code: 'AUTH',
    message:
      'The managed credential settings are incomplete or invalid. Set both PTO_API_ORIGIN and PTO_API_TOKEN, or use a local profile.',
  },
  AMBIGUOUS_CREDENTIALS: {
    code: 'USAGE',
    message: 'Choose either a local profile or the managed environment credential, not both.',
  },
  ORIGIN_MISMATCH: {
    code: 'USAGE',
    message: 'The expected origin does not match the origin bound to this credential.',
  },
  PROFILE_NOT_CONFIGURED: {
    code: 'AUTH',
    message: 'No local credential is configured for this profile. Run pto auth set to store one.',
  },
  PROFILE_CONFLICT: {
    code: 'CONFLICT',
    message:
      'The local profile is bound to another origin or storage backend. Run pto auth remove before changing it.',
  },
  PROFILE_CORRUPT: {
    code: 'LOCAL',
    message: 'The local profile could not be read as a valid profile.',
  },
  CREDENTIAL_MISSING: {
    code: 'AUTH',
    message:
      'The profile is configured, but its credential is missing from the local store. Run pto auth set again.',
  },
  FILE_UNSAFE: {
    code: 'LOCAL',
    message: 'The local profile path is not safe for credential storage.',
  },
  FILE_UNAVAILABLE: {
    code: 'LOCAL',
    message: 'Profile file storage is unavailable on this machine.',
  },
  FILE_BUSY: {
    code: 'LOCAL',
    message:
      'The local profile is busy or has a stale lock. Make sure no other profile operation is running.',
  },
  KEYRING_UNSUPPORTED: {
    code: 'LOCAL',
    message: 'This platform has no supported operating system credential store.',
  },
  KEYRING_UNAVAILABLE: {
    code: 'AUTH',
    message:
      'The operating system credential store is unavailable in this session, so the credential was not read.',
  },
  KEYRING_LOCKED: {
    code: 'AUTH',
    message: 'The operating system credential store is locked. Unlock it, then try again.',
  },
  KEYRING_AMBIGUOUS: {
    code: 'AUTH',
    message:
      'More than one operating system credential matches this profile. Remove the extra entry, then try again.',
  },
  KEYRING_FAILED: {
    code: 'AUTH',
    message:
      'The operating system credential store could not confirm the operation. Check the profile before retrying.',
  },
  INPUT_REQUIRED: {
    code: 'USAGE',
    message: 'Provide one personal access token on stdin, followed by a newline and end of input.',
  },
  INPUT_UNAVAILABLE: {
    code: 'USAGE',
    message:
      'The secret input is not usable. Use --token-stdin with exactly one line, or an interactive terminal.',
  },
  INPUT_CANCELLED: {
    code: 'CANCELLED',
    message: 'The secret entry was cancelled. Nothing was stored.',
  },
};

/** Every failure the service or the transport reports, mapped to one category. */
const API_MAPPING: ReadonlyMap<string, ErrorMapping> = new Map<string, ErrorMapping>([
  [
    'UNAUTHENTICATED',
    {
      code: 'AUTH',
      message:
        'The service did not accept this credential. It may be revoked or expired. Replace or revoke it in the signed-in browser UI, then run pto auth set again.',
    },
  ],
  [
    'FORBIDDEN',
    {
      code: 'PERMISSION',
      message:
        'This credential lacks the scope this command needs. Ask for a token with the required read scope in the signed-in browser UI.',
    },
  ],
  [
    'SESSION_REQUIRED',
    {
      code: 'PERMISSION',
      message: 'This operation needs a browser session, not a personal access token.',
    },
  ],
  ['CSRF_REJECTED', { code: 'PERMISSION', message: 'The service refused the request origin.' }],
  [
    'NOT_FOUND',
    {
      code: 'NOT_FOUND',
      message: 'No PTO entry matches this identifier, or this credential cannot see it.',
    },
  ],
  [
    'CONFLICT',
    { code: 'CONFLICT', message: 'The service reports a conflict with an existing entry.' },
  ],
  [
    'IDEMPOTENCY_CONFLICT',
    { code: 'CONFLICT', message: 'The idempotency key was already used for another request.' },
  ],
  [
    'STALE_WRITE',
    {
      code: 'CONFLICT',
      message: 'The entry changed since it was read. Read it again before retrying.',
    },
  ],
  [
    'IDEMPOTENCY_EXPIRED',
    {
      code: 'CONFLICT',
      message:
        'The create key expired. Reconcile existing PTO records before attempting another create.',
    },
  ],
  [
    'RATE_LIMITED',
    {
      code: 'QUOTA',
      message:
        'The service is rate limiting this credential. Wait for the Retry-After period, then try again.',
    },
  ],
  [
    'TOKEN_LIMIT_REACHED',
    { code: 'QUOTA', message: 'The maximum number of personal access tokens already exists.' },
  ],
  ['VALIDATION_ERROR', { code: 'USAGE', message: 'The service rejected the request parameters.' }],
  ['NOT_READY', { code: 'NETWORK', message: 'The service is not ready yet. Try again later.' }],
  ['INTERNAL_ERROR', { code: 'NETWORK', message: 'The service could not complete the request.' }],
  [
    'PRECONDITION_REQUIRED',
    {
      code: 'LOCAL',
      message: 'The service requires a write precondition that this read-only CLI does not send.',
    },
  ],
  [
    'IDEMPOTENCY_KEY_REQUIRED',
    {
      code: 'LOCAL',
      message: 'The service requires an idempotency key that this read-only CLI does not send.',
    },
  ],
  ['INVALID_INPUT', { code: 'USAGE', message: 'The request parameters are not valid.' }],
  [
    'INVALID_OPTIONS',
    { code: 'LOCAL', message: 'The client settings are not usable on this machine.' },
  ],
  [
    'INVALID_RESPONSE',
    { code: 'NETWORK', message: 'The service returned an answer this CLI cannot use.' },
  ],
  ['ABORTED', CANCELLED],
  ['TIMEOUT', { code: 'NETWORK', message: 'The service did not answer within the time limit.' }],
  ['NETWORK_ERROR', { code: 'NETWORK', message: 'The service could not be reached.' }],
  [
    'REDIRECT',
    {
      code: 'NETWORK',
      message: 'The service answered with a redirect, which this CLI does not follow.',
    },
  ],
  [
    'HTTP_ERROR',
    { code: 'NETWORK', message: 'The service answered with an error this CLI does not recognize.' },
  ],
]);

/**
 * A failure of this module that is already classified.
 *
 * The message is always one of the fixed texts above, never a cause, so it can
 * be shown unchanged.
 */
class CommandError extends Error {
  constructor(
    readonly mapping: ErrorMapping,
    readonly correlation: Correlation,
  ) {
    super(mapping.message);
    this.name = 'CommandError';
  }
}

function usageError(message: string): CommandError {
  return new CommandError({ code: 'USAGE', message }, NO_CORRELATION);
}

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new CommandError(CANCELLED, NO_CORRELATION);
}

/** The per-operation state: the dependencies, the context and the redaction in force. */
interface Run {
  readonly dependencies: ExecuteDependencies;
  readonly context: OperationContext;
  /** Replaced by the credential-specific scrubber once a profile is resolved. */
  scrub: Scrub;
}

/* ------------------------------------------------------------------------- */
/* Redaction: displayed text never carries a control byte or a secret.      */
/* ------------------------------------------------------------------------- */

/** A function that makes displayed text safe. */
type Scrub = (value: string) => string;

/** Control, format, unpaired surrogate and line/paragraph separator characters. */
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

/** Any personal-token-shaped text, complete or truncated. */
const PTO_SHAPED = /pto_pat_[A-Za-z0-9._-]*/gi;

/** A digest or a secret component: any run of at least 64 hexadecimal digits. */
const DIGEST_SHAPED = /[0-9a-f]{64,}/gi;

const WHITESPACE = /\s+/g;

/** A pattern that never matches, used when there is no known secret. */
const NEVER_MATCHES = '(?!)';

/** A request identifier that is safe to keep and to show. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,200}$/;

function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A scrubber for the given exact secrets.
 *
 * Invisible and control characters are removed before matching, so a secret
 * split by them still matches. Known secrets are matched case-insensitively,
 * then the token shape and any digest-shaped run are replaced.
 */
function scrubberFor(secrets: readonly string[]): Scrub {
  const alternatives = secrets.map(escapeForPattern).join('|') || NEVER_MATCHES;
  const known = new RegExp(alternatives, 'gi');
  return (value) =>
    value
      .normalize('NFC')
      .replace(UNSAFE_CHARACTERS, '')
      .replace(known, REDACTED)
      .replace(PTO_SHAPED, REDACTED)
      .replace(DIGEST_SHAPED, REDACTED)
      .replace(WHITESPACE, ' ')
      .trim();
}

/** The scrubber for text when no credential has been resolved yet. */
const PLAIN_SCRUB: Scrub = scrubberFor([]);

/**
 * The scrubber for one resolved credential.
 *
 * The exact token, its secret component (the last 64 characters of a validated
 * token) and the SHA-256 digest of that secret are all removed. The digest uses
 * the same algorithm as the backend's token domain: SHA-256 of the UTF-8 secret.
 */
function scrubberForCredential(token: string): Scrub {
  const secret = token.slice(-SECRET_LENGTH);
  const digest = createHash('sha256').update(secret, 'utf8').digest('hex');
  return scrubberFor([token, secret, digest]);
}

/** A request identifier is kept only when it looks like one and carries no secret. */
function safeRequestId(value: string | null, scrub: Scrub): string | null {
  if (value === null) return null;
  if (!SAFE_REQUEST_ID.test(value)) return null;
  return scrub(value) === value ? value : null;
}

function correlationOf(error: PtoApiError, scrub: Scrub): Correlation {
  return {
    status: error.status > 0 ? error.status : null,
    requestId: safeRequestId(error.requestId, scrub),
    retryAfterMs: error.retryAfterMs,
  };
}

function mappingFor(error: PtoApiError): ErrorMapping {
  return API_MAPPING.get(error.code) ?? UNEXPECTED;
}

/* ------------------------------------------------------------------------- */
/* Validation: every non-secret argument is checked before any input or store. */
/* ------------------------------------------------------------------------- */

const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** The same origin admission rule the shared API client and the local store use. */
const ORIGIN_SHAPE =
  /^https?:\/\/(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[1-9][0-9]{0,4})?\/?$/i;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]', 'localhost']);

const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An admitted origin, or null.
 *
 * Only an origin with no path, query, userinfo or alternate host spelling is
 * admitted. Plain HTTP is admitted only for the exact loopback hosts after the
 * explicit opt-in.
 */
function admitOrigin(value: unknown, allowLoopbackHttp: boolean): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null;
  const matched = ORIGIN_SHAPE.exec(value);
  if (matched === null) return null;
  const host = matched[1]!.toLowerCase();
  if (host.includes('..')) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.hostname !== host) return null;
  if (url.protocol === 'http:' && !(allowLoopbackHttp && LOOPBACK_HOSTS.has(host))) return null;
  return url.origin;
}

function requireProfile(value: unknown): string {
  if (typeof value !== 'string' || !PROFILE_NAME.test(value)) throw usageError(TEXT.profile);
  return value;
}

function requireOrigin(value: unknown, allowLoopbackHttp: boolean): string {
  const origin = admitOrigin(value, allowLoopbackHttp);
  if (origin === null) throw usageError(TEXT.origin);
  return origin;
}

function requireFlag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw usageError(TEXT.flag);
  return value;
}

function requireStorage(value: unknown): 'keyring' | 'file' {
  if (value !== 'keyring' && value !== 'file') throw usageError(TEXT.storage);
  return value;
}

function requireBounded(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw usageError(TEXT.bound);
  }
  return value;
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_SHAPE.test(value)) throw usageError(TEXT.uuid);
  return value;
}

/** A real calendar day in the documented form, with no rollover such as February 30. */
function isRealDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY_SHAPE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** An ordered, inclusive range of real days, at most 366 days long. */
function requireWindow(
  from: unknown,
  to: unknown,
): { readonly start: string; readonly end: string } {
  if (!isRealDay(from) || !isRealDay(to)) throw usageError(TEXT.dates);
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (end < start) throw usageError(TEXT.dateOrder);
  if (Math.round((end - start) / DAY_MS) + 1 > MAX_RANGE_DAYS) throw usageError(TEXT.dateSpan);
  return { start: from, end: to };
}

/* ------------------------------------------------------------------------- */
/* Credential input: the managed pair is projected, never read otherwise.    */
/* ------------------------------------------------------------------------- */

/** The validated, non-secret read options of one command. */
interface ReadOptions {
  readonly allowLoopbackHttp: boolean;
  readonly profile?: string;
  readonly origin?: string;
}

function readOptions(input: ReadAuthOptions): ReadOptions {
  const allowLoopbackHttp = requireFlag(input.allowLoopbackHttp);
  const profile = input.profile === undefined ? undefined : requireProfile(input.profile);
  // A saved binding may have opted in to loopback HTTP already. Only check
  // syntax here; the resolver checks permission with the selected credential.
  const origin = input.origin === undefined ? undefined : requireOrigin(input.origin, true);
  return {
    allowLoopbackHttp,
    ...(profile === undefined ? {} : { profile }),
    ...(origin === undefined ? {} : { origin }),
  };
}

/**
 * The trusted host pair, projected for the shared facade.
 *
 * Only the two own fields are copied, and only when they are present. A field
 * that is present is passed on even when it is malformed, so the facade can
 * refuse a partial pair instead of silently falling back to a profile.
 */
function managedEnvironment(env: NodeJS.ProcessEnv): AgentAuthEnvironment | undefined {
  const record: { PTO_API_ORIGIN?: string; PTO_API_TOKEN?: string } = {};
  if (Object.hasOwn(env, 'PTO_API_ORIGIN')) record.PTO_API_ORIGIN = env.PTO_API_ORIGIN;
  if (Object.hasOwn(env, 'PTO_API_TOKEN')) record.PTO_API_TOKEN = env.PTO_API_TOKEN;
  return Object.keys(record).length === 0 ? undefined : record;
}

function resolveInputFor(options: ReadOptions, env: NodeJS.ProcessEnv): ResolveInput {
  const managed = managedEnvironment(env);
  return {
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    ...(options.origin === undefined ? {} : { baseUrl: options.origin }),
    allowLoopbackHttp: options.allowLoopbackHttp,
    ...(managed === undefined ? {} : { env: managed }),
  };
}

async function resolveCredential(run: Run, options: ReadOptions): Promise<AgentAuthCredential> {
  const bundle = await run.dependencies
    .createAuth()
    .resolve(resolveInputFor(options, run.context.env));
  // The current local backend is not abortable; a cancellation while it runs
  // must still prevent creating a client or starting a request.
  assertNotCancelled(run.context.signal);
  return bundle;
}

/**
 * The client options of one resolved binding.
 *
 * The client is bound to the origin the facade resolved, never to an origin the
 * command named. The per-request deadline is always passed explicitly.
 */
function clientOptionsFor(bundle: AgentAuthCredential, timeoutMs: number): PtoClientOptions {
  return {
    baseUrl: bundle.baseUrl,
    credential: { origin: bundle.credential.origin, token: bundle.credential.token },
    allowLoopbackHttp: bundle.allowLoopbackHttp,
    timeoutMs,
    readRetries: READ_RETRIES,
  };
}

/* ------------------------------------------------------------------------- */
/* Budget: one monotonic deadline per API phase, never reset by a retry.     */
/* ------------------------------------------------------------------------- */

interface Budget {
  /** The remaining milliseconds, always positive. An exhausted budget is a timeout. */
  remaining(): number;
}

/**
 * A deadline of `totalMs` from now.
 *
 * A non-positive value is never passed to the client: the client would read it as
 * "no deadline" and grant its default. An exhausted budget stops here instead.
 */
function budgetOf(now: () => number, totalMs: number): Budget {
  const deadline = now() + totalMs;
  return {
    remaining: (): number => {
      const left = Math.ceil(deadline - now());
      if (left <= 0) throw new PtoApiError('TIMEOUT');
      return left;
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Projection: only allowlisted fields, scrubbed text, nothing else.         */
/* ------------------------------------------------------------------------- */

function projectUser(user: PtoUserSummary, scrub: Scrub): PtoUserSummary {
  return { id: user.id, name: scrub(user.name), colorCode: scrub(user.colorCode) };
}

function projectItem(item: PtoPageItem, scrub: Scrub): PtoPageItem {
  return {
    id: item.id,
    user: projectUser(item.user, scrub),
    startDate: item.startDate,
    endDate: item.endDate,
    dayPart: item.dayPart,
    note: null,
    version: item.version,
  };
}

/** A detail carries only the note the service actually returned, scrubbed. */
function projectDetail(detail: PtoDetail, scrub: Scrub): PtoDetail {
  return {
    id: detail.id,
    user: projectUser(detail.user, scrub),
    startDate: detail.startDate,
    endDate: detail.endDate,
    dayPart: detail.dayPart,
    note: detail.note === null ? null : scrub(detail.note),
    version: detail.version,
  };
}

function listDataOf(result: ListAllClientResult, scrub: Scrub): ListData {
  return {
    items: result.items.map((item) => projectItem(item, scrub)),
    complete: result.complete,
    reason: result.reason,
    pages: result.pages,
  };
}

/* ------------------------------------------------------------------------- */
/* Results: one builder for each shape, so no field is ever ad hoc.          */
/* ------------------------------------------------------------------------- */

function success<K extends CommandKind>(
  command: K,
  data: CliSuccessFor<K>['data'],
): CliSuccessFor<K> {
  return { schemaVersion: CLI_SCHEMA_VERSION, ok: true, command, data };
}

function failure(
  command: CommandKind,
  mapping: ErrorMapping,
  correlation: Correlation,
  partial?: ListData,
): CliFailure {
  return {
    schemaVersion: CLI_SCHEMA_VERSION,
    ok: false,
    command,
    error: { code: mapping.code, message: mapping.message, ...correlation },
    ...(partial === undefined ? {} : { partial }),
  };
}

/* ------------------------------------------------------------------------- */
/* Secret input: explicit stdin, or a hidden terminal that is started first. */
/* ------------------------------------------------------------------------- */

function readFromStdin(context: OperationContext): Promise<string> {
  return readSecretInput({ mode: 'stdin', input: context.input, signal: context.signal });
}

/**
 * Reads one hidden line from a terminal.
 *
 * The hidden reader is started before the label is shown, so the label is never
 * written ahead of raw input collection. If the label cannot be shown, the reader
 * is cancelled and its raw mode is restored before the failure is reported.
 */
async function readFromTerminal(context: OperationContext): Promise<string> {
  // Refuse before the label: a label is never shown for an input that cannot be hidden.
  if (context.input.isTTY !== true || typeof context.input.setRawMode !== 'function') {
    throw usageError(TEXT.hiddenInput);
  }
  const cancel = new AbortController();
  const signal = AbortSignal.any([context.signal, cancel.signal]);
  const secret = readSecretInput({ mode: 'tty', input: context.input, signal });
  if (context.input.isRaw !== true) {
    cancel.abort();
    await secret.catch(() => undefined);
    throw usageError(TEXT.hiddenInput);
  }
  try {
    context.prompt(SECRET_PROMPT);
  } catch {
    cancel.abort();
    await secret.catch(() => undefined);
    throw new CommandError({ code: 'LOCAL', message: TEXT.prompt }, NO_CORRELATION);
  }
  return secret;
}

/* ------------------------------------------------------------------------- */
/* Operations.                                                                */
/* ------------------------------------------------------------------------- */

type AuthSetCommand = Extract<Operation, { readonly kind: 'auth-set' }>;
type AuthStatusCommand = Extract<Operation, { readonly kind: 'auth-status' }>;
type AuthRemoveCommand = Extract<Operation, { readonly kind: 'auth-remove' }>;
type ListCommand = Extract<Operation, { readonly kind: 'list' }>;
type GetCommand = Extract<Operation, { readonly kind: 'get' }>;

async function authSet(run: Run, command: AuthSetCommand): Promise<CliResult> {
  const profile = requireProfile(command.profile);
  const allowLoopbackHttp = requireFlag(command.allowLoopbackHttp);
  const origin = requireOrigin(command.origin, allowLoopbackHttp);
  const storage = requireStorage(command.storage);
  const tokenStdin = requireFlag(command.tokenStdin);
  // Only an explicit stdin or an interactive terminal may supply the secret.
  if (!tokenStdin && !run.context.interactive) throw usageError(TEXT.tokenSource);
  assertNotCancelled(run.context.signal);
  const token = tokenStdin ? await readFromStdin(run.context) : await readFromTerminal(run.context);
  // A cancel after the read stores nothing: the secret is dropped here.
  assertNotCancelled(run.context.signal);
  const stored = await run.dependencies.createAuth().setProfile({
    profile,
    baseUrl: origin,
    token,
    allowLoopbackHttp,
    storage,
  });
  return success('auth-set', {
    profile: stored.profile,
    origin: scrubberForCredential(token)(stored.origin),
    source: stored.source,
  });
}

async function authStatus(run: Run, command: AuthStatusCommand): Promise<CliResult> {
  const options = readOptions(command.auth);
  assertNotCancelled(run.context.signal);
  const bundle = await resolveCredential(run, options);
  run.scrub = scrubberForCredential(bundle.credential.token);
  const client = run.dependencies.createClient(clientOptionsFor(bundle, READ_TIMEOUT_MS));
  const budget = budgetOf(run.dependencies.now, READ_TIMEOUT_MS);
  // The one live check: the credential is verified, and only its safe fields are kept.
  const identity = await client.getIdentity({
    signal: run.context.signal,
    timeoutMs: budget.remaining(),
  });
  assertNotCancelled(run.context.signal);
  return success('auth-status', {
    profile: bundle.profile,
    origin: run.scrub(bundle.baseUrl),
    source: bundle.source,
    ownerId: identity.id,
    scopes: [...identity.auth.scopes],
    expiresAt: identity.auth.expiresAt,
  });
}

/** Removes the local profile. A missing profile is reported as not found. */
async function removeLocally(run: Run, profile: string): Promise<RemoveProfileResult> {
  try {
    return await run.dependencies.createAuth().removeProfile(profile);
  } catch (error) {
    if (error instanceof AgentAuthError && error.code === 'PROFILE_NOT_CONFIGURED') {
      throw new CommandError({ code: 'NOT_FOUND', message: TEXT.profileMissing }, NO_CORRELATION);
    }
    throw error;
  }
}

async function authRemove(run: Run, command: AuthRemoveCommand): Promise<CliResult> {
  const profile = requireProfile(command.profile);
  assertNotCancelled(run.context.signal);
  const removal = await removeLocally(run, profile);
  // A removal that the store did not confirm is never reported as a removal.
  if (!removal.removed)
    throw new CommandError({ code: 'LOCAL', message: TEXT.unconfirmed }, NO_CORRELATION);
  return success('auth-remove', {
    profile: removal.profile,
    source: removal.source,
    removed: true,
    guidance: TEXT.removed,
  });
}

async function list(run: Run, command: ListCommand): Promise<CliResult> {
  const options = readOptions(command.auth);
  const range = requireWindow(command.from, command.to);
  const owner = ownerOf(command);
  const pageSize = requireBounded(command.pageSize, 1, MAX_PAGE_SIZE);
  const maxPages = requireBounded(command.maxPages, 1, MAX_PAGES);
  assertNotCancelled(run.context.signal);
  const bundle = await resolveCredential(run, options);
  run.scrub = scrubberForCredential(bundle.credential.token);
  const client = run.dependencies.createClient(clientOptionsFor(bundle, LIST_TIMEOUT_MS));
  // One budget covers the identity call and the traversal together.
  const budget = budgetOf(run.dependencies.now, LIST_TIMEOUT_MS);
  let userId = owner.userId;
  if (owner.mine) {
    const identity = await client.getIdentity({
      signal: run.context.signal,
      timeoutMs: budget.remaining(),
    });
    userId = identity.id;
  }
  const query: ListAllQuery = {
    start: range.start,
    end: range.end,
    ...(userId === undefined ? {} : { userId }),
    limit: pageSize,
  };
  const traversal = await client.listAll(query, {
    signal: run.context.signal,
    timeoutMs: budget.remaining(),
    maxPages,
    maxRecords: MAX_RECORDS,
  });
  return listOutcome(traversal, run);
}

/** The owner filter: `--mine` or a validated `--owner`, never both. */
function ownerOf(command: ListCommand): { readonly mine: boolean; readonly userId?: string } {
  const mine = requireFlag(command.mine);
  if (command.ownerId === undefined) return { mine };
  if (mine) throw usageError(TEXT.ownerConflict);
  return { mine: false, userId: requireUuid(command.ownerId) };
}

async function get(run: Run, command: GetCommand): Promise<CliResult> {
  const options = readOptions(command.auth);
  const id = requireUuid(command.id);
  assertNotCancelled(run.context.signal);
  const bundle = await resolveCredential(run, options);
  run.scrub = scrubberForCredential(bundle.credential.token);
  const client = run.dependencies.createClient(clientOptionsFor(bundle, READ_TIMEOUT_MS));
  const budget = budgetOf(run.dependencies.now, READ_TIMEOUT_MS);
  const detail = await client.getDetail(id, {
    signal: run.context.signal,
    timeoutMs: budget.remaining(),
  });
  assertNotCancelled(run.context.signal);
  return success('get', projectDetail(detail, run.scrub));
}

/**
 * The traversal error that may name a category.
 *
 * A budget stop and a drift stop are not service failures: the client's fixed
 * local code for them is not a category, so they report incomplete instead.
 */
function usableError(result: ListAllClientResult): ListAllClientResult['error'] {
  if (result.reason === 'budget' || result.reason === 'drift') return undefined;
  return result.error;
}

/**
 * The outcome of a traversal.
 *
 * An abort beats every other classification. A complete traversal is a
 * success. Any other stop is incomplete: with rows it is INCOMPLETE, and with
 * no rows a usable service or transport failure keeps its own category.
 */
function listOutcome(result: ListAllClientResult, run: Run): CliResult {
  if (run.context.signal.aborted || result.reason === 'aborted') {
    // A cancelled run is never complete, even when the last page had already arrived.
    const aborted: ListData = {
      ...listDataOf(result, run.scrub),
      complete: false,
      reason: 'aborted',
    };
    return failure('list', CANCELLED, NO_CORRELATION, aborted);
  }
  const partial = listDataOf(result, run.scrub);
  if (result.complete) return success('list', partial);
  const cause = usableError(result);
  if (cause !== undefined && result.items.length === 0) {
    return failure('list', mappingFor(cause), correlationOf(cause, run.scrub), partial);
  }
  const correlation = cause === undefined ? NO_CORRELATION : correlationOf(cause, run.scrub);
  return failure('list', INCOMPLETE, correlation, partial);
}

/* ------------------------------------------------------------------------- */
/* Entry points.                                                              */
/* ------------------------------------------------------------------------- */

/** Turns any thrown value into one classified, fixed failure. */
function failureFor(kind: CommandKind, error: unknown, run: Run): CliFailure {
  // An abort beats every other classification, so no other category leaks out.
  if (run.context.signal.aborted) return failure(kind, CANCELLED, NO_CORRELATION);
  if (error instanceof CommandError) return failure(kind, error.mapping, error.correlation);
  if (error instanceof AgentAuthError) {
    return failure(kind, AGENT_AUTH_MAPPING[error.code], NO_CORRELATION);
  }
  if (error instanceof PtoApiError) {
    return failure(kind, mappingFor(error), correlationOf(error, run.scrub));
  }
  return failure(kind, UNEXPECTED, NO_CORRELATION);
}

/**
 * Runs one operation with the given dependencies.
 *
 * This is the internal test seam. The public entry point is `executeCommand`,
 * which uses the real stores, the real client and the real secret reader.
 */
export async function executeWithDependencies(
  dependencies: ExecuteDependencies,
  command: Operation,
  context: OperationContext,
): Promise<CliResult> {
  const run: Run = { dependencies, context, scrub: PLAIN_SCRUB };
  try {
    switch (command.kind) {
      case 'auth-set':
        return await authSet(run, command);
      case 'auth-status':
        return await authStatus(run, command);
      case 'auth-remove':
        return await authRemove(run, command);
      case 'list':
        return await list(run, command);
      case 'get':
        return await get(run, command);
      default:
        throw new CommandError(UNEXPECTED, NO_CORRELATION);
    }
  } catch (error) {
    return failureFor(command.kind, error, run);
  }
}

/**
 * Runs one operation of the CLI against the real local store and the real API client.
 *
 * Every failure of a well-formed operation resolves to a classified result with
 * a fixed category and message. A call without a command object and a context
 * is a programming error of the caller, and only that can reject.
 */
export async function executeCommand(
  command: Operation,
  context: OperationContext,
): Promise<CliResult> {
  return executeWithDependencies(DEFAULT_DEPENDENCIES, command, context);
}
