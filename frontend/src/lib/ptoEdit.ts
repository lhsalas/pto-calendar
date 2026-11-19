import { apiRequest, ApiError } from '../api/client';
import { canModifyPto } from './permissions';
import type { DayPart, PTO, PTOWithUser, User } from '../types/api';

// UI-only provenance; never part of a list DTO or an API request.
export type PreparedPto = PTOWithUser & { noteLoadedFor: string; version: number };

/**
 * The authoritative fields of one loaded PTO. Every write quotes the version
 * of exactly this snapshot, so the dates, the day part, the note and the
 * version always describe the same revision.
 */
export interface LoadedPtoDetail {
  startDate: string;
  endDate: string;
  dayPart: DayPart;
  note: string | null;
  version: number;
}

export function editViewerKey(user: User): string {
  return `${user.id}:${user.role}`;
}

const DAY_PARTS: readonly DayPart[] = ['morning', 'evening', 'all_day'];
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function isVersion(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2_147_483_647
  );
}

/**
 * Builds the snapshot an editor works on. The editable fields always come
 * from the loaded detail, never from the calendar summary, so a form can
 * never pair a fresh version with stale dates.
 */
export function preparePtoForEdit(
  pto: PTOWithUser,
  user: User,
  detail: LoadedPtoDetail,
): PreparedPto {
  if (!canModifyPto(user, { userId: pto.user.id })) throw new Error('You cannot edit this PTO.');
  if (
    (detail.note !== null && typeof detail.note !== 'string') ||
    typeof detail.startDate !== 'string' ||
    !DATE_ONLY.test(detail.startDate) ||
    typeof detail.endDate !== 'string' ||
    !DATE_ONLY.test(detail.endDate) ||
    !DAY_PARTS.includes(detail.dayPart) ||
    !isVersion(detail.version)
  ) {
    throw new Error('Could not load PTO details.');
  }
  return {
    ...pto,
    startDate: detail.startDate,
    endDate: detail.endDate,
    dayPart: detail.dayPart,
    note: detail.note,
    version: detail.version,
    noteLoadedFor: editViewerKey(user),
  };
}

export function isPreparedPto(pto: PTOWithUser, user: User): pto is PreparedPto {
  return (
    canModifyPto(user, { userId: pto.user.id }) &&
    'noteLoadedFor' in pto &&
    pto.noteLoadedFor === editViewerKey(user) &&
    (pto.note === null || typeof pto.note === 'string') &&
    'version' in pto &&
    isVersion(pto.version)
  );
}

export async function loadPtoForEdit(pto: PTOWithUser, user: User): Promise<PreparedPto> {
  if (!canModifyPto(user, { userId: pto.user.id })) throw new Error('You cannot edit this PTO.');
  const detail = await apiRequest<PTO>(`/pto/${encodeURIComponent(pto.id)}`, {
    cache: 'no-store',
  });
  if (detail?.id !== pto.id || detail.userId !== pto.user.id) {
    throw new Error('Could not load PTO details.');
  }
  return preparePtoForEdit(pto, user, detail);
}

/**
 * The precondition header of a write. The version must be an integer of at
 * least one; a missing or malformed version fails closed instead of
 * guessing a version.
 */
export function ifMatchHeader(version: number): { 'If-Match': string } {
  if (!isVersion(version)) throw new Error('Could not check the PTO version.');
  return { 'If-Match': `"${version}"` };
}

/**
 * A write the server refused because the record changed (412) or because no
 * precondition was sent (428). The user has to load the current details
 * again; the editor is never allowed to overwrite the newer revision.
 */
export class StalePtoWriteError extends Error {
  constructor(readonly kind: 'missing' | 'stale') {
    super(
      kind === 'missing'
        ? 'This server requires a version check for every change. Close this and open the PTO again to load the current details.'
        : 'This PTO changed since you loaded it. Close this and open the PTO again to load the current details.',
    );
    this.name = 'StalePtoWriteError';
  }
}

export function isStalePtoWriteError(err: unknown): err is StalePtoWriteError {
  return err instanceof StalePtoWriteError;
}

/** Maps a refused write onto the typed conflict, keeping other errors. */
export function toPtoWriteError(err: unknown): unknown {
  if (err instanceof ApiError) {
    if (err.status === 412) return new StalePtoWriteError('stale');
    if (err.status === 428) return new StalePtoWriteError('missing');
  }
  return err;
}
