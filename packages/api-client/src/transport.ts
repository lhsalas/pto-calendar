import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PtoApiError, classifyUpstreamCode } from './errors.js';
import { parseTrustedOrigin, sameOrigin, type TrustedOrigin } from './origin.js';

/** How the client is pointed at the service and how it authenticates. */
export interface PtoClientOptions {
  /** The trusted origin of the service. */
  baseUrl: string;
  /** The credential and the origin it is bound to. */
  credential: { origin: string; token: string };
  /** Opt in to plain HTTP for the exact loopback hosts. */
  allowLoopbackHttp?: boolean;
  /** The deadline of one invocation in milliseconds. */
  timeoutMs?: number;
  /** How many times a read may be retried after the first attempt. */
  readRetries?: number;
}

/** The per-request options a caller may add. */
export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** One request the transport may send. */
export interface TransportRequest extends RequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: '/auth/me' | '/pto' | `/pto/${string}`;
  query?: URLSearchParams;
  body?: object;
  ifMatch?: string;
  idempotencyKey?: string;
}

/** What the transport reports back. */
export interface TransportResult {
  status: number;
  body: unknown;
  requestId: string | null;
  replayed: string | null;
  expiresAt: string | null;
}

export type PtoTransport = (req: TransportRequest) => Promise<TransportResult>;

/** The default deadline of one invocation. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** The longest deadline one invocation may take, including its retries. */
const MAX_TIMEOUT_MS = 60_000;

/** The most read retries after the first attempt. */
const MAX_READ_RETRIES = 2;

/** The largest answer body this client reads. */
const MAX_RESPONSE_BYTES = 1_048_576;

/** The largest request body this client sends. */
const MAX_REQUEST_BYTES = 65_536;

/** The statuses a read may be retried on. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429, 502, 503, 504]);

/** The backoff of the first retry and of the second. */
const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5_000;

/** The exact wire format of a personal token, secret included to the last character. */
const TOKEN_SHAPE =
  /^pto_pat_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[0-9a-f]{64}$/;

/** The exact wire format of an expected version. */
const IF_MATCH_SHAPE = /^"([1-9][0-9]{0,9})"$/;

/** The exact wire format of an idempotency key. */
const IDEMPOTENCY_KEY_SHAPE =
  /^v1\.[0-9]{13}\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The identifier shape the transport accepts in a path. */
const PATH_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A correlation id that is safe to keep and to show. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,200}$/;

/** An idempotency key inside a correlation id. */
const KEY_INSIDE_ID = /v1\.[0-9]{13}\.[0-9a-f-]{36}/i;

/** The canonical expiry header of a keyed answer. */
const EXPIRES_AT_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** The exact HTTP date of a `Retry-After`. */
const HTTP_DATE_SHAPE = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

interface TransportConfig {
  readonly base: TrustedOrigin;
  readonly token: string;
  readonly timeoutMs: number;
  readonly readRetries: number;
}

interface Prepared {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly url: URL;
  readonly body: string | undefined;
  readonly ifMatch: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly deadlineMs: number;
  /** The one monotonic deadline of the invocation, in milliseconds. */
  readonly deadlineAt: number;
  readonly isWrite: boolean;
}

function invalidOptions(): never {
  throw new PtoApiError('INVALID_OPTIONS');
}

function invalidInput(): never {
  throw new PtoApiError('INVALID_INPUT');
}

/** The deadline of one invocation: a positive number of milliseconds, at most a minute. */
function clampTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_TIMEOUT_MS);
}

function clampRetries(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.trunc(value), MAX_READ_RETRIES);
}

/**
 * Validates the client options once. The credential is bound to the origin it
 * was issued for, so a base URL that points somewhere else is refused instead
 * of receiving the token.
 */
function validateOptions(options: PtoClientOptions): TransportConfig {
  if (typeof options !== 'object' || options === null) invalidOptions();
  const allowLoopbackHttp = options.allowLoopbackHttp === true;
  const base = parseTrustedOrigin(options.baseUrl, allowLoopbackHttp);
  const credentialOrigin = parseTrustedOrigin(options.credential?.origin ?? '', allowLoopbackHttp);
  if (!sameOrigin(base, credentialOrigin)) invalidOptions();
  const token = options.credential?.token;
  if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) invalidOptions();
  return {
    base,
    token,
    timeoutMs: clampTimeout(options.timeoutMs),
    readRetries: clampRetries(options.readRetries),
  };
}

/**
 * Validates one request and builds the exact URL and headers. Nothing the
 * caller supplies can add a header, change the origin or point the request
 * somewhere else.
 */
