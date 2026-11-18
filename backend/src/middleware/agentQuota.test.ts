import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvForTests } from '../config/env.js';
import {
  __resetAgentQuotaForTests,
  __useMemoryQuotaStoreForTests,
  agentQuotaPolicy,
  chargeAuthenticatedTraffic,
  chargeBearerFailure,
  chargeTokenIssuance,
  chargeTokenPassword,
  MemoryQuotaBackend,
  QuotaStoreError,
  remainingWindowSeconds,
  sendRateLimited,
} from './agentQuota.js';

const fake = vi.hoisted(() => ({
  evals: [] as { script: string; keys: number; args: string[] }[],
  failEval: false,
  reply: ['1', '0', '0'] as string[],
}));

vi.mock('ioredis', () => ({
  Redis: class {
    status = 'ready';
    async eval(script: string, keys: number, ...args: string[]) {
      fake.evals.push({ script, keys, args });
      if (fake.failEval) throw new Error('redis unavailable');
      return fake.reply;
    }
    async call() {
      return 'OK';
    }
    async quit() {
      return 'OK';
    }
  },
}));

const BASE_ENV = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'aB1!cD2@eF3#gH4$iJ5%kL6&mN7*oP8+',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
} as const;
const CLOCK_START = Date.UTC(2026, 0, 1, 0, 0, 0, 1);

function useEnv(overrides: Record<string, string> = {}): void {
  const base: Record<string, string | undefined> = { ...process.env };
  // Every limiter override is scoped to one test, so a previous case can
  // never leak its policy into the next one.
  for (const key of Object.keys(base)) {
    if (key.startsWith('RATE_LIMIT_')) delete base[key];
  }
  process.env = { ...base, ...BASE_ENV, ...overrides };
  resetEnvForTests();
  __resetAgentQuotaForTests();
}

function requestAt(ip: string): Request {
  return { ip, socket: { remoteAddress: ip } } as unknown as Request;
}

const session = {
  method: 'session' as const,
  actor: { id: 'user-a', role: 'member' as const },
  requestId: 'req-a',
};

const pat = {
  method: 'pat' as const,
  actor: { id: 'user-a', role: 'member' as const },
  requestId: 'req-b',
  tokenId: 'token-a',
  scopes: ['pto:read'] as const,
  expiresAt: new Date(Date.now() + 86_400_000),
};

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(CLOCK_START);
  fake.evals.length = 0;
  fake.failEval = false;
  fake.reply = ['1', '0', '0'];
  useEnv();
});

afterEach(() => {
  vi.mocked(Date.now).mockRestore();
  resetEnvForTests();
  __resetAgentQuotaForTests();
  vi.unstubAllEnvs();
});

describe('agent quota policy', () => {
  it('uses the documented defaults and the attempt/quota windows', () => {
    const policy = agentQuotaPolicy();
    expect(policy.bearerFailure).toEqual({ limit: 20, windowMs: 900_000 });
    expect(policy.userTraffic).toEqual({ limit: 600, windowMs: 60_000 });
    expect(policy.tokenTraffic).toEqual({ limit: 300, windowMs: 60_000 });
    expect(policy.tokenIssuance).toEqual({ limit: 20, windowMs: 900_000 });
    expect(policy.tokenPassword).toEqual({ limit: 20, windowMs: 900_000 });
  });

  it('follows the bounded environment overrides', () => {
    useEnv({
      RATE_LIMIT_ATTEMPT_WINDOW_MS: '60000',
      RATE_LIMIT_QUOTA_WINDOW_MS: '30000',
      RATE_LIMIT_BEARER_FAILURE_MAX: '3',
      RATE_LIMIT_USER_QUOTA_MAX: '4',
      RATE_LIMIT_TOKEN_QUOTA_MAX: '2',
      RATE_LIMIT_TOKEN_ISSUANCE_MAX: '5',
      RATE_LIMIT_TOKEN_PASSWORD_MAX: '6',
    });
    const policy = agentQuotaPolicy();
    expect(policy.bearerFailure).toEqual({ limit: 3, windowMs: 60_000 });
    expect(policy.userTraffic).toEqual({ limit: 4, windowMs: 30_000 });
    expect(policy.tokenTraffic).toEqual({ limit: 2, windowMs: 30_000 });
    expect(policy.tokenIssuance).toEqual({ limit: 5, windowMs: 60_000 });
    expect(policy.tokenPassword).toEqual({ limit: 6, windowMs: 60_000 });
  });
});

