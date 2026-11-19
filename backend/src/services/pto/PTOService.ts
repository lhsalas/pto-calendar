import { Prisma } from '@prisma/client';
import type { DayPart, PTORequest } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { canModifyPTO } from '../authorization/AuthorizationService.js';
import { auditEntryFor, record as recordAudit } from '../audit/AuditLogService.js';
import type { AttributedActor } from '../audit/auditContext.js';
import { validatePtoPatch, validatePtoPayload, type ValidatedPto } from './validation.js';
import { staleWrite } from './preconditions.js';
import type { CreatePtoInput, PatchPtoInput } from './schemas.js';

export type PublicPto = Pick<
  PTORequest,
  | 'id'
  | 'userId'
  | 'startDate'
  | 'endDate'
  | 'dayPart'
  | 'note'
  | 'version'
  | 'createdAt'
  | 'updatedAt'
>;

export interface PublicPtoWithUser {
  id: string;
  userId: string;
  startDate: string;
  endDate: string;
  dayPart: DayPart;
  note: string | null;
  version: number;
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
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

const PTO_WITH_USER_SELECT = {
  ...PUBLIC_PTO_SELECT,
  user: { select: { id: true, name: true, colorCode: true } },
} as const;

/**
 * The live row a write is merged against and guarded by. The version is the
 * revision the caller read; every write names it.
 */
interface LivePtoRow {
  id: string;
  userId: string;
  version: number;
  startDate: Date;
  endDate: Date;
  dayPart: DayPart;
  note: string | null;
}

const LIVE_PTO_SELECT = {
  id: true,
  userId: true,
  version: true,
  startDate: true,
  endDate: true,
  dayPart: true,
  note: true,
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

/**
 * A driver failure can carry the note or the statement in its message, so it
 * is never passed on: the cause is dropped and only a plain, retryable error
 * reaches the answer and the log. Every other cause keeps its own handling.
 */
function rethrowSafeDriverFailure(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    logger.error({ errorType: 'pto_write_failed' }, 'PTO write failed');
    throw new HttpError(500, 'INTERNAL_ERROR', 'The PTO entry could not be saved. Try again.');
  }
  throw err;
}

/** The guarded write found no row: the record moved on before the write. */
function isMissingRow(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
}

/**
 * The write must name the revision it read. A mismatch is reported before the
 * payload or the overlap of the stale snapshot is, so a client learns that it
 * has to reload instead of a conflict it cannot act on.
 */
function assertCurrentVersion(current: number, expected: number): void {
  if (current !== expected) staleWrite();
}

export async function findOverlapping(
  userId: string,
  startDate: string,
  endDate: string,
  excludeId?: string,
  client: Prisma.TransactionClient = prisma,
): Promise<PublicPto | null> {
  const where: Prisma.PTORequestWhereInput = {
    userId,
    AND: [{ startDate: { lte: toDateOnly(endDate) } }, { endDate: { gte: toDateOnly(startDate) } }],
  };
  if (excludeId) {
    where.id = { not: excludeId };
  }
  return client.pTORequest.findFirst({ where, select: PUBLIC_PTO_SELECT });
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
    version: row.version,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    user: { id: row.user.id, name: row.user.name, colorCode: row.user.colorCode },
  };
}

/** Reads the live row inside the caller's transaction. */
async function readLiveRow(tx: Prisma.TransactionClient, id: string): Promise<LivePtoRow | null> {
  try {
    return await tx.pTORequest.findUnique({ where: { id }, select: LIVE_PTO_SELECT });
  } catch (err) {
    rethrowSafeDriverFailure(err);
  }
}

/**
 * The live row of a write.
 *
 * The route reads the record and authorizes the caller for it before the
 * transaction starts. When that prior observation exists, a record that
 * disappeared or changed owner in between is a stale write, not a missing
 * record: the caller's version no longer describes the stored record. Without
 * that observation a missing record stays a missing record, and a foreign one
 * stays forbidden.
 */
function assertLiveRecord(
  existing: LivePtoRow | null,
  authorizedOwnerId: string | undefined,
): LivePtoRow {
  if (!existing) {
    if (authorizedOwnerId !== undefined) staleWrite();
    throw new HttpError(404, 'NOT_FOUND', 'PTO entry not found.');
  }
  if (authorizedOwnerId !== undefined && existing.userId !== authorizedOwnerId) {
    staleWrite();
  }
  return existing;
}

/**
 * The write is guarded by the id, the owner and the expected version, so a
 * record that changed in the meantime is never overwritten. The guarded write
 * that finds no row is a lost race, not a success.
 */
async function guardedUpdate(
  tx: Prisma.TransactionClient,
  where: Prisma.PTORequestWhereUniqueInput,
  data: Prisma.PTORequestUpdateInput,
): Promise<PublicPto> {
  try {
    return await tx.pTORequest.update({ where, data, select: PUBLIC_PTO_SELECT });
  } catch (err) {
    if (isMissingRow(err)) staleWrite();
    rethrowSafeDriverFailure(err);
  }
}

