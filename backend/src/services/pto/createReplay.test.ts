import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { HttpError } from '../../middleware/errorHandler.js';
import {
  PTO_REPLAY_CLEANUP_LIMIT,
  cleanupExpiredReplays,
  claimReplay,
  databaseClock,
  fingerprintMatches,
  idempotencyConflict,
  idempotencyExpired,
  keyDigest,
  parseReplayResult,
  payloadFingerprint,
  readReplay,
  signingKeys,
  storeReplayResult,
  type PtoCreateReplayResult,
} from './createReplay.js';
import type { ValidatedPto } from './validation.js';

const VALIDATED: ValidatedPto = {
  startDate: '2026-05-11',
  endDate: '2026-05-11',
  dayPart: 'morning',
  note: 'Doctor',
};

const SNAPSHOT: PtoCreateReplayResult = {
  id: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  startDate: '2026-05-11',
  endDate: '2026-05-11',
  dayPart: 'morning',
  version: 1,
  createdAt: '2026-05-01T10:00:00.000Z',
  updatedAt: '2026-05-01T10:00:00.000Z',
};

function fakeTx(rows: unknown[] = [], affected = 1) {
  const queryRaw = vi.fn(async (_sql: unknown) => rows);
  const executeRaw = vi.fn(async (_sql: unknown) => affected);
  return {
    tx: { $queryRaw: queryRaw, $executeRaw: executeRaw } as unknown as Prisma.TransactionClient,
    queryRaw,
    executeRaw,
  };
}

