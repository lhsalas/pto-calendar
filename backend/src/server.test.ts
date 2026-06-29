import { Writable } from 'node:stream';
import { pino, type Logger } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const { queryRawMock, capturedLogs } = vi.hoisted(() => ({
  queryRawMock: vi.fn(),
  capturedLogs: { lines: [] as string[] },
}));

vi.mock('./lib/prisma.js', () => ({
  prisma: {
    $queryRaw: queryRawMock,
  },
}));

vi.mock('./lib/logger.js', () => {
  const sink = new Writable({
    write(chunk, _enc, cb) {
      capturedLogs.lines.push(chunk.toString());
      cb();
    },
  });
  const testLogger: Logger = pino(
    { level: 'info', base: { pid: 0, hostname: 'test' } },
    sink as unknown as NodeJS.WritableStream,
  );
  return {
    logger: testLogger,
    Logger: undefined,
  };
});

import { createApp } from './server.js';
import { resetEnvForTests } from './config/env.js';

const REQUIRED_ENV = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'a'.repeat(32),
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
} as const;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface ParsedLogLine {
  msg?: string;
  [key: string]: unknown;
}

function parseLogs(): ParsedLogLine[] {
  const all = capturedLogs.lines.join('');
  const lines = all.split('\n').filter((l) => l.trim().length > 0);
  const parsed: ParsedLogLine[] = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line) as ParsedLogLine);
    } catch {
      // skip non-JSON
    }
  }
  return parsed;
}

