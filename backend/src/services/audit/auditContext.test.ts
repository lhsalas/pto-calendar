import { describe, expect, it } from 'vitest';
import type { AuthContext } from '../auth/authContext.js';
import {
  attributedActorFromAuth,
  safeAuditRequestId,
  trustedOperatorActor,
} from './auditContext.js';

const SESSION: AuthContext = {
  method: 'session',
  actor: { id: '11111111-1111-4111-8111-111111111111', role: 'team_lead' },
  requestId: 'req-session-1',
};

const PAT: AuthContext = {
  method: 'pat',
  actor: { id: '22222222-2222-4222-8222-222222222222', role: 'member' },
  requestId: 'req-pat-1',
  tokenId: '33333333-3333-4333-8333-333333333333',
  scopes: ['pto:read'],
  expiresAt: new Date('2027-01-01T00:00:00.000Z'),
};

describe('safeAuditRequestId', () => {
  it('keeps only the correlation-ID shape and never a personal-token look-alike', () => {
    expect(safeAuditRequestId('trace-123_abc.v1')).toBe('trace-123_abc.v1');
    expect(safeAuditRequestId(null)).toBeNull();
    expect(safeAuditRequestId('')).toBeNull();
    expect(safeAuditRequestId('a'.repeat(201))).toBeNull();
    expect(safeAuditRequestId('has space')).toBeNull();
    expect(safeAuditRequestId('abc\ninjected')).toBeNull();
    expect(safeAuditRequestId('pto_pat_00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(safeAuditRequestId('prefix-PTO_PAT_secret')).toBeNull();
  });

  it('never stores a canonical create key as a correlation ID', () => {
    const key = 'v1.1700000000000.9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
    expect(safeAuditRequestId(key)).toBeNull();
    expect(safeAuditRequestId(`prefix-${key}`)).toBeNull();
    expect(safeAuditRequestId(`${key}-suffix`)).toBeNull();
    expect(attributedActorFromAuth({ ...SESSION, requestId: key }).requestId).toBeNull();
    expect(attributedActorFromAuth({ ...PAT, requestId: key }).requestId).toBeNull();
  });
});

describe('attributedActorFromAuth', () => {
  it('maps a verified cookie session to session attribution', () => {
    expect(attributedActorFromAuth(SESSION)).toEqual({
      id: SESSION.actor.id,
      role: 'team_lead',
      credential: { type: 'session' },
      requestId: 'req-session-1',
    });
  });

  it('maps a verified personal token to its public token ID, never a secret', () => {
    const actor = attributedActorFromAuth(PAT);
    expect(actor).toEqual({
      id: PAT.actor.id,
      role: 'member',
      credential: { type: 'personal_access_token', tokenId: PAT.tokenId },
      requestId: 'req-pat-1',
    });
    expect(JSON.stringify(actor)).not.toMatch(/pto_pat_|secret|digest/i);
  });

  it('drops an unsafe request ID from the verified context to NULL', () => {
    expect(attributedActorFromAuth({ ...SESSION, requestId: 'pto_pat_leak' }).requestId).toBeNull();
  });
});

describe('trustedOperatorActor', () => {
  it('attributes explicit maintenance work to a named operator without a request', () => {
    expect(trustedOperatorActor('44444444-4444-4444-8444-444444444444')).toEqual({
      id: '44444444-4444-4444-8444-444444444444',
      credential: { type: 'operator' },
      requestId: null,
    });
  });
});
