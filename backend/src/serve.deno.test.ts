import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { queryRawMock } = vi.hoisted(() => ({
  queryRawMock: vi.fn(),
}));

vi.mock('./lib/prisma.js', () => ({
  prisma: {
    $queryRaw: queryRawMock,
  },
}));

import { resetEnvForTests } from './config/env.js';

const REQUIRED_ENV = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'aB1!cD2@eF3#gH4$iJ5%kL6&mN7*oP8+',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
} as const;

let adapter: { fetch: (request: Request) => Promise<Response> };

beforeAll(async () => {
  Object.assign(process.env, REQUIRED_ENV);
  resetEnvForTests();
  const mod = (await import('./serve.deno.js')) as { default: typeof adapter };
  adapter = mod.default;
});

beforeEach(() => {
  Object.assign(process.env, REQUIRED_ENV);
  resetEnvForTests();
  queryRawMock.mockReset();
});

afterEach(() => {
  resetEnvForTests();
});

describe('serve.deno adapter', () => {
  it('exports a default object with a fetch handler', () => {
    expect(typeof adapter.fetch).toBe('function');
  });

  it('forwards method, URL, and headers to the Express app', async () => {
    queryRawMock.mockResolvedValue([{ '?column?': 1 }]);
    const res = await adapter.fetch(
      new Request('http://localhost/ready', {
        method: 'GET',
        headers: { 'x-custom-header': 'hello' },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; db: string };
    expect(body.status).toBe('ready');
    expect(body.db).toBe('ok');
  });

  it('returns 200 from /health without touching the database', async () => {
    const res = await adapter.fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it('streams a request body through to the Express app', async () => {
    queryRawMock.mockResolvedValue([{ '?column?': 1 }]);
    const res = await adapter.fetch(
      new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong-password-xx' }),
      }),
    );
    expect([400, 401, 500]).toContain(res.status);
  });

  it('preserves response headers (helmet headers, X-Request-Id)', async () => {
    const res = await adapter.fetch(new Request('http://localhost/health'));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(res.headers.get('x-request-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('returns 404 for unknown routes via the express app', async () => {
    const res = await adapter.fetch(new Request('http://localhost/does-not-exist'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
