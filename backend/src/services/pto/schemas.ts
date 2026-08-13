import { z } from 'zod';
import { CalendarRangeSchema } from '../calendar/range.js';

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DayPartSchema = z.enum(['morning', 'evening', 'all_day']);

export const CreatePtoSchema = z.object({
  startDate: z.string().regex(ISO_DATE),
  endDate: z.string().regex(ISO_DATE),
  dayPart: DayPartSchema.optional(),
  note: z.string().max(500).optional(),
});

export const RangeQuerySchema = CalendarRangeSchema;

export const IdParamSchema = z.string().regex(UUID_REGEX);

export type CreatePtoInput = z.infer<typeof CreatePtoSchema>;
export type RangeQueryInput = z.infer<typeof RangeQuerySchema>;
export type IdParam = z.infer<typeof IdParamSchema>;
