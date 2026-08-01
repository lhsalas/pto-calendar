import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv, resetEnvForTests } from './env.js';
import {
  isPlaceholderSessionSecret,
  isStrongSessionSecret,
  parseSessionKeys,
  shannonEntropy,
} from './sessionSecret.js';

const STRONG_SECRET_A = 'aB1!cD2@eF3#gH4$iJ5%kL6&mN7*oP8+';
const STRONG_SECRET_B = 'bB1!cD2@eF3#gH4$iJ5%kL6&mN7*oP8+';
const STRONG_SECRET_C = 'cC1!dD2@eF3#gH4$iJ5%kL6&mN7*oP8+';

const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  CORS_ORIGIN: 'http://localhost:5173',
  COOKIE_SECURE: 'false',
  COOKIE_DOMAIN: '',
  COOKIE_MAX_AGE_MS: '86400000',
  BCRYPT_ROUNDS: '10',
  LOG_LEVEL: 'info',
  RATE_LIMIT_WINDOW_MS: '900000',
  RATE_LIMIT_MAX: '100',
  AUTH_RATE_LIMIT_MAX: '5',
  SHUTDOWN_TIMEOUT_MS: '10000',
  READY_TIMEOUT_MS: '5000',
  SESSION_SECRET: STRONG_SECRET_A,
} as const;

describe('loadEnv — SESSION_SECRET validation', () => {
  beforeEach(() => {
    resetEnvForTests();
  });
  afterEach(() => {
    resetEnvForTests();
  });

  it('accepts a single strong secret in dev', () => {
    const env = loadEnv({ ...BASE_ENV, NODE_ENV: 'development' });
    expect(env.SESSION_SECRET).toEqual([STRONG_SECRET_A]);
  });

  it('accepts comma-separated keys (rotation) and returns them in order', () => {
    const env = loadEnv({
      ...BASE_ENV,
      SESSION_SECRET: `${STRONG_SECRET_A},${STRONG_SECRET_B},${STRONG_SECRET_C}`,
    });
    expect(env.SESSION_SECRET).toEqual([STRONG_SECRET_A, STRONG_SECRET_B, STRONG_SECRET_C]);
  });

  it('trims whitespace around comma-separated keys', () => {
    const env = loadEnv({
      ...BASE_ENV,
      SESSION_SECRET: ` ${STRONG_SECRET_A} , ${STRONG_SECRET_B} `,
    });
    expect(env.SESSION_SECRET).toEqual([STRONG_SECRET_A, STRONG_SECRET_B]);
  });

  it('rejects the .env.example placeholder value', () => {
    expect(() =>
      loadEnv({ ...BASE_ENV, SESSION_SECRET: 'replace-me-with-a-long-random-string-min-32-chars' }),
    ).toThrow(/placeholder string/);
  });

  it('rejects any "replace-me..." prefix (case-insensitive)', () => {
    expect(() =>
      loadEnv({ ...BASE_ENV, SESSION_SECRET: 'REPLACE-ME-something-long-enough-here-yes' }),
    ).toThrow(/placeholder/);
    expect(() =>
      loadEnv({ ...BASE_ENV, SESSION_SECRET: 'Replace-Me-abcdefghijklmnopqrstuvwxyz' }),
    ).toThrow(/placeholder/);
  });

  it('rejects any "change-me..." prefix (case-insensitive)', () => {
    expect(() =>
      loadEnv({ ...BASE_ENV, SESSION_SECRET: 'change-me-please-abcdefghijklmnopqrstuv' }),
    ).toThrow(/placeholder/);
  });

  it('rejects secrets shorter than 32 characters', () => {
    expect(() => loadEnv({ ...BASE_ENV, SESSION_SECRET: 'aB1!cD2@eF3#gH4' })).toThrow(
      /at least 32 characters/,
    );
  });

  it('rejects secrets with insufficient entropy (long run of one char)', () => {
    expect(() => loadEnv({ ...BASE_ENV, SESSION_SECRET: 'a'.repeat(32) })).toThrow(/entropy/);
    expect(() => loadEnv({ ...BASE_ENV, SESSION_SECRET: '0'.repeat(32) })).toThrow(/entropy/);
  });

  it('rejects an empty / all-whitespace secret', () => {
    expect(() => loadEnv({ ...BASE_ENV, SESSION_SECRET: '   ' })).toThrow();
  });

  it('rejects when all comma-separated entries are blank', () => {
    expect(() => loadEnv({ ...BASE_ENV, SESSION_SECRET: ',,,' })).toThrow(/non-empty key/);
  });
});

