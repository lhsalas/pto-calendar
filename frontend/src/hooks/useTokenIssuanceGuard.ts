import { useCallback, useRef, useState } from 'react';

export interface TokenIssuanceGuard {
  begin: (accountId: string) => number;
  pendingAttempt: (accountId: string) => number | undefined;
  settle: (accountId: string, attempt: number) => void;
}

/**
 * Lives above the settings route. Store only an account ID and a generation
 * for each unconfirmed issuance, never a password, token or request payload.
 * An older completion or refresh cannot settle a newer attempt.
 */
export function useTokenIssuanceGuard(): TokenIssuanceGuard {
  const nextAttempt = useRef(0);
  const [pending, setPending] = useState<ReadonlyMap<string, number>>(() => new Map());

  const begin = useCallback((accountId: string): number => {
    const attempt = ++nextAttempt.current;
    setPending((previous) => new Map(previous).set(accountId, attempt));
    return attempt;
  }, []);

  const settle = useCallback((accountId: string, attempt: number): void => {
    setPending((previous) => {
      if (previous.get(accountId) !== attempt) return previous;
      const remaining = new Map(previous);
      remaining.delete(accountId);
      return remaining;
    });
  }, []);

  return { begin, pendingAttempt: (accountId) => pending.get(accountId), settle };
}
