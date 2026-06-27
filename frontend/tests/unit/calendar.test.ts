import { describe, expect, it } from 'vitest';
import {
  addMonths,
  currentYearMonth,
  dayCovers,
  formatYearMonth,
  grid,
  initials,
  isCurrentYearMonth,
  ptoCoversDay,
  visibleGridRange,
} from '../../src/lib/calendar';

describe('calendar utilities', () => {
  describe('grid', () => {
    it('returns 6 rows of 7 days starting on Monday for a mid-month', () => {
      const { weeks } = grid({ year: 2026, month: 5 });
      expect(weeks).toHaveLength(6);
      weeks.forEach((week) => expect(week).toHaveLength(7));
      const firstDay = new Date(`${weeks[0]![0]!.iso}T00:00:00Z`);
      expect(firstDay.getUTCDay()).toBe(1);
    });

    it('marks only the cells whose month matches the input', () => {
      const { weeks } = grid({ year: 2026, month: 5 });
      const inMonth = weeks.flat().filter((d) => d.isInMonth);
      const outOfMonth = weeks.flat().filter((d) => !d.isInMonth);
      expect(inMonth.length).toBe(30);
      expect(outOfMonth.length).toBe(12);
      inMonth.forEach((d) => expect(d.iso.startsWith('2026-06')).toBe(true));
    });

    it('starts before the 1st when the month does not begin on Monday', () => {
      const { weeks } = grid({ year: 2026, month: 6 });
      expect(weeks[0]![0]!.iso).toBe('2026-06-29');
    });
  });

  describe('visibleGridRange', () => {
    it('returns the 42-day span as start and end ISO strings', () => {
      const range = visibleGridRange({ year: 2026, month: 5 });
      expect(range.start).toBe('2026-06-01');
      expect(range.end).toBe('2026-07-12');
    });
  });

  describe('addMonths', () => {
    it('crosses a year boundary forward', () => {
      expect(addMonths({ year: 2026, month: 11 }, 1)).toEqual({ year: 2027, month: 0 });
    });
    it('crosses a year boundary backward', () => {
      expect(addMonths({ year: 2026, month: 0 }, -1)).toEqual({ year: 2025, month: 11 });
    });
    it('returns the same year-month for zero delta', () => {
      expect(addMonths({ year: 2026, month: 5 }, 0)).toEqual({ year: 2026, month: 5 });
    });
  });

  describe('currentYearMonth', () => {
    it('returns a valid year-month object', () => {
      const ym = currentYearMonth();
      expect(ym.year).toBeGreaterThan(2020);
      expect(ym.month).toBeGreaterThanOrEqual(0);
      expect(ym.month).toBeLessThan(12);
    });
  });

  describe('isCurrentYearMonth', () => {
    it('returns true for the current year-month', () => {
      expect(isCurrentYearMonth(currentYearMonth())).toBe(true);
    });
    it('returns false for a different month in the current year', () => {
      const current = currentYearMonth();
      const other = { year: current.year, month: (current.month + 1) % 12 };
      expect(isCurrentYearMonth(other)).toBe(false);
    });
    it('returns false for a different year', () => {
      const current = currentYearMonth();
      expect(isCurrentYearMonth({ year: current.year - 1, month: current.month })).toBe(false);
      expect(isCurrentYearMonth({ year: current.year + 1, month: current.month })).toBe(false);
    });
  });

  describe('formatYearMonth', () => {
    it('formats a known month', () => {
      expect(formatYearMonth({ year: 2026, month: 5 })).toBe('June 2026');
    });
  });

  describe('dayCovers and ptoCoversDay', () => {
    it('returns true when the day is within the range', () => {
      expect(dayCovers('2026-05-15', '2026-05-11', '2026-05-15')).toBe(true);
    });
    it('returns true for the start and end days inclusive', () => {
      expect(dayCovers('2026-05-11', '2026-05-11', '2026-05-15')).toBe(true);
      expect(dayCovers('2026-05-15', '2026-05-11', '2026-05-15')).toBe(true);
    });
    it('returns false when the day is outside the range', () => {
      expect(dayCovers('2026-05-10', '2026-05-11', '2026-05-15')).toBe(false);
      expect(dayCovers('2026-05-16', '2026-05-11', '2026-05-15')).toBe(false);
    });
    it('handles malformed inputs', () => {
      expect(dayCovers('nope', '2026-05-11', '2026-05-15')).toBe(false);
    });
    it('delegates correctly through ptoCoversDay', () => {
      expect(ptoCoversDay({ startDate: '2026-05-11', endDate: '2026-05-15' }, '2026-05-12')).toBe(
        true,
      );
    });
  });

  describe('initials', () => {
    it('returns two-letter initials for a two-word name', () => {
      expect(initials('Alice Johnson')).toBe('AJ');
    });
    it('returns the first two characters for a single-word name', () => {
      expect(initials('Alice')).toBe('AL');
    });
    it('handles extra whitespace', () => {
      expect(initials('  Alice   Johnson  ')).toBe('AJ');
    });
    it('returns ? for an empty name', () => {
      expect(initials('')).toBe('?');
    });
  });
});
