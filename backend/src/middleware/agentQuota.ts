import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { loadEnv } from '../config/env.js';
import { awaitRedisReady, clientIpKey, sharedRedisClient } from '../lib/rateLimit.js';
import { safeRequestId } from '../lib/logSanitizers.js';
import type { AuthContext } from '../services/auth/authContext.js';

/**
 * Operational quotas for personal-token issuance and authenticated agent
 * traffic (#253).
 *
 * The counters live in the same production Redis deployment as the login and
 * global limiters, in separate namespaces, so every instance of the API shares
 * one budget. A missing store fails closed: the request is refused instead of
 * running unmetered, and the driver cause never reaches a log or a response.
 *
 * Two rules shape every key here:
 *  - A quota that belongs to an account is keyed by the *verified* identity
 *    (the user id or the verified token public id). An unverified
 *    `Authorization` header is never an identity, not even hashed.
 *  - The pre-verification bearer counter is keyed by the client address only,
 *    because the secret is not known to be valid at that point.
 *
 * A counter is a fixed window whose identity is its *generation*: the window
 * index derived from the store clock. The generation is stored with the count,
 * so a compensation can only ever give back an attempt of the window it was
 * charged in. It can never credit a later window, it can never compensate the
 * same attempt twice, and it never creates a counter that does not exist.
 */
export type QuotaKind =
  'bearer-failure' | 'user-traffic' | 'token-traffic' | 'token-issuance' | 'token-password';

/** One namespace per counter. Namespaces never share a key space. */
const QUOTA_PREFIX: Record<QuotaKind, string> = {
  'bearer-failure': 'pto:rate-limit:bearer-failure:',
  'user-traffic': 'pto:rate-limit:quota-user:',
  'token-traffic': 'pto:rate-limit:quota-token:',
  'token-issuance': 'pto:rate-limit:token-issuance:',
  'token-password': 'pto:rate-limit:token-password:',
};

/** A store failure is never reported with its driver cause. */
export class QuotaStoreError extends Error {
  constructor() {
    super('Rate limit store is unavailable');
    this.name = 'QuotaStoreError';
  }
}

export interface QuotaCharge {
  readonly kind: QuotaKind;
  /** False when this charge exceeded the quota. */
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetTime: Date;
  readonly windowMs: number;
  /**
   * Compensates this charge when the guarded operation turned out to be
   * legitimate, for example after a secret verified successfully. The
   * compensation is atomic and bound to the window that was charged.
   */
  refund(): Promise<void>;
}

/** One counter identity: a namespace plus the subject inside it. */
interface QuotaSubject {
  readonly kind: QuotaKind;
  readonly key: string;
}

interface QuotaSnapshot {
  readonly totalHits: number;
  /** The window this count belongs to. */
  readonly generation: string;
  /** When the window ends. */
  readonly resetTime: Date;
}

/**
 * The counter storage contract. Both implementations keep the same observable
 * behavior: an atomic count per window, an atomic compensation that is bound
 * to one window and to one attempt, and no counter is ever created by a
 * compensation.
 */
export interface QuotaBackend {
  increment(subject: QuotaSubject, windowMs: number): Promise<QuotaSnapshot>;
  compensate(
    subject: QuotaSubject,
    windowMs: number,
    generation: string,
    attemptId: string,
  ): Promise<void>;
}

function counterKey(subject: QuotaSubject): string {
  return `${QUOTA_PREFIX[subject.kind]}${subject.key}`;
}

function refundsKey(subject: QuotaSubject): string {
  return `${counterKey(subject)}:refunds`;
}

/**
 * Counts one attempt and returns the new count with its window. The count and
 * the window identity change together, so a concurrent instance can never
 * observe a count that belongs to another window.
 */
