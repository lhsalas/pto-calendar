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
import { trustedOperatorActor, type AuditActor } from '../../src/services/audit/auditContext.js';

const url = process.env.DATABASE_URL;
if (!url)
  throw new Error('DATABASE_URL must explicitly identify the disposable integration database');
const db = createPrismaClient(url);
const otherDb = createPrismaClient(url);
const tokens = createTokenDatabase(url);
const otherTokens = createTokenDatabase(url);
const ownerId = randomUUID();
const otherId = randomUUID();

/** Attribution for a verified browser session; never derived from request data. */
function sessionActor(id: string): AuditActor {
  return { id, credential: { type: 'session' }, requestId: 'pat-integration' };
}

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
      // Audit rows reference their actor, so they are removed before the users.
      await db.auditLog.deleteMany({ where: { actorUserId: { in: [ownerId, otherId] } } });
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
        issueToken(i % 2 ? tokens : otherTokens, sessionActor(ownerId), 0, {
          name: `token-${i}`,
        }),
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
    const first = await issueToken(tokens, sessionActor(ownerId), 0, { name: 'first' });
    const id = first.token.id;
    expect(await revokeToken(otherTokens, sessionActor(otherId), id)).toBe(false);
    expect(await revokeToken(tokens, sessionActor(ownerId), id)).toBe(true);
    expect(await revokeToken(otherTokens, sessionActor(ownerId), id)).toBe(true);
    const replacement = await issueToken(otherTokens, sessionActor(ownerId), 0, {
      name: 'replacement',
    });
    expect(await verifyToken(tokens, replacement.rawToken)).not.toBeNull();
    expect(
      (await db.personalAccessToken.findUniqueOrThrow({ where: { id: replacement.token.id } }))
        .lastUsedAt,
    ).not.toBeNull();
    await revokeAllTokens(otherTokens, sessionActor(ownerId));
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
      issued.push(await issueToken(tokens, sessionActor(ownerId), 0, { name: `capacity-${i}` }));
    }
    const past = new Date(Date.now() - 2 * 86400000);
    await db.personalAccessToken.update({
      where: { id: issued[0]!.token.id },
      data: { createdAt: past, expiresAt: new Date(past.getTime() + 86400000) },
    });
    await expect(
      issueToken(otherTokens, sessionActor(ownerId), 0, { name: 'expired replacement' }),
    ).resolves.toBeDefined();
    await revokeAllTokens(tokens, sessionActor(ownerId));
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
    const issued = await issueToken(tokens, sessionActor(ownerId), 0, {
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
    await changeRoleAndInvalidate(tokens, ownerId, 'member', trustedOperatorActor(otherId));
    await changeRoleAndInvalidate(otherTokens, ownerId, 'team_lead', trustedOperatorActor(otherId));
    expect(await verifyToken(tokens, issued.rawToken)).toBeNull();
    await expect(
      issueToken(tokens, sessionActor(ownerId), 0, { name: 'stale caller' }),
    ).rejects.toThrow();
    const current = await db.user.findUniqueOrThrow({
      where: { id: ownerId },
      select: { sessionVersion: true },
    });
    await expect(
      issueToken(otherTokens, sessionActor(ownerId), current.sessionVersion, {
        name: 'new version',
      }),
    ).resolves.toBeDefined();
  });

  it('invalidates old tokens after reset and one-time account setup', async () => {
    const user = await db.user.findUniqueOrThrow({
      where: { id: otherId },
      select: { sessionVersion: true },
    });
    const old = await issueToken(tokens, sessionActor(otherId), user.sessionVersion, {
      name: 'before reset',
    });
    const reset = await resetUserPassword(otherId, sessionActor(otherId));
    expect(await verifyToken(tokens, old.rawToken)).toBeNull();
    await expect(
      issueToken(tokens, sessionActor(otherId), user.sessionVersion, { name: 'stale reset' }),
    ).rejects.toThrow();
    await setupAccount(
      { token: reset.setupToken.plaintext, password: 'test-password' },
      { requestId: 'pat-integration' },
    );
    expect(await verifyToken(otherTokens, old.rawToken)).toBeNull();
    const updated = await db.user.findUniqueOrThrow({
      where: { id: otherId },
      select: { sessionVersion: true },
    });
    expect(updated.sessionVersion).toBe(user.sessionVersion + 2);
    await expect(
      issueToken(tokens, sessionActor(otherId), updated.sessionVersion, { name: 'after setup' }),
    ).resolves.toBeDefined();
  });

  it('does not leave a valid token when issuance races a password reset', async () => {
    const user = await db.user.findUniqueOrThrow({
      where: { id: otherId },
      select: { sessionVersion: true },
    });
    const [issued] = await Promise.allSettled([
      issueToken(otherTokens, sessionActor(otherId), user.sessionVersion, { name: 'racing' }),
      resetUserPassword(otherId, sessionActor(otherId)),
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
      const issued = await issueToken(tokens, sessionActor(ownerId), 0, {
        name: 'UTC',
        expiresInDays: 365,
      });
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

  it('computes the owner-visible status from the row and the live owner', async () => {
    const plain = await issueToken(tokens, sessionActor(ownerId), 0, { name: 'plain' });
    const team = await issueToken(tokens, sessionActor(ownerId), 0, {
      name: 'team',
      scopes: ['pto:update:team'],
    });
    const statusOf = async (id: string): Promise<string | undefined> =>
      (await listTokens(tokens, ownerId)).find((token) => token.id === id)?.status;

    expect(await statusOf(plain.token.id)).toBe('active');
    expect(await statusOf(team.token.id)).toBe('active');

    // A live role that no longer fits the team scopes invalidates that token
    // only; a read-only token of the same owner stays live.
    await db.user.update({ where: { id: ownerId }, data: { role: 'member' } });
    expect(await statusOf(team.token.id)).toBe('invalidated');
    expect(await statusOf(plain.token.id)).toBe('active');
    await db.user.update({ where: { id: ownerId }, data: { role: 'team_lead' } });
    expect(await statusOf(team.token.id)).toBe('active');

    // A reset account has no usable password, so its tokens are invalidated.
    // The token is still unexpired here, so the invalidation is the only
    // reason it is no longer live.
    await db.user.update({ where: { id: ownerId }, data: { passwordHash: null } });
    expect(await statusOf(plain.token.id)).toBe('invalidated');
    await db.user.update({
      where: { id: ownerId },
      data: { passwordHash: 'test-only-hash' },
    });
    expect(await statusOf(plain.token.id)).toBe('active');

    // A changed session version invalidates the credentials of the old session.
    await db.user.update({
      where: { id: ownerId },
      data: { sessionVersion: { increment: 1 } },
    });
    expect(await statusOf(plain.token.id)).toBe('invalidated');
    expect(await statusOf(team.token.id)).toBe('invalidated');
  });

  it('expires at the database clock exactly at the boundary and lets revocation win', async () => {
    const issued = await issueToken(tokens, sessionActor(ownerId), 0, { name: 'expiry' });
    const statusOf = async (): Promise<string | undefined> =>
      (await listTokens(tokens, ownerId)).find((token) => token.id === issued.token.id)?.status;

    expect(await statusOf()).toBe('active');

    // The expiry is read from the database's own UTC wall clock, so a token
    // that ends in the future stays active.
    await db.$executeRaw`
      UPDATE personal_access_tokens
      SET expires_at = (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '1 minute'
      WHERE id = ${issued.token.id}::uuid`;
    expect(await statusOf()).toBe('active');

    // At the boundary the token is expired: now is not before expiresAt. The
    // clamp keeps the stored instant after the creation instant, so the
    // lifetime constraint of the table still holds.
    await db.$executeRaw`
      UPDATE personal_access_tokens
      SET expires_at = GREATEST(
        (clock_timestamp() AT TIME ZONE 'UTC'), created_at + INTERVAL '1 millisecond')
      WHERE id = ${issued.token.id}::uuid`;
    expect(await statusOf()).toBe('expired');

    // Expiry wins over invalidation, and revocation wins over both.
    await db.user.update({
      where: { id: ownerId },
      data: { sessionVersion: { increment: 1 } },
    });
    expect(await statusOf()).toBe('expired');
    expect(await revokeToken(tokens, sessionActor(ownerId), issued.token.id)).toBe(true);
    expect(await statusOf()).toBe('revoked');
  });

  it("lists only the owner's own tokens and never a credential or an owner field", async () => {
    const issued = await issueToken(tokens, sessionActor(ownerId), 0, { name: 'owned' });
    const foreign = await issueToken(otherTokens, sessionActor(otherId), 0, { name: 'foreign' });
    const listed = await listTokens(tokens, ownerId);
    expect(listed.map((token) => token.id)).toEqual([issued.token.id]);
    expect(await listTokens(otherTokens, otherId)).toHaveLength(1);
    expect((await listTokens(tokens, otherId)).map((token) => token.id)).not.toContain(
      issued.token.id,
    );
    // An owner without tokens gets an empty list, never another owner's rows.
    expect(await listTokens(tokens, randomUUID())).toEqual([]);

    const stored = await db.personalAccessToken.findUniqueOrThrow({
      where: { id: issued.token.id },
    });
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain(stored.secretDigest);
    expect(serialized).not.toContain(issued.rawToken);
    expect(serialized).not.toContain(issued.rawToken.split('.')[1]!);
    expect(serialized).not.toContain(ownerId);
    expect(serialized).not.toContain(otherId);
    expect(serialized).not.toContain('test-only-hash');
    for (const token of listed) {
      expect(Object.keys(token).sort()).toEqual([
        'createdAt',
        'displayPrefix',
        'expiresAt',
        'id',
        'lastUsedAt',
        'name',
        'revokedAt',
        'scopes',
        'status',
      ]);
      expect(token.status).toBe('active');
    }
    expect(foreign.token.id).not.toBe(issued.token.id);
  });

  it('rejects verification held behind a row lock until after absolute expiry', async () => {
    const issued = await issueToken(tokens, sessionActor(ownerId), 0, { name: 'Blocked expiry' });
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
