/**
 * The write operations of the PTO CLI: `create`, `update` and `delete`.
 *
 * Every write runs the same ordered gates, and each one is a precondition of
 * the next:
 *
 *   1. the local switch: the trusted host environment must set `PTO_CLI_WRITES=1`
 *      as an own field, never from a dotenv file or a profile;
 *   2. the confirmation mode: a terminal always asks, while a pipe needs an
 *      explicit `--yes` and never prompts;
 *   3. the non-secret arguments, checked before any store, prompt or request;
 *   4. the credential of one profile, bound to its origin, and the live
 *      `/auth/me` identity of that credential;
 *   5. the live scope, owner and role rules, checked before any preview;
 *   6. the preview and the explicit confirmation, when a terminal asks;
 *   7. one versioned request, started only after a last cancellation check.
 *
 * A create also passes the durable intent journal, which owns the idempotency
 * key and never lets a second plain invocation dispatch while one is pending.
 * A verified create success is handed to the host while the journal lease still
 * holds, and only a delivered success clears the pending record. An update or a
 * delete loads the exact target detail and compares the explicit expected version
 * before anything is sent, and a stale answer is refetched once.
 *
 * Results are finished DTOs: an allowlisted record, a fixed message and typed
 * recovery facts. A write that may already have been applied is never reported
 * as failed or cancelled, and a known success stays a success even when the
 * caller aborts after reading it or when its delivery hook fails.
 */

import { createHash } from 'node:crypto';

import {
  AgentAuthError,
  createAgentAuth,
  type AgentAuth,
  type AgentAuthCredential,
  type AgentAuthEnvironment,
  type AgentAuthErrorCode,
  type AgentAuthOptions,
  type ResolveInput,
} from '@pto-calendar/agent-auth';
import {
  createPtoClient,
  PtoApiError,
  type CreatePtoPayload,
  type CreatePtoResult,
  type PatchPtoChanges,
  type PtoClient,
  type PtoClientOptions,
  type PtoDayPart,
  type PtoDetail,
  type PtoIdentity,
  type PtoRecord,
  type PtoScope,
} from '@pto-calendar/api-client';

import {
  CLI_SCHEMA_VERSION,
  READ_TIMEOUT_MS,
  type CliErrorCode,
  type CliSuccessFor,
  type ReadAuthOptions,
} from './contract.js';
import type { OperationContext } from './execute-command.js';
import {
  CreateIntentError,
  withCreateIntent,
  type CreateIntentBinding,
  type CreateIntentCode,
  type CreateIntentLease,
} from './create-intent.js';
import type { WriteCommand, WriteRecord, WriteRecovery } from './write-contract.js';

/**
 * The inputs of one write: the operation context plus the host's confirmation.
 *
 * `publishCreateResult` is optional and belongs to the real host. It receives the
 * single known success of a create while the journal lease still holds, and it
 * resolves `true` only once the success was rendered or flushed. Only then is the
 * pending record removed. Without the hook, a verified success clears the record
 * directly, which is the behavior of direct and unit callers.
 */
export interface WriteContext extends OperationContext {
  /**
   * Presents the preview and resolves `true` only for an explicit `yes`. The
   * host may reject when its stream fails; a rejection is a refusal.
   */
  readonly confirm: (preview: string) => Promise<boolean>;
  /**
   * Delivers the known success of a create while its pending record is still held.
   *
   * Resolves `true` once the result was delivered. `false`, a rejection, or a delivery
   * still pending when the caller aborts keeps the pending record for reconciliation.
   * The known success is still returned to the caller; it is never reclassified as a
   * failure and never retried.
   */
  readonly publishCreateResult?: (result: CliSuccessFor<'create'>) => Promise<boolean>;
}

/** The API surface a write may use: the live reads and the three versioned operations. */
export type WriteClient = Pick<
  PtoClient,
  'getIdentity' | 'getDetail' | 'create' | 'patch' | 'delete'
>;

/** The durable create journal, exactly as the contract defines it. */
export type CreateJournal = typeof withCreateIntent;

/**
 * The seams of this module.
 *
 * Production calls use the real factories. Only the focused tests replace them,
 * and nothing outside this module can choose a store, a header or a URL.
 */
export interface WriteDependencies {
  readonly createAuth: (options?: AgentAuthOptions) => AgentAuth;
  readonly createClient: (options: PtoClientOptions) => WriteClient;
  readonly withCreateIntent: CreateJournal;
}

/** The kinds of write this module executes. */
export type WriteKind = WriteCommand['kind'];

type CreateWrite = Extract<WriteCommand, { readonly kind: 'create' }>;
type UpdateWrite = Extract<WriteCommand, { readonly kind: 'update' }>;
type DeleteWrite = Extract<WriteCommand, { readonly kind: 'delete' }>;

/** A successful write. Each member is the contract's success for that kind. */
export type WriteSuccess =
  CliSuccessFor<'create'> | CliSuccessFor<'update'> | CliSuccessFor<'delete'>;

/**
 * The failure of a write. The recovery is a top-level member, as the contract's
 * failure envelope defines it, and it is present only when its facts are safe and known.
 */
export interface WriteFailure {
  readonly schemaVersion: typeof CLI_SCHEMA_VERSION;
  readonly ok: false;
  readonly command: WriteKind | null;
  readonly error: {
    readonly code: CliErrorCode;
    readonly message: string;
    readonly status: number | null;
    readonly requestId: string | null;
    readonly retryAfterMs: number | null;
  };
  readonly recovery?: WriteRecovery;
}

/** The typed result of a write. It is assignable to the CLI's `CliResult`. */
export type WriteResult = WriteSuccess | WriteFailure;

/* ------------------------------------------------------------------------- */
/* Fixed texts and categories. None of them carries an argument or a secret.  */
/* ------------------------------------------------------------------------- */

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

