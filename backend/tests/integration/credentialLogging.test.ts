import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type * as LoggerModule from '../../src/lib/logger.js';

const { logs } = vi.hoisted(() => ({ logs: [] as string[] }));

vi.mock('../../src/lib/logger.js', async (importOriginal) => {
  const original = await importOriginal<typeof LoggerModule>();
  const { Writable } = await import('node:stream');
  const { pino } = await import('pino');
  const sink = new Writable({
    write(chunk, _encoding, done) {
      logs.push(chunk.toString());
      done();
    },
  });
  return {
    ...original,
    // The production options, captured: the same pipeline the application uses.
    logger: pino(
      { ...original.LOGGER_OPTIONS, base: { pid: 0, hostname: 'test' } },
      sink as unknown as NodeJS.WritableStream,
    ),
  };
});

import { createApp, type ManagedApp } from '../../src/server.js';

const PASSWORD = 'integration-logging-password-marker';
const PAT_VALUE = `pto_pat_11111111-1111-4111-8111-111111111111.${'a'.repeat(64)}`;

describe('production request logging boundary', () => {
  let app: ManagedApp;

  beforeAll(() => {
    app = createApp();
  });

  afterAll(async () => {
    await app.closeResources();
  });

  it('never writes a submitted password into the request log', async () => {
    logs.length = 0;
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'someone@example.test', password: PASSWORD })
      .expect(401);

    const blob = logs.join('');
    expect(blob).not.toContain(PASSWORD);
    expect(blob).toContain('"url":"/auth/login"');
    expect(blob).toContain(`"id":"${res.headers['x-request-id']}"`);
  });

  it('never writes an Authorization credential into the request log', async () => {
    logs.length = 0;
    await request(app).get('/auth/me').set('Authorization', `Bearer ${PAT_VALUE}`).expect(401);

    const blob = logs.join('');
    expect(blob).not.toContain(PAT_VALUE);
    expect(blob).not.toContain('a'.repeat(64));
    expect(blob).toContain('"url":"/auth/me"');
  });

  it('never writes a rejected request body into the error log', async () => {
    logs.length = 0;
    const res = await request(app)
      .post('/auth/login')
      .set('Content-Type', 'application/json')
      .send(`password=${PASSWORD}`)
      .expect(500);

    const blob = logs.join('');
    expect(blob).not.toContain(PASSWORD);
    expect(blob).toContain('"errorType":"request_body_error"');
    expect(blob).toContain(`"reqId":"${res.headers['x-request-id']}"`);
  });
});