describe('the process-local counter', () => {
  it('counts separate subjects inside one window', async () => {
    const backend = new MemoryQuotaBackend();
    const subject = { kind: 'user-traffic' as const, key: 'user:a' };
    const first = await backend.increment(subject, 60_000);
    expect(first.totalHits).toBe(1);
    const second = await backend.increment(subject, 60_000);
    expect(second.totalHits).toBe(2);
    expect(second.generation).toBe(first.generation);
    expect(second.resetTime.getTime()).toBe(first.resetTime.getTime());
    const other = await backend.increment({ kind: 'user-traffic', key: 'user:b' }, 60_000);
    expect(other.totalHits).toBe(1);
  });

  it('starts a new window once the previous one elapsed', async () => {
    const backend = new MemoryQuotaBackend();
    const subject = { kind: 'user-traffic' as const, key: 'user:a' };
    const first = await backend.increment(subject, 1000);
    expect(first.totalHits).toBe(1);
    vi.mocked(Date.now).mockReturnValue(first.resetTime.getTime());
    const second = await backend.increment(subject, 1000);
    expect(second.totalHits).toBe(1);
    expect(second.generation).not.toBe(first.generation);
  });

  it('gives one attempt of its own window back exactly once', async () => {
    const backend = new MemoryQuotaBackend();
    const subject = { kind: 'bearer-failure' as const, key: 'ip:1' };
    const charge = await backend.increment(subject, 60_000);
    await backend.compensate(subject, 60_000, charge.generation, 'attempt-1');
    const after = await backend.increment(subject, 60_000);
    expect(after.totalHits).toBe(1);
    // The same attempt is never given back twice.
    await backend.compensate(subject, 60_000, charge.generation, 'attempt-1');
    const again = await backend.increment(subject, 60_000);
    expect(again.totalHits).toBe(2);
  });

  it('never lets an old attempt touch a newer window', async () => {
    const backend = new MemoryQuotaBackend();
    const subject = { kind: 'bearer-failure' as const, key: 'ip:1' };
    const old = await backend.increment(subject, 1000);
    vi.mocked(Date.now).mockReturnValue(old.resetTime.getTime());
    const fresh = await backend.increment(subject, 1000);
    expect(fresh.totalHits).toBe(1);
    // The stale compensation arrives after the window changed.
    await backend.compensate(subject, 1000, old.generation, 'attempt-1');
    const after = await backend.increment(subject, 1000);
    expect(after.totalHits).toBe(2);
  });

  it('never creates a counter for a missing subject', async () => {
    const backend = new MemoryQuotaBackend();
    const subject = { kind: 'bearer-failure' as const, key: 'ip:missing' };
    await backend.compensate(subject, 60_000, '1', 'attempt-1');
    const created = await backend.increment(subject, 60_000);
    expect(created.totalHits).toBe(1);
  });

  it('never compensates below zero', async () => {
    const backend = new MemoryQuotaBackend();
    const subject = { kind: 'bearer-failure' as const, key: 'ip:1' };
    const charge = await backend.increment(subject, 60_000);
    await backend.compensate(subject, 60_000, charge.generation, 'attempt-1');
    // The counter is already empty; another attempt changes nothing.
    await backend.compensate(subject, 60_000, charge.generation, 'attempt-2');
    expect((await backend.increment(subject, 60_000)).totalHits).toBe(1);
  });

  it('drops every counter on reset', async () => {
    const backend = new MemoryQuotaBackend();
    const subject = { kind: 'user-traffic' as const, key: 'user:a' };
    await backend.increment(subject, 60_000);
    backend.reset();
    expect((await backend.increment(subject, 60_000)).totalHits).toBe(1);
  });
});

describe('pre-verification bearer budget', () => {
  it('charges per client address so one shared office address cannot lock another', async () => {
    useEnv({ RATE_LIMIT_BEARER_FAILURE_MAX: '1' });
    const first = await chargeBearerFailure(requestAt('203.0.113.7'));
    expect(first.allowed).toBe(true);
    const second = await chargeBearerFailure(requestAt('203.0.113.7'));
    expect(second.allowed).toBe(false);
    const other = await chargeBearerFailure(requestAt('198.51.100.9'));
    expect(other.allowed).toBe(true);
  });

  it('refunds a verified secret so a legitimate client keeps its budget', async () => {
    useEnv({ RATE_LIMIT_BEARER_FAILURE_MAX: '1' });
    const charge = await chargeBearerFailure(requestAt('203.0.113.7'));
    expect(charge.allowed).toBe(true);
    await charge.refund();
    expect((await chargeBearerFailure(requestAt('203.0.113.7'))).allowed).toBe(true);
  });

  it('keeps the failed attempt charged when no refund happens', async () => {
    useEnv({ RATE_LIMIT_BEARER_FAILURE_MAX: '1' });
    await chargeBearerFailure(requestAt('203.0.113.7'));
    expect((await chargeBearerFailure(requestAt('203.0.113.7'))).allowed).toBe(false);
  });

  it('does not refund a charge whose window already reset', async () => {
    useEnv({ RATE_LIMIT_BEARER_FAILURE_MAX: '1', RATE_LIMIT_ATTEMPT_WINDOW_MS: '1000' });
    const req = requestAt('203.0.113.7');
    const charge = await chargeBearerFailure(req);
    vi.mocked(Date.now).mockReturnValue(charge.resetTime.getTime());
    const fresh = await chargeBearerFailure(req);
    expect(fresh.allowed).toBe(true);
    await charge.refund();
    expect((await chargeBearerFailure(req)).allowed).toBe(false);
  });
});

