import type { RequestHandler } from 'express';
import { loadEnv } from '../config/env.js';
import { HttpError } from './errorHandler.js';

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
 * a Firebase Hosting frontend and a separate Cloud Run API origin.
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
    if (env.NODE_ENV === 'production' && !requestOrigin && req.session?.user) {
      next(new HttpError(403, 'CSRF_REJECTED', 'Request origin is not allowed.'));
      return;
    }

    next();
  };
}
