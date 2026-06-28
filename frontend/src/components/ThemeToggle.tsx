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
      className="inline-flex overflow-hidden rounded border border-slate-300 text-xs dark:border-slate-600"
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
            className={`inline-flex min-h-11 items-center gap-2 px-3 py-2 text-sm transition-colors ${
              selected
                ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                : 'bg-white text-slate-700 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'
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
