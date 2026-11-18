import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import bcrypt from 'bcryptjs';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type ManagedApp } from '../../src/server.js';
import { createPrismaClient } from '../../src/lib/prismaClient.js';
import { prisma as appPrisma } from '../../src/lib/prisma.js';
import { resetEnvForTests } from '../../src/config/env.js';
import { __resetAuthUserCacheForTests } from '../../src/middleware/requireAuth.js';
import { __resetAgentQuotaForTests, chargeBearerFailure } from '../../src/middleware/agentQuota.js';
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
const USER_WINDOW_MS = 60_000;
const BEARER_WINDOW_MS = 900_000;
const EXPIRY_WINDOW_MS = 5_000;
const REQUEST_HEADROOM_MS = 3_000;

/** The runtime key of the verified-user counter, including its subject. */
const userKey = `pto:rate-limit:quota-user:user:${user.id}`;
const userRefundsKey = `${userKey}:refunds`;
/** The runtime key of the pre-verification counter for the loopback address. */
const bearerKey = 'pto:rate-limit:bearer-failure:ip:127.0.0.1';
const bearerRefundsKey = `${bearerKey}:refunds`;

async function waitForWindowHeadroom(windowMs: number): Promise<void> {
  // Use the Redis clock that chooses the generation, not the Node clock.
  // If near a boundary, wait for and confirm room in the next window.
  for (let check = 0; check < 3; check += 1) {
    const [seconds, microseconds] = await observer.time();
    const nowMs = Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000);
    const remainingMs = windowMs - (nowMs % windowMs);
    if (remainingMs >= REQUEST_HEADROOM_MS) return;
    await delay(remainingMs + 5);
  }
  throw new Error('Could not establish sufficient time in a Redis fixture window');
}

