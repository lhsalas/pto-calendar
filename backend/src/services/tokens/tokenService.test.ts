import { describe, expect, it, vi } from 'vitest';
import type { AuditActor } from '../audit/auditContext.js';
import { trustedOperatorActor } from '../audit/auditContext.js';
import type { TokenDatabase } from './tokenDatabase.js';
import { tokenDatabaseFromPool } from './tokenDatabase.js';
import {
  changeRoleAndInvalidate,
  issueToken,
  listTokens,
  revokeAllTokens,
  revokeToken,
  TokenOperationError,
  TokenLimitError,
  verifyToken,
} from './tokenService.js';

const result = (rows: unknown[] = [], rowCount: number | null = rows.length) => ({
  rows,
  rowCount,
});

const ACTOR: AuditActor = {
  id: 'owner',
  credential: { type: 'session' },
  requestId: 'req-token-1',
};

function fixture() {
  const owner = {
    id: 'owner',
    role: 'member' as 'member' | 'team_lead' | 'admin',
    passwordHash: 'hash' as string | null,
    sessionVersion: 4,
  };
  let record: Record<string, unknown> = {};
  const audits: Array<{ text: string; values: unknown[] }> = [];
  const statements: string[] = [];
  const lock = vi.fn(async () => result([{ ...owner }]));
  const count = vi.fn(async () => result([{ count: 0 }]));
  const insert = vi.fn(async (_text: string, values: unknown[]) => {
    record = {
      id: values[0],
      ownerId: values[1],
      name: values[2],
      displayPrefix: values[3],
      secretDigest: values[4],
      scopes: values[5],
      issuedSessionVersion: values[6],
      createdAt: new Date(String(values[7]).replace(' ', 'T') + 'Z'),
      expiresAt: new Date(String(values[8]).replace(' ', 'T') + 'Z'),
      lastUsedAt: null,
      revokedAt: null,
    };
    const { secretDigest: _digest, issuedSessionVersion: _version, ownerId: _id, ...safe } = record;
    return result([safe]);
  });
  const audit = vi.fn(async (text: string, values: unknown[]) => {
    audits.push({ text, values });
    return result([], 1);
  });
  const roleUpdate = vi.fn(async (_text: string, values: unknown[]) => {
    owner.role = values[1] as typeof owner.role;
    owner.sessionVersion += 1;
    return result([{ sessionVersion: owner.sessionVersion }], 1);
  });
  const revokeOne = vi.fn(async () => result([], 1));
  const revokeAll = vi.fn(async () => result([{ id: 'one' }, { id: 'two' }], 2));
  const own = vi.fn(async () => result([{ id: 'one' }]));
  const usage = vi.fn(async (_text: string, _values: unknown[]) => result([], 1));
  const read = vi.fn(async () =>
    result([{ ...record, ...owner, id: record.id, ownerId: owner.id }]),
  );
  const listRows: unknown[] = [];
  const list = vi.fn(async () => result(listRows));
  const txQuery = vi.fn((text: string, values: unknown[] = []) => {
    statements.push(text);
    if (text.includes('FOR UPDATE')) return lock();
    if (text.includes('COUNT(*)')) return count();
    if (text.includes('audit_logs')) return audit(text, values);
    if (text.includes('SET role')) return roleUpdate(text, values);
    if (text.includes('SET revoked_at')) {
      return text.includes('RETURNING') ? revokeAll() : revokeOne();
    }
    if (text.startsWith('SELECT id FROM')) return own();
    return insert(text, values);
  });
  const query = vi.fn((text: string, values: unknown[] = []) => {
    statements.push(text);
    if (text.includes(' JOIN ')) return read();
    if (text.includes('SET last_used_at')) return usage(text, values);
    if (text.startsWith('SELECT id FROM')) return own();
    if (text.includes('SET revoked_at') || text.includes('SET role')) return txQuery(text, values);
    return list();
  });
  const db = {
    tables: {
      users: '"public"."users"',
      tokens: '"public"."personal_access_tokens"',
      audit: '"public"."audit_logs"',
    },
    query,
    transaction: vi.fn((callback: (tx: { query: typeof txQuery }) => unknown) =>
      callback({ query: txQuery }),
    ),
  } as unknown as TokenDatabase;
  return {
    db,
    owner,
    lock,
    count,
    insert,
    audit,
    audits,
    roleUpdate,
    revokeOne,
    revokeAll,
    own,
    usage,
    txQuery,
    query,
    read,
    list,
    listRows,
    statements,
    record: () => record,
  };
}