/** The delete is guarded the same way: a newer revision is never removed. */
async function guardedDelete(
  tx: Prisma.TransactionClient,
  where: Prisma.PTORequestWhereUniqueInput,
): Promise<{ userId: string; startDate: Date; endDate: Date; dayPart: DayPart }> {
  try {
    return await tx.pTORequest.delete({
      where,
      select: { userId: true, startDate: true, endDate: true, dayPart: true },
    });
  } catch (err) {
    if (isMissingRow(err)) staleWrite();
    rethrowSafeDriverFailure(err);
  }
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
  try {
    return await prisma.$transaction(async (tx) => {
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
  } catch (err) {
    rethrowSafeDriverFailure(err);
  }
}

/**
 * Replaces the record. The write names the revision it read, so a stale
 * snapshot is refused instead of overwriting a newer one, and the guarded
 * update and its audit row commit together.
 *
 * `authorizedOwnerId` is the owner the caller was authorized for in the read
 * that preceded this write. It turns a record that vanished or changed owner
 * in between into a stale write instead of a missing or forbidden record.
 */
export async function updatePto(
  actor: AttributedActor,
  id: string,
  input: CreatePtoInput,
  expectedVersion: number,
  authorizedOwnerId?: string,
): Promise<PublicPto> {
  try {
    return await prisma.$transaction(async (tx) => {
      const existing = assertLiveRecord(await readLiveRow(tx, id), authorizedOwnerId);
      if (!canModifyPTO(actor, existing)) {
        throw new HttpError(403, 'FORBIDDEN', 'You are not allowed to modify this PTO entry.');
      }
      assertCurrentVersion(existing.version, expectedVersion);
      // Capture presence before shared create validation normalizes missing notes to null.
      const noteProvided = Object.hasOwn(input, 'note');
      if (noteProvided && typeof input.note !== 'string') {
        throw new HttpError(400, 'VALIDATION_ERROR', 'note must be a string when provided.');
      }
      const validated = validatePtoPayload(input);
      const overlap = await findOverlapping(
        existing.userId,
        validated.startDate,
        validated.endDate,
        id,
        tx,
      );
      if (overlap) {
        throw new HttpError(
          409,
          'CONFLICT',
          'This PTO overlaps an existing PTO entry for the same user.',
        );
      }
      const updated = await guardedUpdate(
        tx,
        { id, userId: existing.userId, version: expectedVersion },
        {
          startDate: toDateOnly(validated.startDate),
          endDate: toDateOnly(validated.endDate),
          dayPart: validated.dayPart,
          ...(noteProvided ? { note: validated.note } : {}),
          version: { increment: 1 },
        },
      );
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
      return updated;
    });
  } catch (err) {
    rethrowSafeDriverFailure(err);
  }
}

/**
 * Changes only the named fields. Omitted fields keep their stored value, an
 * explicit note clears or sets it, and the merged record is validated with
 * the same rules as a fresh record. The write names the revision it read and
 * is guarded by it, so a stale snapshot is refused instead of overwriting a
 * newer one.
 *
 * `authorizedOwnerId` is the owner the caller was authorized for in the read
 * that preceded this write. It turns a record that vanished or changed owner
 * in between into a stale write instead of a missing or forbidden record.
 */
export async function patchPto(
  actor: AttributedActor,
  id: string,
  patch: PatchPtoInput,
  expectedVersion: number,
  authorizedOwnerId?: string,
): Promise<PublicPto> {
  try {
    return await prisma.$transaction(async (tx) => {
      const existing = assertLiveRecord(await readLiveRow(tx, id), authorizedOwnerId);
      if (!canModifyPTO(actor, existing)) {
        throw new HttpError(403, 'FORBIDDEN', 'You are not allowed to modify this PTO entry.');
      }
      assertCurrentVersion(existing.version, expectedVersion);
      const stored = {
        startDate: fromDateOnly(existing.startDate),
        endDate: fromDateOnly(existing.endDate),
        dayPart: existing.dayPart,
        note: existing.note,
      };
      const validated = validatePtoPatch(patch, stored);
      const overlap = await findOverlapping(
        existing.userId,
        validated.startDate,
        validated.endDate,
        id,
        tx,
      );
      if (overlap) {
        throw new HttpError(
          409,
          'CONFLICT',
          'This PTO overlaps an existing PTO entry for the same user.',
        );
      }
      const noteProvided = Object.hasOwn(patch, 'note');
      const updated = await guardedUpdate(
        tx,
        { id, userId: existing.userId, version: expectedVersion },
        {
          startDate: toDateOnly(validated.startDate),
          endDate: toDateOnly(validated.endDate),
          dayPart: validated.dayPart,
          ...(noteProvided ? { note: validated.note } : {}),
          version: { increment: 1 },
        },
      );
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
      return updated;
    });
  } catch (err) {
    rethrowSafeDriverFailure(err);
  }
}

/**
 * The delete returns the removed row, so the audit summary describes exactly what was removed.
 * The delete names the revision it read, so a newer record is never removed.
 *
 * `authorizedOwnerId` is the owner the caller was authorized for in the read
 * that preceded this write. It turns a record that vanished or changed owner
 * in between into a stale write instead of a missing or forbidden record.
 */
export async function deletePto(
  actor: AttributedActor,
  id: string,
  expectedVersion: number,
  authorizedOwnerId?: string,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const existing = assertLiveRecord(await readLiveRow(tx, id), authorizedOwnerId);
      if (!canModifyPTO(actor, existing)) {
        throw new HttpError(403, 'FORBIDDEN', 'You are not allowed to delete this PTO entry.');
      }
      assertCurrentVersion(existing.version, expectedVersion);
      const removed = await guardedDelete(tx, {
        id,
        userId: existing.userId,
        version: expectedVersion,
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
  } catch (err) {
    rethrowSafeDriverFailure(err);
  }
}

export function toPublicPto(p: PublicPto): {
  id: string;
  userId: string;
  startDate: string;
  endDate: string;
  dayPart: ValidatedPto['dayPart'];
  note: string | null;
  version: number;
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
    version: p.version,
    createdAt: toIso(p.createdAt),
    updatedAt: toIso(p.updatedAt),
  };
}
