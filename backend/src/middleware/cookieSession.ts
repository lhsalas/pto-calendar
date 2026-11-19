import cookieSession from 'cookie-session';
import type { RequestHandler } from 'express';
import { loadEnv } from '../config/env.js';

export interface SessionUser {
  id: string;
  role: 'member' | 'team_lead' | 'admin';
  sessionVersion: number;
  /**
   * A random per-login nonce that scopes a keyed create to this session.
   *
   * It is server state inside the signed cookie, never a credential and never
   * part of an API response. A session created before this field existed has
   * no nonce: it may still create without a key, but a keyed request is
   * refused until the user signs in again.
   */
  replayNonce?: string;
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
    sameSite: env.COOKIE_SAME_SITE,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  });
}
