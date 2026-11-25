import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Holiday } from '../../src/types/api';

const { apiRequest } = vi.hoisted(() => ({ apiRequest: vi.fn() }));

vi.mock('../../src/api/client', () => ({ apiRequest }));

import { useHolidays } from '../../src/hooks/useHolidays';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function holiday(id: string, date: string, name: string): Holiday {
  return { id, date, name, countryCode: 'US' };
}

const FIRST_HOLIDAY = holiday('h-1', '2026-07-04', 'Independence Day');
const SECOND_HOLIDAY = holiday('h-2', '2026-12-25', 'Christmas Day');

async function settle(): Promise<void> {
  await Promise.resolve();
}

describe('useHolidays', () => {
  beforeEach(() => {
    apiRequest.mockReset();
  });

  it('loads the holidays for the requested range', async () => {
    apiRequest.mockResolvedValueOnce([FIRST_HOLIDAY]);

    const { result } = renderHook(() => useHolidays('2026-01-01', '2026-01-31'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.items).toEqual([FIRST_HOLIDAY]);
    expect(result.current.error).toBeNull();
    expect(apiRequest).toHaveBeenCalledWith('/holidays?start=2026-01-01&end=2026-01-31');
  });

  it('surfaces the error message when the initial load fails', async () => {
    apiRequest.mockRejectedValueOnce(new Error('Could not reach the server.'));

    const { result } = renderHook(() => useHolidays('2026-01-01', '2026-01-31'));

    await waitFor(() => {
      expect(result.current.error).toBe('Could not reach the server.');
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.items).toEqual([]);
  });

  it('falls back to a generic message when the initial load fails with a non-Error', async () => {
    apiRequest.mockRejectedValueOnce('not an error');

    const { result } = renderHook(() => useHolidays('2026-01-01', '2026-01-31'));

    await waitFor(() => {
      expect(result.current.error).toBe('Could not load holidays.');
    });
    expect(result.current.loading).toBe(false);
  });

  it('ignores a load failure that arrives after the hook unmounts', async () => {
    const pending = deferred<Holiday[]>();
    apiRequest.mockReturnValueOnce(pending.promise);

    const { result, unmount } = renderHook(() => useHolidays('2026-01-01', '2026-01-31'));
    unmount();

    await act(async () => {
      pending.reject(new Error('late failure'));
      await pending.promise.catch(() => undefined);
      await settle();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(result.current.items).toEqual([]);
  });

  it('ignores a stale load failure once a newer request has been started', async () => {
    const pending = deferred<Holiday[]>();
    apiRequest.mockReturnValueOnce(pending.promise);
    apiRequest.mockResolvedValueOnce([SECOND_HOLIDAY]);

    const { result } = renderHook(() => useHolidays('2026-01-01', '2026-01-31'));

    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.items).toEqual([SECOND_HOLIDAY]);

    await act(async () => {
      pending.reject(new Error('stale failure'));
      await pending.promise.catch(() => undefined);
      await settle();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.items).toEqual([SECOND_HOLIDAY]);
  });

  it('replaces the items when refetch resolves', async () => {
    apiRequest.mockResolvedValueOnce([FIRST_HOLIDAY]);

    const { result } = renderHook(() => useHolidays('2026-01-01', '2026-01-31'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    apiRequest.mockResolvedValueOnce([SECOND_HOLIDAY]);
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.items).toEqual([SECOND_HOLIDAY]);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(apiRequest).toHaveBeenLastCalledWith('/holidays?start=2026-01-01&end=2026-01-31');
  });

  it('surfaces the error message when a refetch fails', async () => {
    apiRequest.mockResolvedValueOnce([FIRST_HOLIDAY]);

    const { result } = renderHook(() => useHolidays('2026-01-01', '2026-01-31'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    apiRequest.mockRejectedValueOnce(new Error('Refetch failed.'));
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.error).toBe('Refetch failed.');
    expect(result.current.loading).toBe(false);
  });

  it('falls back to a generic message when a refetch fails with a non-Error', async () => {
    apiRequest.mockResolvedValueOnce([FIRST_HOLIDAY]);

    const { result } = renderHook(() => useHolidays('2026-01-01', '2026-01-31'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    apiRequest.mockRejectedValueOnce('not an error');
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.error).toBe('Could not load holidays.');
    expect(result.current.loading).toBe(false);
  });

  it('ignores a refetch failure that arrives after the hook unmounts', async () => {
    apiRequest.mockResolvedValueOnce([FIRST_HOLIDAY]);

    const { result, unmount } = renderHook(() => useHolidays('2026-01-01', '2026-01-31'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const pending = deferred<Holiday[]>();
    apiRequest.mockReturnValueOnce(pending.promise);

    let refetch: Promise<void> = Promise.resolve();
    await act(async () => {
      refetch = result.current.refetch();
    });
    // The refetch really started: the request is in flight and the hook is
    // loading again while it waits for the response.
    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(result.current.loading).toBe(true);

    unmount();

    await act(async () => {
      pending.reject(new Error('late refetch failure'));
      await refetch;
      await settle();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.items).toEqual([FIRST_HOLIDAY]);
  });

  it('ignores a stale refetch response when a newer refetch is in flight', async () => {
    apiRequest.mockResolvedValueOnce([FIRST_HOLIDAY]);

    const { result } = renderHook(() => useHolidays('2026-01-01', '2026-01-31'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const stale = deferred<Holiday[]>();
    apiRequest.mockReturnValueOnce(stale.promise);
    apiRequest.mockResolvedValueOnce([SECOND_HOLIDAY]);

    let staleRefetch: Promise<void> = Promise.resolve();
    await act(async () => {
      staleRefetch = result.current.refetch();
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.items).toEqual([SECOND_HOLIDAY]);

    await act(async () => {
      stale.resolve([FIRST_HOLIDAY]);
      await staleRefetch;
      await settle();
    });

    expect(result.current.items).toEqual([SECOND_HOLIDAY]);
    expect(result.current.error).toBeNull();
  });

  it('ignores a refetch response that arrives after the hook unmounts', async () => {
    apiRequest.mockResolvedValueOnce([FIRST_HOLIDAY]);

    const { result, unmount } = renderHook(() => useHolidays('2026-01-01', '2026-01-31'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const pending = deferred<Holiday[]>();
    apiRequest.mockReturnValueOnce(pending.promise);

    let refetch: Promise<void> = Promise.resolve();
    await act(async () => {
      refetch = result.current.refetch();
    });
    // The refetch really started: the request is in flight and the hook is
    // loading again while it waits for the response.
    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(result.current.loading).toBe(true);

    unmount();

    await act(async () => {
      pending.resolve([SECOND_HOLIDAY]);
      await refetch;
      await settle();
    });

    expect(result.current.items).toEqual([FIRST_HOLIDAY]);
  });

  it('creates a holiday and refreshes the list', async () => {
    apiRequest.mockResolvedValueOnce([FIRST_HOLIDAY]);

    const { result } = renderHook(() => useHolidays('2026-01-01', '2026-01-31'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    apiRequest.mockResolvedValueOnce(SECOND_HOLIDAY);
    apiRequest.mockResolvedValueOnce([FIRST_HOLIDAY, SECOND_HOLIDAY]);

    let created: Holiday | null = null;
    await act(async () => {
      created = await result.current.create({
        date: '2026-12-25',
        name: 'Christmas Day',
        countryCode: 'US',
      });
    });

    expect(created).toEqual(SECOND_HOLIDAY);
    expect(apiRequest).toHaveBeenNthCalledWith(2, '/holidays', {
      method: 'POST',
      body: { date: '2026-12-25', name: 'Christmas Day', countryCode: 'US' },
    });
    expect(result.current.items).toEqual([FIRST_HOLIDAY, SECOND_HOLIDAY]);
  });

  it('removes a holiday and refreshes the list', async () => {
    apiRequest.mockResolvedValueOnce([FIRST_HOLIDAY]);

    const { result } = renderHook(() => useHolidays('2026-01-01', '2026-01-31'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    apiRequest.mockResolvedValueOnce(undefined);
    apiRequest.mockResolvedValueOnce([]);

    await act(async () => {
      await result.current.remove('h-1');
    });

    expect(apiRequest).toHaveBeenNthCalledWith(2, '/holidays/h-1', { method: 'DELETE' });
    expect(result.current.items).toEqual([]);
  });

  it('seeds defaults and refreshes the list', async () => {
    apiRequest.mockResolvedValueOnce([FIRST_HOLIDAY]);

    const { result } = renderHook(() => useHolidays('2026-01-01', '2026-01-31'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    apiRequest.mockResolvedValueOnce({ inserted: 14, skipped: 0, errors: [] });
    apiRequest.mockResolvedValueOnce([FIRST_HOLIDAY]);

    let seeded: { inserted: number; skipped: number; errors: string[] } | null = null;
    await act(async () => {
      seeded = await result.current.seed({ countryCode: 'US' });
    });

    expect(seeded).toEqual({ inserted: 14, skipped: 0, errors: [] });
    expect(apiRequest).toHaveBeenNthCalledWith(2, '/holidays/seed', {
      method: 'POST',
      body: { countryCode: 'US' },
    });
    expect(result.current.items).toEqual([FIRST_HOLIDAY]);
  });
});
