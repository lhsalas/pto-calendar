import { useCallback, useEffect, useState } from 'react';
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

  const refetch = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ start, end }).toString();
      const list = await apiRequest<Holiday[]>(`/holidays?${query}`);
      setItems(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load holidays.');
    } finally {
      setLoading(false);
    }
  }, [start, end]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

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
