import { ViewToggle, type ViewMode } from './ViewToggle';

export interface CalendarHeaderProps {
  label: string;
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  todayDisabled: boolean;
}

export function CalendarHeader({
  label,
  view,
  onViewChange,
  onPrev,
  onNext,
  onToday,
  todayDisabled,
}: CalendarHeaderProps): JSX.Element {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onPrev}
          aria-label="Previous"
          className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          ‹
        </button>
        <button
          type="button"
          onClick={onNext}
          aria-label="Next"
          className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          ›
        </button>
        <button
          type="button"
          onClick={onToday}
          aria-label="Jump to current period"
          data-testid="today-button"
          disabled={todayDisabled}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          Today
        </button>
        <h2
          data-testid="header-label"
          className="ml-2 text-lg font-semibold text-slate-900 dark:text-slate-100"
        >
          {label}
        </h2>
      </div>
      <ViewToggle view={view} onViewChange={onViewChange} />
    </div>
  );
}
