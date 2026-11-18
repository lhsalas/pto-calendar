import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { resetEnvForTests } from '../config/env.js';
import { __resetAuthUserCacheForTests } from '../middleware/requireAuth.js';
import { csrfOriginMiddleware } from '../middleware/csrf.js';
import {
  tokenManagementBoundary,
  tokenManagementErrorHandler,
} from '../middleware/tokenManagement.js';
import { createGlobalLimiter } from '../lib/rateLimit.js';
import { __resetAgentQuotaForTests } from '../middleware/agentQuota.js';
import type { TokenDatabase } from '../services/tokens/tokenDatabase.js';
import type { TokenMetadata } from '../services/tokens/tokenService.js';
import { createTokenRouter } from './tokens.js';

vi.mock('../lib/prisma.js', () => ({ prisma: { user: { findUnique: vi.fn() } } }));
vi.mock('../lib/logger.js', () => ({ logger: { error: vi.fn() } }));

const PASSWORD = 'synthetic-current-password';
const HASH = bcrypt.hashSync(PASSWORD, 4);
type Row = TokenMetadata & { ownerId: string; secretDigest: string; issuedSessionVersion: number };
const result = (rows: unknown[] = [], rowCount = rows.length) => ({ rows, rowCount });
function safe(row: Row): TokenMetadata {
  const {
    ownerId: _owner,
    secretDigest: _digest,
    issuedSessionVersion: _version,
    ...metadata
  } = row;
  return metadata;
}

function fixture(
  role: 'member' | 'team_lead' | 'admin' = 'member',
  authMax = 100,
  globalMax = 10000,
  passwordMax = 100,
  issuanceMax = 100,
) {
  process.env.AUTH_RATE_LIMIT_MAX = String(authMax);
  process.env.RATE_LIMIT_MAX = String(globalMax);
  process.env.RATE_LIMIT_TOKEN_PASSWORD_MAX = String(passwordMax);
  process.env.RATE_LIMIT_TOKEN_ISSUANCE_MAX = String(issuanceMax);
  process.env.CORS_ORIGIN = 'http://localhost:5173';
  resetEnvForTests();
  __resetAgentQuotaForTests();
  __resetAuthUserCacheForTests();
  const owner = { id: randomUUID(), role, passwordHash: HASH as string | null, sessionVersion: 0 };
  const session = { id: owner.id, role, sessionVersion: 0 };
  let authenticated = true;
  const rows: Row[] = [];
  vi.mocked(prisma.user.findUnique).mockImplementation(
    () => Promise.resolve({ ...owner }) as never,
  );
  const listOwned = (values: unknown[]) =>
    result(rows.filter((r) => r.ownerId === values[0]).map(safe));
  const selectOwned = (values: unknown[]) =>
    result(
      rows.filter((r) => r.id === values[0] && r.ownerId === values[1]).map((r) => ({ id: r.id })),
    );
  /** The guarded revocation update: only live rows of the owner change. */
  const revokeMatching = (sql: string, values: unknown[]) => {
    const candidates = rows.filter(
      (r) =>
        !r.revokedAt &&
        (sql.includes('WHERE id =')
          ? r.id === values[0] && r.ownerId === values[1]
          : r.ownerId === values[0]),
    );
    candidates.forEach((r) => {
      r.revokedAt = new Date();
    });
    return sql.includes('RETURNING')
      ? result(candidates.map((r) => ({ id: r.id })))
      : result([], candidates.length);
  };
  const txQuery = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes('FOR UPDATE')) return result([{ ...owner }]);
    if (sql.includes('audit_logs')) return result([], 1);
    if (sql.includes('COUNT(*)'))
      return result([
        {
          count: rows.filter(
            (r) =>
              r.ownerId === values[0] &&
              r.issuedSessionVersion === values[1] &&
              !r.revokedAt &&
              r.expiresAt.getTime() > Date.now(),
          ).length,
        },
      ]);
    if (sql.includes('SET revoked_at')) return revokeMatching(sql, values);
    if (sql.startsWith('SELECT id')) return selectOwned(values);
    const row: Row = {
      id: String(values[0]),
      ownerId: String(values[1]),
      name: String(values[2]),
      displayPrefix: String(values[3]),
      secretDigest: String(values[4]),
      scopes: values[5] as string[],
      issuedSessionVersion: Number(values[6]),
      createdAt: new Date(String(values[7]).replace(' ', 'T') + 'Z'),
      expiresAt: new Date(String(values[8]).replace(' ', 'T') + 'Z'),
      revokedAt: null,
      lastUsedAt: null,
      // The service assembles the issued status; the stored row keeps the
      // server-computed value the list returns.
      status: 'active',
    };
    rows.push(row);
    return result([safe(row)]);
  });
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes('ORDER BY')) return listOwned(values);
    if (sql.startsWith('SELECT id')) return selectOwned(values);
    return revokeMatching(sql, values);
  });
  const db = {
    tables: {
      users: '"public"."users"',
      tokens: '"public"."personal_access_tokens"',
      audit: '"public"."audit_logs"',
    },
    query,
    transaction: vi.fn(async (operation: (tx: { query: typeof txQuery }) => unknown) =>
      operation({ query: txQuery }),
    ),
  } as unknown as TokenDatabase;
  const runtime = { get: vi.fn(() => db), close: vi.fn().mockResolvedValue(undefined) };
  const app = express();
  app.use('/auth/tokens', tokenManagementBoundary);
  app.use(express.json({ limit: '100kb' }));
  // External signed-cookie transport boundary; all new auth/service logic runs.
  app.use((req, _res, next) => {
    req.session = authenticated ? ({ user: session } as typeof req.session) : null;
    next();
  });
  app.use(csrfOriginMiddleware());
  app.use(createGlobalLimiter());
  app.use('/auth/tokens', createTokenRouter(runtime));
  app.use('/auth/tokens', tokenManagementErrorHandler);
  return {
    app,
    owner,
    rows,
    query,
    txQuery,
    runtime,
    signOut: () => {
      authenticated = false;
    },
  };
}

