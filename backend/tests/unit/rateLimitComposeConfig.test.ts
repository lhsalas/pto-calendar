import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv, resetEnvForTests } from '../../src/config/env.js';

const COMPOSE_FILES = ['docker-compose.prod.yml', 'docker-compose.app.yml'];
const BASE_ENV = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'aB1!cD2@eF3#gH4$iJ5%kL6&mN7*oP8+',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
} as const;

/** The limiter values an operator can override, with their schema defaults. */
const LIMITS = {
  RATE_LIMIT_MAX: 100,
  AUTH_RATE_LIMIT_MAX: 5,
  RATE_LIMIT_ATTEMPT_WINDOW_MS: 900_000,
  RATE_LIMIT_BEARER_FAILURE_MAX: 20,
  RATE_LIMIT_QUOTA_WINDOW_MS: 60_000,
  RATE_LIMIT_USER_QUOTA_MAX: 600,
  RATE_LIMIT_TOKEN_QUOTA_MAX: 300,
  RATE_LIMIT_TOKEN_ISSUANCE_MAX: 20,
  RATE_LIMIT_TOKEN_PASSWORD_MAX: 20,
} as const;

/** Resolves the compose `${VAR:-default}` substitution of one value. */
function resolve(value: string, environment: Record<string, string>): string {
  return value.replace(
    /\$\{(\w+):-([^}]*)\}/g,
    (_match, name: string, fallback: string) => environment[name] ?? fallback,
  );
}

function composeEntry(content: string, name: string): string | undefined {
  const match = new RegExp(`^\\s{6}${name}:\\s*(.+)$`, 'm').exec(content);
  const value = match?.[1]?.trim();
  if (!value) return undefined;
  // The container value is a quoted substitution.
  return value.replace(/^'(.*)'$/, '$1');
}

afterEach(() => {
  resetEnvForTests();
});

describe('the container limiter configuration', () => {
  it.each(COMPOSE_FILES)('exposes every limiter value as an operator override in %s', (file) => {
    const content = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
    for (const [name, fallback] of Object.entries(LIMITS)) {
      const entry = composeEntry(content, name);
      expect(entry, `${name} in ${file}`).toBeDefined();
      // The container value is a substitution with the documented default, so
      // an explicit bounded override reaches the running container.
      expect(resolve(entry!, {}), `${name} default in ${file}`).toBe(String(fallback));
      expect(resolve(entry!, { [name]: '1234' }), `${name} override in ${file}`).toBe('1234');
    }
  });

  it.each(COMPOSE_FILES)(
    'keeps the container defaults equal to the schema defaults in %s',
    (file) => {
      const content = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
      resetEnvForTests();
      const env = loadEnv({ ...BASE_ENV });
      for (const name of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
        const entry = composeEntry(content, name);
        expect(entry, `${name} in ${file}`).toBeDefined();
        expect(resolve(entry!, {})).toBe(String(env[name]));
      }
    },
  );

  it('rejects an out-of-range override instead of passing it to the container', () => {
    resetEnvForTests();
    expect(() => loadEnv({ ...BASE_ENV, RATE_LIMIT_USER_QUOTA_MAX: '100001' })).toThrow();
    expect(() => loadEnv({ ...BASE_ENV, RATE_LIMIT_ATTEMPT_WINDOW_MS: '999' })).toThrow();
    expect(() => loadEnv({ ...BASE_ENV, RATE_LIMIT_ATTEMPT_WINDOW_MS: '86400001' })).toThrow();
    resetEnvForTests();
    expect(
      loadEnv({ ...BASE_ENV, RATE_LIMIT_USER_QUOTA_MAX: '100000' }).RATE_LIMIT_USER_QUOTA_MAX,
    ).toBe(100_000);
  });

  it('keeps the shared address high-water below the per-caller budgets by default', () => {
    resetEnvForTests();
    const env = loadEnv({ ...BASE_ENV });
    // The shared address cap still binds first for an office behind one
    // address, so the per-caller budgets only help once an operator raises
    // the high-water explicitly.
    expect(env.RATE_LIMIT_MAX).toBeLessThan(env.RATE_LIMIT_USER_QUOTA_MAX);
    expect(env.RATE_LIMIT_MAX).toBeLessThan(env.RATE_LIMIT_TOKEN_QUOTA_MAX);
    // The issuance budgets stay above the ten active tokens per owner.
    expect(env.RATE_LIMIT_TOKEN_ISSUANCE_MAX).toBeGreaterThanOrEqual(10);
  });
});
