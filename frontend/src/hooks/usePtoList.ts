import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../api/client';
import type { CreatePTORequest, PTOWithUser } from '../types/api';

export interface UsePtoListResult {
  items: PTOWithUser[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  create: (payload: CreatePTORequest) => Promise<PTOWithUser>;
}

export function usePtoList(start: string, end: string): UsePtoListResult {
  const [items, setItems] = useState<PTOWithUser[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const list = await apiRequest<PTOWithUser[]>(`/pto?start=${start}&end=${end}`);
      setItems(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load PTOs.');
    } finally {
      setLoading(false);
    }
  }, [start, end]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

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

  return { items, loading, error, refetch, create };
}
