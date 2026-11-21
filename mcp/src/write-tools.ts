/**
 * The writable PTO tools of the local stdio server (#264).
 *
 * Every mutation is a two-phase operation with the same ordered gates:
 *
 *   1. the exact own local switch `PTO_MCP_WRITES=1`, checked before anything else;
 *   2. the strict, closed arguments, checked before any store or request;
 *   3. on `apply`, the claim of the one preview that bound these exact arguments;
 *   4. the origin-bound shared credential resolver and the live `/auth/me` identity;
 *   5. the live scope, ownership and role rules, plus the exact current entry
 *      and version for update and delete;
 *   6. on a create, the bounded process-local observation of the exact create
 *      key and intent;
 *   7. for `preview`, one bounded preview reference and a safe description; for
 *      `apply`, a final expiry recheck and one conditional request.
 *
 * The rules this module never breaks:
 *
 * - a tool call never chooses a credential, an origin, an owner, a role, a
 *   header, a path or a URL, and no argument is an instruction;
 * - a preview never writes, never reads a note into its answer and never claims
 *   that a human approved anything;
 * - an apply from one preview dispatches at most once, with no automatic retry;
 *   a dispatched write whose answer was lost is an unknown outcome, never a
 *   failure and never a cancellation;
 * - a create key is never minted or replaced by this module. Its first observed
 *   origin, actor, live credential, token ID and canonical intent are retained
 *   for the bounded process lifetime; a different binding fails closed and a
 *   rotated credential cannot use an older preview;
 * - update sends only actual effective changes plus an explicit note. An omitted
 *   note preserves the stored (possibly hidden) note, and `null` or the empty
 *   string clears it. No note text is read into a result;
 * - the live role is part of the preview binding even when a changed role would
 *   still permit the operation;
 * - every answer is a closed, allowlisted envelope; every failure is a fixed
 *   sentence and a bounded recovery category, and never reflects an unverified
 *   upstream correlation value.
 */

import { randomUUID } from 'node:crypto';

import {
  AgentAuthError,
  createAgentAuth,
  type AgentAuth,
  type AgentAuthCredential,
  type AgentAuthErrorCode,
  type AgentAuthOptions,
} from '@pto-calendar/agent-auth';
import {
  createPtoClient,
  PtoApiError,
  type CreatePtoPayload,
  type PatchPtoChanges,
  type PtoClient,
  type PtoClientOptions,
  type PtoDayPart,
  type PtoDetail,
  type PtoIdentity,
  type PtoRecord,
  type PtoScope,
} from '@pto-calendar/api-client';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import { MCP_SCHEMA_VERSION, type LaunchOptions, type ToolErrorCode } from './contract.js';
import { adapterRequestId, type InputResult } from './schema.js';
import { executeReadTool, resolveInputFor, toolFailure } from './tools.js';
import {
  CHANGED_FIELDS,
  isWriteToolName,
  writesEnabled,
  type AnyToolName,
  type AnyToolResult,
  type AppliedRecord,
  type ChangedField,
  type CreateApplyData,
  type CreateArguments,
  type CreatePreviewData,
  type DeleteApplyData,
  type DeleteArguments,
  type DeletePreviewData,
  type EffectiveRange,
  type NoteIntent,
  type TargetReference,
  type UpdateApplyData,
  type UpdateArguments,
  type UpdateChanges,
  type UpdatePreviewData,
  type WriteArguments,
  type WriteErrorCode,
  type WriteOperation,
  type WriteRecovery,
  type WriteToolName,
  type WriteToolResult,
} from './write-contract.js';
import {
  CREATE_INPUT_SCHEMA,
  CREATE_OUTPUT_SCHEMA,
  DELETE_INPUT_SCHEMA,
  DELETE_OUTPUT_SCHEMA,
  UPDATE_INPUT_SCHEMA,
  UPDATE_OUTPUT_SCHEMA,
  WRITE_INPUT_MESSAGES,
  validateEffectiveRange,
  validateWriteArguments,
} from './write-schema.js';
import {
  CreateKeyRegistry,
  MutationGuard,
  PreviewStore,
  createKeyFingerprint,
  credentialFingerprint,
  payloadDigest,
  type ClaimedPreview,
  type CreateKeyBinding,
  type PreviewBinding,
} from './write-preview.js';

/** The deadline that covers one whole mutation call, including its live reads. */
export const WRITE_DEADLINE_MS = 20_000;

/** The bounded GET retries the shared client may spend on the live reads. */
const READ_RETRIES = 2;

/** The API surface a mutation may use: live reads and the three versioned operations. */
export type WriteClient = Pick<
  PtoClient,
  'getIdentity' | 'getDetail' | 'create' | 'patch' | 'delete'
>;

/**
 * The seams of the mutation tools.
 *
 * Production calls use the real factories. Only the focused tests replace them,
 * and nothing outside this module can choose a store, a header, an origin or a
 * transport through them. The preview store and the one-dispatch guard are
 * process-local and bounded.
 */
export interface WriteToolDependencies {
  readonly createAuth: (options?: AgentAuthOptions) => AgentAuth;
  readonly createClient: (options: PtoClientOptions) => WriteClient;
  /** A wall clock in milliseconds, shared by the deadline and the preview store. */
  readonly now: () => number;
  /** The request identifier of one call. */
  readonly newRequestId: () => string;
  readonly previews: PreviewStore;
  readonly mutations: MutationGuard;
  readonly createKeys: CreateKeyRegistry;
}

const DEFAULT_DEPENDENCIES: WriteToolDependencies = {
  createAuth: createAgentAuth,
  createClient: createPtoClient,
  now: Date.now,
  newRequestId: randomUUID,
  previews: new PreviewStore(),
  mutations: new MutationGuard(),
  createKeys: new CreateKeyRegistry(),
};

/* ------------------------------------------------------------------------- */
/* Fixed texts and bounded classifications. None carries an argument.        */
/* ------------------------------------------------------------------------- */

interface ErrorMapping {
  readonly code: WriteErrorCode;
  readonly message: string;
  readonly recovery: WriteRecovery;
}

const PREVIEW_RECONCILIATION =
  'This call sent no mutation, but an earlier attempt may have committed. Reconcile existing PTO records before preparing a new preview. Do not retry an earlier create with a new key or changed credential.';

