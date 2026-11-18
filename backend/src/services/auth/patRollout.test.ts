import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv, resetEnvForTests } from '../../config/env.js';

const base = {
  SESSION_SECRET: 'aB1!cD2@eF3#gH4$iJ5%kL6&mN7*oP8+',
  DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:1/pto_test',
  COOKIE_SECURE: 'true',
  RATE_LIMIT_REDIS_URL: 'rediss://redis.example.test:6379/0',
};
afterEach(resetEnvForTests);

describe('strict disabled-by-default personal-token rollout flags', () => {
  it.each(['test', 'development', 'production'])('defaults both flags off in %s', (NODE_ENV) => {
    resetEnvForTests();
    const env = loadEnv({ ...base, NODE_ENV });
    expect(env.PAT_AUTH_ENABLED).toBe(false);
    expect(env.PAT_WRITES_ENABLED).toBe(false);
  });
  it('requires exact true/false rather than truthy coercion', () => {
    for (const value of ['true', 'false']) {
      resetEnvForTests();
      const env = loadEnv({ ...base, PAT_AUTH_ENABLED: value, PAT_WRITES_ENABLED: value });
      expect(env.PAT_AUTH_ENABLED).toBe(value === 'true');
      expect(env.PAT_WRITES_ENABLED).toBe(value === 'true');
    }
    for (const key of ['PAT_AUTH_ENABLED', 'PAT_WRITES_ENABLED']) {
      for (const value of ['', '1', 'TRUE', 'yes', ' false']) {
        resetEnvForTests();
        expect(() => loadEnv({ ...base, [key]: value })).toThrow(key);
      }
    }
  });
});
