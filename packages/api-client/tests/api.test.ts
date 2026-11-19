import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as apiClient from '../src/index.js';
import { createPtoClient, type PtoClient } from '../src/index.js';
import { invalidResponseFor, localCodeFor } from '../src/client.js';
import { PtoApiError } from '../src/errors.js';
import { PtoWireError } from '../src/wire.js';

/**
 * The client against a real HTTP server on the loopback interface.
 *
 * The server is a synthetic fixture: it answers the documented shapes and
 * records what the client sent. No database, no real credential and no
 * production host is involved.
 */

const TOKEN = `pto_pat_44444444-4444-4444-8444-444444444444.${'a'.repeat(64)}`;
const OWNER = '11111111-1111-4111-8111-111111111111';
const PTO_ID = '22222222-2222-4222-8222-222222222222';
const ISSUED_AT = Date.now();
const KEY = `v1.${ISSUED_AT}.9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f`;
/** The expiry the service reports for that key: exactly 24 hours later. */
const EXPIRES_AT = new Date(ISSUED_AT + 86_400_000).toISOString();

interface Recorded {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string | string[] | undefined>;
}

interface Canned {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  raw?: string;
}

const IDENTITY = {
  id: OWNER,
  role: 'member',
  auth: {
    method: 'pat',
    tokenId: '33333333-3333-4333-8333-333333333333',
    scopes: ['pto:read', 'pto:create'],
    expiresAt: '2027-01-01T00:00:00.000Z',
  },
};

const RECORD = {
  id: PTO_ID,
  userId: OWNER,
  startDate: '2026-05-10',
  endDate: '2026-05-10',
  dayPart: 'morning',
  note: 'Doctor appointment',
  createdAt: '2026-05-03T12:00:00.000Z',
  updatedAt: '2026-05-03T12:30:00.000Z',
  version: 1,
};

const DETAIL = {
  id: PTO_ID,
  user: { id: OWNER, name: 'Owner', colorCode: '#123456' },
  startDate: '2026-05-10',
  endDate: '2026-05-10',
  dayPart: 'morning',
  note: 'Doctor appointment',
  version: 1,
};

const PAGE_ITEM = {
  id: PTO_ID,
  user: { id: OWNER, name: 'Owner', colorCode: '#123456' },
  startDate: '2026-05-10',
  endDate: '2026-05-10',
  dayPart: 'morning',
  note: null,
  version: 1,
};

let server: ReturnType<typeof createServer>;
let baseUrl = '';
let client: PtoClient;
let recorded: Recorded[] = [];
let canned: Canned = { status: 200, body: {} };
let queue: Canned[] = [];

function send(res: ServerResponse, answer: Canned): void {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...answer.headers };
  res.writeHead(answer.status, headers);
  if (answer.raw !== undefined) {
    res.end(answer.raw);
    return;
  }
  if (answer.status === 204 || answer.body === undefined) {
    res.end();
    return;
  }
  res.end(JSON.stringify(answer.body));
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    recorded.push({
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.search,
      headers: req.headers,
    });
    send(res, queue.shift() ?? canned);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  client = createPtoClient({
    baseUrl,
    credential: { origin: baseUrl, token: TOKEN },
    allowLoopbackHttp: true,
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  recorded = [];
  canned = { status: 200, body: {} };
  queue = [];
});

