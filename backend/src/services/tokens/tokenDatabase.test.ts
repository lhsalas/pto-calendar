import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

const poolConstructor = vi.hoisted(() => vi.fn());
vi.mock('pg', () => ({
  default: {
    Pool: class {
      constructor(options: unknown) {
        Object.assign(this, poolConstructor(options));
      }
    },
  },
}));

import { createTokenDatabase, tokenDatabaseFromPool, TokenDatabaseError } from './tokenDatabase.js';

function fixture(owned = false) {
  const query = vi.fn().mockResolvedValue({ rows: [{ value: 1 }], rowCount: 1 });
  const release = vi.fn();
  const client = { query, release };
  const handlers = new Map<string, () => void>();
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [{ value: 2 }], rowCount: 1 }),
    connect: vi.fn().mockResolvedValue(client),
    end: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, fn: () => void) => {
      handlers.set(event, fn);
    }),
    removeListener: vi.fn((event: string) => {
      handlers.delete(event);
    }),
  };
  const db = owned
    ? tokenDatabaseFromPool(pool as unknown as Pool, 'public', true)
    : tokenDatabaseFromPool(pool as unknown as Pool);
  return { db, pool, client, query, release, handlers };
}

afterEach(() => {
  poolConstructor.mockReset();
});

describe('private native token database', () => {
  it('uses a single client and explicit read-committed transaction, then releases it', async () => {
    const f = fixture();
    const value = await f.db.transaction(async (tx) => {
      const result = await tx.query<{ value: number }>('SELECT $1::int', [1]);
      return result.rows[0]?.value;
    });
    expect(value).toBe(1);
    expect(f.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      'SELECT $1::int',
      'COMMIT',
    ]);
    expect(f.query).toHaveBeenNthCalledWith(2, 'SELECT $1::int', [1]);
    expect(f.pool.query).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('rolls back callback errors and never forwards their sensitive cause', async () => {
    const f = fixture();
    const error: unknown = await f.db
      .transaction(async () => {
        throw new Error('private digest');
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TokenDatabaseError);
    expect(String(error)).not.toContain('private digest');
    expect(error).not.toHaveProperty('cause');
    expect(f.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it.each(['connect', 'begin', 'query', 'commit', 'rollback', 'release'])(
    'fails safely at %s and handles checkout ownership',
    async (phase) => {
      const f = fixture();
      const sensitive = new Error('private digest');
      if (phase === 'connect') f.pool.connect.mockRejectedValueOnce(sensitive);
      if (phase === 'begin') f.query.mockRejectedValueOnce(sensitive);
      if (phase === 'query')
        f.query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(sensitive);
      if (phase === 'commit')
        f.query
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] })
          .mockRejectedValueOnce(sensitive);
      if (phase === 'rollback')
        f.query
          .mockResolvedValueOnce({ rows: [] })
          .mockRejectedValueOnce(sensitive)
          .mockRejectedValueOnce(sensitive);
      if (phase === 'release')
        f.release.mockImplementationOnce(() => {
          throw sensitive;
        });
      await expect(
        f.db.transaction(async (tx) => {
          await tx.query('SELECT 1');
        }),
      ).rejects.toThrow('Token database operation failed');
      if (phase === 'connect') expect(f.release).not.toHaveBeenCalled();
      else expect(f.release).toHaveBeenCalledOnce();
      if (phase === 'begin' || phase === 'rollback') expect(f.release).toHaveBeenCalledWith(true);
    },
  );

  it('supports bound standalone queries and sanitizes errors', async () => {
    const f = fixture();
    await expect(f.db.query('SELECT $1::int', [2])).resolves.toMatchObject({
      rows: [{ value: 2 }],
    });
    expect(f.pool.query).toHaveBeenCalledWith('SELECT $1::int', [2]);
    f.pool.query.mockRejectedValueOnce(new Error('private query'));
    await expect(f.db.query('SELECT 1')).rejects.toThrow('Token database operation failed');
  });

  it('closes an owned pool exactly once and rejects subsequent work', async () => {
    const f = fixture(true);
    const first = f.db.close();
    expect(f.db.close()).toBe(first);
    await first;
    expect(f.pool.end).toHaveBeenCalledOnce();
    expect(f.pool.removeListener).toHaveBeenCalledWith('error', expect.any(Function));
    await expect(f.db.query('SELECT 1')).rejects.toThrow(TokenDatabaseError);
    await expect(f.db.transaction(async () => 1)).rejects.toThrow(TokenDatabaseError);
  });

  it('leaves a borrowed pool open but closes its wrapper', async () => {
    const f = fixture();
    await f.db.close();
    await f.db.close();
    expect(f.pool.end).not.toHaveBeenCalled();
    expect(f.pool.on).not.toHaveBeenCalled();
    await expect(f.db.query('SELECT 1')).rejects.toThrow(TokenDatabaseError);
  });

  it('fails closed after idle errors and retains safe handling when close fails', async () => {
    const f = fixture(true);
    f.handlers.get('error')!();
    await expect(f.db.query('SELECT 1')).rejects.toThrow(TokenDatabaseError);
    f.pool.end.mockRejectedValueOnce(new Error('sensitive close error'));
    await expect(f.db.close()).rejects.toThrow('Token database operation failed');
    expect(f.handlers.has('error')).toBe(true);
    expect(f.pool.query).not.toHaveBeenCalled();
  });

  it('preserves an explicit socket URL, quotes namespace identifiers and opens no connection eagerly', async () => {
    const f = fixture();
    poolConstructor.mockReturnValueOnce(f.pool);
    const url =
      'postgresql://pto@socket-only.invalid/db?host=%2Fprivate%2Fsocket&schema=odd%22schema';
    const db = createTokenDatabase(url);
    expect(poolConstructor).toHaveBeenCalledWith({ connectionString: url });
    expect(db.tables.users).toBe('"odd""schema"."users"');
    expect(db.tables.tokens).toBe('"odd""schema"."personal_access_tokens"');
    expect(f.pool.connect).not.toHaveBeenCalled();
    await db.close();
  });

  it('defaults to public and sanitizes pool-construction failures', async () => {
    const f = fixture();
    poolConstructor.mockReturnValueOnce(f.pool);
    const db = createTokenDatabase('postgresql://pto@localhost/db');
    expect(db.tables.users).toBe('"public"."users"');
    await db.close();
    poolConstructor.mockImplementationOnce(() => {
      throw new Error('private connection URL');
    });
    expect(() => createTokenDatabase('postgresql://pto@localhost/db')).toThrow(
      'Token database operation failed',
    );
  });

  it.each([
    'not a URL',
    'https://example.test/db',
    'postgresql://host/db?schema=a&schema=b',
    'postgresql://host/db?schema=',
    'postgresql://host/db?schema=%00',
    `postgresql://host/db?schema=${'x'.repeat(64)}`,
  ])('rejects unsafe configuration without echoing it: %s', (url) => {
    expect(() => createTokenDatabase(url)).toThrow('Token database operation failed');
    expect(poolConstructor).not.toHaveBeenCalled();
  });
});