const INCREMENT_SCRIPT = `
-- pto-quota:increment
local now = redis.call('TIME')
local nowMs = now[1] * 1000 + math.floor(now[2] / 1000)
local windowMs = tonumber(ARGV[1])
local generation = math.floor(nowMs / windowMs)
local expiresAt = (generation + 1) * windowMs
local count = 0
if redis.call('HGET', KEYS[1], 'generation') == tostring(generation) then
  count = tonumber(redis.call('HGET', KEYS[1], 'count') or '0')
end
count = count + 1
redis.call('HSET', KEYS[1], 'generation', tostring(generation), 'count', tostring(count))
redis.call('PEXPIRE', KEYS[1], expiresAt - nowMs)
return { tostring(count), tostring(expiresAt), tostring(generation) }
`;

/**
 * Gives one attempt of one window back.
 *
 *  - A different window is never touched: the stored generation must match the
 *    generation the attempt was charged in.
 *  - The same attempt is never given back twice: the attempt id is recorded.
 *  - A missing counter is never created: nothing is written unless the counter
 *    exists and still belongs to the charged window.
 */
const COMPENSATE_SCRIPT = `
-- pto-quota:compensate
if redis.call('HGET', KEYS[1], 'generation') ~= ARGV[1] then return 0 end
if redis.call('SISMEMBER', KEYS[2], ARGV[2]) == 1 then return 0 end
local count = tonumber(redis.call('HGET', KEYS[1], 'count') or '0')
if count <= 0 then return 0 end
redis.call('HSET', KEYS[1], 'count', tostring(count - 1))
redis.call('SADD', KEYS[2], ARGV[2])
local windowMs = tonumber(ARGV[3])
local now = redis.call('TIME')
local nowMs = now[1] * 1000 + math.floor(now[2] / 1000)
local expiresAt = (tonumber(ARGV[1]) + 1) * windowMs
local ttl = expiresAt - nowMs
if ttl > 0 then redis.call('PEXPIRE', KEYS[2], ttl) end
return 1
`;

/** The shared Redis counters. Every operation is one atomic script. */
class RedisQuotaBackend implements QuotaBackend {
  constructor(private readonly redisUrl: string) {}

  private async evalScript(script: string, keys: number, ...args: string[]): Promise<unknown> {
    const client = sharedRedisClient(this.redisUrl);
    // The command waits for a usable socket instead of failing with a raw
    // driver error, and the failure message carries no store detail.
    await awaitRedisReady(client);
    return client.eval(script, keys, ...args);
  }

  async increment(subject: QuotaSubject, windowMs: number): Promise<QuotaSnapshot> {
    const reply = (await this.evalScript(
      INCREMENT_SCRIPT,
      1,
      counterKey(subject),
      String(windowMs),
    )) as [string, string, string];
    const [totalHits, expiresAt, generation] = reply;
    return {
      totalHits: Number(totalHits),
      generation,
      resetTime: new Date(Number(expiresAt)),
    };
  }

  async compensate(
    subject: QuotaSubject,
    windowMs: number,
    generation: string,
    attemptId: string,
  ): Promise<void> {
    await this.evalScript(
      COMPENSATE_SCRIPT,
      2,
      counterKey(subject),
      refundsKey(subject),
      generation,
      attemptId,
      String(windowMs),
    );
  }
}

/**
 * The process-local counter used only when no shared store is configured, and
 * by the suites that substitute the external storage adapter. Production always
 * resolves Redis, so this store never carries a production budget. It keeps the
 * same window and compensation behavior as the shared store.
 */
export class MemoryQuotaBackend implements QuotaBackend {
  private readonly counters = new Map<
    string,
    { generation: string; count: number; expiresAt: number }
  >();
  private readonly compensated = new Map<string, Set<string>>();

  async increment(subject: QuotaSubject, windowMs: number): Promise<QuotaSnapshot> {
    const now = Date.now();
    const generation = String(Math.floor(now / windowMs));
    const expiresAt = (Math.floor(now / windowMs) + 1) * windowMs;
    const key = counterKey(subject);
    const current = this.counters.get(key);
    const totalHits = current && current.generation === generation ? current.count + 1 : 1;
    this.counters.set(key, { generation, count: totalHits, expiresAt });
    if (current && current.generation !== generation) {
      // The previous window is gone, so its recorded compensations are moot.
      this.compensated.delete(key);
    }
    return { totalHits, generation, resetTime: new Date(expiresAt) };
  }

