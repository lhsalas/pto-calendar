export type Role = 'member' | 'team_lead' | 'admin';

export interface ActorContext {
  id: string;
  role: Role;
}

export function canModifyPto(actor: ActorContext, pto: { userId: string }): boolean {
  return actor.role === 'team_lead' || actor.role === 'admin' || actor.id === pto.userId;
}

export function canManageUsers(actor: ActorContext): boolean {
  return actor.role === 'team_lead' || actor.role === 'admin';
}
