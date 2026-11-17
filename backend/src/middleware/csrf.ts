import type { RequestHandler } from 'express';
import { loadEnv } from '../config/env.js';
import { HttpError } from './errorHandler.js';
import type {} from '../services/auth/authContext.js';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function originFromReferer(referer: string | undefined): string | undefined {
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

/**
 * Cookie sessions need an origin check when production uses SameSite=None for
 * a frontend and API served from separate origins.
 */
export function csrfOriginMiddleware(): RequestHandler {
  const env = loadEnv();

  return (req, _res, next) => {
    if (!STATE_CHANGING_METHODS.has(req.method)) {
      next();
      return;
    }

    const requestOrigin = req.get('origin') ?? originFromReferer(req.get('referer'));
    if (requestOrigin && requestOrigin !== env.CORS_ORIGIN) {
      next(new HttpError(403, 'CSRF_REJECTED', 'Request origin is not allowed.'));
      return;
    }
    const verifiedCookieFreePat =
      req.auth?.method === 'pat' && req.headers.cookie === undefined && !req.session?.user;
    if (
      env.NODE_ENV === 'production' &&
      !requestOrigin &&
      !verifiedCookieFreePat &&
      (req.session?.user || req.headers.authorization !== undefined)
    ) {
      next(new HttpError(403, 'CSRF_REJECTED', 'Request origin is not allowed.'));
      return;
    }

    next();
  };
}
