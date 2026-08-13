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
): { method: string; get: (name: string) => string | undefined } {
  return {
    method,
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