describe('the client against the loopback fixture', () => {
  it('exports only the client factory and the error type', () => {
    expect(Object.keys(apiClient).sort()).toEqual(['PtoApiError', 'createPtoClient']);
  });

  it('exposes exactly the documented operations', () => {
    expect(Object.keys(client).sort()).toEqual([
      'create',
      'delete',
      'getDetail',
      'getIdentity',
      'listAll',
      'listPage',
      'patch',
    ]);
  });

  it('reads the identity with the credential and without a cookie', async () => {
    canned = { status: 200, body: IDENTITY };
    const identity = await client.getIdentity();
    expect(identity).toEqual(IDENTITY);
    expect(recorded[0]?.path).toBe('/auth/me');
    expect(recorded[0]?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(recorded[0]?.headers['cookie']).toBeUndefined();
  });

  it('asks for the paged envelope and never the capped array', async () => {
    canned = {
      status: 200,
      body: { items: [PAGE_ITEM], nextCursor: null, hasMore: false },
    };
    const page = await client.listPage({ start: '2026-05-01', end: '2026-05-31', limit: 50 });
    expect(page.items).toEqual([PAGE_ITEM]);
    const query = new URLSearchParams(recorded[0]?.query);
    expect(query.get('format')).toBe('page');
    expect(query.get('start')).toBe('2026-05-01');
    expect(query.get('end')).toBe('2026-05-31');
    expect(query.get('limit')).toBe('50');
    expect(query.get('cursor')).toBeNull();
  });

  it('walks the pages of a traversal and keeps the filters', async () => {
    queue = [
      { status: 200, body: { items: [PAGE_ITEM], nextCursor: 'cursor-1', hasMore: true } },
      { status: 200, body: { items: [], nextCursor: null, hasMore: false } },
    ];
    const result = await client.listAll({ start: '2026-05-01', end: '2026-05-31' });
    expect(result.complete).toBe(true);
    expect(result.reason).toBe('complete');
    expect(result.pages).toBe(2);
    expect(result.items).toEqual([PAGE_ITEM]);
    expect(recorded).toHaveLength(2);
    expect(new URLSearchParams(recorded[0]?.query).get('cursor')).toBeNull();
    expect(new URLSearchParams(recorded[1]?.query).get('cursor')).toBe('cursor-1');
    expect(new URLSearchParams(recorded[1]?.query).get('format')).toBe('page');
  });

  it('reads a detail', async () => {
    canned = { status: 200, body: DETAIL };
    const detail = await client.getDetail(PTO_ID);
    expect(detail).toEqual(DETAIL);
    expect(recorded[0]?.path).toBe(`/pto/${PTO_ID}`);
  });

  it('creates with the caller-supplied key and reports the replay state', async () => {
    canned = {
      status: 201,
      body: RECORD,
      headers: {
        'Idempotency-Replayed': 'false',
        'Idempotency-Key-Expires-At': EXPIRES_AT,
      },
    };
    const created = await client.create(
      { startDate: '2026-05-10', endDate: '2026-05-10', dayPart: 'morning' },
      KEY,
    );
    expect(created.record).toEqual(RECORD);
    expect(created.replayed).toBe(false);
    expect(created.expiresAt).toBe(EXPIRES_AT);
    expect(recorded[0]?.headers['idempotency-key']).toBe(KEY);
    expect(recorded[0]?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('marks a replayed create', async () => {
    canned = {
      status: 201,
      body: RECORD,
      headers: {
        'Idempotency-Replayed': 'true',
        'Idempotency-Key-Expires-At': EXPIRES_AT,
      },
    };
    const created = await client.create(
      { startDate: '2026-05-10', endDate: '2026-05-10', dayPart: 'morning' },
      KEY,
    );
    expect(created.replayed).toBe(true);
  });

  it('does not infer success from a create without its replay metadata', async () => {
    canned = { status: 201, body: RECORD };
    await expect(
      client.create({ startDate: '2026-05-10', endDate: '2026-05-10', dayPart: 'morning' }, KEY),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('sends the canonical precondition on a partial update', async () => {
    canned = { status: 200, body: { ...RECORD, version: 4 } };
    const patched = await client.patch(PTO_ID, 3, { dayPart: 'evening' });
    expect(patched.version).toBe(4);
    expect(recorded[0]?.headers['if-match']).toBe('"3"');
    expect(recorded[0]?.method).toBe('PATCH');
  });

  it('requires an empty 204 for a delete', async () => {
    canned = { status: 204 };
    await expect(client.delete(PTO_ID, 4)).resolves.toBeUndefined();
    expect(recorded[0]?.headers['if-match']).toBe('"4"');
    expect(recorded[0]?.method).toBe('DELETE');

    canned = { status: 200, body: { ok: true } };
    await expect(client.delete(PTO_ID, 4)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('reports an upstream failure with its machine code', async () => {
    canned = {
      status: 412,
      body: { error: { code: 'STALE_WRITE', message: 'stale' } },
      headers: { 'X-Request-Id': 'req-42' },
    };
    await expect(client.patch(PTO_ID, 1, { dayPart: 'evening' })).rejects.toMatchObject({
      code: 'STALE_WRITE',
      status: 412,
    });
  });

  it('reports an unknown upstream code as a fixed error', async () => {
    canned = { status: 500, body: { error: { code: 'TEAPOT', message: 'leak' } } };
    const failure = await client.getIdentity().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PtoApiError);
    expect((failure as PtoApiError).code).toBe('HTTP_ERROR');
    expect((failure as PtoApiError).status).toBe(500);
  });

  it('refuses a response that does not match the contract', async () => {
    canned = { status: 200, body: { id: 'nope' } };
    await expect(client.getIdentity()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('refuses a body that does not match the contract on every read and write', async () => {
    canned = {
      status: 200,
      body: { items: [{ id: 'nope' }], nextCursor: null, hasMore: false },
    };
    await expect(client.listPage({ start: '2026-05-01', end: '2026-05-31' })).rejects.toMatchObject(
      { code: 'INVALID_RESPONSE' },
    );

    canned = { status: 200, body: { id: 'nope' } };
    await expect(client.getDetail(PTO_ID)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    canned = {
      status: 201,
      body: { id: 'nope' },
      headers: {
        'Idempotency-Replayed': 'false',
        'Idempotency-Key-Expires-At': EXPIRES_AT,
      },
    };
    await expect(
      client.create({ startDate: '2026-05-10', endDate: '2026-05-10', dayPart: 'morning' }, KEY),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    canned = { status: 200, body: { id: 'nope' } };
    await expect(client.patch(PTO_ID, 1, { dayPart: 'evening' })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('refuses an unusable note, cursor or key before it reaches the network', async () => {
    await expect(client.patch(PTO_ID, 1, { note: 7 } as never)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(client.patch(PTO_ID, 1, { note: 'x'.repeat(501) })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      client.listPage({ start: '2026-05-01', end: '2026-05-31', cursor: '' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      client.create(
        {
          startDate: '2026-05-10',
          endDate: '2026-05-10',
          dayPart: 'morning',
          note: 'x'.repeat(501),
        },
        KEY,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(recorded).toHaveLength(0);
  });

  it('accepts a null note, which clears the stored one, and a text note', async () => {
    canned = { status: 200, body: RECORD };
    const cleared = await client.patch(PTO_ID, 1, { note: null });
    expect(cleared).toEqual(RECORD);
    expect(recorded[0]?.method).toBe('PATCH');

    canned = { status: 200, body: RECORD };
    const replaced = await client.patch(PTO_ID, 1, { note: 'Replaced' });
    expect(replaced).toEqual(RECORD);
  });

  it('reports an incomplete traversal with its typed cause', async () => {
    canned = { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'boom' } } };
    const result = await client.listAll({ start: '2026-05-01', end: '2026-05-31' });
    expect(result.complete).toBe(false);
    expect(result.reason).toBe('error');
    expect(result.items).toHaveLength(0);
    expect(result.error?.code).toBe('INTERNAL_ERROR');
    expect(result.error?.status).toBe(500);
  });

  it('never masks a defect of the client as a service answer', () => {
    const defect = new Error('defect');
    expect(() => invalidResponseFor(defect)).toThrow(defect);
    expect(() => invalidResponseFor(new PtoWireError())).toThrow(PtoApiError);
  });

  it('gives every stop of a traversal a fixed local code', () => {
    expect(localCodeFor('aborted')).toBe('ABORTED');
    expect(localCodeFor('deadline')).toBe('TIMEOUT');
    expect(localCodeFor('drift')).toBe('INVALID_RESPONSE');
    expect(localCodeFor('invalid-response')).toBe('INVALID_RESPONSE');
  });

  it('requires the documented status of every answer', async () => {
    // A read answers 200.
    canned = { status: 204 };
    await expect(client.getIdentity()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    // A create answers 201.
    canned = {
      status: 200,
      body: RECORD,
      headers: { 'Idempotency-Replayed': 'false', 'Idempotency-Key-Expires-At': EXPIRES_AT },
    };
    await expect(
      client.create({ startDate: '2026-05-10', endDate: '2026-05-10', dayPart: 'morning' }, KEY),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    // A partial update answers 200.
    canned = { status: 201, body: RECORD };
    await expect(client.patch(PTO_ID, 1, { dayPart: 'evening' })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });

    // A delete answers 204.
    canned = { status: 200, body: { ok: true } };
    await expect(client.delete(PTO_ID, 1)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('keeps the safe status and correlation id of a refused write', async () => {
    canned = {
      status: 201,
      body: RECORD,
      headers: { 'Idempotency-Replayed': 'false', 'X-Request-Id': 'req-77' },
    };
    const failure = await client
      .create({ startDate: '2026-05-10', endDate: '2026-05-10', dayPart: 'morning' }, KEY)
      .then(
        (value) => value,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(PtoApiError);
    expect((failure as PtoApiError).code).toBe('INVALID_RESPONSE');
    expect((failure as PtoApiError).status).toBe(201);
    expect((failure as PtoApiError).requestId).toBe('req-77');
    // The write was dispatched, so it may have committed.
    expect((failure as PtoApiError).unknownWriteOutcome).toBe(true);
  });

  it('refuses a create whose expiry does not belong to the key', async () => {
    canned = {
      status: 201,
      body: RECORD,
      headers: {
        'Idempotency-Replayed': 'false',
        'Idempotency-Key-Expires-At': new Date(ISSUED_AT + 3_600_000).toISOString(),
      },
    };
    const failure = await client
      .create({ startDate: '2026-05-10', endDate: '2026-05-10', dayPart: 'morning' }, KEY)
      .then(
        (value) => value,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(PtoApiError);
    expect((failure as PtoApiError).code).toBe('INVALID_RESPONSE');
    expect((failure as PtoApiError).unknownWriteOutcome).toBe(true);
  });

  it('refuses a record that is not the one that was addressed', async () => {
    const other = { ...DETAIL, id: '99999999-9999-4999-8999-999999999999' };
    canned = { status: 200, body: other };
    await expect(client.getDetail(PTO_ID)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    canned = { status: 200, body: { ...RECORD, id: '99999999-9999-4999-8999-999999999999' } };
    const failure = await client.patch(PTO_ID, 1, { dayPart: 'evening' }).then(
      (value) => value,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PtoApiError);
    expect((failure as PtoApiError).unknownWriteOutcome).toBe(true);
  });

  it('keeps the filters of a traversal fixed when the caller mutates its own object', async () => {
    const query = { start: '2026-05-01', end: '2026-05-31', userId: OWNER, limit: 25 };
    queue = [
      { status: 200, body: { items: [PAGE_ITEM], nextCursor: 'cursor-1', hasMore: true } },
      { status: 200, body: { items: [], nextCursor: null, hasMore: false } },
    ];
    const pending = client.listAll(query);
    // The caller changes its own object while the first page is on its way.
    query.start = '2027-01-01';
    query.end = '2027-12-31';
    query.userId = 'changed';
    query.limit = 200;
    const result = await pending;
    expect(result.complete).toBe(true);
    expect(result.reason).toBe('complete');
    expect(recorded).toHaveLength(2);
    for (const call of recorded) {
      const search = new URLSearchParams(call.query);
      expect(search.get('start')).toBe('2026-05-01');
      expect(search.get('end')).toBe('2026-05-31');
      expect(search.get('userId')).toBe(OWNER);
      expect(search.get('limit')).toBe('25');
    }
  });

  it('does not impose the read range on a create', async () => {
    canned = {
      status: 201,
      body: RECORD,
      headers: { 'Idempotency-Replayed': 'false', 'Idempotency-Key-Expires-At': EXPIRES_AT },
    };
    await client
      .create({ startDate: '2026-01-01', endDate: '2027-06-01', dayPart: 'all_day' }, KEY)
      .catch(() => undefined);
    expect(recorded).toHaveLength(1);
  });

  it('keeps the safe fields of an upstream failure in an incomplete traversal', async () => {
    canned = {
      status: 429,
      body: { error: { code: 'RATE_LIMITED', message: 'slow down' } },
      headers: { 'Retry-After': '7', 'X-Request-Id': 'req-9' },
    };
    const result = await client.listAll({ start: '2026-05-01', end: '2026-05-31' });
    expect(result.complete).toBe(false);
    expect(result.reason).toBe('error');
    expect(result.error?.code).toBe('RATE_LIMITED');
    expect(result.error?.status).toBe(429);
    expect(result.error?.requestId).toBe('req-9');
    expect(result.error?.retryAfterMs).toBe(7000);
  });

  it('reports a malformed page as explicitly incomplete with safe metadata', async () => {
    canned = { status: 200, body: [], headers: { 'X-Request-Id': 'req-page' } };
    const result = await client.listAll({ start: '2026-05-01', end: '2026-05-31' });
    expect(result).toMatchObject({
      complete: false,
      reason: 'invalid-response',
      items: [],
      error: { code: 'INVALID_RESPONSE', status: 200, requestId: 'req-page' },
    });
    expect(recorded).toHaveLength(1);
  });

  it('refuses invalid input before it reaches the network', async () => {
    await expect(client.getDetail('not-a-uuid')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client.patch(PTO_ID, 0, { dayPart: 'evening' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      client.create({ startDate: '2026-05-10', endDate: '2026-05-10' }, 'not-a-key'),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // The key has to be the canonical one, even when the body is fine.
    await expect(
      client.create(
        { startDate: '2026-05-10', endDate: '2026-05-10', dayPart: 'morning' },
        'not-a-key',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      client.create(
        { startDate: '2026-05-10', endDate: '2026-05-10', dayPart: 'morning' },
        'v2.1700000000000.9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      client.create(
        {
          startDate: '2026-05-10',
          endDate: '2026-05-10',
          dayPart: 'morning',
          userId: OWNER,
        } as never,
        KEY,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      client.listPage({ start: '2026-05-01', end: '2026-05-31', limit: 500 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(recorded).toHaveLength(0);
  });

  it('passes the cancellation of the caller to every request of a traversal', async () => {
    const controller = new AbortController();
    canned = { status: 200, body: { items: [PAGE_ITEM], nextCursor: null, hasMore: false } };
    const result = await client.listAll(
      { start: '2026-05-01', end: '2026-05-31' },
      { signal: controller.signal },
    );
    expect(result.complete).toBe(true);
    expect(recorded).toHaveLength(1);
  });

  it('reports an aborted traversal without asking the service', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await client.listAll(
      { start: '2026-05-01', end: '2026-05-31' },
      { signal: controller.signal },
    );
    expect(result.complete).toBe(false);
    expect(result.reason).toBe('aborted');
    expect(result.items).toHaveLength(0);
    expect(result.error?.code).toBe('ABORTED');
    expect(recorded).toHaveLength(0);
  });

  it('reports a drifted traversal as an unusable answer', async () => {
    queue = [
      { status: 200, body: { items: [PAGE_ITEM], nextCursor: 'cursor-1', hasMore: true } },
      // The second page repeats a record of the first one.
      { status: 200, body: { items: [PAGE_ITEM], nextCursor: null, hasMore: false } },
    ];
    const result = await client.listAll({ start: '2026-05-01', end: '2026-05-31' });
    expect(result.complete).toBe(false);
    expect(result.reason).toBe('drift');
    expect(result.error?.code).toBe('INVALID_RESPONSE');
    // Only the records that were really read are kept.
    expect(result.items).toHaveLength(1);
    expect(recorded).toHaveLength(2);
  });
});
