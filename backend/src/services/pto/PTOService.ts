import type { DayPart, PTORequest, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { canModifyPTO, type ActorLike } from '../authorization/AuthorizationService.js';
import { record as recordAudit } from '../audit/AuditLogService.js';
import { validatePtoPayload, type CreatePtoInput, type ValidatedPto } from './validation.js';

export type PublicPto = Pick<
  PTORequest,
  'id' | 'userId' | 'startDate' | 'endDate' | 'dayPart' | 'note' | 'createdAt' | 'updatedAt'
>;

export interface PublicPtoWithUser {
  id: string;
  userId: string;
  startDate: string;
  endDate: string;
  dayPart: DayPart;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  user: { id: string; name: string; colorCode: string };
}

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

const PTO_WITH_USER_SELECT = {
  ...PUBLIC_PTO_SELECT,
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

function toIso(d: Date): string {
  return d.toISOString();
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

export async function getPtoById(id: string): Promise<PublicPtoWithUser | null> {
  const row = await prisma.pTORequest.findUnique({
    where: { id },
    select: PTO_WITH_USER_SELECT,
  });
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    startDate: fromDateOnly(row.startDate),
    endDate: fromDateOnly(row.endDate),
    dayPart: row.dayPart,
    note: row.note,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    user: { id: row.user.id, name: row.user.name, colorCode: row.user.colorCode },
  };
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

export async function updatePto(
  actor: ActorLike,
  id: string,
  input: CreatePtoInput,
): Promise<PublicPto> {
  const existing = await prisma.pTORequest.findUnique({
    where: { id },
    select: { id: true, userId: true },
  });
  if (!existing) {
    throw new HttpError(404, 'NOT_FOUND', 'PTO entry not found.');
  }
  if (!canModifyPTO(actor, existing)) {
    throw new HttpError(403, 'FORBIDDEN', 'You are not allowed to modify this PTO entry.');
  }
  const validated: ValidatedPto = validatePtoPayload(input);
  const overlap = await findOverlapping(
    existing.userId,
    validated.startDate,
    validated.endDate,
    id,
  );
  if (overlap) {
    throw new HttpError(
      409,
      'CONFLICT',
      'This PTO overlaps an existing PTO entry for the same user.',
    );
  }
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.pTORequest.update({
      where: { id },
      data: {
        startDate: toDateOnly(validated.startDate),
        endDate: toDateOnly(validated.endDate),
        dayPart: validated.dayPart,
        note: validated.note,
      },
      select: PUBLIC_PTO_SELECT,
    });
    await recordAudit(
      {
        actorUserId: actor.id,
        action: 'update_pto',
        entityType: 'pto_request',
        entityId: id,
        details: {
          startDate: validated.startDate,
          endDate: validated.endDate,
          dayPart: validated.dayPart,
          note: validated.note,
        },
      },
      tx,
    );
    return row;
  });
  return updated;
}

export async function deletePto(actor: ActorLike, id: string): Promise<void> {
  const existing = await prisma.pTORequest.findUnique({
    where: { id },
    select: { id: true, userId: true },
  });
  if (!existing) {
    throw new HttpError(404, 'NOT_FOUND', 'PTO entry not found.');
  }
  if (!canModifyPTO(actor, existing)) {
    throw new HttpError(403, 'FORBIDDEN', 'You are not allowed to delete this PTO entry.');
  }
  await prisma.$transaction(async (tx) => {
    await tx.pTORequest.delete({ where: { id } });
    await recordAudit(
      {
        actorUserId: actor.id,
        action: 'delete_pto',
        entityType: 'pto_request',
        entityId: id,
      },
      tx,
    );
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
    createdAt: toIso(p.createdAt),
    updatedAt: toIso(p.updatedAt),
  };
}
