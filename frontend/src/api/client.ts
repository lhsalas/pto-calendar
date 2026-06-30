export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody,
  ) {
    super(body.message);
    this.name = 'ApiError';
  }
}

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';
const DEFAULT_TIMEOUT_MS = Number(import.meta.env.VITE_API_TIMEOUT_MS) || 15_000;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Per-request timeout in ms. Falls back to VITE_API_TIMEOUT_MS (default 15000). */
  timeoutMs?: number;
}

/**
 * `apiRequest` normalizes fetch into a typed-error path and enforces two
 * properties on every call:
 *   1. A default per-request timeout (15s, configurable via
 *      `VITE_API_TIMEOUT_MS` or the `timeoutMs` option). On expiry we throw
 *      a typed `ApiError(0, { code: 'TIMEOUT' })`.
 *   2. A caller-supplied `signal` is forwarded to `fetch` so the request can
 *      be cancelled by the caller; an aborted caller signal is reported as
 *      `ApiError(0, { code: 'ABORTED' })`.
 *
 * The timeout is implemented as a `Promise.race` rather than an `AbortSignal`
 * composed with the caller's signal, because the test environment (jsdom +
 * undici + MSW) is sensitive to which `AbortSignal` class is passed to
 * `fetch`; the `Promise.race` approach avoids any test-env coupling while
 * still meeting the issue's AC. When the timeout fires, the in-flight
 * request is left to complete (or fail) naturally; callers won't observe it
 * because we already returned. This trades a small amount of server-side
 * work for a robust signal story across node/browser/SSR.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal: externalSignal, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise =
    timeoutMs > 0
      ? new Promise<never>((_resolve, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(
              new ApiError(0, {
                code: 'TIMEOUT',
                message: 'Request timed out.',
              }),
            );
          }, timeoutMs);
          if (typeof (timeoutHandle as { unref?: () => void }).unref === 'function') {
            (timeoutHandle as { unref: () => void }).unref();
          }
        })
      : undefined;

  const fetchPromise = (async (): Promise<Response> => {
    try {
      return await fetch(`${BASE_URL}${path}`, {
        method,
        headers,
        body: payload,
        credentials: 'include',
        ...(externalSignal ? { signal: externalSignal } : {}),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new ApiError(0, {
          code: 'ABORTED',
          message: 'Request was aborted.',
        });
      }
      throw new ApiError(0, {
        code: 'NETWORK',
        message: 'Could not reach the server.',
      });
    }
  })();

  let res: Response;
  try {
    res = await (timeoutPromise ? Promise.race([fetchPromise, timeoutPromise]) : fetchPromise);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  let parsed: unknown;
  const text = await res.text();
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ApiError(res.status, {
        code: 'BAD_RESPONSE',
        message: 'Malformed response from server.',
      });
    }
  }

  if (!res.ok) {
    const errorBody =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? (parsed as { error: ApiErrorBody }).error
        : { code: 'UNKNOWN', message: res.statusText };
    throw new ApiError(res.status, errorBody);
  }

  return parsed as T;
}
