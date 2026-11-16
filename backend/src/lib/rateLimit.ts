import type { Request } from 'express';
import { isIP } from 'node:net';
import rateLimit, { ipKeyGenerator, type RateLimitExceededEventHandler } from 'express-rate-limit';
import { Redis } from 'ioredis';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { loadEnv } from '../config/env.js';

let redisClient: Redis | undefined;

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
  redisClient ??= new Redis(env.RATE_LIMIT_REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 1_000,
  });
  return new RedisStore({
    prefix,
    sendCommand: (command: string, ...args: string[]) =>
      redisClient!.call(command, ...args) as Promise<RedisReply>,
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
