import { randomUUID } from 'node:crypto';
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
import { issueToken } from '../../src/services/tokens/tokenService.js';
import { clearFixtureCreateKeys, ptoCreateKey } from '../helpers/ptoCreateKey.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Overlap integration requires an explicit disposable DB.');
const target = new URL(databaseUrl);
if (
  !['postgresql:', 'postgres:'].includes(target.protocol) ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
  target.pathname !== '/pto_test' ||
  [...target.searchParams].some(([key, value]) => key !== 'schema' || value !== 'public')
) {
  throw new Error('Overlap integration runs only on the disposable loopback pto_test DB.');
}

const db = createPrismaClient(databaseUrl);
const tokens = createTokenDatabase(databaseUrl);
const password = 'synthetic-overlap-test-password';
const note = 'private synthetic PTO note';
const users = ['Owner', 'Other'].map((name) => {
  const id = randomUUID();
  return {
    id,
    name,
    email: `overlap-${id}@example.invalid`,
    role: 'member' as const,
    colorCode: '#123456',
    passwordHash: bcrypt.hashSync(password, 4),
  };
});
const [owner, other] = [users[0]!, users[1]!];
const ownerIds = users.map(({ id }) => id);
const collision = '2026-11-20';
let app: ManagedApp;

function day(date: string, dayPart: 'morning' | 'evening' | 'all_day' = 'all_day') {
  return { startDate: date, endDate: date, dayPart };
}

async function session(user = owner) {
  const agent = request.agent(app);
  await agent.post('/auth/login').send({ email: user.email, password }).expect(200);
  return agent;
}

