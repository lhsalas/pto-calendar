import type { KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import { PTOChip } from '../pto/PTOChip';
import { formatLongDate, isWeekend, ptoCoversDay } from '../../lib/calendar';
import type { CalendarDay } from '../../lib/calendar';
import type { PTOWithUser } from '../../types/api';

const MAX_CHIPS = 3;

export interface DayCellProps {
  day: CalendarDay;
  ptoList: PTOWithUser[];
  onChipClick: (pto: PTOWithUser) => void;
  onDayClick?: (iso: string) => void;
}

export function DayCell({ day, ptoList, onChipClick, onDayClick }: DayCellProps): JSX.Element {
  const covering = ptoList.filter((p) => ptoCoversDay(p, day.iso));
  const visible = covering.slice(0, MAX_CHIPS);
  const overflow = covering.length - visible.length;
  const clickable = onDayClick !== undefined && !isWeekend(day.iso);

  function handleDayActivate(): void {
    onDayClick?.(day.iso);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleDayActivate();
    }
  }

  const baseClass = `flex h-28 flex-col gap-1 border border-border p-1.5 dark:border-border-dark ${
    day.isInMonth
      ? 'bg-surface-3 text-ink dark:bg-surface-dark-3 dark:text-ink-dark'
      : 'bg-surface text-ink-muted dark:bg-surface-dark dark:text-ink-muted-dark'
  }`;

  const interactiveClass = clickable
    ? 'cursor-pointer transition-colors duration-150 hover:bg-accent-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:hover:bg-accent-900/30 dark:focus-visible:ring-offset-surface-dark'
    : '';

  const cellProps = clickable
    ? {
        role: 'button',
        tabIndex: 0,
        'aria-label': `Create PTO for ${formatLongDate(day.iso)}`,
        onClick: handleDayActivate,
        onKeyDown: handleKeyDown,
      }
    : {};

  return (
    <div
      data-testid={`day-cell-${day.iso}`}
      className={`${baseClass} ${interactiveClass}`}
      {...cellProps}
    >
      <div className="flex items-center justify-between text-xs">
        {day.isToday ? (
          <motion.span
            initial={{ scale: 0.7 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 400, damping: 18 }}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-accent font-mono text-xs font-semibold tabular-nums text-ink-inverse"
          >
            {day.dayOfMonth}
          </motion.span>
        ) : (
          <span
            className={`font-mono font-medium tabular-nums ${
              day.isInMonth ? 'text-ink-muted dark:text-ink-muted-dark' : 'text-ink-muted/60'
            }`}
          >
            {day.dayOfMonth}
          </span>
        )}
        {overflow > 0 ? (
          <span className="rounded bg-surface-2 px-1 text-[10px] font-medium text-ink-muted dark:bg-surface-dark-2 dark:text-ink-muted-dark">
            +{overflow} more
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-0.5 overflow-hidden">
        {visible.map((p) => (
          <div key={p.id} onClick={clickable ? (e) => e.stopPropagation() : undefined}>
            <PTOChip pto={p} onClick={onChipClick} />
          </div>
        ))}
      </div>
    </div>
  );
}
