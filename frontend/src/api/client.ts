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
  /**
   * Fetch cache mode. Only forwarded when a caller opts in, so every existing
   * call keeps the browser default. Credential endpoints use `no-store` so a
   * secret response is never written to the HTTP cache.
   */
  cache?: RequestCache;
  /**
   * Fetch redirect mode. Only forwarded when a caller opts in. Credential
   * endpoints use `error` so a redirect is never followed with cookies.
   */
  redirect?: RequestRedirect;
  /** Send the version of a reviewed PTO detail on conditional writes only. */
  headers?: { 'If-Match': string };
  /**
   * Opt in to a real deadline for this request.
   *
   * The default timeout only ends the wait for the response headers; the
   * request itself keeps running and the response body is read without a
   * deadline. A caller that opts in gets a request that is actually aborted
   * when the timeout fires, and whose deadline covers the response body as
   * well. The caller's own abort signal is still honoured and is reported
   * separately from a timeout.
   */
  deadline?: boolean;
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
 *
 * A caller can opt in to a real deadline with `deadline: true`. That path
 * binds one abort controller to the whole exchange: the timeout aborts it,
 * a caller abort is forwarded to it, and the deadline covers the response
 * body as well as the headers. The default path above is unchanged for
 * every other caller.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const {
    method = 'GET',
    body,
    signal: externalSignal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cache,
    redirect,
    deadline = false,
    headers: extraHeaders,
  } = options;
  const headers: Record<string, string> = {};
  if (extraHeaders) headers['If-Match'] = extraHeaders['If-Match'];
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  // Deadline mode binds one abort controller to the whole exchange: the
  // timeout aborts it and a caller abort is forwarded to it. The controller
  // is released once the response body has settled.
  let deadlineController: AbortController | undefined;
  let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
  let deadlineExpired = false;
  let detachCallerAbort: (() => void) | undefined;

  if (deadline) {
    deadlineController = new AbortController();
    if (externalSignal) {
      if (externalSignal.aborted) {
        deadlineController.abort();
      } else {
        const onCallerAbort = (): void => {
          deadlineController?.abort();
        };
        externalSignal.addEventListener('abort', onCallerAbort, { once: true });
        detachCallerAbort = (): void => {
          externalSignal.removeEventListener('abort', onCallerAbort);
        };
      }
    }
    if (timeoutMs > 0) {
      deadlineHandle = setTimeout(() => {
        deadlineExpired = true;
        deadlineController?.abort();
      }, timeoutMs);
      if (typeof (deadlineHandle as unknown as { unref: () => void }).unref === 'function') {
        (deadlineHandle as unknown as { unref: () => void }).unref();
      }
    }
  }

  const releaseDeadline = (): void => {
    if (deadlineHandle) {
      clearTimeout(deadlineHandle);
      deadlineHandle = undefined;
    }
    detachCallerAbort?.();
    detachCallerAbort = undefined;
  };

  const deadlineError = (): ApiError =>
    deadlineExpired
      ? new ApiError(0, {
          code: 'TIMEOUT',
          message: 'Request timed out.',
        })
      : new ApiError(0, {
          code: 'ABORTED',
          message: 'Request was aborted.',
        });

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
          if (typeof (timeoutHandle as unknown as { unref: () => void }).unref === 'function') {
            (timeoutHandle as unknown as { unref: () => void }).unref();
          }
        })
      : undefined;

  const requestSignal = deadline ? deadlineController?.signal : externalSignal;

  const fetchPromise = (async (): Promise<Response> => {
    try {
      return await fetch(`${BASE_URL}${path}`, {
        method,
        headers,
        body: payload,
        credentials: 'include',
        ...(requestSignal ? { signal: requestSignal } : {}),
        ...(cache ? { cache } : {}),
        ...(redirect ? { redirect } : {}),
      });
    } catch (err) {
      if (deadline && deadlineController?.signal.aborted) {
        throw deadlineError();
      }
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
  let timedOut = false;
  try {
    try {
      if (timeoutPromise) {
        // Track which side wins. The other side may reject after the race;
        // suppress those rejections by attaching handlers eagerly so we don't
        // trip Node's unhandled-rejection handler.
        fetchPromise.catch(() => {
          if (!timedOut) return; // fetch lost the race; swallow.
        });
        timeoutPromise.catch(() => {
          if (timedOut) return; // timeout lost the race; swallow.
          // fetch won; we already have a Response below.
        });
        const result = await Promise.race([fetchPromise, timeoutPromise]);
        if (result instanceof Error) {
          timedOut = true;
          throw result;
        }
        res = result as Response;
      } else {
        res = await fetchPromise;
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
    if (res.status === 204) {
      return undefined as T;
    }

    let parsed: unknown;
    const text = await readBody(res);
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
  } finally {
    // The deadline is released on every path, including a timeout.
    releaseDeadline();
  }

  /**
   * Reads the response body. In deadline mode the body read is covered by
   * the same deadline as the headers, so a stalled body is reported as a
   * timeout instead of hanging.
   */
  async function readBody(response: Response): Promise<string> {
    const controller = deadlineController;
    if (!deadline || !controller) {
      return response.text();
    }
    if (controller.signal.aborted) {
      throw deadlineError();
    }
    const bodyPromise = response.text();
    // The body may reject after the race settles; keep that handled.
    bodyPromise.catch(() => undefined);
    let onAbort: (() => void) | undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      onAbort = (): void => {
        reject(deadlineError());
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([bodyPromise, abortPromise]);
    } finally {
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    }
  }
}