describe('verified traffic budgets', () => {
  it('charges the session owner and leaves other users untouched', async () => {
    useEnv({ RATE_LIMIT_USER_QUOTA_MAX: '1' });
    expect(await chargeAuthenticatedTraffic(session)).toBeUndefined();
    const rejected = await chargeAuthenticatedTraffic(session);
    expect(rejected?.kind).toBe('user-traffic');
    expect(rejected?.allowed).toBe(false);
    expect(
      await chargeAuthenticatedTraffic({ ...session, actor: { id: 'user-b', role: 'member' } }),
    ).toBeUndefined();
  });

  it('charges a personal token against its own token budget', async () => {
    useEnv({ RATE_LIMIT_TOKEN_QUOTA_MAX: '1' });
    expect(await chargeAuthenticatedTraffic(pat)).toBeUndefined();
    const rejected = await chargeAuthenticatedTraffic(pat);
    expect(rejected?.kind).toBe('token-traffic');
    expect(rejected?.allowed).toBe(false);
    expect(
      await chargeAuthenticatedTraffic({
        ...pat,
        tokenId: 'token-b',
      }),
    ).toBeUndefined();
  });

  it('never charges a session against a token budget', async () => {
    useEnv({ RATE_LIMIT_TOKEN_QUOTA_MAX: '1', RATE_LIMIT_USER_QUOTA_MAX: '5' });
    for (let index = 0; index < 3; index += 1)
      expect(await chargeAuthenticatedTraffic(session)).toBeUndefined();
  });

  it('reports the rejecting budget of the exact window', async () => {
    useEnv({ RATE_LIMIT_USER_QUOTA_MAX: '1', RATE_LIMIT_QUOTA_WINDOW_MS: '60000' });
    await chargeAuthenticatedTraffic(session);
    const rejected = await chargeAuthenticatedTraffic(session);
    expect(rejected?.remaining).toBe(0);
    expect(rejected?.resetTime.getTime()).toBeGreaterThan(Date.now());
    expect(remainingWindowSeconds(rejected!)).toBeGreaterThan(0);
    expect(remainingWindowSeconds(rejected!)).toBeLessThanOrEqual(60);
  });
});

describe('issuance budgets', () => {
  it('bounds token creation per verified owner', async () => {
    useEnv({ RATE_LIMIT_TOKEN_ISSUANCE_MAX: '1' });
    expect((await chargeTokenIssuance('user-a')).allowed).toBe(true);
    expect((await chargeTokenIssuance('user-a')).allowed).toBe(false);
    expect((await chargeTokenIssuance('user-b')).allowed).toBe(true);
  });

  it('bounds issuance password verification per verified owner', async () => {
    useEnv({ RATE_LIMIT_TOKEN_PASSWORD_MAX: '2' });
    const first = await chargeTokenPassword('user-a');
    expect(first.allowed).toBe(true);
    // A verified password is not given back: the budget bounds the expensive
    // comparisons themselves.
    expect((await chargeTokenPassword('user-a')).allowed).toBe(true);
    expect((await chargeTokenPassword('user-a')).allowed).toBe(false);
    expect((await chargeTokenPassword('user-b')).allowed).toBe(true);
  });
});

