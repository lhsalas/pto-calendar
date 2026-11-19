/**
 * The read-only tools of the local PTO MCP server.
 *
 * This module owns the whole path from a model-visible argument to a bounded
 * answer: it validates the argument, resolves the local credential, reads the
 * shared API and projects the answer into the closed envelope the protocol
 * carries.
 *
 * The rules it never breaks:
 *
 * - a tool call never chooses a credential, an origin, a header, a path or a
 *   role. The credential comes from the local store of the shared package or
 *   from the managed environment pair, and the request is built by the shared
 *   client, which binds the credential to one origin;
 * - a tool call never writes. The client surface this module holds has no
 *   create, update or delete member, and no flag, environment variable or
 *   launch option can add one;
 * - a tool call never asks for a secret. The setup command reads a secret
 *   once; a tool call can only report that a credential is missing;
 * - a tool call never echoes. Every answer is an allowlisted projection, every
 *   text is bounded and scrubbed, and every diagnostic is a fixed sentence.
 */

import { randomUUID } from 'node:crypto';

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
  type ListAllClientResult,
  type ListAllQuery,
  type PtoClient,
  type PtoClientOptions,
} from '@pto-calendar/api-client';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import {
  GET_DEADLINE_MS,
  LIST_DEADLINE_MS,
  LIST_RECORD_LIMIT,
  MCP_SCHEMA_VERSION,
  TOOL_NAMES,
  type LaunchOptions,
  type ReadToolList,
  type ToolErrorCode,
  type ToolName,
  type ToolRecord,
  type ToolResult,
} from './contract.js';
import {
  GET_INPUT_SCHEMA,
  GET_OUTPUT_SCHEMA,
  INPUT_MESSAGES,
  LIST_INPUT_SCHEMA,
  LIST_OUTPUT_SCHEMA,
  adapterRequestId,
  projectList,
  projectRecord,
  scrubberForCredential,
  validateGetArguments,
  validateListArguments,
  type GetArguments,
  type ListArguments,
  type Scrub,
} from './schema.js';

/**
 * The read surface of the shared client.
 *
 * The type has no create, update or delete member, so a write cannot even be
 * expressed here. There is no flag, environment variable or launch option that
 * could add one later: a write would need a new code path, and it would have
 * to name a member this type does not have.
 */
export type ReadClient = Pick<PtoClient, 'getIdentity' | 'listAll' | 'getDetail'>;

/**
 * The seam the tests use to replace the local store and the transport.
 *
 * The public path passes the real factories of the shared packages. Nothing
 * outside this module can choose a store, a header, a URL or a transport
 * through it.
 */
export interface ToolDependencies {
  readonly createAuth: (options?: AgentAuthOptions) => AgentAuth;
  readonly createClient: (options: PtoClientOptions) => ReadClient;
  /** A monotonic clock in milliseconds. */
  readonly now: () => number;
  /** The request identifier of one call. */
  readonly newRequestId: () => string;
}

const DEFAULT_DEPENDENCIES: ToolDependencies = {
  createAuth: createAgentAuth,
  createClient: createPtoClient,
  now: () => performance.now(),
  newRequestId: () => randomUUID(),
};

/** The number of GET retries the shared client may spend inside its own budget. */
const READ_RETRIES = 2;

/** The longest correlation id that is kept and shown. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,200}$/;

/** The fixed messages of the error categories. */
const MESSAGES: Readonly<Record<ToolErrorCode, string>> = {
  INPUT: 'The tool arguments are not valid.',
  AUTH: 'No usable credential. Configure the local profile outside the tool, or replace a revoked or expired token in the signed-in browser UI.',
  PERMISSION: 'The credential is not allowed to read this data.',
  NOT_FOUND: 'No PTO entry matches this identifier, or the credential cannot see it.',
  QUOTA:
    'The service is rate limiting this credential. Wait for the period it asks for, then try again.',
  NETWORK: 'The service could not be reached, or answered with something this server cannot use.',
  INCOMPLETE:
    'The calendar read is incomplete and is not a point-in-time snapshot. The rows that were read are included; missing rows are not confirmed absent. Recover by asking for a narrower explicit date range, or by splitting the range into smaller ranges, and compare the results yourself; never retry the same call in a loop.',
  CANCELLED: 'The tool call was cancelled.',
  LOCAL:
    'The local configuration could not be used. Verify the named profile or complete managed credential pair outside the tool.',
  BUSY: 'The tool server or local credential store is busy. Try again once another call finishes.',
};

/** The fixed message of a local failure that is not classified any further. */
const UNEXPECTED = 'The local PTO tool server could not complete this call.';