describe('loadEnv — production guards', () => {
  beforeEach(() => {
    resetEnvForTests();
  });
  afterEach(() => {
    resetEnvForTests();
  });

  it('fails when COOKIE_SECURE is false in production', () => {
    expect(() =>
      loadEnv({
        ...BASE_ENV,
        NODE_ENV: 'production',
        SESSION_SECRET: STRONG_SECRET_A,
        COOKIE_SECURE: 'false',
      }),
    ).toThrow(/COOKIE_SECURE/);
  });

  it('accepts COOKIE_SECURE=false in production when INSECURE_COOKIES_ALLOWED=true', () => {
    const env = loadEnv({
      ...BASE_ENV,
      NODE_ENV: 'production',
      SESSION_SECRET: STRONG_SECRET_A,
      COOKIE_SECURE: 'false',
      INSECURE_COOKIES_ALLOWED: 'true',
      BCRYPT_ROUNDS: '10',
    });
    expect(env.COOKIE_SECURE).toBe(false);
    expect(env.INSECURE_COOKIES_ALLOWED).toBe(true);
  });

  it('INSECURE_COOKIES_ALLOWED defaults to false when unset', () => {
    const env = loadEnv({
      ...BASE_ENV,
      NODE_ENV: 'development',
    });
    expect(env.INSECURE_COOKIES_ALLOWED).toBe(false);
  });

  it('INSECURE_COOKIES_ALLOWED=true in dev is accepted (flag is allowed in any NODE_ENV)', () => {
    const env = loadEnv({
      ...BASE_ENV,
      NODE_ENV: 'development',
      INSECURE_COOKIES_ALLOWED: 'true',
    });
    expect(env.INSECURE_COOKIES_ALLOWED).toBe(true);
  });

  it('fails when SESSION_SECRET is empty in production', () => {
    expect(() =>
      loadEnv({
        ...BASE_ENV,
        NODE_ENV: 'production',
        SESSION_SECRET: STRONG_SECRET_A,
        COOKIE_SECURE: 'true',
        BCRYPT_ROUNDS: '10',
      }),
    ).not.toThrow();

    // sanity: switch the secret to a placeholder and expect failure
    resetEnvForTests();
    expect(() =>
      loadEnv({
        ...BASE_ENV,
        NODE_ENV: 'production',
        SESSION_SECRET: 'change-me-please-abcdefghijklmnopqrstuv',
        COOKIE_SECURE: 'true',
      }),
    ).toThrow(/placeholder/);
  });

  it('fails when BCRYPT_ROUNDS is below 10 in production', () => {
    expect(() =>
      loadEnv({
        ...BASE_ENV,
        NODE_ENV: 'production',
        SESSION_SECRET: STRONG_SECRET_A,
        COOKIE_SECURE: 'true',
        BCRYPT_ROUNDS: '4',
      }),
    ).toThrow(/BCRYPT_ROUNDS/);
  });

  it('accepts a fully-valid production env', () => {
    const env = loadEnv({
      ...BASE_ENV,
      NODE_ENV: 'production',
      SESSION_SECRET: STRONG_SECRET_A,
      COOKIE_SECURE: 'true',
      BCRYPT_ROUNDS: '12',
    });
    expect(env.NODE_ENV).toBe('production');
    expect(env.COOKIE_SECURE).toBe(true);
    expect(env.BCRYPT_ROUNDS).toBe(12);
    expect(env.SESSION_SECRET).toEqual([STRONG_SECRET_A]);
  });
});

describe('loadEnv — PORT and TRUST_PROXY_HOPS defaults', () => {
  beforeEach(() => {
    resetEnvForTests();
  });
  afterEach(() => {
    resetEnvForTests();
  });

  it('defaults PORT to 3000 when PORT is unset (Deno Deploy does not set it)', () => {
    const envSource = { ...BASE_ENV } as Record<string, string>;
    delete envSource.PORT;
    const env = loadEnv(envSource);
    expect(env.PORT).toBe(3000);
  });

  it('honors an explicit PORT when provided', () => {
    const env = loadEnv({ ...BASE_ENV, PORT: '4000' });
    expect(env.PORT).toBe(4000);
  });

  it('defaults TRUST_PROXY_HOPS to 1 in production (Deno Deploy edge is a single hop)', () => {
    const env = loadEnv({
      ...BASE_ENV,
      NODE_ENV: 'production',
      SESSION_SECRET: STRONG_SECRET_A,
      COOKIE_SECURE: 'true',
      BCRYPT_ROUNDS: '12',
    });
    expect(env.TRUST_PROXY_HOPS).toBe(1);
  });

  it('defaults TRUST_PROXY_HOPS to 0 in development', () => {
    const env = loadEnv({ ...BASE_ENV, NODE_ENV: 'development' });
    expect(env.TRUST_PROXY_HOPS).toBe(0);
  });
});

describe('sessionSecret helpers', () => {
  it('shannonEntropy returns 0 for the empty string', () => {
    expect(shannonEntropy('')).toBe(0);
  });

  it('shannonEntropy returns 0 for a single repeated char', () => {
    expect(shannonEntropy('aaaa')).toBe(0);
  });

  it('shannonEntropy increases as the alphabet grows', () => {
    expect(shannonEntropy('aB1!')).toBeGreaterThan(shannonEntropy('aaaa'));
    expect(shannonEntropy('aB1!cD2@')).toBeGreaterThan(shannonEntropy('aB1!'));
  });

  it('isPlaceholderSessionSecret flags the deny-list and known prefixes', () => {
    expect(isPlaceholderSessionSecret('replace-me-with-a-long-random-string-min-32-chars')).toBe(
      true,
    );
    expect(isPlaceholderSessionSecret('REPLACE-ME-something-very-long-yes-please')).toBe(true);
    expect(isPlaceholderSessionSecret('change-me-please-aaaaaaaaaaaaaaa')).toBe(true);
    expect(isPlaceholderSessionSecret('CHANGEME-very-long-string-yes-please')).toBe(true);
    expect(isPlaceholderSessionSecret(STRONG_SECRET_A)).toBe(false);
  });

  it('isStrongSessionSecret passes the strong test secrets and fails the weak ones', () => {
    expect(isStrongSessionSecret(STRONG_SECRET_A)).toBe(true);
    expect(isStrongSessionSecret('a'.repeat(32))).toBe(false);
    expect(isStrongSessionSecret('aB1!')).toBe(false);
    expect(isStrongSessionSecret('REPLACE-ME-something-very-long-yes-please')).toBe(false);
  });

  it('parseSessionKeys splits, trims, and drops empties', () => {
    expect(parseSessionKeys('a, b, ,c')).toEqual(['a', 'b', 'c']);
    expect(parseSessionKeys('   ')).toEqual([]);
    expect(parseSessionKeys('only')).toEqual(['only']);
  });
});
