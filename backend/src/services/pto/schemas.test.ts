import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvForTests } from '../../config/env.js';
import { mintCursor } from '../calendar/cursor.js';
import { CreatePtoSchema, IdParamSchema, PtoListQuerySchema, RangeQuerySchema } from './schemas.js';

const SESSION_SECRET = 'aB1!cD2@eF3#gH4$iJ5%kL6&mN7*oP8+';
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', SESSION_SECRET);
  vi.stubEnv('DATABASE_URL', 'postgresql://pto:pto@localhost:5432/pto_test?schema=public');
  resetEnvForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvForTests();
});

describe('CreatePtoSchema', () => {
  it('accepts a valid single-day payload', () => {
    const result = CreatePtoSchema.safeParse({
      startDate: '2026-05-11',
      endDate: '2026-05-11',
      dayPart: 'morning',
      note: 'Doctor',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid multi-day all_day payload', () => {
    const result = CreatePtoSchema.safeParse({
      startDate: '2026-05-11',
      endDate: '2026-05-15',
      dayPart: 'all_day',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a payload with no note or dayPart', () => {
    const result = CreatePtoSchema.safeParse({
      startDate: '2026-05-11',
      endDate: '2026-05-11',
    });
    expect(result.success).toBe(true);
  });

  it('preserves the distinction between an absent note and an own undefined note', () => {
    const dates = { startDate: '2026-05-11', endDate: '2026-05-11' };
    const omitted = CreatePtoSchema.parse(dates);
    const explicit = CreatePtoSchema.parse({ ...dates, note: undefined });
    expect(Object.hasOwn(omitted, 'note')).toBe(false);
    expect(Object.hasOwn(explicit, 'note')).toBe(true);
    expect(explicit.note).toBeUndefined();
  });

  it.each([null, 0, false, [], {}])('rejects a non-string note %j', (note) => {
    expect(
      CreatePtoSchema.safeParse({
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        note,
      }).success,
    ).toBe(false);
  });

  it.each([
    { label: 'empty', note: '' },
    { label: 'whitespace', note: '  ' },
    { label: '500-character', note: 'x'.repeat(500) },
  ])('accepts an $label string note unchanged', ({ note }) => {
    const result = CreatePtoSchema.parse({
      startDate: '2026-05-11',
      endDate: '2026-05-11',
      note,
    });
    expect(result.note).toBe(note);
  });

  it('rejects a date that does not match ISO_DATE format', () => {
    const result = CreatePtoSchema.safeParse({
      startDate: '05/11/2026',
      endDate: '2026-05-11',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid dayPart value', () => {
    const result = CreatePtoSchema.safeParse({
      startDate: '2026-05-11',
      endDate: '2026-05-11',
      dayPart: 'noonish',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a note longer than 500 chars', () => {
    const result = CreatePtoSchema.safeParse({
      startDate: '2026-05-11',
      endDate: '2026-05-11',
      note: 'x'.repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing startDate', () => {
    const result = CreatePtoSchema.safeParse({
      endDate: '2026-05-11',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing endDate', () => {
    expect(CreatePtoSchema.safeParse({ startDate: '2026-05-11' }).success).toBe(false);
  });
});

describe('RangeQuerySchema', () => {
  it('accepts a valid ISO range', () => {
    const result = RangeQuerySchema.safeParse({ start: '2026-01-01', end: '2026-01-31' });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid ISO date', () => {
    const result = RangeQuerySchema.safeParse({ start: 'not-a-date', end: '2026-01-31' });
    expect(result.success).toBe(false);
  });

  it('rejects missing end', () => {
    const result = RangeQuerySchema.safeParse({ start: '2026-01-01' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid, reversed, and oversized calendar ranges', () => {
    expect(RangeQuerySchema.safeParse({ start: '2026-02-30', end: '2026-03-01' }).success).toBe(
      false,
    );
    expect(RangeQuerySchema.safeParse({ start: '2026-02-01', end: '2026-01-31' }).success).toBe(
      false,
    );
    expect(RangeQuerySchema.safeParse({ start: '2026-01-01', end: '2027-01-02' }).success).toBe(
      false,
    );
  });

  it('names the impossible start or end date', () => {
    const start = RangeQuerySchema.safeParse({ start: '2026-02-30', end: '2026-03-01' });
    expect(start.error?.issues[0]?.message).toBe('start is not a valid date');
    const end = RangeQuerySchema.safeParse({ start: '2026-03-01', end: '2026-02-30' });
    expect(end.error?.issues[0]?.message).toBe('end is not a valid date');
  });
});

describe('PtoListQuerySchema', () => {
  const range = { start: '2026-05-01', end: '2026-05-31' };

  it('keeps the legacy range rules and ignores unrelated unknown arguments', () => {
    const parsed = PtoListQuerySchema.parse({ ...range, unknown: 'ignored' });
    expect(parsed.start).toBe('2026-05-01');
    expect(parsed.end).toBe('2026-05-31');
    expect(parsed.format).toBeUndefined();
    expect(parsed.userId).toBeNull();
    expect(parsed.limit).toBeUndefined();
    expect(parsed.cursor).toBeNull();
  });

  it('keeps the inclusive 366-day range and rejects a 367-day range', () => {
    expect(PtoListQuerySchema.safeParse({ start: '2026-01-01', end: '2027-01-01' }).success).toBe(
      true,
    );
    expect(PtoListQuerySchema.safeParse({ start: '2026-01-01', end: '2027-01-02' }).success).toBe(
      false,
    );
  });

  it('rejects a malformed or impossible calendar date', () => {
    expect(PtoListQuerySchema.safeParse({ start: '2026-02-30', end: '2026-03-01' }).success).toBe(
      false,
    );
    expect(PtoListQuerySchema.safeParse({ start: '2026-13-01', end: '2026-03-01' }).success).toBe(
      false,
    );
  });

  it('normalizes the owner filter to a canonical lower-case identifier', () => {
    const parsed = PtoListQuerySchema.parse({ ...range, userId: OWNER.toUpperCase() });
    expect(parsed.userId).toBe(OWNER);
  });

  it('rejects a malformed owner filter', () => {
    expect(PtoListQuerySchema.safeParse({ ...range, userId: 'not-a-uuid' }).success).toBe(false);
  });

  it('rejects limit and cursor outside the paged representation', () => {
    const limit = PtoListQuerySchema.safeParse({ ...range, limit: '10' });
    expect(limit.success).toBe(false);
    expect(limit.error?.issues[0]?.message).toBe('limit is only supported with format=page');
    const cursor = PtoListQuerySchema.safeParse({ ...range, cursor: 'anything' });
    expect(cursor.success).toBe(false);
    expect(cursor.error?.issues[0]?.message).toBe('cursor is only supported with format=page');
  });

  it('rejects an unsupported representation name', () => {
    expect(PtoListQuerySchema.safeParse({ ...range, format: 'array' }).success).toBe(false);
  });

  it.each(['0', '201', '1000', '-1', '1.5', '1e2', ' 10', '10 ', '010', 'ten', ''])(
    'rejects the non-canonical or out-of-range limit %j',
    (limit) => {
      const result = PtoListQuerySchema.safeParse({ ...range, format: 'page', limit });
      expect(result.success).toBe(false);
    },
  );

  it('rejects a repeated limit parameter instead of coercing the array', () => {
    expect(
      PtoListQuerySchema.safeParse({ ...range, format: 'page', limit: ['10', '20'] }).success,
    ).toBe(false);
  });

  it('accepts a bounded page size', () => {
    const parsed = PtoListQuerySchema.parse({ ...range, format: 'page', limit: '200' });
    expect(parsed.format).toBe('page');
    expect(parsed.limit).toBe(200);
    expect(parsed.cursor).toBeNull();
  });

  it('accepts a valid cursor that repeats the original filters', () => {
    const cursor = mintCursor(
      { start: '2026-05-01', end: '2026-05-31', userId: null },
      { startDate: '2026-05-11', userId: OWNER, id: OTHER },
    );
    const parsed = PtoListQuerySchema.parse({ ...range, format: 'page', cursor });
    expect(parsed.cursor).toEqual({
      context: { start: '2026-05-01', end: '2026-05-31', userId: null },
      anchor: { startDate: '2026-05-11', userId: OWNER, id: OTHER },
    });
  });

  it.each([
    { label: 'malformed', cursor: 'not-a-cursor' },
    { label: 'tampered', cursor: 'aGVsbG8.aGVsbG8' },
    { label: 'oversized', cursor: 'a'.repeat(513) },
  ])('rejects a $label cursor with one generic issue', ({ cursor }) => {
    const result = PtoListQuerySchema.safeParse({ ...range, format: 'page', cursor });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      { code: 'custom', path: ['cursor'], message: 'cursor is invalid' },
    ]);
    expect(JSON.stringify(result.error?.issues)).not.toContain(cursor);
  });

  it('rejects a cursor that was issued for another owner filter', () => {
    const cursor = mintCursor(
      { start: '2026-05-01', end: '2026-05-31', userId: OWNER },
      { startDate: '2026-05-11', userId: OWNER, id: OTHER },
    );
    const result = PtoListQuerySchema.safeParse({ ...range, format: 'page', cursor });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('cursor is invalid');
  });

  it('rejects a cursor that was issued for another range', () => {
    const cursor = mintCursor(
      { start: '2026-05-01', end: '2026-05-31', userId: null },
      { startDate: '2026-05-11', userId: OWNER, id: OTHER },
    );
    const result = PtoListQuerySchema.safeParse({
      start: '2026-05-02',
      end: '2026-05-31',
      format: 'page',
      cursor,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('cursor is invalid');
  });

  it('rejects a repeated cursor parameter instead of coercing the array', () => {
    expect(
      PtoListQuerySchema.safeParse({ ...range, format: 'page', cursor: ['a', 'b'] }).success,
    ).toBe(false);
  });
});

describe('IdParamSchema', () => {
  it('accepts a UUID v4 string', () => {
    const result = IdParamSchema.safeParse('11111111-2222-3333-4444-555555555555');
    expect(result.success).toBe(true);
  });

  it('rejects a non-UUID string', () => {
    const result = IdParamSchema.safeParse('not-a-uuid');
    expect(result.success).toBe(false);
  });

  it('rejects an empty string', () => {
    const result = IdParamSchema.safeParse('');
    expect(result.success).toBe(false);
  });
});
