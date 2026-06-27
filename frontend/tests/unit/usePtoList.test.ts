import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { server } from '../mocks/server';
import { http, HttpResponse } from 'msw';
import { usePtoList } from '../../src/hooks/usePtoList';
import { STUB_PTO } from '../mocks/handlers';

describe('usePtoList', () => {
  it('fetches the list for the given range on mount', async () => {
    server.use(
      http.get('/pto', ({ request }) => {
        const url = new URL(request.url);
        return HttpResponse.json([
          { ...STUB_PTO, startDate: url.searchParams.get('start') ?? STUB_PTO.startDate },
        ]);
      }),
    );

    const { result } = renderHook(() => usePtoList('2026-05-01', '2026-05-31'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]?.startDate).toBe('2026-05-01');
    expect(result.current.error).toBeNull();
  });

  it('captures an error message when the request fails', async () => {
    server.use(
      http.get('/pto', () =>
        HttpResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'down' } }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => usePtoList('2026-05-01', '2026-05-31'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.items).toEqual([]);
    expect(result.current.error).toBe('down');
  });

  it('create() POSTs to /pto and refetches the list', async () => {
    let listCallCount = 0;
    server.use(
      http.get('/pto', () => {
        listCallCount += 1;
        return HttpResponse.json([STUB_PTO]);
      }),
      http.post('/pto', () =>
        HttpResponse.json({ ...STUB_PTO, id: 'newly-created' }, { status: 201 }),
      ),
    );

    const { result } = renderHook(() => usePtoList('2026-05-01', '2026-05-31'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    const before = listCallCount;

    await act(async () => {
      await result.current.create({
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'morning',
      });
    });

    expect(listCallCount).toBe(before + 1);
  });

  it('exposes refetch() that re-issues the GET', async () => {
    let callCount = 0;
    server.use(
      http.get('/pto', () => {
        callCount += 1;
        return HttpResponse.json([]);
      }),
    );

    const { result } = renderHook(() => usePtoList('2026-05-01', '2026-05-31'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    const before = callCount;

    await act(async () => {
      await result.current.refetch();
    });
    expect(callCount).toBe(before + 1);
  });
});