function confidential(res: request.Response): void {
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.headers['x-request-id']).toMatch(/^[A-Za-z0-9._-]{1,200}$/);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.user.findUnique).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('session-only token HTTP adapter with real domain/auth logic', () => {
  it.each(['member', 'team_lead', 'admin'] as const)(
    'lets %s issue once and list safe own metadata',
    async (role) => {
      const f = fixture(role);
      const issued = await request(f.app)
        .post('/auth/tokens')
        .send({ name: 'Laptop', password: PASSWORD })
        .expect(201);
      confidential(issued);
      expect(issued.body.rawToken).toMatch(/^pto_pat_[a-f0-9-]+\.[a-f0-9]{64}$/);
      expect(issued.body.token.scopes).toEqual(['pto:read']);
      expect(issued.body.token.status).toBe('active');
      expect(f.rows[0]?.secretDigest).not.toBe(issued.body.rawToken.split('.')[1]);
      const listed = await request(f.app).get('/auth/tokens').expect(200);
      confidential(listed);
      expect(listed.body.tokens).toHaveLength(1);
      expect(listed.body.tokens[0].status).toBe('active');
      expect(Object.keys(listed.body.tokens[0]).sort()).toEqual([
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
      expect(JSON.stringify(listed.body)).not.toContain(issued.body.rawToken);
      expect(JSON.stringify(listed.body)).not.toContain(f.rows[0]?.secretDigest);
      expect(JSON.stringify(listed.body)).not.toContain(HASH);
      expect(JSON.stringify(listed.body)).not.toContain(f.owner.id);
      expect(JSON.stringify(issued.body)).not.toContain(PASSWORD);
      expect(
        new Date(issued.body.token.expiresAt).getTime() -
          new Date(issued.body.token.createdAt).getTime(),
      ).toBe(90 * 86400000);
    },
  );

  it('returns the server-computed status per own token instead of deriving it locally', async () => {
    const f = fixture();
    await request(f.app)
      .post('/auth/tokens')
      .send({ name: 'Laptop', password: PASSWORD })
      .expect(201);
    await request(f.app)
      .post('/auth/tokens')
      .send({ name: 'Expired', password: PASSWORD })
      .expect(201);
    // The server decides the state of every token; the client never guesses it.
    f.rows[0]!.status = 'expired';
    f.rows[1]!.status = 'invalidated';
    const listed = await request(f.app).get('/auth/tokens').expect(200);
    confidential(listed);
    expect(listed.body.tokens.map((token: { status: string }) => token.status).sort()).toEqual([
      'expired',
      'invalidated',
    ]);
  });

  it('requires fresh passwords but not a password for revoke-one/all; isolates foreign and unknown IDs', async () => {
    const f = fixture();
    const issued = await request(f.app)
      .post('/auth/tokens')
      .send({ name: 'Laptop', password: PASSWORD })
      .expect(201);
    const failure = await request(f.app)
      .post('/auth/tokens')
      .send({ name: 'Again', password: 'wrong' })
      .expect(401);
    confidential(failure);
    expect(f.rows).toHaveLength(1);
    const id = issued.body.token.id as string;
    for (let i = 0; i < 2; i += 1)
      confidential(await request(f.app).delete(`/auth/tokens/${id}`).expect(204));
    const foreign = { ...f.rows[0]!, id: randomUUID(), ownerId: randomUUID(), revokedAt: null };
    f.rows.push(foreign);
    const denied = await request(f.app).delete(`/auth/tokens/${foreign.id}`).expect(404);
    const absent = await request(f.app).delete(`/auth/tokens/${randomUUID()}`).expect(404);
    expect(denied.body).toEqual(absent.body);
    expect(foreign.revokedAt).toBeNull();
    await request(f.app)
      .post('/auth/tokens')
      .send({ name: 'Next', password: PASSWORD })
      .expect(201);
    confidential(await request(f.app).post('/auth/tokens/revoke-all').expect(204));
    expect(f.rows.filter((r) => r.ownerId === f.owner.id).every((r) => r.revokedAt)).toBe(true);
    expect(foreign.revokedAt).toBeNull();
  });

  it('rejects members requesting team scopes and uses live role rather than the cookie/cache role', async () => {
    const f = fixture('team_lead');
    await request(f.app).get('/auth/tokens').expect(200); // populate old role cache
    f.owner.role = 'member';
    const denied = await request(f.app)
      .post('/auth/tokens')
      .send({
        name: 'Escalate',
        password: PASSWORD,
        scopes: ['pto:update:team'],
      })
      .expect(403);
    confidential(denied);
    expect(f.rows).toHaveLength(0);
    const lead = fixture('admin');
    await request(lead.app)
      .post('/auth/tokens')
      .send({
        name: 'Team',
        password: PASSWORD,
        scopes: ['pto:update:team'],
        expiresInDays: 365,
      })
      .expect(201);
  });

  it('bounds every password verification attempt and does not lock out revocation', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const f = fixture('member', 100, 10000, 3);
    // The budget covers every verification, not only the failed ones: a
    // verified password is not given back.
    await request(f.app)
      .post('/auth/tokens')
      .send({ name: 'success-0', password: PASSWORD })
      .expect(201);
    await request(f.app)
      .post('/auth/tokens')
      .send({ name: 'success-1', password: PASSWORD })
      .expect(201);
    await request(f.app)
      .post('/auth/tokens')
      .send({ name: 'Failure', password: 'wrong' })
      .expect(401);
    const limited = await request(f.app)
      .post('/auth/tokens')
      .send({ name: 'Failure', password: 'wrong' });
    expect(limited.status).toBe(429);
    confidential(limited);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
    await request(f.app).post('/auth/tokens/revoke-all').expect(204);
  });

  it('bounds token issuance separately from the password budget and writes nothing for a rejected issuance', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const f = fixture('member', 100, 10000, 100, 1);
    await request(f.app)
      .post('/auth/tokens')
      .send({ name: 'First', password: PASSWORD })
      .expect(201);
    const limited = await request(f.app)
      .post('/auth/tokens')
      .send({ name: 'Second', password: PASSWORD })
      .expect(429);
    confidential(limited);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
    // The rejected issuance wrote no token row and no audit entry.
    expect(f.rows).toHaveLength(1);
    const audits = f.txQuery.mock.calls.filter(([sql]) => sql.includes('audit_logs'));
    expect(audits).toHaveLength(1);
  });

  it('enforces ten active tokens with the safe cap-specific HTTP error', async () => {
    const f = fixture();
    for (let i = 0; i < 10; i += 1)
      await request(f.app)
        .post('/auth/tokens')
        .send({ name: `token-${i}`, password: PASSWORD })
        .expect(201);
    const full = await request(f.app)
      .post('/auth/tokens')
      .send({ name: 'Extra', password: PASSWORD })
      .expect(409);
    confidential(full);
    expect(full.body.error.code).toBe('TOKEN_LIMIT_REACHED');
    await request(f.app).delete(`/auth/tokens/${f.rows[0]!.id}`).expect(204);
    await request(f.app)
      .post('/auth/tokens')
      .send({ name: 'Replacement', password: PASSWORD })
      .expect(201);
  });

  it('rejects missing and stale sessions, bearer-only and all mixed/empty authorization forms', async () => {
    const f = fixture();
    for (const authorization of ['Bearer invalid', 'Basic invalid', '']) {
      confidential(
        await request(f.app).get('/auth/tokens').set('Authorization', authorization).expect(401),
      );
    }
    f.signOut();
    confidential(await request(f.app).get('/auth/tokens').expect(401));
    const stale = fixture();
    stale.owner.sessionVersion = 1;
    confidential(await request(stale.app).get('/auth/tokens').expect(401));
    expect(f.rows).toHaveLength(0);
  });

  it('does not let rejected bearer requests bypass the global IP limiter', async () => {
    const f = fixture('member', 100, 2);
    for (let i = 0; i < 2; i += 1)
      await request(f.app).get('/auth/tokens').set('Authorization', 'Bearer invalid').expect(401);
    const limited = await request(f.app)
      .get('/auth/tokens')
      .set('Authorization', 'Bearer invalid')
      .expect(429);
    confidential(limited);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(f.runtime.get).not.toHaveBeenCalled();
  });

  it('preserves CSRF and rejects unknown/spoofed inputs without echoing secrets', async () => {
    const f = fixture();
    const csrf = await request(f.app)
      .post('/auth/tokens')
      .set('Origin', 'https://foreign.example')
      .send({ name: 'Laptop', password: PASSWORD })
      .expect(403);
    confidential(csrf);
    for (const input of [
      { name: 'Laptop', password: PASSWORD, userId: randomUUID() },
      { name: 'Laptop', password: PASSWORD, scopes: ['unknown'] },
      { name: ' Laptop', password: PASSWORD },
      { name: 'Laptop', password: PASSWORD, expiresInDays: 366 },
    ]) {
      const res = await request(f.app).post('/auth/tokens').send(input).expect(400);
      confidential(res);
      expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
    }
    confidential(await request(f.app).get('/auth/tokens?userId=other').expect(400));
    confidential(
      await request(f.app).post('/auth/tokens/revoke-all').send({ userId: 'other' }).expect(400),
    );
    confidential(await request(f.app).delete('/auth/tokens/not-a-uuid').expect(400));
    confidential(await request(f.app).put('/auth/tokens/unsupported').expect(404));
    expect(f.rows).toHaveLength(0);
  });

  it('sets no-store/correlation before malformed, oversized and unsupported parser failures', async () => {
    const f = fixture();
    for (const res of [
      await request(f.app)
        .post('/auth/tokens')
        .set('Content-Type', 'application/json')
        .send(`{"password":"${PASSWORD}"`)
        .expect(400),
      await request(f.app)
        .post('/auth/tokens')
        .send({ password: 'x'.repeat(110000) })
        .expect(413),
      await request(f.app)
        .post('/auth/tokens')
        .set('Content-Type', 'application/json; charset=unknown')
        .send('{}')
        .expect(415),
      await request(f.app)
        .post('/auth/tokens')
        .set('Content-Encoding', 'unknown')
        .send({ name: 'Laptop', password: PASSWORD })
        .expect(415),
    ]) {
      confidential(res);
      expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
    }
    expect(f.runtime.get).not.toHaveBeenCalled();
  });

  it('sanitizes persistence failures and never sends their private cause to logging', async () => {
    const f = fixture();
    f.query.mockRejectedValueOnce(new Error(PASSWORD));
    const res = await request(f.app).get('/auth/tokens').expect(500);
    confidential(res);
    expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(PASSWORD);
  });
});

describe('credential error boundary defensive paths', () => {
  it('handles raw parser/unknown errors without serializing their bodies or details', () => {
    for (const error of [
      { type: 'request.aborted', body: PASSWORD },
      { type: 'request.size.invalid', body: PASSWORD },
      { type: 'unexpected', body: PASSWORD },
      {},
      null,
      5,
    ]) {
      const json = vi.fn();
      const res = { status: vi.fn().mockReturnValue({ json }) } as unknown as Response;
      tokenManagementErrorHandler(error, { id: 'safe-id' } as Request, res, vi.fn());
      expect(JSON.stringify(json.mock.calls)).not.toContain(PASSWORD);
      expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(PASSWORD);
    }
  });
});
