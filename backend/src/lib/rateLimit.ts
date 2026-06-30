import type { Request } from 'express';
import rateLimit, { type RateLimitExceededEventHandler } from 'express-rate-limit';
import { loadEnv } from '../config/env.js';

function buildHandler(message: string): RateLimitExceededEventHandler {
  return (_req, res, _next, options) => {
    res.status(options.statusCode).json({
      error: { code: 'RATE_LIMITED', message },
    });
  };
}

function clientIpKey(req: Request): string {
  const env = loadEnv();
  if (env.TRUST_PROXY_HOPS === 0) {
    return req.socket.remoteAddress ?? req.ip ?? 'unknown';
  }
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

function isProbe(req: Request): boolean {
  return req.url === '/health' || req.url === '/ready';
}

export function createLoginLimiter(): ReturnType<typeof rateLimit> {
  const env = loadEnv();
  return rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: env.AUTH_RATE_LIMIT_MAX,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: clientIpKey,
    handler: buildHandler('Too many login attempts. Try again later.'),
  });
}

export function createGlobalLimiter(): ReturnType<typeof rateLimit> {
  const env = loadEnv();
  return rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: env.RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: clientIpKey,
    skip: isProbe,
    handler: buildHandler('Too many requests. Try again later.'),
  });
}
