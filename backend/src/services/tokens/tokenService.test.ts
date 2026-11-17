import { describe, expect, it, vi } from 'vitest';
import type { TokenDatabase } from './tokenDatabase.js';
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

function fixture() {
  const owner = {
    id: 'owner',
    role: 'member',
    passwordHash: 'hash' as string | null,
    sessionVersion: 4,
  };
  let record: Record<string, unknown> = {};
  const lock = vi.fn(async () => result([owner]));
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
  const txQuery = vi.fn((text: string, values: unknown[] = []) => {
    if (text.includes('FOR UPDATE')) return lock();
    if (text.includes('COUNT(*)')) return count();
    return insert(text, values);
  });
  const read = vi.fn(async () =>
    result([{ ...record, ...owner, id: record.id, ownerId: owner.id }]),
  );
  const update = vi.fn(async () => result([], 1));
  const own = vi.fn(async () => result([{ id: 'one' }]));
  const list = vi.fn(async () => result([]));
  const query = vi.fn((text: string) => {
    if (text.includes(' JOIN ')) return read();
    if (text.trimStart().startsWith('UPDATE')) return update();
    if (text.startsWith('SELECT id FROM')) return own();
    return list();
  });
  const db = {
    tables: { users: '"public"."users"', tokens: '"public"."personal_access_tokens"' },
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
    txQuery,
    query,
    read,
    update,
    own,
    list,
    record: () => record,
  };
}

