import { describe, expect, it } from 'vitest';
import { CreatePtoSchema, IdParamSchema, RangeQuerySchema } from './schemas.js';

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
