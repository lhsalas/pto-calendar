import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../api/client';
import type { CreatePTORequest, PTOWithUser } from '../types/api';

export interface UsePtoListResult {
  items: PTOWithUser[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  create: (payload: CreatePTORequest) => Promise<PTOWithUser>;
  update: (id: string, payload: CreatePTORequest) => Promise<PTOWithUser>;
  remove: (id: string) => Promise<void>;
}

export function usePtoList(start: string, end: string): UsePtoListResult {
  const [items, setItems] = useState<PTOWithUser[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const activeSession = useRef<{ range: string; active: boolean } | null>(null);
  const range = new URLSearchParams({ start, end }).toString();
  const [previousRange, setPreviousRange] = useState(range);
  if (previousRange !== range) {
    setPreviousRange(range);
    setLoading(true);
    setError(null);
  }

  useEffect(() => {
    const session = { range, active: true };
    activeSession.current = session;
    const id = ++requestId.current;
    void apiRequest<PTOWithUser[]>(`/pto?${range}`).then(
      (list) => {
        if (!session.active || id !== requestId.current) return;
        setItems(list);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (!session.active || id !== requestId.current) return;
        setError(err instanceof Error ? err.message : 'Could not load PTOs.');
        setLoading(false);
      },
    );
    return () => {
      session.active = false;
    };
  }, [range]);

  const refetch = useCallback(async (): Promise<void> => {
    const session = activeSession.current;
    if (!session?.active || session.range !== range) return;
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const list = await apiRequest<PTOWithUser[]>(`/pto?${range}`);
      if (session.active && id === requestId.current) setItems(list);
    } catch (err) {
      if (session.active && id === requestId.current)
        setError(err instanceof Error ? err.message : 'Could not load PTOs.');
    } finally {
      if (session.active && id === requestId.current) setLoading(false);
    }
  }, [range]);

  const create = useCallback(
    async (payload: CreatePTORequest): Promise<PTOWithUser> => {
      const created = await apiRequest<PTOWithUser>('/pto', {
        method: 'POST',
        body: payload,
      });
      await refetch();
      return created;
    },
    [refetch],
  );

  const update = useCallback(
    async (id: string, payload: CreatePTORequest): Promise<PTOWithUser> => {
      const updated = await apiRequest<PTOWithUser>(`/pto/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: payload,
      });
      await refetch();
      return updated;
    },
    [refetch],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      await apiRequest<void>(`/pto/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await refetch();
    },
    [refetch],
  );

  return { items, loading, error, refetch, create, update, remove };
}
