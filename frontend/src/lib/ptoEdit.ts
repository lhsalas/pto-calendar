import { apiRequest } from '../api/client';
import { canModifyPto } from './permissions';
import type { PTO, PTOWithUser, User } from '../types/api';

// UI-only provenance; never part of a list DTO or an API request.
export type PreparedPto = PTOWithUser & { noteLoadedFor: string };
export function editViewerKey(user: User): string {
  return `${user.id}:${user.role}`;
}
export function preparePtoForEdit(pto: PTOWithUser, user: User, note: unknown): PreparedPto {
  if (!canModifyPto(user, { userId: pto.user.id })) throw new Error('You cannot edit this PTO.');
  if (note !== null && typeof note !== 'string') throw new Error('Could not load PTO details.');
  return { ...pto, note, noteLoadedFor: editViewerKey(user) };
}
export function isPreparedPto(pto: PTOWithUser, user: User): pto is PreparedPto {
  return (
    canModifyPto(user, { userId: pto.user.id }) &&
    'noteLoadedFor' in pto &&
    pto.noteLoadedFor === editViewerKey(user) &&
    (pto.note === null || typeof pto.note === 'string')
  );
}
export async function loadPtoForEdit(pto: PTOWithUser, user: User): Promise<PreparedPto> {
  if (!canModifyPto(user, { userId: pto.user.id })) throw new Error('You cannot edit this PTO.');
  const detail = await apiRequest<PTO>(`/pto/${encodeURIComponent(pto.id)}`);
  return preparePtoForEdit(pto, user, detail.note);
}
