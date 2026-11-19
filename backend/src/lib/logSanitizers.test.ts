import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger as PinoLogger } from 'pino';
import { safeErrorSerializer } from './logRedaction.js';
import {
  createPinoHttpOptions,
  safeReqSerializer,
  safeResSerializer,
  safeRequestId,
} from './logSanitizers.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A canonical create key: it fits the correlation grammar and must still be refused. */
const CREATE_KEY = 'v1.1700000000000.9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

function makeReqRes(headers: Record<string, string | string[] | undefined> = {}): {
  req: IncomingMessage;
  res: ServerResponse;
  headerStore: Record<string, string | string[]>;
} {
  const headerStore: Record<string, string | string[]> = {};
  const rawHeaders: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const single of Array.isArray(value) ? value : [value]) {
      rawHeaders.push(name, single);
    }
  }
  const req = {
    headers: { ...headers },
    rawHeaders,
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
  it('reuses only a safe previously generated ID throughout credential middleware', () => {
    const { req, res, headerStore } = makeReqRes();
    const id = safeRequestId(req, res);
    expect(safeRequestId(req, res)).toBe(id);
    for (const invalid of [
      ['array-value'],
      'unsafe value',
      'pto_pat_pasted-secret',
      'prefix-PTO_PAT_pasted-secret',
    ]) {
      headerStore['x-request-id'] = invalid;
      expect(safeRequestId(req, res)).toMatch(UUID_REGEX);
    }
  });
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

  it('does not reflect a pasted personal token as a correlation ID or log identifier', () => {
    const token = `pto_pat_00000000-0000-4000-8000-000000000000.${'a'.repeat(64)}`;
    const { req, res, headerStore } = makeReqRes({ 'x-request-id': token });
    expect(safeRequestId(req, res)).toMatch(UUID_REGEX);
    expect(headerStore['x-request-id']).not.toBe(token);
    const prefixed = makeReqRes({ 'x-request-id': `prefix-${token}` });
    expect(safeRequestId(prefixed.req, prefixed.res)).toMatch(UUID_REGEX);
    expect(prefixed.headerStore['x-request-id']).not.toContain(token);
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

  it('never uses a canonical create key as the correlation ID', () => {
    const { req, res, headerStore } = makeReqRes({ 'x-request-id': CREATE_KEY });
    const id = safeRequestId(req, res);
    expect(id).toMatch(UUID_REGEX);
    expect(id).not.toBe(CREATE_KEY);
    expect(headerStore['x-request-id']).toBe(id);
    expect(headerStore['x-request-id']).not.toContain(CREATE_KEY);
  });

  it('refuses a correlation ID that embeds a canonical create key', () => {
    for (const value of [`prefix-${CREATE_KEY}`, `${CREATE_KEY}-suffix`, `trace.${CREATE_KEY}`]) {
      const { req, res, headerStore } = makeReqRes({ 'x-request-id': value });
      expect(safeRequestId(req, res)).toMatch(UUID_REGEX);
      expect(headerStore['x-request-id']).not.toContain(CREATE_KEY);
    }
  });

  it('refuses a correlation ID that repeats the submitted create key', () => {
    const { req, res, headerStore } = makeReqRes({
      'x-request-id': CREATE_KEY,
      'idempotency-key': CREATE_KEY,
    });
    expect(safeRequestId(req, res)).toMatch(UUID_REGEX);
    expect(headerStore['x-request-id']).not.toBe(CREATE_KEY);
  });

  it('refuses a correlation ID that repeats a malformed submitted create key', () => {
    const malformed = 'v1.1700000000000.not-a-uuid';
    const { req, res, headerStore } = makeReqRes({
      'x-request-id': malformed,
      'idempotency-key': malformed,
    });
    expect(safeRequestId(req, res)).toMatch(UUID_REGEX);
    expect(headerStore['x-request-id']).not.toBe(malformed);
  });

  it('keeps an ordinary correlation ID when a create key was submitted', () => {
    const { req, res } = makeReqRes({
      'x-request-id': 'trace-123_abc',
      'idempotency-key': CREATE_KEY,
    });
    expect(safeRequestId(req, res)).toBe('trace-123_abc');
  });

  it('replaces a carried correlation ID that is a canonical create key', () => {
    // The early credential boundary may have set the header before pino ran.
    const { req, res, headerStore } = makeReqRes();
    headerStore['x-request-id'] = CREATE_KEY;
    const id = safeRequestId(req, res);
    expect(id).toMatch(UUID_REGEX);
    expect(headerStore['x-request-id']).toBe(id);
  });

  it('copes with a request that carries no raw header list', () => {
    const { req, res } = makeReqRes({ 'x-request-id': 'trace-123_abc' });
    const withoutRaw = { headers: req.headers } as unknown as IncomingMessage;
    expect(safeRequestId(withoutRaw, res)).toBe('trace-123_abc');
  });
});

describe('safeReqSerializer', () => {
  it('redacts all credential-management dynamic paths and query strings, including absolute-form URLs', () => {
    for (const url of [
      '/auth/tokens',
      '/AUTH/TOKENS/secret-token?password=secret',
      '/auth/tokens?password=secret',
      '/auth/tokens#secret',
      'https://secret@example.test/auth/tokens/secret?secret=secret',
    ])
      expect(safeReqSerializer({ url }).url).toBe('/auth/tokens');
    expect(safeReqSerializer({ url: '/auth/tokens-extra' }).url).toBe('[unclassified]');
    for (const url of [12, null, undefined, {}, ['/pto']]) {
      expect(safeReqSerializer({ url }).url).toBe('[unclassified]');
    }
  });

  it('only emits fixed labels, irrespective of dynamic path contents or encoding', () => {
    const token = `pto_pat_00000000-0000-4000-8000-000000000000.${'a'.repeat(64)}`;
    for (const [url, expected] of [
      [`/pto?token=${token}#secret`, '/pto'],
      [`https://user:secret@example.test/pto?token=${token}`, '/pto'],
      [`/pto/prefix-${token}`, '[unclassified]'],
      [`/pto/%70%74%6f%5f%70%61%74%5f${token}`, '[unclassified]'],
      [`/pto/%2570${token.slice(1)}`, '[unclassified]'],
      [`/pto/%252570${token.slice(1)}`, '[unclassified]'],
      [`/pto/%70%74%6F%5fpat_${token.slice(8)}`, '[unclassified]'],
      ['/pto/%broken', '[unclassified]'],
      ['https://user:secret@example.test?token=secret', '[unclassified]'],
    ]) {
      expect(safeReqSerializer({ url }).url).toBe(expected);
    }
    for (const segment of ['123', '00000000-0000-4000-8000-000000000000', 'private', '%', token]) {
      expect(safeReqSerializer({ url: `/pto/${segment}` }).url).toBe('[unclassified]');
      expect(safeReqSerializer({ url: `/unknown/${segment}` }).url).toBe('[unclassified]');
    }
  });

  it('recognizes only known static endpoint labels', () => {
    for (const path of [
      '/health',
      '/ready',
      '/auth/login',
      '/auth/setup-account',
      '/auth/logout',
      '/auth/me',
      '/pto',
      '/users',
      '/holidays',
      '/holidays/all',
      '/holidays/seed',
    ]) {
      expect(safeReqSerializer({ url: `${path}?private=secret#fragment` }).url).toBe(path);
    }
  });

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

describe('createPinoHttpOptions', () => {
  it('wires the safe serializers, the correlation guard and the health exclusions', () => {
    const target = { info: () => undefined } as unknown as PinoLogger;
    const options = createPinoHttpOptions(target);
    expect(options.logger).toBe(target);
    expect(options.genReqId).toBe(safeRequestId);
    expect(options.serializers?.['req']).toBe(safeReqSerializer);
    expect(options.serializers?.['res']).toBe(safeResSerializer);
    expect(options.serializers?.['err']).toBe(safeErrorSerializer);
    const ignore = (options.autoLogging as { ignore: (req: { url: string }) => boolean }).ignore;
    expect(ignore({ url: '/health' })).toBe(true);
    expect(ignore({ url: '/ready' })).toBe(true);
    expect(ignore({ url: '/pto' })).toBe(false);
  });
});
