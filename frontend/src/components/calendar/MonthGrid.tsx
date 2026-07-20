import { DayCell } from './DayCell';
import type { CalendarDay } from '../../lib/calendar';
import type { Holiday, PTOWithUser } from '../../types/api';

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export interface MonthGridProps {
  weeks: CalendarDay[][];
  ptoList: PTOWithUser[];
  onChipClick: (pto: PTOWithUser) => void;
  onDayClick?: (iso: string) => void;
  holidays?: Holiday[];
}

export function MonthGrid({
  weeks,
  ptoList,
  onChipClick,
  onDayClick,
  holidays = [],
}: MonthGridProps): JSX.Element {
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <div
        role="grid"
        aria-label="Month grid"
        className="min-w-[480px] rounded-lg border border-border bg-surface-3 shadow-sm dark:border-border-dark dark:bg-surface-dark-3"
      >
        <div
          role="row"
          className="sticky top-0 z-10 grid grid-cols-7 border-b border-border bg-surface-2 font-mono text-[11px] uppercase tracking-wider text-ink-muted dark:border-border-dark dark:bg-surface-dark-2 dark:text-ink-muted-dark"
        >
          {WEEKDAY_LABELS.map((label) => (
            <div key={label} role="columnheader" className="px-2 py-1.5 text-center">
              {label}
            </div>
          ))}
        </div>
        {weeks.map((week, rowIdx) => (
          <div key={rowIdx} role="row" className="grid grid-cols-7">
            {week.map((day) => (
              <DayCell
                key={day.iso}
                day={day}
                ptoList={ptoList}
                onChipClick={onChipClick}
                {...(onDayClick ? { onDayClick } : {})}
                holidays={holidays}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
