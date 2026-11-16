import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../api/client';
import type {
  Holiday,
  CreateHolidayRequest,
  SeedHolidayRequest,
  SeedHolidayResponse,
} from '../types/api';

export interface UseHolidaysResult {
  items: Holiday[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  create: (payload: CreateHolidayRequest) => Promise<Holiday>;
  remove: (id: string) => Promise<void>;
  seed: (payload: SeedHolidayRequest) => Promise<SeedHolidayResponse>;
}

export function useHolidays(start: string, end: string): UseHolidaysResult {
  const [items, setItems] = useState<Holiday[]>([]);
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
    void apiRequest<Holiday[]>(`/holidays?${range}`).then(
      (list) => {
        if (!session.active || id !== requestId.current) return;
        setItems(list);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (!session.active || id !== requestId.current) return;
        setError(err instanceof Error ? err.message : 'Could not load holidays.');
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
      const list = await apiRequest<Holiday[]>(`/holidays?${session.range}`);
      if (session.active && id === requestId.current) setItems(list);
    } catch (err) {
      if (session.active && id === requestId.current)
        setError(err instanceof Error ? err.message : 'Could not load holidays.');
    } finally {
      if (session.active && id === requestId.current) setLoading(false);
    }
  }, []);

  const create = useCallback(
    async (payload: CreateHolidayRequest): Promise<Holiday> => {
      const created = await apiRequest<Holiday>('/holidays', {
        method: 'POST',
        body: payload,
      });
      await refetch();
      return created;
    },
    [refetch],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      await apiRequest<void>(`/holidays/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await refetch();
    },
    [refetch],
  );

  const seed = useCallback(
    async (payload: SeedHolidayRequest): Promise<SeedHolidayResponse> => {
      const result = await apiRequest<SeedHolidayResponse>('/holidays/seed', {
        method: 'POST',
        body: payload,
      });
      await refetch();
      return result;
    },
    [refetch],
  );

  return { items, loading, error, refetch, create, remove, seed };
}
