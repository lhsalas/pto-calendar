import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type ManagedApp } from '../../src/server.js';
import { createPrismaClient } from '../../src/lib/prismaClient.js';
import { prisma as appPrisma } from '../../src/lib/prisma.js';
import { resetEnvForTests } from '../../src/config/env.js';
import { __resetAuthUserCacheForTests } from '../../src/middleware/requireAuth.js';
import {
  __resetAgentQuotaForTests,
  __useMemoryQuotaStoreForTests,
} from '../../src/middleware/agentQuota.js';
import { createTokenDatabase } from '../../src/services/tokens/tokenDatabase.js';
import {
  changeRoleAndInvalidate,
  issueToken,
  revokeAllTokens,
  revokeToken,
} from '../../src/services/tokens/tokenService.js';
import { TOKEN_SCOPES, type TokenScope } from '../../src/services/tokens/tokenDomain.js';
import { resetUserPassword, setupAccount } from '../../src/services/users/UserService.js';
import { trustedOperatorActor, type AuditActor } from '../../src/services/audit/auditContext.js';

const { logs } = vi.hoisted(() => ({ logs: [] as string[] }));
vi.mock('../../src/lib/logger.js', async () => {
  const { Writable } = await import('node:stream');
  const { pino } = await import('pino');
  return {
    logger: pino(
      { level: 'trace' },
      new Writable({
        write(chunk, _encoding, done) {
          logs.push(chunk.toString());
          done();
        },
      }),
    ),
  };
});
// Production configuration requires Redis. Replace only the external storage
// adapter, not the actual limiters, cookies, auth, CSRF, routes or PostgreSQL.
// This suite is NOT real-Redis certification.
vi.mock('ioredis', () => ({ Redis: class {} }));
vi.mock('rate-limit-redis', async () => {
  const { MemoryStore } = await import('express-rate-limit');
  return {
    RedisStore: class extends MemoryStore {
      constructor() {
        super();
      }
    },
  };
});

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Explicit disposable PostgreSQL DATABASE_URL is required');
const db = createPrismaClient(url);
const tokens = createTokenDatabase(url);
const roles = ['member', 'team_lead', 'admin'] as const;
const password = 'scoped-pat-integration-password';
const hash = bcrypt.hashSync(password, 4);
const users = [...roles, 'member' as const].map((role) => {
  const id = randomUUID();
  return {
    id,
    role,
    email: `scoped-pat-${id}@example.test`,
    name: `PAT ${role}`,
    colorCode: '#123456',
    passwordHash: hash,
  };
});
const ids = users.map((u) => u.id);
/** Attribution for a verified browser session; never derived from request data. */
function sessionActor(id: string): AuditActor {
  return { id, credential: { type: 'session' }, requestId: 'scoped-pat-integration' };
}
const foreignId = users[3]!.id;
const originalEnv = { ...process.env };
const apps: ManagedApp[] = [];
const day = { startDate: '2026-12-01', endDate: '2026-12-01', dayPart: 'all_day' as const };
let app: ManagedApp;
function newApp(overrides: Record<string, string> = {}) {
  Object.assign(process.env, overrides);
  resetEnvForTests();
  const created = createApp();
  apps.push(created);
  return created;
}

async function makeRecord(userId: string) {
  return db.pTORequest.create({
    data: {
      userId,
      startDate: new Date(day.startDate),
      endDate: new Date(day.endDate),
      dayPart: 'all_day',
      note: 'stored private note',
    },
  });
}
async function mint(index: number, scopes: readonly TokenScope[] = ['pto:read']) {
  return issueToken(tokens, sessionActor(users[index]!.id), 0, {
    name: 'Integration',
    scopes: [...scopes],
  });
}
function confidential(res: request.Response) {
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.headers['x-request-id']).toMatch(/^[A-Za-z0-9._-]{1,200}$/);
}
async function cookie(target = app, production = false) {
  const req = request(target).post('/auth/login').send({ email: users[0]!.email, password });
  if (production) req.set('Origin', 'https://pto.example.test').set('X-Forwarded-Proto', 'https');
  const res = await req.expect(200);
  const cookies = res.headers['set-cookie'] as unknown as string[];
  return cookies.map((entry) => entry.split(';')[0]).join('; ');
}

