import { describe, expect, it } from 'vitest';
import type { AuthContext } from '../auth/authContext.js';
import { TOKEN_SCOPES, type TokenScope } from '../tokens/tokenDomain.js';
import {
  assertPatRoute,
  assertPtoRecordAccess,
  assertPtoScope,
  classifyPatRoute,
  redactPtoNote,
} from './patPolicy.js';

function pat(
  scopes: readonly TokenScope[],
  role: 'member' | 'team_lead' | 'admin' = 'member',
): Extract<AuthContext, { method: 'pat' }> {
  return {
    method: 'pat',
    actor: { id: 'owner', role },
    requestId: 'request',
    tokenId: 'token',
    scopes,
    expiresAt: new Date(),
  };
}
const session: AuthContext = {
  method: 'session',
  actor: { id: 'owner', role: 'member' },
  requestId: 'request',
};
const path = '/pto/00000000-0000-4000-8000-000000000000';

describe('default-deny PAT route and scope policy', () => {
  it('classifies only deliberate method/path pairs, matching Express case/trailing slash behavior', () => {
    for (const [method, url, operation] of [
      ['GET', '/auth/me', 'identity'],
      ['GET', '/AUTH/ME/', 'identity'],
      ['GET', '/pto', 'read'],
      ['GET', '/PTO/', 'read'],
      ['POST', '/pto/', 'create'],
      ['GET', path, 'read'],
      ['PUT', path + '/', 'update'],
      ['DELETE', path.toUpperCase(), 'delete'],
    ])
      expect(classifyPatRoute(method!, url!)).toBe(operation);
    for (const [method, url] of [
      ['HEAD', '/pto'],
      ['OPTIONS', '/auth/me'],
      ['POST', '/auth/me'],
      ['PUT', '/pto'],
      ['DELETE', '/pto'],
      ['POST', path],
      ['PATCH', path],
      ['HEAD', path],
      ['GET', '/pto/new-route'],
      ['GET', path + '/extra'],
      ['GET', '/pto//'],
      ['GET', '/users'],
      ['GET', '/holidays'],
      ['POST', '/auth/tokens'],
      ['GET', '/auth/tokens'],
      ['POST', '/auth/login'],
      ['POST', '/auth/setup-account'],
      ['POST', '/auth/logout'],
      ['GET', '/health'],
      ['GET', '/future'],
    ])
      expect(classifyPatRoute(method!, url!)).toBeNull();
  });

  it('requires basic scopes and a separate write flag even on already-issued tokens', () => {
    assertPatRoute(pat(['pto:create']), 'identity', false);
    assertPatRoute(pat(['pto:read']), 'read', false);
    assertPatRoute(pat(['pto:create']), 'create', true);
    for (const operation of ['update', 'delete'] as const) {
      assertPatRoute(pat([`pto:${operation}:self`]), operation, true);
      assertPatRoute(pat([`pto:${operation}:team`], 'admin'), operation, true);
      expect(() => assertPatRoute(pat(['pto:read']), operation, true)).toThrow();
    }
    expect(() => assertPatRoute(pat(['pto:create']), 'read', true)).toThrow();
    expect(() => assertPatRoute(pat(['pto:read']), 'create', true)).toThrow();
    for (const operation of ['create', 'update', 'delete'] as const) {
      expect(() => assertPatRoute(pat(TOKEN_SCOPES, 'admin'), operation, false)).toThrow();
    }
    assertPtoScope(session, 'read');
    assertPtoScope(session, 'create');
  });

  it('enforces the full scope AND role AND ownership predicate for updates and deletes', () => {
    for (const operation of ['update', 'delete'] as const) {
      for (const role of ['member', 'team_lead', 'admin'] as const) {
        for (const self of [true, false]) {
          const pto = { userId: self ? 'owner' : 'colleague' };
          for (const kind of ['read', 'self', 'team'] as const) {
            const scopes: TokenScope[] =
              kind === 'read' ? ['pto:read'] : [`pto:${operation}:${kind}`];
            const allowed = (self && kind === 'self') || (role !== 'member' && kind === 'team');
            if (allowed) assertPtoRecordAccess(pat(scopes, role), operation, pto);
            else expect(() => assertPtoRecordAccess(pat(scopes, role), operation, pto)).toThrow();
          }
        }
      }
      assertPtoRecordAccess(session, operation, { userId: 'owner' });
      expect(() => assertPtoRecordAccess(session, operation, { userId: 'other' })).toThrow();
      assertPtoRecordAccess({ ...session, actor: { id: 'owner', role: 'admin' } }, operation, {
        userId: 'other',
      });
    }
  });

  it('requires note-read scope and record authority on every note-bearing response', () => {
    for (const role of ['member', 'team_lead', 'admin'] as const) {
      for (const self of [true, false]) {
        const row = { userId: self ? 'owner' : 'other', note: 'private' };
        for (const scopes of [
          ['pto:create'],
          ['pto:read'],
          ['pto:read', 'pto:notes:read'],
        ] as TokenScope[][]) {
          const visible = scopes.includes('pto:notes:read') && (self || role !== 'member');
          expect(redactPtoNote(pat(scopes, role), row).note).toBe(visible ? 'private' : null);
          expect(row.note).toBe('private');
        }
      }
    }
    expect(redactPtoNote(session, { userId: 'owner', note: 'private' }).note).toBe('private');
    expect(redactPtoNote(session, { userId: 'other', note: 'private' }).note).toBeNull();
  });
});
