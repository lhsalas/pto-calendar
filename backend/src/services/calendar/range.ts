import { z } from 'zod';

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_CALENDAR_RANGE_DAYS = 366;
export const MAX_CALENDAR_RESULTS = 1000;

function toUtcDate(value: string): Date | null {
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
