import { z } from 'zod';

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const COUNTRY_CODE_REGEX = /^[A-Z]{2}$/;
export const SUPPORTED_COUNTRY_CODES = ['US', 'MX', 'CO', 'CL'] as const;
export type SupportedCountryCode = (typeof SUPPORTED_COUNTRY_CODES)[number];

export const RangeQuerySchema = z.object({
  start: z.string().regex(ISO_DATE, 'start must be YYYY-MM-DD'),
  end: z.string().regex(ISO_DATE, 'end must be YYYY-MM-DD'),
});

export const CreateHolidaySchema = z.object({
  date: z.string().regex(ISO_DATE, 'date must be YYYY-MM-DD'),
  name: z.string().min(1).max(120),
  countryCode: z
    .string()
    .regex(COUNTRY_CODE_REGEX, 'countryCode must be ISO 3166-1 alpha-2')
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? null : v)),
});

export const IdParamSchema = z.string().regex(UUID_REGEX);

export const SeedHolidaySchema = z.object({
  countryCode: z.enum(SUPPORTED_COUNTRY_CODES),
});

export type CreateHolidayInput = z.infer<typeof CreateHolidaySchema>;
export type RangeQueryInput = z.infer<typeof RangeQuerySchema>;
export type SeedHolidayInput = z.infer<typeof SeedHolidaySchema>;
