import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from '../lib/logger.js';
import { safeRequestId } from '../lib/logSanitizers.js';
import { TokenInputError } from '../services/tokens/tokenDomain.js';
import { TokenLimitError } from '../services/tokens/tokenService.js';
import { HttpError } from './errorHandler.js';
import { requireAuth } from './requireAuth.js';

/** Mounted before CORS, parsers, CSRF and limiters, including their failures. */
export const tokenManagementBoundary: RequestHandler = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  req.id = safeRequestId(req, res);
  next();
};

export const requireTokenSession: RequestHandler = (req, res, next) => {
  // Run after the normal global limiter/CSRF path, not around its protection.
  if (req.headers.authorization !== undefined) {
    next(
      new HttpError(
        401,
        'SESSION_REQUIRED',
        'A browser session without bearer credentials is required.',
      ),
    );
    return;
  }
  // Keep this explicit even when shared authentication later supports PATs.
  if (!req.session?.user) {
    next(new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required.'));
    return;
  }
  return requireAuth(req, res, next);
};

export const tokenManagementErrorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err instanceof TokenLimitError) {
    res.status(409).json({
      error: { code: 'TOKEN_LIMIT_REACHED', message: 'The active token limit has been reached.' },
    });
    return;
  }
  if (err instanceof ZodError || err instanceof TokenInputError) {
    // Never serialize issue inputs, unknown keys, passwords or driver causes.
    res
      .status(400)
      .json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request payload.' } });
    return;
  }
  if (err && typeof err === 'object' && 'type' in err) {
    const type: unknown = err.type;
    if (
      type === 'entity.parse.failed' ||
      type === 'request.size.invalid' ||
      type === 'request.aborted'
    ) {
      res
        .status(400)
        .json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request payload.' } });
      return;
    }
    if (type === 'entity.too.large') {
      res
        .status(413)
        .json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request payload is too large.' } });
      return;
    }
    if (type === 'charset.unsupported' || type === 'encoding.unsupported') {
      res.status(415).json({
        error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported request encoding.' },
      });
      return;
    }
  }
  // Raw parser errors can contain req.body; logging the original error is unsafe.
  logger.error({ reqId: req.id }, 'Token management operation failed');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } });
};