/** Every failure of the local store, mapped to one category. */
const AGENT_AUTH_MAPPING: Readonly<Record<AgentAuthErrorCode, ToolErrorCode>> = {
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

/** Every failure the service or the transport reports, mapped to one category. */
const API_MAPPING: Readonly<Record<string, ToolErrorCode>> = {
  UNAUTHENTICATED: 'AUTH',
  FORBIDDEN: 'PERMISSION',
  SESSION_REQUIRED: 'PERMISSION',
  CSRF_REJECTED: 'PERMISSION',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'QUOTA',
  TOKEN_LIMIT_REACHED: 'QUOTA',
  VALIDATION_ERROR: 'INPUT',
  INVALID_INPUT: 'INPUT',
  INVALID_OPTIONS: 'LOCAL',
  INVALID_RESPONSE: 'NETWORK',
  NOT_READY: 'NETWORK',
  INTERNAL_ERROR: 'NETWORK',
  TIMEOUT: 'NETWORK',
  NETWORK_ERROR: 'NETWORK',
  REDIRECT: 'NETWORK',
  HTTP_ERROR: 'NETWORK',
  ABORTED: 'CANCELLED',
};

/** The correlation of a failure. Every field is null when it is unavailable. */
interface Correlation {
  readonly status: number | null;
  readonly upstreamRequestId: string | null;
  readonly retryAfterMs: number | null;
}

const NO_CORRELATION: Correlation = {
  status: null,
  upstreamRequestId: null,
  retryAfterMs: null,
};

/** The extra members a failure envelope may carry. */
interface FailureDetail extends Correlation {
  readonly partial?: ReadToolList;
}

/** Whether the value names one of the documented read tools. */
function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value);
}

/** The tool an envelope names. An unknown name is reported as the first one. */
function reportedTool(name: string): ToolName {
  return name === 'pto_get' ? 'pto_get' : 'pto_list';
}

/**
 * The trusted environment pair, projected for the shared facade.
 *
 * Only the two own fields are copied, and only when they are present. A field
 * that is present is passed on even when it is malformed, so the facade
 * refuses an incomplete pair instead of silently falling back to a profile.
 * Every other variable of the environment is never read.
 */
function managedEnvironment(env: NodeJS.ProcessEnv): AgentAuthEnvironment | undefined {
  const record: { PTO_API_ORIGIN?: string; PTO_API_TOKEN?: string } = {};
  if (Object.hasOwn(env, 'PTO_API_ORIGIN')) record.PTO_API_ORIGIN = env['PTO_API_ORIGIN'];
  if (Object.hasOwn(env, 'PTO_API_TOKEN')) record.PTO_API_TOKEN = env['PTO_API_TOKEN'];
  return Object.keys(record).length === 0 ? undefined : record;
}

/**
 * The input of the shared credential resolver.
 *
 * A named profile and a managed pair are never combined: the facade refuses
 * that combination, so an explicit profile is never silently ignored in
 * favour of the environment. The signal of the call is passed on, so a
 * cancelled call stops the credential lookup instead of waiting for it.
 */
function resolveInputFor(
  launch: LaunchOptions,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): ResolveInput {
  const managed = managedEnvironment(env);
  return {
    ...(launch.profile === undefined ? {} : { profile: launch.profile }),
    allowLoopbackHttp: launch.allowLoopbackHttp === true,
    ...(managed === undefined ? {} : { env: managed }),
    signal,
  };
}

/**
 * The client options of one resolved binding.
 *
 * The client is bound to the origin the facade resolved, never to an origin
 * the caller named. The per-request deadline is always passed explicitly.
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

/** A deadline of `totalMs` from now. */
interface Budget {
  /** The remaining milliseconds. An exhausted budget is a timeout. */
  remaining(): number;
}

/**
 * Builds the one deadline of a call.
 *
 * A non-positive remainder is never passed to the client: the client would
 * read it as "no deadline" and grant its default. An exhausted budget stops
 * the call instead.
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

/**
 * A correlation id is kept only when it looks like one and carries no secret.
 */
function safeRequestId(value: string | null, scrub: Scrub): string | null {
  if (value === null) return null;
  if (!SAFE_REQUEST_ID.test(value)) return null;
  return scrub(value) === value ? value : null;
}

/**
 * The retry hint is kept only when it is a whole number of milliseconds.
 */
