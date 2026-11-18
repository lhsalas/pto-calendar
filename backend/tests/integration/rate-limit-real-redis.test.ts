import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type ManagedApp } from '../../src/server.js';
import { createPrismaClient } from '../../src/lib/prismaClient.js';
import { prisma as appPrisma } from '../../src/lib/prisma.js';
import { resetEnvForTests } from '../../src/config/env.js';
import { __resetAuthUserCacheForTests } from '../../src/middleware/requireAuth.js';
import { __resetAgentQuotaForTests } from '../../src/middleware/agentQuota.js';
import { chargeBearerFailure } from '../../src/middleware/agentQuota.js';
import { sharedRedisClient } from '../../src/lib/rateLimit.js';
import { createTokenDatabase } from '../../src/services/tokens/tokenDatabase.js';

/**
 * Real-Redis certification of the shared counters (#253).
 *
 * The disposable fixture is named explicitly: this suite never falls back to
 * an ambient production store, never uses a process-local substitute and
 * never skips. A missing fixture is a hard failure.
 */
const testRedisUrl = process.env.RATE_LIMIT_TEST_REDIS_URL;
if (!testRedisUrl) {
  throw new Error(
    'RATE_LIMIT_TEST_REDIS_URL is required for the real-Redis rate-limit integration tests',
  );
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Explicit disposable integration DATABASE_URL is required');
const db = createPrismaClient(url);
const tokens = createTokenDatabase(url);
const password = 'real-redis-quota-password';
const hash = bcrypt.hashSync(password, 4);
const user = {
  id: randomUUID(),
  role: 'member' as const,
  email: `real-redis-${randomUUID()}@example.test`,
  name: 'Real Redis',
  colorCode: '#123456',
  passwordHash: hash,
};
const originalEnv = { ...process.env };
/** An independent connection that never shares state with the application. */
let observer: Redis;
const apps: ManagedApp[] = [];

/** The runtime key of the verified-user counter, including its subject. */
const userKey = `pto:rate-limit:quota-user:user:${user.id}`;
const userRefundsKey = `${userKey}:refunds`;
/** The runtime key of the pre-verification counter for the loopback address. */
const bearerKey = 'pto:rate-limit:bearer-failure:ip:127.0.0.1';
const bearerRefundsKey = `${bearerKey}:refunds`;

async function login(target: ManagedApp) {
  const agent = request.agent(target);
  await agent.post('/auth/login').send({ email: user.email, password }).expect(200);
  return agent;
}

function newApp(): ManagedApp {
  const created = createApp();
  apps.push(created);
  return created;
}

describe('the shared counters on a real Redis store', () => {
  beforeAll(async () => {
    observer = new Redis(testRedisUrl, { maxRetriesPerRequest: 1, connectTimeout: 2_000 });
    await db.user.create({ data: user });
  });
  beforeEach(async () => {
    Object.assign(process.env, originalEnv, {
      NODE_ENV: 'test',
      DATABASE_URL: url,
      RATE_LIMIT_REDIS_URL: testRedisUrl,
      COOKIE_SECURE: 'false',
      CORS_ORIGIN: 'http://localhost:5173',
      AUTH_RATE_LIMIT_MAX: '1000',
      RATE_LIMIT_MAX: '10000',
      RATE_LIMIT_ATTEMPT_WINDOW_MS: '900000',
      RATE_LIMIT_BEARER_FAILURE_MAX: '1000',
      RATE_LIMIT_USER_QUOTA_MAX: '1',
      RATE_LIMIT_TOKEN_QUOTA_MAX: '1000',
      RATE_LIMIT_TOKEN_ISSUANCE_MAX: '1000',
      RATE_LIMIT_TOKEN_PASSWORD_MAX: '1000',
      RATE_LIMIT_QUOTA_WINDOW_MS: '60000',
    });
    resetEnvForTests();
    __resetAuthUserCacheForTests();
    __resetAgentQuotaForTests();
    await db.personalAccessToken.deleteMany({ where: { ownerId: user.id } });
    await db.auditLog.deleteMany({ where: { actorUserId: user.id } });
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
    await observer.del(userKey, userRefundsKey, bearerKey, bearerRefundsKey);
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((owned) => owned.closeResources()));
    await observer.del(userKey, userRefundsKey, bearerKey, bearerRefundsKey);
  });
  afterAll(async () => {
    try {
      await db.personalAccessToken.deleteMany({ where: { ownerId: user.id } });
      await db.auditLog.deleteMany({ where: { actorUserId: user.id } });
      await db.user.deleteMany({ where: { id: user.id } });
    } finally {
      await Promise.all([tokens.close(), db.$disconnect(), appPrisma.$disconnect()]);
      observer.disconnect();
      process.env = { ...originalEnv };
      resetEnvForTests();
      __resetAuthUserCacheForTests();
      __resetAgentQuotaForTests();
    }
  });

  it('keeps one counter that an independent connection can read and extend', async () => {
    const app = newApp();
    const agent = await login(app);
    await agent.get('/pto?start=2026-12-01&end=2026-12-31').expect(200);
    expect(await observer.hget(userKey, 'count')).toBe('1');
    // A different connection, with no shared process state, extends the same
    // counter, so the budget lives in the store and not in the application.
    await observer.hset(userKey, 'count', '5');
    const other = await login(app);
    const limited = await other.get('/pto?start=2026-12-01&end=2026-12-31');
    expect(limited.status).toBe(429);
    expect(await observer.hget(userKey, 'count')).toBe('6');
  });

  it('shares the counter between two running application instances', async () => {
    const first = newApp();
    const second = newApp();
    const agent = await login(first);
    await agent.get('/pto?start=2026-12-01&end=2026-12-31').expect(200);
    const other = await login(second);
    const limited = await other.get('/pto?start=2026-12-01&end=2026-12-31');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
    expect(await observer.hget(userKey, 'count')).toBe('2');
  });

  it('reuses the counter after the application restarted', async () => {
    const first = newApp();
    const agent = await login(first);
    await agent.get('/pto?start=2026-12-01&end=2026-12-31').expect(200);
    // The restart closes the shared connection and opens a new one.
    await first.closeResources();
    const second = newApp();
    const other = await login(second);
    const limited = await other.get('/pto?start=2026-12-01&end=2026-12-31');
    expect(limited.status).toBe(429);
    expect(await observer.hget(userKey, 'count')).toBe('2');
  });

  it('counts concurrent attempts exactly once', async () => {
    process.env.RATE_LIMIT_USER_QUOTA_MAX = '5';
    resetEnvForTests();
    __resetAgentQuotaForTests();
    await observer.del(userKey);
    const app = newApp();
    const agent = await login(app);
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => agent.get('/pto?start=2026-12-01&end=2026-12-31')),
    );
    expect(responses.filter((response) => response.status === 200)).toHaveLength(5);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(15);
    // No increment was lost: every attempt is counted exactly once.
    expect(await observer.hget(userKey, 'count')).toBe('20');
  });

  it('expires the counter with its window and starts a new one', async () => {
    process.env.RATE_LIMIT_QUOTA_WINDOW_MS = '2000';
    resetEnvForTests();
    __resetAgentQuotaForTests();
    await observer.del(userKey);
    const app = newApp();
    const agent = await login(app);
    await agent.get('/pto?start=2026-12-01&end=2026-12-31').expect(200);
    const ttl = await observer.pttl(userKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(2000);
    await agent.get('/pto?start=2026-12-01&end=2026-12-31').expect(429);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    // The expired counter is gone, so the next attempt starts a new window.
    expect(await observer.exists(userKey)).toBe(0);
    await agent.get('/pto?start=2026-12-01&end=2026-12-31').expect(200);
  });

  it('never lets a compensation of an expired window touch the new one', async () => {
    process.env.RATE_LIMIT_ATTEMPT_WINDOW_MS = '2000';
    resetEnvForTests();
    __resetAgentQuotaForTests();
    await observer.del(bearerKey, bearerRefundsKey);
    const client = sharedRedisClient(testRedisUrl);
    const originalEval = client.eval.bind(client);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived!: () => void;
    const entered = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    client.eval = (async (...args: Parameters<typeof client.eval>) => {
      if (String(args[0]).includes('pto-quota:compensate')) {
        arrived();
        await held;
      }
      return originalEval(...args);
    }) as typeof client.eval;
    try {
      const charge = await chargeBearerFailure({
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
        headers: {},
      } as never);
      const refund = charge.refund();
      // Hold the compensation while the window it belongs to expires.
      await entered;
      await new Promise((resolve) => setTimeout(resolve, 2100));
      expect(await observer.exists(bearerKey)).toBe(0);
      // A genuinely new window starts with its own count.
      await chargeBearerFailure({
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
        headers: {},
      } as never);
      expect(await observer.hget(bearerKey, 'count')).toBe('1');
      const ttlBefore = await observer.pttl(bearerKey);
      release();
      await refund;
      // The stale compensation changed neither the new count nor its window.
      expect(await observer.hget(bearerKey, 'count')).toBe('1');
      expect(await observer.pttl(bearerKey)).toBe(ttlBefore);
    } finally {
      release();
      client.eval = originalEval;
    }
  });

  it('compensates the same attempt only once', async () => {
    await observer.del(bearerKey, bearerRefundsKey);
    const request_ = {
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      headers: {},
    } as never;
    const charge = await chargeBearerFailure(request_);
    await charge.refund();
    await charge.refund();
    // The duplicate compensation did not take the next attempt's budget.
    const next = await chargeBearerFailure(request_);
    expect(next.allowed).toBe(true);
    expect(await observer.hget(bearerKey, 'count')).toBe('1');
  });

  it('never creates a counter for a compensation whose window is gone', async () => {
    process.env.RATE_LIMIT_ATTEMPT_WINDOW_MS = '2000';
    resetEnvForTests();
    __resetAgentQuotaForTests();
    await observer.del(bearerKey, bearerRefundsKey);
    const charge = await chargeBearerFailure({
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      headers: {},
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(await observer.exists(bearerKey)).toBe(0);
    await charge.refund();
    // No counter and no compensation record were created.
    expect(await observer.exists(bearerKey)).toBe(0);
    expect(await observer.exists(bearerRefundsKey)).toBe(0);
  });
});
