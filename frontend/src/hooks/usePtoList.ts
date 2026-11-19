import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../api/client';
import { ifMatchHeader, toPtoWriteError } from '../lib/ptoEdit';
import type { CreatePTORequest, PTO, PTOWithUser } from '../types/api';

export interface UsePtoListResult {
  items: PTOWithUser[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  create: (payload: CreatePTORequest) => Promise<PTO>;
  /** Updates a record, quoting the version of the loaded detail. */
  update: (id: string, payload: CreatePTORequest, version: number) => Promise<PTO>;
  /** Deletes a record, quoting the version of the loaded detail. */
  remove: (id: string, version: number) => Promise<void>;
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
    if (!session?.active) return;
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const list = await apiRequest<PTOWithUser[]>(`/pto?${session.range}`);
      if (session.active && id === requestId.current) setItems(list);
    } catch (err) {
      if (session.active && id === requestId.current)
        setError(err instanceof Error ? err.message : 'Could not load PTOs.');
    } finally {
      if (session.active && id === requestId.current) setLoading(false);
    }
  }, []);

  const create = useCallback(
    async (payload: CreatePTORequest): Promise<PTO> => {
      const created = await apiRequest<PTO>('/pto', {
        method: 'POST',
        body: payload,
      });
      await refetch();
      return created;
    },
    [refetch],
  );

  const update = useCallback(
    async (id: string, payload: CreatePTORequest, version: number): Promise<PTO> => {
      let updated: PTO;
      try {
        updated = await apiRequest<PTO>(`/pto/${encodeURIComponent(id)}`, {
          method: 'PUT',
          body: payload,
          headers: ifMatchHeader(version),
        });
      } catch (err) {
        // A refused precondition is reported as a typed conflict; the write
        // is never repeated on its own.
        throw toPtoWriteError(err);
      }
      await refetch();
      return updated;
    },
    [refetch],
  );

  const remove = useCallback(
    async (id: string, version: number): Promise<void> => {
      try {
        await apiRequest<void>(`/pto/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: ifMatchHeader(version),
        });
      } catch (err) {
        throw toPtoWriteError(err);
      }
      await refetch();
    },
    [refetch],
  );

  return { items, loading, error, refetch, create, update, remove };
}
