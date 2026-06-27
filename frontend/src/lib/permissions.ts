export type Role = 'member' | 'team_lead';

export interface ActorLike {
  id: string;
  role: Role;
}

export interface PTOOwnerLike {
  userId?: string;
}

export function canModifyPto(actor: ActorLike, pto: { userId: string }): boolean {
  return actor.role === 'team_lead' || actor.id === pto.userId;
}