describe('server', () => {
  const originalEnv = { ...process.env };

  beforeAll(() => {
    Object.assign(process.env, REQUIRED_ENV);
    resetEnvForTests();
  });

  afterAll(() => {
    process.env = { ...originalEnv };
    resetEnvForTests();
  });

  beforeEach(() => {
    queryRawMock.mockReset();
  });

  describe('GET /health (liveness)', () => {
    it('returns 200 with { status: "ok" }', async () => {
      const app = createApp();
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('returns 200 even when the database is unreachable', async () => {
      queryRawMock.mockRejectedValue(new Error('connection refused'));
      const app = createApp();
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });
  });

  describe('GET /ready (readiness)', () => {
    it('returns 200 with { status: "ready", db: "ok", uptime: <number> } when DB responds', async () => {
      queryRawMock.mockResolvedValue([{ '?column?': 1 }]);
      const app = createApp();
      const res = await request(app).get('/ready');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      expect(res.body.db).toBe('ok');
      expect(typeof res.body.uptime).toBe('number');
      expect(res.body.uptime).toBeGreaterThanOrEqual(0);
    });

    it('returns 503 when the database throws', async () => {
      queryRawMock.mockRejectedValue(new Error('connection refused'));
      const app = createApp();
      const res = await request(app).get('/ready');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        error: {
          code: 'NOT_READY',
          message: 'Database unavailable',
          details: { db: 'unreachable', reason: 'connection refused' },
        },
      });
    });

    it('returns 503 within READY_TIMEOUT_MS + 100ms when the database hangs', async () => {
      const original = process.env.READY_TIMEOUT_MS;
      process.env.READY_TIMEOUT_MS = '200';
      resetEnvForTests();

      queryRawMock.mockImplementation(
        () => new Promise(() => {}) as unknown as ReturnType<typeof queryRawMock>,
      );

      const app = createApp();
      const start = Date.now();
      const res = await request(app).get('/ready');
      const elapsed = Date.now() - start;

      expect(res.status).toBe(503);
      expect(elapsed).toBeLessThan(600);
      expect(res.body.error.code).toBe('NOT_READY');
      expect(res.body.error.details.db).toBe('unreachable');
      expect(res.body.error.details.reason).toContain('timed out');

      if (original === undefined) delete process.env.READY_TIMEOUT_MS;
      else process.env.READY_TIMEOUT_MS = original;
      resetEnvForTests();
    });
  });

  describe('request ID and request logging', () => {
    beforeEach(() => {
      capturedLogs.lines.length = 0;
    });

    it('echoes an X-Request-Id UUID on every response', async () => {
      queryRawMock.mockResolvedValue([{ '?column?': 1 }]);
      const app = createApp();
      const res = await request(app).get('/health');
      expect(res.headers['x-request-id']).toMatch(UUID_REGEX);
    });

    it('respects an inbound X-Request-Id header', async () => {
      queryRawMock.mockResolvedValue([{ '?column?': 1 }]);
      const app = createApp();
      const inbound = '11111111-2222-3333-4444-555555555555';
      const res = await request(app).get('/health').set('X-Request-Id', inbound);
      expect(res.headers['x-request-id']).toBe(inbound);
    });

    it('does NOT log request completion for GET /health', async () => {
      const app = createApp();
      await request(app).get('/health');
      await new Promise((r) => setTimeout(r, 50));
      const completionLogs = parseLogs().filter((l) => l.msg === 'request completed');
      expect(completionLogs).toHaveLength(0);
    });

    it('does NOT log request completion for GET /ready', async () => {
      queryRawMock.mockResolvedValue([{ '?column?': 1 }]);
      const app = createApp();
      await request(app).get('/ready');
      await new Promise((r) => setTimeout(r, 50));
      const completionLogs = parseLogs().filter((l) => l.msg === 'request completed');
      expect(completionLogs).toHaveLength(0);
    });

    it('logs exactly one request-completion line for POST /auth/login (any response)', async () => {
      queryRawMock.mockResolvedValue([{ '?column?': 1 }]);
      const app = createApp();
      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'nobody@example.com', password: 'wrong' });
      expect([401, 500]).toContain(res.status);

      await new Promise((r) => setTimeout(r, 50));

      const completionLogs = parseLogs().filter(
        (l) => l.msg === 'request completed' || l.msg === 'request errored',
      );
      expect(completionLogs).toHaveLength(1);

      const log = completionLogs[0]!;
      const req = log['req'] as Record<string, unknown>;
      const resLog = log['res'] as Record<string, unknown>;
      expect(req['method']).toBe('POST');
      expect(req['url']).toBe('/auth/login');
      expect(typeof req['id']).toBe('string');
      expect(req['id']).toMatch(UUID_REGEX);
      expect(resLog['statusCode']).toBe(res.status);
      expect(typeof log['responseTime']).toBe('number');
    });

    it('logs a readiness-check warning when /ready fails', async () => {
      queryRawMock.mockImplementation(() => {
        throw new Error('boom');
      });
      const app = createApp();
      const res = await request(app).get('/ready');
      expect(res.status).toBe(503);

      const warnLogs = parseLogs().filter((l) => l.msg === 'Readiness check failed');
      expect(warnLogs).toHaveLength(1);
      expect(warnLogs[0]!['err']).toBeDefined();
    });

    it('errorHandler logs reqId when a downstream handler throws', async () => {
      const express = (await import('express')).default;
      const testApp = express();
      const { errorHandler } = await import('./middleware/errorHandler.js');
      testApp.use((req, _res, next) => {
        (req as unknown as { id: string }).id = '99999999-aaaa-bbbb-cccc-dddddddddddd';
        next();
      });
      testApp.get('/boom', (_req, _res, next) => {
        next(new Error('route boom'));
      });
      testApp.use(errorHandler);

      const res = await request(testApp).get('/boom');
      expect(res.status).toBe(500);

      const errorLogs = parseLogs().filter((l) => l.msg === 'Unhandled error');
      expect(errorLogs).toHaveLength(1);
      expect(errorLogs[0]!['reqId']).toBe('99999999-aaaa-bbbb-cccc-dddddddddddd');
    });
  });

  it('returns 404 for unknown routes', async () => {
    queryRawMock.mockResolvedValue([{ '?column?': 1 }]);
    const app = createApp();
    const res = await request(app).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('applies helmet security headers to responses', async () => {
    const app = createApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=/);
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
  });
});