describe('native personal token service', () => {
  it('locks the verified owner and binds count/insert data without returning credentials', async () => {
    const f = fixture();
    const issued = await issueToken(f.db, ACTOR, 4, { name: 'Laptop' });
    expect(f.db.transaction).toHaveBeenCalledOnce();
    expect(f.statements[0]).toContain('FOR UPDATE');
    expect(f.lock.mock.calls).toHaveLength(1);
    expect(f.statements[1]).toContain('issued_session_version = $2');
    expect(f.statements[1]).toContain('revoked_at IS NULL AND expires_at > $3');
    const insertCall = f.insert.mock.calls[0]!;
    const [sql, values] = insertCall;
    expect(sql).toContain('VALUES ($1::uuid, $2::uuid');
    expect(sql).toContain("AT TIME ZONE 'UTC'");
    expect(sql.split('RETURNING')[1]).not.toContain('secret_digest');
    expect(values[1]).toBe('owner');
    expect(values[6]).toBe(4);
    expect(issued.token.expiresAt.getTime() - issued.token.createdAt.getTime()).toBe(90 * 86400000);
    expect(JSON.stringify(issued.token)).not.toContain(String(values[4]));
    expect(JSON.stringify(issued.token)).not.toContain(issued.rawToken);
    expect(issued.token.id).toBe(issued.rawToken.slice(8).split('.')[0]);
  });

  it('issues an active token whose metadata carries no owner or credential field', async () => {
    const f = fixture();
    const issued = await issueToken(f.db, ACTOR, 4, { name: 'Laptop' });
    expect(issued.token.status).toBe('active');
    expect(Object.keys(issued.token).sort()).toEqual([
      'createdAt',
      'displayPrefix',
      'expiresAt',
      'id',
      'lastUsedAt',
      'name',
      'revokedAt',
      'scopes',
      'status',
    ]);
    // The insert returns only the safe base columns; the status is assembled
    // from the verified issuance, never projected from a hidden column.
    const returning = (f.insert.mock.calls[0]![0] as string).split('RETURNING')[1]!;
    expect(returning).not.toContain('secret_digest');
    expect(returning).not.toContain('status');
    expect(returning).not.toContain('owner_id');
  });

  it('writes the creation audit on the same transaction, after the token insert, with public IDs only', async () => {
    const f = fixture();
    const issued = await issueToken(f.db, ACTOR, 4, { name: 'Laptop', scopes: ['pto:read'] });
    expect(f.db.transaction).toHaveBeenCalledOnce();
    expect(f.statements.at(-1)).toContain('INSERT INTO "public"."audit_logs"');
    expect(f.statements.findIndex((s) => s.includes('audit_logs'))).toBeGreaterThan(
      f.statements.findIndex((s) => s.includes('personal_access_tokens') && s.startsWith('INSERT')),
    );
    expect(f.audits).toHaveLength(1);
    const { text, values } = f.audits[0]!;
    expect(text).toContain('(id, actor_user_id, action, entity_type, entity_id, details,');
    expect(values).toEqual([
      'owner',
      'create_personal_token',
      'personal_access_token',
      JSON.stringify({
        scopes: ['pto:read'],
        expiresAt: new Date(issued.token.expiresAt).toISOString(),
      }),
      'session',
      null,
      'owner',
      'req-token-1',
      [expect.any(String)],
      [issued.token.id],
    ]);
    const serialized = JSON.stringify(values);
    expect(serialized).not.toContain(issued.rawToken);
    expect(serialized).not.toContain(issued.rawToken.split('.')[1]!);
    expect(serialized).not.toContain('Laptop');
  });

  it('rejects stale, missing, passwordless and improperly scoped owners before insertion', async () => {
    const stale = fixture();
    await expect(issueToken(stale.db, ACTOR, 3, { name: 'Laptop' })).rejects.toBeInstanceOf(
      TokenOperationError,
    );
    const missing = fixture();
    missing.lock.mockResolvedValueOnce(result([]));
    await expect(issueToken(missing.db, ACTOR, 4, { name: 'Laptop' })).rejects.toBeInstanceOf(
      TokenOperationError,
    );
    const passwordless = fixture();
    passwordless.owner.passwordHash = null;
    await expect(issueToken(passwordless.db, ACTOR, 4, { name: 'Laptop' })).rejects.toBeInstanceOf(
      TokenOperationError,
    );
    const member = fixture();
    await expect(
      issueToken(member.db, ACTOR, 4, { name: 'Laptop', scopes: ['pto:update:team'] }),
    ).rejects.toBeInstanceOf(TokenOperationError);
    for (const f of [stale, missing, passwordless, member]) {
      expect(f.insert).not.toHaveBeenCalled();
      expect(f.audits).toHaveLength(0);
    }
  });

  it('rejects a full cap and missing count/insert results rather than issuing misleading success', async () => {
    const full = fixture();
    full.count.mockResolvedValueOnce(result([{ count: 10 }]));
    await expect(issueToken(full.db, ACTOR, 4, { name: 'Laptop' })).rejects.toBeInstanceOf(
      TokenLimitError,
    );
    expect(full.insert).not.toHaveBeenCalled();
    expect(full.audits).toHaveLength(0);
    const missingCount = fixture();
    missingCount.count.mockResolvedValueOnce(result([]));
    await expect(issueToken(missingCount.db, ACTOR, 4, { name: 'Laptop' })).rejects.toThrow(
      'Token operation failed',
    );
    const missingInsert = fixture();
    missingInsert.insert.mockResolvedValueOnce(result([]));
    await expect(issueToken(missingInsert.db, ACTOR, 4, { name: 'Laptop' })).rejects.toThrow(
      'Token operation failed',
    );
    expect(missingInsert.audits).toHaveLength(0);
  });

  it('conceals insertion errors without retaining a sensitive cause', async () => {
    const f = fixture();
    f.insert.mockRejectedValueOnce(new Error('sensitive digest and query'));
    const error: unknown = await issueToken(f.db, ACTOR, 4, { name: 'Laptop' }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TokenOperationError);
    expect(String(error)).not.toContain('sensitive');
    expect(error).not.toHaveProperty('cause');
    expect(f.audits).toHaveLength(0);
  });

  it('reads live owner credentials on every verification and guards the usage write', async () => {
    const f = fixture();
    const issued = await issueToken(f.db, ACTOR, 4, { name: 'Laptop' });
    await expect(verifyToken(f.db, issued.rawToken)).resolves.toMatchObject({
      tokenId: issued.token.id,
      ownerId: 'owner',
      scopes: ['pto:read'],
    });
    expect(f.query.mock.calls[0]?.[0]).toContain(' JOIN ');
    expect(f.query.mock.calls[1]?.[0]).toContain('u.session_version = $3');
    expect(f.query.mock.calls[1]?.[0]).toContain('u.password_hash IS NOT NULL');
    expect(f.query.mock.calls[1]?.[0]).toContain("clock_timestamp() AT TIME ZONE 'UTC'");
    f.owner.sessionVersion += 1;
    await expect(verifyToken(f.db, issued.rawToken)).resolves.toBeNull();
    expect(f.read).toHaveBeenCalledTimes(2);
  });

  it('records no audit row when verification updates last-used metadata', async () => {
    const f = fixture();
    const issued = await issueToken(f.db, ACTOR, 4, { name: 'Laptop' });
    const auditsBefore = f.audits.length;
    await expect(verifyToken(f.db, issued.rawToken)).resolves.not.toBeNull();
    expect(f.usage).toHaveBeenCalledOnce();
    expect(f.audits).toHaveLength(auditsBefore);
    expect(f.statements.some((s) => s.includes('audit_logs') && !s.includes('INSERT'))).toBe(false);
  });

  it('rejects concurrent changes observed by the guarded usage update', async () => {
    const f = fixture();
    const issued = await issueToken(f.db, ACTOR, 4, { name: 'Laptop' });
    f.usage.mockResolvedValueOnce(result([], 0));
    await expect(verifyToken(f.db, issued.rawToken)).resolves.toBeNull();
  });

  it('rejects expiry while a guarded usage write is waiting', async () => {
    const f = fixture();
    const issued = await issueToken(f.db, ACTOR, 4, { name: 'Delayed write' });
    let finish!: (value: ReturnType<typeof result>) => void;
    let entered!: () => void;
    const waiting = new Promise<ReturnType<typeof result>>((resolve) => {
      finish = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.usage.mockImplementationOnce(() => {
      entered();
      return waiting;
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(issued.token.expiresAt.getTime() - 1);
    try {
      const verification = verifyToken(f.db, issued.rawToken);
      await started;
      clock.mockReturnValue(issued.token.expiresAt.getTime());
      finish(result([], 1));
      await expect(verification).resolves.toBeNull();
    } finally {
      finish(result([], 1));
      clock.mockRestore();
    }
  });

  it('rejects malformed, missing, mismatched, revoked, expired and ineligible credentials', async () => {
    const f = fixture();
    const issued = await issueToken(f.db, ACTOR, 4, { name: 'Laptop' });
    await expect(verifyToken(f.db, 'bad')).resolves.toBeNull();
    f.read.mockResolvedValueOnce(result([]));
    await expect(verifyToken(f.db, issued.rawToken)).resolves.toBeNull();
    for (const fields of [
      { secretDigest: '0'.repeat(64) },
      { revokedAt: new Date() },
      { expiresAt: new Date(Date.now()) },
      { passwordHash: null },
    ]) {
      f.read.mockResolvedValueOnce(result([{ ...f.record(), ...f.owner, ...fields }]));
      await expect(verifyToken(f.db, issued.rawToken)).resolves.toBeNull();
    }
    f.read.mockRejectedValueOnce(new Error('sensitive database detail'));
    await expect(verifyToken(f.db, issued.rawToken)).rejects.toThrow('Token operation failed');
  });

  it('honors the exact expiry boundary and rejects team scope after live demotion', async () => {
    const f = fixture();
    f.owner.role = 'team_lead';
    const issued = await issueToken(f.db, ACTOR, 4, {
      name: 'Team',
      scopes: ['pto:update:team'],
    });
    const clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(issued.token.expiresAt.getTime() - 1);
      await expect(verifyToken(f.db, issued.rawToken)).resolves.not.toBeNull();
      clock.mockReturnValue(issued.token.expiresAt.getTime());
      await expect(verifyToken(f.db, issued.rawToken)).resolves.toBeNull();
      clock.mockReturnValue(issued.token.createdAt.getTime());
      f.owner.role = 'member';
      await expect(verifyToken(f.db, issued.rawToken)).resolves.toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it('binds owner-scoped lists and foreign/unknown rejection', async () => {
    const f = fixture();
    await expect(listTokens(f.db, 'owner')).resolves.toEqual([]);
    expect(f.query).toHaveBeenLastCalledWith(expect.stringContaining('WHERE owner_id = $1::uuid'), [
      'owner',
    ]);
    // The guarded update matches no live row and the row is not the caller's.
    f.revokeOne.mockResolvedValueOnce(result([], 0));
    f.own.mockResolvedValueOnce(result([]));
    await expect(revokeToken(f.db, ACTOR, 'foreign-or-unknown')).resolves.toBe(false);
    expect(f.audits).toHaveLength(0);
  });

  it('returns the server-computed status with the owner-scoped list and no credential column', async () => {
    const f = fixture();
    const base = {
      name: 'Laptop',
      displayPrefix: 'pto_pat_one',
      scopes: ['pto:read'],
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2026-04-01T00:00:00.000Z'),
      lastUsedAt: null,
      revokedAt: null,
    };
    f.listRows.push(
      { ...base, id: 'one', status: 'expired' },
      { ...base, id: 'two', status: 'revoked' },
      { ...base, id: 'three', status: 'invalidated' },
      { ...base, id: 'four', status: 'active' },
    );
    const listed = await listTokens(f.db, 'owner');
    expect(listed.map((token) => token.status)).toEqual([
      'expired',
      'revoked',
      'invalidated',
      'active',
    ]);
    for (const token of listed) {
      expect(Object.keys(token).sort()).toEqual([
        'createdAt',
        'displayPrefix',
        'expiresAt',
        'id',
        'lastUsedAt',
        'name',
        'revokedAt',
        'scopes',
        'status',
      ]);
    }
    // The owner selector is the only parameter, and the status is computed in
    // the same read against the quoted owner table.
    expect(f.query).toHaveBeenLastCalledWith(expect.stringContaining('WHERE owner_id = $1::uuid'), [
      'owner',
    ]);
    const sql = f.query.mock.calls[0]![0] as string;
    expect(sql).toContain('FROM "public"."users" u');
    expect(sql).toContain('u.id = owner_id');
    expect(sql).toContain('u.session_version IS DISTINCT FROM issued_session_version');
    expect(sql).toContain('u.password_hash IS NULL');
    expect(sql).toContain("u.role::text NOT IN ('team_lead', 'admin')");
    expect(sql).toContain("clock_timestamp() AT TIME ZONE 'UTC'");
    // Revoked wins over expired, which wins over invalidated.
    expect(sql.indexOf("'revoked'")).toBeLessThan(sql.indexOf("'expired'"));
    expect(sql.indexOf("'expired'")).toBeLessThan(sql.indexOf("'invalidated'"));
    expect(sql.indexOf("'invalidated'")).toBeLessThan(sql.indexOf("'active'"));
    // No credential column is projected, and no second query is issued.
    expect(sql).not.toContain('secret_digest');
    expect(sql).not.toContain('AS "passwordHash"');
    expect(sql).not.toContain('AS "sessionVersion"');
    expect(sql).not.toContain('AS "ownerId"');
    expect(sql).not.toContain('AS "secretDigest"');
    expect(f.query).toHaveBeenCalledOnce();
  });

  it('revokes one own token with a single audit row, and treats a repeat as an idempotent no-op', async () => {
    const f = fixture();
    await expect(revokeToken(f.db, ACTOR, 'one')).resolves.toBe(true);
    expect(f.db.transaction).toHaveBeenCalledOnce();
    expect(f.statements[0]).toContain('owner_id = $2::uuid AND revoked_at IS NULL');
    expect(f.audits).toHaveLength(1);
    expect(f.audits[0]!.values).toEqual([
      'owner',
      'revoke_personal_token',
      'personal_access_token',
      JSON.stringify({ bulk: false }),
      'session',
      null,
      'owner',
      'req-token-1',
      [expect.any(String)],
      ['one'],
    ]);
    // A repeated own revocation matches no live row, so it must not write again.
    f.revokeOne.mockResolvedValueOnce(result([], 0));
    await expect(revokeToken(f.db, ACTOR, 'one')).resolves.toBe(true);
    expect(f.audits).toHaveLength(1);
    expect(f.statements.at(-1)).toContain('SELECT id FROM');
  });

  it('writes no audit for a foreign or unknown token even when the owner is otherwise valid', async () => {
    const f = fixture();
    f.revokeOne.mockResolvedValueOnce(result([], 0));
    f.own.mockResolvedValueOnce(result([]));
    await expect(revokeToken(f.db, ACTOR, 'foreign-or-unknown')).resolves.toBe(false);
    expect(f.audits).toHaveLength(0);
  });

  it('revokes all active tokens with one public-ID audit row per changed token', async () => {
    const f = fixture();
    await expect(revokeAllTokens(f.db, ACTOR)).resolves.toBe(2);
    expect(f.statements[0]).toContain('RETURNING id::text AS id');
    expect(f.audits).toHaveLength(1);
    expect(f.audits[0]!.values).toEqual([
      'owner',
      'revoke_personal_token',
      'personal_access_token',
      JSON.stringify({ bulk: true }),
      'session',
      null,
      'owner',
      'req-token-1',
      [expect.any(String), expect.any(String)],
      ['one', 'two'],
    ]);
    const serialized = JSON.stringify(f.audits[0]!.values);
    expect(serialized).not.toMatch(/pto_pat_|secret|digest/i);
  });

  it('writes no audit when revoke-all changes nothing, including a race that matched no rows', async () => {
    const f = fixture();
    f.revokeAll.mockResolvedValueOnce(result([], 0));
    await expect(revokeAllTokens(f.db, ACTOR)).resolves.toBe(0);
    expect(f.audits).toHaveLength(0);
  });

  it('rejects an inconsistent revoke-all driver result instead of guessing which tokens changed', async () => {
    const f = fixture();
    f.revokeAll.mockResolvedValueOnce(result([{ id: 'one' }], 2));
    await expect(revokeAllTokens(f.db, ACTOR)).rejects.toThrow('Token operation failed');
    f.revokeAll.mockResolvedValueOnce(result([], null));
    await expect(revokeAllTokens(f.db, ACTOR)).rejects.toThrow('Token operation failed');
    expect(f.audits).toHaveLength(0);
  });

  it('atomically changes role/version with a trusted operator audit, rejects missing owners, and conceals operation errors', async () => {
    const f = fixture();
    const operator = trustedOperatorActor('operator-user');
    await changeRoleAndInvalidate(f.db, 'owner', 'member', operator);
    expect(f.db.transaction).toHaveBeenCalledOnce();
    expect(f.statements[0]).toContain('FOR UPDATE');
    expect(f.roleUpdate).toHaveBeenCalledWith(
      expect.stringContaining('session_version = session_version + 1'),
      ['owner', 'member'],
    );
    expect(f.audits).toHaveLength(1);
    expect(f.audits[0]!.values).toEqual([
      'operator-user',
      'change_user_role',
      'user',
      JSON.stringify({ fromRole: 'member', toRole: 'member', sessionVersion: 5 }),
      'operator',
      null,
      'owner',
      null,
      [expect.any(String)],
      ['owner'],
    ]);
    f.lock.mockResolvedValueOnce(result([]));
    await expect(changeRoleAndInvalidate(f.db, 'owner', 'admin', operator)).rejects.toThrow(
      'Token operation failed',
    );
    f.roleUpdate.mockResolvedValueOnce(result([], 0));
    await expect(changeRoleAndInvalidate(f.db, 'owner', 'admin', operator)).rejects.toThrow(
      'Token operation failed',
    );
    f.roleUpdate.mockResolvedValueOnce(result([], 1));
    await expect(changeRoleAndInvalidate(f.db, 'owner', 'admin', operator)).rejects.toThrow(
      'Token operation failed',
    );
    expect(f.audits).toHaveLength(1);
    f.roleUpdate.mockRejectedValue(new Error('sensitive driver detail'));
    await expect(changeRoleAndInvalidate(f.db, 'owner', 'admin', operator)).rejects.toThrow(
      'Token operation failed',
    );
    await expect(revokeToken(f.db, ACTOR, 'one')).resolves.toBe(true);
    f.revokeOne.mockRejectedValueOnce(new Error('sensitive driver detail'));
    await expect(revokeToken(f.db, ACTOR, 'one')).rejects.toThrow('Token operation failed');
    f.revokeAll.mockRejectedValueOnce(new Error('sensitive driver detail'));
    await expect(revokeAllTokens(f.db, ACTOR)).rejects.toThrow('Token operation failed');
    f.list.mockRejectedValueOnce(new Error('sensitive driver detail'));
    await expect(listTokens(f.db, 'owner')).rejects.toThrow('Token operation failed');
  });
});

describe('audit writes share the native transaction boundary', () => {
  /** Fake pg client that records statements and fails at a chosen SQL fragment. */
  function pooled(failOn?: string) {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        statements.push(text);
        if (failOn && text.includes(failOn)) throw new Error('synthetic failure');
        if (text.includes('FOR UPDATE')) {
          return result([{ id: 'owner', role: 'member', passwordHash: 'hash', sessionVersion: 4 }]);
        }
        if (text.includes('COUNT(*)')) return result([{ count: 0 }]);
        if (text.startsWith('INSERT INTO "public"."personal_access_tokens"')) {
          return result([
            {
              id: 'token-id',
              name: 'Laptop',
              displayPrefix: 'pto_pat_token-id',
              scopes: ['pto:read'],
              createdAt: new Date(),
              expiresAt: new Date(Date.now() + 86400000),
              lastUsedAt: null,
              revokedAt: null,
            },
          ]);
        }
        return result([], 1);
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    return { db: tokenDatabaseFromPool(pool as never), statements, client };
  }

  it('rolls back the token insert when its audit row cannot be written', async () => {
    const f = pooled('INSERT INTO "public"."audit_logs"');
    await expect(issueToken(f.db, ACTOR, 4, { name: 'Laptop' })).rejects.toThrow(
      'Token operation failed',
    );
    expect(f.statements).toContain('BEGIN ISOLATION LEVEL READ COMMITTED');
    expect(
      f.statements.some((s) => s.startsWith('INSERT INTO "public"."personal_access_tokens"')),
    ).toBe(true);
    expect(f.statements).toContain('ROLLBACK');
    expect(f.statements).not.toContain('COMMIT');
    expect(f.client.release).toHaveBeenCalledWith(false);
  });

  it('commits the token insert and its audit row together on success', async () => {
    const f = pooled();
    await expect(issueToken(f.db, ACTOR, 4, { name: 'Laptop' })).resolves.toMatchObject({
      token: { id: 'token-id' },
    });
    const audit = f.statements.findIndex((s) => s.includes('audit_logs'));
    expect(audit).toBeGreaterThan(-1);
    expect(f.statements.indexOf('COMMIT')).toBeGreaterThan(audit);
    expect(f.statements).not.toContain('ROLLBACK');
  });
});
