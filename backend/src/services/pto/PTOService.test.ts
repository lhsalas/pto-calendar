import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../middleware/errorHandler.js';
import { createPto, findOverlapping, toPublicPto } from './PTOService.js';

vi.mock('../../lib/prisma.js', () => {
  const pTORequest = {
    findFirst: vi.fn(),
    create: vi.fn(),
  };
  return { prisma: { pTORequest } };
});

import { prisma } from '../../lib/prisma.js';

const mockFindFirst = prisma.pTORequest.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockCreate = prisma.pTORequest.create as unknown as ReturnType<typeof vi.fn>;

const USER_ID = '11111111-1111-1111-1111-111111111111';

const CREATED_ROW = {
  id: '22222222-2222-2222-2222-222222222222',
  userId: USER_ID,
  startDate: new Date('2026-05-11T00:00:00.000Z'),
  endDate: new Date('2026-05-11T00:00:00.000Z'),
  dayPart: 'morning' as const,
  note: null,
  createdAt: new Date('2026-05-01T10:00:00.000Z'),
  updatedAt: new Date('2026-05-01T10:00:00.000Z'),
};

describe('PTOService', () => {
  beforeEach(() => {
    mockFindFirst.mockReset();
    mockCreate.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('findOverlapping', () => {
    it('queries with the documented overlap predicate', async () => {
      mockFindFirst.mockResolvedValueOnce(CREATED_ROW);
      const result = await findOverlapping(USER_ID, '2026-05-11', '2026-05-15');
      expect(result).toBe(CREATED_ROW);
      expect(mockFindFirst).toHaveBeenCalledWith({
        where: {
          userId: USER_ID,
          AND: [
            { startDate: { lte: new Date('2026-05-15T00:00:00.000Z') } },
            { endDate: { gte: new Date('2026-05-11T00:00:00.000Z') } },
          ],
        },
        select: expect.objectContaining({
          id: true,
          userId: true,
          startDate: true,
          endDate: true,
          dayPart: true,
          note: true,
          createdAt: true,
          updatedAt: true,
        }),
      });
    });

    it('excludes a given id when provided', async () => {
      mockFindFirst.mockResolvedValueOnce(null);
      await findOverlapping(USER_ID, '2026-05-11', '2026-05-15', 'exclude-this-id');
      const calls = mockFindFirst.mock.calls[0];
      const call = calls?.[0] as { where: { id: unknown } };
      expect(call.where.id).toEqual({ not: 'exclude-this-id' });
    });

    it('returns null when no overlap', async () => {
      mockFindFirst.mockResolvedValueOnce(null);
      expect(await findOverlapping(USER_ID, '2026-05-11', '2026-05-11')).toBeNull();
    });
  });

  describe('createPto', () => {
    it('persists a validated PTO and returns the public row', async () => {
      mockFindFirst.mockResolvedValueOnce(null);
      mockCreate.mockResolvedValueOnce(CREATED_ROW);
      const result = await createPto(USER_ID, {
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'morning',
        note: 'Doctor',
      });
      expect(result).toBe(CREATED_ROW);
      expect(mockCreate).toHaveBeenCalledWith({
        data: {
          userId: USER_ID,
          startDate: new Date('2026-05-11T00:00:00.000Z'),
          endDate: new Date('2026-05-11T00:00:00.000Z'),
          dayPart: 'morning',
          note: 'Doctor',
        },
        select: expect.objectContaining({ id: true, userId: true }),
      });
    });

    it('throws 409 CONFLICT when an overlap exists', async () => {
      mockFindFirst.mockResolvedValueOnce(CREATED_ROW);
      await expect(
        createPto(USER_ID, {
          startDate: '2026-05-11',
          endDate: '2026-05-11',
          dayPart: 'morning',
        }),
      ).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('surfaces validation errors as 400', async () => {
      await expect(
        createPto(USER_ID, {
          startDate: '2026-05-09',
          endDate: '2026-05-09',
          dayPart: 'morning',
        }),
      ).rejects.toBeInstanceOf(HttpError);
      expect(mockFindFirst).not.toHaveBeenCalled();
    });
  });

  describe('toPublicPto', () => {
    it('converts a Prisma row to the public API shape', () => {
      const publicRow = toPublicPto(CREATED_ROW);
      expect(publicRow).toEqual({
        id: CREATED_ROW.id,
        userId: USER_ID,
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'morning',
        note: null,
        createdAt: '2026-05-01T10:00:00.000Z',
        updatedAt: '2026-05-01T10:00:00.000Z',
      });
    });
  });
});
