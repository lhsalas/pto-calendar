import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { __resetAuthUserCacheForTests, requireAuth } from './requireAuth.js';

const { findUniqueMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: { findUnique: findUniqueMock },
  },
}));

interface MockResponse {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
}

function makeRes(): Response & MockResponse {
  const json = vi.fn().mockReturnThis();
  const status = vi.fn().mockReturnValue({ json });
  return { status, json } as unknown as Response & MockResponse;
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
});
