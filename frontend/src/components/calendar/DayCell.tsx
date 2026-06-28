import type { KeyboardEvent } from 'react';
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

  const baseClass = `flex h-28 flex-col gap-1 border border-slate-200 p-1.5 dark:border-slate-700 ${
    day.isInMonth
      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100'
      : 'bg-slate-50 text-slate-400 dark:bg-slate-950 dark:text-slate-600'
  }`;

  const interactiveClass = clickable
    ? 'cursor-pointer transition-colors hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 dark:hover:bg-slate-800'
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
        <span
          className={`font-semibold ${
            day.isInMonth
              ? 'text-slate-700 dark:text-slate-300'
              : 'text-slate-400 dark:text-slate-600'
          }`}
        >
          {day.dayOfMonth}
        </span>
        {overflow > 0 ? (
          <span className="rounded bg-slate-100 px-1 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
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
