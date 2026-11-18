import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listVisiblePage, listVisibleRange } from './CalendarQuery.js';

vi.mock('../../lib/prisma.js', () => {
  const pTORequest = { findMany: vi.fn() };
  return { prisma: { pTORequest } };
});

vi.mock('./cursor.js', () => ({ mintCursor: vi.fn(() => 'minted-cursor') }));

import { prisma } from '../../lib/prisma.js';
import { mintCursor } from './cursor.js';

const mockFindMany = prisma.pTORequest.findMany as unknown as ReturnType<typeof vi.fn>;
const mockMint = mintCursor as unknown as ReturnType<typeof vi.fn>;

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    userId: OWNER,
    startDate: new Date('2026-05-11T00:00:00.000Z'),
    endDate: new Date('2026-05-12T00:00:00.000Z'),
    dayPart: 'all_day',
    user: { id: OWNER, name: 'Alice', colorCode: '#3B82F6' },
    ...overrides,
  };
}

describe('CalendarQuery', () => {
  beforeEach(() => {
    mockFindMany.mockReset();
    mockMint.mockClear();
    mockMint.mockReturnValue('minted-cursor');
  });
  afterEach(() => vi.clearAllMocks());

  describe('listVisibleRange', () => {
    it('queries with the documented overlap predicate', async () => {
      mockFindMany.mockResolvedValueOnce([]);
      await listVisibleRange({ start: '2026-05-01', end: '2026-05-31', userId: null });
      expect(mockFindMany).toHaveBeenCalledWith({
        where: {
          AND: [
            { startDate: { lte: new Date('2026-05-31T00:00:00.000Z') } },
            { endDate: { gte: new Date('2026-05-01T00:00:00.000Z') } },
          ],
        },
        orderBy: [{ startDate: 'asc' }, { userId: 'asc' }, { id: 'asc' }],
        take: 1000,
        select: expect.objectContaining({
          id: true,
          userId: true,
          startDate: true,
          endDate: true,
          dayPart: true,
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

    it('never selects the note column for a list', async () => {
      mockFindMany.mockResolvedValueOnce([]);
      await listVisibleRange({ start: '2026-05-01', end: '2026-05-31', userId: null });
      const select = mockFindMany.mock.calls[0]![0].select as Record<string, unknown>;
      expect(select).not.toHaveProperty('note');
    });

    it('applies the owner filter inside the database query, before the cap', async () => {
      mockFindMany.mockResolvedValueOnce([]);
      await listVisibleRange({ start: '2026-05-01', end: '2026-05-31', userId: OWNER });
      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: [
              { startDate: { lte: new Date('2026-05-31T00:00:00.000Z') } },
              { endDate: { gte: new Date('2026-05-01T00:00:00.000Z') } },
              { userId: OWNER },
            ],
          },
        }),
      );
    });

    it('returns an empty array when no rows overlap', async () => {
      mockFindMany.mockResolvedValueOnce([]);
      expect(
        await listVisibleRange({ start: '2026-05-01', end: '2026-05-31', userId: null }),
      ).toEqual([]);
    });

    it('maps rows to the public PTOWithUser shape with date strings and a null note', async () => {
      mockFindMany.mockResolvedValueOnce([row()]);
      const result = await listVisibleRange({
        start: '2026-05-01',
        end: '2026-05-31',
        userId: null,
      });
      expect(result).toEqual([
        {
          id: 'p1',
          user: { id: OWNER, name: 'Alice', colorCode: '#3B82F6' },
          startDate: '2026-05-11',
          endDate: '2026-05-12',
          dayPart: 'all_day',
          note: null,
        },
      ]);
    });
  });

  describe('listVisiblePage', () => {
    it('requests one extra row to answer hasMore without a second query', async () => {
      mockFindMany.mockResolvedValueOnce([row()]);
      await listVisiblePage(
        { start: '2026-05-01', end: '2026-05-31', userId: null },
        { limit: 200, cursor: null },
      );
      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 201,
          orderBy: [{ startDate: 'asc' }, { userId: 'asc' }, { id: 'asc' }],
        }),
      );
    });

    it('uses the default page size when no limit is supplied', async () => {
      mockFindMany.mockResolvedValueOnce([row()]);
      await listVisiblePage(
        { start: '2026-05-01', end: '2026-05-31', userId: null },
        { cursor: null },
      );
      expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 101 }));
    });

    it('reports the last delivered row as the next cursor and keeps the extra row out', async () => {
      mockFindMany.mockResolvedValueOnce([
        row({ id: 'p1' }),
        row({ id: 'p2', userId: OTHER, user: { id: OTHER, name: 'Bob', colorCode: '#10B981' } }),
      ]);
      const page = await listVisiblePage(
        { start: '2026-05-01', end: '2026-05-31', userId: null },
        { limit: 1, cursor: null },
      );
      expect(page.items).toHaveLength(1);
      expect(page.items[0]!.id).toBe('p1');
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).toBe('minted-cursor');
      expect(mockMint).toHaveBeenCalledWith(
        { start: '2026-05-01', end: '2026-05-31', userId: null },
        { startDate: '2026-05-11', userId: OWNER, id: 'p1' },
      );
    });

    it('returns a null cursor exactly when there is no further page', async () => {
      mockFindMany.mockResolvedValueOnce([row({ id: 'p1' })]);
      const page = await listVisiblePage(
        { start: '2026-05-01', end: '2026-05-31', userId: null },
        { limit: 1, cursor: null },
      );
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
      expect(mockMint).not.toHaveBeenCalled();
    });

    it('returns an empty page for an empty result set', async () => {
      mockFindMany.mockResolvedValueOnce([]);
      const page = await listVisiblePage(
        { start: '2026-05-01', end: '2026-05-31', userId: null },
        { limit: 50, cursor: null },
      );
      expect(page).toEqual({ items: [], nextCursor: null, hasMore: false });
    });

    it('continues after the anchor with a keyset predicate instead of an offset', async () => {
      mockFindMany.mockResolvedValueOnce([]);
      const anchorDate = new Date('2026-05-11T00:00:00.000Z');
      await listVisiblePage(
        { start: '2026-05-01', end: '2026-05-31', userId: OWNER },
        {
          limit: 10,
          cursor: {
            context: { start: '2026-05-01', end: '2026-05-31', userId: OWNER },
            anchor: { startDate: '2026-05-11', userId: OWNER, id: 'p1' },
          },
        },
      );
      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: [
              { startDate: { lte: new Date('2026-05-31T00:00:00.000Z') } },
              { endDate: { gte: new Date('2026-05-01T00:00:00.000Z') } },
              { userId: OWNER },
              {
                OR: [
                  { startDate: { gt: anchorDate } },
                  { startDate: anchorDate, userId: { gt: OWNER } },
                  { startDate: anchorDate, userId: OWNER, id: { gt: 'p1' } },
                ],
              },
            ],
          },
        }),
      );
    });
  });
});
