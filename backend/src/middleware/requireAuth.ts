import 'express';
import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { loadEnv } from '../config/env.js';
import type { SessionUser } from './cookieSession.js';

declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser;
  }
}

type CachedUser = SessionUser | null;

interface CacheEntry {
  user: CachedUser;
  expiresAt: number;
}

const userCache: Map<string, CacheEntry> = new Map();
const NEGATIVE_TTL_RATIO = 4;

async function loadCachedUser(id: string): Promise<CachedUser> {
  const env = loadEnv();
  const ttl = env.AUTH_USER_CACHE_TTL_MS;
  const now = Date.now();
  const cached = userCache.get(id);
  if (cached && cached.expiresAt > now) {
    return cached.user;
  }
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });
  const value: CachedUser = user ? { id: user.id, role: user.role } : null;
  const effectiveTtl = value === null ? ttl * NEGATIVE_TTL_RATIO : ttl;
  userCache.set(id, { user: value, expiresAt: now + effectiveTtl });
  return value;
}

export function __resetAuthUserCacheForTests(): void {
  userCache.clear();
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const sessionUser = req.session?.user;
  if (!sessionUser) {
    res.status(401).json({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' },
    });
    return;
  }

  try {
    const live = await loadCachedUser(sessionUser.id);
    if (live === null) {
      req.session = null;
      res.status(401).json({
        error: { code: 'UNAUTHENTICATED', message: 'Session is no longer valid.' },
      });
      return;
    }
    if (req.session) {
      req.session.user = live;
    }
    req.user = live;
    next();
  } catch (err) {
    next(err);
  }
}
