import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { resetEnvForTests } from '../config/env.js';
import {
  acquireRateLimitResources,
  awaitRedisReady,
  clientIpKey,
  closeRateLimitResources,
  createGlobalLimiter,
  createLoginLimiter,
  sharedRedisClient,
} from './rateLimit.js';

const fake = vi.hoisted(() => ({
  clients: [] as { url: string; quit?: () => Promise<string>; disconnect?: () => void }[],
  calls: [] as string[][],
  counts: new Map<string, number>(),
  connectFails: false,
}));

vi.mock('ioredis', () => ({
  Redis: class {
    url: string;
    status = 'ready';
    quit = vi.fn(async () => 'OK');
    private readonly listeners = new Map<string, (() => void)[]>();
    constructor(url: string) {
      this.url = url;
      fake.clients.push(this);
    }
    on(event: string, listener: () => void) {
      const existing = this.listeners.get(event) ?? [];
      existing.push(listener);
      this.listeners.set(event, existing);
      return this;
    }
    once(event: string, listener: () => void) {
      return this.on(event, listener);
    }
    off(event: string, listener: () => void) {
      const existing = this.listeners.get(event) ?? [];
      this.listeners.set(
        event,
        existing.filter((entry) => entry !== listener),
      );
      return this;
    }
    emit(event: string) {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
    }
    async connect() {
      this.status = 'ready';
      if (fake.connectFails) {
        queueMicrotask(() => this.emit('error'));
        throw new Error('connection refused');
      }
      queueMicrotask(() => this.emit('ready'));
      return undefined;
    }
    async call(...args: string[]) {
      fake.calls.push(args);
      const [command, , , key] = args;
      if (command === 'SCRIPT') return args[2]!.includes('INCR') ? 'increment-sha' : 'get-sha';
      if (command === 'EVALSHA') {
        if (args[1] === 'increment-sha') {
          const count = (fake.counts.get(key!) ?? 0) + 1;
          fake.counts.set(key!, count);
          return [count, Number(args[4])];
        }
        return [fake.counts.get(key!) ?? 0, 60000];
      }
      if (command === 'DECR') {
        fake.counts.set(args[1]!, (fake.counts.get(args[1]!) ?? 0) - 1);
        return 0;
      }
      throw new Error(`Unexpected command ${command}`);
    }
  },
}));

const BASE_ENV = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'aB1!cD2@eF3#gH4$iJ5%kL6&mN7*oP8+',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
} as const;

function useEnv(overrides: Record<string, string> = {}): void {
  const base: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(base)) {
    if (key.startsWith('RATE_LIMIT_') || key === 'AUTH_RATE_LIMIT_MAX') delete base[key];
  }
  process.env = { ...base, ...BASE_ENV, ...overrides };
  resetEnvForTests();
}