const TEXT = {
  cancelled: 'The write was cancelled before it was sent. Nothing was changed.',
  unexpected: 'An unexpected local error occurred before the write was sent. Nothing was changed.',
  disabled:
    'Writes are disabled on this host. The trusted environment must set PTO_CLI_WRITES=1. Nothing was sent.',
  needsYes:
    'A non-interactive write needs --yes, given only after the user approved the proposed operation. Nothing was sent.',
  declined: 'The write was not confirmed. Nothing was sent.',
  dates: 'Use --from and --to as real calendar dates in YYYY-MM-DD form.',
  weekend:
    'Dates must fall on weekdays. The CLI never moves a date to a weekday; choose weekday dates.',
  order: 'The end date must not be before the start date.',
  dayPart: 'Use --day-part morning, evening or all_day.',
  singleDay: 'A single-day entry needs --day-part morning, evening or all_day.',
  storedDayPart:
    'The changed dates need an explicit --day-part, because the stored day part does not fit a range longer than one day.',
  noteText: 'A note must be text. Use --clear-note to remove a note.',
  noteWellFormed: 'A note must be well-formed text with no unpaired surrogate characters.',
  noteLength: 'A note may be at most 500 characters.',
  version: 'Use --version with a whole number from 1 to 2147483647.',
  uuid: 'Use the canonical UUID of one PTO entry. Wildcards, prefixes and fuzzy matches are refused.',
  operation: 'Use --operation with the UUID of an earlier pending create.',
  changes: 'Name at least one of --from, --to, --day-part, --note or --clear-note.',
  fields: 'Only --from, --to, --day-part and --note are accepted for this command.',
  flag: 'Check the command flags and try again.',
  profile: 'Use a profile name of 1 to 32 lowercase letters, digits, underscores or hyphens.',
  origin: 'Use an https origin, or an explicitly allowed loopback http origin.',
  scope:
    'This credential lacks a scope this write needs. Ask for a token with the required scope in the signed-in browser UI.',
  owner:
    'This credential may change only its own entries. Changing a teammate entry needs a team lead or admin token with the team scope.',
  busy: 'Another local create is running for this account. Nothing was sent. Wait for it to finish, then try again.',
  pending:
    'A create is still pending for this account and was not sent again. Resume it with its --operation and the same fields, or reconcile it first.',
  mismatch:
    'The pending create does not match this request: the origin, account, credential or fields differ. Nothing was sent.',
  expired:
    'The pending create passed its key deadline. Nothing was sent. Reconcile existing PTO records before creating again.',
  unavailable:
    'The local create journal is unavailable. Nothing was sent. Check the local journal before retrying.',
  journalFault: 'The local create journal could not be used. Nothing was sent.',
  createUnknown:
    'The create outcome is unknown, so the entry may exist. Do not start a new create. Resume with the same --operation and fields to reuse the same key, or reconcile existing records first.',
  updateUnknown:
    'The update outcome is unknown, so the change may already be applied. Reread the entry before any further change.',
  deleteUnknown:
    'The delete outcome is unknown, so the entry may already be removed. Reread the entry before any further change.',
  stale:
    'The entry changed since it was read, so nothing was changed. Review the current fields and confirm the change again with the new version.',
  forbidden:
    'The service refused this write for this credential. Check its scopes, the owner rules and whether writes are enabled on the service. Nothing was changed.',
  conflict:
    'The service reports a conflict with an existing entry, such as an overlapping range. Nothing was changed.',
  rateLimited:
    'The service is rate limiting this credential. Wait for the Retry-After period, then reconcile before retrying.',
  validation: 'The service rejected the request parameters. Nothing was changed.',
} as const;

const CANCELLED: ErrorMapping = { code: 'CANCELLED', message: TEXT.cancelled };
const DECLINED: ErrorMapping = { code: 'CANCELLED', message: TEXT.declined };
const UNEXPECTED: ErrorMapping = { code: 'LOCAL', message: TEXT.unexpected };
const DISABLED: ErrorMapping = { code: 'PERMISSION', message: TEXT.disabled };
const SCOPE: ErrorMapping = { code: 'PERMISSION', message: TEXT.scope };
const OWNER: ErrorMapping = { code: 'PERMISSION', message: TEXT.owner };
const STALE: ErrorMapping = { code: 'CONFLICT', message: TEXT.stale };
const JOURNAL_FAULT: ErrorMapping = { code: 'LOCAL', message: TEXT.journalFault };
const UNKNOWN_CREATE: ErrorMapping = { code: 'NETWORK', message: TEXT.createUnknown };
const UNKNOWN_BY_KIND: Readonly<Record<'update' | 'delete', ErrorMapping>> = {
  update: { code: 'NETWORK', message: TEXT.updateUnknown },
  delete: { code: 'NETWORK', message: TEXT.deleteUnknown },
};

/** The create journal's fixed refusals. Each one names a category and a fixed sentence. */
const JOURNAL_MAPPING: Readonly<Record<CreateIntentCode, ErrorMapping>> = {
  BUSY: { code: 'CONFLICT', message: TEXT.busy },
  PENDING: { code: 'CONFLICT', message: TEXT.pending },
  MISMATCH: { code: 'CONFLICT', message: TEXT.mismatch },
  EXPIRED: { code: 'CONFLICT', message: TEXT.expired },
  UNAVAILABLE: { code: 'LOCAL', message: TEXT.unavailable },
};

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

/** Every failure the service or the transport reports, mapped for a write. */
const WRITE_API_MAPPING: ReadonlyMap<string, ErrorMapping> = new Map<string, ErrorMapping>([
  [
    'UNAUTHENTICATED',
    {
      code: 'AUTH',
      message:
        'The service did not accept this credential. It may be revoked or expired. Replace or revoke it in the signed-in browser UI, then run pto auth set again.',
    },
  ],
  ['FORBIDDEN', { code: 'PERMISSION', message: TEXT.forbidden }],
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
  ['CONFLICT', { code: 'CONFLICT', message: TEXT.conflict }],
  [
    'IDEMPOTENCY_CONFLICT',
    {
      code: 'CONFLICT',
      message:
        'The idempotency key was already used for another request. Reconcile the pending create before retrying.',
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
    'IDEMPOTENCY_KEY_REQUIRED',
    {
      code: 'LOCAL',
      message: 'The service requires an idempotency key that this CLI did not send.',
    },
  ],
  ['STALE_WRITE', STALE],
  [
    'PRECONDITION_REQUIRED',
    {
      code: 'LOCAL',
      message: 'The service requires a write precondition that this CLI did not send.',
    },
  ],
  ['RATE_LIMITED', { code: 'QUOTA', message: TEXT.rateLimited }],
  [
    'TOKEN_LIMIT_REACHED',
    { code: 'QUOTA', message: 'The maximum number of personal access tokens already exists.' },
  ],
  ['VALIDATION_ERROR', { code: 'USAGE', message: TEXT.validation }],
  [
    'NOT_READY',
    { code: 'NETWORK', message: 'The service is not ready yet. Reconcile before retrying.' },
  ],
  ['INTERNAL_ERROR', { code: 'NETWORK', message: 'The service could not complete the request.' }],
  [
    'INVALID_INPUT',
    { code: 'USAGE', message: 'The request parameters are not valid. Nothing was sent.' },
  ],
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
    {
      code: 'NETWORK',
      message: 'The service answered with an error this CLI does not recognize.',
    },
  ],
]);

/**
 * The service codes that prove a create was refused before any write.
 *
 * A key-bound refusal (an expired or reused key) is deliberately absent: the
 * earlier request under that key may have been applied, so the pending record
 * is kept for reconciliation.
 */
