import { HttpError } from '../../middleware/errorHandler.js';
import { ISO_DATE, type CreatePtoInput } from './schemas.js';

export type DayPart = 'morning' | 'evening' | 'all_day';

const DAY_PARTS: readonly DayPart[] = ['morning', 'evening', 'all_day'];

export const NOTE_MAX_LENGTH = 500;

export interface ValidatedPto {
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

export function validatePtoPayload(input: CreatePtoInput): ValidatedPto {
  const { startDate, endDate, dayPart, note } = input;

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

  if (note !== undefined && note !== null && note.length > NOTE_MAX_LENGTH) {
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      `note must be ${NOTE_MAX_LENGTH} characters or fewer.`,
    );
  }

  const normalizedDayPart = normalizeDayPart(startDate, endDate, dayPart);
  const normalizedNote = note && note.length > 0 ? note : null;

  return {
    startDate,
    endDate,
    dayPart: normalizedDayPart,
    note: normalizedNote,
  };
}
