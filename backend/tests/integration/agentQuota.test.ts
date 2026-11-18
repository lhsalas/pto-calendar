import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type * as bcryptModule from 'bcryptjs';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { createApp, type ManagedApp } from '../../src/server.js';
import { createPrismaClient } from '../../src/lib/prismaClient.js';
import { prisma as appPrisma } from '../../src/lib/prisma.js';
import { resetEnvForTests } from '../../src/config/env.js';
import { __resetAuthUserCacheForTests } from '../../src/middleware/requireAuth.js';
import { __resetAgentQuotaForTests } from '../../src/middleware/agentQuota.js';
import { createTokenDatabase } from '../../src/services/tokens/tokenDatabase.js';
import { issueToken } from '../../src/services/tokens/tokenService.js';
import type { AuditActor } from '../../src/services/audit/auditContext.js';

const { bcryptCalls } = vi.hoisted(() => ({ bcryptCalls: { compare: 0 } }));

// The real bcrypt implementation still runs; the counter only proves how many
// expensive comparisons a request actually reached.
vi.mock('bcryptjs', async (importOriginal) => {
  const actual = await importOriginal<typeof bcryptModule>();
  const compare = async (...args: Parameters<typeof actual.default.compare>) => {
    bcryptCalls.compare += 1;
    return actual.default.compare(...args);
  };
  return { default: { ...actual.default, compare } };
});

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Explicit disposable integration DATABASE_URL is required');
const db = createPrismaClient(url);
const tokens = createTokenDatabase(url);
const password = 'agent-quota-integration-password';
const hash = bcrypt.hashSync(password, 4);
const users = (['member', 'member'] as const).map((role, index) => {
  const id = randomUUID();
  return {
    id,
    role,
    email: `agent-quota-${id}@example.test`,
    name: `Quota ${index}`,
    colorCode: '#123456',
    passwordHash: hash,
  };
});
const ids = users.map((user) => user.id);
/** Attribution for a verified browser session; never derived from request data. */
function sessionActor(id: string): AuditActor {
  return { id, credential: { type: 'session' }, requestId: 'agent-quota-integration' };
}
const originalEnv = { ...process.env };
let app: ManagedApp | undefined;
let clock: MockInstance<typeof Date.now> | undefined;

function confidential(res: request.Response): void {
  expect(res.headers['x-request-id']).toMatch(/^[A-Za-z0-9._-]{1,200}$/);
}

/** The remaining delay of the rejecting window, in seconds. */
function draft7Reset(res: request.Response): number {
  const match = /reset=(\d+)/.exec(res.headers['ratelimit'] ?? '');
  expect(match).not.toBeNull();
  return Number(match![1]);
}

async function login(index: number) {
  const user = users[index]!;
  const agent = request.agent(app!);
  await agent.post('/auth/login').send({ email: user.email, password }).expect(200);
  bcryptCalls.compare = 0;
  return agent;
}

async function mint(index: number) {
  return issueToken(tokens, sessionActor(users[index]!.id), 0, {
    name: 'Quota token',
    scopes: ['pto:read'],
  });
}

