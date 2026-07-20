import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { record } from '../audit/AuditLogService.js';
import type { CreateHolidayInput, SupportedCountryCode } from './schemas.js';
import { loadPreset } from './presets.js';

export interface ApiHoliday {
  id: string;
  date: string;
  name: string;
  countryCode: string | null;
}

const HOLIDAY_SELECT = {
  id: true,
  date: true,
  name: true,
  countryCode: true,
} as const;

function toDateOnly(dateStr: string): Date {
  const parts = dateStr.split('-').map(Number);
  const [y, m, d] = parts as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function fromDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toApi(row: {
  id: string;
  date: Date;
  name: string;
  countryCode: string | null;
}): ApiHoliday {
  return {
    id: row.id,
    date: fromDateOnly(row.date),
    name: row.name,
    countryCode: row.countryCode,
  };
}

export async function listInRange(start: string, end: string): Promise<ApiHoliday[]> {
  const rows = await prisma.holiday.findMany({
    where: {
      date: { gte: toDateOnly(start), lte: toDateOnly(end) },
    },
    orderBy: [{ date: 'asc' }, { countryCode: 'asc' }],
    select: HOLIDAY_SELECT,
  });
  return rows.map(toApi);
}

export async function create(
  input: CreateHolidayInput,
  actor: { id: string },
): Promise<ApiHoliday> {
  const date = toDateOnly(input.date);
  let row: { id: string; date: Date; name: string; countryCode: string | null };
  try {
    row = await prisma.holiday.create({
      data: {
        date,
        name: input.name,
        countryCode: input.countryCode ?? null,
        createdById: actor.id,
      },
      select: HOLIDAY_SELECT,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new HttpError(409, 'CONFLICT', 'A holiday already exists for that date and country.');
    }
    throw err;
  }
  const api = toApi(row);
  await record({
    actorUserId: actor.id,
    action: 'create_holiday',
    entityType: 'holiday',
    entityId: row.id,
    details: { date: api.date, name: api.name, countryCode: api.countryCode },
  });
  return api;
}

export async function remove(id: string, actor: { id: string }): Promise<void> {
  const existing = await prisma.holiday.findUnique({
    where: { id },
    select: HOLIDAY_SELECT,
  });
  if (!existing) {
    throw new HttpError(404, 'NOT_FOUND', 'Holiday not found.');
  }
  await prisma.holiday.delete({ where: { id } });
  await record({
    actorUserId: actor.id,
    action: 'delete_holiday',
    entityType: 'holiday',
    entityId: id,
    details: {
      date: fromDateOnly(existing.date),
      name: existing.name,
      countryCode: existing.countryCode,
    },
  });
}

export interface SeedResult {
  inserted: number;
  skipped: number;
  errors: string[];
}

export async function seedDefaults(
  countryCode: SupportedCountryCode,
  actor: { id: string },
): Promise<SeedResult> {
  const entries = await loadPreset(countryCode);
  const result: SeedResult = { inserted: 0, skipped: 0, errors: [] };
  for (const entry of entries) {
    try {
      await prisma.holiday.create({
        data: {
          date: toDateOnly(entry.date),
          name: entry.name,
          countryCode,
          createdById: actor.id,
        },
        select: { id: true },
      });
      result.inserted += 1;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        result.skipped += 1;
      } else {
        result.errors.push(`${entry.date}: ${(err as Error).message}`);
      }
    }
  }
  await record({
    actorUserId: actor.id,
    action: 'seed_holidays',
    entityType: 'holiday',
    entityId: actor.id,
    details: {
      countryCode,
      inserted: result.inserted,
      skipped: result.skipped,
      errorCount: result.errors.length,
    },
  });
  return result;
}

export async function listAll(): Promise<ApiHoliday[]> {
  const rows = await prisma.holiday.findMany({
    orderBy: [{ date: 'asc' }, { countryCode: 'asc' }],
    select: HOLIDAY_SELECT,
  });
  return rows.map(toApi);
}
