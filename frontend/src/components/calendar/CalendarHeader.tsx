import { formatYearMonth, type YearMonth } from '../../lib/calendar';

export interface CalendarHeaderProps {
  yearMonth: YearMonth;
  onPrev: () => void;
  onNext: () => void;
}

export function CalendarHeader({ yearMonth, onPrev, onNext }: CalendarHeaderProps): JSX.Element {
  return (
    <div className="mb-3 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onPrev}
          aria-label="Previous month"
          className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          ‹
        </button>
        <button
          type="button"
          onClick={onNext}
          aria-label="Next month"
          className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          ›
        </button>
        <h2 className="ml-2 text-lg font-semibold text-slate-900">{formatYearMonth(yearMonth)}</h2>
      </div>
    </div>
  );
}
