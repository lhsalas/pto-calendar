import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { safeReqSerializer, safeResSerializer, safeRequestId } from './logSanitizers.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeReqRes(headers: Record<string, string | string[] | undefined> = {}): {
  req: IncomingMessage;
  res: ServerResponse;
  headerStore: Record<string, string | string[]>;
} {
  const headerStore: Record<string, string | string[]> = {};
  const req = {
    headers: { ...headers },
  } as unknown as IncomingMessage;
  const res = {
    setHeader(name: string, value: string | string[]) {
      headerStore[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return headerStore[name.toLowerCase()];
    },
  } as unknown as ServerResponse;
  return { req, res, headerStore };
}

describe('safeRequestId', () => {
  it('passes through a valid inbound X-Request-Id header', () => {
    const { req, res, headerStore } = makeReqRes({ 'x-request-id': 'trace-123_abc' });
    const id = safeRequestId(req, res);
    expect(id).toBe('trace-123_abc');
    expect(headerStore['x-request-id']).toBe('trace-123_abc');
  });

  it('replaces a missing X-Request-Id with a fresh UUID', () => {
    const { req, res, headerStore } = makeReqRes();
    const id = safeRequestId(req, res);
    expect(id).toMatch(UUID_REGEX);
    expect(headerStore['x-request-id']).toBe(id);
  });

  it('replaces a header containing newlines (log-injection guard) with a fresh UUID', () => {
    const malicious = 'abc\nINJECTED LOG LINE: {"msg":"pwn"}';
    const { req, res, headerStore } = makeReqRes({ 'x-request-id': malicious });
    const id = safeRequestId(req, res);
    expect(id).toMatch(UUID_REGEX);
    expect(id).not.toBe(malicious);
    expect(id).not.toContain('\n');
    expect(headerStore['x-request-id']).toBe(id);
  });

  it('replaces a header with special characters outside [A-Za-z0-9._-] with a fresh UUID', () => {
    const malicious = 'a b c d e f';
    const { req, res } = makeReqRes({ 'x-request-id': malicious });
    const id = safeRequestId(req, res);
    expect(id).toMatch(UUID_REGEX);
    expect(id).not.toBe(malicious);
  });
});

describe('safeReqSerializer', () => {
  it('strips headers and any other non-allowlisted fields', () => {
    const out = safeReqSerializer({
      id: 'req-1',
      method: 'POST',
      url: '/auth/login',
      headers: { cookie: 'session=secret' },
      remoteAddress: '127.0.0.1',
      body: { email: 'x@y.z', password: 'shhh' },
    });
    expect(out).toEqual({ id: 'req-1', method: 'POST', url: '/auth/login' });
    expect(Object.prototype.hasOwnProperty.call(out, 'headers')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out, 'body')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out, 'remoteAddress')).toBe(false);
  });
});

describe('safeResSerializer', () => {
  it('strips headers and any other non-allowlisted fields', () => {
    const out = safeResSerializer({
      statusCode: 201,
      headers: { 'set-cookie': 'session=secret' },
    });
    expect(out).toEqual({ statusCode: 201 });
    expect(Object.prototype.hasOwnProperty.call(out, 'headers')).toBe(false);
  });
});