const PROVEN_NO_WRITE: ReadonlySet<string> = new Set([
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'SESSION_REQUIRED',
  'CSRF_REJECTED',
  'CONFLICT',
  'RATE_LIMITED',
  'INVALID_INPUT',
  'INVALID_OPTIONS',
  'ABORTED',
  'TIMEOUT',
]);

/** A category and a fixed, safe message, raised by this module before or around a request. */
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

/* ------------------------------------------------------------------------- */
/* Redaction: displayed text never carries a control byte or a secret.      */
/* ------------------------------------------------------------------------- */

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
/** The length of the secret component at the end of a personal access token. */
const SECRET_LENGTH = 64;
const REDACTED = '[redacted]';

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
 * The exact token, its secret component and the SHA-256 digest of that secret
 * are all removed. The digest uses the backend's token domain: SHA-256 of the
 * UTF-8 secret.
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
  return WRITE_API_MAPPING.get(error.code) ?? UNEXPECTED;
}

/* ------------------------------------------------------------------------- */
/* Validation: every non-secret argument is checked before any input or store. */
/* ------------------------------------------------------------------------- */

/**
 * The shape rules below use `$` without the multiline flag. In JavaScript that
 * anchor matches only at the very end of the input, so a trailing newline is
 * refused. The regression tests pin this for every identifier shape.
 */
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** The same origin admission rule the shared API client and the local store use. */
const ORIGIN_SHAPE =
  /^https?:\/\/(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[1-9][0-9]{0,4})?\/?$/i;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]', 'localhost']);
const MAX_ORIGIN_LENGTH = 512;
const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The public operation identifier: a random UUIDv4, never the wire idempotency key. */
const OPERATION_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXPIRES_AT_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const DAY_PARTS: readonly string[] = ['morning', 'evening', 'all_day'];
const MAX_NOTE_LENGTH = 500;
/** An unpaired surrogate, which UTF-8 cannot represent without changing the value. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const MAX_VERSION = 2_147_483_647;
const CREATE_FIELDS: readonly string[] = ['startDate', 'endDate', 'dayPart', 'note'];
const CHANGE_FIELDS: readonly string[] = ['startDate', 'endDate', 'dayPart', 'note'];
/** The wire timeout of one write request. A write is never retried by this CLI. */
const WRITE_TIMEOUT_MS = 15_000;
/** The bounded GET retries the shared client may spend on the live reads. */
const READ_RETRIES = 2;
/** The local switch that the trusted host environment must set. */
const WRITES_SWITCH = 'PTO_CLI_WRITES';

/**
 * An admitted origin, or null.
 *
 * Only an origin with no path, query, userinfo or alternate host spelling is
 * admitted. Plain HTTP is admitted only for the exact loopback hosts.
 */
function admitOrigin(value: unknown, allowLoopbackHttp: boolean): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ORIGIN_LENGTH) {
    return null;
  }
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

/** A real calendar day in the documented form, with no rollover such as February 30. */
function isRealDay(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function requireDay(value: unknown): string {
  if (typeof value !== 'string' || !DAY_SHAPE.test(value) || !isRealDay(value)) {
    throw usageError(TEXT.dates);
  }
  return value;
}

/** A Saturday or a Sunday. The check reads the calendar day in UTC, as the service does. */
function isWeekend(day: string): boolean {
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
}

/** An ordered range whose two endpoints are weekdays. The dates are never moved. */
function requireWeekdayRange(startDate: string, endDate: string): void {
  if (Date.parse(endDate) < Date.parse(startDate)) throw usageError(TEXT.order);
  if (isWeekend(startDate) || isWeekend(endDate)) throw usageError(TEXT.weekend);
}

function requireDayPart(value: unknown): PtoDayPart {
  if (typeof value !== 'string' || !DAY_PARTS.includes(value)) throw usageError(TEXT.dayPart);
  return value as PtoDayPart;
}

/** A positive int32 record version. The number must be a whole number, never a coercion. */
function requireVersion(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_VERSION
  ) {
    throw usageError(TEXT.version);
  }
  return value;
}

/** A canonical UUID of one entry, returned in lowercase. Partial and wildcard identifiers are refused. */
function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_SHAPE.test(value)) throw usageError(TEXT.uuid);
  return value.toLowerCase();
}

/** The public operation identifier of a pending create, when one was supplied. */
function operationIdOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !OPERATION_SHAPE.test(value)) throw usageError(TEXT.operation);
  return value.toLowerCase();
}

/**
 * The own fields of a plain object, copied out.
 *
 * Only own enumerable fields are read, so an inherited property can never stand
 * in for a field. Any field outside the allowlist is refused.
 */
function fieldsOf(
  value: unknown,
  allowed: readonly string[],
  message: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw usageError(message);
  }
  const source = value as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) throw usageError(message);
    fields[key] = source[key];
  }
  return fields;
}

/** A note as text, with the length bound and the well-formed text the service and the journal require. */
function noteText(value: unknown): string {
  if (typeof value !== 'string') throw usageError(TEXT.noteText);
  if (value.length > MAX_NOTE_LENGTH) throw usageError(TEXT.noteLength);
  if (LONE_SURROGATE.test(value)) throw usageError(TEXT.noteWellFormed);
  return value;
}

/** A create note: an empty note is the same as no note, and the service stores none. */
function noteOfCreate(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const text = noteText(value);
  return text === '' ? undefined : text;
}

/**
 * A note change: `null` clears the note, an empty note clears it too, and any
 * other text replaces it. An omitted note is not represented at all.
 */
function noteOfChange(value: unknown): string | null {
  if (value === null) return null;
  const text = noteText(value);
  return text === '' ? null : text;
}

/** The plan of a write: the merged dates and day part the service would store. */
interface Plan {
  readonly startDate: string;
  readonly endDate: string;
  /** The day part the service stores. A range longer than one day is always `all_day`. */
  readonly dayPart: PtoDayPart;
  /** The day part the caller asked for, when one was asked for. */
  readonly requestedDayPart: PtoDayPart | undefined;
}

/**
 * A validated create: the body that is sent and the plan that is previewed.
 *
 * A single day keeps the requested day part and needs one. A longer range keeps
 * the requested value on the wire, because the service is the authority that
 * normalizes it; the preview shows the stored `all_day` next to the request, so
 * the change is never silent.
 */
interface CreateRequest {
  readonly payload: CreatePtoPayload;
  readonly plan: Plan;
}

