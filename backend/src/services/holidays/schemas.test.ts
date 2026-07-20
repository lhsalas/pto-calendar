import { describe, expect, it } from 'vitest';
import {
  CreateHolidaySchema,
  IdParamSchema,
  RangeQuerySchema,
  SeedHolidaySchema,
  SUPPORTED_COUNTRY_CODES,
} from './schemas.js';

describe('holidays schemas', () => {
  describe('RangeQuerySchema', () => {
    it('accepts valid start and end', () => {
      const r = RangeQuerySchema.parse({ start: '2026-01-01', end: '2026-12-31' });
      expect(r.start).toBe('2026-01-01');
      expect(r.end).toBe('2026-12-31');
    });
    it('rejects bad start', () => {
      expect(() => RangeQuerySchema.parse({ start: '01-01-2026', end: '2026-12-31' })).toThrow();
    });
    it('rejects bad end', () => {
      expect(() => RangeQuerySchema.parse({ start: '2026-01-01', end: 'bad' })).toThrow();
    });
  });

  describe('CreateHolidaySchema', () => {
    it('accepts minimal payload', () => {
      const r = CreateHolidaySchema.parse({ date: '2026-07-04', name: 'Independence Day' });
      expect(r.date).toBe('2026-07-04');
      expect(r.name).toBe('Independence Day');
      expect(r.countryCode).toBeNull();
    });
    it('accepts a country code', () => {
      const r = CreateHolidaySchema.parse({ date: '2026-07-04', name: 'X', countryCode: 'US' });
      expect(r.countryCode).toBe('US');
    });
    it('rejects lowercase country code', () => {
      expect(() =>
        CreateHolidaySchema.parse({ date: '2026-07-04', name: 'X', countryCode: 'us' }),
      ).toThrow();
    });
    it('rejects non-alpha-2 country code', () => {
      expect(() =>
        CreateHolidaySchema.parse({ date: '2026-07-04', name: 'X', countryCode: 'USA' }),
      ).toThrow();
    });
    it('rejects empty name', () => {
      expect(() => CreateHolidaySchema.parse({ date: '2026-07-04', name: '' })).toThrow();
    });
    it('rejects name > 120 chars', () => {
      expect(() =>
        CreateHolidaySchema.parse({ date: '2026-07-04', name: 'x'.repeat(121) }),
      ).toThrow();
    });
    it('rejects bad date format', () => {
      expect(() => CreateHolidaySchema.parse({ date: '2026/07/04', name: 'X' })).toThrow();
    });
  });

  describe('IdParamSchema', () => {
    it('accepts a valid uuid', () => {
      expect(IdParamSchema.parse('3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBe(
        '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      );
    });
    it('rejects a non-uuid', () => {
      expect(() => IdParamSchema.parse('not-a-uuid')).toThrow();
    });
  });

  describe('SeedHolidaySchema', () => {
    it.each(SUPPORTED_COUNTRY_CODES)('accepts %s', (cc) => {
      expect(SeedHolidaySchema.parse({ countryCode: cc }).countryCode).toBe(cc);
    });
    it('rejects unsupported country', () => {
      expect(() => SeedHolidaySchema.parse({ countryCode: 'CA' })).toThrow();
    });
  });
});
