import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  compareYearMonth,
  currentYearMonth,
  dayCovers,
  dayPartLabel,
  firstOfMonthIso,
  formatLongDate,
  formatMonthDay,
  formatRangeLabel,
  formatYearMonth,
  grid,
  initials,
  isCurrentYearMonth,
  isWeekend,
  listWindow,
  ptoCoversDay,
  readableTextOn,
  todayIso,
  visibleGridRange,
} from '../../src/lib/calendar';
import type { DayPart } from '../../src/types/api';

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

    it('starts on the 1st when the month begins on a Monday', () => {
      const { weeks, start } = grid({ year: 2026, month: 5 });
      expect(start).toBe('2026-06-01');
      expect(weeks[0]![0]!.iso).toBe('2026-06-01');
      expect(new Date(`${start}T00:00:00Z`).getUTCDay()).toBe(1);
    });

    it('starts on the previous Monday when the month begins on a Sunday', () => {
      const { weeks, start } = grid({ year: 2026, month: 10 });
      expect(start).toBe('2026-10-26');
      expect(weeks[0]![0]!.iso).toBe('2026-10-26');
      expect(new Date(`${start}T00:00:00Z`).getUTCDay()).toBe(1);
    });

    it('always renders 42 Monday-first cells ending on a Sunday', () => {
      for (const month of [0, 1, 5, 9, 11]) {
        const { weeks } = grid({ year: 2026, month });
        expect(weeks).toHaveLength(6);
        weeks.forEach((week) => expect(week).toHaveLength(7));
        const first = weeks[0]![0]!.iso;
        const last = weeks[5]![6]!.iso;
        expect(new Date(`${first}T00:00:00Z`).getUTCDay()).toBe(1);
        expect(new Date(`${last}T00:00:00Z`).getUTCDay()).toBe(0);
      }
    });

    it('covers every day of a leap-year February exactly once, in order', () => {
      const { weeks } = grid({ year: 2028, month: 1 });
      const inMonth = weeks.flat().filter((d) => d.isInMonth);
      expect(inMonth.map((d) => d.dayOfMonth)).toEqual(
        Array.from({ length: 29 }, (_, index) => index + 1),
      );
      expect(inMonth.at(-1)!.iso).toBe('2028-02-29');
    });

    it('marks exactly one cell as today when the input matches the current month', () => {
      const today = todayIso();
      const current = currentYearMonth();
      const { weeks } = grid(current);
      const all = weeks.flat();
      expect(all).toHaveLength(42);
      const todays = all.filter((d) => d.isToday);
      expect(todays).toHaveLength(1);
      expect(todays[0]!.iso).toBe(today);
      expect(todays[0]!.isInMonth).toBe(true);
    });

    it('marks no cells as today when the input is a non-current month', () => {
      const current = currentYearMonth();
      const other = { year: current.year + 1, month: 0 };
      const { weeks } = grid(other);
      const all = weeks.flat();
      expect(all.every((d) => d.isToday === false)).toBe(true);
    });
  });

  describe('visibleGridRange', () => {
    it('returns the 42-day span as start and end ISO strings', () => {
      const range = visibleGridRange({ year: 2026, month: 5 });
      expect(range.start).toBe('2026-06-01');
      expect(range.end).toBe('2026-07-12');
    });

    it('matches the grid bounds for a month that starts on a Sunday', () => {
      const range = visibleGridRange({ year: 2026, month: 10 });
      expect(range.start).toBe('2026-10-26');
      expect(range.end).toBe('2026-12-06');
    });

    it('spans exactly 42 inclusive days', () => {
      const range = visibleGridRange({ year: 2026, month: 10 });
      const start = new Date(`${range.start}T00:00:00Z`);
      const end = new Date(`${range.end}T00:00:00Z`);
      const days = (end.getTime() - start.getTime()) / 86_400_000 + 1;
      expect(days).toBe(42);
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
    it('moves more than a year forward', () => {
      expect(addMonths({ year: 2026, month: 0 }, 13)).toEqual({ year: 2027, month: 1 });
    });
    it('moves more than a year backward', () => {
      expect(addMonths({ year: 2026, month: 0 }, -13)).toEqual({ year: 2024, month: 11 });
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

  describe('compareYearMonth', () => {
    it('returns 0 for equal year-months', () => {
      expect(compareYearMonth({ year: 2026, month: 5 }, { year: 2026, month: 5 })).toBe(0);
    });
    it('returns -1 when the first month is earlier in the same year', () => {
      expect(compareYearMonth({ year: 2026, month: 4 }, { year: 2026, month: 5 })).toBe(-1);
    });
    it('returns 1 when the first month is later in the same year', () => {
      expect(compareYearMonth({ year: 2026, month: 6 }, { year: 2026, month: 5 })).toBe(1);
    });
    it('returns -1 across a year boundary when the first is in an earlier year', () => {
      expect(compareYearMonth({ year: 2025, month: 11 }, { year: 2026, month: 0 })).toBe(-1);
    });
    it('returns 1 across a year boundary when the first is in a later year', () => {
      expect(compareYearMonth({ year: 2026, month: 0 }, { year: 2025, month: 11 })).toBe(1);
    });
  });

  describe('firstOfMonthIso', () => {
    it('returns YYYY-MM-01 for a mid-year month', () => {
      expect(firstOfMonthIso({ year: 2026, month: 6 })).toBe('2026-07-01');
    });
    it('zero-pads the month number', () => {
      expect(firstOfMonthIso({ year: 2026, month: 0 })).toBe('2026-01-01');
      expect(firstOfMonthIso({ year: 2026, month: 9 })).toBe('2026-10-01');
    });
    it('handles a December input', () => {
      expect(firstOfMonthIso({ year: 2026, month: 11 })).toBe('2026-12-01');
    });
    it('handles February in a leap year', () => {
      expect(firstOfMonthIso({ year: 2028, month: 1 })).toBe('2028-02-01');
    });
  });

  describe('isWeekend', () => {
    it('returns false for a Monday', () => {
      expect(isWeekend('2026-06-15')).toBe(false);
    });
    it('returns false for a Wednesday', () => {
      expect(isWeekend('2026-06-17')).toBe(false);
    });
    it('returns false for a Friday', () => {
      expect(isWeekend('2026-06-19')).toBe(false);
    });
    it('returns true for a Saturday', () => {
      expect(isWeekend('2026-06-20')).toBe(true);
    });
    it('returns true for a Sunday', () => {
      expect(isWeekend('2026-06-21')).toBe(true);
    });
    it('returns false for malformed input', () => {
      expect(isWeekend('not-a-date')).toBe(false);
    });
    it('returns false for a value that is not a three-part date', () => {
      expect(isWeekend('2026-06')).toBe(false);
      expect(isWeekend('2026-06-15-16')).toBe(false);
      expect(isWeekend('')).toBe(false);
    });
  });

  describe('formatLongDate', () => {
    it('renders the long English date for a weekday', () => {
      expect(formatLongDate('2026-06-15')).toBe('Monday, June 15, 2026');
    });
    it('renders the long English date for a weekend day', () => {
      expect(formatLongDate('2026-06-20')).toBe('Saturday, June 20, 2026');
    });
    it('returns the input unchanged for malformed ISO', () => {
      expect(formatLongDate('not-a-date')).toBe('not-a-date');
    });
    it('returns the input unchanged for a value that is not a three-part date', () => {
      expect(formatLongDate('2026-06')).toBe('2026-06');
      expect(formatLongDate('2026-06-15-16')).toBe('2026-06-15-16');
    });
    it('returns the input unchanged for a day that does not exist', () => {
      expect(formatLongDate('2026-02-30')).toBe('2026-02-30');
      expect(formatLongDate('2026-13-01')).toBe('2026-13-01');
    });
  });

  describe('formatMonthDay', () => {
    it('formats a known date', () => {
      expect(formatMonthDay('2026-06-15')).toBe('Jun 15');
    });
    it('returns the input unchanged for malformed ISO', () => {
      expect(formatMonthDay('not-a-date')).toBe('not-a-date');
    });
    it('returns the input unchanged for a value that is not a three-part date', () => {
      expect(formatMonthDay('2026-06')).toBe('2026-06');
      expect(formatMonthDay('2026-06-15-16')).toBe('2026-06-15-16');
    });
    it('returns the input unchanged for a day that does not exist', () => {
      expect(formatMonthDay('2026-02-30')).toBe('2026-02-30');
      expect(formatMonthDay('2026-13-01')).toBe('2026-13-01');
    });
  });

  describe('formatRangeLabel', () => {
    it('returns month-day when start and end are the same', () => {
      expect(formatRangeLabel('2026-06-15', '2026-06-15')).toBe('Jun 15');
    });
    it('formats a same-month range with en-dash', () => {
      expect(formatRangeLabel('2026-06-15', '2026-06-19')).toBe('Jun 15 → 19');
    });
    it('formats a cross-month range without the year if same year', () => {
      expect(formatRangeLabel('2026-06-28', '2026-09-26')).toBe('Jun 28 → Sep 26');
    });
    it('formats a cross-year range with both years', () => {
      expect(formatRangeLabel('2026-12-30', '2027-01-04')).toBe('Dec 30, 2026 → Jan 4, 2027');
    });
    it('falls back to the raw values when the start is not a three-part date', () => {
      expect(formatRangeLabel('2026-06', '2026-06-19')).toBe('2026-06 → 2026-06-19');
    });
    it('falls back to the raw values when the end is not a three-part date', () => {
      expect(formatRangeLabel('2026-06-15', '2026-07')).toBe('2026-06-15 → 2026-07');
    });
  });

  describe('readableTextOn', () => {
    it('picks dark ink for a very light pastel yellow', () => {
      expect(readableTextOn('#FCE7A1')).toBe('#1F1B16');
    });
    it('picks dark ink for white', () => {
      expect(readableTextOn('#FFFFFF')).toBe('#1F1B16');
    });
    it('picks inverse cream for the seeded blue', () => {
      expect(readableTextOn('#3B82F6')).toBe('#F5EFE4');
    });
    it('picks inverse cream for dark purple', () => {
      expect(readableTextOn('#1F1B16')).toBe('#F5EFE4');
    });
    it('expands 3-digit hex shorthand', () => {
      expect(readableTextOn('#FFF')).toBe('#1F1B16');
    });
    it('returns ink for malformed hex', () => {
      expect(readableTextOn('not-a-color')).toBe('#1F1B16');
    });
    it('returns ink for a six-character value that is not hex', () => {
      expect(readableTextOn('#ZZZZZZ')).toBe('#1F1B16');
    });
    it('uses the linear segment for channels at or below the dark threshold', () => {
      expect(readableTextOn('#000000')).toBe('#F5EFE4');
      expect(readableTextOn('#0A0A0A')).toBe('#F5EFE4');
    });
    it('uses the power segment for channels just above the dark threshold', () => {
      expect(readableTextOn('#0B0B0B')).toBe('#F5EFE4');
    });
  });

  describe('addDays', () => {
    it('adds days within the same month', () => {
      expect(addDays('2026-06-01', 5)).toBe('2026-06-06');
    });
    it('crosses a month boundary', () => {
      expect(addDays('2026-06-28', 5)).toBe('2026-07-03');
    });
    it('crosses a year boundary', () => {
      expect(addDays('2026-12-30', 5)).toBe('2027-01-04');
      expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    });
    it('returns the same value for zero delta', () => {
      expect(addDays('2026-06-15', 0)).toBe('2026-06-15');
    });
    it('handles negative deltas', () => {
      expect(addDays('2026-06-01', -1)).toBe('2026-05-31');
    });
    it('returns the input for malformed ISO', () => {
      expect(addDays('not-a-date', 5)).toBe('not-a-date');
    });
    it('returns the input for a non-padded ISO date', () => {
      expect(addDays('2026-6-15', 5)).toBe('2026-6-15');
    });
    it('returns the input for a full ISO timestamp', () => {
      expect(addDays('2026-06-15T00:00:00Z', 5)).toBe('2026-06-15T00:00:00Z');
    });
    it('adds a day to a leap day', () => {
      expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
      expect(addDays('2028-02-28', 2)).toBe('2028-03-01');
    });
  });

  describe('todayIso', () => {
    it('returns a valid ISO date string for today', () => {
      const iso = todayIso();
      expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const now = new Date();
      expect(iso).toBe(
        `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`,
      );
    });
  });

  describe('listWindow', () => {
    it('returns a 90-day window starting at the given date', () => {
      const w = listWindow('2026-06-01', 90);
      expect(w.start).toBe('2026-06-01');
      expect(w.end).toBe('2026-08-30');
    });
    it('produces a human-readable label', () => {
      const w = listWindow('2026-06-27', 90);
      expect(w.label).toBe('Jun 27 – Sep 25, 2026');
    });
    it('labels a window that crosses a year boundary', () => {
      const w = listWindow('2026-12-01', 90);
      expect(w.start).toBe('2026-12-01');
      expect(w.end).toBe('2027-03-01');
      expect(w.label).toBe('Dec 1 – Mar 1, 2027');
    });
  });

  describe('formatYearMonth', () => {
    it('formats a known month', () => {
      expect(formatYearMonth({ year: 2026, month: 5 })).toBe('June 2026');
    });
    it('formats the first and last months of a year', () => {
      expect(formatYearMonth({ year: 2026, month: 0 })).toBe('January 2026');
      expect(formatYearMonth({ year: 2026, month: 11 })).toBe('December 2026');
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
    it('returns false when the start or end of the range is malformed', () => {
      expect(dayCovers('2026-05-12', 'nope', '2026-05-15')).toBe(false);
      expect(dayCovers('2026-05-12', '2026-05-11', 'nope')).toBe(false);
    });
    it('returns false when the range is reversed', () => {
      expect(dayCovers('2026-05-12', '2026-05-15', '2026-05-11')).toBe(false);
    });
    it('delegates correctly through ptoCoversDay', () => {
      expect(ptoCoversDay({ startDate: '2026-05-11', endDate: '2026-05-15' }, '2026-05-12')).toBe(
        true,
      );
    });
    it('returns false through ptoCoversDay when the PTO range is malformed', () => {
      expect(ptoCoversDay({ startDate: '2026-05-11', endDate: 'nope' }, '2026-05-12')).toBe(false);
    });
  });

  describe('dayPartLabel', () => {
    const expected: Array<[DayPart, string]> = [
      ['morning', 'AM'],
      ['evening', 'PM'],
      ['all_day', 'Full'],
    ];

    it.each(expected)('labels %s as %s', (dp, label) => {
      expect(dayPartLabel(dp)).toBe(label);
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
    it('returns ? for a whitespace-only name', () => {
      expect(initials('   ')).toBe('?');
    });
    it('uppercases a lowercase name', () => {
      expect(initials('alice johnson')).toBe('AJ');
    });
    it('returns a single letter for a one-character name', () => {
      expect(initials('A')).toBe('A');
    });
  });
});