/** A create body: the token owner is the only owner, and nothing else is accepted. */
function createRequestOf(value: unknown): CreateRequest {
  const fields = fieldsOf(value, CREATE_FIELDS, TEXT.fields);
  const startDate = requireDay(fields['startDate']);
  const endDate = requireDay(fields['endDate']);
  requireWeekdayRange(startDate, endDate);
  const requested = fields['dayPart'] === undefined ? undefined : requireDayPart(fields['dayPart']);
  const note = noteOfCreate(fields['note']);
  const noteFields = note === undefined ? {} : { note };
  if (startDate === endDate) {
    // A single day has no other way to say which part of the day it covers.
    if (requested === undefined) throw usageError(TEXT.singleDay);
    return {
      payload: { startDate, endDate, dayPart: requested, ...noteFields },
      plan: { startDate, endDate, dayPart: requested, requestedDayPart: requested },
    };
  }
  return {
    payload: {
      startDate,
      endDate,
      ...(requested === undefined ? {} : { dayPart: requested }),
      ...noteFields,
    },
    plan: { startDate, endDate, dayPart: 'all_day', requestedDayPart: requested },
  };
}

/** A partial update body: only the named fields, and at least one of them. */
function changesOf(value: unknown): PatchPtoChanges {
  const fields = fieldsOf(value, CHANGE_FIELDS, TEXT.fields);
  const changes: {
    startDate?: string;
    endDate?: string;
    dayPart?: PtoDayPart;
    note?: string | null;
  } = {};
  if (fields['startDate'] !== undefined) changes.startDate = requireDay(fields['startDate']);
  if (fields['endDate'] !== undefined) changes.endDate = requireDay(fields['endDate']);
  if (fields['dayPart'] !== undefined) changes.dayPart = requireDayPart(fields['dayPart']);
  if (fields['note'] !== undefined) changes.note = noteOfChange(fields['note']);
  if (Object.keys(changes).length === 0) throw usageError(TEXT.changes);
  return changes;
}

/* ------------------------------------------------------------------------- */
/* Options: one profile, one origin expectation, one loopback opt-in.       */
/* ------------------------------------------------------------------------- */

interface AuthOptions {
  readonly allowLoopbackHttp: boolean;
  readonly profile?: string;
  readonly origin?: string;
}

