import { z } from 'zod';

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_CALENDAR_RANGE_DAYS = 366;
/**
 * Legacy array responses stay capped. The cap is a property of the legacy
 * representation only: the opt-in paged representation (#255) traverses
 * past it and reports completeness explicitly.
 */
export const MAX_CALENDAR_RESULTS = 1000;
/** Bounded page sizes for the opt-in paged representation. */
export const MIN_CALENDAR_PAGE_SIZE = 1;
export const DEFAULT_CALENDAR_PAGE_SIZE = 100;
export const MAX_CALENDAR_PAGE_SIZE = 200;
/** Maximum number of characters in one issued cursor envelope. */
export const MAX_CURSOR_LENGTH = 512;

/**
 * Parse a strict `YYYY-MM-DD` calendar date. The value must be a real date:
 * `2026-02-30` and `2026-13-01` are rejected instead of rolling over. The
 * holiday parser keeps its own semantics and is not routed through here.
 */
export function toUtcDate(value: string): Date | null {
  if (!ISO_DATE.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

/** True only for a strict, real `YYYY-MM-DD` calendar date. */
export function isRealIsoDate(value: string): boolean {
  return toUtcDate(value) !== null;
}

export const CalendarRangeSchema = z
  .object({
    start: z.string().regex(ISO_DATE, 'start must be YYYY-MM-DD'),
    end: z.string().regex(ISO_DATE, 'end must be YYYY-MM-DD'),
  })
  .superRefine(({ start, end }, ctx) => {
    const startDate = toUtcDate(start);
    const endDate = toUtcDate(end);
    if (!startDate || !endDate) {
      if (!startDate && ISO_DATE.test(start)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['start'],
          message: 'start is not a valid date',
        });
      }
      if (!endDate && ISO_DATE.test(end)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['end'],
          message: 'end is not a valid date',
        });
      }
      return;
    }
    const spanDays = (endDate.getTime() - startDate.getTime()) / 86_400_000 + 1;
    if (spanDays < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['end'],
        message: 'end cannot be before start',
      });
    } else if (spanDays > MAX_CALENDAR_RANGE_DAYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['end'],
        message: `date range cannot exceed ${MAX_CALENDAR_RANGE_DAYS} days`,
      });
    }
  });
