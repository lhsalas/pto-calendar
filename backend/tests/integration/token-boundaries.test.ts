import { randomUUID } from 'node:crypto';
import type { Pool, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { trustedOperatorActor, type AuditActor } from '../../src/services/audit/auditContext.js';
import {
  createTokenDatabase,
  TokenDatabaseError,
  tokenDatabaseFromPool,
} from '../../src/services/tokens/tokenDatabase.js';
import {
  parseToken,
  tokenDigestMatches,
  tokenExpiry,
  TokenInputError,
} from '../../src/services/tokens/tokenDomain.js';
import {
  changeRoleAndInvalidate,
  issueToken,
  listTokens,
  revokeAllTokens,
  TokenOperationError,
  verifyToken,
} from '../../src/services/tokens/tokenService.js';

const ACTOR: AuditActor = {
  id: '00000000-0000-4000-8000-000000000001',
  credential: { type: 'session' },
  requestId: 'token-boundary-integration',
};
const OPERATOR = trustedOperatorActor('00000000-0000-4000-8000-000000000002');

const TABLES = {
  users: '"public"."users"',
  tokens: '"public"."personal_access_tokens"',
  audit: '"public"."audit_logs"',
} as const;

const OWNER = {
  id: ACTOR.id,
  role: 'member' as const,
  passwordHash: 'synthetic-password-hash',
  sessionVersion: 0,
};

interface Answer {
  rows: unknown[];
  rowCount: number | null;
}

type Router = (text: string, values: unknown[]) => Answer | undefined;

interface Statement {
  text: string;
  values: unknown[];
}

function answer(rows: unknown[] = [], rowCount: number | null = rows.length): Answer {
  return { rows, rowCount };
}

function result<R extends QueryResultRow>(value: Answer): QueryResult<R> {
  return {
    command: '',
    oid: 0,
    fields: [],
    rows: value.rows as R[],
    rowCount: value.rowCount,
  };
}

/**
 * A scripted pg driver underneath the real tokenDatabaseFromPool boundary.
 * Driver statements are answered as driver statements; only business SQL is
 * routed. Every checkout and release is recorded so a refusal can be proven to
 * have rolled back on the real wrapper rather than in this double.
 */
function scriptedBoundary(router: Router) {
  const statements: Statement[] = [];
  const audits: Statement[] = [];
  let checkouts = 0;

  const dispatch = async <R extends QueryResultRow>(
    text: string,
    values: unknown[],
    source: 'client' | 'pool',
  ): Promise<QueryResult<R>> => {
    statements.push({ text, values });
    if (source === 'client') {
      if (
        text === 'BEGIN ISOLATION LEVEL READ COMMITTED' ||
        text === 'COMMIT' ||
        text === 'ROLLBACK'
      ) {
        return result<R>(answer());
      }
      if (text.includes('INSERT INTO "public"."audit_logs"')) {
        audits.push({ text, values });
        return result<R>(answer([], 1));
      }
    }
    const scripted = router(text, values);
    if (!scripted) throw new Error(`Unexpected synthetic query: ${text}`);
    return result<R>(scripted);
  };

  const poolQuery = vi.fn((text: string, values: unknown[] = []) =>
    dispatch<QueryResultRow>(text, values, 'pool'),
  );
  const clientQuery = vi.fn((text: string, values: unknown[] = []) =>
    dispatch<QueryResultRow>(text, values, 'client'),
  );
  const release = vi.fn();
  const client = { query: clientQuery, release };
  const pool = {
    query: poolQuery,
    connect: vi.fn(async () => {
      checkouts += 1;
      return client;
    }),
    end: vi.fn(async () => undefined),
    on: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as Pool;

  return {
    db: tokenDatabaseFromPool(pool),
    poolQuery,
    release,
    statements,
    audits,
    checkouts: () => checkouts,
  };
}

type ScriptedBoundary = ReturnType<typeof scriptedBoundary>;

function expectDiscarded(boundary: ScriptedBoundary, times: number): void {
  expect(boundary.release).toHaveBeenCalledTimes(times);
  expect(boundary.release.mock.calls.map(([discard]) => discard)).toEqual(
    Array.from({ length: times }, () => false),
  );
}

function expectRolledBackOnce(boundary: ScriptedBoundary): void {
  expect(
    boundary.statements.filter(
      (statement) => statement.text === 'BEGIN ISOLATION LEVEL READ COMMITTED',
    ),
  ).toHaveLength(1);
  expect(boundary.statements.filter((statement) => statement.text === 'ROLLBACK')).toHaveLength(1);
  expect(boundary.statements.filter((statement) => statement.text === 'COMMIT')).toEqual([]);
  expectDiscarded(boundary, 1);
  expect(boundary.checkouts()).toBe(1);
  expect(boundary.audits).toEqual([]);
}

interface FakeClient {
  query: (text: string, values?: unknown[]) => Promise<QueryResult<QueryResultRow>>;
  release: (discard?: boolean) => void;
}

function fakePool(client: FakeClient) {
  const connect = vi.fn(async () => client);
  return {
    connect,
    pool: {
      query: vi.fn(),
      connect,
      end: vi.fn(async () => undefined),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as Pool,
  };
}

describe('token database connection boundaries', () => {
  it('rejects unsafe protocols and namespace identifiers before opening a pool', () => {
    const inputs = [
      'not a database url',
      'https://example.test/pto_test',
      'postgresql://pto@127.0.0.1:9/pto_test?schema=',
      'postgresql://pto@127.0.0.1:9/pto_test?schema=%00',
      `postgresql://pto@127.0.0.1:9/pto_test?schema=${'x'.repeat(64)}`,
      'postgresql://pto@127.0.0.1:9/pto_test?schema=one&schema=two',
    ];
    for (const input of inputs) {
      let thrown: unknown;
      try {
        createTokenDatabase(input);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TokenDatabaseError);
      expect(thrown).toMatchObject({
        name: 'TokenDatabaseError',
        message: 'Token database operation failed',
      });
      expect(thrown).not.toHaveProperty('cause');
      expect(String(thrown)).not.toContain(input);
    }
  });

  it('defaults a bare PostgreSQL URL to public, opens nothing eagerly and closes once', async () => {
    // pg.Pool is lazy: constructing and ending it opens no socket, so this
    // placeholder port is never contacted.
    const db = createTokenDatabase('postgresql://pto@127.0.0.1:9/pto_test');
    expect(db.tables).toEqual(TABLES);
    const closing = db.close();
    expect(db.close()).toBe(closing);
    await closing;
  });

  it('borrows a caller-owned pool without ending it and refuses work after close', async () => {
    const query = vi.fn(async () => result<{ value: number }>(answer([{ value: 7 }], 1)));
    const end = vi.fn(async () => undefined);
    const on = vi.fn();
    const removeListener = vi.fn();
    const pool = { query, connect: vi.fn(), end, on, removeListener } as unknown as Pool;
    const db = tokenDatabaseFromPool(pool, 'tenant');

    await expect(
      db.query<{ value: number }>('SELECT $1::int AS value', [7]),
    ).resolves.toMatchObject({ rows: [{ value: 7 }] });
    expect(query).toHaveBeenCalledWith('SELECT $1::int AS value', [7]);
    expect(db.tables.users).toBe('"tenant"."users"');

    const closing = db.close();
    expect(db.close()).toBe(closing);
    await closing;
    expect(on).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    expect(removeListener).not.toHaveBeenCalled();
    await expect(db.query('SELECT 1')).rejects.toBeInstanceOf(TokenDatabaseError);
    await expect(db.transaction(async () => 1)).rejects.toBeInstanceOf(TokenDatabaseError);
  });

  it('fails closed after an owned pool reports an idle error rather than reusing it', async () => {
    let idle: (() => void) | undefined;
    const query = vi.fn(async () => result<QueryResultRow>(answer()));
    const pool = {
      query,
      connect: vi.fn(),
      end: vi.fn(async () => undefined),
      on: vi.fn((_event: string, handler: () => void) => {
        idle = handler;
      }),
      removeListener: vi.fn(),
    } as unknown as Pool;
    const db = tokenDatabaseFromPool(pool, 'public', true);

    expect(idle).toBeTypeOf('function');
    idle!();
    await expect(db.query('SELECT 1')).rejects.toBeInstanceOf(TokenDatabaseError);
    await expect(db.transaction(async () => 1)).rejects.toBeInstanceOf(TokenDatabaseError);
    expect(query).not.toHaveBeenCalled();

    await db.close();
    expect(pool.removeListener).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('sanitizes an owned pool close failure and remains fail-closed', async () => {
    const secret = 'postgresql://synthetic-owner:secret@127.0.0.1:9/pto_test';
    const pool = {
      query: vi.fn(),
      connect: vi.fn(),
      end: vi.fn(async () => {
        throw new Error(secret);
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as Pool;
    const db = tokenDatabaseFromPool(pool, 'public', true);

    const closing = db.close();
    const error = await closing.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TokenDatabaseError);
    expect(String(error)).not.toContain(secret);
    expect(error).not.toHaveProperty('cause');
    expect(pool.removeListener).not.toHaveBeenCalled();
    await expect(db.query('SELECT 1')).rejects.toBeInstanceOf(TokenDatabaseError);
    await expect(db.close()).rejects.toBeInstanceOf(TokenDatabaseError);
  });

  it('sanitizes checkout, begin, rollback and release failures without leaking driver text', async () => {
    const phases = ['connect', 'begin', 'operation', 'rollback', 'commit', 'release'] as const;
    for (const phase of phases) {
      const secret = `synthetic-${phase}-secret`;
      const statements: string[] = [];
      const client = {
        query: vi.fn(async (text: string) => {
          statements.push(text);
          if (text.startsWith('BEGIN') && phase === 'begin') throw new Error(secret);
          if (text === 'ROLLBACK' && phase === 'rollback') throw new Error(secret);
          if (text === 'COMMIT' && phase === 'commit') throw new Error(secret);
          if (text === 'SELECT 1' && (phase === 'operation' || phase === 'rollback'))
            throw new Error(secret);
          return result<QueryResultRow>(answer());
        }),
        release: vi.fn(),
      };
      const { pool, connect } = fakePool(client);
      if (phase === 'connect') {
        connect.mockRejectedValueOnce(new Error(secret));
      }
      if (phase === 'release') {
        client.release.mockImplementationOnce(() => {
          throw new Error(secret);
        });
      }
      const db = tokenDatabaseFromPool(pool);

      const error = await db.transaction(async (tx) => tx.query('SELECT 1')).catch((e) => e);
      expect(error, phase).toBeInstanceOf(TokenDatabaseError);
      expect(String(error)).not.toContain(secret);
      expect(error).not.toHaveProperty('cause');

      if (phase === 'connect') {
        expect(client.release).not.toHaveBeenCalled();
        expect(statements).toEqual([]);
        continue;
      }
      expect(statements).toContain('BEGIN ISOLATION LEVEL READ COMMITTED');
      if (phase === 'begin') {
        expect(statements).not.toContain('ROLLBACK');
        expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
      } else if (phase === 'rollback') {
        expect(statements).toContain('ROLLBACK');
        expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
      } else {
        expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
      }
    }
  });
});

describe('token domain rejection at the service boundary', () => {
  it('rejects malformed token names before starting a transaction', async () => {
    const harness = scriptedBoundary(() => undefined);
    const names: unknown[] = [null, 42, '', ' leading', 'trailing ', 'x'.repeat(121), ['name']];
    for (const name of names) {
      const error = await issueToken(harness.db, ACTOR, 0, { name }).catch((thrown) => thrown);
      expect(error).toBeInstanceOf(TokenInputError);
      expect(error).toMatchObject({ message: 'Invalid token input' });
      expect(String(error)).toBe('TokenInputError: Invalid token input');
    }
    expect(harness.statements).toEqual([]);
    expect(harness.audits).toEqual([]);
    expect(harness.checkouts()).toBe(0);
    expect(harness.poolQuery).not.toHaveBeenCalled();
    expect(harness.release).not.toHaveBeenCalled();
  });

  it('refuses ineligible scopes and lifetimes inside the owner-locked transaction', async () => {
    const harness = scriptedBoundary((text) => {
      if (text.includes('FOR UPDATE')) return answer([OWNER]);
      if (text.includes('COUNT(*)')) return answer([{ count: 0 }]);
      return undefined;
    });
    const attempts: Array<{ scopes?: unknown; expiresInDays?: unknown }> = [
      { scopes: [] },
      { scopes: 'pto:read' },
      { scopes: ['unknown'] },
      { scopes: ['pto:read', 'pto:read'] },
      { scopes: ['pto:notes:read'] },
      { scopes: ['pto:update:team'] },
      { expiresInDays: 0 },
      { expiresInDays: 366 },
      { expiresInDays: 1.5 },
    ];
    for (const attempt of attempts) {
      const error = await issueToken(harness.db, ACTOR, 0, {
        name: 'Boundary token',
        ...attempt,
      }).catch((thrown) => thrown);
      expect(error).toBeInstanceOf(TokenOperationError);
      expect(error).toMatchObject({ message: 'Token operation failed' });
      expect(String(error)).not.toContain('Boundary token');
    }
    expect(harness.statements.filter((statement) => statement.text === 'COMMIT')).toEqual([]);
    expect(
      harness.statements.filter(
        (statement) => statement.text === 'BEGIN ISOLATION LEVEL READ COMMITTED',
      ),
    ).toHaveLength(attempts.length);
    expect(harness.statements.filter((statement) => statement.text === 'ROLLBACK')).toHaveLength(
      attempts.length,
    );
    expect(
      harness.statements.filter((statement) => statement.text.includes('FOR UPDATE')),
    ).toHaveLength(attempts.length);
    expect(
      harness.statements.filter((statement) => statement.text.includes('COUNT(*)')),
    ).toHaveLength(0);
    expect(
      harness.statements.some((statement) =>
        statement.text.includes('INSERT INTO "public"."personal_access_tokens"'),
      ),
    ).toBe(false);
    expect(harness.audits).toEqual([]);
    expect(harness.checkouts()).toBe(attempts.length);
    expectDiscarded(harness, attempts.length);
    expect(harness.poolQuery).not.toHaveBeenCalled();
  });

  it('rejects lifetimes that leave the representable Date range', () => {
    expect(() => tokenExpiry(new Date(8_640_000_000_000_000), 1)).toThrow(TokenInputError);
    expect(() => tokenExpiry(new Date(Number.NaN), 1)).toThrow(TokenInputError);
  });

  it('rejects malformed credentials and stored digests before granting authority', async () => {
    const malformedRaw = 'pto_pat_not-a-canonical-credential';
    expect(parseToken(malformedRaw)).toBeNull();
    const unread = scriptedBoundary(() => undefined);
    await expect(verifyToken(unread.db, malformedRaw)).resolves.toBeNull();
    expect(unread.statements).toEqual([]);
    expect(unread.checkouts()).toBe(0);
    expect(unread.poolQuery).not.toHaveBeenCalled();
    expect(unread.release).not.toHaveBeenCalled();

    const raw = `pto_pat_${randomUUID()}.${'a'.repeat(64)}`;
    const corrupt = scriptedBoundary((text) => {
      if (!text.includes(' JOIN ')) return undefined;
      return answer([
        {
          id: randomUUID(),
          ownerId: ACTOR.id,
          secretDigest: 'synthetic-digest',
          scopes: ['pto:read'],
          expiresAt: new Date(Date.now() + 60_000),
          revokedAt: null,
          passwordHash: 'synthetic-password-hash',
          sessionVersion: 0,
          issuedSessionVersion: 0,
          role: 'member',
        },
      ]);
    });
    await expect(verifyToken(corrupt.db, raw)).resolves.toBeNull();
    expect(corrupt.statements).toHaveLength(1);
    expect(corrupt.poolQuery).toHaveBeenCalledTimes(1);
    expect(corrupt.checkouts()).toBe(0);
    expect(corrupt.release).not.toHaveBeenCalled();
    expect(
      corrupt.statements.some((statement) => statement.text.includes('SET last_used_at')),
    ).toBe(false);
    expect(tokenDigestMatches('bad', 'a'.repeat(64))).toBe(false);
    expect(tokenDigestMatches('a'.repeat(64), 'bad')).toBe(false);
  });
});

describe('token service database inconsistency boundaries', () => {
  it('fails closed when the active-count or insert read returns no row', async () => {
    const missingCount = scriptedBoundary((text) => {
      if (text.includes('FOR UPDATE')) return answer([OWNER]);
      if (text.includes('COUNT(*)')) return answer([]);
      return undefined;
    });
    const countError = await issueToken(missingCount.db, ACTOR, 0, { name: 'No count' }).catch(
      (thrown) => thrown,
    );
    expect(countError).toBeInstanceOf(TokenOperationError);
    expectRolledBackOnce(missingCount);
    expect(missingCount.statements.at(-1)?.text).toBe('ROLLBACK');
    expect(missingCount.statements.some((statement) => statement.text.includes('FOR UPDATE'))).toBe(
      true,
    );
    expect(missingCount.statements.some((statement) => statement.text.includes('COUNT(*)'))).toBe(
      true,
    );
    expect(
      missingCount.statements.some((statement) =>
        statement.text.includes('INSERT INTO "public"."personal_access_tokens"'),
      ),
    ).toBe(false);
    expect(missingCount.poolQuery).not.toHaveBeenCalled();

    const missingInsert = scriptedBoundary((text) => {
      if (text.includes('FOR UPDATE')) return answer([OWNER]);
      if (text.includes('COUNT(*)')) return answer([{ count: 0 }]);
      if (text.includes('INSERT INTO "public"."personal_access_tokens"')) return answer([]);
      return undefined;
    });
    const insertError = await issueToken(missingInsert.db, ACTOR, 0, { name: 'No insert' }).catch(
      (thrown) => thrown,
    );
    expect(insertError).toBeInstanceOf(TokenOperationError);
    expectRolledBackOnce(missingInsert);
    expect(missingInsert.statements.at(-1)?.text).toBe('ROLLBACK');
    expect(
      missingInsert.statements.some((statement) => statement.text.includes('FOR UPDATE')),
    ).toBe(true);
    expect(missingInsert.statements.some((statement) => statement.text.includes('COUNT(*)'))).toBe(
      true,
    );
    expect(
      missingInsert.statements.some((statement) =>
        statement.text.includes('INSERT INTO "public"."personal_access_tokens"'),
      ),
    ).toBe(true);
    expect(missingInsert.poolQuery).not.toHaveBeenCalled();
  });

  it('rejects inconsistent bulk revocation results and sanitizes driver failures', async () => {
    for (const inconsistent of [answer([{ id: 'one' }], 2), answer([], null)]) {
      const harness = scriptedBoundary((text) =>
        text.includes('SET revoked_at') ? inconsistent : undefined,
      );
      const error = await revokeAllTokens(harness.db, ACTOR).catch((thrown) => thrown);
      expect(error).toBeInstanceOf(TokenOperationError);
      expectRolledBackOnce(harness);
      expect(harness.statements.at(-1)?.text).toBe('ROLLBACK');
      expect(
        harness.statements.some((statement) => statement.text.includes('SET revoked_at')),
      ).toBe(true);
      expect(harness.poolQuery).not.toHaveBeenCalled();
    }

    const failed = scriptedBoundary((text) => {
      if (text.includes('SET revoked_at')) throw new Error('synthetic-revoke-secret');
      return undefined;
    });
    const error = await revokeAllTokens(failed.db, ACTOR).catch((thrown) => thrown);
    expect(error).toBeInstanceOf(TokenOperationError);
    expect(String(error)).not.toContain('synthetic-revoke-secret');
    expect(error).not.toHaveProperty('cause');
    expectRolledBackOnce(failed);
    expect(failed.statements.at(-1)?.text).toBe('ROLLBACK');
    expect(failed.poolQuery).not.toHaveBeenCalled();
  });

  it('refuses role invalidation when the owner or updated version is absent', async () => {
    const missingOwner = scriptedBoundary((text) =>
      text.includes('FOR UPDATE') ? answer([]) : undefined,
    );
    const ownerError = await changeRoleAndInvalidate(
      missingOwner.db,
      ACTOR.id,
      'admin',
      OPERATOR,
    ).catch((thrown) => thrown);
    expect(ownerError).toBeInstanceOf(TokenOperationError);
    expectRolledBackOnce(missingOwner);
    expect(missingOwner.statements.at(-1)?.text).toBe('ROLLBACK');
    expect(missingOwner.statements.some((statement) => statement.text.includes('FOR UPDATE'))).toBe(
      true,
    );
    expect(missingOwner.poolQuery).not.toHaveBeenCalled();

    for (const update of [answer([], 0), answer([], 1)]) {
      const harness = scriptedBoundary((text) => {
        if (text.includes('FOR UPDATE')) return answer([{ role: 'member' }]);
        if (text.includes('SET role')) return update;
        return undefined;
      });
      const error = await changeRoleAndInvalidate(harness.db, ACTOR.id, 'admin', OPERATOR).catch(
        (thrown) => thrown,
      );
      expect(error).toBeInstanceOf(TokenOperationError);
      expectRolledBackOnce(harness);
      expect(harness.statements.at(-1)?.text).toBe('ROLLBACK');
      expect(harness.statements.some((statement) => statement.text.includes('SET role'))).toBe(
        true,
      );
      expect(harness.poolQuery).not.toHaveBeenCalled();
    }
  });

  it('conceals list failures without exposing driver details', async () => {
    const harness = scriptedBoundary((text) => {
      if (text.includes('FROM "public"."personal_access_tokens"')) {
        throw new Error('synthetic-list-secret');
      }
      return undefined;
    });
    const error = await listTokens(harness.db, ACTOR.id).catch((thrown) => thrown);
    expect(error).toBeInstanceOf(TokenOperationError);
    expect(error).toMatchObject({ message: 'Token operation failed' });
    expect(String(error)).not.toContain('synthetic-list-secret');
    expect(error).not.toHaveProperty('cause');
    expect(harness.statements).toHaveLength(1);
    expect(harness.statements[0]?.text).toContain('FROM "public"."personal_access_tokens"');
    expect(harness.poolQuery).toHaveBeenCalledTimes(1);
    expect(harness.checkouts()).toBe(0);
    expect(harness.release).not.toHaveBeenCalled();
    expect(harness.audits).toEqual([]);
  });
});