/** The fixed message of one failure category. */
const MESSAGES: Readonly<Record<WriteErrorCode, string>> = {
  INPUT: 'The tool arguments are not valid.',
  AUTH: 'No usable credential. Configure the local profile outside the tool, or replace a revoked or expired token in the signed-in browser UI. Nothing was sent.',
  PERMISSION: 'The credential is not allowed to perform this write. Nothing was sent.',
  NOT_FOUND:
    'No PTO entry matches this identifier, or the credential cannot see it. Nothing was changed.',
  QUOTA:
    'The service is rate limiting this credential. Wait for the period it asks for, then read the current entry before proposing another change. This server never retries a write automatically.',
  NETWORK:
    'The service could not be reached, or answered with something this server cannot use. This server never retries a write automatically.',
  CANCELLED: 'The write was cancelled before it was sent. Nothing was changed.',
  LOCAL: 'The local PTO tool server could not complete this write. Nothing was sent.',
  BUSY: 'Another mutation for this target or credential is in flight, or the bounded preview store is full. Wait for it to finish, then prepare a new preview.',
  CONFLICT:
    'The change conflicts with the current state of the entry. Nothing was changed. Read the entry again and prepare a new preview.',
  PREVIEW: `The preview is unknown, expired or already used. ${PREVIEW_RECONCILIATION}`,
  UNKNOWN_OUTCOME:
    'The write outcome is unknown. Reconcile the PTO records before any further mutation. This server never retries automatically.',
};

const CANCELLED: ErrorMapping = {
  code: 'CANCELLED',
  message: MESSAGES.CANCELLED,
  recovery: 'none',
};
const BUSY: ErrorMapping = { code: 'BUSY', message: MESSAGES.BUSY, recovery: 'none' };
const UNEXPECTED_LOCAL: ErrorMapping = {
  code: 'LOCAL',
  message: MESSAGES.LOCAL,
  recovery: 'none',
};
const DISABLED: ErrorMapping = {
  code: 'PERMISSION',
  message:
    'Writes are disabled for this local tool server. The trusted host must set PTO_MCP_WRITES=1 before the server starts. Nothing was sent.',
  recovery: 'none',
};
const SCOPE: ErrorMapping = {
  code: 'PERMISSION',
  message:
    'This credential lacks a scope this write needs. Ask for a token with the required scope in the signed-in browser UI. Nothing was sent.',
  recovery: 'reauthenticate',
};
const OWNER: ErrorMapping = {
  code: 'PERMISSION',
  message:
    'This credential may change only its own entries. Changing a teammate entry needs a team lead or admin token with the team scope. Nothing was sent.',
  recovery: 'reauthenticate',
};
const FORBIDDEN: ErrorMapping = {
  code: 'PERMISSION',
  message:
    'The service refused this write for this credential. Check its scopes, the owner rules and whether writes are enabled on the service. Nothing was changed.',
  recovery: 'reauthenticate',
};
const STALE: ErrorMapping = {
  code: 'CONFLICT',
  message:
    'The entry changed since the preview, so nothing was changed. Read the current entry and prepare a new preview with its current version.',
  recovery: 'refresh-version',
};
const STALE_BEFORE_SEND: ErrorMapping = {
  code: 'CONFLICT',
  message:
    'The entry changed since it was read, so nothing was changed. Prepare a new preview with the current version.',
  recovery: 'refresh-version',
};
const OVERLAP: ErrorMapping = {
  code: 'CONFLICT',
  message:
    'The service reports a conflict with an existing entry, such as an overlapping range. Nothing was changed. Choose different dates and prepare a new preview.',
  recovery: 'none',
};
const KEY_CONFLICT: ErrorMapping = {
  code: 'CONFLICT',
  message:
    'The idempotency key was already used for another request or intent. Nothing was sent again. Reconcile existing PTO records; never reuse this key for a different payload and never mint a new key for this intent.',
  recovery: 'reconcile',
};
const KEY_EXPIRED: ErrorMapping = {
  code: 'CONFLICT',
  message:
    'The create key expired. An earlier attempt under it may or may not have been applied. Reconcile existing PTO records before creating again; this server never assumes failure and never mints a new key.',
  recovery: 'reconcile',
};
const PREVIEW_INVALID: ErrorMapping = {
  code: 'PREVIEW',
  message: MESSAGES.PREVIEW,
  recovery: 'reconcile',
};
const PREVIEW_MISMATCH: ErrorMapping = {
  code: 'PREVIEW',
  message: `The apply arguments do not match the preview. ${PREVIEW_RECONCILIATION}`,
  recovery: 'reconcile',
};
const PREVIEW_BINDING: ErrorMapping = {
  code: 'PERMISSION',
  message:
    'The credential, live role, actor or origin changed after the preview, so nothing was sent. Reconcile existing PTO records; do not retry this intent with a changed credential or a replaced binding.',
  recovery: 'reconcile',
};
const CREATE_KEY_CONFLICT: ErrorMapping = {
  code: 'CONFLICT',
  message:
    'This create key was already observed in this process with a different origin, actor, credential or canonical payload. Nothing was sent. Reconcile existing PTO records; never reuse this key for another intent and never retry it with a changed credential or a new key.',
  recovery: 'reconcile',
};
const CREATE_KEY_FULL: ErrorMapping = {
  code: 'CONFLICT',
  message:
    'The local create-key registry is full, so this new create key was not accepted. Nothing was sent. Reconcile existing PTO records before creating again; this server never evicts an observed key.',
  recovery: 'reconcile',
};
const CREATE_KEY_MISSING: ErrorMapping = {
  code: 'CONFLICT',
  message:
    'No retained process-local binding exists for this create key, so nothing was sent. Reconcile existing PTO records before creating again; do not assume failure and do not mint a new key automatically.',
  recovery: 'reconcile',
};
const PRE_DISPATCH_TIMEOUT: ErrorMapping = {
  code: 'NETWORK',
  message: 'The local time budget was exhausted before the request was sent. Nothing was changed.',
  recovery: 'retry-preview',
};
const UNKNOWN_CREATE: ErrorMapping = {
  code: 'UNKNOWN_OUTCOME',
  message:
    'The create outcome is unknown, so the entry may exist. Do not start a new create. Reconcile existing PTO records and audit entries before any further mutation. Only the exact same credential, payload and unexpired key may be resumed, after the user explicitly approves that exact replay. This server never retries automatically.',
  recovery: 'reconcile',
};
const UNKNOWN_UPDATE: ErrorMapping = {
  code: 'UNKNOWN_OUTCOME',
  message:
    'The update outcome is unknown, so the change may already be applied. Do not retry. Read the entry and reconcile it before any further mutation. This server never retries automatically.',
  recovery: 'reconcile',
};
const UNKNOWN_DELETE: ErrorMapping = {
  code: 'UNKNOWN_OUTCOME',
  message:
    'The delete outcome is unknown, so the entry may already be removed. Do not retry. Read the entry and reconcile it before any further mutation. This server never retries automatically.',
  recovery: 'reconcile',
};
const UNEXPECTED_SERVICE: ErrorMapping = {
  code: 'NETWORK',
  message: MESSAGES.NETWORK,
  recovery: 'none',
};
const VALIDATION: ErrorMapping = {
  code: 'INPUT',
  message: 'The service rejected the request parameters. Nothing was changed.',
  recovery: 'none',
};

