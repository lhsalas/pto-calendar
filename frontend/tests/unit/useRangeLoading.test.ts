import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from '../../src/api/client';
import { useHolidays } from '../../src/hooks/useHolidays';
import { usePtoList } from '../../src/hooks/usePtoList';
import { STUB_PTO } from '../mocks/handlers';

vi.mock('../../src/api/client', () => ({ apiRequest: vi.fn() }));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('range query lifecycle', () => {
  beforeEach(() => vi.mocked(apiRequest).mockReset());

  it('keeps newer PTO data when an earlier range completes late', async () => {
    const earlier = deferred<(typeof STUB_PTO)[]>();
    const later = deferred<(typeof STUB_PTO)[]>();
    vi.mocked(apiRequest).mockReturnValueOnce(earlier.promise).mockReturnValueOnce(later.promise);
    const { result, rerender } = renderHook(({ start }) => usePtoList(start, '2026-12-31'), {
      initialProps: { start: '2026-01-01' },
    });
    rerender({ start: '2026-06-01' });
    expect(result.current.loading).toBe(true);
    await act(async () => later.resolve([{ ...STUB_PTO, id: 'new' }]));
    await waitFor(() => expect(result.current.items[0]?.id).toBe('new'));
    await act(async () => earlier.resolve([{ ...STUB_PTO, id: 'old' }]));
    expect(result.current.items[0]?.id).toBe('new');
    expect(result.current.loading).toBe(false);
  });

  it('returns to loading when revisiting a holiday range and ignores the older response', async () => {
    const pending = deferred<never[]>();
    const revisit = deferred<never[]>();
    vi.mocked(apiRequest)
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(pending.promise)
      .mockReturnValueOnce(revisit.promise);
    const { result, rerender } = renderHook(({ start }) => useHolidays(start, '2026-12-31'), {
      initialProps: { start: '2026-01-01' },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ start: '2026-06-01' });
    rerender({ start: '2026-01-01' });
    expect(result.current.loading).toBe(true);
    await act(async () => pending.resolve([]));
    expect(result.current.loading).toBe(true);
    await act(async () => revisit.resolve([]));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it.each(['create', 'update', 'remove'] as const)(
    'refreshes the active PTO range after an outstanding %s completes',
    async (operation) => {
      const write = deferred<typeof STUB_PTO>();
      vi.mocked(apiRequest)
        .mockResolvedValueOnce([])
        .mockReturnValueOnce(write.promise)
        .mockResolvedValueOnce([{ ...STUB_PTO, id: 'before-write' }])
        .mockResolvedValueOnce([{ ...STUB_PTO, id: 'after-write' }]);
      const { result, rerender } = renderHook(({ start }) => usePtoList(start, '2026-12-31'), {
        initialProps: { start: '2026-01-01' },
      });
      await waitFor(() => expect(result.current.loading).toBe(false));
      let mutation!: Promise<unknown>;
      act(() => {
        const payload = { startDate: '2026-01-05', endDate: '2026-01-05' };
        mutation =
          operation === 'create'
            ? result.current.create(payload)
            : operation === 'update'
              ? result.current.update(STUB_PTO.id, payload)
              : result.current.remove(STUB_PTO.id);
      });
      rerender({ start: '2026-06-01' });
      await waitFor(() => expect(result.current.items[0]?.id).toBe('before-write'));
      await act(async () => {
        write.resolve(STUB_PTO);
        await mutation;
      });
      expect(apiRequest).toHaveBeenCalledTimes(4);
      expect(vi.mocked(apiRequest).mock.calls[3]?.[0]).toBe('/pto?start=2026-06-01&end=2026-12-31');
      expect(result.current.items[0]?.id).toBe('after-write');
    },
  );

  it.each(['create', 'remove', 'seed'] as const)(
    'refreshes the active holiday range after an outstanding %s completes',
    async (operation) => {
      const write = deferred<unknown>();
      const holiday = { id: 'new-holiday', date: '2026-06-15', name: 'Holiday', countryCode: null };
      vi.mocked(apiRequest)
        .mockResolvedValueOnce([])
        .mockReturnValueOnce(write.promise)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([holiday]);
      const { result, rerender } = renderHook(({ start }) => useHolidays(start, '2026-12-31'), {
        initialProps: { start: '2026-01-01' },
      });
      await waitFor(() => expect(result.current.loading).toBe(false));
      let mutation!: Promise<unknown>;
      act(() => {
        mutation =
          operation === 'create'
            ? result.current.create({ date: holiday.date, name: holiday.name })
            : operation === 'remove'
              ? result.current.remove(holiday.id)
              : result.current.seed({ countryCode: 'US' });
      });
      rerender({ start: '2026-06-01' });
      await waitFor(() => expect(result.current.loading).toBe(false));
      await act(async () => {
        write.resolve(operation === 'seed' ? { inserted: 1, skipped: 0, errors: [] } : holiday);
        await mutation;
      });
      expect(apiRequest).toHaveBeenCalledTimes(4);
      expect(vi.mocked(apiRequest).mock.calls[3]?.[0]).toBe(
        '/holidays?start=2026-06-01&end=2026-12-31',
      );
      expect(result.current.items).toEqual([holiday]);
    },
  );

  it('ignores an older in-flight PTO response after the post-write refresh', async () => {
    const oldRead = deferred<(typeof STUB_PTO)[]>();
    const write = deferred<typeof STUB_PTO>();
    vi.mocked(apiRequest)
      .mockReturnValueOnce(oldRead.promise)
      .mockReturnValueOnce(write.promise)
      .mockResolvedValueOnce([{ ...STUB_PTO, id: 'fresh' }]);
    const { result } = renderHook(() => usePtoList('2026-01-01', '2026-12-31'));
    let mutation!: Promise<unknown>;
    act(() => {
      mutation = result.current.create({ startDate: '2026-01-05', endDate: '2026-01-05' });
    });
    await act(async () => {
      write.resolve(STUB_PTO);
      await mutation;
    });
    expect(result.current.items[0]?.id).toBe('fresh');
    await act(async () => oldRead.resolve([{ ...STUB_PTO, id: 'stale' }]));
    expect(result.current.items[0]?.id).toBe('fresh');
  });

  it('ignores an older in-flight holiday response after the post-write refresh', async () => {
    const oldRead = deferred<never[]>();
    const write = deferred<unknown>();
    const holiday = { id: 'fresh', date: '2026-06-15', name: 'Holiday', countryCode: null };
    vi.mocked(apiRequest)
      .mockReturnValueOnce(oldRead.promise)
      .mockReturnValueOnce(write.promise)
      .mockResolvedValueOnce([holiday]);
    const { result } = renderHook(() => useHolidays('2026-01-01', '2026-12-31'));
    let mutation!: Promise<unknown>;
    act(() => {
      mutation = result.current.seed({ countryCode: 'US' });
    });
    await act(async () => {
      write.resolve({ inserted: 1, skipped: 0, errors: [] });
      await mutation;
    });
    expect(result.current.items).toEqual([holiday]);
    await act(async () => oldRead.resolve([]));
    expect(result.current.items).toEqual([holiday]);
  });

  it('does not refresh PTO after unmount when a write completes', async () => {
    const write = deferred<unknown>();
    vi.mocked(apiRequest).mockResolvedValueOnce([]).mockReturnValueOnce(write.promise);
    const { result, unmount } = renderHook(() => usePtoList('2026-01-01', '2026-12-31'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const mutation = result.current.create({ startDate: '2026-01-05', endDate: '2026-01-05' });
    unmount();
    await act(async () => {
      write.resolve(STUB_PTO);
      await mutation;
    });
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });

  it('does not refresh holidays after unmount when a write completes', async () => {
    const write = deferred<unknown>();
    vi.mocked(apiRequest).mockResolvedValueOnce([]).mockReturnValueOnce(write.promise);
    const { result, unmount } = renderHook(() => useHolidays('2026-01-01', '2026-12-31'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const mutation = result.current.seed({ countryCode: 'US' });
    unmount();
    await act(async () => {
      write.resolve({ inserted: 1, skipped: 0, errors: [] });
      await mutation;
    });
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });

  it('clears a refetch error when a later refresh succeeds', async () => {
    vi.mocked(apiRequest)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValueOnce([STUB_PTO]);
    const { result } = renderHook(() => usePtoList('2026-01-01', '2026-12-31'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => result.current.refetch());
    expect(result.current.error).toBe('refresh failed');
    await act(async () => result.current.refetch());
    expect(result.current.error).toBeNull();
    expect(result.current.items).toEqual([STUB_PTO]);
  });

  it('ignores a failed refetch from a range that is no longer active', async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<never>((_, fail) => {
      reject = fail;
    });
    vi.mocked(apiRequest)
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce([{ ...STUB_PTO, id: 'current' }]);
    const { result, rerender } = renderHook(({ start }) => usePtoList(start, '2026-12-31'), {
      initialProps: { start: '2026-01-01' },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.refetch();
    });
    rerender({ start: '2026-06-01' });
    await waitFor(() => expect(result.current.items[0]?.id).toBe('current'));
    await act(async () => {
      reject(new Error('stale'));
      await refresh;
    });
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});