describe('verified traffic and issuance quotas on PostgreSQL', () => {
  beforeAll(async () => {
    await db.user.createMany({ data: users });
  });
  beforeEach(async () => {
    Object.assign(process.env, originalEnv, {
      NODE_ENV: 'test',
      DATABASE_URL: url,
      PAT_AUTH_ENABLED: 'true',
      PAT_WRITES_ENABLED: 'false',
      COOKIE_SECURE: 'false',
      CORS_ORIGIN: 'http://localhost:5173',
      AUTH_RATE_LIMIT_MAX: '1000',
      RATE_LIMIT_MAX: '10000',
      RATE_LIMIT_ATTEMPT_WINDOW_MS: '900000',
      RATE_LIMIT_BEARER_FAILURE_MAX: '1000',
      RATE_LIMIT_USER_QUOTA_MAX: '1000',
      RATE_LIMIT_TOKEN_QUOTA_MAX: '1000',
      RATE_LIMIT_TOKEN_ISSUANCE_MAX: '1000',
      RATE_LIMIT_TOKEN_PASSWORD_MAX: '1000',
      RATE_LIMIT_QUOTA_WINDOW_MS: '60000',
    });
    delete process.env.RATE_LIMIT_REDIS_URL;
    resetEnvForTests();
    __resetAuthUserCacheForTests();
    __resetAgentQuotaForTests();
    await db.personalAccessToken.deleteMany({ where: { ownerId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { actorUserId: { in: ids } } });
    for (const user of users)
      await db.user.update({
        where: { id: user.id },
        data: {
          role: user.role,
          passwordHash: hash,
          sessionVersion: 0,
          setupTokenHash: null,
          setupTokenExpiresAt: null,
        },
      });
    // Fix Date.now() so consecutive requests cannot straddle a quota window;
    // keep the real event loop and timers for PostgreSQL and HTTP.
    const now = Date.now();
    clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    app = createApp();
  });
  afterEach(async () => {
    clock?.mockRestore();
    clock = undefined;
    // A failed setup must not mask its own error with a cleanup failure.
    if (app) await app.closeResources();
    app = undefined;
  });
  afterAll(async () => {
    try {
      await db.personalAccessToken.deleteMany({ where: { ownerId: { in: ids } } });
      await db.auditLog.deleteMany({ where: { actorUserId: { in: ids } } });
      await db.user.deleteMany({ where: { id: { in: ids } } });
    } finally {
      await Promise.all([tokens.close(), db.$disconnect(), appPrisma.$disconnect()]);
      process.env = { ...originalEnv };
      resetEnvForTests();
      __resetAuthUserCacheForTests();
      __resetAgentQuotaForTests();
    }
  });

  it('charges verified users independently behind one shared address', async () => {
    process.env.RATE_LIMIT_USER_QUOTA_MAX = '2';
    resetEnvForTests();
    __resetAgentQuotaForTests();
    const first = await login(0);
    const second = await login(1);
    await first.get('/pto?start=2026-12-01&end=2026-12-31').expect(200);
    await first.get('/pto?start=2026-12-01&end=2026-12-31').expect(200);
    const limited = await first.get('/pto?start=2026-12-01&end=2026-12-31');
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' },
    });
    confidential(limited);
    // The other account shares the address but not the budget.
    await second.get('/pto?start=2026-12-01&end=2026-12-31').expect(200);
  });

  it('charges verified tokens of one owner independently', async () => {
    process.env.RATE_LIMIT_TOKEN_QUOTA_MAX = '1';
    resetEnvForTests();
    __resetAgentQuotaForTests();
    const first = await mint(0);
    const second = await mint(0);
    await request(app!)
      .get('/pto?start=2026-12-01&end=2026-12-31')
      .set('Authorization', `Bearer ${first.rawToken}`)
      .expect(200);
    const limited = await request(app!)
      .get('/pto?start=2026-12-01&end=2026-12-31')
      .set('Authorization', `Bearer ${first.rawToken}`);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    // A second token of the same owner keeps its own budget.
    await request(app!)
      .get('/pto?start=2026-12-01&end=2026-12-31')
      .set('Authorization', `Bearer ${second.rawToken}`)
      .expect(200);
  });

  it('stops an invalid bearer flood before the credential lookup', async () => {
    process.env.RATE_LIMIT_BEARER_FAILURE_MAX = '2';
    resetEnvForTests();
    __resetAgentQuotaForTests();
    const issued = await mint(0);
    const stored = await db.personalAccessToken.findUniqueOrThrow({
      where: { id: issued.token.id },
    });
    expect(stored.lastUsedAt).toBeNull();
    const invalid = `Bearer pto_pat_${randomUUID()}.${'a'.repeat(64)}`;
    for (let attempt = 0; attempt < 2; attempt += 1)
      await request(app!)
        .get('/pto?start=2026-12-01&end=2026-12-31')
        .set('Authorization', invalid)
        .expect(401);
    const limited = await request(app!)
      .get('/pto?start=2026-12-01&end=2026-12-31')
      .set('Authorization', invalid);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
    // Even a valid secret is refused before the lookup, so no usage was written.
    const blocked = await request(app!)
      .get('/pto?start=2026-12-01&end=2026-12-31')
      .set('Authorization', `Bearer ${issued.rawToken}`);
    expect(blocked.status).toBe(429);
    const after = await db.personalAccessToken.findUniqueOrThrow({
      where: { id: issued.token.id },
    });
    expect(after.lastUsedAt).toBeNull();
  });

  it('keeps a verified secret out of the failed-attempt budget', async () => {
    process.env.RATE_LIMIT_BEARER_FAILURE_MAX = '1';
    resetEnvForTests();
    __resetAgentQuotaForTests();
    const issued = await mint(0);
    for (let attempt = 0; attempt < 3; attempt += 1)
      await request(app!)
        .get('/pto?start=2026-12-01&end=2026-12-31')
        .set('Authorization', `Bearer ${issued.rawToken}`)
        .expect(200);
  });

  it('bounds issuance password failures without locking the browser login', async () => {
    process.env.RATE_LIMIT_TOKEN_PASSWORD_MAX = '2';
    resetEnvForTests();
    __resetAgentQuotaForTests();
    const agent = await login(0);
    for (let attempt = 0; attempt < 2; attempt += 1)
      await agent.post('/auth/tokens').send({ name: 'Wrong', password: 'wrong' }).expect(401);
    const limited = await agent.post('/auth/tokens').send({ name: 'Wrong', password: 'wrong' });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
    // The rejected issuance produced no token and no audit row.
    expect(await db.personalAccessToken.count({ where: { ownerId: users[0]!.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { actorUserId: users[0]!.id } })).toBe(0);
    // The browser login keeps its own budget and is not locked by those failures.
    await login(0);
  });

  it('bounds the expensive password comparisons themselves', async () => {
    process.env.RATE_LIMIT_TOKEN_PASSWORD_MAX = '1';
    process.env.RATE_LIMIT_TOKEN_ISSUANCE_MAX = '1';
    resetEnvForTests();
    __resetAgentQuotaForTests();
    const agent = await login(0);
    await agent.post('/auth/tokens').send({ name: 'First', password }).expect(201);
    expect(bcryptCalls.compare).toBe(1);
    // The next request is refused before the comparison, even though its
    // password would have been correct.
    const limited = await agent.post('/auth/tokens').send({ name: 'Second', password });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(bcryptCalls.compare).toBe(1);
    // A wrong password is refused the same way, and never compared.
    const wrong = await agent.post('/auth/tokens').send({ name: 'Third', password: 'wrong' });
    expect(wrong.status).toBe(429);
    expect(bcryptCalls.compare).toBe(1);
    expect(await db.personalAccessToken.count({ where: { ownerId: users[0]!.id } })).toBe(1);
  });

  it('charges the password budget even when the request is denied for its scope', async () => {
    process.env.RATE_LIMIT_TOKEN_PASSWORD_MAX = '1';
    resetEnvForTests();
    __resetAgentQuotaForTests();
    const agent = await login(0);
    // A member cannot request a team scope, but the password verification ran
    // and is charged like any other attempt.
    await agent
      .post('/auth/tokens')
      .send({ name: 'Escalate', password, scopes: ['pto:update:team'] })
      .expect(403);
    expect(bcryptCalls.compare).toBe(1);
    // The next request is refused before the comparison.
    const limited = await agent.post('/auth/tokens').send({ name: 'Next', password });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(bcryptCalls.compare).toBe(1);
  });

  it('keeps the issuance budget separate from the password budget', async () => {
    process.env.RATE_LIMIT_TOKEN_ISSUANCE_MAX = '1';
    process.env.RATE_LIMIT_TOKEN_PASSWORD_MAX = '1000';
    resetEnvForTests();
    __resetAgentQuotaForTests();
    const agent = await login(0);
    await agent.post('/auth/tokens').send({ name: 'First', password }).expect(201);
    const limited = await agent.post('/auth/tokens').send({ name: 'Second', password });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(await db.personalAccessToken.count({ where: { ownerId: users[0]!.id } })).toBe(1);
    // Ordinary reads are not charged to the issuance budget.
    await agent.get('/pto?start=2026-12-01&end=2026-12-31').expect(200);
  });

  it('keeps one owner budget apart from another owner and from ordinary reads', async () => {
    process.env.RATE_LIMIT_TOKEN_PASSWORD_MAX = '1';
    resetEnvForTests();
    __resetAgentQuotaForTests();
    const owner = await login(0);
    const other = await login(1);
    await owner.post('/auth/tokens').send({ name: 'First', password }).expect(201);
    const limited = await owner.post('/auth/tokens').send({ name: 'Second', password });
    expect(limited.status).toBe(429);
    // Another owner keeps its own budget.
    await other.post('/auth/tokens').send({ name: 'First', password }).expect(201);
    // An ordinary read is not charged to the issuance or password budget.
    await owner.get('/pto?start=2026-12-01&end=2026-12-31').expect(200);
  });

  it('starts a new budget when its window elapsed', async () => {
    process.env.RATE_LIMIT_USER_QUOTA_MAX = '1';
    process.env.RATE_LIMIT_QUOTA_WINDOW_MS = '1000';
    resetEnvForTests();
    __resetAgentQuotaForTests();
    const boundary = (Math.floor(Date.now() / 1000) + 1) * 1000;
    clock!.mockReturnValue(boundary - 1);
    const agent = await login(0);
    await agent.get('/pto?start=2026-12-01&end=2026-12-31').expect(200);
    const limited = await agent.get('/pto?start=2026-12-01&end=2026-12-31').expect(429);
    expect(limited.headers['retry-after']).toBe('1');
    expect(draft7Reset(limited)).toBe(1);
    clock!.mockReturnValue(boundary);
    await agent.get('/pto?start=2026-12-01&end=2026-12-31').expect(200);
  });

  it('never exposes a credential or a store address in a rejection', async () => {
    process.env.RATE_LIMIT_USER_QUOTA_MAX = '1';
    resetEnvForTests();
    __resetAgentQuotaForTests();
    const agent = await login(0);
    await agent.get('/pto?start=2026-12-01&end=2026-12-31').expect(200);
    const limited = await agent.get('/pto?start=2026-12-01&end=2026-12-31');
    expect(limited.status).toBe(429);
    expect(limited.headers['ratelimit']).toContain('limit=1');
    expect(limited.headers['ratelimit-policy']).toContain('w=60');
    expect(limited.headers['retry-after']).toMatch(/^\d+$/);
    // The draft-7 reset is the remaining delay of the rejecting window.
    const reset = draft7Reset(limited);
    expect(reset).toBeGreaterThan(0);
    expect(reset).toBeLessThanOrEqual(60);
    expect(limited.headers['retry-after']).toBe(String(reset));
    expect(JSON.stringify(limited.body)).not.toContain(password);
    expect(JSON.stringify(limited.body)).not.toContain('redis');
  });

  it('fails closed when the shared store is unavailable', async () => {
    process.env.RATE_LIMIT_REDIS_URL = 'redis://127.0.0.1:1/0';
    resetEnvForTests();
    __resetAgentQuotaForTests();
    const failing = createApp();
    try {
      const response = await request(failing).get('/pto?start=2026-12-01&end=2026-12-31');
      expect(response.status).toBe(500);
      expect(JSON.stringify(response.body)).not.toContain('127.0.0.1:1');
      expect(JSON.stringify(response.body)).not.toContain('redis://');
    } finally {
      await failing.closeResources();
    }
  });
});