/** Every failure of the local credential store, mapped to a category and a recovery. */
const AUTH_CODES: Readonly<Record<AgentAuthErrorCode, WriteErrorCode>> = {
  INVALID_PROFILE: 'LOCAL',
  INVALID_ORIGIN: 'LOCAL',
  INVALID_TOKEN: 'AUTH',
  INVALID_OPTIONS: 'LOCAL',
  AMBIGUOUS_CREDENTIALS: 'LOCAL',
  ORIGIN_MISMATCH: 'LOCAL',
  PROFILE_NOT_CONFIGURED: 'AUTH',
  PROFILE_CONFLICT: 'LOCAL',
  PROFILE_CORRUPT: 'LOCAL',
  CREDENTIAL_MISSING: 'AUTH',
  FILE_UNSAFE: 'LOCAL',
  FILE_UNAVAILABLE: 'LOCAL',
  FILE_BUSY: 'BUSY',
  KEYRING_UNSUPPORTED: 'LOCAL',
  KEYRING_UNAVAILABLE: 'AUTH',
  KEYRING_LOCKED: 'AUTH',
  KEYRING_AMBIGUOUS: 'AUTH',
  KEYRING_FAILED: 'AUTH',
  INPUT_REQUIRED: 'LOCAL',
  INPUT_CANCELLED: 'CANCELLED',
  INPUT_UNAVAILABLE: 'LOCAL',
};

/** Every service or transport code a write can see, mapped to one safe answer. */
const API_MAPPING: ReadonlyMap<string, ErrorMapping> = new Map<string, ErrorMapping>([
  [
    'UNAUTHENTICATED',
    {
      code: 'AUTH',
      message:
        'The service did not accept this credential. It may be revoked or expired. Replace it in the signed-in browser UI. Nothing was changed.',
      recovery: 'reauthenticate',
    },
  ],
  ['FORBIDDEN', FORBIDDEN],
  [
    'SESSION_REQUIRED',
    {
      code: 'PERMISSION',
      message: 'This operation needs a browser session, not a personal access token.',
      recovery: 'none',
    },
  ],
  [
    'CSRF_REJECTED',
    {
      code: 'PERMISSION',
      message: 'The service refused the request origin. Nothing was changed.',
      recovery: 'none',
    },
  ],
  [
    'NOT_FOUND',
    {
      code: 'NOT_FOUND',
      message: MESSAGES.NOT_FOUND,
      recovery: 'none',
    },
  ],
  ['CONFLICT', OVERLAP],
  ['STALE_WRITE', STALE],
  [
    'PRECONDITION_REQUIRED',
    {
      code: 'LOCAL',
      message:
        'The service requires a precondition this server did not send. Check the client build.',
      recovery: 'none',
    },
  ],
  ['IDEMPOTENCY_CONFLICT', KEY_CONFLICT],
  ['IDEMPOTENCY_EXPIRED', KEY_EXPIRED],
  [
    'IDEMPOTENCY_KEY_REQUIRED',
    {
      code: 'LOCAL',
      message:
        'The service requires an idempotency key this server did not send. Check the client build.',
      recovery: 'none',
    },
  ],
  [
    'RATE_LIMITED',
    {
      code: 'QUOTA',
      message: MESSAGES.QUOTA,
      recovery: 'wait-retry-after',
    },
  ],
  [
    'TOKEN_LIMIT_REACHED',
    {
      code: 'QUOTA',
      message: 'The maximum number of personal access tokens already exists.',
      recovery: 'none',
    },
  ],
  ['VALIDATION_ERROR', VALIDATION],
  ['INVALID_INPUT', VALIDATION],
  [
    'INVALID_OPTIONS',
    {
      code: 'LOCAL',
      message: 'The client settings are not usable on this machine. Nothing was sent.',
      recovery: 'none',
    },
  ],
  [
    'INVALID_RESPONSE',
    {
      code: 'NETWORK',
      message:
        'The service returned an answer this server cannot use. This server never retries a write automatically.',
      recovery: 'none',
    },
  ],
  [
    'NOT_READY',
    {
      code: 'NETWORK',
      message:
        'The service is not ready yet. Reconcile before retrying. This server never retries a write automatically.',
      recovery: 'none',
    },
  ],
  [
    'INTERNAL_ERROR',
    {
      code: 'NETWORK',
      message:
        'The service could not complete the request. This server never retries a write automatically.',
      recovery: 'none',
    },
  ],
  [
    'TIMEOUT',
    {
      code: 'NETWORK',
      message:
        'The service did not answer within the time limit. This server never retries a write automatically.',
      recovery: 'none',
    },
  ],
  [
    'NETWORK_ERROR',
    {
      code: 'NETWORK',
      message: 'The service could not be reached. This server never retries a write automatically.',
      recovery: 'none',
    },
  ],
  [
    'REDIRECT',
    {
      code: 'NETWORK',
      message:
        'The service answered with a redirect, which this client does not follow. This server never retries a write automatically.',
      recovery: 'none',
    },
  ],
  [
    'HTTP_ERROR',
    {
      code: 'NETWORK',
      message:
        'The service answered with an error this client does not recognize. This server never retries a write automatically.',
      recovery: 'none',
    },
  ],
  ['ABORTED', CANCELLED],
]);

/**
 * The bounded correlation of a failure of the service.
 *
 * The write surface never exposes an upstream correlation value: it has not
 * verified that the value is safe or belongs to this answer. It keeps only the
 * HTTP status and a bounded Retry-After, and always reports the upstream
 * correlation member as null.
 */
interface Correlation {
  readonly status: number | null;
  readonly retryAfterMs: number | null;
}

const NO_CORRELATION: Correlation = {
  status: null,
  retryAfterMs: null,
};

/** The category of a failure of the local credential store. */
function authMapping(error: AgentAuthError): ErrorMapping {
  const code = AUTH_CODES[error.code] ?? 'LOCAL';
  return {
    code,
    message: MESSAGES[code],
    recovery: code === 'AUTH' ? 'reauthenticate' : 'none',
  };
}

/** The safe category of a failure of the service or the transport. */
function mappingFor(error: PtoApiError): ErrorMapping {
  return API_MAPPING.get(error.code) ?? UNEXPECTED_SERVICE;
}

/** The unknown-outcome text of one operation. */
function unknownMapping(tool: WriteToolName): ErrorMapping {
  if (tool === 'pto_create') return UNKNOWN_CREATE;
  return tool === 'pto_update' ? UNKNOWN_UPDATE : UNKNOWN_DELETE;
}

/**
 * Whether an error proves that the request was never applied.
 *
 * The shared client sets `unknownWriteOutcome` on every failure after a write
 * dispatch that may have been committed. Only a `PtoApiError` without that flag
 * is definite, and any other thrown value is conservatively unknown.
 */
function isDefinitive(error: unknown): error is PtoApiError {
  return error instanceof PtoApiError && !error.unknownWriteOutcome;
}