/** The validated, non-secret read options of one write. */
function authOptionsOf(input: ReadAuthOptions): AuthOptions {
  const allowLoopbackHttp = requireFlag(input.allowLoopbackHttp);
  const profile = input.profile === undefined ? undefined : requireProfile(input.profile);
  // A saved binding may have opted in to loopback HTTP already. Only the syntax is
  // checked here; the resolver checks the permission with the selected credential.
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
 * Only the two own fields are copied, and only when they are present, so a
 * partial pair is refused by the facade instead of falling back to a profile.
 */
function managedEnvironment(env: NodeJS.ProcessEnv): AgentAuthEnvironment | undefined {
  const record: { PTO_API_ORIGIN?: string; PTO_API_TOKEN?: string } = {};
  if (Object.hasOwn(env, 'PTO_API_ORIGIN')) record.PTO_API_ORIGIN = env.PTO_API_ORIGIN;
  if (Object.hasOwn(env, 'PTO_API_TOKEN')) record.PTO_API_TOKEN = env.PTO_API_TOKEN;
  return Object.keys(record).length === 0 ? undefined : record;
}

function resolveInputFor(auth: AuthOptions, env: NodeJS.ProcessEnv): ResolveInput {
  const managed = managedEnvironment(env);
  return {
    ...(auth.profile === undefined ? {} : { profile: auth.profile }),
    ...(auth.origin === undefined ? {} : { baseUrl: auth.origin }),
    allowLoopbackHttp: auth.allowLoopbackHttp,
    ...(managed === undefined ? {} : { env: managed }),
  };
}

/**
 * The local write switch.
 *
 * Only the exact own field `PTO_CLI_WRITES` with the value `1` opens writes. A
 * value inherited through a prototype, a dotenv file or any other spelling does not.
 */
function requireWritesEnabled(env: NodeJS.ProcessEnv): void {
  const enabled = Object.hasOwn(env, WRITES_SWITCH) && env[WRITES_SWITCH] === '1';
  if (!enabled) throw new CommandError(DISABLED, NO_CORRELATION);
}

/** Without a terminal, the operation needs an explicit `--yes`; a terminal always asks. */
function assertConfirmationMode(interactive: boolean, yes: boolean): void {
  if (!interactive && !yes) throw usageError(TEXT.needsYes);
}

/** The gates that run before any credential, store, prompt or request. */
function preflight(
  run: Run,
  command: { readonly auth: ReadAuthOptions; readonly yes: boolean },
): AuthOptions {
  requireWritesEnabled(run.context.env);
  assertConfirmationMode(run.context.interactive, requireFlag(command.yes));
  return authOptionsOf(command.auth);
}

/* ------------------------------------------------------------------------- */
/* Credential, client and live identity.                                     */
/* ------------------------------------------------------------------------- */

/** The per-operation state: the seams, the context and the redaction in force. */
interface Run {
  readonly dependencies: WriteDependencies;
  readonly context: WriteContext;
  /** Replaced by the credential-specific scrubber once a profile is resolved. */
  scrub: Scrub;
}

async function resolveCredential(run: Run, auth: AuthOptions): Promise<AgentAuthCredential> {
  const bundle = await run.dependencies
    .createAuth()
    .resolve(resolveInputFor(auth, run.context.env));
  // The current local backend is not abortable: a cancellation while it runs must
  // still prevent creating a client or starting a request.
  assertNotCancelled(run.context.signal);
  run.scrub = scrubberForCredential(bundle.credential.token);
  return bundle;
}

/** The client of one resolved binding, bound to the origin the facade resolved. */
function clientFor(run: Run, bundle: AgentAuthCredential): WriteClient {
  return run.dependencies.createClient({
    baseUrl: bundle.baseUrl,
    credential: { origin: bundle.credential.origin, token: bundle.credential.token },
    allowLoopbackHttp: bundle.allowLoopbackHttp,
    timeoutMs: WRITE_TIMEOUT_MS,
    readRetries: READ_RETRIES,
  });
}

/** The live identity of the credential. It is the only source of the actor and of the scopes. */
async function liveIdentity(run: Run, client: WriteClient): Promise<PtoIdentity> {
  const identity = await client.getIdentity({
    signal: run.context.signal,
    timeoutMs: READ_TIMEOUT_MS,
  });
  assertNotCancelled(run.context.signal);
  return identity;
}

/** The exact target detail, read before any update or delete. */
async function loadDetail(run: Run, client: WriteClient, id: string): Promise<PtoDetail> {
  const detail = await client.getDetail(id, {
    signal: run.context.signal,
    timeoutMs: READ_TIMEOUT_MS,
  });
  assertNotCancelled(run.context.signal);
  return detail;
}

/** The request options of one write. Each write request has its own deadline and the caller's signal. */
function requestFor(run: Run): { readonly signal: AbortSignal; readonly timeoutMs: number } {
  return { signal: run.context.signal, timeoutMs: WRITE_TIMEOUT_MS };
}

/** The scope a live token must hold for this operation. */
function requireScope(identity: PtoIdentity, scope: PtoScope): void {
  if (!identity.auth.scopes.includes(scope)) throw new CommandError(SCOPE, NO_CORRELATION);
}

function sameUuid(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

const SCOPE_BY_KIND: Readonly<
  Record<'update' | 'delete', { readonly self: PtoScope; readonly team: PtoScope }>
> = {
  update: { self: 'pto:update:self', team: 'pto:update:team' },
  delete: { self: 'pto:delete:self', team: 'pto:delete:team' },
};

/**
 * The owner and scope rules of a change to an existing entry.
 *
 * A token may change its own entry with its self scope, and a teammate's entry
 * only with its team scope and a live team-lead or administrator role. A self-only
 * lead token therefore cannot change a teammate, and the server applies the same
 * rules again.
 */
function assertMayChange(identity: PtoIdentity, ownerId: string, kind: 'update' | 'delete'): void {
  const lead = identity.role === 'team_lead' || identity.role === 'admin';
  const own = sameUuid(identity.id, ownerId);
  if (!lead && !own) throw new CommandError(OWNER, NO_CORRELATION);
  const scopes = SCOPE_BY_KIND[kind];
  const selfAllowed = own && identity.auth.scopes.includes(scopes.self);
  const teamAllowed = lead && identity.auth.scopes.includes(scopes.team);
  if (!selfAllowed && !teamAllowed) throw new CommandError(SCOPE, NO_CORRELATION);
}

/**
 * An update's plan: the merged record. An omitted date or day part keeps its stored value.
 *
 * A stored half-day cannot describe a longer range, so such a change needs an
 * explicit day part. Otherwise the plan refuses before a preview and before any request.
 */
function planUpdate(detail: PtoDetail, changes: PatchPtoChanges): Plan {
  const startDate = changes.startDate ?? detail.startDate;
  const endDate = changes.endDate ?? detail.endDate;
  requireWeekdayRange(startDate, endDate);
  let dayPart: PtoDayPart;
  if (startDate === endDate) {
    dayPart = changes.dayPart ?? detail.dayPart;
  } else if (changes.dayPart !== undefined || detail.dayPart === 'all_day') {
    dayPart = 'all_day';
  } else {
    throw usageError(TEXT.storedDayPart);
  }
  return { startDate, endDate, dayPart, requestedDayPart: changes.dayPart };
}

/* ------------------------------------------------------------------------- */
/* Preview: exact actor, owner, entry, dates and fields; never note text.    */
/* ------------------------------------------------------------------------- */

interface PreviewFacts {
  readonly title: string;
  readonly origin: string;
  readonly actorId: string;
  readonly ownerId: string;
  readonly entry: string;
  readonly dates: string;
  readonly dayPart: string;
  /** Null when the operation has no note line. */
  readonly note: string | null;
  readonly changed: string;
  /** Null when the operation is not a resume. */
  readonly resume: string | null;
}

/**
 * The text of one preview, with every value scrubbed.
 *
 * The values are validated identifiers, dates and enumerations, and the origin is
 * admitted, but each one still passes the scrubber, so a hostile value can never
 * add a line, a control character or a secret.
 */
function previewText(scrub: Scrub, facts: PreviewFacts): string {
  const lines = [
    facts.title,
    `Origin: ${scrub(facts.origin)}`,
    `Acting user: ${scrub(facts.actorId)}`,
    `Owner: ${scrub(facts.ownerId)}`,
    `Entry: ${scrub(facts.entry)}`,
    `Dates: ${scrub(facts.dates)}`,
    `Day part: ${scrub(facts.dayPart)}`,
  ];
  if (facts.note !== null) lines.push(`Note: ${scrub(facts.note)}`);
  if (facts.resume !== null) lines.push(`Resume: ${scrub(facts.resume)}`);
  lines.push(`Changed fields: ${scrub(facts.changed)}`);
  return lines.join('\n');
}

function listOf(fields: readonly string[]): string {
  return fields.length === 0 ? 'none' : fields.join(', ');
}

function rangeOf(startDate: string, endDate: string): string {
  return `${startDate}..${endDate}`;
}

/**
 * The day part as it will be stored.
 *
 * A requested day part that the service does not store is said so in the same
 * line, so a range longer than one day never looks as if it kept the request.
 */
function dayPartLine(before: PtoDayPart | null, plan: Plan): string {
  const stored = before === null ? plan.dayPart : `${before} -> ${plan.dayPart}`;
  const requested = plan.requestedDayPart;
  if (requested === undefined || requested === plan.dayPart) return stored;
  return `${stored} (requested ${requested}; a range longer than one day is stored as ${plan.dayPart})`;
}

/** The note as keep, set or clear. Its text is never shown. */
function noteAction(note: string | null | undefined): string {
  if (note === undefined) return 'keep';
  return note === null ? 'clear' : 'set';
}

function previewOfCreate(
  run: Run,
  origin: string,
  identity: PtoIdentity,
  request: CreateRequest,
  operationId: string | undefined,
): string {
  const { payload, plan } = request;
  const noted = payload.note !== undefined;
  const changed = ['startDate', 'endDate', 'dayPart', ...(noted ? ['note'] : [])];
  return previewText(run.scrub, {
    title: 'Create one PTO entry for the token holder:',
    origin,
    actorId: identity.id,
    ownerId: identity.id,
    entry: 'new entry, with no identifier until it is created',
    dates: rangeOf(plan.startDate, plan.endDate),
    dayPart: dayPartLine(null, plan),
    note: noted ? 'set' : 'none',
    changed: listOf(changed),
    resume:
      operationId === undefined
        ? null
        : `pending operation ${operationId}, same key and the same fields`,
  });
}

function previewOfUpdate(
  run: Run,
  origin: string,
  identity: PtoIdentity,
  detail: PtoDetail,
  target: Target,
  changes: PatchPtoChanges,
  plan: Plan,
): string {
  const changed: string[] = [];
  if (plan.startDate !== detail.startDate) changed.push('startDate');
  if (plan.endDate !== detail.endDate) changed.push('endDate');
  if (plan.dayPart !== detail.dayPart) changed.push('dayPart');
  if (changes.note !== undefined) changed.push('note');
  return previewText(run.scrub, {
    title: 'Update one PTO entry:',
    origin,
    actorId: identity.id,
    ownerId: detail.user.id,
    entry: `${target.id} at version ${target.version}`,
    dates: `${rangeOf(detail.startDate, detail.endDate)} -> ${rangeOf(plan.startDate, plan.endDate)}`,
    dayPart: dayPartLine(detail.dayPart, plan),
    note: noteAction(changes.note),
    changed: listOf(changed),
    resume: null,
  });
}

function previewOfDelete(
  run: Run,
  origin: string,
  identity: PtoIdentity,
  detail: PtoDetail,
  target: Target,
): string {
  return previewText(run.scrub, {
    title: 'Delete one PTO entry:',
    origin,
    actorId: identity.id,
    ownerId: detail.user.id,
    entry: `${target.id} at version ${target.version}`,
    dates: rangeOf(detail.startDate, detail.endDate),
    dayPart: detail.dayPart,
    note: null,
    changed: 'none; the entry is deleted',
    resume: null,
  });
}

/**
 * The host's confirmation. It is asked only on a terminal; a refusal, a rejection
 * of the host or an aborted signal is a stop with no write.
 */
async function confirmWrite(run: Run, preview: string): Promise<void> {
  let approved = false;
  try {
    approved = (await run.context.confirm(preview)) === true;
  } catch {
    approved = false;
  }
  if (!approved || run.context.signal.aborted) throw new CommandError(DECLINED, NO_CORRELATION);
}

/* ------------------------------------------------------------------------- */
/* Results: one builder for each shape, so no field is ever ad hoc.         */
/* ------------------------------------------------------------------------- */

interface Target {
  readonly id: string;
  readonly version: number;
}

function success<K extends WriteKind>(
  command: K,
  data: CliSuccessFor<K>['data'],
): CliSuccessFor<K> {
  return { schemaVersion: CLI_SCHEMA_VERSION, ok: true, command, data };
}

function failure(
  command: WriteKind | null,
  mapping: ErrorMapping,
  correlation: Correlation,
  recovery?: WriteRecovery,
): WriteFailure {
  return {
    schemaVersion: CLI_SCHEMA_VERSION,
    ok: false,
    command,
    error: {
      code: mapping.code,
      message: mapping.message,
      ...correlation,
    },
    ...(recovery === undefined ? {} : { recovery }),
  };
}

/** The safe record of a live detail, with the owner the service reported. */
function recordOfDetail(detail: PtoDetail): WriteRecord {
  return {
    id: detail.id,
    ownerId: detail.user.id,
    version: detail.version,
    startDate: detail.startDate,
    endDate: detail.endDate,
    dayPart: detail.dayPart,
  };
}

/** The safe record of a mutation answer. The note is never kept. */
function recordOfRecord(record: PtoRecord): WriteRecord {
  return {
    id: record.id,
    ownerId: record.userId,
    version: record.version,
    startDate: record.startDate,
    endDate: record.endDate,
    dayPart: record.dayPart,
  };
}

/** A recovery for a pending create, when its operation identifier and deadline are safe. */
function pendingRecovery(operationId: unknown, expiresAt: unknown): WriteRecovery | undefined {
  if (typeof operationId !== 'string' || !UUID_SHAPE.test(operationId)) return undefined;
  if (typeof expiresAt !== 'string' || !EXPIRES_AT_SHAPE.test(expiresAt)) return undefined;
  return { kind: 'create-pending', operationId, expiresAt };
}

/**
 * Whether an error proves that the answer was definite.
 *
 * The client sets `unknownWriteOutcome` on every failure after a dispatch that may
 * have been applied. Only a `PtoApiError` without that flag is definite, and any
 * other thrown value is treated as unknown.
 */
function isDefinitive(error: unknown): error is PtoApiError {
  return error instanceof PtoApiError && !error.unknownWriteOutcome;
}

/** Turns any thrown value into one classified, fixed failure. Reached only before a request. */
function failureFor(kind: WriteKind | null, error: unknown, run: Run): WriteFailure {
  // An abort beats every other classification before the request was sent.
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

/* ------------------------------------------------------------------------- */
/* Create: identity, scope, confirmation, durable journal, one dispatch.     */
/* ------------------------------------------------------------------------- */

/** The public identifiers of one pending create. The idempotency key is never copied out. */
interface IntentView {
  readonly operationId: string;
  readonly expiresAt: string;
}

/**
 * How one admitted create attempt ended.
 *
 * Every variant names its own safe facts, and `kept` says whether the pending record
 * stays for reconciliation. A `created` attempt carries the one success object that
 * is delivered and returned, so the caller never sees two different results.
 */
type CreateAttempt =
  | {
      readonly kind: 'created';
      readonly intent: IntentView;
      readonly answer: CliSuccessFor<'create'>;
    }
  | { readonly kind: 'not-sent'; readonly intent: IntentView; readonly kept: boolean }
  | {
      readonly kind: 'refused';
      readonly intent: IntentView;
      readonly error: PtoApiError;
      readonly kept: boolean;
    }
  | { readonly kind: 'unknown'; readonly intent: IntentView; readonly error: unknown };

/** Resolves the lease. A failure to resolve it is never a reason to report a different result. */
function completeSafely(lease: CreateIntentLease): boolean {
  try {
    lease.complete();
    return true;
  } catch {
    return false;
  }
}

/**
 * Settles the pending record of one attempt that is not a delivered success.
 *
 * Only a fresh attempt that the service refused with a proven no-write answer, or
 * that never reached the service, clears the record. A resumed attempt keeps it,
 * and so does any ambiguous or key-bound outcome. Returns whether the record is kept.
 */
function settlePending(lease: CreateIntentLease, fresh: boolean, provenNoWrite: boolean): boolean {
  if (!fresh || !provenNoWrite) return true;
  return !completeSafely(lease);
}

/** The safe success of a verified create. */
function createdAnswer(intent: IntentView, result: CreatePtoResult): CliSuccessFor<'create'> {
  return success('create', {
    record: recordOfRecord(result.record),
    operationId: intent.operationId,
    replayed: result.replayed,
    expiresAt: result.expiresAt,
  });
}

/**
 * Waits for one delivery, but never past the caller's cancellation.
 *
 * A host that never answers, for example one whose output nobody reads, must not
 * hold the journal lease forever. When the signal aborts first, the delivery counts
 * as not made: the record stays pending and the known success is still returned.
 * A rejection or a synchronous throw counts the same way, and only an exact `true` delivers.
 */
function deliveredBefore(signal: AbortSignal, deliver: () => Promise<boolean>): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });
    const finish = (value: unknown): void => {
      signal.removeEventListener('abort', onAbort);
      resolve(value === true);
    };
    Promise.resolve()
      .then(deliver)
      .then(finish, () => finish(false));
  });
}

