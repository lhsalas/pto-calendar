import { motion } from 'motion/react';
import type { Holiday } from '../../types/api';

const COUNTRY_FLAG: Record<string, string> = {
  US: '🇺🇸',
  MX: '🇲🇽',
  CO: '🇨🇴',
  CL: '🇨🇱',
};

export interface HolidayBadgeProps {
  holiday: Holiday;
  /** Stacking index — used to offset multiple badges on the same day. */
  index?: number;
}

export function HolidayBadge({ holiday, index = 0 }: HolidayBadgeProps): JSX.Element {
  const flag = holiday.countryCode ? COUNTRY_FLAG[holiday.countryCode] : '🏳️';
  const title = holiday.countryCode ? `${holiday.name} (${holiday.countryCode})` : holiday.name;
  return (
    <motion.span
      data-testid={`holiday-badge-${holiday.date}-${holiday.countryCode ?? 'NONE'}`}
      data-country={holiday.countryCode ?? ''}
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.18, delay: index * 0.04 }}
      title={title}
      aria-label={`Public holiday: ${title}`}
      className="inline-flex max-w-full items-center gap-0.5 truncate rounded-sm border border-holiday/40 bg-holiday/15 px-1 text-[10px] font-medium text-holiday dark:border-holiday-dark/40 dark:bg-holiday-dark/20 dark:text-holiday-dark"
      style={{ marginTop: index === 0 ? 0 : 1 }}
    >
      <span aria-hidden="true" className="text-[11px] leading-none">
        {flag}
      </span>
      <span className="truncate">{holiday.name}</span>
    </motion.span>
  );
}
