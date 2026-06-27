import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listVisibleRange } from './CalendarQuery.js';

vi.mock('../../lib/prisma.js', () => {
  const pTORequest = { findMany: vi.fn() };
  return { prisma: { pTORequest } };
});

import { prisma } from '../../lib/prisma.js';

const mockFindMany = prisma.pTORequest.findMany as unknown as ReturnType<typeof vi.fn>;

describe('CalendarQuery', () => {
  beforeEach(() => mockFindMany.mockReset());
  afterEach(() => vi.clearAllMocks());

  it('queries with the documented overlap predicate', async () => {
    mockFindMany.mockResolvedValueOnce([]);
    await listVisibleRange('2026-05-01', '2026-05-31');
    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        AND: [
          { startDate: { lte: new Date('2026-05-31T00:00:00.000Z') } },
          { endDate: { gte: new Date('2026-05-01T00:00:00.000Z') } },
        ],
      },
      orderBy: [{ startDate: 'asc' }, { userId: 'asc' }],
      select: expect.objectContaining({
        id: true,
        startDate: true,
        endDate: true,
        dayPart: true,
        note: true,
        user: expect.objectContaining({
          select: expect.objectContaining({
            id: true,
            name: true,
            colorCode: true,
          }),
        }),
      }),
    });
  });

  it('returns an empty array when no rows overlap', async () => {
    mockFindMany.mockResolvedValueOnce([]);
    expect(await listVisibleRange('2026-05-01', '2026-05-31')).toEqual([]);
  });

  it('maps rows to the public PTOWithUser shape with date strings', async () => {
    mockFindMany.mockResolvedValueOnce([
      {
        id: 'p1',
        startDate: new Date('2026-05-11T00:00:00.000Z'),
        endDate: new Date('2026-05-12T00:00:00.000Z'),
        dayPart: 'all_day',
        note: null,
        user: { id: 'u1', name: 'Alice', colorCode: '#3B82F6' },
      },
    ]);
    const result = await listVisibleRange('2026-05-01', '2026-05-31');
    expect(result).toEqual([
      {
        id: 'p1',
        user: { id: 'u1', name: 'Alice', colorCode: '#3B82F6' },
        startDate: '2026-05-11',
        endDate: '2026-05-12',
        dayPart: 'all_day',
        note: null,
      },
    ]);
  });
});
