import rateLimit, { type RateLimitExceededEventHandler } from 'express-rate-limit';
import { loadEnv } from '../config/env.js';

function buildHandler(message: string): RateLimitExceededEventHandler {
  return (_req, res, _next, options) => {
    res.status(options.statusCode).json({
      error: { code: 'RATE_LIMITED', message },
    });
  };
}

export function createLoginLimiter(): ReturnType<typeof rateLimit> {
  const env = loadEnv();
  return rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: env.AUTH_RATE_LIMIT_MAX,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
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
    handler: buildHandler('Too many requests. Try again later.'),
  });
}
