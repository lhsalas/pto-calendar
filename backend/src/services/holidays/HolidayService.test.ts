import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { resetEnvForTests } from '../../config/env.js';
import { create, listAll, listInRange, remove, seedDefaults } from './HolidayService.js';

vi.mock('../../lib/prisma.js', () => {
  const holiday = {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  };
  return { prisma: { holiday } };
});

vi.mock('../audit/AuditLogService.js', () => ({
  record: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from '../../lib/prisma.js';
import { record } from '../audit/AuditLogService.js';

const mockFindMany = prisma.holiday.findMany as unknown as ReturnType<typeof vi.fn>;
const mockFindUnique = prisma.holiday.findUnique as unknown as ReturnType<typeof vi.fn>;
const mockCreate = prisma.holiday.create as unknown as ReturnType<typeof vi.fn>;
const mockDelete = prisma.holiday.delete as unknown as ReturnType<typeof vi.fn>;
const mockRecord = record as unknown as ReturnType<typeof vi.fn>;

const ACTOR = { id: 'actor-uuid' };

beforeEach(() => {
  process.env.SESSION_SECRET = 'aB1!cD2@eF3#gH4$iJ5%kL6&mN7*oP8+';
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? 'postgresql://pto:pto@localhost:5432/pto_test';
  resetEnvForTests();
  mockFindMany.mockReset();
  mockFindUnique.mockReset();
  mockCreate.mockReset();
  mockDelete.mockReset();
  mockRecord.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('HolidayService.listInRange', () => {
  it('returns rows in date order', async () => {
    mockFindMany.mockResolvedValueOnce([
      { id: 'h1', date: new Date('2026-07-04Z'), name: 'A', countryCode: 'US' },
      { id: 'h2', date: new Date('2026-12-25Z'), name: 'B', countryCode: null },
    ]);
    const result = await listInRange('2026-01-01', '2026-12-31');
    expect(result).toEqual([
      { id: 'h1', date: '2026-07-04', name: 'A', countryCode: 'US' },
      { id: 'h2', date: '2026-12-25', name: 'B', countryCode: null },
    ]);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          date: {
            gte: new Date('2026-01-01T00:00:00.000Z'),
            lte: new Date('2026-12-31T00:00:00.000Z'),
          },
        },
      }),
    );
  });

  it('returns empty array when no rows', async () => {
    mockFindMany.mockResolvedValueOnce([]);
    const result = await listInRange('2026-01-01', '2026-12-31');
    expect(result).toEqual([]);
  });
});

describe('HolidayService.listAll', () => {
  it('returns rows without date filter', async () => {
    mockFindMany.mockResolvedValueOnce([
      { id: 'h1', date: new Date('2026-07-04Z'), name: 'A', countryCode: null },
    ]);
    const result = await listAll();
    expect(result).toEqual([{ id: 'h1', date: '2026-07-04', name: 'A', countryCode: null }]);
    const where = mockFindMany.mock.calls[0]?.[0]?.where;
    expect(where).toBeUndefined();
  });
});

describe('HolidayService.create', () => {
  it('creates a holiday and writes an audit log', async () => {
    mockCreate.mockResolvedValueOnce({
      id: 'h-new',
      date: new Date('2026-07-04Z'),
      name: 'Independence Day',
      countryCode: 'US',
    });
    const result = await create(
      { date: '2026-07-04', name: 'Independence Day', countryCode: 'US' },
      ACTOR,
    );
    expect(result).toEqual({
      id: 'h-new',
      date: '2026-07-04',
      name: 'Independence Day',
      countryCode: 'US',
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          countryCode: 'US',
          createdById: ACTOR.id,
          name: 'Independence Day',
        }),
      }),
    );
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: ACTOR.id,
        action: 'create_holiday',
        entityType: 'holiday',
        entityId: 'h-new',
        details: { date: '2026-07-04', name: 'Independence Day', countryCode: 'US' },
      }),
    );
  });

  it('normalizes missing countryCode to null', async () => {
    mockCreate.mockResolvedValueOnce({
      id: 'h1',
      date: new Date('2026-07-04Z'),
      name: 'X',
      countryCode: null,
    });
    await create({ date: '2026-07-04', name: 'X', countryCode: null }, ACTOR);
    expect(mockCreate.mock.calls[0]?.[0]?.data?.countryCode).toBeNull();
  });

  it('returns 409 on unique-constraint conflict', async () => {
    const prismaErr = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '5.22.0',
    });
    mockCreate.mockRejectedValueOnce(prismaErr);
    await expect(
      create({ date: '2026-07-04', name: 'X', countryCode: 'US' }, ACTOR),
    ).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
  });

  it('re-throws other Prisma errors', async () => {
    const prismaErr = new Prisma.PrismaClientKnownRequestError('Other', {
      code: 'P2003',
      clientVersion: '5.22.0',
    });
    mockCreate.mockRejectedValueOnce(prismaErr);
    await expect(create({ date: '2026-07-04', name: 'X', countryCode: null }, ACTOR)).rejects.toBe(
      prismaErr,
    );
  });
});

describe('HolidayService.remove', () => {
  it('deletes an existing holiday and writes an audit log', async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: 'h-1',
      date: new Date('2026-07-04Z'),
      name: 'X',
      countryCode: null,
    });
    mockDelete.mockResolvedValueOnce({});
    await remove('h-1', ACTOR);
    expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'h-1' } });
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'delete_holiday',
        entityType: 'holiday',
        entityId: 'h-1',
        details: { date: '2026-07-04', name: 'X', countryCode: null },
      }),
    );
  });

  it('throws 404 when holiday does not exist', async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    await expect(remove('missing', ACTOR)).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe('HolidayService.seedDefaults', () => {
  it('inserts preset entries, skipping duplicates, and reports counts', async () => {
    // US preset has 26 entries; only the first 5 are scripted (1st ok, 2nd ok,
    // 3rd duplicate, 4th ok, 5th error). The remaining 21 default-reject so
    // the seed function records them as errors rather than silently counting
    // as inserts.
    mockCreate
      .mockResolvedValueOnce({ id: 'a' })
      .mockResolvedValueOnce({ id: 'b' })
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Unique', {
          code: 'P2002',
          clientVersion: '5.22.0',
        }),
      )
      .mockResolvedValueOnce({ id: 'c' })
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValue(new Error('unscripted'));
    const result = await seedDefaults('US', ACTOR);
    expect(result.inserted).toBe(3);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(22);
    expect(result.errors[0]).toMatch(/2026-06-19/);
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'seed_holidays',
        details: expect.objectContaining({
          countryCode: 'US',
          inserted: 3,
          skipped: 1,
          errorCount: 22,
        }),
      }),
    );
  });

  it('handles the MX preset when every entry is a fresh insert', async () => {
    mockCreate.mockResolvedValue({ id: 'a' });
    const result = await seedDefaults('MX', ACTOR);
    expect(result.inserted).toBe(14);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);
  });
});
