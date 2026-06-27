import { PTOChip } from '../pto/PTOChip';
import { ptoCoversDay } from '../../lib/calendar';
import type { CalendarDay } from '../../lib/calendar';
import type { PTOWithUser } from '../../types/api';

const MAX_CHIPS = 3;

export interface DayCellProps {
  day: CalendarDay;
  ptoList: PTOWithUser[];
  onChipClick: (pto: PTOWithUser) => void;
}

export function DayCell({ day, ptoList, onChipClick }: DayCellProps): JSX.Element {
  const covering = ptoList.filter((p) => ptoCoversDay(p, day.iso));
  const visible = covering.slice(0, MAX_CHIPS);
  const overflow = covering.length - visible.length;

  return (
    <div
      data-testid={`day-cell-${day.iso}`}
      className={`flex h-28 flex-col gap-1 border border-slate-200 p-1.5 dark:border-slate-700 ${
        day.isInMonth
          ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100'
          : 'bg-slate-50 text-slate-400 dark:bg-slate-950 dark:text-slate-600'
      }`}
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
          <PTOChip key={p.id} pto={p} onClick={onChipClick} />
        ))}
      </div>
    </div>
  );
}