/** The retry hint is kept only when it is a whole number of milliseconds. */
function safeRetryAfter(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/** The bounded correlation of a failure of the service. */
function correlationOf(error: PtoApiError): Correlation {
  return {
    status: error.status > 0 ? error.status : null,
    retryAfterMs: safeRetryAfter(error.retryAfterMs),
  };
}

/** Builds the closed failure envelope of one mutation. */
function failure(
  tool: WriteToolName,
  mapping: ErrorMapping,
  requestId: string,
  correlation: Correlation = NO_CORRELATION,
): WriteToolResult {
  return {
    schemaVersion: MCP_SCHEMA_VERSION,
    requestId,
    ok: false,
    tool,
    error: {
      code: mapping.code,
      message: mapping.message,
      status: correlation.status,
      upstreamRequestId: null,
      retryAfterMs: correlation.retryAfterMs,
      recovery: mapping.recovery,
    },
  };
}

/** Builds the failure of one category for a call that produced no other detail. */
export function writeToolFailure(tool: WriteToolName, code: ToolErrorCode): WriteToolResult {
  const mapped: WriteErrorCode = code === 'INCOMPLETE' ? 'LOCAL' : code;
  return failure(
    tool,
    { code: mapped, message: MESSAGES[mapped], recovery: 'none' },
    adapterRequestId(randomUUID()),
  );
}

/** Builds the success envelope of one create answer. */
function createSuccess(
  data: CreatePreviewData | CreateApplyData,
  requestId: string,
): WriteToolResult {
  return { schemaVersion: MCP_SCHEMA_VERSION, requestId, ok: true, tool: 'pto_create', data };
}

/** Builds the success envelope of one update answer. */
function updateSuccess(
  data: UpdatePreviewData | UpdateApplyData,
  requestId: string,
): WriteToolResult {
  return { schemaVersion: MCP_SCHEMA_VERSION, requestId, ok: true, tool: 'pto_update', data };
}

/** Builds the success envelope of one delete answer. */
function deleteSuccess(
  data: DeletePreviewData | DeleteApplyData,
  requestId: string,
): WriteToolResult {
  return { schemaVersion: MCP_SCHEMA_VERSION, requestId, ok: true, tool: 'pto_delete', data };
}

/* ------------------------------------------------------------------------- */
/* Credential, client and live identity.                                     */
/* ------------------------------------------------------------------------- */

/** The client of one resolved binding, bound to the origin the facade resolved. */
function clientOptionsFor(bundle: AgentAuthCredential): PtoClientOptions {
  return {
    baseUrl: bundle.baseUrl,
    credential: { origin: bundle.credential.origin, token: bundle.credential.token },
    allowLoopbackHttp: bundle.allowLoopbackHttp,
    timeoutMs: WRITE_DEADLINE_MS,
    readRetries: READ_RETRIES,
  };
}

/** A deadline of one whole mutation call. */
interface Budget {
  /** The remaining milliseconds. An exhausted budget is a timeout. */
  remaining(): number;
}

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

/** The live context of one preview or apply. */
interface LiveContext {
  readonly bundle: AgentAuthCredential;
  readonly client: WriteClient;
  readonly identity: PtoIdentity;
  readonly budget: Budget;
}

type LiveResult =
  | { readonly ok: true; readonly live: LiveContext }
  | { readonly ok: false; readonly result: WriteToolResult };

/** Resolves the credential, opens the origin-bound client and reads the live identity. */
async function resolveLive(
  tool: WriteToolName,
  launch: LaunchOptions,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  dependencies: WriteToolDependencies,
  requestId: string,
): Promise<LiveResult> {
  const budget = budgetOf(dependencies.now, WRITE_DEADLINE_MS);
  let bundle: AgentAuthCredential;
  try {
    bundle = await dependencies.createAuth().resolve(resolveInputFor(launch, env, signal));
  } catch (error) {
    if (signal.aborted) return { ok: false, result: failure(tool, CANCELLED, requestId) };
    if (error instanceof AgentAuthError) {
      return { ok: false, result: failure(tool, authMapping(error), requestId) };
    }
    return { ok: false, result: failure(tool, UNEXPECTED_LOCAL, requestId) };
  }
  if (signal.aborted) return { ok: false, result: failure(tool, CANCELLED, requestId) };
  try {
    const client = dependencies.createClient(clientOptionsFor(bundle));
    const identity = await client.getIdentity({ signal, timeoutMs: budget.remaining() });
    if (signal.aborted) return { ok: false, result: failure(tool, CANCELLED, requestId) };
    return { ok: true, live: { bundle, client, identity, budget } };
  } catch (error) {
    return {
      ok: false,
      result: preflightFailure(tool, error, signal, requestId),
    };
  }
}

/** The safe failure of a call that did not dispatch a mutation. */
function preflightFailure(
  tool: WriteToolName,
  error: unknown,
  signal: AbortSignal,
  requestId: string,
): WriteToolResult {
  if (signal.aborted) return failure(tool, CANCELLED, requestId);
  if (error instanceof PtoApiError) {
    const mapping = error.code === 'TIMEOUT' ? PRE_DISPATCH_TIMEOUT : mappingFor(error);
    return failure(tool, mapping, requestId, correlationOf(error));
  }
  return failure(tool, UNEXPECTED_LOCAL, requestId);
}

/**
 * The safe failure of a mutation that may or may not have been dispatched.
 *
 * Only a definitive refusal keeps its category. A dispatched write whose answer
 * was lost is always an unknown outcome with reconciliation guidance, never a
 * failure or a cancellation.
 */
function settleSent(
  tool: WriteToolName,
  error: unknown,
  dispatched: boolean,
  signal: AbortSignal,
  requestId: string,
): WriteToolResult {
  if (!dispatched) return preflightFailure(tool, error, signal, requestId);
  const correlation = error instanceof PtoApiError ? correlationOf(error) : NO_CORRELATION;
  if (!isDefinitive(error)) {
    return failure(tool, unknownMapping(tool), requestId, correlation);
  }
  if (error.code === 'STALE_WRITE') return failure(tool, STALE, requestId, correlation);
  return failure(tool, mappingFor(error), requestId, correlation);
}

/* ------------------------------------------------------------------------- */
/* Permission rules. The service applies the same rules again.               */
/* ------------------------------------------------------------------------- */

const SCOPE_BY_KIND: Readonly<
  Record<'update' | 'delete', { readonly self: PtoScope; readonly team: PtoScope }>
> = {
  update: { self: 'pto:update:self', team: 'pto:update:team' },
  delete: { self: 'pto:delete:self', team: 'pto:delete:team' },
};

function sameUuid(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** The missing-scope failure, or null when the live token holds the scope. */
function scopeFailure(identity: PtoIdentity, scope: PtoScope): ErrorMapping | null {
  return identity.auth.scopes.includes(scope) ? null : SCOPE;
}

/**
 * The owner and scope rules of a change to an existing entry.
 *
 * A token may change its own entry with its self scope, and a teammate's entry
 * only with its team scope and a live team-lead or administrator role. The
 * server applies the same rules again when the request arrives.
 */
function changeFailure(
  identity: PtoIdentity,
  ownerId: string,
  kind: 'update' | 'delete',
): ErrorMapping | null {
  const lead = identity.role === 'team_lead' || identity.role === 'admin';
  const own = sameUuid(identity.id, ownerId);
  if (!lead && !own) return OWNER;
  const scopes = SCOPE_BY_KIND[kind];
  const selfAllowed = own && identity.auth.scopes.includes(scopes.self);
  const teamAllowed = lead && identity.auth.scopes.includes(scopes.team);
  return selfAllowed || teamAllowed ? null : SCOPE;
}

/* ------------------------------------------------------------------------- */
/* Plans, digests and safe projections.                                      */
/* ------------------------------------------------------------------------- */

/** The effective values of one create or one update. */
interface Plan {
  readonly startDate: string;
  readonly endDate: string;
  /** The day part the service stores. A range longer than one day is `all_day`. */
  readonly dayPart: PtoDayPart;
}

/**
 * The plan of a create.
 *
 * A single day keeps the requested day part. A longer range is stored as
 * `all_day`; the preview shows that effective value next to the request, so the
 * normalization is never silent.
 */
function planCreate(args: CreateArguments): Plan {
  return {
    startDate: args.startDate,
    endDate: args.endDate,
    dayPart: args.startDate === args.endDate ? args.dayPart : 'all_day',
  };
}

/** The create body the service is sent. The owner is never part of it. */
function createPayloadOf(args: CreateArguments): CreatePtoPayload {
  return {
    startDate: args.startDate,
    endDate: args.endDate,
    dayPart: args.dayPart,
    ...(args.note === undefined ? {} : { note: args.note }),
  };
}

/**
 * The plan of an update: the explicit changes merged against the live entry.
 *
 * An omitted date or day part keeps its stored value. The complete merged range
 * must satisfy the same real-weekday, ordered rules as a create before either a
 * preview or an apply continues. A stored half-day cannot describe a longer
 * range, so such a change needs an explicit day part; the preview refuses
 * instead of silently changing it.
 */
function planUpdate(detail: PtoDetail, changes: UpdateChanges): InputResult<Plan> {
  const startDate = changes.startDate ?? detail.startDate;
  const endDate = changes.endDate ?? detail.endDate;
  const range = validateEffectiveRange(startDate, endDate);
  if (!range.ok) return range;
  let dayPart: PtoDayPart;
  if (startDate === endDate) {
    dayPart = changes.dayPart ?? detail.dayPart;
  } else if (changes.dayPart !== undefined || detail.dayPart === 'all_day') {
    dayPart = 'all_day';
  } else {
    return {
      ok: false,
      code: 'INPUT',
      message: WRITE_INPUT_MESSAGES.storedDayPart,
    };
  }
  return { ok: true, value: { startDate, endDate, dayPart } };
}

/**
 * The update body: only actual effective changes plus an explicit note.
 *
 * A supplied date or day part that leaves the stored value unchanged is dropped,
 * so repeating the current value does not inflate the PATCH. A changed range
 * sends the effective day part (including `all_day` normalization). An explicit
 * note is always preserved, because the current note is never read or compared.
 */
function wireChangesOf(detail: PtoDetail, plan: Plan, changes: UpdateChanges): PatchPtoChanges {
  return {
    ...(plan.startDate === detail.startDate ? {} : { startDate: plan.startDate }),
    ...(plan.endDate === detail.endDate ? {} : { endDate: plan.endDate }),
    ...(plan.dayPart === detail.dayPart ? {} : { dayPart: plan.dayPart }),
    ...(changes.note === undefined ? {} : { note: changes.note }),
  };
}

/** The effective range of one plan. */
function rangeOf(plan: Plan): EffectiveRange {
  return { startDate: plan.startDate, endDate: plan.endDate, dayPart: plan.dayPart };
}

/** The current effective range of one live entry. */
function rangeOfDetail(detail: PtoDetail): EffectiveRange {
  return {
    startDate: detail.startDate,
    endDate: detail.endDate,
    dayPart: detail.dayPart,
  };
}

/** The changed fields of one update. An explicit note always counts. */
function changedFieldsOf(detail: PtoDetail, plan: Plan, changes: UpdateChanges): ChangedField[] {
  const fields: ChangedField[] = [];
  if (plan.startDate !== detail.startDate) fields.push('startDate');
  if (plan.endDate !== detail.endDate) fields.push('endDate');
  if (plan.dayPart !== detail.dayPart) fields.push('dayPart');
  if (changes.note !== undefined) fields.push('note');
  return fields;
}

/** The changed fields of one create. */
function createChangedFields(args: CreateArguments): ChangedField[] {
  return [
    ...CHANGED_FIELDS.filter((field) => field !== 'note'),
    ...(args.note === undefined ? [] : (['note'] as const)),
  ];
}

/** The note intention of one create: no note, or an explicit set. */
function createNoteIntent(args: CreateArguments): Extract<NoteIntent, 'none' | 'set'> {
  return args.note === undefined ? 'none' : 'set';
}

/** The note intention of one update: keep, set or clear. */
function updateNoteIntent(changes: UpdateChanges): Extract<NoteIntent, 'keep' | 'set' | 'clear'> {
  if (changes.note === undefined) return 'keep';
  return changes.note === null ? 'clear' : 'set';
}

/** The canonical intent of a create: exact dates, day part, note and key. */
function canonicalCreate(args: CreateArguments): Record<string, unknown> {
  return {
    operation: 'create',
    startDate: args.startDate,
    endDate: args.endDate,
    dayPart: args.dayPart,
    note: args.note ?? null,
    idempotencyKey: args.idempotencyKey,
  };
}

/** The canonical intent of an update: exact target, version and requested fields. */
function canonicalUpdate(args: UpdateArguments): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  if (args.changes.startDate !== undefined) changes['startDate'] = args.changes.startDate;
  if (args.changes.endDate !== undefined) changes['endDate'] = args.changes.endDate;
  if (args.changes.dayPart !== undefined) changes['dayPart'] = args.changes.dayPart;
  if (args.changes.note !== undefined) changes['note'] = args.changes.note;
  return {
    operation: 'update',
    id: args.id,
    expectedVersion: args.expectedVersion,
    changes,
  };
}

/** The canonical intent of a delete: exact target and version. */
function canonicalDelete(args: DeleteArguments): Record<string, unknown> {
  return { operation: 'delete', id: args.id, expectedVersion: args.expectedVersion };
}

/** The process-keyed digest of one canonical intent. */
function digestOf(args: WriteArguments): string {
  if (args.name === 'pto_create') return payloadDigest(canonicalCreate(args));
  if (args.name === 'pto_update') return payloadDigest(canonicalUpdate(args));
  return payloadDigest(canonicalDelete(args));
}

/** The operation a mutation tool performs. */
function operationOf(name: WriteToolName): WriteOperation {
  if (name === 'pto_create') return 'create';
  return name === 'pto_update' ? 'update' : 'delete';
}

/** The safe record of one live detail. The note is never copied. */
function recordOfDetail(detail: PtoDetail): EffectiveRange {
  return rangeOfDetail(detail);
}

/** The safe record of one mutation answer. The note is never copied. */
function appliedRecordOf(record: PtoRecord): AppliedRecord {
  return {
    id: record.id,
    ownerId: record.userId,
    version: record.version,
    startDate: record.startDate,
    endDate: record.endDate,
    dayPart: record.dayPart,
  };
}

/* ------------------------------------------------------------------------- */
/* Preview.                                                                  */
/* ------------------------------------------------------------------------- */

/** The immutable create-key observation of one live context and intent. */
function createKeyBindingOf(live: LiveContext, intent: string): CreateKeyBinding {
  return {
    origin: live.bundle.baseUrl,
    actorId: live.identity.id.toLowerCase(),
    tokenId: live.identity.auth.tokenId.toLowerCase(),
    credential: credentialFingerprint(live.bundle.credential.token),
    intent,
  };
}

/** The unified one-dispatch guard key of one exact target and version. */
function targetGuardKey(origin: string, id: string, version: number): string {
  return `target:${origin}:${id.toLowerCase()}:${version}`;
}

/** The binding every preview shares, built from live values only. */
function bindingOf(
  live: LiveContext,
  args: WriteArguments,
  ownerId: string,
  target: TargetReference | null,
  before: EffectiveRange | null,
  after: EffectiveRange | null,
  changedFields: readonly ChangedField[],
  noteIntent: NoteIntent,
): PreviewBinding {
  return {
    operation: operationOf(args.name),
    actorId: live.identity.id,
    ownerId,
    origin: live.bundle.baseUrl,
    tokenId: live.identity.auth.tokenId,
    credential: credentialFingerprint(live.bundle.credential.token),
    digest: digestOf(args),
    role: live.identity.role,
    target,
    before,
    after,
    changedFields,
    noteIntent,
  };
}

/** Runs the read-only preview of one mutation. */
async function preview(
  tool: WriteToolName,
  args: WriteArguments,
  launch: LaunchOptions,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  dependencies: WriteToolDependencies,
  requestId: string,
): Promise<WriteToolResult> {
  const live = await resolveLive(tool, launch, env, signal, dependencies, requestId);
  if (!live.ok) return live.result;
  const { identity, client, budget } = live.live;

  try {
    if (args.name === 'pto_create') {
      const scope = scopeFailure(identity, 'pto:create');
      if (scope !== null) return failure(tool, scope, requestId);
      const plan = planCreate(args);
      const binding = bindingOf(
        live.live,
        args,
        identity.id,
        null,
        null,
        rangeOf(plan),
        createChangedFields(args),
        createNoteIntent(args),
      );
      const observation = dependencies.createKeys.observe(
        createKeyFingerprint(args.idempotencyKey),
        createKeyBindingOf(live.live, binding.digest),
      );
      if (observation === 'conflict') return failure(tool, CREATE_KEY_CONFLICT, requestId);
      if (observation === 'full') return failure(tool, CREATE_KEY_FULL, requestId);
      const issued = dependencies.previews.issue(binding);
      if (issued === null) return failure(tool, BUSY, requestId);
      return createSuccess(
        {
          phase: 'preview',
          operation: 'create',
          previewId: issued.id,
          actorId: identity.id,
          ownerId: identity.id,
          expiresAt: issued.expiresAt,
          target: null,
          before: null,
          after: rangeOf(plan),
          changedFields: createChangedFields(args),
          noteIntent: createNoteIntent(args),
        },
        requestId,
      );
    }

    const readScope = scopeFailure(identity, 'pto:read');
    if (readScope !== null) return failure(tool, readScope, requestId);
    const detail = await client.getDetail(args.id, { signal, timeoutMs: budget.remaining() });
    if (signal.aborted) return failure(tool, CANCELLED, requestId);

    if (args.name === 'pto_update') {
      const permission = changeFailure(identity, detail.user.id, 'update');
      if (permission !== null) return failure(tool, permission, requestId);
      if (detail.version !== args.expectedVersion) {
        return failure(tool, STALE_BEFORE_SEND, requestId);
      }
      const plan = planUpdate(detail, args.changes);
      if (!plan.ok) {
        return failure(tool, { code: 'INPUT', message: plan.message, recovery: 'none' }, requestId);
      }
      const changedFields = changedFieldsOf(detail, plan.value, args.changes);
      if (changedFields.length === 0) {
        return failure(
          tool,
          { code: 'INPUT', message: WRITE_INPUT_MESSAGES.noChange, recovery: 'none' },
          requestId,
        );
      }
      const target: TargetReference = { id: detail.id, version: detail.version };
      const binding = bindingOf(
        live.live,
        args,
        detail.user.id,
        target,
        recordOfDetail(detail),
        rangeOf(plan.value),
        changedFields,
        updateNoteIntent(args.changes),
      );
      const issued = dependencies.previews.issue(binding);
      if (issued === null) return failure(tool, BUSY, requestId);
      return updateSuccess(
        {
          phase: 'preview',
          operation: 'update',
          previewId: issued.id,
          actorId: identity.id,
          ownerId: detail.user.id,
          expiresAt: issued.expiresAt,
          target,
          before: recordOfDetail(detail),
          after: rangeOf(plan.value),
          changedFields,
          noteIntent: updateNoteIntent(args.changes),
        },
        requestId,
      );
    }

    const permission = changeFailure(identity, detail.user.id, 'delete');
    if (permission !== null) return failure(tool, permission, requestId);
    if (detail.version !== args.expectedVersion) {
      return failure(tool, STALE_BEFORE_SEND, requestId);
    }
    const target: TargetReference = { id: detail.id, version: detail.version };
    const binding = bindingOf(
      live.live,
      args,
      detail.user.id,
      target,
      recordOfDetail(detail),
      null,
      [],
      'none',
    );
    const issued = dependencies.previews.issue(binding);
    if (issued === null) return failure(tool, BUSY, requestId);
    return deleteSuccess(
      {
        phase: 'preview',
        operation: 'delete',
        previewId: issued.id,
        actorId: identity.id,
        ownerId: detail.user.id,
        expiresAt: issued.expiresAt,
        target,
        before: recordOfDetail(detail),
        after: null,
        changedFields: [],
        noteIntent: 'none',
      },
      requestId,
    );
  } catch (error) {
    return preflightFailure(tool, error, signal, requestId);
  }
}

/* ------------------------------------------------------------------------- */
/* Apply.                                                                    */
/* ------------------------------------------------------------------------- */

/** Whether the live credential still matches the one the preview bound. */
function sameBinding(binding: PreviewBinding, live: LiveContext): boolean {
  return (
    live.bundle.baseUrl === binding.origin &&
    credentialFingerprint(live.bundle.credential.token) === binding.credential &&
    sameUuid(live.identity.auth.tokenId, binding.tokenId) &&
    sameUuid(live.identity.id, binding.actorId) &&
    live.identity.role === binding.role
  );
}

/** Whether the live entry still is the exact one the preview saw. */
function sameEntry(binding: PreviewBinding, detail: PtoDetail): boolean {
  const target = binding.target;
  const before = binding.before;
  if (target === null || before === null) return false;
  return (
    sameUuid(detail.id, target.id) &&
    sameUuid(detail.user.id, binding.ownerId) &&
    detail.version === target.version &&
    detail.startDate === before.startDate &&
    detail.endDate === before.endDate &&
    detail.dayPart === before.dayPart
  );
}

/** The validated arguments of an apply. Validation always supplies its previewId. */
type ApplyArguments = WriteArguments & { readonly previewId: string };

/** Claims the one preview and releases its in-flight mark when the apply settles. */
async function apply(
  tool: WriteToolName,
  args: ApplyArguments,
  launch: LaunchOptions,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  dependencies: WriteToolDependencies,
  requestId: string,
): Promise<WriteToolResult> {
  // The claim is synchronous: a duplicate concurrent apply finds the entry in
  // flight. Only a create preview remains reusable, and only after this call
  // released it, so an ambiguous create can be deliberately resumed with the
  // same key and a fresh host approval. Update and delete previews are one-shot.
  const claimed = dependencies.previews.claim(args.previewId, args.name === 'pto_create');
  if (!claimed.ok) {
    return failure(tool, claimed.reason === 'in-flight' ? BUSY : PREVIEW_INVALID, requestId);
  }
  try {
    return await applyClaimed(
      tool,
      args,
      claimed.preview,
      launch,
      env,
      signal,
      dependencies,
      requestId,
    );
  } finally {
    claimed.release();
  }
}

/** Runs the one conditional write of one claimed preview. */
async function applyClaimed(
  tool: WriteToolName,
  args: ApplyArguments,
  claimed: ClaimedPreview,
  launch: LaunchOptions,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  dependencies: WriteToolDependencies,
  requestId: string,
): Promise<WriteToolResult> {
  const binding = claimed.binding;
  if (binding.operation !== operationOf(tool) || binding.digest !== digestOf(args)) {
    return failure(tool, PREVIEW_MISMATCH, requestId);
  }

  const live = await resolveLive(tool, launch, env, signal, dependencies, requestId);
  if (!live.ok) return live.result;
  if (!sameBinding(binding, live.live)) {
    return failure(tool, PREVIEW_BINDING, requestId);
  }
  const { identity, client, budget } = live.live;

  if (args.name === 'pto_create') {
    const scope = scopeFailure(identity, 'pto:create');
    if (scope !== null) return failure(tool, scope, requestId);
    if (!sameUuid(identity.id, binding.ownerId)) {
      return failure(tool, PREVIEW_BINDING, requestId);
    }
    const plan = planCreate(args);
    if (!sameRange(binding.after, rangeOf(plan)) || binding.noteIntent !== createNoteIntent(args)) {
      return failure(tool, PREVIEW_MISMATCH, requestId);
    }
    const verification = dependencies.createKeys.verify(
      createKeyFingerprint(args.idempotencyKey),
      createKeyBindingOf(live.live, binding.digest),
    );
    if (verification === 'missing') return failure(tool, CREATE_KEY_MISSING, requestId);
    if (verification === 'conflict') return failure(tool, CREATE_KEY_CONFLICT, requestId);
    // The guard never keeps the raw key: it is an HMAC of the key under the process key.
    const release = dependencies.mutations.acquire(
      `create:${payloadDigest({ operation: 'create-guard', idempotencyKey: args.idempotencyKey })}`,
    );
    if (release === undefined) return failure(tool, BUSY, requestId);
    try {
      if (signal.aborted) return failure(tool, CANCELLED, requestId);
      let dispatched = false;
      try {
        // Recheck the same claimed preview's expiry on the same clock after every
        // asynchronous authorization and immediately before this one dispatch.
        if (!dependencies.previews.isLive(claimed)) {
          return failure(tool, PREVIEW_INVALID, requestId);
        }
        const options = { signal, timeoutMs: budget.remaining() };
        dispatched = true;
        const result = await client.create(createPayloadOf(args), args.idempotencyKey, options);
        return createSuccess(
          {
            phase: 'apply',
            operation: 'create',
            record: appliedRecordOf(result.record),
            replayed: result.replayed,
            expiresAt: result.expiresAt,
          },
          requestId,
        );
      } catch (error) {
        return settleSent(tool, error, dispatched, signal, requestId);
      }
    } finally {
      release();
    }
  }

  try {
    const readScope = scopeFailure(identity, 'pto:read');
    if (readScope !== null) return failure(tool, readScope, requestId);
    const detail = await client.getDetail(args.id, { signal, timeoutMs: budget.remaining() });
    if (signal.aborted) return failure(tool, CANCELLED, requestId);

    if (args.name === 'pto_update') {
      const permission = changeFailure(identity, detail.user.id, 'update');
      if (permission !== null) return failure(tool, permission, requestId);
      if (!sameEntry(binding, detail)) return failure(tool, STALE, requestId);
      const plan = planUpdate(detail, args.changes);
      if (!plan.ok) {
        return failure(tool, { code: 'INPUT', message: plan.message, recovery: 'none' }, requestId);
      }
      if (
        !sameRange(binding.after, rangeOf(plan.value)) ||
        binding.noteIntent !== updateNoteIntent(args.changes)
      ) {
        return failure(tool, PREVIEW_MISMATCH, requestId);
      }
      const release = dependencies.mutations.acquire(
        targetGuardKey(binding.origin, detail.id, detail.version),
      );
      if (release === undefined) return failure(tool, BUSY, requestId);
      try {
        if (signal.aborted) return failure(tool, CANCELLED, requestId);
        let dispatched = false;
        try {
          // Recheck the same claimed preview's expiry on the same clock immediately
          // before the one conditional PATCH.
          if (!dependencies.previews.isLive(claimed)) {
            return failure(tool, PREVIEW_INVALID, requestId);
          }
          const options = { signal, timeoutMs: budget.remaining() };
          dispatched = true;
          const record = await client.patch(
            detail.id,
            detail.version,
            wireChangesOf(detail, plan.value, args.changes),
            options,
          );
          return updateSuccess(
            {
              phase: 'apply',
              operation: 'update',
              record: appliedRecordOf(record),
              noteIntent: updateNoteIntent(args.changes),
            },
            requestId,
          );
        } catch (error) {
          return settleSent(tool, error, dispatched, signal, requestId);
        }
      } finally {
        release();
      }
    }

    const permission = changeFailure(identity, detail.user.id, 'delete');
    if (permission !== null) return failure(tool, permission, requestId);
    if (!sameEntry(binding, detail)) return failure(tool, STALE, requestId);
    const release = dependencies.mutations.acquire(
      targetGuardKey(binding.origin, detail.id, detail.version),
    );
    if (release === undefined) return failure(tool, BUSY, requestId);
    try {
      if (signal.aborted) return failure(tool, CANCELLED, requestId);
      let dispatched = false;
      try {
        // Recheck the same claimed preview's expiry on the same clock immediately
        // before the one conditional DELETE.
        if (!dependencies.previews.isLive(claimed)) {
          return failure(tool, PREVIEW_INVALID, requestId);
        }
        const options = { signal, timeoutMs: budget.remaining() };
        dispatched = true;
        await client.delete(detail.id, detail.version, options);
        return deleteSuccess(
          {
            phase: 'apply',
            operation: 'delete',
            deleted: { id: detail.id, ownerId: detail.user.id, version: detail.version },
          },
          requestId,
        );
      } catch (error) {
        return settleSent(tool, error, dispatched, signal, requestId);
      }
    } finally {
      release();
    }
  } catch (error) {
    return preflightFailure(tool, error, signal, requestId);
  }
}

/** Whether two effective ranges are exactly the same. */
function sameRange(left: EffectiveRange | null, right: EffectiveRange): boolean {
  if (left === null) return false;
  return (
    left.startDate === right.startDate &&
    left.endDate === right.endDate &&
    left.dayPart === right.dayPart
  );
}

/* ------------------------------------------------------------------------- */
/* Entry point and production definitions.                                   */
/* ------------------------------------------------------------------------- */

/**
 * Runs one mutation call.
 *
 * The local switch is checked before the arguments and before any store or
 * request. A malformed call never reaches the credential; a preview never
 * writes; an apply dispatches at most once.
 */
export async function executeWriteTool(
  name: WriteToolName,
  input: unknown,
  launch: LaunchOptions,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  dependencies: WriteToolDependencies = DEFAULT_DEPENDENCIES,
): Promise<WriteToolResult> {
  const requestId = adapterRequestId(dependencies.newRequestId());
  if (!writesEnabled(env)) return failure(name, DISABLED, requestId);
  if (signal.aborted) return failure(name, CANCELLED, requestId);
  const parsed = validateWriteArguments(name, input);
  if (!parsed.ok) {
    return failure(
      name,
      {
        code: 'INPUT',
        message: parsed.attemptedApply
          ? `${parsed.message} ${PREVIEW_RECONCILIATION}`
          : parsed.message,
        recovery: parsed.attemptedApply ? 'reconcile' : 'none',
      },
      requestId,
    );
  }
  return parsed.value.mode === 'preview'
    ? preview(name, parsed.value, launch, env, signal, dependencies, requestId)
    : // Validation requires a previewId on apply, so the narrowed value carries one.
      apply(name, parsed.value as ApplyArguments, launch, env, signal, dependencies, requestId);
}

/**
 * The tool surface this server adds when the host enables writes.
 *
 * There are exactly three mutation tools. None accepts an owner, a role, an
 * origin, a credential, a header, a path, a command, a link or a `confirmed`
 * flag. A definition is a hint and a schema, never an authorization rule: the
 * live identity, scope, ownership, version and the API rollout flags decide
 * every request.
 */
export const WRITE_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'pto_create',
    title: 'Create a PTO entry',
    description:
      'Create one PTO entry for the credential owner. Call mode "preview" first: it is read-only and returns the actor, the derived owner, the effective dates and day part, the changed fields, the note intention and an opaque previewId. After the host showed that exact preview and the user explicitly approved this call, call again with mode "apply", the same arguments and that previewId. A previewId, an annotation or any argument is not proof of human approval. The credential needs pto:create and the service must enable writes. Only the same credential, payload and unexpired canonical idempotencyKey may resume a lost create, after the user explicitly approves that exact replay; never mint a new key automatically, and reconcile after an unknown outcome. Notes are never returned, and no owner, role or credential argument is accepted.',
    inputSchema: CREATE_INPUT_SCHEMA,
    outputSchema: CREATE_OUTPUT_SCHEMA,
    annotations: {
      title: 'Create a PTO entry',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'pto_update',
    title: 'Update a PTO entry',
    description:
      'Update one PTO entry by exact identifier and exact expected version. Call mode "preview" first: it is read-only and returns the current and proposed dates and day part, the changed fields, the note intention and an opaque previewId. After the host showed that exact preview and the user explicitly approved this call, call again with mode "apply", the same arguments and that previewId. A previewId, an annotation or any argument is not proof of human approval. The update sends only the fields that actually change, plus any explicitly requested note, with one conditional PATCH; an omitted note preserves the stored note (even a hidden one), while null or the empty string clears it. A stale version or a conflict must be reconciled with a fresh read and a fresh preview; this server never retries a write automatically. Notes are never returned, and no owner, role or credential argument is accepted.',
    inputSchema: UPDATE_INPUT_SCHEMA,
    outputSchema: UPDATE_OUTPUT_SCHEMA,
    annotations: {
      title: 'Update a PTO entry',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'pto_delete',
    title: 'Delete a PTO entry',
    description:
      'Delete one PTO entry by exact identifier and exact expected version. Call mode "preview" first: it is read-only and returns the actor, owner, current dates and day part and an opaque previewId. After the host showed that exact preview and the user explicitly approved this call, call again with mode "apply", the same arguments and that previewId. A previewId, an annotation or any argument is not proof of human approval. The delete sends one conditional DELETE with the exact version. A stale version or a conflict must be reconciled with a fresh read and a fresh preview; this server never retries a write automatically. No owner, role or credential argument is accepted.',
    inputSchema: DELETE_INPUT_SCHEMA,
    outputSchema: DELETE_OUTPUT_SCHEMA,
    annotations: {
      title: 'Delete a PTO entry',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
];

/** Dispatches one tool of either surface. */
export function executeTool(
  name: AnyToolName,
  input: unknown,
  launch: LaunchOptions,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<AnyToolResult> {
  return isWriteToolName(name)
    ? executeWriteTool(name, input, launch, env, signal)
    : executeReadTool(name, input, launch, env, signal);
}

/** Builds the fixed failure of one category for either surface. */
export function anyToolFailure(tool: AnyToolName, code: ToolErrorCode): AnyToolResult {
  return isWriteToolName(tool) ? writeToolFailure(tool, code) : toolFailure(tool, code);
}
