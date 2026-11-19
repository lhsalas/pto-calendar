import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { HttpError } from '../../middleware/errorHandler.js';
import type { SessionUser } from '../../middleware/cookieSession.js';
import type { AuthContext } from '../auth/authContext.js';
import { preparePtoReplay, type PtoReplayCredential } from './replayCredential.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const TOKEN_ID = '22222222-2222-4222-8222-222222222222';
const NONCE = '33333333-3333-4333-8333-333333333333';

interface FakeRows {
  user?: { id: string; role: string; sessionVersion: number; passwordEstablished: boolean } | null;
  token?: {
    id: string;
    ownerId: string;
    scopes: string[];
    expiresAt: Date;
    revokedAt: Date | null;
    issuedSessionVersion: number;
  } | null;
  clock?: Date | null;
}

function fakeTx(rows: FakeRows): { tx: Prisma.TransactionClient; statements: string[] } {
  const statements: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const sql = strings.join('?');
      statements.push(sql);
      if (sql.includes('FROM "users"')) {
        return rows.user ? [rows.user] : [];
      }
      if (sql.includes('FROM "personal_access_tokens"')) {
        return rows.token ? [rows.token] : [];
      }
      return rows.clock ? [{ now: rows.clock }] : [];
    }),
  } as unknown as Prisma.TransactionClient;
  return { tx, statements };
}

function patAuth(overrides: Partial<Extract<AuthContext, { method: 'pat' }>> = {}) {
  return {
    method: 'pat',
    actor: { id: OWNER, role: 'member' },
    requestId: 'req-1',
    tokenId: TOKEN_ID,
    scopes: ['pto:read', 'pto:create'],
    expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    ...overrides,
  } satisfies Extract<AuthContext, { method: 'pat' }>;
}

function sessionAuth(overrides: Partial<Extract<AuthContext, { method: 'session' }>> = {}) {
  return {
    method: 'session',
    actor: { id: OWNER, role: 'member' },
    requestId: 'req-2',
    ...overrides,
  } satisfies Extract<AuthContext, { method: 'session' }>;
}

function liveUser(overrides: Partial<NonNullable<FakeRows['user']>> = {}) {
  return {
    id: OWNER,
    role: 'member',
    sessionVersion: 3,
    passwordEstablished: true,
    ...overrides,
  };
}

function liveToken(overrides: Partial<NonNullable<FakeRows['token']>> = {}) {
  return {
    id: TOKEN_ID,
    ownerId: OWNER,
    scopes: ['pto:read', 'pto:create'],
    expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    revokedAt: null,
    issuedSessionVersion: 3,
    ...overrides,
  };
}

async function expectUnauthorized(run: () => Promise<unknown>): Promise<void> {
  await expect(run()).rejects.toBeInstanceOf(HttpError);
  await expect(run()).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
}

