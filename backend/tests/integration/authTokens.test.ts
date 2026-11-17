import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type ManagedApp } from '../../src/server.js';
import { createPrismaClient } from '../../src/lib/prismaClient.js';
import { prisma as appPrisma } from '../../src/lib/prisma.js';
import { resetEnvForTests } from '../../src/config/env.js';
import { __resetAuthUserCacheForTests } from '../../src/middleware/requireAuth.js';
import { createTokenDatabase } from '../../src/services/tokens/tokenDatabase.js';
import { changeRoleAndInvalidate, verifyToken } from '../../src/services/tokens/tokenService.js';
import { resetUserPassword, setupAccount } from '../../src/services/users/UserService.js';
import { logger } from '../../src/lib/logger.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Explicit disposable integration DATABASE_URL is required');
const db = createPrismaClient(url);
const verifier = createTokenDatabase(url);
const password = 'token-management-integration-password';
const hash = bcrypt.hashSync(password, 4);
const users = (['member', 'team_lead', 'admin'] as const).map((role) => {
  const id = randomUUID();
  return {
    id,
    role,
    email: `token-api-${id}@example.test`,
    name: `Token ${role}`,
    colorCode: '#123456',
    passwordHash: hash,
  };
});
const ids = users.map((u) => u.id);
const originalAuthMax = process.env.AUTH_RATE_LIMIT_MAX;
const originalGlobalMax = process.env.RATE_LIMIT_MAX;
let app: ManagedApp;

function confidential(res: request.Response): void {
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.headers['x-request-id']).toMatch(/^[A-Za-z0-9._-]{1,200}$/);
}

async function login(
  role: (typeof users)[number]['role'] = 'member',
  target = app,
  currentPassword = password,
) {
  const user = users.find((u) => u.role === role)!;
  const agent = request.agent(target);
  await agent
    .post('/auth/login')
    .send({ email: user.email, password: currentPassword })
    .expect(200);
  return agent;
}

