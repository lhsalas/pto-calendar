import { describe, expect, it, vi } from 'vitest';

import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { createPrismaClient } from './prismaClient.js';

describe('Prisma PostgreSQL pool ownership', () => {
  it('allows repeated disconnect without connecting', async () => {
    const client = createPrismaClient('postgresql://pto:pto@127.0.0.1:1/pto_test?schema=public');
    await expect(client.$disconnect()).resolves.toBeUndefined();
    await expect(client.$disconnect()).resolves.toBeUndefined();
  });

  it('disposes an adapter-created pool and propagates cleanup errors', async () => {
    const factory = new PrismaPg({ connectionString: 'postgresql://localhost/test' });
    const adapter = await factory.connect();
    const pool = adapter.underlyingDriver();
    const end = vi.spyOn(pool, 'end').mockRejectedValueOnce(new Error('cleanup failed'));
    await expect(adapter.dispose()).rejects.toThrow('cleanup failed');
    expect(end).toHaveBeenCalledOnce();
    end.mockRestore();
    await pool.end();
  });

  it('does not end a borrowed pool by default', async () => {
    const pool = new pg.Pool({ connectionString: 'postgresql://localhost/test' });
    const end = vi.spyOn(pool, 'end');
    const removeListener = vi.spyOn(pool, 'removeListener');
    const adapter = await new PrismaPg(pool).connect();
    await adapter.dispose();
    expect(end).not.toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalledWith('error', expect.any(Function));
    await pool.end();
  });
});
