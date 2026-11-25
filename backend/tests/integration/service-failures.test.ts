import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const envBackup = vi.hoisted(() => {
  const sessionSecret = process.env.SESSION_SECRET;
  const databaseUrl = process.env.DATABASE_URL;
  // The error handler imports the production logger, which reads the
  // environment when the module is imported. The fallback database URL points
  // at the discard port: the database client itself is replaced by a
  // deterministic fixture below, so no connection is ever opened.
  process.env.SESSION_SECRET ??= 'integration-service-failures-secret-3b81ea6d';
  process.env.DATABASE_URL ??= 'postgresql://placeholder@127.0.0.1:9/placeholder?schema=public';
  return { sessionSecret, databaseUrl };
});

const prismaMock = vi.hoisted(() => ({
  holiday: {
    findMany: vi.fn(),
    create: vi.fn(),
    findUnique: vi.fn(),
    delete: vi.fn(),
  },
  auditLog: {
    create: vi.fn(),
  },
}));

vi.mock('../../src/lib/prisma.js', () => ({ prisma: prismaMock }));

import { Prisma } from '@prisma/client';
import { HttpError } from '../../src/middleware/errorHandler.js';
import {
  CreateHolidaySchema,
  type CreateHolidayInput,
} from '../../src/services/holidays/schemas.js';
import { create, listAll, seedDefaults } from '../../src/services/holidays/HolidayService.js';

const ACTOR = { id: '11111111-1111-4111-8111-111111111111' };

function knownRequestError(code: string, message: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: '7.10.1',
  });
}

/** A caller that omits the optional country code entirely. */
const GLOBAL_HOLIDAY = {
  date: '2026-07-04',
  name: 'Global Day',
} as unknown as CreateHolidayInput;

afterAll(() => {
  if (envBackup.sessionSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = envBackup.sessionSecret;
  if (envBackup.databaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = envBackup.databaseUrl;
});

describe('holiday service failures', () => {
  beforeEach(() => {
    prismaMock.holiday.findMany.mockReset();
    prismaMock.holiday.create.mockReset();
    prismaMock.holiday.findUnique.mockReset();
    prismaMock.holiday.delete.mockReset();
    prismaMock.auditLog.create.mockReset();
    prismaMock.auditLog.create.mockResolvedValue({ id: 'audit-1' });
  });

  it('lists every holiday for the admin view', async () => {
    prismaMock.holiday.findMany.mockResolvedValue([
      {
        id: 'holiday-2',
        date: new Date('2026-07-05T00:00:00.000Z'),
        name: 'Second',
        countryCode: 'MX',
      },
      {
        id: 'holiday-1',
        date: new Date('2026-07-04T00:00:00.000Z'),
        name: 'First',
        countryCode: null,
      },
    ]);

    const holidays = await listAll();

    expect(holidays).toEqual([
      { id: 'holiday-2', date: '2026-07-05', name: 'Second', countryCode: 'MX' },
      { id: 'holiday-1', date: '2026-07-04', name: 'First', countryCode: null },
    ]);
    expect(prismaMock.holiday.findMany).toHaveBeenCalledWith({
      orderBy: [{ date: 'asc' }, { countryCode: 'asc' }],
      take: expect.any(Number),
      select: { id: true, date: true, name: true, countryCode: true },
    });
  });

  it('stores a holiday without a country code as a global holiday', async () => {
    prismaMock.holiday.create.mockResolvedValue({
      id: 'holiday-1',
      date: new Date('2026-07-04T00:00:00.000Z'),
      name: 'Global Day',
      countryCode: null,
    });

    const holiday = await create(GLOBAL_HOLIDAY, ACTOR);

    expect(holiday).toEqual({
      id: 'holiday-1',
      date: '2026-07-04',
      name: 'Global Day',
      countryCode: null,
    });
    expect(prismaMock.holiday.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ countryCode: null, createdById: ACTOR.id }),
      }),
    );
    // The change is still attributable in the audit trail.
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'create_holiday', entityId: 'holiday-1' }),
      }),
    );
  });

  it('turns a duplicate holiday into a conflict', async () => {
    prismaMock.holiday.create.mockRejectedValue(
      knownRequestError('P2002', 'Unique constraint failed on the fields: (`date`,`country_code`)'),
    );

    const failure = await create(GLOBAL_HOLIDAY, ACTOR).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HttpError);
    expect((failure as HttpError).status).toBe(409);
    expect((failure as HttpError).code).toBe('CONFLICT');
    expect((failure as HttpError).message).toBe(
      'A holiday already exists for that date and country.',
    );
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it('does not turn an unrelated database failure into a conflict', async () => {
    const driverError = knownRequestError('P2003', 'Foreign key constraint failed');
    prismaMock.holiday.create.mockRejectedValue(driverError);

    await expect(create(GLOBAL_HOLIDAY, ACTOR)).rejects.toBe(driverError);
  });

  it('does not turn an unexpected failure into a conflict', async () => {
    const unexpected = new Error('connection terminated unexpectedly');
    prismaMock.holiday.create.mockRejectedValue(unexpected);

    await expect(create(GLOBAL_HOLIDAY, ACTOR)).rejects.toBe(unexpected);
  });

  it('reports the seeded holidays that already exist as skipped', async () => {
    prismaMock.holiday.create.mockRejectedValue(
      knownRequestError('P2002', 'Unique constraint failed'),
    );

    const result = await seedDefaults('US', ACTOR);

    expect(result.inserted).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);
    expect(result.errors).toEqual([]);
  });

  it('reports a seeding failure instead of claiming the holiday was skipped', async () => {
    prismaMock.holiday.create.mockRejectedValue(new Error('connection terminated unexpectedly'));

    const result = await seedDefaults('US', ACTOR);

    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/^\d{4}-\d{2}-\d{2}: connection terminated unexpectedly$/);
  });

  it('accepts a request without a country code and normalizes it to the global marker', () => {
    const input = CreateHolidaySchema.parse({ date: '2026-07-04', name: 'Global Day' });

    expect(input.countryCode).toBeNull();
  });
});
