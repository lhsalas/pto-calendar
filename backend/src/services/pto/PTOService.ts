import type { PTORequest, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { validatePtoPayload, type CreatePtoInput, type ValidatedPto } from './validation.js';

export type PublicPto = Pick<
  PTORequest,
  'id' | 'userId' | 'startDate' | 'endDate' | 'dayPart' | 'note' | 'createdAt' | 'updatedAt'
>;

const PUBLIC_PTO_SELECT = {
  id: true,
  userId: true,
  startDate: true,
  endDate: true,
  dayPart: true,
  note: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toDateOnly(dateStr: string): Date {
  const parts = dateStr.split('-').map(Number);
  const [y, m, d] = parts as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function fromDateOnly(d: Date): string {
  const iso = d.toISOString().slice(0, 10);
  return iso;
}

export async function findOverlapping(
  userId: string,
  startDate: string,
  endDate: string,
  excludeId?: string,
): Promise<PublicPto | null> {
  const where: Prisma.PTORequestWhereInput = {
    userId,
    AND: [{ startDate: { lte: toDateOnly(endDate) } }, { endDate: { gte: toDateOnly(startDate) } }],
  };
  if (excludeId) {
    where.id = { not: excludeId };
  }
  return prisma.pTORequest.findFirst({ where, select: PUBLIC_PTO_SELECT });
}

export async function createPto(userId: string, input: CreatePtoInput): Promise<PublicPto> {
  const validated: ValidatedPto = validatePtoPayload(input);
  const overlap = await findOverlapping(userId, validated.startDate, validated.endDate);
  if (overlap) {
    throw new HttpError(
      409,
      'CONFLICT',
      'This PTO overlaps an existing PTO entry for the same user.',
    );
  }
  return prisma.pTORequest.create({
    data: {
      userId,
      startDate: toDateOnly(validated.startDate),
      endDate: toDateOnly(validated.endDate),
      dayPart: validated.dayPart,
      note: validated.note,
    },
    select: PUBLIC_PTO_SELECT,
  });
}

export function toPublicPto(p: PublicPto): {
  id: string;
  userId: string;
  startDate: string;
  endDate: string;
  dayPart: ValidatedPto['dayPart'];
  note: string | null;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: p.id,
    userId: p.userId,
    startDate: fromDateOnly(p.startDate),
    endDate: fromDateOnly(p.endDate),
    dayPart: p.dayPart,
    note: p.note,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}