function prepareRequest(request: TransportRequest, config: TransportConfig): Prepared {
  if (typeof request !== 'object' || request === null) invalidInput();
  const method = request.method;
  if (method !== 'GET' && method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') {
    invalidInput();
  }
  const path = request.path;
  if (path !== '/auth/me' && path !== '/pto') {
    if (typeof path !== 'string' || !path.startsWith('/pto/')) invalidInput();
    const id = path.slice('/pto/'.length);
    if (id.includes('/') || !PATH_ID_SHAPE.test(id)) invalidInput();
  }
  let body: string | undefined;
  if (request.body !== undefined) {
    if (typeof request.body !== 'object' || request.body === null || Array.isArray(request.body)) {
      invalidInput();
    }
    body = JSON.stringify(request.body);
    if (body.length > MAX_REQUEST_BYTES) invalidInput();
  }
  if (request.ifMatch !== undefined) {
    const match = typeof request.ifMatch === 'string' ? IF_MATCH_SHAPE.exec(request.ifMatch) : null;
    if (!match) invalidInput();
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version) || version > 2_147_483_647) invalidInput();
  }
  if (request.idempotencyKey !== undefined) {
    if (
      typeof request.idempotencyKey !== 'string' ||
      !IDEMPOTENCY_KEY_SHAPE.test(request.idempotencyKey)
    ) {
      invalidInput();
    }
  }
  const url = new URL(`${config.base.value}${path}`);
  if (request.query) {
    for (const [name, value] of request.query) url.searchParams.append(name, value);
  }
  const deadlineMs = clampTimeout(request.timeoutMs ?? config.timeoutMs);
  return {
    method,
    url,
    body,
    ifMatch: request.ifMatch,
    idempotencyKey: request.idempotencyKey,
    deadlineMs,
    deadlineAt: performance.now() + deadlineMs,
    isWrite: method !== 'GET',
  };
}

/**
 * Keeps a correlation id only when it is safe: it must look like an id, and it
 * must never carry the credential or an idempotency key.
 */
function sanitizeRequestId(value: string | null, token: string): string | null {
  if (typeof value !== 'string') return null;
  if (!SAFE_REQUEST_ID.test(value)) return null;
  if (value.includes(token.slice(-64))) return null;
  if (KEY_INSIDE_ID.test(value)) return null;
  return value;
}

/** Keeps the replay marker of an answer, when it is the exact known value. */
function sanitizeReplayed(value: string | null): string | null {
  if (value !== 'true' && value !== 'false') return null;
  return value;
}

/** Keeps the canonical expiry of an answer, when it is an absolute instant. */
function sanitizeExpiresAt(value: string | null): string | null {
  if (typeof value !== 'string') return null;
  if (!EXPIRES_AT_SHAPE.test(value)) return null;
  return value;
}

/**
 * Reads a whole number of seconds or an IMF-fixdate `Retry-After` header.
 * Unknown formats do not grant permission to retry.
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // Even an enormous valid integer tells us not to retry within our budget.
  if (/^[0-9]+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, Number.MAX_SAFE_INTEGER);
  if (!HTTP_DATE_SHAPE.test(trimmed)) return null;
  const parsed = Date.parse(trimmed);
  if (new Date(parsed).toUTCString() !== trimmed) return null;
  const wait = parsed - now;
  return wait > 0 ? wait : 0;
}

/**
 * Reads a body with a hard cap. An answer that is too large, truncated or cut
 * off by the deadline never becomes a native error: the caller learns that the
 * answer cannot be used.
 */
async function readBoundedBody(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (text.length > limit) throw new Error('the answer is too large');
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value!.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error('the answer is too large');
    }
    chunks.push(value!);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function abortCode(signal: AbortSignal): 'TIMEOUT' | 'ABORTED' {
  return signal.reason === 'TIMEOUT' ? 'TIMEOUT' : 'ABORTED';
}

/** The error code of an upstream body, when the body is a JSON error envelope. */
function upstreamCode(body: unknown): string {
  if (typeof body !== 'object' || body === null) return 'HTTP_ERROR';
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return 'HTTP_ERROR';
  return classifyUpstreamCode((error as { code?: unknown }).code);
}

/**
 * Creates the transport.
 *
 * Every call sends the credential to the one trusted origin it is bound to,
 * follows no redirect, logs nothing and never retries a write.
 */
