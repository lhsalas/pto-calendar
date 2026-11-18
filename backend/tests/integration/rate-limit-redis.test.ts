import express, { type Request } from 'express';
import { Redis } from 'ioredis';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  counts: new Map<string, number>(),
  commands: [] as string[][],
  failIncrement: false,
  failLoad: false,
  failGetLoad: false,
  noScript: false,
  onDecrement: undefined as (() => void) | undefined,
  loadGate: undefined as Promise<void> | undefined,
  onLoad: undefined as (() => void) | undefined,
}));

vi.mock('ioredis', () => ({
  Redis: class {
    // The limiter waits for a usable socket before its first command; this
    // synthetic connection is usable from the start.
    status = 'ready';
    async call(...args: string[]) {
      fake.commands.push(args);
      const [command, a, , key] = args;
      if (command === 'SCRIPT') {
        fake.onLoad?.();
        await fake.loadGate;
        const increment = args[2]!.includes('INCR');
        if (fake.failLoad || (!increment && fake.failGetLoad)) throw new Error('redis unavailable');
        return increment ? 'increment-sha' : 'get-sha';
      }
      if (command === 'EVALSHA') {
        if (fake.noScript) {
          fake.noScript = false;
          throw new Error('NOSCRIPT missing script');
        }
        if (a === 'increment-sha') {
          if (fake.failIncrement) throw new Error('redis unavailable');
          const count = (fake.counts.get(key!) ?? 0) + 1;
          fake.counts.set(key!, count);
          return [count, Number(args[4])];
        }
        return [fake.counts.get(key!) ?? false, 60000];
      }
      if (command === 'DECR') {
        fake.counts.set(a!, (fake.counts.get(a!) ?? 0) - 1);
        fake.onDecrement?.();
        return 1;
      }
      if (command === 'DEL') {
        fake.counts.delete(a!);
        return 1;
      }
      throw new Error(`Unexpected command ${command}`);
    }
  },
}));

vi.mock('../../src/config/env.js', () => ({
  loadEnv: () => ({
    RATE_LIMIT_REDIS_URL: 'redis://synthetic.invalid',
    RATE_LIMIT_WINDOW_MS: 60000,
    RATE_LIMIT_MAX: 2,
    AUTH_RATE_LIMIT_MAX: 2,
  }),
}));

import { clientIpKey, createGlobalLimiter, createLoginLimiter } from '../../src/lib/rateLimit.js';

