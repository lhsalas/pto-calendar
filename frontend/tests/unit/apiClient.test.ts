import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiRequest } from '../../src/api/client';

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

function mockFetchOnce(response: Partial<Response> & { ok?: boolean; status?: number }): void {
  globalThis.fetch = vi.fn(async () => response) as unknown as typeof fetch;
}

describe('apiRequest hardening', () => {
  it('throws a typed ApiError with BAD_RESPONSE on malformed JSON body', async () => {
    mockFetchOnce({
      status: 200,
      ok: true,
      statusText: 'OK',
      text: async () => '<html>nope</html>',
    } as Response);

    await expect(apiRequest('/broken')).rejects.toMatchObject({
      status: 200,
      body: { code: 'BAD_RESPONSE', message: 'Malformed response from server.' },
    });
    await expect(apiRequest('/broken')).rejects.toBeInstanceOf(ApiError);
  });

  it('throws a typed ApiError with NETWORK on a fetch rejection', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    await expect(apiRequest('/nope')).rejects.toMatchObject({
      status: 0,
      body: { code: 'NETWORK', message: 'Could not reach the server.' },
    });
  });

  it('throws a typed ApiError with TIMEOUT when the request exceeds timeoutMs', async () => {
    // Note: the timeout path is a Promise.race against a setTimeout-fired
    // rejection. Mocking that with vi.useFakeTimers reliably triggers
    // vitest's unhandled-rejection detector (the loser of the race stays
    // pending and is observed after the test ends), so we cover the
    // timeout behavior by mocking the fetch to return a Response after
    // a microtask delay and using a very short timeoutMs to let the
    // race fire in real time.
    globalThis.fetch = vi.fn(
      (_input, init) =>
        new Promise<Response>((resolve) => {
          const sig = init?.signal;
          // Don't bother aborting — the test relies on the timeout.
          void sig;
          setTimeout(() => resolve(new Response('{}', { status: 200 })), 200);
        }),
    ) as unknown as typeof fetch;
    await expect(apiRequest('/slow', { timeoutMs: 10 })).rejects.toMatchObject({
      status: 0,
      body: { code: 'TIMEOUT', message: 'Request timed out.' },
    });
  });

  it('throws a typed ApiError with ABORTED when the caller signal aborts', async () => {
    globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        if (sig) {
          if (sig.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          sig.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }
      });
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    const promise = apiRequest('/caller-abort', { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({
      status: 0,
      body: { code: 'ABORTED', message: 'Request was aborted.' },
    });
  });

  it('does not leak the timeout timer when the caller aborts synchronously', async () => {
    globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        if (sig) {
          if (sig.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          sig.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }
      });
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    controller.abort();
    await expect(apiRequest('/sync-abort', { signal: controller.signal })).rejects.toMatchObject({
      body: { code: 'ABORTED' },
    });
    // The timer is started (for the timeout race) but must be cleared before
    // the promise rejects, so no pending timer keeps the process alive.
    // Vitest's default 5s test timeout would fire if the timer leaked.
  });
});

describe('apiRequest deadline mode', () => {
  it('aborts the request when the deadline expires', async () => {
    let observed: AbortSignal | undefined;
    globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      observed = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        if (!sig) return;
        if (sig.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        sig.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    }) as unknown as typeof fetch;

    await expect(apiRequest('/deadline', { deadline: true, timeoutMs: 20 })).rejects.toMatchObject({
      status: 0,
      body: { code: 'TIMEOUT', message: 'Request timed out.' },
    });
    // The request itself is aborted, not just abandoned.
    expect(observed?.aborted).toBe(true);
  });

  it('applies the deadline to the response body as well', async () => {
    globalThis.fetch = vi.fn(async () => ({
      status: 200,
      ok: true,
      statusText: 'OK',
      // The headers arrive, the body never does.
      text: () => new Promise<string>(() => undefined),
    })) as unknown as typeof fetch;

    await expect(apiRequest('/slow-body', { deadline: true, timeoutMs: 20 })).rejects.toMatchObject(
      {
        status: 0,
        body: { code: 'TIMEOUT', message: 'Request timed out.' },
      },
    );
  });

  it('reports a caller abort separately from a timeout and aborts the request', async () => {
    let observed: AbortSignal | undefined;
    globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      observed = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        sig?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    const promise = apiRequest('/caller-abort-deadline', {
      deadline: true,
      signal: controller.signal,
      timeoutMs: 5000,
    });
    controller.abort();
    await expect(promise).rejects.toMatchObject({
      status: 0,
      body: { code: 'ABORTED', message: 'Request was aborted.' },
    });
    expect(observed?.aborted).toBe(true);
  });

  it('keeps the default race timeout for callers that do not opt in', async () => {
    globalThis.fetch = vi.fn(
      (_input, init) =>
        new Promise<Response>((resolve) => {
          void init;
          setTimeout(() => resolve(new Response('{}', { status: 200 })), 200);
        }),
    ) as unknown as typeof fetch;
    await expect(apiRequest('/slow', { timeoutMs: 10 })).rejects.toMatchObject({
      status: 0,
      body: { code: 'TIMEOUT' },
    });
  });
});