describe('session-only personal token management on PostgreSQL', () => {
  beforeAll(async () => {
    await db.user.createMany({ data: users });
  });
  beforeEach(async () => {
    process.env.AUTH_RATE_LIMIT_MAX = '1000';
    process.env.RATE_LIMIT_MAX = '10000';
    resetEnvForTests();
    __resetAuthUserCacheForTests();
    await db.personalAccessToken.deleteMany({ where: { ownerId: { in: ids } } });
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
    app = createApp();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app.closeResources();
  });
  afterAll(async () => {
    try {
      await db.personalAccessToken.deleteMany({ where: { ownerId: { in: ids } } });
      await db.user.deleteMany({ where: { id: { in: ids } } });
    } finally {
      await Promise.all([verifier.close(), db.$disconnect(), appPrisma.$disconnect()]);
      if (originalAuthMax === undefined) delete process.env.AUTH_RATE_LIMIT_MAX;
      else process.env.AUTH_RATE_LIMIT_MAX = originalAuthMax;
      if (originalGlobalMax === undefined) delete process.env.RATE_LIMIT_MAX;
      else process.env.RATE_LIMIT_MAX = originalGlobalMax;
      resetEnvForTests();
      __resetAuthUserCacheForTests();
    }
  });

  it.each(['member', 'team_lead', 'admin'] as const)(
    'lets %s manage only their own show-once credentials',
    async (role) => {
      const agent = await login(role);
      const issued = await agent
        .post('/auth/tokens')
        .send({ name: 'Laptop', password })
        .expect(201);
      confidential(issued);
      expect(issued.body.rawToken).toMatch(/^pto_pat_[a-f0-9-]{36}\.[a-f0-9]{64}$/);
      expect(issued.body.token.scopes).toEqual(['pto:read']);
      expect(
        new Date(issued.body.token.expiresAt).getTime() -
          new Date(issued.body.token.createdAt).getTime(),
      ).toBe(90 * 86400000);
      const stored = await db.personalAccessToken.findUniqueOrThrow({
        where: { id: issued.body.token.id },
      });
      expect(JSON.stringify(stored)).not.toContain(issued.body.rawToken);
      const listed = await agent.get('/auth/tokens').expect(200);
      confidential(listed);
      expect(listed.body.tokens.map((t: { id: string }) => t.id)).toEqual([issued.body.token.id]);
      expect(JSON.stringify(listed.body)).not.toContain(issued.body.rawToken);
      expect(JSON.stringify(listed.body)).not.toContain(stored.secretDigest);
      expect(JSON.stringify(issued.body)).not.toContain(password);
      const other = await login(role === 'member' ? 'team_lead' : 'member');
      const foreign = await other.delete(`/auth/tokens/${issued.body.token.id}`).expect(404);
      const unknown = await other.delete(`/auth/tokens/${randomUUID()}`).expect(404);
      expect(foreign.body).toEqual(unknown.body);
      confidential(foreign);
      expect(await verifyToken(verifier, issued.body.rawToken)).not.toBeNull();
      confidential(await agent.delete(`/auth/tokens/${issued.body.token.id}`).expect(204));
      confidential(await agent.delete(`/auth/tokens/${issued.body.token.id}`).expect(204));
      expect(await verifyToken(verifier, issued.body.rawToken)).toBeNull();
    },
  );

  it('requires current passwords every time, preserves show-once secrecy and keeps logout separate from revocation', async () => {
    const agent = await login();
    const bad = await agent
      .post('/auth/tokens')
      .send({ name: 'Laptop', password: 'wrong' })
      .expect(401);
    confidential(bad);
    const issued = await agent.post('/auth/tokens').send({ name: 'Laptop', password }).expect(201);
    const missing = await agent.post('/auth/tokens').send({ name: 'Again' }).expect(400);
    confidential(missing);
    await agent.post('/auth/logout').expect(204);
    confidential(await agent.get('/auth/tokens').expect(401));
    expect(await verifyToken(verifier, issued.body.rawToken)).not.toBeNull();
    const replacementSession = await login();
    confidential(await replacementSession.post('/auth/tokens/revoke-all').expect(204));
    expect(await verifyToken(verifier, issued.body.rawToken)).toBeNull();
  });

  it('serializes eleven concurrent HTTP issuances to ten and restores capacity after revocation', async () => {
    const agent = await login();
    const results = await Promise.all(
      Array.from({ length: 11 }, (_, i) =>
        agent.post('/auth/tokens').send({ name: `Concurrent-${i}`, password }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    expect(results.filter((r) => r.status === 409)).toHaveLength(1);
    results.forEach(confidential);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('TOKEN_LIMIT_REACHED');
    const first = results.find((r) => r.status === 201)!;
    await agent.delete(`/auth/tokens/${first.body.token.id}`).expect(204);
    await agent.post('/auth/tokens').send({ name: 'Replacement', password }).expect(201);
  });

  it('rejects scope/owner/lifetime spoofing and grants explicit team scopes only to live elevated roles', async () => {
    const agent = await login();
    for (const extra of [
      { userId: users[1]!.id },
      { role: 'admin' },
      { ownerId: users[1]!.id },
      { scopes: ['unknown'] },
      { scopes: ['pto:notes:read'] },
      { scopes: ['pto:read', 'pto:read'] },
      { expiresInDays: 0 },
      { expiresInDays: -1 },
      { expiresInDays: 366 },
      { expiresInDays: 1.2 },
      { createdAt: new Date().toISOString() },
    ])
      confidential(
        await agent
          .post('/auth/tokens')
          .send({ name: 'Bad', password, ...extra })
          .expect(400),
      );
    confidential(
      await agent
        .post('/auth/tokens')
        .send({ name: 'Team', password, scopes: ['pto:update:team'] })
        .expect(403),
    );
    const lead = await login('team_lead');
    const maximum = await lead
      .post('/auth/tokens')
      .send({
        name: 'Team',
        password,
        scopes: ['pto:read', 'pto:notes:read', 'pto:update:team'],
        expiresInDays: 365,
      })
      .expect(201);
    expect(
      new Date(maximum.body.token.expiresAt).getTime() -
        new Date(maximum.body.token.createdAt).getTime(),
    ).toBe(365 * 86400000);
    await changeRoleAndInvalidate(verifier, users[1]!.id, 'member');
    await changeRoleAndInvalidate(verifier, users[1]!.id, 'team_lead');
    confidential(await lead.post('/auth/tokens').send({ name: 'Stale', password }).expect(401));
    expect(await verifyToken(verifier, maximum.body.rawToken)).toBeNull();
  });

  it('rejects bearer-only, mixed and malformed credentials on every management operation', async () => {
    const agent = await login();
    const issued = await agent.post('/auth/tokens').send({ name: 'Laptop', password }).expect(201);
    for (const authorization of [`Bearer ${issued.body.rawToken}`, 'Bearer invalid', '']) {
      confidential(
        await request(app).get('/auth/tokens').set('Authorization', authorization).expect(401),
      );
      confidential(await agent.get('/auth/tokens').set('Authorization', authorization).expect(401));
      confidential(
        await agent
          .post('/auth/tokens')
          .set('Authorization', authorization)
          .send({ name: 'Denied', password })
          .expect(401),
      );
      confidential(
        await agent
          .delete(`/auth/tokens/${issued.body.token.id}`)
          .set('Authorization', authorization)
          .expect(401),
      );
      confidential(
        await agent.post('/auth/tokens/revoke-all').set('Authorization', authorization).expect(401),
      );
    }
    expect(await verifyToken(verifier, issued.body.rawToken)).not.toBeNull();
  });

  it('keeps no-store/correlation on CSRF, parser, validation and rate-limit failures without secret error logging', async () => {
    const spy = vi.spyOn(logger, 'error');
    const agent = await login();
    confidential(
      await agent
        .post('/auth/tokens')
        .set('Origin', 'https://foreign.example')
        .send({ name: 'Laptop', password })
        .expect(403),
    );
    const malformed = await agent
      .post('/auth/tokens')
      .set('Content-Type', 'application/json')
      .send(`{"password":"${password}"`)
      .expect(400);
    confidential(malformed);
    expect(JSON.stringify(malformed.body)).not.toContain(password);
    confidential(
      await agent
        .post('/auth/tokens')
        .send({ password: 'x'.repeat(110000) })
        .expect(413),
    );
    confidential(await agent.get('/auth/tokens?userId=other').expect(400));
    process.env.AUTH_RATE_LIMIT_MAX = '2';
    resetEnvForTests();
    const limitedApp = createApp();
    try {
      const limited = await login('member', limitedApp);
      for (let i = 0; i < 2; i += 1)
        await limited.post('/auth/tokens').send({ name: 'Wrong', password: 'wrong' }).expect(401);
      const denial = await limited
        .post('/auth/tokens')
        .send({ name: 'Wrong', password: 'wrong' })
        .expect(429);
      confidential(denial);
      expect(denial.headers['retry-after']).toBeDefined();
      confidential(await limited.post('/auth/tokens/revoke-all').expect(204));
    } finally {
      await limitedApp.closeResources();
    }
    expect(JSON.stringify(spy.mock.calls)).not.toContain(password);
  });

  it('invalidates browser issuance and old tokens through reset/setup rather than minting for an old session', async () => {
    const agent = await login();
    const issued = await agent
      .post('/auth/tokens')
      .send({ name: 'Before reset', password })
      .expect(201);
    const reset = await resetUserPassword(users[0]!.id);
    confidential(
      await agent.post('/auth/tokens').send({ name: 'Old credentials', password }).expect(401),
    );
    expect(await verifyToken(verifier, issued.body.rawToken)).toBeNull();
    const nextPassword = 'new-token-management-password';
    await setupAccount({ token: reset.setupToken.plaintext, password: nextPassword });
    const fresh = await login('member', app, nextPassword);
    confidential(
      await fresh
        .post('/auth/tokens')
        .send({ name: 'New credentials', password: nextPassword })
        .expect(201),
    );
  });
});
