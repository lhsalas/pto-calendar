import { EventEmitter, once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PtoApiError } from '../src/errors.js';
import { createTransport, parseRetryAfter, type TransportRequest } from '../src/transport.js';

const TOKEN = `pto_pat_11111111-1111-4111-8111-111111111111.${'a'.repeat(64)}`;
const UUID = '11111111-1111-4111-8111-111111111111';
const PTO_PATH = `/pto/${UUID}`;
const KEY = 'v1.1700000000000.11111111-1111-4111-8111-111111111111';

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body: string;
}

interface Fixture {
  origin: string;
  requests: Recorded[];
  hits: Map<string, number>;
}

let server: Server;
let redirectServer: Server;
let fixture: Fixture;
let redirectRequests: Recorded[] = [];
const events = new EventEmitter();

function read(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    request.on('end', () => resolve(body));
  });
}

function send(
  response: ServerResponse,
  status: number,
  body?: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, headers);
  response.end(body);
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  send(response, status, JSON.stringify(body), { 'content-type': 'application/json', ...headers });
}

beforeAll(async () => {
  redirectServer = createServer((request, response) => {
    void read(request).then((body) => {
      redirectRequests.push({
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        headers: { ...request.headers } as Record<string, string | undefined>,
        body,
      });
      json(response, 200, { reached: true });
    });
  });
  await new Promise<void>((resolve) => redirectServer.listen(0, '127.0.0.1', resolve));
  const redirectPort = (redirectServer.address() as { port: number }).port;

  server = createServer((request, response) => {
    void (async () => {
      const url = request.url ?? '/';
      const path = url.split('?')[0] ?? '/';
      const query = new URLSearchParams(url.split('?')[1] ?? '');
      const body = await read(request);
      fixture.requests.push({
        method: request.method ?? 'GET',
        url,
        headers: { ...request.headers } as Record<string, string | undefined>,
        body,
      });
      fixture.hits.set(path, (fixture.hits.get(path) ?? 0) + 1);
      if (path === '/auth/me') {
        json(response, 200, { id: 'owner' }, { 'x-request-id': 'req-1' });
        return;
      }
      const kind = query.get('case') ?? 'ok';
      switch (kind) {
        case 'ok':
          json(response, 200, { items: [] }, { 'x-request-id': 'req-1' });
          return;
        case 'created':
          json(
            response,
            201,
            { id: 'record' },
            {
              'x-request-id': 'req-2',
              'idempotency-replayed': 'false',
              'idempotency-key-expires-at': '2026-05-12T10:00:00.000Z',
            },
          );
          return;
        case 'replayed':
          json(
            response,
            201,
            { id: 'record' },
            {
              'x-request-id': 'req-3',
              'idempotency-replayed': 'true',
              'idempotency-key-expires-at': '2026-05-12T10:00:00.000Z',
            },
          );
          return;
        case 'conflict':
          json(response, 409, { error: { code: 'CONFLICT', message: 'overlaps' } });
          return;
        case 'unauthorized':
          json(response, 401, { error: { code: 'UNAUTHENTICATED' } });
          return;
        case 'forbidden':
          json(response, 403, { error: { code: 'FORBIDDEN' } });
          return;
        case 'stale':
          json(response, 412, { error: { code: 'STALE_WRITE' } });
          return;
        case 'precondition':
          json(response, 428, { error: { code: 'PRECONDITION_REQUIRED' } });
          return;
        case 'rate':
          json(response, 429, { error: { code: 'RATE_LIMITED' } }, { 'retry-after': '0' });
          return;
        case 'rate-late':
          json(response, 429, { error: { code: 'RATE_LIMITED' } }, { 'retry-after': '120' });
          return;
        case 'rate-huge':
          json(response, 429, { error: { code: 'RATE_LIMITED' } }, { 'retry-after': '1000000000' });
          return;
        case 'rate-unknown':
          json(response, 429, { error: { code: 'RATE_LIMITED' } }, { 'retry-after': 'later' });
          return;
        case 'gateway-timeout':
          json(response, 408, { error: { code: 'UPSTREAM' } });
          return;
        case 'rate-wait':
          json(response, 429, { error: { code: 'RATE_LIMITED' } }, { 'retry-after': '2' });
          return;
        case 'unavailable':
          json(response, 503, { error: { code: 'NOT_READY' } });
          return;
        case 'flaky':
          if ((fixture.hits.get(path) ?? 0) === 1) {
            json(response, 503, { error: { code: 'NOT_READY' } });
            return;
          }
          json(response, 200, { items: [] });
          return;
        case 'broken-error':
          send(response, 500, 'not json at all', { 'content-type': 'text/plain' });
          return;
        case 'empty':
          response.writeHead(204);
          response.end();
          return;
        case 'garbage':
          send(response, 200, 'not json at all', { 'content-type': 'text/plain' });
          return;
        case 'big':
          send(response, 200, 'x'.repeat(1_048_577), { 'content-type': 'text/plain' });
          return;
        case 'truncated':
          // The headers arrive, then the body is cut off in the middle.
          response.writeHead(200, { 'content-type': 'application/json' });
          response.write('{"items":[');
          response.flushHeaders();
          setTimeout(() => request.socket.destroy(), 20);
          return;
        case 'redirect':
          send(response, 302, undefined, { location: `http://127.0.0.1:${redirectPort}/target` });
          return;
        case 'unsafe-id':
          json(response, 200, { id: 'owner' }, { 'x-request-id': 'not a safe id' });
          return;
        case 'token-id':
          json(response, 200, { id: 'owner' }, { 'x-request-id': TOKEN });
          return;
        case 'token-secret-id':
          json(
            response,
            429,
            { error: { code: TOKEN, message: KEY } },
            {
              'x-request-id': `req-${TOKEN.slice(-64)}`,
            },
          );
          return;
        case 'key-id':
          json(response, 200, { id: 'owner' }, { 'x-request-id': `x-${KEY}-y` });
          return;
        case 'bad-expiry':
          json(response, 201, { id: 'record' }, { 'idempotency-key-expires-at': 'tomorrow' });
          return;
        case 'empty-body':
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end();
          return;
        case 'empty-error':
          response.writeHead(409);
          response.end();
          return;
        case 'bad-error':
          json(response, 400, { error: 'not an object' });
          return;
        case 'slow-body':
          response.once('close', () => events.emit('closed-slow-body'));
          response.writeHead(200, {
            'content-type': 'application/json',
            'x-request-id': 'stream-id',
          });
          response.write('{"items":[');
          response.flushHeaders();
          return;
        case 'slow':
          return;
        case 'close':
          request.socket.destroy();
          return;
        default:
          json(response, 404, { error: { code: 'NOT_FOUND' } });
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  fixture = { origin: `http://127.0.0.1:${port}`, requests: [], hits: new Map() };
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => redirectServer.close(() => resolve()));
});

beforeEach(() => {
  // Every test starts with its own counters and its own requests.
  fixture.requests = [];
  fixture.hits = new Map();
  redirectRequests = [];
});

function transport(overrides: Partial<Parameters<typeof createTransport>[0]> = {}) {
  return createTransport({
    baseUrl: fixture.origin,
    credential: { origin: fixture.origin, token: TOKEN },
    allowLoopbackHttp: true,
    ...overrides,
  });
}

function pto(kind: string, overrides: Partial<TransportRequest> = {}): TransportRequest {
  return {
    method: 'GET',
    path: PTO_PATH,
    query: new URLSearchParams({ case: kind }),
    ...overrides,
  } as TransportRequest;
}

describe('the transport', () => {
  it('sends the credential to the trusted origin and reports the answer', async () => {
    const result = await transport()({ method: 'GET', path: '/auth/me' });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ id: 'owner' });
    expect(result.requestId).toBe('req-1');
    const sent = fixture.requests.at(-1)!;
    expect(sent.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(sent.headers['accept']).toBe('application/json');
    expect(sent.headers['cookie']).toBeUndefined();
    expect(sent.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps the replay marker and the canonical expiry of a keyed answer', async () => {
    const created = await transport()(pto('created', { method: 'POST', body: { name: 'Laptop' } }));
    expect(created.replayed).toBe('false');
    expect(created.expiresAt).toBe('2026-05-12T10:00:00.000Z');
    const replayed = await transport()(
      pto('replayed', { method: 'POST', body: { name: 'Laptop' } }),
    );
    expect(replayed.replayed).toBe('true');
    expect(replayed.expiresAt).toBe('2026-05-12T10:00:00.000Z');
  });

  it('adds the query, the precondition and the idempotency key it was given', async () => {
    await transport()({
      method: 'POST',
      path: PTO_PATH,
      query: new URLSearchParams({ case: 'ok', format: 'page' }),
      body: { name: 'Laptop' },
      ifMatch: '"3"',
      idempotencyKey: KEY,
    });
    const sent = fixture.requests.at(-1)!;
    expect(sent.url).toBe(`/pto/${UUID}?case=ok&format=page`);
    expect(sent.headers['content-type']).toBe('application/json');
    expect(sent.headers['if-match']).toBe('"3"');
    expect(sent.headers['idempotency-key']).toBe(KEY);
    expect(sent.body).toBe('{"name":"Laptop"}');
  });

  it('reports an empty answer without a body', async () => {
    const result = await transport()(pto('empty', { method: 'DELETE' }));
    expect(result.status).toBe(204);
    expect(result.body).toBeNull();
  });

  it('refuses an answer it cannot use', async () => {
    await expect(transport()(pto('garbage'))).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      status: 200,
    });
    await expect(transport()(pto('big'))).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(transport()(pto('truncated'))).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      status: 200,
    });
  });

  it('refuses a body an empty answer must not carry', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      status: 204,
      headers: new Headers(),
      body: null,
      text: async () => 'unexpected',
    })) as unknown as typeof fetch;
    try {
      await expect(transport()(pto('empty', { method: 'DELETE' }))).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
        status: 204,
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it.each([
    ['conflict', 409, 'CONFLICT'],
    ['unauthorized', 401, 'UNAUTHENTICATED'],
    ['forbidden', 403, 'FORBIDDEN'],
    ['stale', 412, 'STALE_WRITE'],
    ['precondition', 428, 'PRECONDITION_REQUIRED'],
    ['rate', 429, 'RATE_LIMITED'],
  ])('reports the %s answer of the service', async (kind, status, code) => {
    const error = await transport()(pto(kind as string)).catch((err) => err);
    expect(error).toBeInstanceOf(PtoApiError);
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(error.unknownWriteOutcome).toBe(false);
    expect(String(error)).not.toContain('overlaps');
  });

  it('keeps the status and the correlation of an answer that is not JSON', async () => {
    const error = await transport()(pto('broken-error')).catch((err) => err);
    expect(error.code).toBe('HTTP_ERROR');
    expect(error.status).toBe(500);
    expect(error.unknownWriteOutcome).toBe(false);
  });

  it('refuses a redirect and never reaches its target', async () => {
    const error = await transport()(pto('redirect')).catch((err) => err);
    expect(error.code).toBe('REDIRECT');
    expect(error.status).toBe(302);
    expect(redirectRequests).toHaveLength(0);
  });

  it('reports a lost connection', async () => {
    const error = await transport()(pto('close')).catch((err) => err);
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.status).toBe(0);
    expect(error.unknownWriteOutcome).toBe(false);
  });

  it('reports a deadline and gives up on the request', async () => {
    const error = await transport({ timeoutMs: 120 })(pto('slow')).catch((err) => err);
    expect(error.code).toBe('TIMEOUT');
    expect(error.unknownWriteOutcome).toBe(false);
  });

  it('reports a cancellation of the caller', async () => {
    const controller = new AbortController();
    const pending = transport()(pto('slow', { signal: controller.signal }));
    controller.abort();
    const error = await pending.catch((err) => err);
    expect(error.code).toBe('ABORTED');
    expect(error.unknownWriteOutcome).toBe(false);
  });

  it('reports a request that was already cancelled without sending it', async () => {
    const controller = new AbortController();
    controller.abort();
    const before = fixture.requests.length;
    const error = await transport()({
      method: 'GET',
      path: '/auth/me',
      signal: controller.signal,
    }).catch((err) => err);
    expect(error.code).toBe('ABORTED');
    expect(fixture.requests.length).toBe(before);
  });

  it('retries a read once and reports the answer of the retry', async () => {
    const result = await transport({ readRetries: 1 })(pto('flaky'));
    expect(result.status).toBe(200);
    expect(fixture.hits.get(PTO_PATH)).toBe(2);
  });

  it('never retries a write', async () => {
    const error = await transport({ readRetries: 2 })(pto('unavailable', { method: 'POST' })).catch(
      (err) => err,
    );
    expect(error.code).toBe('NOT_READY');
    expect(error.status).toBe(503);
    expect(error.unknownWriteOutcome).toBe(true);
    expect(fixture.hits.get(PTO_PATH)).toBe(1);
  });

  it('treats a gateway timeout after a dispatched write as uncertain without retrying', async () => {
    await expect(
      transport({ readRetries: 2 })(pto('gateway-timeout', { method: 'PATCH' })),
    ).rejects.toMatchObject({ status: 408, unknownWriteOutcome: true });
    expect(fixture.hits.get(PTO_PATH)).toBe(1);
  });

  it('stops retrying when the budget cannot hold the wait', async () => {
    const error = await transport({ readRetries: 2, timeoutMs: 300 })(pto('rate-late')).catch(
      (err) => err,
    );
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(120_000);
    expect(fixture.hits.get(PTO_PATH)).toBe(1);
  });

  it.each(['rate-huge', 'rate-unknown'])('does not retry early on %s', async (kind) => {
    await expect(transport({ readRetries: 1 })(pto(kind))).rejects.toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
    });
    expect(fixture.hits.get(PTO_PATH)).toBe(1);
  });

  it('refuses a request it cannot send', async () => {
    const before = fixture.requests.length;
    for (const bad of [
      { method: 'PUT' },
      { path: '/pto/not-a-uuid' },
      { path: `/pto/${UUID}/extra` },
      { path: '/auth/me/extra' },
      { method: 'PATCH', ifMatch: '3' },
      { method: 'PATCH', ifMatch: '"0"' },
      { method: 'PATCH', ifMatch: '"2147483648"' },
      { method: 'POST', idempotencyKey: 'not-a-key' },
      { method: 'POST', body: { note: 'x'.repeat(70_000) } },
      { signal: {} },
    ]) {
      const error = await transport()(pto('ok', bad as Partial<TransportRequest>)).catch(
        (err) => err,
      );
      expect(error.code).toBe('INVALID_INPUT');
    }
    expect(fixture.requests.length).toBe(before);
  });

  it('refuses client options it cannot use', () => {
    for (const options of [
      {
        baseUrl: 'http://api.example.com',
        credential: { origin: 'http://api.example.com', token: TOKEN },
      },
      {
        baseUrl: 'https://api.example.com',
        credential: { origin: 'https://other.example.com', token: TOKEN },
      },
      {
        baseUrl: 'https://api.example.com',
        credential: { origin: 'https://api.example.com', token: 'nope' },
      },
      {
        baseUrl: 'https://api.example.com/path',
        credential: { origin: 'https://api.example.com', token: TOKEN },
      },
      {
        baseUrl: 'https://user@api.example.com',
        credential: { origin: 'https://api.example.com', token: TOKEN },
      },
      {
        baseUrl: 'https://api.example.com',
        credential: { origin: 'https://api.example.com', token: `${TOKEN}x` },
      },
    ]) {
      expect(() => createTransport(options as never)).toThrow(PtoApiError);
      try {
        createTransport(options as never);
      } catch (err) {
        expect((err as PtoApiError).code).toBe('INVALID_OPTIONS');
      }
    }
  });

  it('keeps only a safe correlation id and a canonical expiry', async () => {
    const unsafe = await transport()(pto('unsafe-id'));
    expect(unsafe.requestId).toBeNull();
    const withToken = await transport()(pto('token-id'));
    expect(withToken.requestId).toBeNull();
    const withKey = await transport()(pto('key-id'));
    expect(withKey.requestId).toBeNull();
    const badExpiry = await transport()(pto('bad-expiry'));
    expect(badExpiry.expiresAt).toBeNull();
  });

  it('does not copy even a token secret segment or an upstream message to an error', async () => {
    const error = await transport()(pto('token-secret-id')).catch((err) => err);
    expect(error).toMatchObject({ status: 429, requestId: null, code: 'HTTP_ERROR' });
    expect(JSON.stringify(error)).not.toContain(TOKEN.slice(-64));
    expect(String(error)).not.toContain(KEY);
  });

  it('reports an error envelope it cannot read', async () => {
    const error = await transport()(pto('bad-error')).catch((err) => err);
    expect(error.code).toBe('HTTP_ERROR');
    expect(error.status).toBe(400);
  });

  it('reports a body the deadline cuts off', async () => {
    const closed = once(events, 'closed-slow-body');
    await expect(
      transport({ timeoutMs: 250 })(pto('slow-body', { method: 'PATCH' })),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
      status: 200,
      requestId: 'stream-id',
      unknownWriteOutcome: true,
    });
    await closed;
  });

  it('recognizes caller abort after write response headers and closes its real stream', async () => {
    const controller = new AbortController();
    let announced!: () => void;
    const headers = new Promise<void>((resolve) => {
      announced = resolve;
    });
    const closed = once(events, 'closed-slow-body');
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
      const result = await realFetch(...args);
      announced();
      return result;
    });
    try {
      const pending = transport()(pto('slow-body', { method: 'PATCH', signal: controller.signal }));
      const result = expect(pending).rejects.toMatchObject({
        code: 'ABORTED',
        status: 200,
        requestId: 'stream-id',
        unknownWriteOutcome: true,
      });
      await headers;
      controller.abort();
      await result;
      await closed;
    } finally {
      controller.abort();
      spy.mockRestore();
    }
  });

  it('refuses an answer that is too large without a body', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      status: 200,
      headers: new Headers(),
      body: null,
      text: async () => 'x'.repeat(1_048_577),
    })) as unknown as typeof fetch;
    try {
      await expect(transport()(pto('ok'))).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
        status: 200,
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('reports a cancellation while it waits before a retry', async () => {
    const controller = new AbortController();
    const pending = transport({ timeoutMs: 60_000, readRetries: 1 })({
      ...pto('rate-wait'),
      signal: controller.signal,
    } as TransportRequest);
    setTimeout(() => controller.abort(), 50);
    const error = await pending.catch((err) => err);
    expect(error.code).toBe('ABORTED');
  });

  it('reports an answer with an empty body', async () => {
    const empty = await transport()(pto('empty-body'));
    expect(empty.status).toBe(200);
    expect(empty.body).toBeNull();
    const emptyError = await transport()(pto('empty-error')).catch((err) => err);
    expect(emptyError.code).toBe('HTTP_ERROR');
    expect(emptyError.status).toBe(409);
  });

  it('retries a read after a lost connection', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('the network is down');
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    try {
      const result = await transport({ timeoutMs: 60_000, readRetries: 1 })(pto('ok'));
      expect(result.status).toBe(200);
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('gives up on a retry when the deadline cuts the wait short', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new TypeError('the network is down');
    }) as unknown as typeof fetch;
    try {
      const error = await transport({ timeoutMs: 60, readRetries: 1 })(pto('ok')).catch(
        (err) => err,
      );
      expect(error.code).toBe('TIMEOUT');
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('does not retry an answer that is not retryable', async () => {
    const error = await transport({ readRetries: 2 })(pto('conflict')).catch((err) => err);
    expect(error.code).toBe('CONFLICT');
    expect(fixture.hits.get(PTO_PATH)).toBe(1);
  });

  it('refuses a request it cannot even read', async () => {
    const error = await transport()(null as never).catch((err) => err);
    expect(error.code).toBe('INVALID_INPUT');
    for (const body of ['text', null, [1, 2]]) {
      const rejected = await transport()(pto('ok', { method: 'POST', body: body as never })).catch(
        (err) => err,
      );
      expect(rejected.code).toBe('INVALID_INPUT');
    }
    const notAString = await transport()(pto('ok', { method: 'PATCH', ifMatch: 5 as never })).catch(
      (err) => err,
    );
    expect(notAString.code).toBe('INVALID_INPUT');
  });

  it('refuses options it cannot even read', () => {
    for (const options of [null, { baseUrl: 'https://api.example.com' }]) {
      expect(() => createTransport(options as never)).toThrow(PtoApiError);
      try {
        createTransport(options as never);
      } catch (err) {
        expect((err as PtoApiError).code).toBe('INVALID_OPTIONS');
      }
    }
  });

  it('reads a Retry-After of seconds and of a date', () => {
    const now = Date.parse('2026-05-11T10:00:00.000Z');
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter(' 5 ')).toBe(5000);
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter('1'.repeat(400))).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseRetryAfter('Mon, 11 May 2026 10:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Mon, 11 May 2026 09:59:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('later')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('-5')).toBeNull();
    expect(parseRetryAfter('+5')).toBeNull();
    expect(parseRetryAfter('1.5')).toBeNull();
    expect(parseRetryAfter('Mon, 11 May 2026 10:00:00')).toBeNull();
    expect(parseRetryAfter('Mon, 32 May 2026 10:00:00 GMT')).toBeNull();
    expect(parseRetryAfter('Tue, 11 May 2026 10:00:30 GMT', now)).toBeNull();
  });
});
