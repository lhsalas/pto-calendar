import type { DayPart, PTORequest, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { canModifyPTO } from '../authorization/AuthorizationService.js';
import { auditEntryFor, record as recordAudit } from '../audit/AuditLogService.js';
import type { AttributedActor } from '../audit/auditContext.js';
import { validatePtoPayload, type ValidatedPto } from './validation.js';
import type { CreatePtoInput } from './schemas.js';

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

/**
 * The authenticated actor becomes the owner, and the create plus its audit row
 * commit together. Audit details carry dates, day part and whether a note was
 * written, never the note text.
 */
export async function createPto(actor: AttributedActor, input: CreatePtoInput): Promise<PublicPto> {
  const validated: ValidatedPto = validatePtoPayload(input);
  const overlap = await findOverlapping(actor.id, validated.startDate, validated.endDate);
  if (overlap) {
    throw new HttpError(
      409,
      'CONFLICT',
      'This PTO overlaps an existing PTO entry for the same user.',
    );
  }
  return prisma.$transaction(async (tx) => {
    const row = await tx.pTORequest.create({
      data: {
        userId: actor.id,
        startDate: toDateOnly(validated.startDate),
        endDate: toDateOnly(validated.endDate),
        dayPart: validated.dayPart,
        note: validated.note,
      },
      select: PUBLIC_PTO_SELECT,
    });
    await recordAudit(
      auditEntryFor(actor, {
        action: 'create_pto',
        entityType: 'pto_request',
        entityId: row.id,
        targetOwnerId: row.userId,
        details: {
          startDate: validated.startDate,
          endDate: validated.endDate,
          dayPart: validated.dayPart,
          noteWritten: validated.note !== null,
        },
      }),
      tx,
    );
    return row;
  });
}

export async function updatePto(
  actor: AttributedActor,
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
  // Capture presence before shared create validation normalizes missing notes to null.
  const noteProvided = Object.hasOwn(input, 'note');
  if (noteProvided && typeof input.note !== 'string') {
    throw new HttpError(400, 'VALIDATION_ERROR', 'note must be a string when provided.');
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
  // The audit row records the change summary but never the note text. Note writes
  // are recorded as a boolean; legacy rows keep whatever they stored historically.
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.pTORequest.update({
      where: { id },
      data: {
        startDate: toDateOnly(validated.startDate),
        endDate: toDateOnly(validated.endDate),
        dayPart: validated.dayPart,
        ...(noteProvided ? { note: validated.note } : {}),
      },
      select: PUBLIC_PTO_SELECT,
    });
    await recordAudit(
      auditEntryFor(actor, {
        action: 'update_pto',
        entityType: 'pto_request',
        entityId: id,
        targetOwnerId: existing.userId,
        details: {
          startDate: validated.startDate,
          endDate: validated.endDate,
          dayPart: validated.dayPart,
          noteWritten: noteProvided,
        },
      }),
      tx,
    );
    return row;
  });
  return updated;
}

/** The delete returns the removed row, so the audit summary describes exactly what was removed. */
export async function deletePto(actor: AttributedActor, id: string): Promise<void> {
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
    const removed = await tx.pTORequest.delete({
      where: { id },
      select: { userId: true, startDate: true, endDate: true, dayPart: true },
    });
    await recordAudit(
      auditEntryFor(actor, {
        action: 'delete_pto',
        entityType: 'pto_request',
        entityId: id,
        targetOwnerId: removed.userId,
        details: {
          startDate: fromDateOnly(removed.startDate),
          endDate: fromDateOnly(removed.endDate),
          dayPart: removed.dayPart,
        },
      }),
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
