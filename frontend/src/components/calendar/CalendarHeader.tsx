import { formatYearMonth, isCurrentYearMonth, type YearMonth } from '../../lib/calendar';

export interface CalendarHeaderProps {
  yearMonth: YearMonth;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
}

export function CalendarHeader({
  yearMonth,
  onPrev,
  onNext,
  onToday,
}: CalendarHeaderProps): JSX.Element {
  const onCurrentMonth = isCurrentYearMonth(yearMonth);
  return (
    <div className="mb-3 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onPrev}
          aria-label="Previous month"
          className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          ‹
        </button>
        <button
          type="button"
          onClick={onNext}
          aria-label="Next month"
          className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          ›
        </button>
        <button
          type="button"
          onClick={onToday}
          aria-label="Jump to current month"
          data-testid="today-button"
          disabled={onCurrentMonth}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          Today
        </button>
        <h2 className="ml-2 text-lg font-semibold text-slate-900 dark:text-slate-100">
          {formatYearMonth(yearMonth)}
        </h2>
      </div>
    </div>
  );
}