async function existing(date: string) {
  return db.pTORequest.create({
    data: {
      userId: owner.id,
      startDate: new Date(date),
      endDate: new Date(date),
      dayPart: 'all_day',
      note,
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

/**
 * Pause the first real application transaction after its mutation and audit
 * but before COMMIT. The second actual API write cannot see the winner in
 * its preflight SELECT; verify it reaches the DB and waits for that exact
 * transaction before releasing it.
 */
async function race(
  winner: () => Promise<request.Response>,
  loser: () => Promise<request.Response>,
  sameOwner = true,
) {
  const ready = deferred<number>();
  const release = deferred<void>();
  const transact = prisma.$transaction.bind(prisma);
  const spy = vi.spyOn(prisma, '$transaction').mockImplementationOnce((async (
    callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) =>
    transact(
      async (tx) => {
        const result = await callback(tx);
        const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        ready.resolve(row!.pid);
        await release.promise;
        return result;
      },
      { timeout: 10_000 },
    )) as never);
  let first: Promise<request.Response> | undefined;
  let second: Promise<request.Response> | undefined;
  try {
    first = winner();
    const pid = await Promise.race([
      ready.promise,
      first.then((response) => {
        throw new Error(`First write ended before the transaction barrier (${response.status}).`);
      }),
    ]);
    second = loser();
    void second.catch(() => undefined);
    if (sameOwner) {
      await vi.waitFor(
        async () => {
          const [row] = await db.$queryRaw<{ waiting: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database()
                AND state = 'active' AND wait_event_type = 'Lock'
                AND query LIKE '%pto_requests%'
                AND ${pid}::integer = ANY(pg_blocking_pids(pid))
            ) AS waiting
          `;
          expect(row?.waiting).toBe(true);
        },
        { timeout: 3500, interval: 20 },
      );
    } else {
      // Wait for this owner to commit before releasing the first owner.
      expect((await second).status).toBe(201);
    }
  } finally {
    release.resolve(undefined);
    spy.mockRestore();
    await Promise.allSettled([first, second]);
  }
  return await Promise.all([first!, second!]);
}

function expectConflict(response: request.Response) {
  expect(response.status).toBe(409);
  expect(response.body).toEqual({
    error: {
      code: 'CONFLICT',
      message: 'This PTO overlaps an existing PTO entry for the same user.',
    },
  });
}

function ptoAudits() {
  return db.auditLog.findMany({ where: { actorUserId: owner.id, entityType: 'pto_request' } });
}

async function clearFixtures() {
  await clearFixtureCreateKeys(db, ownerIds);
  await db.auditLog.deleteMany({ where: { actorUserId: { in: ownerIds } } });
  await db.pTORequest.deleteMany({ where: { userId: { in: ownerIds } } });
  await db.personalAccessToken.deleteMany({ where: { ownerId: { in: ownerIds } } });
}

describe('concurrent PTO overlap integrity on PostgreSQL', () => {
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      SESSION_SECRET: 'disposable-overlap-tests-session-secret-not-for-use',
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
      await db.user.deleteMany({ where: { id: { in: ownerIds } } });
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

  it('lets only one of two overlapping creates commit, including a scoped PAT', async () => {
    const browser = await session();
    const issued = await issueToken(
      tokens,
      { id: owner.id, credential: { type: 'session' }, requestId: 'overlap-fixture' },
      0,
      { name: 'Local overlap test', scopes: ['pto:create'] },
    );
    const [created, refused] = await race(
      async () => browser.post('/pto').send({ ...day(collision, 'morning'), note }),
      async () =>
        request(app)
          .post('/pto')
          .set('Authorization', `Bearer ${issued.rawToken}`)
          .set('Idempotency-Key', ptoCreateKey())
          .send(day(collision, 'evening')),
    );
    expect(created!.status).toBe(201);
    expectConflict(refused!);
    expect(await db.pTORequest.count({ where: { userId: owner.id } })).toBe(1);
    const audit = await ptoAudits();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'create_pto', entityId: created!.body.id });
    expect(JSON.stringify(audit[0]?.details)).not.toContain(note);
  });

  it('refuses an overlapping replacement against an uncommitted create', async () => {
    const row = await existing('2026-11-18');
    const browser = await session();
    const second = await session();
    const [created, refused] = await race(
      async () => browser.post('/pto').send(day(collision)),
      async () => second.put(`/pto/${row.id}`).set('If-Match', '"1"').send(day(collision)),
    );
    expect(created!.status).toBe(201);
    expectConflict(refused!);
    expect(await db.pTORequest.findUnique({ where: { id: row.id } })).toEqual(row);
    const audit = await ptoAudits();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'create_pto', entityId: created!.body.id });
  });

  it('refuses an overlapping partial write on a different row without changing its revision', async () => {
    const [left, right] = await Promise.all([existing('2026-11-18'), existing('2026-11-19')]);
    const first = await session();
    const second = await session();
    const [updated, refused] = await race(
      async () => first.put(`/pto/${left.id}`).set('If-Match', '"1"').send(day(collision)),
      async () =>
        second
          .patch(`/pto/${right.id}`)
          .set('If-Match', '"1"')
          .send({ startDate: collision, endDate: collision }),
    );
    expect(updated!.status).toBe(200);
    expect(updated!.body.version).toBe(2);
    expectConflict(refused!);
    expect(await db.pTORequest.findUnique({ where: { id: right.id } })).toEqual(right);
    const audit = await ptoAudits();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'update_pto', entityId: left.id });
    expect(JSON.stringify(audit[0]?.details)).not.toContain(note);
  });

  it('lets another owner commit the same date while the first owner is uncommitted', async () => {
    const browser = await session();
    const otherBrowser = await session(other);
    const [created] = await race(
      async () => browser.post('/pto').send(day(collision)).timeout({ deadline: 6000 }),
      async () => otherBrowser.post('/pto').send(day(collision)).timeout({ deadline: 5000 }),
      false,
    );
    expect(created.status).toBe(201);
    const rows = await db.pTORequest.findMany({ where: { userId: { in: ownerIds } } });
    expect(new Set(rows.map((row) => row.userId))).toEqual(new Set(ownerIds));
    expect(rows).toHaveLength(2);
  });

  it('allows adjacent ranges and a weekend inside the range, but rejects the shared end date', async () => {
    const browser = await session();
    await browser
      .post('/pto')
      .send({ ...day(collision), endDate: '2026-11-23' })
      .expect(201);
    await browser.post('/pto').send(day('2026-11-24')).expect(201);
    expectConflict(await browser.post('/pto').send(day('2026-11-23')));
    expect(await db.pTORequest.count({ where: { userId: owner.id } })).toBe(2);
    expect(await ptoAudits()).toHaveLength(2);
  });
});
