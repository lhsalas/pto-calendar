import type { ReactNode } from 'react';
import { CalendarIcon, ListIcon } from '../icons';

export type ViewMode = 'grid' | 'list';

interface Option {
  value: ViewMode;
  label: string;
  aria: string;
  icon: ReactNode;
}

const OPTIONS: Option[] = [
  {
    value: 'grid',
    label: 'Calendar',
    aria: 'Show month grid',
    icon: <CalendarIcon aria-hidden className="h-4 w-4" />,
  },
  {
    value: 'list',
    label: 'List',
    aria: 'Show upcoming PTO list',
    icon: <ListIcon aria-hidden className="h-4 w-4" />,
  },
];

export interface ViewToggleProps {
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
}

export function ViewToggle({ view, onViewChange }: ViewToggleProps): JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label="View"
      data-testid="view-toggle"
      className="inline-flex overflow-hidden rounded border border-border text-xs dark:border-border-dark"
    >
      {OPTIONS.map((opt) => {
        const selected = view === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={opt.aria}
            data-testid={`view-option-${opt.value}`}
            onClick={() => onViewChange(opt.value)}
            className={`inline-flex min-h-11 items-center gap-2 px-3 py-2 text-sm transition-colors duration-150 ${
              selected
                ? 'bg-ink text-ink-inverse dark:bg-ink-dark dark:text-surface-dark'
                : 'bg-surface-3 text-ink hover:bg-surface-2 dark:bg-surface-dark-3 dark:text-ink-dark dark:hover:bg-surface-dark-2'
            }`}
          >
            {opt.icon}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