describe('preparePtoReplay', () => {
  it('binds a personal token to its public token id and freezes the credential', () => {
    const credential: PtoReplayCredential = preparePtoReplay(patAuth(), undefined);
    expect(credential.kind).toBe('pat');
    expect(credential.ownerId).toBe(OWNER);
    expect(credential.credentialId).toBe(TOKEN_ID);
    expect(Object.isFrozen(credential)).toBe(true);
  });

  it('binds a browser session to its per-login replay nonce', () => {
    const session: SessionUser = {
      id: OWNER,
      role: 'member',
      sessionVersion: 3,
      replayNonce: NONCE,
    };
    const credential = preparePtoReplay(sessionAuth(), session);
    expect(credential.kind).toBe('session');
    expect(credential.ownerId).toBe(OWNER);
    expect(credential.credentialId).toBe(NONCE);
    expect(Object.isFrozen(credential)).toBe(true);
  });

  it('refuses a keyed request from an older session without a replay nonce', () => {
    const session: SessionUser = { id: OWNER, role: 'member', sessionVersion: 3 };
    expect(() => preparePtoReplay(sessionAuth(), session)).toThrow(HttpError);
    expect(() => preparePtoReplay(sessionAuth(), undefined)).toThrow(HttpError);
    try {
      preparePtoReplay(sessionAuth(), session);
    } catch (err) {
      expect((err as HttpError).status).toBe(401);
      expect((err as HttpError).code).toBe('UNAUTHENTICATED');
    }
  });

  it('does not bind a malformed or unrelated verified session identity', () => {
    const session: SessionUser = { id: OWNER, role: 'member', sessionVersion: 3 };
    expect(() => preparePtoReplay(sessionAuth(), { ...session, replayNonce: 'bad' })).toThrow(
      HttpError,
    );
    expect(() =>
      preparePtoReplay(sessionAuth(), { ...session, replayNonce: NONCE, id: TOKEN_ID }),
    ).toThrow(HttpError);
  });

  it('re-checks a personal token inside the transaction and returns the live context', async () => {
    const { tx, statements } = fakeTx({
      user: liveUser(),
      token: liveToken(),
      clock: new Date('2026-12-01T00:00:00.000Z'),
    });
    const credential = preparePtoReplay(patAuth(), undefined);
    const live = await credential.recheck(tx);
    expect(live.method).toBe('pat');
    expect(live.actor).toEqual({ id: OWNER, role: 'member' });
    expect(live.requestId).toBe('req-1');
    expect(live.method === 'pat' && live.scopes).toEqual(['pto:read', 'pto:create']);
    // The live user is read before the token, and the clock after both locks.
    expect(statements[0]).toContain('FROM "users"');
    expect(statements[1]).toContain('FROM "personal_access_tokens"');
    expect(statements[2]).toContain('clock_timestamp()');
    expect(statements[0]).toContain('FOR SHARE');
    expect(statements[1]).toContain('FOR SHARE');
  });

  it('refuses a revoked, expired, foreign or stale personal token', async () => {
    const cases: FakeRows[] = [
      { user: liveUser(), token: liveToken({ revokedAt: new Date() }), clock: new Date() },
      {
        user: liveUser(),
        token: liveToken({ expiresAt: new Date('2020-01-01T00:00:00.000Z') }),
        clock: new Date('2026-12-01T00:00:00.000Z'),
      },
      {
        user: liveUser(),
        token: liveToken({ ownerId: '33333333-3333-4333-8333-333333333333' }),
        clock: new Date('2026-12-01T00:00:00.000Z'),
      },
      {
        user: liveUser(),
        token: liveToken({ issuedSessionVersion: 9 }),
        clock: new Date('2026-12-01T00:00:00.000Z'),
      },
      { user: null, token: liveToken(), clock: new Date('2026-12-01T00:00:00.000Z') },
      {
        user: liveUser({ passwordEstablished: false }),
        token: liveToken(),
        clock: new Date('2026-12-01T00:00:00.000Z'),
      },
      {
        user: liveUser({ role: 'wizard' }),
        token: liveToken(),
        clock: new Date('2026-12-01T00:00:00.000Z'),
      },
      { user: liveUser(), token: null, clock: new Date('2026-12-01T00:00:00.000Z') },
      {
        user: liveUser(),
        token: liveToken({ scopes: ['pto:notes:read'] }),
        clock: new Date('2026-12-01T00:00:00.000Z'),
      },
      { user: liveUser(), token: liveToken(), clock: null },
    ];
    for (const rows of cases) {
      const { tx } = fakeTx(rows);
      const credential = preparePtoReplay(patAuth(), undefined);
      await expectUnauthorized(() => credential.recheck(tx));
    }
  });

  it('refuses a personal token whose stored scope set no longer fits the role', async () => {
    const { tx } = fakeTx({
      user: liveUser({ role: 'member' }),
      token: liveToken({ scopes: ['pto:update:team'] }),
      clock: new Date('2026-12-01T00:00:00.000Z'),
    });
    const credential = preparePtoReplay(patAuth(), undefined);
    await expectUnauthorized(() => credential.recheck(tx));
  });

  it('refuses a personal token that lost the create scope', async () => {
    const { tx } = fakeTx({
      user: liveUser(),
      token: liveToken({ scopes: ['pto:read'] }),
      clock: new Date('2026-12-01T00:00:00.000Z'),
    });
    const credential = preparePtoReplay(patAuth(), undefined);
    await expect(credential.recheck(tx)).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
  });

  it('re-checks a browser session and returns the live role', async () => {
    const session: SessionUser = {
      id: OWNER,
      role: 'member',
      sessionVersion: 3,
      replayNonce: NONCE,
    };
    const { tx, statements } = fakeTx({
      user: liveUser({ role: 'team_lead' }),
      clock: new Date('2026-12-01T00:00:00.000Z'),
    });
    const credential = preparePtoReplay(sessionAuth(), session);
    const live = await credential.recheck(tx);
    expect(live.method).toBe('session');
    expect(live.actor).toEqual({ id: OWNER, role: 'team_lead' });
    expect(live.requestId).toBe('req-2');
    expect(statements[0]).toContain('FROM "users"');
  });

  it('refuses a session whose credential version changed', async () => {
    const session: SessionUser = {
      id: OWNER,
      role: 'member',
      sessionVersion: 3,
      replayNonce: NONCE,
    };
    const { tx } = fakeTx({
      user: liveUser({ sessionVersion: 4 }),
      clock: new Date('2026-12-01T00:00:00.000Z'),
    });
    const credential = preparePtoReplay(sessionAuth(), session);
    await expectUnauthorized(() => credential.recheck(tx));
  });
});
