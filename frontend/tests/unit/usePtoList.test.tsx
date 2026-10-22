import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { apiRequest } = vi.hoisted(() => ({ apiRequest: vi.fn() }));

vi.mock('../../src/api/client', () => ({
  apiRequest,
}));

import { usePtoList } from '../../src/hooks/usePtoList';

describe('usePtoList', () => {
  beforeEach(() => {
    apiRequest.mockReset();
  });

  it('loads the list for the requested range', async () => {
    const items = [
      {
        id: 'pto-1',
        userId: 'user-1',
        startDate: '2026-01-05',
        endDate: '2026-01-05',
        dayPart: 'morning' as const,
        note: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        user: {
          id: 'user-1',
          name: 'Developer One',
          role: 'member' as const,
          email: 'dev1@example.com',
          colorCode: '#123456',
        },
      },
    ];
    apiRequest.mockResolvedValueOnce(items);

    const { result } = renderHook(() => usePtoList('2026-01-01', '2026-01-31'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.items).toHaveLength(1);
    expect(result.current.error).toBeNull();
    expect(apiRequest).toHaveBeenCalledWith('/pto?start=2026-01-01&end=2026-01-31');
  });

  it('surfaces the error message when the list request fails', async () => {
    apiRequest.mockRejectedValueOnce(new Error('Could not reach the server.'));

    const { result } = renderHook(() => usePtoList('2026-01-01', '2026-01-31'));

    await waitFor(() => {
      expect(result.current.error).toBe('Could not reach the server.');
    });
    expect(result.current.loading).toBe(false);
  });

  it('falls back to a generic message when the request fails with a non-Error', async () => {
    apiRequest.mockRejectedValueOnce('not an error');

    const { result } = renderHook(() => usePtoList('2026-01-01', '2026-01-31'));

    await waitFor(() => {
      expect(result.current.error).toBe('Could not load PTOs.');
    });
    expect(result.current.loading).toBe(false);
  });
});
