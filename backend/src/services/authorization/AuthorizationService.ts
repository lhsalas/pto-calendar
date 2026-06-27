export type Role = 'member' | 'team_lead';

export interface ActorLike {
  id: string;
  role: Role;
}

export interface PTOOwnerLike {
  userId: string;
}

export function canModifyPTO(actor: ActorLike, pto: PTOOwnerLike): boolean {
  return actor.role === 'team_lead' || actor.id === pto.userId;
}

export function canViewNote(actor: ActorLike, pto: PTOOwnerLike): boolean {
  return canModifyPTO(actor, pto);
}
