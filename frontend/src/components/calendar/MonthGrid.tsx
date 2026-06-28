import { DayCell } from './DayCell';
import type { CalendarDay } from '../../lib/calendar';
import type { PTOWithUser } from '../../types/api';

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export interface MonthGridProps {
  weeks: CalendarDay[][];
  ptoList: PTOWithUser[];
  onChipClick: (pto: PTOWithUser) => void;
  onDayClick?: (iso: string) => void;
}

export function MonthGrid({
  weeks,
  ptoList,
  onChipClick,
  onDayClick,
}: MonthGridProps): JSX.Element {
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <div
        role="grid"
        aria-label="Month grid"
        className="min-w-[480px] rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
      >
        <div
          role="row"
          className="sticky top-0 z-10 grid grid-cols-7 border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
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
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
