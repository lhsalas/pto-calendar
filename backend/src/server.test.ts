import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
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

  it('responds to GET /health', async () => {
    const app = createApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('returns 404 for unknown routes', async () => {
    const app = createApp();
    const res = await request(app).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
