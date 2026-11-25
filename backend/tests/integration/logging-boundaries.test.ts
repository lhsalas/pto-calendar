import { afterAll, describe, expect, it, vi } from 'vitest';

const envBackup = vi.hoisted(() => {
  const sessionSecret = process.env.SESSION_SECRET;
  const databaseUrl = process.env.DATABASE_URL;
  // The production logger reads the environment when the module is imported.
  // The fallback database URL points at the discard port: nothing in this
  // file opens a database connection, and no credential is ever used.
  process.env.SESSION_SECRET ??= 'integration-logging-boundaries-secret-4d7f92c1ab';
  process.env.DATABASE_URL ??= 'postgresql://placeholder@127.0.0.1:9/placeholder?schema=public';
  return { sessionSecret, databaseUrl };
});

import { Writable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import express from 'express';
import { pino, type Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import request from 'supertest';

import { LOGGER_OPTIONS } from '../../src/lib/logger.js';
import { scrubLogLine, scrubValue } from '../../src/lib/logRedaction.js';
import { createPinoHttpOptions, safeRequestId } from '../../src/lib/logSanitizers.js';
import { isSafeCorrelationId } from '../../src/lib/requestCorrelation.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A logger built from the production options, writing into a capturing sink.
 * The formatter, the serializers and both stream hooks are the ones the
 * application uses, so every assertion below runs against the real pipeline.
 */
function createCapturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  const logger = pino(
    { ...LOGGER_OPTIONS, base: { pid: 0, hostname: 'test' } },
    sink as unknown as NodeJS.WritableStream,
  );
  return { logger, lines };
}

/** The captured records, parsed the way a log collector would read them. */
function parseRecords(lines: string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterAll(() => {
  // Leave the shared process environment as it was found.
  if (envBackup.sessionSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = envBackup.sessionSecret;
  if (envBackup.databaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = envBackup.databaseUrl;
});

describe('credential-safe logging boundary', () => {
  it('redacts a credential that only appears deep inside the payload', () => {
    const { logger, lines } = createCapturingLogger();

    logger.info({ audit: { apiKey: 'sentinel-deep-api-key', note: 'kept' } }, 'nested credential');

    const blob = lines.join('');
    expect(blob).not.toContain('sentinel-deep-api-key');
    expect(blob).toContain('"apiKey":"[REDACTED]"');
    // The safe part of the payload survives.
    expect(blob).toContain('"note":"kept"');
  });

  it('redacts a top-level credential key that shallow redaction would miss', () => {
    const { logger, lines } = createCapturingLogger();

    logger.info({ apiKey: 'sentinel-top-level-api-key', route: '/pto' }, 'top level credential');

    const blob = lines.join('');
    expect(blob).not.toContain('sentinel-top-level-api-key');
    expect(blob).toContain('"apiKey":"[REDACTED]"');
    expect(blob).toContain('"route":"/pto"');
  });

  it('scrubs an error at any depth and keeps the safe attribution', () => {
    const { logger, lines } = createCapturingLogger();
    const failure = new Error('login failed for pto_pat_sentinel-error-token');
    // An enumerable `type` must not overwrite the error name, and an
    // enumerable `code` must survive as safe attribution.
    Object.assign(failure, { code: 'E_SENTINEL', type: 'SentinelError' });
    // A driver error without a stack must not break the log line.
    failure.stack = undefined;

    logger.error(failure);

    const blob = lines.join('');
    expect(blob).not.toContain('pto_pat_sentinel-error-token');
    expect(blob).not.toContain('SentinelError');
    expect(blob).toContain('"type":"Error"');
    expect(blob).toContain('"code":"E_SENTINEL"');
    expect(blob).toContain('"stack":""');
  });

  it('scrubs the cause of an error at any depth', () => {
    const { logger, lines } = createCapturingLogger();
    const cause = new Error('database rejected pto_pat_sentinel-cause-token');
    const failure = new Error('request failed', { cause });

    logger.error(failure);

    const blob = lines.join('');
    expect(blob).not.toContain('pto_pat_sentinel-cause-token');
    expect(blob).toContain('"cause"');
    expect(blob).toContain('database rejected [REDACTED]');
  });

  it('bounds an oversized error attribute and reports the excess', () => {
    const { logger, lines } = createCapturingLogger();
    const failure = new Error('oversized attribute');
    const oversized = Array.from({ length: 150 }, (_value, index) => index);
    Object.assign(failure, { items: oversized });

    logger.error(failure);

    const [record] = parseRecords(lines);
    const items = (record?.['err'] as Record<string, unknown> | undefined)?.['items'] as
      unknown[] | undefined;
    expect(Array.isArray(items)).toBe(true);
    // The array never grows past the bound, and the excess is reported.
    expect(items).toHaveLength(101);
    expect(items?.[100]).toMatch(/^\[\d+ more\]$/);
    // The first pass reports the real excess before the later boundary
    // passes re-bound the already bounded array.
    expect((scrubValue(oversized) as unknown[])[100]).toBe('[50 more]');
  });

  it('scrubs interpolated values that no serializer owns', () => {
    const { logger, lines } = createCapturingLogger();
    const failure = new Error('boom pto_pat_sentinel-interpolated-token');
    const stamp = new Date('2026-03-04T05:06:07.000Z');

    logger.info('failed: %j', { apiKey: 'sentinel-interpolated-api-key', keep: 'yes' });
    logger.info('error detail: %o', failure);
    logger.info('nothing: %s', null);
    logger.info('items: %j', ['a', 'b']);
    logger.info('at: %s', stamp);
    logger.info('bytes: %s', new Uint8Array([1, 2, 3]));

    const blob = lines.join('');
    expect(blob).not.toContain('sentinel-interpolated-api-key');
    expect(blob).not.toContain('pto_pat_sentinel-interpolated-token');

    const records = parseRecords(lines);
    expect(records[0]?.['msg']).toContain('"apiKey":"[REDACTED]"');
    expect(records[0]?.['msg']).toContain('"keep":"yes"');
    // The interpolated error keeps its shape but loses its credential.
    expect(records[1]?.['msg']).toContain('"message":"boom [REDACTED]"');
    expect(records[1]?.['msg']).toContain('"type":"Error"');
    expect(records[2]?.['msg']).toBe('nothing: null');
    expect(records[3]?.['msg']).toBe('items: ["a","b"]');
    expect(records[4]?.['msg']).toBe(`at: ${String(stamp)}`);
    expect(records[5]?.['msg']).toBe('bytes: [Binary]');
  });

  it('replaces unusual value types with safe markers instead of failing', () => {
    const { logger, lines } = createCapturingLogger();
    const circular: Record<string, unknown> = { label: 'loop-label' };
    circular.self = circular;

    logger.info({
      big: 42n,
      fn: () => 'sentinel-function-body',
      sym: Symbol('sentinel-symbol'),
      when: new Date('2026-02-03T04:05:06.000Z'),
      bytes: new Uint8Array([1, 2, 3]),
      raw: new ArrayBuffer(4),
      list: ['a', 'b'],
      circular,
    });

    const blob = lines.join('');
    expect(blob).not.toContain('sentinel-function-body');
    expect(blob).not.toContain('sentinel-symbol');
    expect(blob).toContain('"big":"42"');
    expect(blob).toContain('"[Binary]"');
    expect(blob).toContain('"[Circular]"');
    // A value that cannot be represented is dropped instead of serialized.
    expect(blob).not.toContain('"fn"');
    expect(blob).not.toContain('"sym"');

    const [record] = parseRecords(lines);
    expect(record?.['when']).toBe('2026-02-03T04:05:06.000Z');
    expect((record?.['circular'] as Record<string, unknown> | undefined)?.['self']).toBe(
      '[Circular]',
    );
    expect(record?.['list']).toEqual(['a', 'b']);
  });

  it('truncates a payload that is nested past the depth limit', () => {
    const { logger, lines } = createCapturingLogger();
    let node: Record<string, unknown> = { leaf: 'sentinel-deep-leaf' };
    for (let level = 0; level < 10; level += 1) node = { nested: node };

    logger.info({ deep: node });

    const blob = lines.join('');
    expect(blob).not.toContain('sentinel-deep-leaf');
    expect(blob).toContain('"[Truncated]"');
  });

  it('keeps an unreadable entry from stopping the log line', () => {
    const { logger, lines } = createCapturingLogger();
    const hostile = {
      get boom(): string {
        throw new Error('sentinel-getter-message');
      },
    };

    logger.info({ hostile });

    const blob = lines.join('');
    expect(blob).not.toContain('sentinel-getter-message');
    expect(blob).toContain('"[Unreadable]"');
  });

  it('keeps a non-string message and classifies an unusable request url', () => {
    const { logger, lines } = createCapturingLogger();

    logger.info({ msg: 42, req: { id: 7, method: 'GET', url: 12345 } });

    const blob = lines.join('');
    expect(blob).toContain('"msg":42');
    expect(blob).toContain('"url":"[unclassified]"');
  });

  it('scrubs a stream line that is not a JSON record instead of dropping it', () => {
    const scrubbed = scrubLogLine('plain text with pto_pat_sentinel-raw-line-token');

    expect(scrubbed).toBe('plain text with [REDACTED]');
  });

  it('scrubs a stream line that carries no trailing newline', () => {
    const scrubbed = scrubLogLine('{"apiKey":"sentinel-raw-line-key","keep":"yes"}');

    expect(scrubbed).not.toContain('sentinel-raw-line-key');
    expect(scrubbed).toContain('"keep":"yes"');
    expect(scrubbed.endsWith('\n')).toBe(false);
  });
});

describe('correlation id boundary', () => {
  it('refuses an unusable correlation id and keeps the response and the log in agreement', async () => {
    const { logger, lines } = createCapturingLogger();
    const app = express();
    app.use(pinoHttp(createPinoHttpOptions(logger)));
    app.get('/pto', (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app).get('/pto').set('X-Request-Id', 'not a safe id!');

    const issued = res.headers['x-request-id'];
    expect(issued).toMatch(UUID_PATTERN);
    expect(issued).not.toBe('not a safe id!');
    const blob = lines.join('');
    expect(blob).not.toContain('not a safe id!');
    expect(blob).toContain(`"id":"${issued}"`);
  });

  it('refuses a correlation id that repeats a submitted idempotency key', async () => {
    const { logger, lines } = createCapturingLogger();
    const app = express();
    app.use(pinoHttp(createPinoHttpOptions(logger)));
    app.get('/pto', (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app)
      .get('/pto')
      .set('X-Request-Id', 'client-state-key')
      .set('Idempotency-Key', 'client-state-key');

    const issued = res.headers['x-request-id'];
    expect(issued).toMatch(UUID_PATTERN);
    expect(issued).not.toBe('client-state-key');
    const blob = lines.join('');
    expect(blob).not.toContain('client-state-key');
  });

  it('echoes a usable correlation id and classifies a token route', async () => {
    const { logger, lines } = createCapturingLogger();
    const app = express();
    app.use(pinoHttp(createPinoHttpOptions(logger)));
    app.get('/auth/tokens', (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app).get('/auth/tokens').set('X-Request-Id', 'req-2026.01.02');

    expect(res.headers['x-request-id']).toBe('req-2026.01.02');
    const blob = lines.join('');
    expect(blob).toContain('"id":"req-2026.01.02"');
    // The token route is classified, not echoed with its query string.
    expect(blob).toContain('"url":"/auth/tokens"');
  });

  it('keeps a correlation id that an earlier boundary already issued', () => {
    const headers = new Map<string, string>([['x-request-id', 'issued-earlier']]);
    const res = {
      setHeader(name: string, value: string): void {
        headers.set(name.toLowerCase(), String(value));
      },
      getHeader(name: string): string | undefined {
        return headers.get(name.toLowerCase());
      },
    } as unknown as ServerResponse;
    const req = { headers: {} } as unknown as IncomingMessage;

    const id = safeRequestId(req, res);

    expect(id).toBe('issued-earlier');
    expect(headers.get('x-request-id')).toBe('issued-earlier');
  });

  it('issues a fresh correlation id when the request carries no raw header list', () => {
    const headers = new Map<string, string>();
    const res = {
      setHeader(name: string, value: string): void {
        headers.set(name.toLowerCase(), String(value));
      },
      getHeader(name: string): string | undefined {
        return headers.get(name.toLowerCase());
      },
    } as unknown as ServerResponse;
    const req = { headers: {} } as unknown as IncomingMessage;

    const id = safeRequestId(req, res);

    expect(id).toMatch(UUID_PATTERN);
    expect(headers.get('x-request-id')).toBe(id);
  });

  it('applies the correlation id grammar and the submitted key rule', () => {
    expect(isSafeCorrelationId('req-2026.01.02')).toBe(true);
    expect(isSafeCorrelationId('has space')).toBe(false);
    expect(isSafeCorrelationId('pto_pat_1234')).toBe(false);
    expect(isSafeCorrelationId('v1.1700000000000.deadbeef-dead-4bee-8bee-deadbeefdead')).toBe(
      false,
    );
    expect(isSafeCorrelationId('client-key', ['client-key'])).toBe(false);
    // An empty submitted key is not a key, so it cannot refuse an id.
    expect(isSafeCorrelationId('client-key', [''])).toBe(true);
  });
});
