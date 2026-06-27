import { describe, expect, it } from 'vitest';
import { HttpError } from '../../middleware/errorHandler.js';
import {
  isWeekend,
  normalizeDayPart,
  validatePtoPayload,
  type CreatePtoInput,
  type DayPart,
} from './validation.js';

const VALID_SINGLE = { startDate: '2026-05-11', endDate: '2026-05-11' } as const; // Monday
const VALID_MULTI = { startDate: '2026-05-11', endDate: '2026-05-15' } as const; // Mon-Fri

describe('isWeekend', () => {
  it('returns true for Saturday', () => {
    expect(isWeekend('2026-05-09')).toBe(true);
  });
  it('returns true for Sunday', () => {
    expect(isWeekend('2026-05-10')).toBe(true);
  });
  it('returns false for weekdays', () => {
    expect(isWeekend('2026-05-11')).toBe(false);
    expect(isWeekend('2026-05-15')).toBe(false);
  });
  it('returns false for malformed input', () => {
    expect(isWeekend('not-a-date')).toBe(false);
    expect(isWeekend('')).toBe(false);
    expect(isWeekend('2026-13-40')).toBe(false);
  });
});

describe('normalizeDayPart', () => {
  it('returns requested day part for single-day PTO', () => {
    expect(normalizeDayPart('2026-05-11', '2026-05-11', 'morning')).toBe('morning');
    expect(normalizeDayPart('2026-05-11', '2026-05-11', 'evening')).toBe('evening');
    expect(normalizeDayPart('2026-05-11', '2026-05-11', 'all_day')).toBe('all_day');
  });

  it('throws when single-day PTO omits the day part', () => {
    expect(() => normalizeDayPart('2026-05-11', '2026-05-11', undefined)).toThrow(HttpError);
  });

  it('throws when single-day PTO sends an unknown day part', () => {
    expect(() =>
      normalizeDayPart('2026-05-11', '2026-05-11', 'midday' as unknown as DayPart),
    ).toThrow(HttpError);
  });

  it('forces all_day for multi-day PTO regardless of requested day part', () => {
    expect(normalizeDayPart('2026-05-11', '2026-05-15', 'morning')).toBe('all_day');
    expect(normalizeDayPart('2026-05-11', '2026-05-15', 'evening')).toBe('all_day');
  });

  it('accepts undefined day part for multi-day PTO', () => {
    expect(normalizeDayPart('2026-05-11', '2026-05-15', undefined)).toBe('all_day');
  });
});

describe('validatePtoPayload', () => {
  function build(overrides: Partial<CreatePtoInput> = {}): CreatePtoInput {
    return { ...VALID_SINGLE, ...overrides };
  }

  it('returns a ValidatedPto for a single-day with morning', () => {
    const result = validatePtoPayload(build({ dayPart: 'morning' }));
    expect(result).toEqual({
      startDate: '2026-05-11',
      endDate: '2026-05-11',
      dayPart: 'morning',
      note: null,
    });
  });

  it('returns a ValidatedPto for a multi-day range', () => {
    const result = validatePtoPayload(build({ ...VALID_MULTI, dayPart: 'morning', note: 'Trip' }));
    expect(result).toEqual({
      startDate: '2026-05-11',
      endDate: '2026-05-15',
      dayPart: 'all_day',
      note: 'Trip',
    });
  });

  it('trims an empty note to null', () => {
    const result = validatePtoPayload(build({ dayPart: 'morning', note: '' }));
    expect(result.note).toBeNull();
  });

  it.each([
    { startDate: 'oops' },
    { startDate: '2026/05/11' },
    { startDate: '2026-13-01' },
    { startDate: '2026-02-30' },
  ])('rejects invalid startDate %#', (overrides) => {
    expect(() => validatePtoPayload(build(overrides))).toThrow(HttpError);
  });

  it('rejects missing startDate', () => {
    expect(() => validatePtoPayload({ ...VALID_SINGLE, startDate: '' })).toThrow(HttpError);
  });

  it('rejects missing endDate', () => {
    expect(() => validatePtoPayload({ ...VALID_SINGLE, endDate: '' })).toThrow(HttpError);
  });

  it('rejects endDate before startDate', () => {
    expect(() =>
      validatePtoPayload(build({ startDate: '2026-05-12', endDate: '2026-05-11' })),
    ).toThrow(HttpError);
  });

  it('rejects weekend startDate', () => {
    expect(() => validatePtoPayload(build({ startDate: '2026-05-09' }))).toThrow(HttpError);
    expect(() => validatePtoPayload(build({ startDate: '2026-05-10' }))).toThrow(HttpError);
  });

  it('rejects weekend endDate', () => {
    expect(() => validatePtoPayload(build({ endDate: '2026-05-16' }))).toThrow(HttpError);
    expect(() => validatePtoPayload(build({ endDate: '2026-05-17' }))).toThrow(HttpError);
  });

  it('rejects single-day PTO missing dayPart', () => {
    expect(() => validatePtoPayload(build())).toThrow(HttpError);
  });

  it('rejects single-day PTO with invalid dayPart', () => {
    expect(() => validatePtoPayload(build({ dayPart: 'midday' as unknown as DayPart }))).toThrow(
      HttpError,
    );
  });

  it('normalizes multi-day dayPart to all_day even when client sends morning/evening', () => {
    const result = validatePtoPayload(build({ ...VALID_MULTI, dayPart: 'morning' }));
    expect(result.dayPart).toBe('all_day');
  });

  it('accepts a multi-day PTO that spans a weekend (start/end weekdays)', () => {
    const result = validatePtoPayload({
      startDate: '2026-05-08', // Friday
      endDate: '2026-05-12', // Tuesday
    });
    expect(result.dayPart).toBe('all_day');
    expect(result.startDate).toBe('2026-05-08');
    expect(result.endDate).toBe('2026-05-12');
  });

  it('rejects note over 500 characters', () => {
    expect(() => validatePtoPayload(build({ dayPart: 'morning', note: 'x'.repeat(501) }))).toThrow(
      HttpError,
    );
  });

  it('accepts note at the 500-character boundary', () => {
    const result = validatePtoPayload(build({ dayPart: 'morning', note: 'x'.repeat(500) }));
    expect(result.note).toHaveLength(500);
  });
});
