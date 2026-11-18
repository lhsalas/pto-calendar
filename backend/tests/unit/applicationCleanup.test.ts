import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The application cleanup owns the shared limiter connection. This suite has
 * its own module registry, so the reference count of live applications starts
 * from zero and the ownership of the connection is observable.
 */
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
}));

vi.mock('../../src/lib/logger.js', async () => {
  const { Writable } = await import('node:stream');
  const { pino } = await import('pino');
  const sink = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  return {
    logger: pino({ level: 'info', base: { pid: 0, hostname: 'test' } }, sink as never),
    Logger: undefined,
  };
});

vi.mock('ioredis', () => ({
  Redis: class {
    status = 'ready';
    async call(...args: string[]) {
      const [command] = args;
      if (command === 'SCRIPT') return args[2]!.includes('INCR') ? 'increment-sha' : 'get-sha';
      if (command === 'EVALSHA') return [1, 60000];
      if (command === 'DECR') return 0;
      throw new Error(`Unexpected command ${command}`);
    }
    async quit() {
      return 'OK';
    }
    disconnect() {}
  },
}));

import { createApp } from '../../src/server.js';
import { resetEnvForTests } from '../../src/config/env.js';
import { sharedRedisClient } from '../../src/lib/rateLimit.js';

const REDIS_URL = 'redis://127.0.0.1:6379/0';
const originalEnv = { ...process.env };

describe('the application cleanup', () => {
  afterEach(() => {
    process.env = { ...originalEnv };
    resetEnvForTests();
  });

  it('releases the shared limiter connection only once per application', async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      SESSION_SECRET: 'aB1!cD2@eF3#gH4$iJ5%kL6&mN7*oP8+',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      RATE_LIMIT_REDIS_URL: REDIS_URL,
    });
    resetEnvForTests();
    const first = createApp();
    const second = createApp();
    const connection = sharedRedisClient(REDIS_URL);
    await first.closeResources();
    // A repeated cleanup must not take the connection the other application
    // still owns.
    await first.closeResources();
    expect(sharedRedisClient(REDIS_URL)).toBe(connection);
    await second.closeResources();
    // The last application releases it, so the next use opens a new one.
    expect(sharedRedisClient(REDIS_URL)).not.toBe(connection);
  });
});
