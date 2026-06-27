import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from './server.js';
import { resetEnvForTests } from './config/env.js';

describe('server', () => {
  it('responds to GET /health', async () => {
    process.env.NODE_ENV = 'test';
    process.env.SESSION_SECRET = 'a'.repeat(32);
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    resetEnvForTests();

    const app = createApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok' });
  });

  it('returns 404 for unknown routes', async () => {
    const app = createApp();
    const res = await request(app).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