describe('the create replay helpers', () => {
  it('digests the key instead of storing it', () => {
    const digest = keyDigest('v1.1700000000000.11111111-1111-4111-8111-111111111111');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain('v1.');
    expect(keyDigest('v1.1700000000000.11111111-1111-4111-8111-111111111111')).toBe(digest);
    expect(keyDigest('another key')).not.toBe(digest);
  });

  it('fingerprints the canonical payload under one signing key', () => {
    const fingerprint = payloadFingerprint(VALIDATED, 'signing-key-one');
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(payloadFingerprint(VALIDATED, 'signing-key-one')).toBe(fingerprint);
    expect(payloadFingerprint(VALIDATED, 'signing-key-two')).not.toBe(fingerprint);
    expect(payloadFingerprint({ ...VALIDATED, dayPart: 'evening' }, 'signing-key-one')).not.toBe(
      fingerprint,
    );
    expect(payloadFingerprint({ ...VALIDATED, note: 'Other' }, 'signing-key-one')).not.toBe(
      fingerprint,
    );
  });

  it('verifies a stored fingerprint against the active and the retained keys', () => {
    const active = payloadFingerprint(VALIDATED, 'active-key');
    const retained = payloadFingerprint(VALIDATED, 'retained-key');
    expect(fingerprintMatches(active, VALIDATED, ['active-key'])).toBe(true);
    expect(fingerprintMatches(retained, VALIDATED, ['active-key', 'retained-key'])).toBe(true);
    expect(fingerprintMatches(retained, VALIDATED, ['active-key'])).toBe(false);
    expect(fingerprintMatches('not-a-digest', VALIDATED, ['active-key'])).toBe(false);
    expect(fingerprintMatches('', VALIDATED, ['active-key'])).toBe(false);
    expect(fingerprintMatches(active, { ...VALIDATED, note: 'Other' }, ['active-key'])).toBe(false);
  });

  it('reads the configured signing keys', () => {
    const keys = signingKeys();
    expect(Array.isArray(keys)).toBe(true);
    expect(keys.length).toBeGreaterThan(0);
  });

  it('reads the database clock', async () => {
    const at = new Date('2026-05-11T10:00:00.000Z');
    const { tx } = fakeTx([{ at }]);
    expect(await databaseClock(tx)).toEqual(at);
  });

  it('fails when the database clock is unavailable', async () => {
    const { tx } = fakeTx([]);
    await expect(databaseClock(tx)).rejects.toThrow(/clock/i);
  });

  it('claims a key and reports the claim of the other writer', async () => {
    const { tx } = fakeTx([{ id: 'claimed-id' }]);
    const claim = await claimReplay(tx, {
      ownerId: '22222222-2222-4222-8222-222222222222',
      kind: 'pat',
      credentialId: '33333333-3333-4333-8333-333333333333',
      keyDigest: 'a'.repeat(64),
      fingerprint: 'b'.repeat(64),
      expiresAt: new Date('2026-05-12T10:00:00.000Z'),
    });
    expect(claim.claimed).toBe(true);
    expect(claim.id).toBe('claimed-id');

    const lost = fakeTx([]);
    const other = await claimReplay(lost.tx, {
      ownerId: '22222222-2222-4222-8222-222222222222',
      kind: 'pat',
      credentialId: '33333333-3333-4333-8333-333333333333',
      keyDigest: 'a'.repeat(64),
      fingerprint: 'b'.repeat(64),
      expiresAt: new Date('2026-05-12T10:00:00.000Z'),
    });
    expect(other.claimed).toBe(false);
    expect(other.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reads the stored row of a key', async () => {
    const { tx, queryRaw } = fakeTx([{ payloadFingerprint: 'b'.repeat(64), result: SNAPSHOT }]);
    const stored = await readReplay(tx, {
      ownerId: '22222222-2222-4222-8222-222222222222',
      kind: 'session',
      credentialId: '33333333-3333-4333-8333-333333333333',
      keyDigest: 'a'.repeat(64),
    });
    expect(stored).toEqual({ payloadFingerprint: 'b'.repeat(64), result: SNAPSHOT });
    expect((queryRaw.mock.calls[0]![0] as { text: string }).text).toContain(
      '"payload_fingerprint" AS "payloadFingerprint"',
    );

    const missing = fakeTx([]);
    expect(
      await readReplay(missing.tx, {
        ownerId: '22222222-2222-4222-8222-222222222222',
        kind: 'session',
        credentialId: '33333333-3333-4333-8333-333333333333',
        keyDigest: 'a'.repeat(64),
      }),
    ).toBeNull();
  });

  it('stores the note-free result of a create', async () => {
    const { tx, executeRaw } = fakeTx();
    await storeReplayResult(tx, '44444444-4444-4444-8444-444444444444', SNAPSHOT);
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const sql = executeRaw.mock.calls[0]![0] as unknown as { text: string; values: unknown[] };
    expect(sql.text).toContain('UPDATE');
    expect(sql.text).not.toContain('Doctor');
    expect(JSON.stringify(sql.values)).not.toContain('Doctor');
  });

  it('fails the transaction rather than lose a successful result when storage affects no row', async () => {
    const { tx } = fakeTx([], 0);
    await expect(storeReplayResult(tx, SNAPSHOT.id, SNAPSHOT)).rejects.toThrow(
      'Could not save the create replay result.',
    );
  });

  it('cleans up expired rows in a bounded, skipping selection', async () => {
    const { tx, queryRaw } = fakeTx([{ id: 'expired-id' }]);
    expect(await cleanupExpiredReplays(tx)).toBe(1);
    const sql = queryRaw.mock.calls[0]![0] as unknown as { text: string };
    expect(sql.text).toContain('DELETE FROM');
    expect(sql.text).toContain('SKIP LOCKED');
    expect(sql.text).toContain('statement_timestamp()');
  });

  it('never cleans up more than the bound and does no work without a limit', async () => {
    const bounded = fakeTx([]);
    await cleanupExpiredReplays(bounded.tx, 1000);
    const sql = bounded.queryRaw.mock.calls[0]![0] as unknown as { values: unknown[] };
    expect(sql.values).toContain(PTO_REPLAY_CLEANUP_LIMIT);

    const none = fakeTx([]);
    expect(await cleanupExpiredReplays(none.tx, 0)).toBe(0);
    expect(none.queryRaw).not.toHaveBeenCalled();
  });

  it('reads a stored result back only when its shape is known', () => {
    expect(parseReplayResult(SNAPSHOT)).toEqual(SNAPSHOT);
    expect(parseReplayResult(null)).toBeNull();
    expect(parseReplayResult('a string')).toBeNull();
    expect(parseReplayResult([SNAPSHOT])).toBeNull();
    expect(parseReplayResult({ ...SNAPSHOT, id: 1 })).toBeNull();
    expect(parseReplayResult({ ...SNAPSHOT, userId: undefined })).toBeNull();
    expect(parseReplayResult({ ...SNAPSHOT, startDate: 5 })).toBeNull();
    expect(parseReplayResult({ ...SNAPSHOT, endDate: null })).toBeNull();
    expect(parseReplayResult({ ...SNAPSHOT, dayPart: 'midday' })).toBeNull();
    expect(parseReplayResult({ ...SNAPSHOT, version: 'one' })).toBeNull();
    expect(parseReplayResult({ ...SNAPSHOT, version: 0 })).toBeNull();
    expect(parseReplayResult({ ...SNAPSHOT, createdAt: null })).toBeNull();
    expect(parseReplayResult({ ...SNAPSHOT, updatedAt: 7 })).toBeNull();
  });

  it('answers an expired key and a conflicting key with a fixed conflict', () => {
    for (const [run, code] of [
      [idempotencyExpired, 'IDEMPOTENCY_EXPIRED'],
      [idempotencyConflict, 'IDEMPOTENCY_CONFLICT'],
    ] as const) {
      let caught: unknown;
      try {
        run();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(HttpError);
      expect(caught).toMatchObject({ status: 409, code });
      expect((caught as HttpError).message).not.toMatch(/\d/);
    }
  });
});
