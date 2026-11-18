import { useCallback, useEffect, useRef, useState } from 'react';
import { listTokens, revokeAllTokens, revokeToken } from '../api/tokens';
import { isAbortError, tokenErrorMessage } from '../lib/tokens';
import type { TokenMetadata } from '../types/api';

export interface RefetchOptions {
  /** Refresh without dropping the list into its loading state. */
  silent?: boolean;
}

export interface UseTokensResult {
  tokens: TokenMetadata[];
  loading: boolean;
  error: string | null;
  refetch: (options?: RefetchOptions) => Promise<void>;
  revoke: (id: string) => Promise<void>;
  revokeAll: () => Promise<void>;
}

/**
 * Owns the list of the signed-in owner's own tokens.
 *
 * The list is only loaded for an authenticated account, and the hook is
 * mounted per account, so a swap of the signed-in user starts a fresh list
 * and drops the previous one. Every request is generation-stamped and
 * abortable: a response that arrives after the page was left, after the
 * list was refreshed, or after another account took over is discarded
 * instead of overwriting newer state.
 */
export function useTokens(userId: string): UseTokensResult {
  const [tokens, setTokens] = useState<TokenMetadata[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef<number>(0);
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef<boolean>(true);

  /**
   * Starts one list request. The caller applies the result, so no state is
   * written while the request is in flight.
   */
  const start = useCallback((): Promise<TokenMetadata[]> => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    return listTokens(controller.signal);
  }, []);

  const load = useCallback(
    async (options: RefetchOptions = {}): Promise<void> => {
      if (!mountedRef.current) return;
      const requestId = ++generation.current;
      if (!options.silent) setLoading(true);
      setError(null);
      try {
        const list = await start();
        if (!mountedRef.current || requestId !== generation.current) return;
        setTokens(list);
      } catch (err) {
        if (!mountedRef.current || requestId !== generation.current) return;
        if (isAbortError(err)) return;
        setError(tokenErrorMessage(err));
      } finally {
        // The latest request always finishes the loading state, otherwise a
        // silent refresh could leave the list loading forever.
        if (mountedRef.current && requestId === generation.current) setLoading(false);
      }
    },
    [start],
  );

  useEffect(() => {
    mountedRef.current = true;
    const requestId = ++generation.current;
    let active = true;
    void start().then(
      (list) => {
        if (!active || requestId !== generation.current) return;
        setTokens(list);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (!active || requestId !== generation.current) return;
        if (isAbortError(err)) return;
        setError(tokenErrorMessage(err));
        setLoading(false);
      },
    );
    return () => {
      active = false;
      mountedRef.current = false;
      generation.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [start, userId]);

  const revoke = useCallback(
    async (id: string): Promise<void> => {
      await revokeToken(id);
      if (!mountedRef.current) return;
      await load({ silent: true });
    },
    [load],
  );

  const revokeAll = useCallback(async (): Promise<void> => {
    await revokeAllTokens();
    if (!mountedRef.current) return;
    await load({ silent: true });
  }, [load]);

  return { tokens, loading, error, refetch: load, revoke, revokeAll };
}
