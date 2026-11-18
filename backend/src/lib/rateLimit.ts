import type { Request } from 'express';
import { isIP } from 'node:net';
import rateLimit, { ipKeyGenerator, type RateLimitExceededEventHandler } from 'express-rate-limit';
import { Redis } from 'ioredis';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { loadEnv } from '../config/env.js';

/**
 * One lazily created connection per Redis URL. The limiters and the agent
 * quotas share these connections so a deployment opens a single socket per
 * configured store instead of one per counter namespace.
 */
const redisClients = new Map<string, Redis>();
/** Applications currently holding the shared connections. */
let resourceHolders = 0;
/** The bounded delay a limiter command waits for a usable connection. */
const REDIS_READY_TIMEOUT_MS = 1_000;

export function sharedRedisClient(redisUrl: string): Redis {
  const existing = redisClients.get(redisUrl);
  if (existing) return existing;
  const client = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 1_000,
  });
  redisClients.set(redisUrl, client);
  return client;
}

/**
 * Waits for the connection to become usable, with a bounded delay.
 *
 * The connection is lazy and the offline queue is disabled, so a command sent
 * before the socket is ready would fail with a raw driver error. The wait is
 * bounded and its failure is a fixed message, so a store outage never leaks a
 * connection address, a credential or a driver cause.
 */
export async function awaitRedisReady(client: Redis): Promise<void> {
  if (client.status === 'ready') return;
  if (client.status === 'end') throw new Error('Rate limit store is unavailable');
  if (client.status === 'wait') {
    // The client is lazy: the first command starts the connection.
    client.connect().catch(() => undefined);
  }
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      client.off('ready', onReady);
      client.off('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onReady = (): void => finish();
    const onError = (): void => finish(new Error('Rate limit store is unavailable'));
    const timer = setTimeout(
      () => finish(new Error('Rate limit store is unavailable')),
      REDIS_READY_TIMEOUT_MS,
    );
    timer.unref();
    client.once('ready', onReady);
    client.once('error', onError);
  });
}

/**
 * Registers one application that uses the shared limiter store. The matching
 * release closes the connections once the last application is gone, so a
 * restart never leaves a half-closed client behind and a still-running
 * application keeps its counters reachable.
 */
export function acquireRateLimitResources(): void {
  resourceHolders += 1;
}

export async function closeRateLimitResources(): Promise<void> {
  resourceHolders = Math.max(0, resourceHolders - 1);
  if (resourceHolders > 0) return;
  const clients = [...redisClients.values()];
  redisClients.clear();
  for (const client of clients) {
    try {
      if (typeof client.quit === 'function') await client.quit();
    } catch {
      // A connection that cannot be closed cleanly is already unusable.
    }
    // The hard close is unconditional: it stops a reconnect loop that would
    // otherwise outlive the application after a store outage.
    if (typeof client.disconnect === 'function') client.disconnect();
  }
}

function buildHandler(message: string): RateLimitExceededEventHandler {
  return (_req, res, _next, options) => {
    res.status(options.statusCode).json({
      error: { code: 'RATE_LIMITED', message },
    });
  };
}

export function clientIpKey(req: Request): string {
  const ip = req.ip;
  if (ip && isIP(ip)) return ipKeyGenerator(ip);
  const remote = req.socket.remoteAddress;
  return remote && isIP(remote) ? ipKeyGenerator(remote) : 'unknown';
}

function sharedStore(prefix: string): RedisStore | undefined {
  const env = loadEnv();
  if (!env.RATE_LIMIT_REDIS_URL) return undefined;
  return new RedisStore({
    prefix,
    // The connection is resolved per command so a closed connection is
    // replaced instead of being reused after a restart, and the command waits
    // for a usable socket instead of failing with a raw driver error.
    sendCommand: async (command: string, ...args: string[]) => {
      const client = sharedRedisClient(env.RATE_LIMIT_REDIS_URL!);
      await awaitRedisReady(client);
      return client.call(command, ...args) as Promise<RedisReply>;
    },
  });
}

function isProbe(req: Request): boolean {
  return req.url === '/health' || req.url === '/ready';
}

export function createLoginLimiter(): ReturnType<typeof rateLimit> {
  const env = loadEnv();
  const store = sharedStore('pto:rate-limit:auth:');
  return rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: env.AUTH_RATE_LIMIT_MAX,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: clientIpKey,
    ...(store ? { store, passOnStoreError: false } : {}),
    handler: buildHandler('Too many login attempts. Try again later.'),
  });
}

export function createGlobalLimiter(): ReturnType<typeof rateLimit> {
  const env = loadEnv();
  const store = sharedStore('pto:rate-limit:global:');
  return rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: env.RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: clientIpKey,
    ...(store ? { store, passOnStoreError: false } : {}),
    skip: isProbe,
    handler: buildHandler('Too many requests. Try again later.'),
  });
}
