import { HttpError } from '../../middleware/errorHandler.js';
import type { AuthContext } from '../auth/authContext.js';
import { canModifyPTO, canViewNote, type PTOOwnerLike } from './AuthorizationService.js';

export type PatRoute = 'identity' | 'read' | 'create' | 'update' | 'delete';
const PTO_COLLECTION = /^\/pto\/?$/i;
const PTO_RECORD = /^\/pto\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i;

/** Default deny: no prefix grants, implicit HEAD, new methods or future routes. */
export function classifyPatRoute(method: string, path: string): PatRoute | null {
  if (method === 'GET' && /^\/auth\/me\/?$/i.test(path)) return 'identity';
  if (PTO_COLLECTION.test(path)) {
    if (method === 'GET') return 'read';
    if (method === 'POST') return 'create';
  }
  if (PTO_RECORD.test(path)) {
    if (method === 'GET') return 'read';
    // A partial write is the same scoped write as the replacement write.
    if (method === 'PUT' || method === 'PATCH') return 'update';
    if (method === 'DELETE') return 'delete';
  }
  return null;
}

function forbidden(): never {
  throw new HttpError(
    403,
    'FORBIDDEN',
    'This credential is not allowed to perform this operation.',
  );
}

export function assertPtoScope(auth: AuthContext, operation: 'read' | 'create'): void {
  if (
    auth.method === 'pat' &&
    !auth.scopes.includes(operation === 'read' ? 'pto:read' : 'pto:create')
  ) {
    forbidden();
  }
}

/** Run before dispatch; record-specific checks still run in each write handler. */
export function assertPatRoute(
  auth: Extract<AuthContext, { method: 'pat' }>,
  route: PatRoute,
  writesEnabled: boolean,
): void {
  if (route === 'identity') return;
  if (route === 'read') {
    assertPtoScope(auth, 'read');
    return;
  }
  if (!writesEnabled) forbidden();
  if (route === 'create') {
    assertPtoScope(auth, 'create');
    return;
  }
  if (!auth.scopes.includes(`pto:${route}:self`) && !auth.scopes.includes(`pto:${route}:team`)) {
    forbidden();
  }
}

/** Scope AND live role AND record authority; elevated self tokens stay self-only. */
export function assertPtoRecordAccess(
  auth: AuthContext,
  operation: 'update' | 'delete',
  pto: PTOOwnerLike,
): void {
  if (!canModifyPTO(auth.actor, pto)) forbidden();
  if (auth.method === 'session') return;
  const self = auth.actor.id === pto.userId && auth.scopes.includes(`pto:${operation}:self`);
  const team =
    (auth.actor.role === 'team_lead' || auth.actor.role === 'admin') &&
    auth.scopes.includes(`pto:${operation}:team`);
  if (!self && !team) forbidden();
}

export function redactPtoNote<T extends PTOOwnerLike & { note: string | null }>(
  auth: AuthContext,
  pto: T,
): T {
  const visible =
    canViewNote(auth.actor, pto) &&
    (auth.method === 'session' || auth.scopes.includes('pto:notes:read'));
  return { ...pto, note: visible ? pto.note : null };
}
