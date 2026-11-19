import { HttpError } from '../../middleware/errorHandler.js';
import { ISO_DATE, type CreatePtoInput, type PatchPtoInput } from './schemas.js';

export type DayPart = 'morning' | 'evening' | 'all_day';

const DAY_PARTS: readonly DayPart[] = ['morning', 'evening', 'all_day'];

export const NOTE_MAX_LENGTH = 500;

export interface ValidatedPto {
  startDate: string;
  endDate: string;
  dayPart: DayPart;
  note: string | null;
}

/** The stored fields a partial write is merged against. */
export interface StoredPtoFields {
  startDate: string;
  endDate: string;
  dayPart: DayPart;
  note: string | null;
}

export function isWeekend(dateStr: string): boolean {
  const parts = dateStr.split('-').map(Number);
  if (parts.length !== 3) return false;
  const [y, m, d] = parts as [number, number, number];
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6;
}

function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function normalizeDayPart(
  startDate: string,
  endDate: string,
  requested: DayPart | undefined,
): DayPart {
  if (startDate === endDate) {
    if (requested && DAY_PARTS.includes(requested)) {
      return requested;
    }
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      'Single-day PTO requires a day part (morning, evening, or all_day).',
    );
  }
  if (requested && requested !== 'all_day') {
    return 'all_day';
  }
  return 'all_day';
}

/**
 * The shared date rules. A create, a replacement and a partial write all
 * validate their dates the same way, so a merged record can never pass a
 * rule that a fresh record would fail.
 */
function validateDates(startDate: string, endDate: string): void {
  if (!startDate || !isValidIsoDate(startDate)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'startDate must be a valid ISO date.');
  }
  if (!endDate || !isValidIsoDate(endDate)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'endDate must be a valid ISO date.');
  }
  if (endDate < startDate) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'endDate cannot be before startDate.');
  }
  if (isWeekend(startDate)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'startDate cannot fall on a weekend.');
  }
  if (isWeekend(endDate)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'endDate cannot fall on a weekend.');
  }
}

function validateNote(note: string | null | undefined): void {
  if (note !== undefined && note !== null && note.length > NOTE_MAX_LENGTH) {
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      `note must be ${NOTE_MAX_LENGTH} characters or fewer.`,
    );
  }
}

export function validatePtoPayload(input: CreatePtoInput): ValidatedPto {
  const { startDate, endDate, dayPart, note } = input;

  validateDates(startDate, endDate);
  validateNote(note);

  const normalizedDayPart = normalizeDayPart(startDate, endDate, dayPart);
  const normalizedNote = note && note.length > 0 ? note : null;

  return {
    startDate,
    endDate,
    dayPart: normalizedDayPart,
    note: normalizedNote,
  };
}

/**
 * Validates a partial write against the record it changes.
 *
 * An omitted field keeps its stored value, an explicit note clears it with
 * `null` or an empty string and sets it with text, and the merged record has
 * to satisfy the same date, day part and note rules as a fresh record. A
 * stored half-day day part cannot describe a longer range: when the caller
 * did not ask for a day part, the write is refused instead of silently
 * changing one.
 */
export function validatePtoPatch(patch: PatchPtoInput, stored: StoredPtoFields): ValidatedPto {
  const startDate = patch.startDate ?? stored.startDate;
  const endDate = patch.endDate ?? stored.endDate;
  validateDates(startDate, endDate);

  const noteProvided = Object.hasOwn(patch, 'note');
  const requestedNote = noteProvided ? (patch.note ?? null) : stored.note;
  validateNote(requestedNote);

  const dayPartProvided = patch.dayPart !== undefined;
  const dayPart = dayPartProvided ? patch.dayPart! : stored.dayPart;
  if (!dayPartProvided && startDate !== endDate && dayPart !== 'all_day') {
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      'The stored day part does not fit the requested dates. Send an explicit day part.',
    );
  }

  const normalizedDayPart = normalizeDayPart(startDate, endDate, dayPart);
  const normalizedNote = requestedNote && requestedNote.length > 0 ? requestedNote : null;

  return {
    startDate,
    endDate,
    dayPart: normalizedDayPart,
    note: normalizedNote,
  };
}
