import { describe, expect, it, vi } from 'vitest';
import type { AuditActor } from './auditContext.js';
import { recordNativeAudit } from './nativeAudit.js';

const TABLE = '"public"."audit_logs"';
const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN_ID = '33333333-3333-4333-8333-333333333333';

function connection() {
  return {
    query: vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [], rowCount: 1 })),
  };
}

const SESSION_ACTOR: AuditActor = {
  id: ACTOR_ID,
  credential: { type: 'session' },
  requestId: 'req-native-1',
};

describe('recordNativeAudit', () => {
  it('writes nothing for an empty batch, so a no-op change cannot create an audit row', async () => {
    const conn = connection();
    await recordNativeAudit(conn, TABLE, SESSION_ACTOR, {
      action: 'revoke_personal_token',
      entityType: 'personal_access_token',
      entityIds: [],
      targetOwnerId: OWNER_ID,
    });
    expect(conn.query).not.toHaveBeenCalled();
  });

  it('inserts one row per entity on the caller connection with the typed attribution', async () => {
    const conn = connection();
    await recordNativeAudit(conn, TABLE, SESSION_ACTOR, {
      action: 'create_personal_token',
      entityType: 'personal_access_token',
      entityIds: [TOKEN_ID],
      targetOwnerId: OWNER_ID,
      details: { scopes: ['pto:read'], expiresAt: '2027-01-01T00:00:00.000Z' },
    });
    expect(conn.query).toHaveBeenCalledOnce();
    const [sql, values] = conn.query.mock.calls[0]!;
    expect(sql).toContain(`INSERT INTO ${TABLE}`);
    expect(sql).toContain('FROM unnest($9::uuid[], $10::uuid[])');
    expect(values).toEqual([
      ACTOR_ID,
      'create_personal_token',
      'personal_access_token',
      JSON.stringify({ scopes: ['pto:read'], expiresAt: '2027-01-01T00:00:00.000Z' }),
      'session',
      null,
      OWNER_ID,
      'req-native-1',
      [expect.any(String)],
      [TOKEN_ID],
    ]);
  });

  it('records the personal-token source only for a personal-token actor and never a secret', async () => {
    const conn = connection();
    await recordNativeAudit(
      conn,
      TABLE,
      {
        id: ACTOR_ID,
        credential: { type: 'personal_access_token', tokenId: TOKEN_ID },
        requestId: null,
      },
      {
        action: 'revoke_personal_token',
        entityType: 'personal_access_token',
        entityIds: [TOKEN_ID],
        targetOwnerId: OWNER_ID,
        details: { bulk: false },
      },
    );
    const values = conn.query.mock.calls[0]![1] as unknown[];
    expect(values[4]).toBe('personal_access_token');
    expect(values[5]).toBe(TOKEN_ID);
    expect(values[7]).toBeNull();
    expect(JSON.stringify(values)).not.toMatch(/pto_pat_|digest|secret/i);
  });

  it('keeps NULL details and NULL target owner as explicit SQL NULLs', async () => {
    const conn = connection();
    await recordNativeAudit(
      conn,
      TABLE,
      { id: ACTOR_ID, credential: { type: 'operator' }, requestId: null },
      {
        action: 'change_user_role',
        entityType: 'user',
        entityIds: [OWNER_ID],
        targetOwnerId: null,
      },
    );
    const values = conn.query.mock.calls[0]![1] as unknown[];
    expect(values[3]).toBeNull();
    expect(values[6]).toBeNull();
    expect(values[4]).toBe('operator');
  });

  it('writes one row per public ID in a batch and drops an unsafe request ID', async () => {
    const conn = connection();
    const second = '44444444-4444-4444-8444-444444444444';
    await recordNativeAudit(
      conn,
      TABLE,
      { id: ACTOR_ID, credential: { type: 'session' }, requestId: 'pto_pat_leak' },
      {
        action: 'revoke_personal_token',
        entityType: 'personal_access_token',
        entityIds: [TOKEN_ID, second],
        targetOwnerId: OWNER_ID,
        details: { bulk: true },
      },
    );
    const values = conn.query.mock.calls[0]![1] as unknown[];
    expect(values[7]).toBeNull();
    expect(values[9]).toEqual([TOKEN_ID, second]);
    expect(values[8]).toHaveLength(2);
    expect((values[8] as string[])[0]).not.toBe((values[8] as string[])[1]);
  });
});
