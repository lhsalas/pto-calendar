import type { Request, Response } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetEnvForTests } from '../config/env.js';
import { patFixture } from '../../tests/unit/helpers/patFixture.js';
import { __resetAgentQuotaForTests } from './agentQuota.js';
import { createPatAuth, hasAuthorization } from './patAuth.js';

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvForTests();
  __resetAgentQuotaForTests();
});
function fixture(options: Parameters<typeof patFixture>[0] = {}) {
  const f = patFixture(options);
  f.app.all(['/pto', '/auth/me'], (req, res) =>
    res.json({ auth: req.auth, browserUser: req.user ?? null }),
  );
  f.app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND' } }));
  f.finish();
  return f;
}

describe('strict bearer selection and database-backed verification', () => {
  it('exposes a typed safe context, preserves correlation and checks the database on every request', async () => {
    const f = fixture();
    for (let i = 0; i < 2; i += 1) {
      const res = await request(f.app)
        .get('/pto')
        .set('Authorization', `Bearer ${f.material.rawToken}`)
        .expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.auth).toEqual({
        method: 'pat',
        actor: { id: f.owner.id, role: 'member' },
        requestId: res.headers['x-request-id'],
        tokenId: f.token.id,
        scopes: ['pto:read'],
        expiresAt: f.token.expiresAt.toISOString(),
      });
      expect(res.body.browserUser).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain(f.material.rawToken);
      expect(res.body.auth.actor).not.toHaveProperty('sessionVersion');
    }
    expect(f.query).toHaveBeenCalledTimes(4);
    const trace = await request(f.app)
      .get('/auth/me')
      .set('Authorization', `bearer ${f.material.rawToken}`)
      .set('X-Request-Id', 'safe-inbound-trace')
      .expect(200);
    expect(trace.body.auth.requestId).toBe('safe-inbound-trace');
  });

  it('rejects malformed, combined, duplicate and missing-normalized headers without cookie fallback', async () => {
    const f = fixture();
    for (const header of [
      '',
      'Basic test',
      'Bearer invalid',
      'Bearer',
      `Bearer  ${f.material.rawToken}`,
      `Bearer ${f.material.rawToken}, Bearer ${f.material.rawToken}`,
    ]) {
      const res = await request(f.app).get('/pto').set('Authorization', header).expect(401);
      expect(res.body).toEqual({
        error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' },
      });
      expect(res.headers['x-request-id']).toBeDefined();
    }
    const duplicate = await request(f.app)
      .get('/pto')
      .set('Authorization', [
        `Bearer ${f.material.rawToken}`,
        `Bearer ${f.material.rawToken}`,
      ] as unknown as string)
      .expect(401);
    expect(duplicate.headers['cache-control']).toBe('no-store');
    for (const header of [undefined, ['Bearer array']]) {
      const req = {
        headers: { authorization: header },
        rawHeaders: ['Authorization', 'Bearer raw'],
        method: 'GET',
        path: '/pto',
      } as unknown as Request;
      await expect(
        Promise.resolve(createPatAuth(f.runtime)(req, {} as Response, vi.fn())),
      ).rejects.toMatchObject({ status: 401 });
    }
    expect(f.query).not.toHaveBeenCalled();
  });

  it('rejects any cookie header, including empty/invalid cookies, or a simultaneously installed session', async () => {
    const f = fixture();
    for (const cookie of ['', 'session=invalid', 'unrelated=value']) {
      await request(f.app)
        .get('/pto')
        .set('Authorization', `Bearer ${f.material.rawToken}`)
        .set('Cookie', cookie)
        .expect(401);
    }
    f.setSession({ id: f.owner.id, role: 'member', sessionVersion: 0 });
    await request(f.app)
      .get('/pto')
      .set('Authorization', `Bearer ${f.material.rawToken}`)
      .expect(401);
    expect(f.query).not.toHaveBeenCalled();
  });

  it('denies ineligible paths and methods, not merely sensitive route prefixes', async () => {
    const f = fixture();
    for (const path of [
      '/users',
      '/holidays',
      '/health',
      '/ready',
      '/auth/tokens',
      '/auth/login',
      '/auth/setup-account',
      '/auth/logout',
      '/future',
      '/pto/new-route',
      '/pto/uuid/extra',
    ]) {
      const denied = await request(f.app)
        .get(path)
        .set('Authorization', `Bearer ${f.material.rawToken}`)
        .expect(401);
      expect(denied.headers['x-request-id']).toBeDefined();
    }
    for (const method of ['head', 'options', 'patch'] as const) {
      await request(f.app)
        [method]('/pto')
        .set('Authorization', `Bearer ${f.material.rawToken}`)
        .expect(401);
    }
    expect(f.query).not.toHaveBeenCalled();
    await request(f.app).options('/pto').expect(204);
    await request(f.app).get('/future').expect(404);
  });

  it('fails closed for invalid, revoked, expired, passwordless or version-mismatched owners and database errors', async () => {
    for (const kind of [
      'digest',
      'revoked',
      'expired',
      'passwordless',
      'version',
      'read-failure',
      'write-failure',
      'pool-failure',
    ]) {
      const f = fixture();
      if (kind === 'digest') f.token.secretDigest = '0'.repeat(64);
      if (kind === 'revoked') f.token.revokedAt = new Date();
      if (kind === 'expired') f.token.expiresAt = new Date(0);
      if (kind === 'passwordless') f.owner.passwordHash = null;
      if (kind === 'version') f.owner.sessionVersion = 1;
      if (kind === 'read-failure') f.query.mockRejectedValueOnce(new Error(f.material.rawToken));
      if (kind === 'write-failure')
        f.query
          .mockImplementationOnce(async () => ({
            rows: [{ ...f.owner, ...f.token }],
            rowCount: 1,
          }))
          .mockRejectedValueOnce(new Error(f.material.rawToken));
      if (kind === 'pool-failure')
        f.runtime.get.mockImplementationOnce(() => {
          throw new Error(f.material.rawToken);
        });
      const res = await request(f.app)
        .get('/pto')
        .set('Authorization', `Bearer ${f.material.rawToken}`)
        .expect(401);
      expect(JSON.stringify(res.body)).not.toContain(f.material.rawToken);
    }
  });

  it('enforces rollout flags separately from scopes and never falls through a failed bearer', async () => {
    const disabled = fixture({ auth: false, writes: true });
    await request(disabled.app)
      .get('/pto')
      .set('Authorization', `Bearer ${disabled.material.rawToken}`)
      .expect(401);
    expect(disabled.query).not.toHaveBeenCalled();
    const readonly = fixture({ scopes: ['pto:create'], writes: false });
    await request(readonly.app)
      .post('/pto')
      .set('Authorization', `Bearer ${readonly.material.rawToken}`)
      .expect(403);
    const wrongScope = fixture({ scopes: ['pto:create'] });
    await request(wrongScope.app)
      .get('/pto')
      .set('Authorization', `Bearer ${wrongScope.material.rawToken}`)
      .expect(403);
    const identity = await request(wrongScope.app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${wrongScope.material.rawToken}`)
      .expect(200);
    expect(identity.body.auth.scopes).toEqual(['pto:create']);
    const write = fixture({ scopes: ['pto:create'] });
    await request(write.app)
      .post('/pto')
      .set('Authorization', `Bearer ${write.material.rawToken}`)
      .expect(200);
  });

  it('preserves foreign-Origin rejection for verified writes and sanitizes early parser errors', async () => {
    const f = fixture({ scopes: ['pto:create'] });
    const csrf = await request(f.app)
      .post('/pto')
      .set('Authorization', `Bearer ${f.material.rawToken}`)
      .set('Origin', 'https://foreign.example')
      .expect(403);
    expect(csrf.body.error.code).toBe('CSRF_REJECTED');
    const parser = await request(f.app)
      .post('/pto')
      .set('Authorization', `Bearer ${f.material.rawToken}`)
      .set('Content-Type', 'application/json')
      .send(`{"secret":"${f.material.rawToken}"`)
      .expect(400);
    expect(parser.headers['x-request-id']).toBeDefined();
    expect(JSON.stringify(parser.body)).not.toContain(f.material.rawToken);
    for (const [body, contentType, status, code] of [
      [
        JSON.stringify({ padding: 'x'.repeat(102_400) }),
        'application/json',
        413,
        'PAYLOAD_TOO_LARGE',
      ],
      ['{}', 'application/json; charset=iso-8859-1', 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ] as const) {
      const res = await request(f.app)
        .post('/pto')
        .set('Authorization', `Bearer ${f.material.rawToken}`)
        .set('Content-Type', contentType)
        .send(body)
        .expect(status);
      expect(res.body.error.code).toBe(code);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-request-id']).toBeDefined();
    }
  });

  it('finds unnormalized raw Authorization attempts even if Node has discarded the normalized header', () => {
    expect(hasAuthorization({ headers: {}, rawHeaders: ['Host', 'test'] } as Request)).toBe(false);
    expect(
      hasAuthorization({
        headers: {},
        rawHeaders: ['Host', 'test', 'AUTHORIZATION', ''],
      } as Request),
    ).toBe(true);
  });
});

describe('bounded bearer verification and verified traffic', () => {
  it('refuses a repeated failed verification before the database is consulted', async () => {
    vi.stubEnv('RATE_LIMIT_BEARER_FAILURE_MAX', '1');
    const f = fixture();
    f.token.secretDigest = '0'.repeat(64);
    await request(f.app)
      .get('/pto')
      .set('Authorization', `Bearer ${f.material.rawToken}`)
      .expect(401);
    const consulted = f.query.mock.calls.length;
    expect(consulted).toBeGreaterThan(0);
    const limited = await request(f.app)
      .get('/pto')
      .set('Authorization', `Bearer ${f.material.rawToken}`)
      .expect(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.headers['x-request-id']).toBeDefined();
    // The rejected attempt never reached the credential lookup.
    expect(f.query.mock.calls.length).toBe(consulted);
  });

  it('gives the budget back after a verified secret', async () => {
    vi.stubEnv('RATE_LIMIT_BEARER_FAILURE_MAX', '1');
    const f = fixture();
    for (let index = 0; index < 3; index += 1)
      await request(f.app)
        .get('/pto')
        .set('Authorization', `Bearer ${f.material.rawToken}`)
        .expect(200);
  });

  it('bounds the verified traffic of one owner and keeps the standard rejection', async () => {
    vi.stubEnv('RATE_LIMIT_USER_QUOTA_MAX', '1');
    const f = fixture();
    await request(f.app)
      .get('/pto')
      .set('Authorization', `Bearer ${f.material.rawToken}`)
      .expect(200);
    const limited = await request(f.app)
      .get('/pto')
      .set('Authorization', `Bearer ${f.material.rawToken}`)
      .expect(429);
    expect(limited.body).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' },
    });
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.headers['ratelimit']).toContain('limit=1');
    expect(limited.headers['x-request-id']).toBeDefined();
  });
});