describe('clientIpKey', () => {
  it('uses Express trusted-proxy resolution instead of raw forwarding headers', () => {
    const req = {
      ip: '203.0.113.7',
      socket: { remoteAddress: '127.0.0.1' },
      headers: { 'x-forwarded-for': '198.51.100.10, 203.0.113.7' },
    } as unknown as Request;

    expect(clientIpKey(req)).toBe('203.0.113.7');
  });

  it('falls back to the socket address when Express has no IP', () => {
    const req = {
      ip: undefined,
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;

    expect(clientIpKey(req)).toBe('127.0.0.1');
  });

  it.each([
    ['2001:db8:abcd:1200::1', '2001:db8:abcd:1200::/56'],
    ['2001:db8:abcd:12ff:ffff::1', '2001:db8:abcd:1200::/56'],
    ['2001:0db8:abcd:1200:0000:0000:0000:0001', '2001:db8:abcd:1200::/56'],
    ['2001:db8:abcd:1300::1', '2001:db8:abcd:1300::/56'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::ffff:cb00:7107', '203.0.113.7'],
  ])('normalizes %s without splitting the same client subnet', (ip, expected) => {
    const req = { ip, socket: { remoteAddress: '127.0.0.1' } } as Request;
    expect(clientIpKey(req)).toBe(expected);
  });

  it.each([undefined, '', 'garbage', '203.0.113.7:12345', '[2001:db8::1]:443'])(
    'uses a valid socket fallback for invalid Express IP %s',
    (ip) => {
      const req = { ip, socket: { remoteAddress: '2001:db8:abcd:1200::1' } } as Request;
      expect(clientIpKey(req)).toBe('2001:db8:abcd:1200::/56');
    },
  );

  it.each(['attacker-a', 'attacker-b:443', '', undefined])(
    'bounds unusable address %s to the shared unknown key',
    (ip) => {
      const req = { ip, socket: { remoteAddress: undefined } } as Request;
      expect(clientIpKey(req)).toBe('unknown');
    },
  );
});

describe('the shared limiter connection', () => {
  beforeEach(() => {
    fake.clients.length = 0;
    fake.calls.length = 0;
    useEnv();
  });

  afterEach(async () => {
    await closeRateLimitResources();
    await closeRateLimitResources();
    resetEnvForTests();
  });

  it('opens one connection per store URL and reuses it', () => {
    const first = sharedRedisClient('redis://127.0.0.1:6379/0');
    expect(sharedRedisClient('redis://127.0.0.1:6379/0')).toBe(first);
    expect(sharedRedisClient('redis://127.0.0.1:6379/1')).not.toBe(first);
    expect(fake.clients).toHaveLength(2);
  });

  it('keeps the connection while another application still holds it', async () => {
    const client = sharedRedisClient('redis://127.0.0.1:6379/0');
    acquireRateLimitResources();
    acquireRateLimitResources();
    await closeRateLimitResources();
    expect(fake.clients[0]!.quit).not.toHaveBeenCalled();
    await closeRateLimitResources();
    expect(fake.clients[0]!.quit).toHaveBeenCalled();
    // A later use opens a fresh connection instead of a closed one.
    expect(sharedRedisClient('redis://127.0.0.1:6379/0')).not.toBe(client);
  });

  it('never fails when a connection cannot be closed cleanly', async () => {
    const client = sharedRedisClient('redis://127.0.0.1:6379/0') as unknown as {
      quit?: () => Promise<string>;
    };
    client.quit = async () => {
      throw new Error('connection already gone');
    };
    acquireRateLimitResources();
    await expect(closeRateLimitResources()).resolves.toBeUndefined();
  });

  it('falls back to a hard disconnect when the graceful close is unavailable', async () => {
    const client = sharedRedisClient('redis://127.0.0.1:6379/0') as unknown as {
      quit?: () => Promise<string>;
      disconnect?: () => void;
    };
    const disconnect = vi.fn();
    delete client.quit;
    client.disconnect = disconnect;
    acquireRateLimitResources();
    await closeRateLimitResources();
    expect(disconnect).toHaveBeenCalled();
  });

  it('closes a connection that offers neither a graceful nor a hard close', async () => {
    const client = sharedRedisClient('redis://127.0.0.1:6379/0') as unknown as {
      quit?: () => Promise<string>;
    };
    delete client.quit;
    acquireRateLimitResources();
    await expect(closeRateLimitResources()).resolves.toBeUndefined();
  });
  it('closes nothing when no application ever held a connection', async () => {
    await expect(closeRateLimitResources()).resolves.toBeUndefined();
    expect(fake.clients).toHaveLength(0);
  });
});

describe('the limiter connection readiness', () => {
  beforeEach(() => {
    fake.clients.length = 0;
    fake.calls.length = 0;
    fake.connectFails = false;
    useEnv();
  });

  afterEach(async () => {
    await closeRateLimitResources();
    resetEnvForTests();
  });

  it('returns immediately for a usable connection', async () => {
    await expect(
      awaitRedisReady(sharedRedisClient('redis://127.0.0.1:6379/0')),
    ).resolves.toBeUndefined();
  });

  it('refuses a closed connection with a fixed message', async () => {
    const client = sharedRedisClient('redis://127.0.0.1:6379/0');
    client.status = 'end';
    await expect(awaitRedisReady(client)).rejects.toThrow('Rate limit store is unavailable');
  });

  it('waits for a lazy connection to become usable', async () => {
    const client = sharedRedisClient('redis://127.0.0.1:6379/0');
    client.status = 'wait';
    await expect(awaitRedisReady(client)).resolves.toBeUndefined();
    expect(client.status).toBe('ready');
  });

  it('fails with a fixed message when the connection reports an error', async () => {
    fake.connectFails = true;
    const client = sharedRedisClient('redis://127.0.0.1:6379/0');
    client.status = 'wait';
    await expect(awaitRedisReady(client)).rejects.toThrow('Rate limit store is unavailable');
  });

  it('gives up after the bounded delay', async () => {
    const client = sharedRedisClient('redis://127.0.0.1:6379/0');
    client.status = 'connecting';
    await expect(awaitRedisReady(client)).rejects.toThrow('Rate limit store is unavailable');
  });
});

describe('the login and global limiters', () => {
  beforeEach(() => {
    fake.clients.length = 0;
    fake.calls.length = 0;
    useEnv();
  });

  afterEach(async () => {
    await closeRateLimitResources();
    resetEnvForTests();
  });

  it('answers with the standard rejection envelope and exempts the probes', async () => {
    useEnv({ RATE_LIMIT_MAX: '1', RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379/0' });
    const app = express();
    app.use(createGlobalLimiter());
    app.get('/health', (_req, res) => res.sendStatus(200));
    app.get('/resource', (_req, res) => res.sendStatus(200));
    expect((await request(app).get('/resource')).status).toBe(200);
    const limited = await request(app).get('/resource');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
    expect((await request(app).get('/health')).status).toBe(200);
  });

  it('keeps the failed-login budget in its own namespace', async () => {
    useEnv({
      AUTH_RATE_LIMIT_MAX: '1',
      RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379/0',
    });
    const app = express();
    app.use(createLoginLimiter());
    // A failed login keeps its attempt; a successful one would be refunded.
    app.post('/login', (_req, res) => res.status(401).json({ error: { code: 'UNAUTHENTICATED' } }));
    expect((await request(app).post('/login')).status).toBe(401);
    const limited = await request(app).post('/login');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    const keys = fake.calls.filter(([command]) => command === 'EVALSHA').map(([, , , key]) => key);
    expect(keys.some((key) => key?.startsWith('pto:rate-limit:auth:'))).toBe(true);
  });

  it('works without a shared store outside production', async () => {
    useEnv({ RATE_LIMIT_MAX: '1' });
    const app = express();
    app.use(createGlobalLimiter());
    app.get('/resource', (_req, res) => res.sendStatus(200));
    expect((await request(app).get('/resource')).status).toBe(200);
    expect((await request(app).get('/resource')).status).toBe(429);
    expect(fake.clients).toHaveLength(0);
  });
});