describe('the shared Redis counters', () => {
  beforeEach(() => {
    useEnv({ RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379/15' });
  });

  it('uses one namespaced key space per counter', async () => {
    await chargeBearerFailure(requestAt('203.0.113.7'));
    await chargeTokenIssuance('user-a');
    await chargeTokenPassword('user-a');
    await chargeAuthenticatedTraffic(pat);
    const keys = fake.evals.flatMap((call) => call.args.slice(0, call.keys));
    expect(keys).toContain('pto:rate-limit:bearer-failure:ip:203.0.113.7');
    expect(keys).toContain('pto:rate-limit:token-issuance:user:user-a');
    expect(keys).toContain('pto:rate-limit:token-password:user:user-a');
    expect(keys).toContain('pto:rate-limit:quota-user:user:user-a');
    expect(keys).toContain('pto:rate-limit:quota-token:token:token-a');
  });

  it('runs the counter and the compensation as one atomic script each', async () => {
    fake.reply = ['2', '1795016977000', '17'];
    const charge = await chargeTokenPassword('user-a');
    expect(charge.resetTime.getTime()).toBe(1795016977000);
    const increment = fake.evals.at(-1)!;
    expect(increment.script).toContain('pto-quota:increment');
    expect(increment.keys).toBe(1);
    expect(increment.args[0]).toBe('pto:rate-limit:token-password:user:user-a');
    expect(increment.args[1]).toBe('900000');
    await charge.refund();
    const compensation = fake.evals.at(-1)!;
    expect(compensation.script).toContain('pto-quota:compensate');
    expect(compensation.keys).toBe(2);
    expect(compensation.args[0]).toBe('pto:rate-limit:token-password:user:user-a');
    expect(compensation.args[1]).toBe('pto:rate-limit:token-password:user:user-a:refunds');
    expect(compensation.args[2]).toBe('17');
    expect(compensation.args[3]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('fails closed when the shared store is unavailable', async () => {
    fake.failEval = true;
    await expect(chargeTokenIssuance('user-a')).rejects.toBeInstanceOf(QuotaStoreError);
    fake.failEval = false;
    expect((await chargeTokenIssuance('user-a')).allowed).toBe(true);
  });

  it('keeps a successful operation successful when its compensation fails', async () => {
    const charge = await chargeTokenPassword('user-a');
    fake.failEval = true;
    await expect(charge.refund()).resolves.toBeUndefined();
    fake.failEval = false;
  });
});

describe('the storage adapter substitution', () => {
  it('uses the local counter when the shared store is not configured', async () => {
    expect(fake.evals).toHaveLength(0);
    await chargeTokenIssuance('user-a');
    expect(fake.evals).toHaveLength(0);
  });

  it('uses the local counter when the suite substitutes the adapter', async () => {
    useEnv({ RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379/15' });
    __useMemoryQuotaStoreForTests();
    await chargeTokenIssuance('user-a');
    expect(fake.evals).toHaveLength(0);
    __resetAgentQuotaForTests();
    await chargeTokenIssuance('user-a');
    expect(fake.evals.length).toBeGreaterThan(0);
  });
});

describe('the rejection response', () => {
  it('returns the standard envelope, the exact retry delay and a safe correlation id', async () => {
    useEnv({ RATE_LIMIT_USER_QUOTA_MAX: '1', RATE_LIMIT_QUOTA_WINDOW_MS: '60000' });
    await chargeAuthenticatedTraffic(session);
    const rejected = await chargeAuthenticatedTraffic(session);
    const json = vi.fn();
    const headers = new Map<string, string>();
    const res = {
      status: vi.fn().mockReturnValue({ json }),
      setHeader: (name: string, value: string) => headers.set(name, value),
      getHeader: (name: string) => headers.get(name),
    } as unknown as Response;
    const req = { headers: {} } as unknown as Request;
    sendRateLimited(req, res, rejected!, 'Too many requests. Try again later.');
    expect(res.status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' },
    });
    const remaining = remainingWindowSeconds(rejected!);
    expect(headers.get('Retry-After')).toBe(String(remaining));
    expect(headers.get('RateLimit')).toContain(`limit=${rejected!.limit}`);
    expect(headers.get('RateLimit')).toContain('remaining=0');
    // The draft-7 reset is the remaining delay, not an absolute timestamp.
    expect(headers.get('RateLimit')).toContain(`reset=${remaining}`);
    expect(Number(/reset=(\d+)/.exec(headers.get('RateLimit')!)![1])).toBeLessThanOrEqual(60);
    expect(headers.get('RateLimit-Policy')).toBe(`${rejected!.limit};w=60`);
    expect(headers.get('X-Request-Id')).toMatch(/^[A-Za-z0-9._-]{1,200}$/);
  });

  it('keeps an inbound correlation id and never echoes a credential', async () => {
    const json = vi.fn();
    const headers = new Map<string, string>();
    const res = {
      status: vi.fn().mockReturnValue({ json }),
      setHeader: (name: string, value: string) => headers.set(name, value),
      getHeader: (name: string) => headers.get(name),
    } as unknown as Response;
    const req = { headers: { 'x-request-id': 'safe-inbound-id' } } as unknown as Request;
    const charge = {
      kind: 'user-traffic' as const,
      allowed: false,
      limit: 1,
      remaining: 0,
      resetTime: new Date(Date.now() + 1000),
      windowMs: 60_000,
      refund: async () => undefined,
    };
    sendRateLimited(req, res, charge, 'Too many requests. Try again later.');
    expect(headers.get('X-Request-Id')).toBe('safe-inbound-id');
    expect(JSON.stringify(json.mock.calls)).not.toContain('pto_pat_');
  });
});