/**
 * Hands the single known success to the host, while the lease still holds.
 *
 * Without a hook the success is delivered by definition, which is the original
 * behavior. A hook that is supplied but is not a function, or a hook that is asked
 * after the caller aborted, cannot deliver anything, so the record is kept and the hook
 * is not started. Otherwise the hook runs once, and only a `true` answer delivers.
 * A host that still writes after an abort may repeat the result in its final publish,
 * so that publish must stay idempotent.
 */
function deliverCreate(run: Run, answer: CliSuccessFor<'create'>): Promise<boolean> {
  const publish = run.context.publishCreateResult;
  if (publish === undefined) return Promise.resolve(true);
  if (typeof publish !== 'function' || run.context.signal.aborted) return Promise.resolve(false);
  return deliveredBefore(run.context.signal, () => publish(answer));
}

/** One admitted create attempt. It never throws: every answer becomes a variant. */
async function attemptCreate(
  run: Run,
  client: WriteClient,
  lease: CreateIntentLease,
  payload: CreatePtoPayload,
  fresh: boolean,
): Promise<CreateAttempt> {
  const intent: IntentView = {
    operationId: lease.intent.operationId,
    expiresAt: lease.intent.expiresAt,
  };
  // The cancellation is checked again after admission and before the request leaves.
  if (run.context.signal.aborted) {
    return { kind: 'not-sent', intent, kept: settlePending(lease, fresh, true) };
  }
  let result: CreatePtoResult;
  try {
    result = await client.create(payload, lease.intent.key, requestFor(run));
  } catch (error) {
    if (!isDefinitive(error)) return { kind: 'unknown', intent, error };
    const proven = PROVEN_NO_WRITE.has(error.code);
    return { kind: 'refused', intent, error, kept: settlePending(lease, fresh, proven) };
  }
  // The service answered with a verified success. Only a delivered success clears the
  // record; a host that cannot confirm delivery leaves it pending, and the success is
  // still returned. The delivery is awaited outside the request's error handling, so a
  // failing host never turns a known success into a refusal.
  const answer = createdAnswer(intent, result);
  if (await deliverCreate(run, answer)) completeSafely(lease);
  return { kind: 'created', intent, answer };
}

