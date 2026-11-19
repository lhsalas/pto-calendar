import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { loadEnv } from '../../config/env.js';
import { HttpError } from '../../middleware/errorHandler.js';
import type { DayPart, ValidatedPto } from './validation.js';

/**
 * The key has expired. The answer never names the key, the stored row or the
 * payload.
 */
export function idempotencyExpired(): never {
  throw new HttpError(
    409,
    'IDEMPOTENCY_EXPIRED',
    'This idempotency key has expired. Reconcile the previous result before starting another create.',
  );
}

/**
 * The key was already used for a different request, or its fingerprint can no
 * longer be verified. Both are a conflict: nothing is written and nothing is
 * replayed.
 */
export function idempotencyConflict(): never {
  throw new HttpError(
    409,
    'IDEMPOTENCY_CONFLICT',
    'This idempotency key was already used for a different request.',
  );
}

/**
 * The note-free snapshot of a created PTO row. The stored result holds the
 * identity, the dates, the day part and the version of the row, never the
 * note and never anything private.
 */
export interface PtoCreateReplayResult {
  id: string;
  userId: string;
  startDate: string;
  endDate: string;
  dayPart: DayPart;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** One stored replay row, read back from the database. */
export interface StoredPtoReplay {
  payloadFingerprint: string;
  result: unknown;
}

/** The scope a key belongs to: the owner, the credential and the key itself. */
export interface PtoReplayScope {
  ownerId: string;
  kind: 'pat' | 'session';
  credentialId: string;
  keyDigest: string;
}

/**
 * The table is addressed by a fixed, quoted name. It is never built from
 * request data, and every value that reaches the database is a bound
 * parameter.
 */
const REPLAY_TABLE = '"public"."pto_create_replays"';

/** One cleanup call removes at most this many expired rows. */
export const PTO_REPLAY_CLEANUP_LIMIT = 100;

/**
 * The SHA-256 digest of the canonical key. The key itself is never stored, so
 * a replay row cannot be used to recover it.
 */
export function keyDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * The canonical, versioned field order of a create payload. It is built from
 * the validated and normalized payload, so two requests that mean the same
 * thing produce the same fingerprint.
 */
function canonicalPayload(validated: ValidatedPto): string {
  return [
    'pto:create-replay:v1',
    validated.startDate,
    validated.endDate,
    validated.dayPart,
    validated.note ?? '',
  ].join('\n');
}

/**
 * The HMAC of the canonical payload under one signing key. The payload holds
 * the note, so it is keyed and never stored in the clear.
 */
export function payloadFingerprint(validated: ValidatedPto, key: string): string {
  return createHmac('sha256', key).update(canonicalPayload(validated), 'utf8').digest('hex');
}

/** Compares two digests without leaking their contents through timing. */
function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Verifies a stored fingerprint against the configured signing keys: the
 * active key first, then the retained keys of a rotation. A key that was
 * rotated away simply does not verify, and the caller then answers with a
 * conflict instead of a replay.
 */
export function fingerprintMatches(
  stored: string,
  validated: ValidatedPto,
  keys: readonly string[],
): boolean {
  for (const key of keys) {
    if (constantTimeEquals(payloadFingerprint(validated, key), stored)) return true;
  }
  return false;
}

/** The configured signing keys: the active one first, then the retained ones. */
export function signingKeys(): readonly string[] {
  return loadEnv().SESSION_SECRET;
}

/** The database clock. Every expiry decision uses it, never the process clock. */
export async function databaseClock(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<{ at: Date }[]>(Prisma.sql`
    SELECT clock_timestamp() AS at
  `);
  const at = rows[0]?.at;
  if (!(at instanceof Date)) throw new Error('The database clock is unavailable.');
  return at;
}

/**
 * Claims the key for this scope. The row is created empty; the result is
 * stored in the same transaction once the entry exists. The insert waits for
 * a concurrent claim of the same key and then does nothing, so the caller
 * learns that the key is taken without writing anything.
 */
export async function claimReplay(
  tx: Prisma.TransactionClient,
  claim: PtoReplayScope & { fingerprint: string; expiresAt: Date },
): Promise<{ claimed: boolean; id: string }> {
  const id = randomUUID();
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO ${Prisma.raw(REPLAY_TABLE)}
      ("id", "owner_id", "credential_kind", "credential_id", "key_digest", "payload_fingerprint", "expires_at")
    VALUES (
      ${id}::uuid,
      ${claim.ownerId}::uuid,
      ${claim.kind},
      ${claim.credentialId}::uuid,
      ${claim.keyDigest},
      ${claim.fingerprint},
      ${claim.expiresAt}
    )
    ON CONFLICT ("owner_id", "credential_kind", "credential_id", "key_digest") DO NOTHING
    RETURNING "id"
  `);
  return { claimed: rows.length === 1, id: rows[0]?.id ?? id };
}

/**
 * Reads the stored row of a key. It is a separate statement on purpose: a
 * read in the same statement as the claim would use the snapshot from before
 * the wait and could not see the row the other writer committed.
 */
export async function readReplay(
  tx: Prisma.TransactionClient,
  scope: PtoReplayScope,
): Promise<StoredPtoReplay | null> {
  const rows = await tx.$queryRaw<{ payloadFingerprint: string; result: unknown }[]>(Prisma.sql`
    SELECT "payload_fingerprint" AS "payloadFingerprint", "result"
    FROM ${Prisma.raw(REPLAY_TABLE)}
    WHERE "owner_id" = ${scope.ownerId}::uuid
      AND "credential_kind" = ${scope.kind}
      AND "credential_id" = ${scope.credentialId}::uuid
      AND "key_digest" = ${scope.keyDigest}
  `);
  const row = rows[0];
  if (!row) return null;
  return { payloadFingerprint: row.payloadFingerprint, result: row.result };
}

/** Stores the note-free result of a successful create. */
export async function storeReplayResult(
  tx: Prisma.TransactionClient,
  id: string,
  result: PtoCreateReplayResult,
): Promise<void> {
  const count = await tx.$executeRaw(Prisma.sql`
    UPDATE ${Prisma.raw(REPLAY_TABLE)}
    SET "result" = ${JSON.stringify(result)}::jsonb
    WHERE "id" = ${id}::uuid
  `);
  if (count !== 1) throw new Error('Could not save the create replay result.');
}

/**
 * Removes expired rows. The selection is bounded and ordered by the indexed
 * expiry, and it skips rows another cleanup or writer holds, so no caller
 * waits for a long global hold.
 */
export async function cleanupExpiredReplays(
  tx: Prisma.TransactionClient,
  limit: number = PTO_REPLAY_CLEANUP_LIMIT,
): Promise<number> {
  const bounded = Math.min(Math.max(Math.trunc(limit), 0), PTO_REPLAY_CLEANUP_LIMIT);
  if (bounded === 0) return 0;
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    DELETE FROM ${Prisma.raw(REPLAY_TABLE)}
    WHERE "id" IN (
      SELECT "id" FROM ${Prisma.raw(REPLAY_TABLE)}
      WHERE "expires_at" <= statement_timestamp()
      ORDER BY "expires_at"
      LIMIT ${bounded}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id"
  `);
  return rows.length;
}

/**
 * Reads a stored result back. The stored JSON is data, so its shape is
 * checked before any of it is used; anything unexpected is refused instead
 * of being spread into an answer.
 */
export function parseReplayResult(value: unknown): PtoCreateReplayResult | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = row['id'];
  const userId = row['userId'];
  const startDate = row['startDate'];
  const endDate = row['endDate'];
  const dayPart = row['dayPart'];
  const version = row['version'];
  const createdAt = row['createdAt'];
  const updatedAt = row['updatedAt'];
  if (typeof id !== 'string' || typeof userId !== 'string') return null;
  if (typeof startDate !== 'string' || typeof endDate !== 'string') return null;
  if (dayPart !== 'morning' && dayPart !== 'evening' && dayPart !== 'all_day') return null;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return null;
  if (typeof createdAt !== 'string' || typeof updatedAt !== 'string') return null;
  return { id, userId, startDate, endDate, dayPart, version, createdAt, updatedAt };
}
