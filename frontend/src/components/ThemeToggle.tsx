import type { ReactNode } from 'react';
import { useTheme } from '../context/useTheme';
import type { ThemeMode } from '../context/themeContextValue';
import { Monitor, Moon, Sun } from './icons';

interface Option {
  value: ThemeMode;
  label: string;
  aria: string;
  icon: ReactNode;
}

const OPTIONS: Option[] = [
  {
    value: 'light',
    label: 'Light',
    aria: 'Use light theme',
    icon: <Sun aria-hidden className="h-4 w-4" />,
  },
  {
    value: 'dark',
    label: 'Dark',
    aria: 'Use dark theme',
    icon: <Moon aria-hidden className="h-4 w-4" />,
  },
  {
    value: 'system',
    label: 'System',
    aria: 'Use system theme',
    icon: <Monitor aria-hidden className="h-4 w-4" />,
  },
];

export function ThemeToggle(): JSX.Element {
  const { mode, setMode } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      data-testid="theme-toggle"
      className="inline-flex overflow-hidden rounded border border-border text-xs dark:border-border-dark"
    >
      {OPTIONS.map((opt) => {
        const selected = mode === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={opt.aria}
            data-testid={`theme-option-${opt.value}`}
            onClick={() => setMode(opt.value)}
            className={`inline-flex min-h-11 items-center gap-2 px-3 py-2 text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:focus-visible:ring-offset-surface-dark ${
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