/** The recovery of a kept pending create. */
function keptRecovery(attempt: {
  readonly intent: IntentView;
  readonly kept: boolean;
}): WriteRecovery | undefined {
  if (!attempt.kept) return undefined;
  return {
    kind: 'create-pending',
    operationId: attempt.intent.operationId,
    expiresAt: attempt.intent.expiresAt,
  };
}

/** The correlation of an answer whose outcome is unknown, when the transport gave one. */
function unknownCorrelation(error: unknown, run: Run): Correlation {
  return error instanceof PtoApiError ? correlationOf(error, run.scrub) : NO_CORRELATION;
}

/** The outcome of a create whose answer was lost. It is never reported as failed or cancelled. */
function unknownCreate(intent: IntentView, correlation: Correlation): WriteFailure {
  return failure('create', UNKNOWN_CREATE, correlation, {
    kind: 'create-pending',
    operationId: intent.operationId,
    expiresAt: intent.expiresAt,
  });
}

/** The outcome of one attempt that the journal admitted and that ran to its answer. */
function attemptOutcome(attempt: CreateAttempt, run: Run): WriteResult {
  switch (attempt.kind) {
    case 'created':
      return attempt.answer;
    case 'not-sent':
      return failure('create', CANCELLED, NO_CORRELATION, keptRecovery(attempt));
    case 'refused':
      return failure(
        'create',
        mappingFor(attempt.error),
        correlationOf(attempt.error, run.scrub),
        keptRecovery(attempt),
      );
    case 'unknown':
      return unknownCreate(attempt.intent, unknownCorrelation(attempt.error, run));
  }
}

/**
 * The journal refused admission, or it failed before the attempt ran.
 *
 * Nothing was sent in this case, because the attempt never ran. A refusal keeps its
 * fixed category and its safe recovery facts. An abort before admission is a
 * cancellation, and any other journal failure is a local fault.
 */
function refusalOf(error: unknown, run: Run): WriteFailure {
  if (error instanceof CreateIntentError) {
    const mapping = JOURNAL_MAPPING[error.code] ?? JOURNAL_FAULT;
    return failure(
      'create',
      mapping,
      NO_CORRELATION,
      pendingRecovery(error.operationId, error.expiresAt),
    );
  }
  if (run.context.signal.aborted) return failure('create', CANCELLED, NO_CORRELATION);
  return failure('create', JOURNAL_FAULT, NO_CORRELATION);
}

/**
 * The journal failed after an attempt ran.
 *
 * A delivered success stays a success, even when the storage failed afterwards,
 * because the service answered. Any other attempt is conservatively unknown: the
 * journal can no longer prove what the pending record holds.
 */
function journalFailureAfter(
  attempt: CreateAttempt | undefined,
  error: unknown,
  run: Run,
): WriteResult {
  if (attempt === undefined) return refusalOf(error, run);
  if (attempt.kind === 'created') return attempt.answer;
  return unknownCreate(attempt.intent, attemptCorrelation(attempt, run));
}

/** The correlation of an attempt that ended without a delivered success, when its answer carried one. */
function attemptCorrelation(attempt: CreateAttempt, run: Run): Correlation {
  if (attempt.kind === 'refused') return correlationOf(attempt.error, run.scrub);
  if (attempt.kind === 'unknown') return unknownCorrelation(attempt.error, run);
  return NO_CORRELATION;
}

async function admitCreate(
  run: Run,
  client: WriteClient,
  bundle: AgentAuthCredential,
  identity: PtoIdentity,
  payload: CreatePtoPayload,
  operationId: string | undefined,
): Promise<WriteResult> {
  const binding: CreateIntentBinding = {
    origin: bundle.baseUrl,
    actorId: identity.id,
    tokenId: identity.auth.tokenId,
    token: bundle.credential.token,
  };
  // The attempt is recorded before the journal returns, so a later journal failure
  // is classified by what really happened. The signal is passed to the journal, so an
  // abort is refused before admission touches anything.
  const settled: { attempt?: CreateAttempt } = {};
  const fresh = operationId === undefined;
  try {
    const attempt = await run.dependencies.withCreateIntent(
      binding,
      payload,
      operationId,
      async (lease) => {
        const answer = await attemptCreate(run, client, lease, payload, fresh);
        settled.attempt = answer;
        return answer;
      },
      { signal: run.context.signal },
    );
    return attemptOutcome(attempt, run);
  } catch (error) {
    return journalFailureAfter(settled.attempt, error, run);
  }
}

async function create(run: Run, command: CreateWrite): Promise<WriteResult> {
  const auth = preflight(run, command);
  const request = createRequestOf(command.payload);
  const operationId = operationIdOf(command.operationId);
  assertNotCancelled(run.context.signal);
  const bundle = await resolveCredential(run, auth);
  const client = clientFor(run, bundle);
  const identity = await liveIdentity(run, client);
  requireScope(identity, 'pto:create');
  if (run.context.interactive) {
    const preview = previewOfCreate(run, bundle.baseUrl, identity, request, operationId);
    await confirmWrite(run, preview);
  }
  return admitCreate(run, client, bundle, identity, request.payload, operationId);
}

/* ------------------------------------------------------------------------- */
/* Update and delete: exact detail, expected version, one versioned request. */
/* ------------------------------------------------------------------------- */

