import type { DayPart, PTORequest, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

export interface PTOWithUser {
  id: string;
  user: { id: string; name: string; colorCode: string };
  startDate: string;
  endDate: string;
  dayPart: DayPart;
  note: string | null;
}

const PTO_LIST_SELECT = {
  id: true,
  startDate: true,
  endDate: true,
  dayPart: true,
  note: true,
  user: { select: { id: true, name: true, colorCode: true } },
} as const;

function toDateOnly(dateStr: string): Date {
  const parts = dateStr.split('-').map(Number);
  const [y, m, d] = parts as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function fromDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function listVisibleRange(start: string, end: string): Promise<PTOWithUser[]> {
  const where: Prisma.PTORequestWhereInput = {
    AND: [{ startDate: { lte: toDateOnly(end) } }, { endDate: { gte: toDateOnly(start) } }],
  };
  const rows = await prisma.pTORequest.findMany({
    where,
    orderBy: [{ startDate: 'asc' }, { userId: 'asc' }],
    select: PTO_LIST_SELECT,
  });
  return rows.map((r) => ({
    id: r.id,
    user: { id: r.user.id, name: r.user.name, colorCode: r.user.colorCode },
    startDate: fromDateOnly(r.startDate),
    endDate: fromDateOnly(r.endDate),
    dayPart: r.dayPart,
    note: null,
  }));
}

export type { PTORequest };