function safeRetryAfter(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/** The correlation of a failure of the service. */
function correlationOf(error: PtoApiError, scrub: Scrub): Correlation {
  return {
    status: error.status > 0 ? error.status : null,
    upstreamRequestId: safeRequestId(error.requestId, scrub),
    retryAfterMs: safeRetryAfter(error.retryAfterMs),
  };
}

/** The category of a failure of the service. */
function apiCodeOf(error: PtoApiError): ToolErrorCode {
  return API_MAPPING[error.code] ?? 'NETWORK';
}

/** The category of a failure of the local store. */
function authCodeOf(error: unknown): ToolErrorCode {
  if (error instanceof AgentAuthError) return AGENT_AUTH_MAPPING[error.code] ?? 'LOCAL';
  return 'LOCAL';
}

/**
 * Builds a failure envelope.
 *
 * The envelope carries the fixed message of the category, the status and the
 * correlation of the upstream answer when they are safe, and never a cause, a
 * raw message or a reflected argument.
 */
function failure(
  tool: ToolName,
  code: ToolErrorCode,
  message: string,
  requestId: string,
  detail: FailureDetail = NO_CORRELATION,
): ToolResult {
  return {
    schemaVersion: MCP_SCHEMA_VERSION,
    requestId,
    ok: false,
    tool,
    error: {
      code,
      message,
      status: detail.status,
      upstreamRequestId: detail.upstreamRequestId,
      retryAfterMs: detail.retryAfterMs,
    },
    ...(detail.partial === undefined ? {} : { partial: detail.partial }),
  };
}

/** Builds the success envelope of the list tool. */
function listSuccess(data: ReadToolList, requestId: string): ToolResult {
  return { schemaVersion: MCP_SCHEMA_VERSION, requestId, ok: true, tool: 'pto_list', data };
}

/** Builds the success envelope of the detail tool. */
function getSuccess(data: ToolRecord, requestId: string): ToolResult {
  return { schemaVersion: MCP_SCHEMA_VERSION, requestId, ok: true, tool: 'pto_get', data };
}

/**
 * Builds the failure envelope of one category.
 *
 * The envelope is complete on its own: it carries the schema version, a fresh
 * request identifier and the fixed message of the category.
 */
export function toolFailure(tool: ToolName, code: ToolErrorCode): ToolResult {
  return failure(tool, code, MESSAGES[code], randomUUID());
}

/**
 * The traversal error that may name a category.
 *
 * A budget stop and a drift stop are not service failures: the read simply
 * stopped early, so the answer is an incomplete one.
 */
function usableError(result: ListAllClientResult): PtoApiError | undefined {
  if (result.reason === 'budget' || result.reason === 'drift') return undefined;
  return result.error;
}

/**
 * The outcome of a bounded list read.
 *
 * A cancellation beats every other classification. A complete read is a
 * success. Any other stop is incomplete: with rows it stays incomplete, and
 * without rows a failure of the service keeps its own category.
 */
function listOutcome(
  result: ListAllClientResult,
  scrub: Scrub,
  requestId: string,
  signal: AbortSignal,
): ToolResult {
  const partial = projectList(result.items, result.complete, result.reason, result.pages, scrub);
  if (signal.aborted || result.reason === 'aborted') {
    return failure('pto_list', 'CANCELLED', MESSAGES.CANCELLED, requestId, {
      ...NO_CORRELATION,
      partial: { ...partial, complete: false, reason: 'aborted' },
    });
  }
  if (partial.complete) return listSuccess(partial, requestId);
  const cause = usableError(result);
  if (cause !== undefined && result.items.length === 0) {
    return failure('pto_list', apiCodeOf(cause), MESSAGES[apiCodeOf(cause)], requestId, {
      ...correlationOf(cause, scrub),
      partial,
    });
  }
  return failure('pto_list', 'INCOMPLETE', MESSAGES.INCOMPLETE, requestId, {
    ...(cause === undefined ? NO_CORRELATION : correlationOf(cause, scrub)),
    partial,
  });
}

/**
 * Reads the records of an inclusive range.
 *
 * The own-records filter resolves the identity of the credential first, so a
 * revoked or expired credential fails before any row is read. The identity
 * call and the traversal share one deadline.
 */
async function runList(
  client: ReadClient,
  args: ListArguments,
  signal: AbortSignal,
  budget: Budget,
  scrub: Scrub,
  requestId: string,
): Promise<ToolResult> {
  let ownerId = args.ownerId;
  if (args.mine) {
    const identity = await client.getIdentity({ signal, timeoutMs: budget.remaining() });
    ownerId = identity.id;
  }
  const query: ListAllQuery = {
    start: args.from,
    end: args.to,
    ...(ownerId === undefined ? {} : { userId: ownerId }),
    limit: args.pageSize,
  };
  const traversal = await client.listAll(query, {
    signal,
    timeoutMs: budget.remaining(),
    maxPages: args.maxPages,
    maxRecords: LIST_RECORD_LIMIT,
  });
  return listOutcome(traversal, scrub, requestId, signal);
}

/**
 * Reads one record.
 *
 * The note is carried only when it was asked for explicitly and the service
 * returned one: the service decides what the credential may see.
 */
async function runGet(
  client: ReadClient,
  args: GetArguments,
  signal: AbortSignal,
  budget: Budget,
  scrub: Scrub,
  requestId: string,
): Promise<ToolResult> {
  const detail = await client.getDetail(args.id, { signal, timeoutMs: budget.remaining() });
  return getSuccess(projectRecord(detail, scrub, args.includeNote), requestId);
}

/**
 * Resolves the credential and runs one read with it.
 *
 * The credential is resolved after the arguments were validated, so a
 * malformed call never opens the local store. A cancelled call never reaches
 * the service, and a failure of the service is reported with its own
 * category.
 */
async function withCredential(
  tool: ToolName,
  launch: LaunchOptions,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  dependencies: ToolDependencies,
  requestId: string,
  read: (client: ReadClient, budget: Budget, scrub: Scrub) => Promise<ToolResult>,
): Promise<ToolResult> {
  const deadline = tool === 'pto_list' ? LIST_DEADLINE_MS : GET_DEADLINE_MS;
  // The deadline covers the whole call: the local store, the identity and the
  // rows are one budget and none of them may spend the time of the others.
  const budget = budgetOf(dependencies.now, deadline);
  let bundle: AgentAuthCredential;
  try {
    bundle = await dependencies.createAuth().resolve(resolveInputFor(launch, env, signal));
  } catch (error) {
    const code = authCodeOf(error);
    return failure(tool, code, MESSAGES[code], requestId);
  }
  if (signal.aborted) {
    return failure(tool, 'CANCELLED', MESSAGES.CANCELLED, requestId);
  }

  const scrub = scrubberForCredential(bundle.credential.token);
  try {
    const client = dependencies.createClient(clientOptionsFor(bundle, deadline));
    return await read(client, budget, scrub);
  } catch (error) {
    if (signal.aborted) {
      return failure(tool, 'CANCELLED', MESSAGES.CANCELLED, requestId);
    }
    if (error instanceof PtoApiError) {
      const code = apiCodeOf(error);
      return failure(tool, code, MESSAGES[code], requestId, correlationOf(error, scrub));
    }
    return failure(tool, 'LOCAL', UNEXPECTED, requestId);
  }
}

/**
 * Runs one read tool.
 *
 * The arguments are validated before a store is opened and before a request
 * is sent, so a malformed call never reaches the local credential or the
 * service. Every outcome is a finished envelope: a success, a typed failure
 * with the fixed message of its category, or an incomplete read with the rows
 * that were really read.
 */
export async function executeReadTool(
  name: ToolName,
  input: unknown,
  launch: LaunchOptions,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  dependencies: ToolDependencies = DEFAULT_DEPENDENCIES,
): Promise<ToolResult> {
  const requestId = adapterRequestId(dependencies.newRequestId());
  const tool = reportedTool(name);
  if (!isToolName(name)) {
    return failure(tool, 'INPUT', INPUT_MESSAGES.unknownTool, requestId);
  }
  if (signal.aborted) {
    return failure(tool, 'CANCELLED', MESSAGES.CANCELLED, requestId);
  }

  if (name === 'pto_list') {
    const parsed = validateListArguments(input);
    if (!parsed.ok) {
      return failure(tool, parsed.code, parsed.message, requestId);
    }
    const args = parsed.value;
    return await withCredential(
      tool,
      launch,
      env,
      signal,
      dependencies,
      requestId,
      (client, budget, scrub) => runList(client, args, signal, budget, scrub, requestId),
    );
  }

  const parsed = validateGetArguments(input);
  if (!parsed.ok) {
    return failure(tool, parsed.code, parsed.message, requestId);
  }
  const args = parsed.value;
  return await withCredential(
    tool,
    launch,
    env,
    signal,
    dependencies,
    requestId,
    (client, budget, scrub) => runGet(client, args, signal, budget, scrub, requestId),
  );
}

/**
 * The tools this server exposes.
 *
 * There are exactly two, both read-only, and both advertise a strict input
 * schema and a closed output schema. No tool accepts a credential, an origin,
 * a header, a path, a role, a command or a link, and no tool writes.
 */
export const TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'pto_list',
    title: 'List PTO records',
    description:
      'Read the PTO records of an inclusive date range. The read is bounded: at most 100 rows per page, 10 pages and 250 rows per call. The answer states whether the read was complete and why it stopped. The read is never a point-in-time snapshot, not even when it reports complete: rows can change between two page reads. An incomplete read never claims a snapshot; recover by asking for a narrower explicit date range or by splitting the range into smaller ranges, and never by retrying the same call in a loop.',
    inputSchema: LIST_INPUT_SCHEMA,
    outputSchema: LIST_OUTPUT_SCHEMA,
    annotations: {
      title: 'List PTO records',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'pto_get',
    title: 'Read one PTO record',
    description:
      'Read one PTO record by its identifier. The private note is only carried when it is asked for explicitly and the credential is allowed to see it.',
    inputSchema: GET_INPUT_SCHEMA,
    outputSchema: GET_OUTPUT_SCHEMA,
    annotations: {
      title: 'Read one PTO record',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
];