async function waitForCounterExpiry(key: string, windowMs: number): Promise<void> {
  // Observe the actual TTL; never delete or extend the counter to fake expiry.
  const ttl = await observer.pttl(key);
  expect(ttl).toBeGreaterThan(0);
  expect(ttl).toBeLessThanOrEqual(windowMs);
  await delay(ttl + 5);
  expect(await observer.exists(key)).toBe(0);
}

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
      RATE_LIMIT_ATTEMPT_WINDOW_MS: String(BEARER_WINDOW_MS),
      RATE_LIMIT_BEARER_FAILURE_MAX: '1000',
      RATE_LIMIT_USER_QUOTA_MAX: '1',
      RATE_LIMIT_TOKEN_QUOTA_MAX: '1000',
      RATE_LIMIT_TOKEN_ISSUANCE_MAX: '1000',
      RATE_LIMIT_TOKEN_PASSWORD_MAX: '1000',
      RATE_LIMIT_QUOTA_WINDOW_MS: String(USER_WINDOW_MS),
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
    await waitForWindowHeadroom(USER_WINDOW_MS);
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
    await waitForWindowHeadroom(USER_WINDOW_MS);
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
    await waitForWindowHeadroom(USER_WINDOW_MS);
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
    await waitForWindowHeadroom(USER_WINDOW_MS);
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => agent.get('/pto?start=2026-12-01&end=2026-12-31')),
    );
    expect(responses.filter((response) => response.status === 200)).toHaveLength(5);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(15);
    // No increment was lost: every attempt is counted exactly once.
    expect(await observer.hget(userKey, 'count')).toBe('20');
  });

  it('expires the counter with its window and starts a new one', async () => {
    process.env.RATE_LIMIT_QUOTA_WINDOW_MS = String(EXPIRY_WINDOW_MS);
    resetEnvForTests();
    __resetAgentQuotaForTests();
    await observer.del(userKey);
    const app = newApp();
    const agent = await login(app);
    await waitForWindowHeadroom(EXPIRY_WINDOW_MS);
    await agent.get('/pto?start=2026-12-01&end=2026-12-31').expect(200);
    await agent.get('/pto?start=2026-12-01&end=2026-12-31').expect(429);
    expect(await observer.hget(userKey, 'count')).toBe('2');
    const firstExpiry = await observer.pexpiretime(userKey);
    expect(firstExpiry).toBeGreaterThan(0);
    await waitForCounterExpiry(userKey, EXPIRY_WINDOW_MS);
    await waitForWindowHeadroom(EXPIRY_WINDOW_MS);
    await agent.get('/pto?start=2026-12-01&end=2026-12-31').expect(200);
    expect(await observer.hget(userKey, 'count')).toBe('1');
    expect(await observer.pexpiretime(userKey)).toBeGreaterThan(firstExpiry);
  });

  it('never lets a compensation of an expired window touch the new one', async () => {
    process.env.RATE_LIMIT_ATTEMPT_WINDOW_MS = String(EXPIRY_WINDOW_MS);
    resetEnvForTests();
    __resetAgentQuotaForTests();
    await observer.del(bearerKey, bearerRefundsKey);
    newApp(); // Holds the application Redis lease for the direct quota calls.
    const client = sharedRedisClient(testRedisUrl);
    const originalEval = client.eval;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    client.eval = (async (...args: Parameters<typeof client.eval>) => {
      if (String(args[0]).includes('pto-quota:compensate') && args[2] === bearerKey) {
        entered = true;
        await held;
      }
      return originalEval.apply(client, args);
    }) as typeof client.eval;
    let refund: Promise<void> | undefined;
    try {
      await waitForWindowHeadroom(EXPIRY_WINDOW_MS);
      const charge = await chargeBearerFailure({
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
        headers: {},
      } as never);
      expect(await observer.hget(bearerKey, 'count')).toBe('1');
      refund = charge.refund();
      // Hold the compensation while the window it belongs to expires.
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 1000 });
      await waitForCounterExpiry(bearerKey, EXPIRY_WINDOW_MS);
      await waitForWindowHeadroom(EXPIRY_WINDOW_MS);
      // A genuinely new window starts with its own count.
      const next = await chargeBearerFailure({
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
        headers: {},
      } as never);
      expect(next.resetTime.getTime()).toBeGreaterThan(charge.resetTime.getTime());
      expect(await observer.hget(bearerKey, 'count')).toBe('1');
      const expiry = await observer.pexpiretime(bearerKey);
      expect(expiry).toBeGreaterThan(0);
      release();
      await refund;
      // The remaining TTL naturally decreases; the absolute expiry must not change.
      expect(await observer.hget(bearerKey, 'count')).toBe('1');
      expect(await observer.pexpiretime(bearerKey)).toBe(expiry);
      expect(await observer.exists(bearerRefundsKey)).toBe(0);
    } finally {
      release();
      try {
        await refund;
      } finally {
        client.eval = originalEval;
      }
    }
  });

  it('compensates the same attempt only once', async () => {
    await observer.del(bearerKey, bearerRefundsKey);
    newApp();
    const request_ = {
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      headers: {},
    } as never;
    await waitForWindowHeadroom(BEARER_WINDOW_MS);
    const charge = await chargeBearerFailure(request_);
    const next = await chargeBearerFailure(request_);
    expect(next.allowed).toBe(true);
    expect(next.resetTime.getTime()).toBe(charge.resetTime.getTime());
    expect(await observer.hget(bearerKey, 'count')).toBe('2');
    await Promise.all([charge.refund(), charge.refund()]);
    // Leave another charge outstanding: a zero-count floor cannot mask a second refund.
    expect(await observer.hget(bearerKey, 'count')).toBe('1');
  });

  it('never creates a counter for a compensation whose window is gone', async () => {
    process.env.RATE_LIMIT_ATTEMPT_WINDOW_MS = String(EXPIRY_WINDOW_MS);
    resetEnvForTests();
    __resetAgentQuotaForTests();
    await observer.del(bearerKey, bearerRefundsKey);
    newApp();
    await waitForWindowHeadroom(EXPIRY_WINDOW_MS);
    const charge = await chargeBearerFailure({
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      headers: {},
    } as never);
    await waitForCounterExpiry(bearerKey, EXPIRY_WINDOW_MS);
    await charge.refund();
    // No counter and no compensation record were created.
    expect(await observer.exists(bearerKey)).toBe(0);
    expect(await observer.exists(bearerRefundsKey)).toBe(0);
  });
});
