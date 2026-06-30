import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type CookieSessionOptions = Record<string, unknown> & {
  name: string;
  keys: string[];
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  maxAge: number;
  domain?: string;
};

const capturedOptions: CookieSessionOptions[] = [];

vi.mock('cookie-session', () => {
  return {
    default: (opts: CookieSessionOptions) => {
      capturedOptions.push(opts);
      return (_req: unknown, _res: unknown, next: () => void) => next();
    },
  };
});

import { resetEnvForTests } from '../config/env.js';
import { cookieSessionMiddleware } from './cookieSession.js';

describe('cookieSessionMiddleware', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    capturedOptions.length = 0;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetEnvForTests();
  });

  it('uses SESSION_SECRET as a single keys entry', () => {
    process.env.SESSION_SECRET = 'aB1!cD2@eF3#gH4$iJ5%kL6&mN7*oP8+';
    process.env.COOKIE_SECURE = 'false';
    process.env.COOKIE_DOMAIN = '';
    process.env.COOKIE_MAX_AGE_MS = '86400000';
    resetEnvForTests();

    cookieSessionMiddleware();
    const opts = capturedOptions[0]!;
    expect(opts.keys).toEqual(['aB1!cD2@eF3#gH4$iJ5%kL6&mN7*oP8+']);
  });

  it('sets the canonical cookie options (secure=true, custom maxAge)', () => {
    process.env.SESSION_SECRET = 'bB1!cD2@eF3#gH4$iJ5%kL6&mN7*oP8+';
    process.env.COOKIE_SECURE = 'true';
    process.env.COOKIE_DOMAIN = '';
    process.env.COOKIE_MAX_AGE_MS = '3600000';
    resetEnvForTests();

    cookieSessionMiddleware();
    const opts = capturedOptions[0]!;
    expect(opts.name).toBe('session');
    expect(opts.httpOnly).toBe(true);
    expect(opts.secure).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.maxAge).toBe(3_600_000);
  });

  it('omits domain when COOKIE_DOMAIN is empty', () => {
    process.env.SESSION_SECRET = 'cC1!dD2@eF3#gH4$iJ5%kL6&mN7*oP8+';
    process.env.COOKIE_SECURE = 'false';
    process.env.COOKIE_DOMAIN = '';
    resetEnvForTests();

    cookieSessionMiddleware();
    const opts = capturedOptions[0]!;
    expect(opts).not.toHaveProperty('domain');
  });

  it('includes domain when COOKIE_DOMAIN is set', () => {
    process.env.SESSION_SECRET = 'dD1!eE2@fF3#gH4$iJ5%kL6&mN7*oP8+';
    process.env.COOKIE_SECURE = 'true';
    process.env.COOKIE_DOMAIN = 'example.com';
    resetEnvForTests();

    cookieSessionMiddleware();
    const opts = capturedOptions[0]!;
    expect(opts.domain).toBe('example.com');
  });

  it('reflects COOKIE_SECURE=false in the options', () => {
    process.env.SESSION_SECRET = 'eE1!fF2@gG3#hH4$iJ5%kL6&mN7*oP8+';
    process.env.COOKIE_SECURE = 'false';
    process.env.COOKIE_DOMAIN = '';
    resetEnvForTests();

    cookieSessionMiddleware();
    const opts = capturedOptions[0]!;
    expect(opts.secure).toBe(false);
  });
});