const profiles: { label: string; scopes: TokenScope[] }[] = [
  { label: 'read', scopes: ['pto:read'] },
  { label: 'notes+read', scopes: ['pto:read', 'pto:notes:read'] },
  { label: 'create', scopes: ['pto:create'] },
  { label: 'update-self', scopes: ['pto:update:self'] },
  { label: 'delete-self', scopes: ['pto:delete:self'] },
  { label: 'update-team', scopes: ['pto:update:team'] },
  { label: 'delete-team', scopes: ['pto:delete:team'] },
  { label: 'write-only', scopes: ['pto:create', 'pto:update:self', 'pto:delete:self'] },
  {
    label: 'notes+self-writes',
    scopes: ['pto:read', 'pto:notes:read', 'pto:create', 'pto:update:self', 'pto:delete:self'],
  },
  { label: 'notes+all-writes', scopes: [...TOKEN_SCOPES] },
];
const matrix = roles.flatMap((role, index) =>
  [true, false].flatMap((own) =>
    profiles.map(({ label, scopes }) => ({ role, index, own, label, scopes })),
  ),
);

describe('scoped PAT HTTP authorization on PostgreSQL', () => {
  beforeAll(async () => {
    await db.user.createMany({ data: users });
  });
  beforeEach(async () => {
    Object.assign(process.env, originalEnv, {
      NODE_ENV: 'test',
      DATABASE_URL: url,
      PAT_AUTH_ENABLED: 'true',
      PAT_WRITES_ENABLED: 'true',
      COOKIE_SECURE: 'false',
      CORS_ORIGIN: 'http://localhost:5173',
      AUTH_RATE_LIMIT_MAX: '1000',
      RATE_LIMIT_MAX: '10000',
      RATE_LIMIT_BEARER_FAILURE_MAX: '1000',
      RATE_LIMIT_USER_QUOTA_MAX: '100000',
      RATE_LIMIT_TOKEN_QUOTA_MAX: '100000',
      RATE_LIMIT_TOKEN_ISSUANCE_MAX: '1000',
      RATE_LIMIT_TOKEN_PASSWORD_MAX: '1000',
    });
    delete process.env.RATE_LIMIT_REDIS_URL;
    resetEnvForTests();
    __resetAuthUserCacheForTests();
    __resetAgentQuotaForTests();
    // This suite substitutes the external storage adapter with the local
    // counter, exactly as it substitutes the limiter store below. The
    // dedicated real-Redis suite is the certification of the shared store.
    __useMemoryQuotaStoreForTests();
    logs.length = 0;
    await db.auditLog.deleteMany({ where: { actorUserId: { in: ids } } });
    await db.pTORequest.deleteMany({ where: { userId: { in: ids } } });
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
    app = newApp();
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((owned) => owned.closeResources()));
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    try {
      await db.auditLog.deleteMany({ where: { actorUserId: { in: ids } } });
      await db.pTORequest.deleteMany({ where: { userId: { in: ids } } });
      await db.personalAccessToken.deleteMany({ where: { ownerId: { in: ids } } });
      await db.user.deleteMany({ where: { id: { in: ids } } });
    } finally {
      await Promise.all([tokens.close(), db.$disconnect(), appPrisma.$disconnect()]);
      process.env = { ...originalEnv };
      resetEnvForTests();
      __resetAuthUserCacheForTests();
    }
  });

  // 3 roles x 2 ownerships x 10 profiles x every method. Member/team combinations
  // cannot be issued. Corrupting only stored scopes additionally proves those
  // impossible credentials fail authentication on every HTTP operation.
  it.each(matrix)(
    '$role / own=$own / $label: list, detail, create, PUT and DELETE',
    async ({ role, index, own, scopes }) => {
      const memberTeam = role === 'member' && scopes.some((scope) => scope.endsWith(':team'));
      const issued = await mint(index, memberTeam ? ['pto:read'] : scopes);
      if (memberTeam)
        await db.personalAccessToken.update({ where: { id: issued.token.id }, data: { scopes } });
      const bearer = `Bearer ${issued.rawToken}`;
      const record = await makeRecord(own ? users[index]!.id : foreignId);
      const has = (scope: TokenScope) => scopes.includes(scope);
      const denial = memberTeam ? 401 : 403;
      const canRead = !memberTeam && has('pto:read');
      const canCreate = !memberTeam && has('pto:create');
      const canWrite = (operation: 'update' | 'delete') =>
        !memberTeam &&
        ((own && has(`pto:${operation}:self`)) ||
          (role !== 'member' && has(`pto:${operation}:team`)));
      const list = await request(app)
        .get('/pto?start=2026-12-01&end=2026-12-31')
        .set('Authorization', bearer)
        .expect(canRead ? 200 : denial);
      confidential(list);
      if (canRead)
        expect(list.body.every((item: { note: unknown }) => item.note === null)).toBe(true);
      const detail = await request(app)
        .get(`/pto/${record.id}`)
        .set('Authorization', bearer)
        .expect(canRead ? 200 : denial);
      if (canRead)
        expect(detail.body.note).toBe(
          has('pto:notes:read') && (own || role !== 'member') ? 'stored private note' : null,
        );
      const created = await request(app)
        .post('/pto')
        .set('Authorization', bearer)
        .send({
          startDate: '2026-12-08',
          endDate: '2026-12-08',
          dayPart: 'all_day',
          note: 'submitted note',
          userId: foreignId,
          role: 'admin',
        })
        .expect(canCreate ? 201 : denial);
      if (canCreate) {
        expect(created.body.userId).toBe(users[index]!.id);
        expect(created.body.note).toBe(has('pto:notes:read') ? 'submitted note' : null);
      }
      const updated = await request(app)
        .put(`/pto/${record.id}`)
        .set('Authorization', bearer)
        .send(day)
        .expect(canWrite('update') ? 200 : denial);
      if (canWrite('update'))
        expect(updated.body.note).toBe(has('pto:notes:read') ? 'stored private note' : null);
      expect((await db.pTORequest.findUniqueOrThrow({ where: { id: record.id } })).note).toBe(
        'stored private note',
      );
      const noteWrite = await request(app)
        .put(`/pto/${record.id}`)
        .set('Authorization', bearer)
        .send({ ...day, note: 'replacement private note' })
        .expect(canWrite('update') ? 200 : denial);
      if (canWrite('update'))
        expect(noteWrite.body.note).toBe(has('pto:notes:read') ? 'replacement private note' : null);
      expect((await db.pTORequest.findUniqueOrThrow({ where: { id: record.id } })).note).toBe(
        canWrite('update') ? 'replacement private note' : 'stored private note',
      );
      const deleted = await request(app)
        .delete(`/pto/${record.id}`)
        .set('Authorization', bearer)
        .expect(canWrite('delete') ? 204 : denial);
      for (const res of [detail, created, updated, noteWrite, deleted]) confidential(res);
      expect(await db.pTORequest.findUnique({ where: { id: record.id } })).toEqual(
        canWrite('delete') ? null : expect.objectContaining({ userId: record.userId }),
      );
      for (const res of [list, detail, created, updated, noteWrite, deleted]) {
        if (res.status === 403) expect(res.body.error.code).toBe('FORBIDDEN');
      }
    },
  );

  it('returns safe identity/scopes/absolute expiry without a read requirement or a browser credential version', async () => {
    const issued = await mint(0, ['pto:create']);
    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${issued.rawToken}`)
      .expect(200);
    confidential(res);
    expect(res.body).toEqual({
      id: users[0]!.id,
      role: 'member',
      auth: {
        method: 'pat',
        tokenId: issued.token.id,
        scopes: ['pto:create'],
        expiresAt: issued.token.expiresAt.toISOString(),
      },
    });
    expect(JSON.stringify(res.body)).not.toContain(issued.rawToken);
    expect(res.body).not.toHaveProperty('sessionVersion');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('denies every unclassified path/method including implicit HEAD, OPTIONS, management and future routes', async () => {
    const issued = await mint(2, TOKEN_SCOPES);
    const bearer = `Bearer ${issued.rawToken}`;
    for (const path of [
      '/users',
      '/holidays',
      '/auth/tokens',
      '/auth/tokens/revoke-all',
      '/auth/login',
      '/auth/setup-account',
      '/auth/logout',
      '/health',
      '/ready',
      '/future',
      '/pto/future',
    ]) {
      confidential(await request(app).get(path).set('Authorization', bearer).expect(401));
      confidential(await request(app).post(path).set('Authorization', bearer).send({}).expect(401));
    }
    for (const path of ['/pto', '/auth/me', `/pto/${randomUUID()}`]) {
      await request(app).head(path).set('Authorization', bearer).expect(401);
      confidential(await request(app).options(path).set('Authorization', bearer).expect(401));
      confidential(
        await request(app).patch(path).set('Authorization', bearer).send({}).expect(401),
      );
    }
    // Cookie-free browser preflight remains the same CORS policy and 204 status.
    const preflight = await request(app)
      .options('/pto')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .expect(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('rejects absent/empty/duplicate/malformed/mixed credentials without falling back to a valid signed cookie', async () => {
    const issued = await mint(0);
    const validCookie = await cookie();
    confidential(await request(app).get('/pto').set('Authorization', '').expect(401));
    await request(app).get('/pto').expect(401);
    const headers = [
      'Basic invalid',
      'Bearer invalid',
      `Bearer ${issued.rawToken}`,
      `Bearer ${issued.rawToken}, Bearer invalid`,
    ];
    for (const authorization of headers)
      confidential(
        await request(app)
          .get('/auth/me')
          .set('Authorization', authorization)
          .set('Cookie', validCookie)
          .expect(401),
      );
    for (const value of ['', 'unrelated=x', 'session=invalid'])
      confidential(
        await request(app)
          .get('/auth/me')
          .set('Authorization', `Bearer ${issued.rawToken}`)
          .set('Cookie', value)
          .expect(401),
      );
    confidential(
      await request(app)
        .get('/auth/me')
        .set('Authorization', [
          `Bearer ${issued.rawToken}`,
          `Bearer ${issued.rawToken}`,
        ] as unknown as string)
        .expect(401),
    );
    await request(app).get('/auth/me').set('Cookie', validCookie).expect(200);
    expect(logs.join('')).not.toContain(issued.rawToken);
    expect(logs.join('')).not.toContain(validCookie);
  });

  it('keeps both flags independent: existing write scopes do not mutate when writes are disabled, and auth-off denies all PATs', async () => {
    const record = await makeRecord(users[2]!.id);
    const issued = await mint(2, TOKEN_SCOPES);
    const readonly = newApp({ PAT_WRITES_ENABLED: 'false' });
    const bearer = `Bearer ${issued.rawToken}`;
    await request(readonly).get('/auth/me').set('Authorization', bearer).expect(200);
    for (const operation of [
      request(readonly).post('/pto').send({ startDate: '2026-12-08', endDate: '2026-12-08' }),
      request(readonly).put(`/pto/${record.id}`).send(day),
      request(readonly).delete(`/pto/${record.id}`),
    ])
      confidential(await operation.set('Authorization', bearer).expect(403));
    expect(await db.pTORequest.count({ where: { userId: users[2]!.id } })).toBe(1);
    const disabled = newApp({ PAT_AUTH_ENABLED: 'false', PAT_WRITES_ENABLED: 'true' });
    confidential(await request(disabled).get('/auth/me').set('Authorization', bearer).expect(401));
    confidential(
      await request(disabled).post('/pto').set('Authorization', bearer).send(day).expect(401),
    );
    // Browser access is unchanged by either switch.
    const validCookie = await cookie(disabled);
    await request(disabled).get('/auth/me').set('Cookie', validCookie).expect(200);
  });

  it('applies revocation, expiry, password/version changes and demote/promote invalidation immediately across application instances', async () => {
    const other = newApp();
    const denied = async (raw: string) => {
      for (const target of [app, other])
        confidential(
          await request(target).get('/auth/me').set('Authorization', `Bearer ${raw}`).expect(401),
        );
    };
    const first = await mint(0);
    await request(app).get('/auth/me').set('Authorization', `Bearer ${first.rawToken}`).expect(200);
    await revokeToken(tokens, sessionActor(users[0]!.id), first.token.id);
    await denied(first.rawToken);
    const all = await mint(0);
    await revokeAllTokens(tokens, sessionActor(users[0]!.id));
    await denied(all.rawToken);
    const expired = await mint(0);
    const past = new Date(Date.now() - 2 * 86400000);
    await db.personalAccessToken.update({
      where: { id: expired.token.id },
      data: { createdAt: past, expiresAt: new Date(past.getTime() + 86400000) },
    });
    await denied(expired.rawToken);
    const passwordless = await mint(0);
    await db.user.update({ where: { id: users[0]!.id }, data: { passwordHash: null } });
    await denied(passwordless.rawToken);
    await db.user.update({
      where: { id: users[0]!.id },
      data: { passwordHash: hash, sessionVersion: 1 },
    });
    await denied(passwordless.rawToken);
    const lead = await mint(1, ['pto:read', 'pto:update:team']);
    await changeRoleAndInvalidate(
      tokens,
      users[1]!.id,
      'member',
      trustedOperatorActor(users[2]!.id),
    );
    await denied(lead.rawToken);
    await changeRoleAndInvalidate(
      tokens,
      users[1]!.id,
      'team_lead',
      trustedOperatorActor(users[2]!.id),
    );
    await denied(lead.rawToken);
  });

  it('does not reuse the browser role cache and keeps old tokens invalid after reset/setup', async () => {
    const issued = await mint(1, ['pto:read', 'pto:notes:read']);
    const record = await makeRecord(foreignId);
    await request(app)
      .get(`/pto/${record.id}`)
      .set('Authorization', `Bearer ${issued.rawToken}`)
      .expect(200);
    // Defense in depth for an operational role change that omitted invalidation:
    // verification still uses live role, not the browser cache.
    await db.user.update({ where: { id: users[1]!.id }, data: { role: 'member' } });
    const demoted = await request(app)
      .get(`/pto/${record.id}`)
      .set('Authorization', `Bearer ${issued.rawToken}`)
      .expect(200);
    expect(demoted.body.note).toBeNull();
    const reset = await resetUserPassword(users[1]!.id, sessionActor(users[2]!.id));
    confidential(
      await request(app)
        .get('/auth/me')
        .set('Authorization', `Bearer ${issued.rawToken}`)
        .expect(401),
    );
    await setupAccount(
      { token: reset.setupToken.plaintext, password: 'new-scoped-pat-password' },
      { requestId: 'scoped-pat-integration' },
    );
    confidential(
      await request(app)
        .get('/auth/me')
        .set('Authorization', `Bearer ${issued.rawToken}`)
        .expect(401),
    );
  });

  it('fails closed on an actual PostgreSQL query error without leaking credentials, private SQL or raw diagnostics', async () => {
    const issued = await mint(0);
    const badUrl = new URL(url);
    badUrl.searchParams.set('schema', `missing_pat_${randomUUID().replaceAll('-', '')}`);
    const unavailable = newApp({ DATABASE_URL: badUrl.toString() });
    const res = await request(unavailable)
      .get('/auth/me')
      .set('Authorization', `Bearer ${issued.rawToken}`)
      .expect(401);
    confidential(res);
    expect(res.body).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' },
    });
    expect(logs.join('')).not.toContain(issued.rawToken);
    expect(logs.join('')).not.toContain('secret_digest');
    expect(logs.join('')).not.toContain('does not exist');
    expect(logs.join('')).not.toContain(badUrl.toString());
  });

  it('uses real production CSRF/cookies with verified cookie-free PAT exemption and foreign-Origin rejection', async () => {
    const production = newApp({
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      INSECURE_COOKIES_ALLOWED: 'false',
      BCRYPT_ROUNDS: '10',
      CORS_ORIGIN: 'https://pto.example.test',
      TRUST_PROXY_HOPS: '1',
      RATE_LIMIT_REDIS_URL: 'rediss://redis-adapter.invalid:6379/0',
    });
    const validCookie = await cookie(production, true);
    const sessionDenied = await request(production)
      .post('/pto')
      .set('Cookie', validCookie)
      .send(day)
      .expect(403);
    expect(sessionDenied.body.error.code).toBe('CSRF_REJECTED');
    await request(production)
      .post('/pto')
      .set('Cookie', validCookie)
      .set('Origin', 'https://pto.example.test')
      .send(day)
      .expect(201);
    const issued = await mint(0, ['pto:create']);
    const bearer = `Bearer ${issued.rawToken}`;
    const nextDay = { startDate: '2026-12-08', endDate: '2026-12-08', dayPart: 'all_day' };
    confidential(
      await request(production).post('/pto').set('Authorization', bearer).send(nextDay).expect(201),
    );
    for (const headers of [
      { Authorization: bearer, Origin: 'https://foreign.test' },
      { Authorization: bearer, Cookie: validCookie },
      { Authorization: 'Bearer invalid', Cookie: validCookie },
      { Authorization: 'Bearer invalid' },
    ])
      confidential(
        await request(production)
          .post('/pto')
          .set(headers)
          .send(nextDay)
          .expect('Origin' in headers ? 403 : 401),
      );
    for (const state of ['revoked', 'expired', 'version', 'role', 'database'] as const) {
      const candidate = await mint(1, ['pto:create']);
      if (state === 'revoked')
        await revokeToken(tokens, sessionActor(users[1]!.id), candidate.token.id);
      if (state === 'expired') {
        const past = new Date(Date.now() - 2 * 86400000);
        await db.personalAccessToken.update({
          where: { id: candidate.token.id },
          data: { createdAt: past, expiresAt: new Date(past.getTime() + 86400000) },
        });
      }
      if (state === 'version')
        await db.user.update({ where: { id: users[1]!.id }, data: { sessionVersion: 1 } });
      if (state === 'role')
        await changeRoleAndInvalidate(
          tokens,
          users[1]!.id,
          'member',
          trustedOperatorActor(users[2]!.id),
        );
      if (state === 'database') await production.closeResources();
      confidential(
        await request(production)
          .post('/pto')
          .set('Authorization', `Bearer ${candidate.rawToken}`)
          .send(nextDay)
          .expect(401),
      );
      await db.user.update({
        where: { id: users[1]!.id },
        data: { role: 'team_lead', sessionVersion: 0 },
      });
    }
    expect(await db.pTORequest.count({ where: { userId: users[0]!.id } })).toBe(2);
    expect(logs.join('')).not.toContain(issued.rawToken);
    expect(logs.join('')).not.toContain(validCookie);
  });
});
