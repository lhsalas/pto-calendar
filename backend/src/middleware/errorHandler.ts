import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from '../lib/logger.js';
import { safeRequestId } from '../lib/logSanitizers.js';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

// A body-parser error quotes the request body in its message, so it can carry a
// submitted password into the log. Those errors are never logged verbatim.
const BODY_ERROR_TYPES = new Set([
  'entity.parse.failed',
  'entity.too.large',
  'request.size.invalid',
  'request.aborted',
  'charset.unsupported',
  'encoding.unsupported',
]);

function isBodyError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('type' in err)) return false;
  const type = (err as { type?: unknown }).type;
  return typeof type === 'string' && BODY_ERROR_TYPES.has(type);
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request payload.',
        details: err.issues,
      },
    });
    return;
  }

  const reqId = typeof req.id === 'string' ? req.id : undefined;
  if (isBodyError(err)) {
    // Browser JSON parsing precedes pino-http, so its failure may have no ID yet.
    const bodyReqId = reqId ?? safeRequestId(req, res);
    req.id = bodyReqId;
    logger.error({ reqId: bodyReqId, errorType: 'request_body_error' }, 'Unhandled error');
  } else {
    logger.error({ err, reqId }, 'Unhandled error');
  }
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' },
  });
};
