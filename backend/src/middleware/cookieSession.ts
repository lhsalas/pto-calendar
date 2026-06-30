import cookieSession from 'cookie-session';
import type { RequestHandler } from 'express';
import { loadEnv } from '../config/env.js';

export interface SessionUser {
  id: string;
  role: 'member' | 'team_lead';
}

export function cookieSessionMiddleware(): RequestHandler {
  const env = loadEnv();
  const keys = env.SESSION_SECRET;
  return cookieSession({
    name: 'session',
    keys,
    maxAge: env.COOKIE_MAX_AGE_MS,
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  });
}
