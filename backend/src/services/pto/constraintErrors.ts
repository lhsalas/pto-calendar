import { Prisma } from '@prisma/client';
import { HttpError } from '../../middleware/errorHandler.js';

/**
 * The exclusion constraint that keeps one owner's PTO ranges apart. The
 * database refuses a second overlapping range for the same owner even when two
 * writers pass the friendly preflight at the same time.
 */
export const PTO_OVERLAP_CONSTRAINT = 'pto_requests_no_owner_overlap';

/** The SQLSTATE of a PostgreSQL exclusion-constraint violation. */
export const EXCLUSION_VIOLATION_SQLSTATE = '23P01';

/**
 * The pinned adapter preserves SQLSTATE and the primary message, but not the
 * structured constraint name. Match the entire error from the OCI database's
 * English message locale; do not inspect or return the row detail.
 */
const EXCLUSION_MESSAGE = `conflicting key value violates exclusion constraint "${PTO_OVERLAP_CONSTRAINT}"`;

/** The friendly answer for an overlap, shared by the preflight and the guard. */
export function ownerOverlapConflict(): never {
  throw new HttpError(
    409,
    'CONFLICT',
    'This PTO overlaps an existing PTO entry for the same user.',
  );
}

/** The parts of the driver error this mapping reads. */
interface AdapterCause {
  kind?: unknown;
  originalCode?: unknown;
  originalMessage?: unknown;
}

/**
 * The cause the driver adapter reports for a failed statement. The adapter
 * keeps the SQLSTATE and the PostgreSQL message there; the row detail it also
 * carries is never read.
 */
function driverAdapterCause(err: unknown): AdapterCause | undefined {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2039') {
    return undefined;
  }
  const meta = err.meta;
  if (typeof meta !== 'object' || meta === null) return undefined;
  const adapterError = (meta as { driverAdapterError?: unknown }).driverAdapterError;
  if (typeof adapterError !== 'object' || adapterError === null) return undefined;
  const cause = (adapterError as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) return undefined;
  return cause as AdapterCause;
}

/**
 * True only for the exclusion constraint of this application: the SQLSTATE of
 * an exclusion violation and the exact constraint name in the PostgreSQL
 * message. Every other failure, including a different constraint and a
 * different SQLSTATE, is left alone.
 */
export function isOwnerOverlapViolation(err: unknown): boolean {
  const cause = driverAdapterCause(err);
  return (
    cause?.kind === 'postgres' &&
    cause.originalCode === EXCLUSION_VIOLATION_SQLSTATE &&
    cause.originalMessage === EXCLUSION_MESSAGE
  );
}

/**
 * Prisma maps PostgreSQL serialization failures and deadlocks to P2034.
 * An exclusion check can participate in a deadlock when both writers reach
 * the index at once. Do not claim a specific overlap or retry the write.
 */
export function throwIfPtoWriteConflict(err: unknown): void {
  if (isOwnerOverlapViolation(err)) ownerOverlapConflict();
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
    throw new HttpError(409, 'CONFLICT', 'A concurrent write prevented this PTO change.');
  }
}
