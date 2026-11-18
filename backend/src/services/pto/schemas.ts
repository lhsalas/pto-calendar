import { z } from 'zod';
import {
  CalendarRangeSchema,
  MAX_CALENDAR_PAGE_SIZE,
  MIN_CALENDAR_PAGE_SIZE,
} from '../calendar/range.js';
import { verifyCursor, type CalendarCursor } from '../calendar/cursor.js';

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A single canonical decimal integer: no sign, no leading zeros, no fraction,
 * no exponent and no surrounding whitespace. `limit=0100` and `limit=1e2` are
 * rejected instead of being coerced.
 */
export const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)$/;

export const DayPartSchema = z.enum(['morning', 'evening', 'all_day']);

export const CreatePtoSchema = z.object({
  startDate: z.string().regex(ISO_DATE),
  endDate: z.string().regex(ISO_DATE),
  dayPart: DayPartSchema.optional(),
  note: z.string().max(500).optional(),
});

export const RangeQuerySchema = CalendarRangeSchema;

/**
 * The `GET /pto` query contract.
 *
 * Without `format=page` the response stays the legacy array with its 1,000-row
 * cap. `format=page` opts in to the `{ items, nextCursor, hasMore }` envelope
 * with a bounded page size and a validated continuation cursor. `limit` and
 * `cursor` are page-mode-only, so a caller can never believe a silent cap was
 * a page boundary.
 */
export const PtoListQuerySchema = RangeQuerySchema.extend({
  userId: z
    .string()
    .regex(UUID_REGEX, 'userId must be a UUID')
    .transform((value) => value.toLowerCase())
    .optional(),
  format: z.literal('page').optional(),
  limit: z
    .string()
    .regex(CANONICAL_DECIMAL, 'limit must be a decimal integer')
    .transform((value) => Number(value))
    .optional(),
  cursor: z.string().optional(),
})
  .superRefine((query, ctx) => {
    const paged = query.format === 'page';
    if (query.limit !== undefined) {
      if (!paged) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['limit'],
          message: 'limit is only supported with format=page',
        });
      } else if (query.limit < MIN_CALENDAR_PAGE_SIZE || query.limit > MAX_CALENDAR_PAGE_SIZE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['limit'],
          message: `limit must be between ${MIN_CALENDAR_PAGE_SIZE} and ${MAX_CALENDAR_PAGE_SIZE}`,
        });
      }
    }
    if (query.cursor !== undefined && !paged) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cursor'],
        message: 'cursor is only supported with format=page',
      });
    }
  })
  .transform((query, ctx) => {
    const userId = query.userId ?? null;
    if (query.cursor === undefined) {
      return { ...query, userId, cursor: null };
    }
    // A malformed, tampered, rotated or mismatched cursor is one generic
    // failure: the response never echoes the cursor or says which check failed.
    const verified = verifyCursor(query.cursor, {
      start: query.start,
      end: query.end,
      userId,
    });
    if (!verified) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cursor'],
        message: 'cursor is invalid',
      });
      return z.NEVER;
    }
    return { ...query, userId, cursor: verified };
  });

export const IdParamSchema = z.string().regex(UUID_REGEX);

export type CreatePtoInput = z.infer<typeof CreatePtoSchema>;
export type RangeQueryInput = z.infer<typeof RangeQuerySchema>;
export type PtoListQuery = z.infer<typeof PtoListQuerySchema>;
export type IdParam = z.infer<typeof IdParamSchema>;
export type { CalendarCursor };
