import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const { queryRawMock } = vi.hoisted(() => ({
  queryRawMock: vi.fn(),
}));

vi.mock('./lib/prisma.js', () => ({
  prisma: {
    $queryRaw: queryRawMock,
  },
}));

import { createApp } from './server.js';
import { resetEnvForTests } from './config/env.js';

const REQUIRED_ENV = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'a'.repeat(32),
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
} as const;

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
