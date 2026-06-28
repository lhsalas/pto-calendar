import { ViewToggle, type ViewMode } from './ViewToggle';
import { ChevronLeft, ChevronRight } from '../icons';

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
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onPrev}
          aria-label="Previous"
          className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-md border border-border px-4 py-2 text-sm text-ink transition-colors duration-150 hover:bg-surface-2 dark:border-border-dark dark:text-ink-dark dark:hover:bg-surface-dark-2"
        >
          <ChevronLeft aria-hidden className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onNext}
          aria-label="Next"
          className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-md border border-border px-4 py-2 text-sm text-ink transition-colors duration-150 hover:bg-surface-2 dark:border-border-dark dark:text-ink-dark dark:hover:bg-surface-dark-2"
        >
          <ChevronRight aria-hidden className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onToday}
          aria-label="Jump to current period"
          data-testid="today-button"
          disabled={todayDisabled}
          className="min-h-11 rounded-md border border-border px-4 py-2 text-sm text-ink transition-colors duration-150 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60 dark:border-border-dark dark:text-ink-dark dark:hover:bg-surface-dark-2"
        >
          Today
        </button>
        <h2
          data-testid="header-label"
          className="ml-2 font-display text-2xl font-semibold tracking-tight text-ink dark:text-ink-dark"
        >
          {label}
        </h2>
      </div>
      <ViewToggle view={view} onViewChange={onViewChange} />
    </div>
  );
}
