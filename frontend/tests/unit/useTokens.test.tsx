import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const { listTokens, revokeToken, revokeAllTokens } = vi.hoisted(() => ({
  listTokens: vi.fn(),
  revokeToken: vi.fn(),
  revokeAllTokens: vi.fn(),
}));

// The credential API is the observable boundary of this hook: every request
// is replaced by a controlled promise, so a late, cancelled or failed answer
// can be delivered at an exact moment.
vi.mock('../../src/api/tokens', () => ({ listTokens, revokeToken, revokeAllTokens }));

import { ApiError } from '../../src/api/client';
import { useTokens } from '../../src/hooks/useTokens';
import type { TokenMetadata } from '../../src/types/api';

const TOKEN: TokenMetadata = {
  id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  name: 'Laptop',
  displayPrefix: 'pto_pat_cccccccc-cccc-cccc-cccc-cccccccccccc',
  scopes: ['pto:read'],
  createdAt: '2026-06-01T10:00:00.000Z',
  expiresAt: '2026-09-01T10:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
  status: 'active',
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ready, fail) => {
    resolve = ready;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function aborted(): ApiError {
  return new ApiError(0, { code: 'ABORTED', message: 'Request was aborted.' });
}

function serverError(): ApiError {
  return new ApiError(500, { code: 'INTERNAL_ERROR', message: 'boom secret detail' });
}

beforeEach(() => {
  listTokens.mockReset();
  revokeToken.mockReset();
  revokeAllTokens.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useTokens', () => {
  it('loads the owned list for the account', async () => {
    listTokens.mockResolvedValueOnce([TOKEN]);
    const { result } = renderHook(() => useTokens('user-1'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.tokens).toEqual([TOKEN]);
    expect(result.current.error).toBeNull();
    expect(listTokens).toHaveBeenCalledTimes(1);
    expect(listTokens).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it('reports a failed first load with safe copy', async () => {
    listTokens.mockRejectedValueOnce(serverError());
    const { result } = renderHook(() => useTokens('user-1'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBe('Something went wrong. Try again.');
    expect(result.current.error).not.toContain('boom secret detail');
    expect(result.current.tokens).toEqual([]);
  });

  it('never applies a first list that lands after the hook was left', async () => {
    const first = deferred<TokenMetadata[]>();
    listTokens.mockReturnValueOnce(first.promise);
    const { result, unmount } = renderHook(() => useTokens('user-1'));
    unmount();
    await act(async () => {
      first.resolve([TOKEN]);
    });
    // The late answer is discarded, so the list that was never shown stays
    // empty and no error is invented for it.
    expect(result.current.tokens).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('never reports a first failure that lands after the hook was left', async () => {
    const first = deferred<TokenMetadata[]>();
    listTokens.mockReturnValueOnce(first.promise);
    const { result, unmount } = renderHook(() => useTokens('user-1'));
    unmount();
    await act(async () => {
      first.reject(serverError());
    });
    expect(result.current.error).toBeNull();
    expect(result.current.tokens).toEqual([]);
  });

  it('treats a cancelled first request as no error at all', async () => {
    listTokens.mockRejectedValueOnce(aborted());
    const { result } = renderHook(() => useTokens('user-1'));
    await waitFor(() => {
      expect(listTokens).toHaveBeenCalledTimes(1);
    });
    // A request that was cancelled on purpose is not a failure, so the hook
    // never shows an error for it.
    expect(result.current.error).toBeNull();
    expect(result.current.tokens).toEqual([]);
  });

  it('refuses a refresh that is started after the hook was left', async () => {
    listTokens.mockResolvedValueOnce([TOKEN]);
    const { result, unmount } = renderHook(() => useTokens('user-1'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    unmount();
    await expect(result.current.refetch()).resolves.toBe(false);
    // No request is even started for a hook that is gone.
    expect(listTokens).toHaveBeenCalledTimes(1);
  });

  it('never applies a refresh that lands after the hook was left', async () => {
    listTokens.mockResolvedValueOnce([TOKEN]);
    const second = deferred<TokenMetadata[]>();
    listTokens.mockReturnValueOnce(second.promise);
    const { result, unmount } = renderHook(() => useTokens('user-1'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = result.current.refetch();
    });
    unmount();
    await act(async () => {
      second.resolve([TOKEN]);
    });
    await expect(pending).resolves.toBe(false);
    expect(result.current.tokens).toEqual([TOKEN]);
  });

  it('never reports a refresh failure that lands after the hook was left', async () => {
    listTokens.mockResolvedValueOnce([TOKEN]);
    const second = deferred<TokenMetadata[]>();
    listTokens.mockReturnValueOnce(second.promise);
    const { result, unmount } = renderHook(() => useTokens('user-1'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = result.current.refetch();
    });
    unmount();
    await act(async () => {
      second.reject(serverError());
    });
    await expect(pending).resolves.toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('treats a cancelled refresh as no error at all', async () => {
    listTokens.mockResolvedValueOnce([TOKEN]);
    const second = deferred<TokenMetadata[]>();
    listTokens.mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useTokens('user-1'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = result.current.refetch();
    });
    await act(async () => {
      second.reject(aborted());
    });
    await expect(pending).resolves.toBe(false);
    // The cancellation is not an error, and the list is not left loading.
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.tokens).toEqual([TOKEN]);
  });

  it('reports an authoritative refresh as the new list', async () => {
    listTokens.mockResolvedValueOnce([TOKEN]);
    const { result } = renderHook(() => useTokens('user-1'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    listTokens.mockResolvedValueOnce([]);
    let refreshed!: boolean;
    await act(async () => {
      refreshed = await result.current.refetch();
    });
    expect(refreshed).toBe(true);
    await waitFor(() => {
      expect(result.current.tokens).toEqual([]);
    });
    expect(result.current.error).toBeNull();
  });

  it('keeps the list when a silent refresh fails', async () => {
    listTokens.mockResolvedValueOnce([TOKEN]);
    const { result } = renderHook(() => useTokens('user-1'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    listTokens.mockRejectedValueOnce(serverError());
    let refreshed!: boolean;
    await act(async () => {
      refreshed = await result.current.refetch({ silent: true });
    });
    expect(refreshed).toBe(false);
    await waitFor(() => {
      expect(result.current.error).toBe('Something went wrong. Try again.');
    });
    expect(result.current.tokens).toEqual([TOKEN]);
  });

  it('reloads the list after a single token was revoked', async () => {
    listTokens.mockResolvedValueOnce([TOKEN]);
    revokeToken.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useTokens('user-1'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    listTokens.mockResolvedValueOnce([]);
    await act(async () => {
      await result.current.revoke(TOKEN.id);
    });
    await waitFor(() => {
      expect(result.current.tokens).toEqual([]);
    });
    expect(revokeToken).toHaveBeenCalledWith(TOKEN.id);
  });

  it('reloads the list after every token was revoked', async () => {
    listTokens.mockResolvedValueOnce([TOKEN]);
    revokeAllTokens.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useTokens('user-1'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    listTokens.mockResolvedValueOnce([]);
    await act(async () => {
      await result.current.revokeAll();
    });
    await waitFor(() => {
      expect(result.current.tokens).toEqual([]);
    });
    expect(revokeAllTokens).toHaveBeenCalledTimes(1);
  });

  it('propagates a failed revocation to the caller', async () => {
    listTokens.mockResolvedValueOnce([TOKEN]);
    revokeToken.mockRejectedValueOnce(serverError());
    const { result } = renderHook(() => useTokens('user-1'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    await expect(result.current.revoke(TOKEN.id)).rejects.toBeInstanceOf(ApiError);
    // The list is not reloaded after a failed revocation.
    expect(listTokens).toHaveBeenCalledTimes(1);
  });
});