  async compensate(
    subject: QuotaSubject,
    _windowMs: number,
    generation: string,
    attemptId: string,
  ): Promise<void> {
    const key = counterKey(subject);
    const current = this.counters.get(key);
    if (!current || current.generation !== generation) return;
    const done = this.compensated.get(key) ?? new Set<string>();
    if (done.has(attemptId)) return;
    if (current.count <= 0) return;
    current.count -= 1;
    done.add(attemptId);
    this.compensated.set(key, done);
  }

  /** Drops every counter. Test-only: production counters live in Redis. */
  reset(): void {
    this.counters.clear();
    this.compensated.clear();
  }
}

const memoryBackend = new MemoryQuotaBackend();
const backends = new Map<string, QuotaBackend>();
/** Forces the process-local counter for the whole process (test suites that
 * substitute the external storage adapter). */
let forceMemoryBackend = false;

function quotaBackend(): QuotaBackend {
  if (forceMemoryBackend) return memoryBackend;
  const env = loadEnv();
  const redisUrl = env.RATE_LIMIT_REDIS_URL;
  if (!redisUrl) return memoryBackend;
  const cached = backends.get(redisUrl);
  if (cached) return cached;
  const created = new RedisQuotaBackend(redisUrl);
  backends.set(redisUrl, created);
  return created;
}

export interface QuotaPolicy {
  readonly bearerFailure: { readonly limit: number; readonly windowMs: number };
  readonly userTraffic: { readonly limit: number; readonly windowMs: number };
  readonly tokenTraffic: { readonly limit: number; readonly windowMs: number };
  readonly tokenIssuance: { readonly limit: number; readonly windowMs: number };
  readonly tokenPassword: { readonly limit: number; readonly windowMs: number };
}

/** The bounded, env-driven policy. Defaults and bounds live in the schema. */
export function agentQuotaPolicy(): QuotaPolicy {
  const env = loadEnv();
  return {
    bearerFailure: {
      limit: env.RATE_LIMIT_BEARER_FAILURE_MAX,
      windowMs: env.RATE_LIMIT_ATTEMPT_WINDOW_MS,
    },
    userTraffic: { limit: env.RATE_LIMIT_USER_QUOTA_MAX, windowMs: env.RATE_LIMIT_QUOTA_WINDOW_MS },
    tokenTraffic: {
      limit: env.RATE_LIMIT_TOKEN_QUOTA_MAX,
      windowMs: env.RATE_LIMIT_QUOTA_WINDOW_MS,
    },
    tokenIssuance: {
      limit: env.RATE_LIMIT_TOKEN_ISSUANCE_MAX,
      windowMs: env.RATE_LIMIT_ATTEMPT_WINDOW_MS,
    },
    tokenPassword: {
      limit: env.RATE_LIMIT_TOKEN_PASSWORD_MAX,
      windowMs: env.RATE_LIMIT_ATTEMPT_WINDOW_MS,
    },
  };
}

async function chargeQuota(
  kind: QuotaKind,
  storeKey: string,
  limit: number,
  windowMs: number,
): Promise<QuotaCharge> {
  const subject: QuotaSubject = { kind, key: storeKey };
  const backend = quotaBackend();
  let snapshot: QuotaSnapshot;
  try {
    snapshot = await backend.increment(subject, windowMs);
  } catch {
    // Fail closed. The driver cause stays out of the error, the log and the
    // response so a store URL or credential can never leak.
    throw new QuotaStoreError();
  }
  // A unique, non-secret id per attempt. It only marks the attempt inside the
  // compensation set of its own window.
  const attemptId = randomUUID();
  return {
    kind,
    allowed: snapshot.totalHits <= limit,
    limit,
    remaining: Math.max(0, limit - snapshot.totalHits),
    resetTime: snapshot.resetTime,
    windowMs,
    refund: async () => {
      try {
        await backend.compensate(subject, windowMs, snapshot.generation, attemptId);
      } catch {
        // The guarded operation already succeeded, so the request keeps its
        // result. The counter stays elevated, which is the stricter direction,
        // and the next charge reports the unavailable store to the caller.
      }
    },
  };
}

