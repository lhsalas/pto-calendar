export type ViewMode = 'grid' | 'list';

interface Option {
  value: ViewMode;
  label: string;
  aria: string;
}

const OPTIONS: Option[] = [
  { value: 'grid', label: 'Calendar', aria: 'Show month grid' },
  { value: 'list', label: 'List', aria: 'Show upcoming PTO list' },
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
      className="inline-flex overflow-hidden rounded border border-slate-300 text-xs dark:border-slate-600"
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
            className={`px-2.5 py-1 transition-colors ${
              selected
                ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                : 'bg-white text-slate-700 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
