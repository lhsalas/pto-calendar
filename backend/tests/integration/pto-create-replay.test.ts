import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvForTests } from '../../src/config/env.js';
import { prisma } from '../../src/lib/prisma.js';
import { createPrismaClient } from '../../src/lib/prismaClient.js';
import { __resetAgentQuotaForTests } from '../../src/middleware/agentQuota.js';
import { __resetAuthUserCacheForTests } from '../../src/middleware/requireAuth.js';
import { createApp, type ManagedApp } from '../../src/server.js';
import { createTokenDatabase } from '../../src/services/tokens/tokenDatabase.js';
import { issueToken, revokeToken } from '../../src/services/tokens/tokenService.js';
import { clearFixtureCreateKeys, ptoCreateKey } from '../helpers/ptoCreateKey.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Explicit disposable PostgreSQL DATABASE_URL is required');
const target = new URL(url);
if (
  !['postgresql:', 'postgres:'].includes(target.protocol) ||
  !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
  target.pathname !== '/pto_test' ||
  [...target.searchParams].some(([key, value]) => key !== 'schema' || value !== 'public')
) {
  throw new Error('Replay integration tests require disposable loopback pto_test');
}
const db = createPrismaClient(url);
const tokens = createTokenDatabase(url);
const password = 'disposable-replay-fixture-password';
const note = 'private synthetic replay note';
const users = ['Replay owner', 'Independent owner'].map((name) => {
  const id = randomUUID();
  return {
    id,
    name,
    email: `replay-${id}@example.invalid`,
    role: 'member' as const,
    colorCode: '#146487',
    passwordHash: bcrypt.hashSync(password, 4),
  };
});
const [owner, other] = [users[0]!, users[1]!];
const ids = [owner.id, other.id];
const body = { startDate: '2026-11-20', endDate: '2026-11-20', dayPart: 'morning', note };
const dayMs = 86_400_000;
const replayHeader = 'idempotency-replayed';
const expiryHeader = 'idempotency-key-expires-at';
let app: ManagedApp;

async function session(user = owner) {
  const agent = request.agent(app);
  await agent.post('/auth/login').send({ email: user.email, password }).expect(200);
  return agent;
}

function auditActor(userId: string) {
  return { id: userId, credential: { type: 'session' as const }, requestId: 'replay-fixture' };
}

async function mint(userId = owner.id, notes = false) {
  return issueToken(tokens, auditActor(userId), 0, {
    name: 'Synthetic create replay test',
    scopes: notes ? ['pto:create', 'pto:read', 'pto:notes:read'] : ['pto:create', 'pto:read'],
  });
}

function post(token: string, key: string) {
  return request(app)
    .post('/pto')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key);
}

function eligibleAudit() {
  return db.auditLog.findMany({
    where: { actorUserId: owner.id, entityType: 'pto_request', action: 'create_pto' },
  });
}

