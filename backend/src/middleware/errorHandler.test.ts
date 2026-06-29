import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { HttpError, errorHandler } from './errorHandler.js';
import { logger } from '../lib/logger.js';

interface MockResponse {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
}

function makeReq(id?: string): Request {
  return { id } as unknown as Request;
}

function makeRes(): Response & MockResponse {
  const json = vi.fn().mockReturnThis();
  const status = vi.fn().mockReturnValue({ json });
  return { status, json } as unknown as Response & MockResponse;
}

describe('errorHandler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns HttpError status + code + message + details when details present', () => {
    const err = new HttpError(404, 'NOT_FOUND', 'PTO entry not found.', { id: 'x' });
    const req = makeReq('req-id-1');
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    errorHandler(err, req, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'NOT_FOUND', message: 'PTO entry not found.', details: { id: 'x' } },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns HttpError status + code + message without a details key when details omitted', () => {
    const err = new HttpError(403, 'FORBIDDEN', 'You may not modify this.');
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    errorHandler(err, req, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'FORBIDDEN', message: 'You may not modify this.' },
    });
    const jsonArg = res.json.mock.calls[0]![0] as { error: Record<string, unknown> };
    expect(jsonArg.error).not.toHaveProperty('details');
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_ERROR with details from a ZodError', () => {
    const schema = z.object({ name: z.string() });
    const result = schema.safeParse({ name: 42 });
    expect(result.success).toBe(false);
    if (result.success) return;

    const req = makeReq();
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    errorHandler(result.error, req, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request payload.',
        details: result.error.issues,
      },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 500 INTERNAL_ERROR for a generic Error and logs it with reqId', () => {
    const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const req = makeReq('abc-123');
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    errorHandler(new Error('boom'), req, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' },
    });
    expect(errSpy).toHaveBeenCalledTimes(1);
    const logArg = errSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(logArg['reqId']).toBe('abc-123');
    expect(logArg['err']).toBeDefined();
    expect(next).not.toHaveBeenCalled();
  });

  it('logs reqId: undefined when req.id is missing', () => {
    const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const req = makeReq(undefined);
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    errorHandler(new Error('boom'), req, res as Response, next);

    const logArg = errSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(logArg['reqId']).toBeUndefined();
  });
});
