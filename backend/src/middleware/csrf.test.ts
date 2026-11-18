import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvForTests } from '../config/env.js';
import { HttpError } from './errorHandler.js';
import { csrfOriginMiddleware } from './csrf.js';

const STRONG_SECRET = 'aB1!cD2@eF3#gH4$iJ5%kL6&mN7*oP8+';

function requestFor(
  method: string,
  headers: Record<string, string> = {},
  session?: {
    user?: { id: string; role: 'member' | 'team_lead' | 'admin'; sessionVersion: number };
  },
): { method: string; headers: Record<string, string>; get: (name: string) => string | undefined } {
  return {
    method,
    headers,
    get: (name) => headers[name.toLowerCase()],
    ...(session ? { session } : {}),
  };
}

describe('csrfOriginMiddleware', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'production',
      SESSION_SECRET: STRONG_SECRET,
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      COOKIE_SECURE: 'true',
      BCRYPT_ROUNDS: '12',
      CORS_ORIGIN: 'https://pto.example.com',
      RATE_LIMIT_REDIS_URL: 'rediss://:test-password@redis.example.test:6379/0',
    });
    resetEnvForTests();
  });

  it('exempts only a verified cookie-free PAT, never a header or mixed credential alone', () => {
    const auth = { method: 'pat' };
    const valid = { ...requestFor('PUT', { authorization: 'Bearer token' }), auth };
    const next = vi.fn();
    csrfOriginMiddleware()(valid as never, {} as never, next);
    expect(next).toHaveBeenCalledWith();
    for (const candidate of [
      requestFor('PUT', { authorization: 'Bearer invalid' }),
      { ...valid, headers: { authorization: 'Bearer token', cookie: '' } },
      { ...valid, session: { user: { id: 'u1' } } },
      { ...valid, get: (key: string) => (key === 'origin' ? 'https://foreign.test' : undefined) },
    ]) {
      const rejected = vi.fn();
      csrfOriginMiddleware()(candidate as never, {} as never, rejected);
      expect(rejected.mock.calls[0]?.[0]).toMatchObject({ status: 403, code: 'CSRF_REJECTED' });
    }
  });

  it('handles malformed referers and preserves development cookie behavior', () => {
    const next = vi.fn();
    csrfOriginMiddleware()(
      requestFor('POST', { referer: 'not a URL' }) as never,
      {} as never,
      next,
    );
    expect(next).toHaveBeenCalledWith();
    process.env.NODE_ENV = 'test';
    resetEnvForTests();
    const user = { id: 'u1', role: 'member' as const, sessionVersion: 0 };
    const development = vi.fn();
    csrfOriginMiddleware()(requestFor('POST', {}, { user }) as never, {} as never, development);
    expect(development).toHaveBeenCalledWith();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetEnvForTests();
  });

  it('allows safe methods without checking their origin', () => {
    const next = vi.fn();
    csrfOriginMiddleware()(requestFor('GET') as never, {} as never, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('allows the configured frontend origin for state-changing methods', () => {
    const next = vi.fn();
    csrfOriginMiddleware()(
      requestFor('POST', { origin: 'https://pto.example.com' }) as never,
      {} as never,
      next,
    );

    expect(next).toHaveBeenCalledWith();
  });

  it('rejects a state-changing request from another origin', () => {
    const next = vi.fn();
    csrfOriginMiddleware()(
      requestFor('DELETE', { origin: 'https://attacker.example' }) as never,
      {} as never,
      next,
    );

    const error = next.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 403, code: 'CSRF_REJECTED' });
  });

  it('uses Referer when Origin is absent', () => {
    const next = vi.fn();
    csrfOriginMiddleware()(
      requestFor('PUT', { referer: 'https://attacker.example/form' }) as never,
      {} as never,
      next,
    );

    expect(next.mock.calls[0]?.[0]).toMatchObject({
      status: 403,
      code: 'CSRF_REJECTED',
    });
  });

  it('allows unauthenticated non-browser requests without Origin or Referer', () => {
    const next = vi.fn();
    csrfOriginMiddleware()(requestFor('PATCH') as never, {} as never, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('rejects authenticated state-changing requests without Origin or Referer', () => {
    const next = vi.fn();
    csrfOriginMiddleware()(
      requestFor(
        'PATCH',
        {},
        {
          user: { id: 'u1', role: 'member', sessionVersion: 0 },
        },
      ) as never,
      {} as never,
      next,
    );

    expect(next.mock.calls[0]?.[0]).toMatchObject({
      status: 403,
      code: 'CSRF_REJECTED',
    });
  });
});