function digest(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function expires(key: string): Date {
  return new Date(Number(key.split('.')[1]) + dayMs);
}

function latch<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function waitingForClaim(pid: number) {
  await vi.waitFor(
    async () => {
      const [row] = await db.$queryRaw<{ waiting: boolean }[]>`
        SELECT EXISTS (
          SELECT FROM pg_stat_activity
          WHERE datname=current_database()
            AND wait_event_type='Lock' AND state='active'
            AND query LIKE '%pto_create_replays%'
            AND ${pid}::integer = ANY(pg_blocking_pids(pid))
        ) AS waiting
      `;
      expect(row?.waiting).toBe(true);
    },
    { timeout: 3500, interval: 20 },
  );
}

/** Pause the first actual application transaction after claim/write/audit. */
async function contend(
  first: () => Promise<request.Response>,
  second: () => Promise<request.Response>,
  rollback: boolean,
) {
  const held = latch<number>();
  const proceed = latch<void>();
  const transact = prisma.$transaction.bind(prisma);
  const spy = vi.spyOn(prisma, '$transaction').mockImplementationOnce((async (
    op: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) =>
    transact(
      async (tx) => {
        const result = await op(tx);
        const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        held.release(row!.pid);
        await proceed.promise;
        if (rollback) throw new Error('synthetic rollback after provisional PTO/audit');
        return result;
      },
      { timeout: 10_000 },
    )) as never);
  const winner = first();
  let contender: Promise<request.Response> | undefined;
  try {
    const pid = await Promise.race([
      held.promise,
      winner.then((response) => {
        throw new Error(`First create completed before barrier (${response.status})`);
      }),
    ]);
    contender = second();
    void contender.catch(() => undefined);
    await waitingForClaim(pid);
  } finally {
    proceed.release(undefined);
    spy.mockRestore();
    await Promise.allSettled([winner, contender]);
  }
  return await Promise.all([winner, contender!]);
}

async function clearFixtures() {
  await clearFixtureCreateKeys(db, ids);
  await db.auditLog.deleteMany({ where: { actorUserId: { in: ids } } });
  await db.pTORequest.deleteMany({ where: { userId: { in: ids } } });
  await db.personalAccessToken.deleteMany({ where: { ownerId: { in: ids } } });
}

describe('persistent create replay on PostgreSQL', () => {
  const originalEnv = { ...process.env };
  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      SESSION_SECRET: 'synthetic-disposable-session-signing-secret-replay-258',
      PAT_AUTH_ENABLED: 'true',
      PAT_WRITES_ENABLED: 'true',
      COOKIE_SECURE: 'false',
      CORS_ORIGIN: 'http://localhost:5173',
    });
    resetEnvForTests();
    __resetAuthUserCacheForTests();
    __resetAgentQuotaForTests();
    await db.user.createMany({ data: users });
    app = createApp();
  });
  beforeEach(clearFixtures);
  afterAll(async () => {
    try {
      await clearFixtures();
      await db.user.deleteMany({ where: { id: { in: ids } } });
    } finally {
      process.env = originalEnv;
      resetEnvForTests();
      await Promise.all([
        app?.closeResources(),
        db.$disconnect(),
        prisma.$disconnect(),
        tokens.close(),
      ]);
    }
  });

  it('requires one valid key for authorized PAT creates but preserves cookie no-key behavior', async () => {
    const reader = await issueToken(tokens, auditActor(owner.id), 0, {
      name: 'Synthetic read only',
      scopes: ['pto:read'],
    });
    const token = await mint();
    await post(reader.rawToken, 'bad').send(body).expect(403);
    const missing = await request(app)
      .post('/pto')
      .set('Authorization', `Bearer ${token.rawToken}`)
      .send(body)
      .expect(400);
    expect(missing.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const invalid = await post(token.rawToken, 'private malformed text').send(body).expect(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(invalid.body)).not.toContain('private malformed text');
    const key = ptoCreateKey();
    await post(token.rawToken, `${key}, ${key}`).send(body).expect(400);
    expect(await eligibleAudit()).toHaveLength(0);
    const browser = await session();
    const created = await browser.post('/pto').send(body).expect(201);
    expect(created.headers[replayHeader]).toBeUndefined();
    expect(created.headers[expiryHeader]).toBeUndefined();
    expect(created.body.note).toBe(note);
    expect(await eligibleAudit()).toHaveLength(1);
  });

  it.each([false, true])(
    'serializes identical same-key requests and creates exactly one record and audit (rollback=%s)',
    async (rollback) => {
      const browser = await session();
      const key = ptoCreateKey();
      const send = async () => browser.post('/pto').set('Idempotency-Key', key).send(body);
      const [first, second] = await contend(send, send, rollback);
      expect(first.status).toBe(rollback ? 500 : 201);
      expect(second.status).toBe(201);
      expect(second.headers[replayHeader]).toBe(rollback ? 'false' : 'true');
      expect(second.headers[expiryHeader]).toBe(expires(key).toISOString());
      if (!rollback) expect(second.body).toEqual(first.body);
      const audits = await eligibleAudit();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ entityId: second.body.id, credentialType: 'session' });
      expect(await db.pTORequest.count({ where: { userId: owner.id } })).toBe(1);
    },
  );

  it('recovers a committed create after a lost response without new data or audit', async () => {
    const credential = await mint();
    const transact = prisma.$transaction.bind(prisma);
    const spy = vi.spyOn(prisma, '$transaction').mockImplementationOnce((async (
      op: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ) => {
      await transact(op);
      // Fault at the service/HTTP boundary after COMMIT; the client never
      // receives a successful result and cannot infer that it committed.
      throw new Error('synthetic lost result after commit');
    }) as never);
    const key = ptoCreateKey();
    try {
      await post(credential.rawToken, key)
        .set('X-Request-Id', 'lost-create')
        .send(body)
        .expect(500);
    } finally {
      spy.mockRestore();
    }
    const stored = await db.pTORequest.findFirstOrThrow({ where: { userId: owner.id } });
    const replay = await post(credential.rawToken, key)
      .set('X-Request-Id', 'replay-create')
      .send(body)
      .expect(201);
    expect(replay.headers[replayHeader]).toBe('true');
    expect(replay.headers['x-request-id']).toBe('replay-create');
    expect(replay.headers['cache-control']).toBe('no-store');
    expect(replay.body).toMatchObject({ id: stored.id, version: 1, note: null });
    const audits = await eligibleAudit();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      credentialType: 'personal_access_token',
      sourceTokenId: credential.token.id,
      requestId: 'lost-create',
    });
    const serialized = await db.$queryRaw<{ data: string }[]>`
      SELECT to_jsonb(r)::text AS data FROM public.pto_create_replays r WHERE owner_id=${owner.id}::uuid
    `;
    expect(serialized).toHaveLength(1);
    for (const secret of [key, note, credential.rawToken]) {
      expect(serialized[0]!.data).not.toContain(secret);
      expect(JSON.stringify(audits[0])).not.toContain(secret);
      expect(JSON.stringify(replay.body)).not.toContain(secret);
    }
  });

  it('binds the canonical payload but isolates different actors and credential identities', async () => {
    const token = await mint();
    const second = await mint();
    const differentOwner = await mint(other.id);
    const key = ptoCreateKey();
    const original = { ...body, endDate: '2026-11-23', note: '' };
    const first = await post(token.rawToken, key).send(original).expect(201);
    const same = await post(token.rawToken, key)
      .send({ startDate: original.startDate, endDate: original.endDate, dayPart: 'all_day' })
      .expect(201);
    expect(same.body).toEqual(first.body);
    expect(same.headers[replayHeader]).toBe('true');
    const mismatch = await post(token.rawToken, key)
      .send({ ...original, note })
      .expect(409);
    expect(mismatch.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const independentToken = await post(second.rawToken, key).send(original).expect(409);
    expect(independentToken.body.error.code).toBe('CONFLICT');
    const independentOwner = await post(differentOwner.rawToken, key).send(original).expect(201);
    expect(independentOwner.headers[replayHeader]).toBe('false');
    expect(independentOwner.body.id).not.toBe(first.body.id);
    const browser1 = await session();
    const browser2 = await session();
    const sessionKey = ptoCreateKey();
    const calendar = { startDate: '2026-11-25', endDate: '2026-11-25', dayPart: 'morning' };
    await browser1.post('/pto').set('Idempotency-Key', sessionKey).send(calendar).expect(201);
    const otherSession = await browser2
      .post('/pto')
      .set('Idempotency-Key', sessionKey)
      .send(calendar)
      .expect(409);
    expect(otherSession.body.error.code).toBe('CONFLICT');
  });

  it('never resurrects an expired key after indexed pruning and rejects a future key', async () => {
    const credential = await mint();
    const key = ptoCreateKey(Date.now() - dayMs - 60_000);
    await db.$executeRaw`
      INSERT INTO public.pto_create_replays
        (id,owner_id,credential_kind,credential_id,key_digest,payload_fingerprint,expires_at)
      VALUES (${randomUUID()}::uuid, ${owner.id}::uuid, 'pat', ${credential.token.id}::uuid, ${digest(key)}, ${'a'.repeat(64)}, ${expires(key)})
    `;
    const before = await post(credential.rawToken, key).send(body).expect(409);
    expect(before.body.error.code).toBe('IDEMPOTENCY_EXPIRED');
    const future = await post(credential.rawToken, ptoCreateKey(Date.now() + 300_000))
      .send(body)
      .expect(400);
    expect(future.body.error.code).toBe('VALIDATION_ERROR');
    expect(await eligibleAudit()).toHaveLength(0);
    await post(credential.rawToken, ptoCreateKey()).send(body).expect(201);
    const [row] = await db.$queryRaw<{ howMany: number }[]>`
      SELECT count(*)::int AS "howMany" FROM public.pto_create_replays
      WHERE owner_id=${owner.id}::uuid AND key_digest=${digest(key)}
    `;
    expect(row?.howMany).toBe(0);
    const after = await post(credential.rawToken, key).send(body).expect(409);
    expect(after.body.error.code).toBe('IDEMPOTENCY_EXPIRED');
    expect(await eligibleAudit()).toHaveLength(1);
  });

  it('preserves non-note snapshots and will not read notes from a changed or deleted revision', async () => {
    const token = await mint(owner.id, true);
    const key = ptoCreateKey();
    const created = await post(token.rawToken, key).send(body).expect(201);
    expect(created.body.note).toBe(note);
    const read = await post(token.rawToken, key).send(body).expect(201);
    expect(read.body).toEqual(created.body);
    await db.personalAccessToken.update({
      where: { id: token.token.id },
      data: { scopes: ['pto:create', 'pto:read'] },
    });
    expect((await post(token.rawToken, key).send(body).expect(201)).body.note).toBeNull();
    await db.personalAccessToken.update({
      where: { id: token.token.id },
      data: { scopes: ['pto:create', 'pto:read', 'pto:notes:read'] },
    });
    const browser = await session();
    await browser
      .patch(`/pto/${created.body.id}`)
      .set('If-Match', '"1"')
      .send({ note: 'newer synthetic note' })
      .expect(200);
    const old = { ...created.body, note: null };
    expect((await post(token.rawToken, key).send(body).expect(201)).body).toEqual(old);
    await browser.delete(`/pto/${created.body.id}`).set('If-Match', '"2"').expect(204);
    expect((await post(token.rawToken, key).send(body).expect(201)).body).toEqual(old);
    expect(await db.pTORequest.count({ where: { userId: owner.id } })).toBe(0);
    expect(await eligibleAudit()).toHaveLength(1);
  });

  it.each(['revoked', 'expired', 'lost-scope'] as const)(
    'rechecks PAT authority after waiting for an in-flight claim (%s)',
    async (change) => {
      const credential = await mint();
      const key = ptoCreateKey();
      const held = latch<number>();
      const release = latch<void>();
      const holder = db.$transaction(
        async (tx) => {
          await tx.$executeRaw`
            INSERT INTO public.pto_create_replays
              (id,owner_id,credential_kind,credential_id,key_digest,payload_fingerprint,expires_at)
            VALUES (${randomUUID()}::uuid, ${owner.id}::uuid, 'pat', ${credential.token.id}::uuid, ${digest(key)}, ${'b'.repeat(64)}, ${expires(key)})
          `;
          const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          held.release(row!.pid);
          await release.promise;
        },
        { timeout: 10_000 },
      );
      void holder.catch(() => undefined);
      let pending: Promise<request.Response> | undefined;
      try {
        const pid = await Promise.race([
          held.promise,
          holder.then(() => {
            throw new Error('Fixture left its claim unexpectedly');
          }),
        ]);
        pending = post(credential.rawToken, key)
          .send(body)
          .then((result) => result);
        void pending.catch(() => undefined);
        await waitingForClaim(pid);
        if (change === 'revoked') {
          await revokeToken(tokens, auditActor(owner.id), credential.token.id);
        } else if (change === 'expired') {
          // Set an expiry *after* the contender's transaction began, then
          // let it pass while that transaction waits for the claim.
          await db.$executeRaw`
            UPDATE personal_access_tokens
              SET expires_at = (clock_timestamp() AT TIME ZONE 'UTC') + interval '300 milliseconds'
            WHERE id=${credential.token.id}::uuid
          `;
          await vi.waitFor(
            async () => {
              const [row] = await db.$queryRaw<{ expired: boolean }[]>`
              SELECT (clock_timestamp() AT TIME ZONE 'UTC') >= expires_at AS expired
              FROM personal_access_tokens WHERE id=${credential.token.id}::uuid
            `;
              expect(row?.expired).toBe(true);
            },
            { timeout: 1500 },
          );
        } else {
          await db.personalAccessToken.update({
            where: { id: credential.token.id },
            data: { scopes: ['pto:read'] },
          });
        }
      } finally {
        release.release(undefined);
        await Promise.allSettled([holder, pending]);
      }
      await holder;
      const refused = await pending!;
      expect(refused.status).toBe(change === 'lost-scope' ? 403 : 401);
      expect(refused.body.error.code).toBe(
        change === 'lost-scope' ? 'FORBIDDEN' : 'UNAUTHENTICATED',
      );
      expect(await db.pTORequest.count({ where: { userId: owner.id } })).toBe(0);
      expect(await eligibleAudit()).toHaveLength(0);
    },
  );
});