/** The stale answer of a version that is not the one read. Nothing was approved yet, so there is no baseline. */
function staleBeforeSend(
  kind: 'update' | 'delete',
  target: Target,
  detail: PtoDetail,
): WriteFailure {
  return failure(kind, STALE, NO_CORRELATION, {
    kind: 'stale',
    id: target.id,
    expectedVersion: target.version,
    before: null,
    current: recordOfDetail(detail),
  });
}

/**
 * The current safe record, read once with a bounded GET.
 *
 * The read never retries a write. An abort, a failure, or an answer that names
 * another entry gives null, which is reported as an unavailable side and never invented.
 */
async function refetch(run: Run, client: WriteClient, id: string): Promise<WriteRecord | null> {
  if (run.context.signal.aborted) return null;
  try {
    const detail = await client.getDetail(id, {
      signal: run.context.signal,
      timeoutMs: READ_TIMEOUT_MS,
    });
    return sameUuid(detail.id, id) ? recordOfDetail(detail) : null;
  } catch {
    return null;
  }
}

/**
 * The outcome of a versioned write that was dispatched and then failed.
 *
 * A definite refusal keeps its category. A stale precondition is refetched once and
 * reported beside the approved baseline. Anything else may already have been applied,
 * so it is reported as an unknown outcome with the target and its version.
 */
async function settleSent(
  run: Run,
  client: WriteClient,
  kind: 'update' | 'delete',
  target: Target,
  baseline: WriteRecord,
  error: unknown,
): Promise<WriteFailure> {
  if (!isDefinitive(error)) {
    const recovery: WriteRecovery = {
      kind: 'outcome-unknown',
      id: target.id,
      expectedVersion: target.version,
    };
    return failure(kind, UNKNOWN_BY_KIND[kind], unknownCorrelation(error, run), recovery);
  }
  if (error.code === 'STALE_WRITE') {
    const current = await refetch(run, client, target.id);
    return failure(kind, STALE, correlationOf(error, run.scrub), {
      kind: 'stale',
      id: target.id,
      expectedVersion: target.version,
      before: baseline,
      current,
    });
  }
  return failure(kind, mappingFor(error), correlationOf(error, run.scrub));
}

async function sendUpdate(
  run: Run,
  client: WriteClient,
  target: Target,
  changes: PatchPtoChanges,
  baseline: WriteRecord,
): Promise<WriteResult> {
  // The cancellation is checked again before the request leaves.
  assertNotCancelled(run.context.signal);
  try {
    const record = await client.patch(target.id, target.version, changes, requestFor(run));
    return success('update', { record: recordOfRecord(record) });
  } catch (error) {
    return settleSent(run, client, 'update', target, baseline, error);
  }
}

async function update(run: Run, command: UpdateWrite): Promise<WriteResult> {
  const auth = preflight(run, command);
  const target: Target = { id: requireUuid(command.id), version: requireVersion(command.version) };
  const changes = changesOf(command.changes);
  assertNotCancelled(run.context.signal);
  const bundle = await resolveCredential(run, auth);
  const client = clientFor(run, bundle);
  const identity = await liveIdentity(run, client);
  requireScope(identity, 'pto:read');
  const detail = await loadDetail(run, client, target.id);
  assertMayChange(identity, detail.user.id, 'update');
  if (detail.version !== target.version) return staleBeforeSend('update', target, detail);
  const plan = planUpdate(detail, changes);
  if (run.context.interactive) {
    const preview = previewOfUpdate(run, bundle.baseUrl, identity, detail, target, changes, plan);
    await confirmWrite(run, preview);
  }
  return sendUpdate(run, client, target, changes, recordOfDetail(detail));
}

async function sendDelete(
  run: Run,
  client: WriteClient,
  target: Target,
  ownerId: string,
  baseline: WriteRecord,
): Promise<WriteResult> {
  assertNotCancelled(run.context.signal);
  try {
    await client.delete(target.id, target.version, requestFor(run));
    return success('delete', { id: target.id, version: target.version, ownerId });
  } catch (error) {
    return settleSent(run, client, 'delete', target, baseline, error);
  }
}

async function remove(run: Run, command: DeleteWrite): Promise<WriteResult> {
  const auth = preflight(run, command);
  const target: Target = { id: requireUuid(command.id), version: requireVersion(command.version) };
  assertNotCancelled(run.context.signal);
  const bundle = await resolveCredential(run, auth);
  const client = clientFor(run, bundle);
  const identity = await liveIdentity(run, client);
  requireScope(identity, 'pto:read');
  const detail = await loadDetail(run, client, target.id);
  assertMayChange(identity, detail.user.id, 'delete');
  if (detail.version !== target.version) return staleBeforeSend('delete', target, detail);
  if (run.context.interactive) {
    const preview = previewOfDelete(run, bundle.baseUrl, identity, detail, target);
    await confirmWrite(run, preview);
  }
  return sendDelete(run, client, target, detail.user.id, recordOfDetail(detail));
}

/* ------------------------------------------------------------------------- */
/* Entry point.                                                               */
/* ------------------------------------------------------------------------- */

/** The production seams. Only the entry point's default argument uses them. */
const DEFAULT_WRITE_DEPENDENCIES: WriteDependencies = {
  createAuth: createAgentAuth,
  createClient: createPtoClient,
  withCreateIntent,
};

function dependenciesOf(supplied: Partial<WriteDependencies>): WriteDependencies {
  return {
    createAuth: supplied.createAuth ?? DEFAULT_WRITE_DEPENDENCIES.createAuth,
    createClient: supplied.createClient ?? DEFAULT_WRITE_DEPENDENCIES.createClient,
    withCreateIntent: supplied.withCreateIntent ?? DEFAULT_WRITE_DEPENDENCIES.withCreateIntent,
  };
}

function kindOf(value: unknown): WriteKind | null {
  if (value === 'create' || value === 'update' || value === 'delete') return value;
  return null;
}

/**
 * Runs one write of the CLI against the real local store, the real API client and
 * the real intent journal.
 *
 * Every failure of a well-formed write resolves to a classified result with a
 * fixed category and message. Only a call without a command object and a context is
 * a programming error of the caller, and only that can reject.
 */
export async function executeWrite(
  command: WriteCommand,
  context: WriteContext,
  deps: Partial<WriteDependencies> = {},
): Promise<WriteResult> {
  const run: Run = { dependencies: dependenciesOf(deps), context, scrub: PLAIN_SCRUB };
  const kind = kindOf(command.kind);
  try {
    assertNotCancelled(context.signal);
    switch (command.kind) {
      case 'create':
        return await create(run, command);
      case 'update':
        return await update(run, command);
      case 'delete':
        return await remove(run, command);
      default:
        throw new CommandError(UNEXPECTED, NO_CORRELATION);
    }
  } catch (error) {
    return failureFor(kind, error, run);
  }
}