export function createTransport(options: PtoClientOptions): PtoTransport {
  const config = validateOptions(options);
  return async (request: TransportRequest): Promise<TransportResult> => {
    const prepared = prepareRequest(request, config);
    const caller = request.signal;
    if (caller !== undefined && !(caller instanceof AbortSignal)) invalidInput();
    // A request that was already cancelled never leaves this process.
    if (caller?.aborted) throw new PtoApiError('ABORTED');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('TIMEOUT'), prepared.deadlineMs);
    const onCallerAbort = (): void => controller.abort('ABORTED');
    caller?.addEventListener('abort', onCallerAbort, { once: true });
    try {
      let attempt = 0;
      while (true) {
        attempt += 1;
        const headers: Record<string, string> = {
          accept: 'application/json',
          authorization: `Bearer ${config.token}`,
          'x-request-id': randomUUID(),
        };
        if (prepared.body !== undefined) headers['content-type'] = 'application/json';
        if (prepared.ifMatch !== undefined) headers['if-match'] = prepared.ifMatch;
        if (prepared.idempotencyKey !== undefined) {
          headers['idempotency-key'] = prepared.idempotencyKey;
        }
        let response: Response;
        try {
          response = await fetch(prepared.url, {
            method: prepared.method,
            headers,
            ...(prepared.body === undefined ? {} : { body: prepared.body }),
            signal: controller.signal,
            // A redirect is never followed, so no byte of the credential or of
            // the body can reach the target of the redirect.
            redirect: 'manual',
            credentials: 'omit',
            cache: 'no-store',
          });
        } catch {
          if (controller.signal.aborted) {
            throw new PtoApiError(abortCode(controller.signal), {
              unknownWriteOutcome: prepared.isWrite,
            });
          }
          const error = new PtoApiError('NETWORK_ERROR', {
            unknownWriteOutcome: prepared.isWrite,
          });
          if (!mayRetryRead(prepared, config, attempt)) throw error;
          await waitBeforeRetry(controller, prepared, attempt, error);
          continue;
        }
        const requestId = sanitizeRequestId(response.headers.get('x-request-id'), config.token);
        const retryHint = response.headers.get('retry-after');
        const retryAfterMs = parseRetryAfter(retryHint);
        const status = response.status;
        if (status >= 300 && status < 400) {
          // The answer is a redirect: it is refused, and nothing is followed.
          // Do not leave its body stream open after the deadline is cleared.
          controller.abort();
          throw new PtoApiError('REDIRECT', {
            status,
            requestId,
            unknownWriteOutcome: prepared.isWrite,
          });
        }
        if (status >= 200 && status < 300) {
          const text = await readAnswer(response, status, requestId, prepared, controller);
          if (status === 204) {
            if (text.length > 0) {
              throw new PtoApiError('INVALID_RESPONSE', {
                status,
                requestId,
                unknownWriteOutcome: prepared.isWrite,
              });
            }
            return {
              status,
              body: null,
              requestId,
              replayed: sanitizeReplayed(response.headers.get('idempotency-replayed')),
              expiresAt: sanitizeExpiresAt(response.headers.get('idempotency-key-expires-at')),
            };
          }
          let body: unknown = null;
          if (text.length > 0) {
            try {
              body = JSON.parse(text);
            } catch {
              throw new PtoApiError('INVALID_RESPONSE', {
                status,
                requestId,
                unknownWriteOutcome: prepared.isWrite,
              });
            }
          }
          return {
            status,
            body,
            requestId,
            replayed: sanitizeReplayed(response.headers.get('idempotency-replayed')),
            expiresAt: sanitizeExpiresAt(response.headers.get('idempotency-key-expires-at')),
          };
        }
        const text = await readAnswer(response, status, requestId, prepared, controller);
        let body: unknown = null;
        if (text.length > 0) {
          try {
            body = JSON.parse(text);
          } catch {
            body = null;
          }
        }
        const error = new PtoApiError(upstreamCode(body), {
          status,
          requestId,
          retryAfterMs,
          unknownWriteOutcome: prepared.isWrite && (status >= 500 || status === 408),
        });
        if (!mayRetryRead(prepared, config, attempt)) throw error;
        if (!RETRYABLE_STATUSES.has(status)) throw error;
        if (retryHint !== null && retryAfterMs === null) throw error;
        await waitBeforeRetry(controller, prepared, attempt, error);
      }
    } finally {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCallerAbort);
    }
  };
}

/**
 * Reads the body of an answer. A body that is too large, truncated or cut
 * off by the deadline keeps the status and the correlation of the answer, and
 * a write that was already dispatched is reported as uncertain.
 */
async function readAnswer(
  response: Response,
  status: number,
  requestId: string | null,
  prepared: Prepared,
  controller: AbortController,
): Promise<string> {
  try {
    return await readBoundedBody(response, MAX_RESPONSE_BYTES);
  } catch {
    if (controller.signal.aborted) {
      throw new PtoApiError(abortCode(controller.signal), {
        status,
        requestId,
        unknownWriteOutcome: prepared.isWrite,
      });
    }
    throw new PtoApiError('INVALID_RESPONSE', {
      status,
      requestId,
      unknownWriteOutcome: prepared.isWrite,
    });
  }
}

/** True when this answer may be retried: a read, a retryable status, budget left. */
function mayRetryRead(prepared: Prepared, config: TransportConfig, attempt: number): boolean {
  if (prepared.isWrite) return false;
  if (attempt > config.readRetries) return false;
  return true;
}

/**
 * Waits before the next attempt. The wait never starts earlier than the
 * service asked for, and it is skipped when the remaining budget cannot hold
 * it: an over-budget wait is never started and the answer is reported as it
 * is.
 */
async function waitBeforeRetry(
  controller: AbortController,
  prepared: Prepared,
  attempt: number,
  failure: PtoApiError,
): Promise<void> {
  const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  const remaining = prepared.deadlineAt - performance.now();
  const retryAfterMs = failure.retryAfterMs ?? 0;
  // A wait the service asked for is never started earlier, and it is not
  // started at all when the budget cannot hold it.
  if (retryAfterMs > remaining) throw failure;
  const wait = Math.max(backoff, retryAfterMs);
  try {
    await delay(wait, undefined, { signal: controller.signal });
  } catch {
    throw new PtoApiError(abortCode(controller.signal), {
      status: failure.status,
      requestId: failure.requestId,
      retryAfterMs: failure.retryAfterMs,
    });
  }
}
