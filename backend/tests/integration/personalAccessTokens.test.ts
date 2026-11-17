import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaClient } from '../../src/lib/prismaClient.js';
import { prisma as appPrisma } from '../../src/lib/prisma.js';
import { resetUserPassword, setupAccount } from '../../src/services/users/UserService.js';
import { createTokenDatabase } from '../../src/services/tokens/tokenDatabase.js';
import {
  changeRoleAndInvalidate,
  issueToken,
  listTokens,
  revokeAllTokens,
  revokeToken,
  verifyToken,
} from '../../src/services/tokens/tokenService.js';

const url = process.env.DATABASE_URL;
if (!url)
  throw new Error('DATABASE_URL must explicitly identify the disposable integration database');
const db = createPrismaClient(url);
const otherDb = createPrismaClient(url);
const tokens = createTokenDatabase(url);
const otherTokens = createTokenDatabase(url);
const ownerId = randomUUID();
const otherId = randomUUID();

describe('personal access tokens on PostgreSQL', () => {
  beforeAll(async () => {
    await db.user.createMany({
      data: [ownerId, otherId].map((id) => ({
        id,
        email: `pat-${id}@example.test`,
        name: 'PAT integration user',
        role: 'team_lead' as const,
        colorCode: '#123456',
        passwordHash: 'test-only-hash',
      })),
    });
  });

  beforeEach(async () => {
    await db.personalAccessToken.deleteMany({ where: { ownerId: { in: [ownerId, otherId] } } });
    await db.user.updateMany({
      where: { id: { in: [ownerId, otherId] } },
      data: {
        role: 'team_lead',
        passwordHash: 'test-only-hash',
        sessionVersion: 0,
        setupTokenHash: null,
        setupTokenExpiresAt: null,
      },
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    try {
      await db.personalAccessToken.deleteMany({ where: { ownerId: { in: [ownerId, otherId] } } });
      await db.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
    } finally {
      await Promise.all([
        tokens.close(),
        otherTokens.close(),
        db.$disconnect(),
        otherDb.$disconnect(),
        appPrisma.$disconnect(),
      ]);
    }
  });

  it('serializes simultaneous issuance to ten active tokens and keeps storage secret-free', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 11 }, (_, i) =>
        issueToken(i % 2 ? tokens : otherTokens, ownerId, 0, { name: `token-${i}` }),
      ),
    );
    const successful = results.filter((r) => r.status === 'fulfilled');
    expect(successful).toHaveLength(10);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const first = successful[0];
    if (!first || first.status !== 'fulfilled') throw new Error('Missing issued token');
    const row = await db.personalAccessToken.findUniqueOrThrow({
      where: { id: first.value.token.id },
    });
    const secret = first.value.rawToken.split('.')[1]!;
    expect(JSON.stringify(row)).not.toContain(first.value.rawToken);
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(JSON.stringify(first.value.token)).not.toContain(row.secretDigest);
    expect(JSON.stringify(first.value.token)).not.toContain(secret);
    expect(await listTokens(otherTokens, ownerId)).toHaveLength(10);
  });

  it('isolates owners and immediately applies revoke-one and revoke-all', async () => {
    const first = await issueToken(tokens, ownerId, 0, { name: 'first' });
    const id = first.token.id;
    expect(await revokeToken(otherTokens, otherId, id)).toBe(false);
    expect(await revokeToken(tokens, ownerId, id)).toBe(true);
    expect(await revokeToken(otherTokens, ownerId, id)).toBe(true);
    const replacement = await issueToken(otherTokens, ownerId, 0, { name: 'replacement' });
    expect(await verifyToken(tokens, replacement.rawToken)).not.toBeNull();
    expect(
      (await db.personalAccessToken.findUniqueOrThrow({ where: { id: replacement.token.id } }))
        .lastUsedAt,
    ).not.toBeNull();
    await revokeAllTokens(otherTokens, ownerId);
    expect(await verifyToken(tokens, replacement.rawToken)).toBeNull();
    expect(await listTokens(tokens, otherId)).toEqual([]);
  });

  it('has the owner/creation index and reuses capacity after an expiration', async () => {
    const indexes = await db.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'personal_access_tokens'
    `;
    expect(indexes.map((row) => row.indexname)).toContain(
      'personal_access_tokens_owner_id_created_at_idx',
    );
    const issued = [];
    for (let i = 0; i < 10; i += 1) {
      issued.push(await issueToken(tokens, ownerId, 0, { name: `capacity-${i}` }));
    }
    const past = new Date(Date.now() - 2 * 86400000);
    await db.personalAccessToken.update({
      where: { id: issued[0]!.token.id },
      data: { createdAt: past, expiresAt: new Date(past.getTime() + 86400000) },
    });
    await expect(
      issueToken(otherTokens, ownerId, 0, { name: 'expired replacement' }),
    ).resolves.toBeDefined();
    await revokeAllTokens(tokens, ownerId);
  });

  it('rejects out-of-bounds lifetime and invalid scopes at the database boundary', async () => {
    const id = randomUUID();
    const createdAt = new Date();
    const data = {
      id,
      ownerId,
      name: 'constraint check',
      displayPrefix: `pto_pat_${id}`,
      secretDigest: 'a'.repeat(64),
      scopes: ['pto:read'],
      issuedSessionVersion: 0,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 366 * 86400000),
    };
    await expect(db.personalAccessToken.create({ data })).rejects.toThrow();
    await expect(
      db.personalAccessToken.create({
        data: {
          ...data,
          expiresAt: new Date(createdAt.getTime() + 86400000),
          scopes: ['pto:notes:read'],
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects exactly at expiration and reuses capacity after version changes', async () => {
    const issued = await issueToken(tokens, ownerId, 0, {
      name: 'expiry',
      expiresInDays: 1,
      scopes: ['pto:update:team'],
    });
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(issued.token.expiresAt.getTime());
    try {
      expect(await verifyToken(otherTokens, issued.rawToken)).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
    await changeRoleAndInvalidate(tokens, ownerId, 'member');
    await changeRoleAndInvalidate(otherTokens, ownerId, 'team_lead');
    expect(await verifyToken(tokens, issued.rawToken)).toBeNull();
    await expect(issueToken(tokens, ownerId, 0, { name: 'stale caller' })).rejects.toThrow();
    const current = await db.user.findUniqueOrThrow({
      where: { id: ownerId },
      select: { sessionVersion: true },
    });
    await expect(
      issueToken(otherTokens, ownerId, current.sessionVersion, { name: 'new version' }),
    ).resolves.toBeDefined();
  });

  it('invalidates old tokens after reset and one-time account setup', async () => {
    const user = await db.user.findUniqueOrThrow({
      where: { id: otherId },
      select: { sessionVersion: true },
    });
    const old = await issueToken(tokens, otherId, user.sessionVersion, { name: 'before reset' });
    const reset = await resetUserPassword(otherId);
    expect(await verifyToken(tokens, old.rawToken)).toBeNull();
    await expect(
      issueToken(tokens, otherId, user.sessionVersion, { name: 'stale reset' }),
    ).rejects.toThrow();
    await setupAccount({ token: reset.setupToken.plaintext, password: 'test-password' });
    expect(await verifyToken(otherTokens, old.rawToken)).toBeNull();
    const updated = await db.user.findUniqueOrThrow({
      where: { id: otherId },
      select: { sessionVersion: true },
    });
    expect(updated.sessionVersion).toBe(user.sessionVersion + 2);
    await expect(
      issueToken(tokens, otherId, updated.sessionVersion, { name: 'after setup' }),
    ).resolves.toBeDefined();
  });

  it('does not leave a valid token when issuance races a password reset', async () => {
    const user = await db.user.findUniqueOrThrow({
      where: { id: otherId },
      select: { sessionVersion: true },
    });
    const [issued] = await Promise.allSettled([
      issueToken(otherTokens, otherId, user.sessionVersion, { name: 'racing' }),
      resetUserPassword(otherId),
    ]);
    if (issued.status === 'fulfilled') {
      expect(await verifyToken(tokens, issued.value.rawToken)).toBeNull();
    }
    const current = await db.user.findUniqueOrThrow({
      where: { id: otherId },
      select: { sessionVersion: true, passwordHash: true },
    });
    expect(current.sessionVersion).toBe(user.sessionVersion + 1);
    expect(current.passwordHash).toBeNull();
  });

  it('round-trips UTC timestamps across process timezones without extending the hard lifetime', async () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'Pacific/Honolulu';
      const before = Date.now();
      const issued = await issueToken(tokens, ownerId, 0, { name: 'UTC', expiresInDays: 365 });
      const after = Date.now();
      expect(issued.token.createdAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(issued.token.createdAt.getTime()).toBeLessThanOrEqual(after);
      expect(issued.token.expiresAt.getTime() - issued.token.createdAt.getTime()).toBe(
        365 * 86400000,
      );
      process.env.TZ = 'Asia/Kolkata';
      const listed = (await listTokens(otherTokens, ownerId))[0]!;
      expect(listed.createdAt.toISOString()).toBe(issued.token.createdAt.toISOString());
      expect(listed.expiresAt.toISOString()).toBe(issued.token.expiresAt.toISOString());
      expect(await verifyToken(otherTokens, issued.rawToken)).not.toBeNull();
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('rejects verification held behind a row lock until after absolute expiry', async () => {
    const issued = await issueToken(tokens, ownerId, 0, { name: 'Blocked expiry' });
    await db.personalAccessToken.update({
      where: { id: issued.token.id },
      data: {
        createdAt: new Date(Date.now() - 86400000),
        expiresAt: new Date(Date.now() + 3000),
      },
    });
    let unlock!: () => void;
    let publishLock!: (pid: number) => void;
    let rejectLock!: (error: unknown) => void;
    const released = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const acquired = new Promise<number>((resolve, reject) => {
      publishLock = resolve;
      rejectLock = reject;
    });
    const holder = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM personal_access_tokens WHERE id = ${issued.token.id}::uuid FOR UPDATE`;
        const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        publishLock(row!.pid);
        await released;
      },
      { timeout: 10000 },
    );
    void holder.catch(rejectLock);
    let finished: Promise<unknown> = Promise.resolve();
    try {
      const pid = await acquired;
      const verification = verifyToken(otherTokens, issued.rawToken).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      finished = verification;
      await vi.waitFor(
        async () => {
          const blocked = await db.$queryRaw<{ pid: number }[]>`
          SELECT pid FROM pg_stat_activity
          WHERE ${pid}::int = ANY(pg_blocking_pids(pid))
            AND query LIKE '%last_used_at%'
        `;
          expect(blocked).toHaveLength(1);
        },
        { timeout: 2000, interval: 20 },
      );
      // Synchronize on the actual database deadline, not a fixed sleep.
      await vi.waitFor(
        async () => {
          const [row] = await db.$queryRaw<{ expired: boolean }[]>`
          SELECT expires_at <= (clock_timestamp() AT TIME ZONE 'UTC') AS expired
          FROM personal_access_tokens WHERE id = ${issued.token.id}::uuid
        `;
          expect(row?.expired).toBe(true);
        },
        { timeout: 5000, interval: 20 },
      );
      unlock();
      await holder;
      const outcome = await verification;
      if (!outcome.ok) throw outcome.error;
      expect(outcome.value).toBeNull();
    } finally {
      unlock();
      await holder;
      await finished;
    }
  });
});
