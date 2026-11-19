import { describe, expect, it } from 'vitest';
import {
  PTO_LOCAL_ERROR_CODES,
  PTO_SERVICE_ERROR_CODES,
  PtoApiError,
  classifyUpstreamCode,
  isPtoApiError,
} from '../src/errors.js';

describe('the API error surface', () => {
  it('reports a fixed message and the classified facts', () => {
    const error = new PtoApiError('NOT_FOUND', {
      status: 404,
      requestId: 'req-1',
      retryAfterMs: 1500,
      unknownWriteOutcome: true,
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('PtoApiError');
    expect(error.code).toBe('NOT_FOUND');
    expect(error.status).toBe(404);
    expect(error.requestId).toBe('req-1');
    expect(error.retryAfterMs).toBe(1500);
    expect(error.unknownWriteOutcome).toBe(true);
    expect(error.message).toBe('The requested entry does not exist.');
  });

  it('defaults to no status, no correlation and a known outcome', () => {
    const error = new PtoApiError('NETWORK_ERROR');
    expect(error.status).toBe(0);
    expect(error.requestId).toBeNull();
    expect(error.retryAfterMs).toBeNull();
    expect(error.unknownWriteOutcome).toBe(false);
    expect(error.message).toBe('The service could not be reached.');
  });

  it('gives every known code a fixed message of its own', () => {
    const messages = new Set<string>();
    for (const code of [...PTO_SERVICE_ERROR_CODES, ...PTO_LOCAL_ERROR_CODES]) {
      const error = new PtoApiError(code);
      expect(error.code).toBe(code);
      expect(error.message.length).toBeGreaterThan(0);
      messages.add(error.message);
    }
    // No two codes share a message, so a caller can tell them apart.
    expect(messages.size).toBe(PTO_SERVICE_ERROR_CODES.length + PTO_LOCAL_ERROR_CODES.length);
  });

  it('never copies an upstream message, a body or a cause', () => {
    const error = new PtoApiError('HTTP_ERROR');
    expect(error.message).not.toContain('upstream');
    expect(error.message).not.toMatch(/https?:/);
    expect(Object.keys(error).sort()).toEqual([
      'code',
      'name',
      'requestId',
      'retryAfterMs',
      'status',
      'unknownWriteOutcome',
    ]);
    expect((error as unknown as { cause?: unknown }).cause).toBeUndefined();
  });

  it('gives an unknown code the fixed fallback message', () => {
    const error = new PtoApiError('SOMETHING_NEW');
    expect(error.code).toBe('SOMETHING_NEW');
    expect(error.message).toBe('The service rejected the request.');
  });

  it('falls back to the fixed error for an unknown upstream code', () => {
    expect(classifyUpstreamCode('NOT_FOUND')).toBe('NOT_FOUND');
    expect(classifyUpstreamCode('STALE_WRITE')).toBe('STALE_WRITE');
    expect(classifyUpstreamCode('SOMETHING_NEW')).toBe('HTTP_ERROR');
    expect(classifyUpstreamCode(undefined)).toBe('HTTP_ERROR');
    expect(classifyUpstreamCode(42)).toBe('HTTP_ERROR');
    expect(classifyUpstreamCode({ code: 'NOT_FOUND' })).toBe('HTTP_ERROR');
  });

  it('recognizes its own errors', () => {
    expect(isPtoApiError(new PtoApiError('ABORTED'))).toBe(true);
    expect(isPtoApiError(new Error('plain'))).toBe(false);
    expect(isPtoApiError(null)).toBe(false);
  });
});
