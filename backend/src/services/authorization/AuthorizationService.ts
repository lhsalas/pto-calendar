export type Role = 'member' | 'team_lead' | 'admin';

export interface ActorContext {
  id: string;
  role: Role;
}

export interface PTOOwnerLike {
  userId: string;
}

export function canModifyPTO(actor: ActorContext, pto: PTOOwnerLike): boolean {
  return actor.role === 'team_lead' || actor.role === 'admin' || actor.id === pto.userId;
}

export function canViewNote(actor: ActorContext, pto: PTOOwnerLike): boolean {
  return canModifyPTO(actor, pto);
}

/**
 * Whether the actor is allowed to manage users (create, list, reset-password).
 * Today the gate is `team_lead`; `admin` is a forward-compatible role that
 * also passes the check so the swap is one PR when we promote a user.
 */
export function canManageUsers(actor: ActorContext): boolean {
  return actor.role === 'team_lead' || actor.role === 'admin';
}