describe('real limiter and Redis store with synthetic Redis commands', () => {
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fake.counts.clear();
    fake.commands.length = 0;
    fake.failIncrement = false;
    fake.failLoad = false;
    fake.failGetLoad = false;
    fake.noScript = false;
    fake.onDecrement = undefined;
    fake.loadGate = undefined;
    fake.onLoad = undefined;
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errors.mockRestore();
  });

  function appFor(ip: string) {
    const app = express();
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'ip', { value: ip });
      next();
    });
    app.use(createGlobalLimiter());
    app.get('/health', (_req, res) => res.sendStatus(200));
    app.get('/resource', (_req, res) => res.sendStatus(200));
    return app;
  }

  it('bounds malformed addresses and normalizes socket fallback and mapped IPv4', () => {
    const req = (ip: string | undefined, remoteAddress: string | undefined) =>
      ({ ip, socket: { remoteAddress } }) as Request;
    expect(clientIpKey(req('bad:443', '::ffff:192.0.2.1'))).toBe('192.0.2.1');
    expect(clientIpKey(req(undefined, 'bad:443'))).toBe('unknown');
    expect(clientIpKey(req('::ffff:192.0.2.1', undefined))).toBe('192.0.2.1');
  });

  it('shares the IPv6 /56 quota, emits draft-7 and Retry-After, and exempts probes', async () => {
    const first = appFor('2001:db8:abcd:1200::1');
    const second = appFor('2001:db8:abcd:12ff::2');
    const other = appFor('2001:db8:abcd:1300::1');
    const response = await request(first).get('/resource');
    expect(response.status).toBe(200);
    expect(response.headers.ratelimit).toBeDefined();
    expect((await request(second).get('/resource')).status).toBe(200);
    const limited = await request(first).get('/resource');
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect((await request(first).get('/health')).status).toBe(200);
    expect((await request(other).get('/resource')).status).toBe(200);
    expect(fake.counts.get('pto:rate-limit:global:2001:db8:abcd:1200::/56')).toBe(3);
    expect(JSON.stringify(errors.mock.calls)).not.toContain('ERR_ERL_KEY_GEN_IPV6');
  });

  it('blocks requests on increment failure and recovers only after Redis succeeds', async () => {
    fake.failIncrement = true;
    const app = appFor('192.0.2.1');
    expect((await request(app).get('/resource')).status).toBe(500);
    expect(fake.counts.size).toBe(0);
    fake.failIncrement = false;
    expect((await request(app).get('/resource')).status).toBe(200);
    expect(fake.counts.get('pto:rate-limit:global:192.0.2.1')).toBe(1);
  });

  it('ignores spoofed forwarding headers when the socket proxy is untrusted', async () => {
    const app = express();
    app.set('trust proxy', false);
    app.use(createGlobalLimiter());
    app.get('/', (_req, res) => res.sendStatus(200));
    expect(
      (
        await request(app)
          .get('/')
          .set('X-Forwarded-For', '198.51.100.1')
          .set('Forwarded', 'for=198.51.100.1')
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .get('/')
          .set('X-Forwarded-For', '198.51.100.2')
          .set('Forwarded', 'for=198.51.100.2')
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .get('/')
          .set('X-Forwarded-For', '198.51.100.3')
          .set('Forwarded', 'for=198.51.100.3')
      ).status,
    ).toBe(429);
    expect(fake.counts.size).toBe(1);
    expect(JSON.stringify(errors.mock.calls)).not.toContain('ERR_ERL_KEY_GEN_IPV6');
  });

  it('reloads a missing increment script and records a positive counter', async () => {
    const app = appFor('192.0.2.2');
    fake.noScript = true;
    expect((await request(app).get('/resource')).status).toBe(200);
    expect(fake.commands.filter(([command]) => command === 'SCRIPT')).toHaveLength(3);
    expect(fake.counts.get('pto:rate-limit:global:192.0.2.2')).toBe(1);
  });

  it('decrements successful login asynchronously and keeps auth prefix separate', async () => {
    const app = express();
    app.use(createLoginLimiter());
    app.get('/', (_req, res) => res.sendStatus(200));
    const done = new Promise<void>((resolve) => {
      fake.onDecrement = resolve;
    });
    expect((await request(app).get('/')).status).toBe(200);
    await done;
    const key = [...fake.counts.keys()][0]!;
    expect(key.startsWith('pto:rate-limit:auth:')).toBe(true);
    expect(fake.counts.get(key)).toBe(0);
  });

  it('does not equate failed get-script initialization with failed increments', async () => {
    fake.failGetLoad = true;
    const app = appFor('192.0.2.3');
    expect((await request(app).get('/resource')).status).toBe(200);
    expect(fake.counts.get('pto:rate-limit:global:192.0.2.3')).toBe(1);
    expect(errors).toHaveBeenCalled();
  });

  it('waits for delayed increment script loading before passing a request', async () => {
    let release!: () => void;
    fake.loadGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      fake.onLoad = resolve;
    });
    const app = appFor('192.0.2.4');
    const response = request(app)
      .get('/resource')
      .then((result) => result);
    await started;
    expect(fake.counts.size).toBe(0);
    release();
    expect((await response).status).toBe(200);
    expect(fake.counts.get('pto:rate-limit:global:192.0.2.4')).toBe(1);
  });

  it('logs rejected initialization, fails closed while reload fails, then recovers', async () => {
    fake.failLoad = true;
    const app = appFor('192.0.2.5');
    expect((await request(app).get('/resource')).status).toBe(500);
    expect(fake.counts.size).toBe(0);
    expect(errors).toHaveBeenCalled();
    fake.failLoad = false;
    expect((await request(app).get('/resource')).status).toBe(200);
    expect(fake.counts.get('pto:rate-limit:global:192.0.2.5')).toBe(1);
  });

  it('preserves store prefixes, fixed window, reset time and explicit reset', async () => {
    const client = new Redis();
    const store = new RedisStore({
      prefix: 'pto:rate-limit:auth:',
      sendCommand: (command, ...args) => client.call(command, ...args) as Promise<RedisReply>,
    });
    await store.init({ windowMs: 60000 } as Parameters<RedisStore['init']>[0]);
    const before = Date.now();
    const first = await store.increment('192.0.2.6');
    const second = await store.increment('192.0.2.6');
    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(2);
    expect(first.resetTime!.getTime()).toBeGreaterThanOrEqual(before + 60000);
    expect(fake.commands.filter(([command]) => command === 'EVALSHA').slice(0, 2)).toEqual([
      ['EVALSHA', 'increment-sha', '1', 'pto:rate-limit:auth:192.0.2.6', '60000'],
      ['EVALSHA', 'increment-sha', '1', 'pto:rate-limit:auth:192.0.2.6', '60000'],
    ]);
    fake.noScript = true;
    expect((await store.get('192.0.2.6'))?.totalHits).toBe(2);
    await store.resetKey('192.0.2.6');
    expect((await store.increment('192.0.2.6')).totalHits).toBe(1);
  });
});
