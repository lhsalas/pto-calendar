import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ adapter: vi.fn(), client: vi.fn() }));

vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: class {
    constructor(...args: unknown[]) {
      calls.adapter(...args);
    }
  },
}));

vi.mock('@prisma/client', () => ({
  PrismaClient: class {
    constructor(...args: unknown[]) {
      calls.client(...args);
    }
  },
}));

import { createPrismaClient } from './prismaClient.js';

describe('createPrismaClient', () => {
  it('passes the connection and schema to an adapter-owned pool', () => {
    const url =
      'postgresql://pto:pto@socket-only.invalid/test?host=%2Fprivate%2Fsocket&schema=custom';
    createPrismaClient(url, ['warn', 'error']);
    expect(calls.adapter).toHaveBeenLastCalledWith({ connectionString: url }, { schema: 'custom' });
    expect(calls.client).toHaveBeenLastCalledWith({
      adapter: expect.any(Object),
      log: ['warn', 'error'],
    });
  });

  it('defaults to the public schema and fails synchronously on an invalid URL', () => {
    createPrismaClient('postgresql://localhost/test');
    expect(calls.adapter).toHaveBeenLastCalledWith(
      { connectionString: 'postgresql://localhost/test' },
      { schema: 'public' },
    );
    expect(() => createPrismaClient('not-a-url')).toThrow();
  });

  it('propagates adapter construction errors', () => {
    calls.adapter.mockImplementationOnce(() => {
      throw new Error('adapter setup failed');
    });
    expect(() => createPrismaClient('postgresql://localhost/test')).toThrow('adapter setup failed');
  });
});