describe('native personal token service', () => {
  it('locks the verified owner and binds count/insert data without returning credentials', async () => {
    const f = fixture();
    const issued = await issueToken(f.db, 'owner', 4, { name: 'Laptop' });
    expect(f.db.transaction).toHaveBeenCalledOnce();
    expect(f.txQuery.mock.calls[0]?.[0]).toContain('FOR UPDATE');
    expect(f.txQuery.mock.calls[0]?.[1]).toEqual(['owner']);
    expect(f.txQuery.mock.calls[1]?.[0]).toContain('issued_session_version = $2');
    expect(f.txQuery.mock.calls[1]?.[0]).toContain('revoked_at IS NULL AND expires_at > $3');
    expect(f.txQuery.mock.calls[1]?.[1]).toEqual(['owner', 4, expect.any(String)]);
    const [sql, values] = f.insert.mock.calls[0]!;
    expect(sql).toContain('VALUES ($1::uuid, $2::uuid');
    expect(sql).toContain("AT TIME ZONE 'UTC'");
    expect(sql.split('RETURNING')[1]).not.toContain('secret_digest');
    expect(values[6]).toBe(4);
    expect(issued.token.expiresAt.getTime() - issued.token.createdAt.getTime()).toBe(90 * 86400000);
    expect(JSON.stringify(issued.token)).not.toContain(String(values[4]));
    expect(JSON.stringify(issued.token)).not.toContain(issued.rawToken);
    expect(issued.token.id).toBe(issued.rawToken.slice(8).split('.')[0]);
  });

  it('rejects stale, missing, passwordless and improperly scoped owners before insertion', async () => {
    const stale = fixture();
    await expect(issueToken(stale.db, 'owner', 3, { name: 'Laptop' })).rejects.toBeInstanceOf(
      TokenOperationError,
    );
    const missing = fixture();
    missing.lock.mockResolvedValueOnce(result([]));
    await expect(issueToken(missing.db, 'owner', 4, { name: 'Laptop' })).rejects.toBeInstanceOf(
      TokenOperationError,
    );
    const passwordless = fixture();
    passwordless.owner.passwordHash = null;
    await expect(
      issueToken(passwordless.db, 'owner', 4, { name: 'Laptop' }),
    ).rejects.toBeInstanceOf(TokenOperationError);
    const member = fixture();
    await expect(
      issueToken(member.db, 'owner', 4, { name: 'Laptop', scopes: ['pto:update:team'] }),
    ).rejects.toBeInstanceOf(TokenOperationError);
    for (const f of [stale, missing, passwordless, member]) expect(f.insert).not.toHaveBeenCalled();
  });

  it('rejects a full cap and missing count/insert results rather than issuing misleading success', async () => {
    const full = fixture();
    full.count.mockResolvedValueOnce(result([{ count: 10 }]));
    await expect(issueToken(full.db, 'owner', 4, { name: 'Laptop' })).rejects.toBeInstanceOf(
      TokenLimitError,
    );
    expect(full.insert).not.toHaveBeenCalled();
    const missingCount = fixture();
    missingCount.count.mockResolvedValueOnce(result([]));
    await expect(issueToken(missingCount.db, 'owner', 4, { name: 'Laptop' })).rejects.toThrow(
      'Token operation failed',
    );
    const missingInsert = fixture();
    missingInsert.insert.mockResolvedValueOnce(result([]));
    await expect(issueToken(missingInsert.db, 'owner', 4, { name: 'Laptop' })).rejects.toThrow(
      'Token operation failed',
    );
  });

  it('conceals insertion errors without retaining a sensitive cause', async () => {
    const f = fixture();
    f.insert.mockRejectedValueOnce(new Error('sensitive digest and query'));
    const error: unknown = await issueToken(f.db, 'owner', 4, { name: 'Laptop' }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TokenOperationError);
    expect(String(error)).not.toContain('sensitive');
    expect(error).not.toHaveProperty('cause');
  });

  it('reads live owner credentials on every verification and guards the usage write', async () => {
    const f = fixture();
    const issued = await issueToken(f.db, 'owner', 4, { name: 'Laptop' });
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

  it('rejects concurrent changes observed by the guarded usage update', async () => {
    const f = fixture();
    const issued = await issueToken(f.db, 'owner', 4, { name: 'Laptop' });
    f.update.mockResolvedValueOnce(result([], 0));
    await expect(verifyToken(f.db, issued.rawToken)).resolves.toBeNull();
  });

  it('rejects expiry while a guarded usage write is waiting', async () => {
    const f = fixture();
    const issued = await issueToken(f.db, 'owner', 4, { name: 'Delayed write' });
    let finish!: (value: ReturnType<typeof result>) => void;
    let entered!: () => void;
    const waiting = new Promise<ReturnType<typeof result>>((resolve) => {
      finish = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.update.mockImplementationOnce(() => {
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
    const issued = await issueToken(f.db, 'owner', 4, { name: 'Laptop' });
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
    const issued = await issueToken(f.db, 'owner', 4, {
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

  it('binds owner-scoped lists, new/repeated revocations and foreign/unknown rejection', async () => {
    const f = fixture();
    await expect(listTokens(f.db, 'owner')).resolves.toEqual([]);
    expect(f.query).toHaveBeenLastCalledWith(expect.stringContaining('WHERE owner_id = $1::uuid'), [
      'owner',
    ]);
    await expect(revokeToken(f.db, 'owner', 'one')).resolves.toBe(true);
    expect(f.query).toHaveBeenLastCalledWith(expect.stringContaining('owner_id = $2::uuid'), [
      'one',
      'owner',
      expect.any(String),
    ]);
    f.update.mockResolvedValueOnce(result([], 0));
    await expect(revokeToken(f.db, 'owner', 'one')).resolves.toBe(true);
    expect(f.query).toHaveBeenLastCalledWith(
      expect.stringContaining('WHERE id = $1::uuid AND owner_id = $2::uuid'),
      ['one', 'owner'],
    );
    f.update.mockResolvedValueOnce(result([], 0));
    f.own.mockResolvedValueOnce(result([]));
    await expect(revokeToken(f.db, 'owner', 'foreign-or-unknown')).resolves.toBe(false);
    f.update.mockResolvedValueOnce(result([], 2)).mockResolvedValueOnce(result([], null));
    await expect(revokeAllTokens(f.db, 'owner')).resolves.toBe(2);
    await expect(revokeAllTokens(f.db, 'owner')).rejects.toThrow('Token operation failed');
    expect(f.query).toHaveBeenLastCalledWith(expect.stringContaining('WHERE owner_id = $1::uuid'), [
      'owner',
      expect.any(String),
    ]);
  });

  it('atomically changes role/version, rejects missing owners, and conceals operation errors', async () => {
    const f = fixture();
    await changeRoleAndInvalidate(f.db, 'owner', 'member');
    expect(f.query).toHaveBeenLastCalledWith(
      expect.stringContaining('session_version = session_version + 1'),
      ['owner', 'member'],
    );
    f.update.mockResolvedValueOnce(result([], 0));
    await expect(changeRoleAndInvalidate(f.db, 'owner', 'admin')).rejects.toThrow(
      'Token operation failed',
    );
    f.update.mockRejectedValue(new Error('sensitive driver detail'));
    await expect(changeRoleAndInvalidate(f.db, 'owner', 'admin')).rejects.toThrow(
      'Token operation failed',
    );
    await expect(revokeToken(f.db, 'owner', 'one')).rejects.toThrow('Token operation failed');
    await expect(revokeAllTokens(f.db, 'owner')).rejects.toThrow('Token operation failed');
    f.list.mockRejectedValueOnce(new Error('sensitive driver detail'));
    await expect(listTokens(f.db, 'owner')).rejects.toThrow('Token operation failed');
  });
});