/**
 * Charges the pre-verification bearer budget of one client address. The charge
 * happens before the credential lookup, and a verified secret refunds it.
 */
export async function chargeBearerFailure(req: Request): Promise<QuotaCharge> {
  const policy = agentQuotaPolicy();
  return chargeQuota(
    'bearer-failure',
    `ip:${clientIpKey(req)}`,
    policy.bearerFailure.limit,
    policy.bearerFailure.windowMs,
  );
}

/**
 * Charges the token issuance budget of one verified owner.
 */
export async function chargeTokenIssuance(ownerId: string): Promise<QuotaCharge> {
  const policy = agentQuotaPolicy();
  return chargeQuota(
    'token-issuance',
    `user:${ownerId}`,
    policy.tokenIssuance.limit,
    policy.tokenIssuance.windowMs,
  );
}

/**
 * Charges the issuance password budget of one verified owner. The charge
 * happens before the password comparison and is not given back, so the budget
 * bounds the expensive comparisons themselves.
 */
export async function chargeTokenPassword(ownerId: string): Promise<QuotaCharge> {
  const policy = agentQuotaPolicy();
  return chargeQuota(
    'token-password',
    `user:${ownerId}`,
    policy.tokenPassword.limit,
    policy.tokenPassword.windowMs,
  );
}

/**
 * Charges the sustained traffic budget of a verified caller: the user budget
 * for every authenticated request and, for a personal token, the token budget
 * as well. Returns the rejecting charge, or undefined when the caller is
 * inside every budget.
 */
export async function chargeAuthenticatedTraffic(
  auth: AuthContext,
): Promise<QuotaCharge | undefined> {
  const policy = agentQuotaPolicy();
  const user = await chargeQuota(
    'user-traffic',
    `user:${auth.actor.id}`,
    policy.userTraffic.limit,
    policy.userTraffic.windowMs,
  );
  if (!user.allowed) return user;
  if (auth.method === 'pat') {
    const token = await chargeQuota(
      'token-traffic',
      `token:${auth.tokenId}`,
      policy.tokenTraffic.limit,
      policy.tokenTraffic.windowMs,
    );
    if (!token.allowed) return token;
  }
  return undefined;
}

/** The seconds the rejecting window still has left, computed at response time. */
export function remainingWindowSeconds(charge: QuotaCharge): number {
  const remaining = Math.ceil((charge.resetTime.getTime() - Date.now()) / 1000);
  return Math.max(1, remaining);
}

/**
 * The shared rejection response: the standard envelope, the retry delay of the
 * exact rejecting window and a safe correlation id.
 */
export function sendRateLimited(
  req: Request,
  res: Response,
  charge: QuotaCharge,
  message: string,
): void {
  safeRequestId(req, res);
  const remaining = remainingWindowSeconds(charge);
  res.setHeader('Retry-After', String(remaining));
  res.setHeader('RateLimit-Policy', `${charge.limit};w=${Math.ceil(charge.windowMs / 1000)}`);
  // The draft-7 reset is the remaining delay of the rejecting window, not an
  // absolute timestamp.
  res.setHeader(
    'RateLimit',
    `limit=${charge.limit}, remaining=${charge.remaining}, reset=${remaining}`,
  );
  res.status(429).json({ error: { code: 'RATE_LIMITED', message } });
}

/**
 * Test-only helpers. Production counters live in the shared Redis store; these
 * only drop the cached backends and the process-local counters.
 */
export function __resetAgentQuotaForTests(): void {
  forceMemoryBackend = false;
  backends.clear();
  memoryBackend.reset();
}

/** Test-only: substitutes the external storage adapter with the local counter. */
export function __useMemoryQuotaStoreForTests(): void {
  forceMemoryBackend = true;
}
