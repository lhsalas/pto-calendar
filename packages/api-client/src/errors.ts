/**
 * The public error surface of the client.
 *
 * Every message is a fixed, safe string. An upstream message, a response body,
 * a URL, a token, a request header or an arbitrary cause never reaches the
 * error, and no error is ever logged: the caller gets a code, a status, a
 * sanitized correlation id and the few facts it needs to act.
 */

export interface PtoApiErrorDetails {
  /** The HTTP status of the answer, or 0 when there was no answer at all. */
  status?: number;
  /** The correlation id of the answer, when it was safe to keep. */
  requestId?: string | null;
  /** How long the server asked the caller to wait, in milliseconds. */
  retryAfterMs?: number | null;
  /**
   * True when a write may have been committed even though its outcome was
   * never read: the request was dispatched, but the answer was lost. A request
   * that was refused before it was dispatched is known not to have been sent.
   */
  unknownWriteOutcome?: boolean;
}

/**
 * The upstream service codes this client knows. Any other code of a non-2xx
 * answer is reported as `HTTP_ERROR`, so an unknown code never becomes a
 * message of its own.
 */
export const PTO_SERVICE_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'VALIDATION_ERROR',
  'CSRF_REJECTED',
  'RATE_LIMITED',
  'NOT_READY',
  'PRECONDITION_REQUIRED',
  'STALE_WRITE',
  'TOKEN_LIMIT_REACHED',
  'SESSION_REQUIRED',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_EXPIRED',
  'IDEMPOTENCY_CONFLICT',
  'INTERNAL_ERROR',
] as const;

/** The codes this client raises on its own. */
export const PTO_LOCAL_ERROR_CODES = [
  'INVALID_OPTIONS',
  'INVALID_INPUT',
  'INVALID_RESPONSE',
  'ABORTED',
  'TIMEOUT',
  'NETWORK_ERROR',
  'REDIRECT',
  'HTTP_ERROR',
] as const;

export type PtoApiErrorCode =
  (typeof PTO_SERVICE_ERROR_CODES)[number] | (typeof PTO_LOCAL_ERROR_CODES)[number];

/** One fixed message per code. Nothing else is ever shown to a caller. */
const MESSAGES: Readonly<Record<string, string>> = {
  UNAUTHENTICATED: 'The credential was not accepted.',
  FORBIDDEN: 'The credential is not allowed to perform this operation.',
  NOT_FOUND: 'The requested entry does not exist.',
  CONFLICT: 'The request conflicts with an existing entry.',
  VALIDATION_ERROR: 'The request was not valid.',
  CSRF_REJECTED: 'The request origin was refused.',
  RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
  NOT_READY: 'The service is not ready yet.',
  PRECONDITION_REQUIRED: 'The request needs the current version of the entry.',
  STALE_WRITE: 'The entry changed since it was read. Read it again and retry.',
  TOKEN_LIMIT_REACHED: 'The maximum number of tokens already exists.',
  SESSION_REQUIRED: 'This request needs a browser session.',
  IDEMPOTENCY_KEY_REQUIRED: 'This request needs an idempotency key.',
  IDEMPOTENCY_EXPIRED:
    'The create key expired. Reconcile the PTO records before attempting another create.',
  IDEMPOTENCY_CONFLICT: 'The idempotency key was already used for another request.',
  INTERNAL_ERROR: 'The service could not complete the request.',
  INVALID_OPTIONS: 'The client options are not usable.',
  INVALID_INPUT: 'The request is not valid.',
  INVALID_RESPONSE: 'The service returned an answer this client cannot use.',
  ABORTED: 'The request was cancelled.',
  TIMEOUT: 'The service did not answer in time.',
  NETWORK_ERROR: 'The service could not be reached.',
  REDIRECT: 'The service answered with a redirect, which this client does not follow.',
  HTTP_ERROR: 'The service rejected the request.',
};

export class PtoApiError extends Error {
  /** The classified code of the failure. */
  readonly code: string;
  /** The HTTP status of the answer, or 0 when there was no answer. */
  readonly status: number;
  /** The correlation id of the answer, or null when it was absent or unsafe. */
  readonly requestId: string | null;
  /** How long the service asked the caller to wait, or null when it did not. */
  readonly retryAfterMs: number | null;
  /** True when a dispatched write may have been committed. */
  readonly unknownWriteOutcome: boolean;

  constructor(code: string, details: PtoApiErrorDetails = {}) {
    super(MESSAGES[code] ?? MESSAGES.HTTP_ERROR!);
    this.name = 'PtoApiError';
    this.code = code;
    this.status = details.status ?? 0;
    this.requestId = details.requestId ?? null;
    this.retryAfterMs = details.retryAfterMs ?? null;
    this.unknownWriteOutcome = details.unknownWriteOutcome ?? false;
  }
}

/** True when the code is one this client reports. */
export function isPtoApiError(value: unknown): value is PtoApiError {
  return value instanceof PtoApiError;
}

/**
 * Maps an upstream error code onto the codes this client reports. An unknown
 * code becomes the fixed fallback, so a new upstream code can never become a
 * new message.
 */
export function classifyUpstreamCode(code: unknown): string {
  if (typeof code !== 'string') return 'HTTP_ERROR';
  const known = (PTO_SERVICE_ERROR_CODES as readonly string[]).includes(code);
  return known ? code : 'HTTP_ERROR';
}
