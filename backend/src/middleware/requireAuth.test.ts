import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { __resetAuthUserCacheForTests, requireAuth } from './requireAuth.js';
import { __resetAgentQuotaForTests } from './agentQuota.js';

const { findUniqueMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: findUniqueMock },
  },
}));
vi.mock('../lib/logSanitizers.js', () => ({ safeRequestId: () => 'safe-unit-request-id' }));

interface MockResponse {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  getHeader: ReturnType<typeof vi.fn>;
}

function makeRes(): Response & MockResponse {
  const json = vi.fn().mockReturnThis();
  const status = vi.fn().mockReturnValue({ json });
  const headers = new Map<string, string>();
  const setHeader = vi.fn((name: string, value: string) => {
    headers.set(name, value);
  });
  const getHeader = vi.fn((name: string) => headers.get(name));
  return { status, json, setHeader, getHeader } as unknown as Response & MockResponse;
}

const BASE_ENV = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'aB1!cD2@eF3#gH4$iJ5%kL6&mN7*oP8+',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  AUTH_USER_CACHE_TTL_MS: '15000',
} as const;

describe('requireAuth', () => {
  beforeEach(async () => {
    __resetAuthUserCacheForTests();
    const { resetEnvForTests, loadEnv } = await import('../config/env.js');
    process.env = { ...process.env, ...BASE_ENV };
    resetEnvForTests();
    loadEnv();
    findUniqueMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    __resetAgentQuotaForTests();
  });

  it('returns 401 UNAUTHENTICATED when req.session is missing', async () => {
    const req = {} as Request;
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireAuth(req, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' },
    });
    expect(next).not.toHaveBeenCalled();
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it('returns 401 UNAUTHENTICATED when req.session exists but has no user', async () => {
    const req = { session: {} } as unknown as Request;
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireAuth(req, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' },
    });
    expect(next).not.toHaveBeenCalled();
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it('revalidates the session user against the DB on a cache miss', async () => {
    const user = { id: 'u1', role: 'member' as const, sessionVersion: 0 };
    const req = { session: { user: { ...user } } } as unknown as Request;
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    findUniqueMock
      .mockResolvedValueOnce({ id: 'u1', role: 'member' })
      .mockResolvedValueOnce({ sessionVersion: 0 });

    await requireAuth(req, res as Response, next);

    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { id: 'u1' },
      select: { id: true, role: true },
    });
    expect(req.user).toEqual({ id: 'u1', role: 'member', sessionVersion: 0 });
    expect(req.auth).toEqual({
      method: 'session',
      actor: { id: 'u1', role: 'member' },
      requestId: 'safe-unit-request-id',
    });
    expect(req.auth?.actor).not.toHaveProperty('sessionVersion');
    expect(next).toHaveBeenCalledWith();
  });

  it('keeps the replay nonce of the session when it refreshes the session user', async () => {
    const req = {
      session: {
        user: { id: 'u1', role: 'member' as const, sessionVersion: 0, replayNonce: 'n-1' },
      },
    } as unknown as Request;
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    findUniqueMock
      .mockResolvedValueOnce({ id: 'u1', role: 'member' })
      .mockResolvedValueOnce({ sessionVersion: 0 });

    await requireAuth(req, res as Response, next);

    expect(req.user).toEqual({
      id: 'u1',
      role: 'member',
      sessionVersion: 0,
      replayNonce: 'n-1',
    });
    expect(req.session?.user).toMatchObject({ replayNonce: 'n-1' });
    expect(next).toHaveBeenCalledWith();
  });

  it('does not invent a replay nonce for a session that never had one', async () => {
    const req = {
      session: { user: { id: 'u1', role: 'member' as const, sessionVersion: 0 } },
    } as unknown as Request;
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    findUniqueMock
      .mockResolvedValueOnce({ id: 'u1', role: 'member' })
      .mockResolvedValueOnce({ sessionVersion: 0 });

    await requireAuth(req, res as Response, next);

    expect(req.user).not.toHaveProperty('replayNonce');
    expect(next).toHaveBeenCalledWith();
  });

  it('serves the role from cache while checking session version', async () => {
    const sessionUser = { id: 'u2', role: 'member' as const, sessionVersion: 0 };
    findUniqueMock
      .mockResolvedValueOnce({ id: 'u2', role: 'member' })
      .mockResolvedValueOnce({ sessionVersion: 0 })
      .mockResolvedValueOnce({ sessionVersion: 0 });

    const req1 = { session: { user: { ...sessionUser } } } as unknown as Request;
    const res1 = makeRes();
    await requireAuth(req1, res1 as Response, vi.fn() as unknown as NextFunction);

    const req2 = { session: { user: { ...sessionUser } } } as unknown as Request;
    const res2 = makeRes();
    await requireAuth(req2, res2 as Response, vi.fn() as unknown as NextFunction);

    expect(findUniqueMock).toHaveBeenCalledTimes(3);
  });

  it('rejects a session whose version was revoked in the database', async () => {
    const sessionUser = { id: 'u-revoked', role: 'member' as const, sessionVersion: 0 };
    findUniqueMock
      .mockResolvedValueOnce({ id: 'u-revoked', role: 'member' })
      .mockResolvedValueOnce({ sessionVersion: 1 });

    const req = { session: { user: sessionUser } } as unknown as Request;
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireAuth(req, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(req.session).toBeNull();
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects if the user disappears during the session-version lookup', async () => {
    findUniqueMock.mockResolvedValueOnce({ id: 'u1', role: 'member' }).mockResolvedValueOnce(null);
    const req = {
      session: { user: { id: 'u1', role: 'member', sessionVersion: 0 } },
    } as unknown as Request;
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    await requireAuth(req, res, next);
    expect(req.session).toBeNull();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('does not write back to a session removed while lookups are in flight', async () => {
    const session = { user: { id: 'u1', role: 'member', sessionVersion: 0 } };
    const req = { session } as unknown as Request;
    findUniqueMock
      .mockResolvedValueOnce({ id: 'u1', role: 'member' })
      .mockImplementationOnce(() => {
        req.session = null;
        return Promise.resolve({ sessionVersion: 0 });
      });
    const next = vi.fn() as unknown as NextFunction;
    await requireAuth(req, makeRes(), next);
    expect(req.session).toBeNull();
    expect(req.user).toEqual({ id: 'u1', role: 'member', sessionVersion: 0 });
    expect(next).toHaveBeenCalledWith();
  });

  it('reflects a role change in req.user after cache expiry', async () => {
    process.env.AUTH_USER_CACHE_TTL_MS = '1';
    const { resetEnvForTests, loadEnv } = await import('../config/env.js');
    resetEnvForTests();
    loadEnv();
    __resetAuthUserCacheForTests();

    const sessionUser = { id: 'u3', role: 'team_lead' as const, sessionVersion: 0 };
    findUniqueMock
      .mockResolvedValueOnce({ id: 'u3', role: 'team_lead' })
      .mockResolvedValueOnce({ sessionVersion: 0 });

    const req1 = { session: { user: { ...sessionUser } } } as unknown as Request;
    const res1 = makeRes();
    await requireAuth(req1, res1 as Response, vi.fn() as unknown as NextFunction);
    expect(req1.user?.role).toBe('team_lead');

    await new Promise((r) => setTimeout(r, 5));
    findUniqueMock
      .mockResolvedValueOnce({ id: 'u3', role: 'member' })
      .mockResolvedValueOnce({ sessionVersion: 0 });

    const req2 = { session: { user: { ...sessionUser } } } as unknown as Request;
    const res2 = makeRes();
    await requireAuth(req2, res2 as Response, vi.fn() as unknown as NextFunction);
    expect(req2.user?.role).toBe('member');
    expect(req2.user?.sessionVersion).toBe(0);
    expect(req2.session?.user?.role).toBe('member');
  });

  it('returns 401 and clears the session when the user no longer exists in the DB', async () => {
    const sessionUser = { id: 'gone', role: 'member' as const, sessionVersion: 0 };
    findUniqueMock.mockResolvedValueOnce(null);

    const req = { session: { user: { ...sessionUser } } } as unknown as Request;
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireAuth(req, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'UNAUTHENTICATED', message: 'Session is no longer valid.' },
    });
    expect(req.session).toBeNull();
    expect(next).not.toHaveBeenCalled();
  });

  it('uses a longer (negative) TTL for "user not found" entries to bound cache-stampede', async () => {
    process.env.AUTH_USER_CACHE_TTL_MS = '10';
    const { resetEnvForTests, loadEnv } = await import('../config/env.js');
    resetEnvForTests();
    loadEnv();
    __resetAuthUserCacheForTests();

    findUniqueMock.mockResolvedValueOnce(null);

    const req1 = {
      session: { user: { id: 'gone2', role: 'member' as const, sessionVersion: 0 } },
    } as unknown as Request;
    await requireAuth(req1, makeRes() as Response, vi.fn() as unknown as NextFunction);
    expect(findUniqueMock).toHaveBeenCalledTimes(1);

    // immediately retry — should be a cache hit (negative cache)
    const req2 = {
      session: { user: { id: 'gone2', role: 'member' as const, sessionVersion: 0 } },
    } as unknown as Request;
    const res2 = makeRes();
    await requireAuth(req2, res2 as Response, vi.fn() as unknown as NextFunction);
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
    expect(res2.status).toHaveBeenCalledWith(401);
  });

  it('refuses a verified session that is outside its traffic budget', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    vi.stubEnv('RATE_LIMIT_USER_QUOTA_MAX', '1');
    const { resetEnvForTests, loadEnv } = await import('../config/env.js');
    resetEnvForTests();
    loadEnv();
    __resetAgentQuotaForTests();
    const sessionUser = { id: 'u-quota', role: 'member' as const, sessionVersion: 0 };
    findUniqueMock
      .mockResolvedValueOnce({ id: 'u-quota', role: 'member' })
      .mockResolvedValueOnce({ sessionVersion: 0 })
      .mockResolvedValueOnce({ sessionVersion: 0 });

    const first = { session: { user: { ...sessionUser } } } as unknown as Request;
    const firstNext = vi.fn() as unknown as NextFunction;
    await requireAuth(first, makeRes() as Response, firstNext);
    expect(firstNext).toHaveBeenCalledWith();

    const req = { session: { user: { ...sessionUser } } } as unknown as Request;
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireAuth(req, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' },
    });
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards DB errors to next()', async () => {
    const sessionUser = { id: 'u-err', role: 'member' as const, sessionVersion: 0 };
    const err = new Error('db boom');
    findUniqueMock.mockRejectedValueOnce(err);

    const req = { session: { user: { ...sessionUser } } } as unknown as Request;
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireAuth(req, res as Response, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('uses a gateway-verified PAT context without manufacturing a browser user or reading the role cache', async () => {
    const req = {
      auth: {
        method: 'pat',
        actor: { id: 'u1', role: 'member' },
        requestId: 'request',
        tokenId: 'token',
        scopes: ['pto:read'],
        expiresAt: new Date(),
      },
    } as unknown as Request;
    const next = vi.fn();
    await requireAuth(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });
});
