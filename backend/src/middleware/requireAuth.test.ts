import { describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { requireAuth } from './requireAuth.js';

interface MockResponse {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
}

function makeRes(): Response & MockResponse {
  const json = vi.fn().mockReturnThis();
  const status = vi.fn().mockReturnValue({ json });
  return { status, json } as unknown as Response & MockResponse;
}

describe('requireAuth', () => {
  it('returns 401 UNAUTHENTICATED when req.session is missing', () => {
    const req = {} as Request;
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    requireAuth(req, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 UNAUTHENTICATED when req.session exists but has no user', () => {
    const req = { session: {} } as unknown as Request;
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    requireAuth(req, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('assigns req.user and calls next() when session.user is present', () => {
    const user = { id: 'u1', role: 'member' as const };
    const req = { session: { user } } as unknown as Request;
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    requireAuth(req, res as Response, next);

    expect(req.user).toEqual({ id: 'u1', role: 'member' });
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('preserves team_lead role on req.user', () => {
    const user = { id: 'u-lead', role: 'team_lead' as const };
    const req = { session: { user } } as unknown as Request;
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    requireAuth(req, res as Response, next);

    expect(req.user).toEqual({ id: 'u-lead', role: 'team_lead' });
    expect(next).toHaveBeenCalledWith();
  });
});
