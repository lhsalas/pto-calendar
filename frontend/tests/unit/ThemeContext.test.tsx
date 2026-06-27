import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { useTheme } from '../../src/context/useTheme';
import type { ResolvedTheme, ThemeMode } from '../../src/context/themeContextValue';

type Listener = (event: { matches: boolean }) => void;

interface MqlMock {
  matches: boolean;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

function installMatchMedia(initialMatches: boolean): {
  setMatches: (next: boolean) => void;
  getMql: () => MqlMock;
} {
  let current = initialMatches;
  const listeners: Listener[] = [];
  const mql: MqlMock = {
    get matches() {
      return current;
    },
    addEventListener: vi.fn((_event: string, listener: Listener) => {
      listeners.push(listener);
    }),
    removeEventListener: vi.fn((_event: string, listener: Listener) => {
      const idx = listeners.indexOf(listener);
      if (idx >= 0) listeners.splice(idx, 1);
    }),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn((_query: string) => mql),
  );
  return {
    setMatches(next: boolean) {
      current = next;
      listeners.forEach((l) => l({ matches: next }));
    },
    getMql: () => mql,
  };
}

interface Probe {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (m: ThemeMode) => void;
}

function Probe({ onChange }: { onChange: (p: Probe) => void }): JSX.Element {
  const ctx = useTheme();
  onChange(ctx);
  return (
    <div>
      <span data-testid="mode">{ctx.mode}</span>
      <span data-testid="resolved">{ctx.resolved}</span>
      <button type="button" onClick={() => ctx.setMode('light')}>
        light
      </button>
      <button type="button" onClick={() => ctx.setMode('dark')}>
        dark
      </button>
      <button type="button" onClick={() => ctx.setMode('system')}>
        system
      </button>
    </div>
  );
}

function renderProbe(): { getProbe: () => Probe; rerender: () => void } {
  let latest: Probe | null = null;
  const utils = render(
    <ThemeProvider>
      <Probe onChange={(p) => (latest = p)} />
    </ThemeProvider>,
  );
  return {
    getProbe: () => latest as Probe,
    rerender: () =>
      utils.rerender(
        <ThemeProvider>
          <Probe onChange={(p) => (latest = p)} />
        </ThemeProvider>,
      ),
  };
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove('dark');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ThemeContext', () => {
  it('defaults to system mode and applies the dark class when the OS prefers dark', async () => {
    installMatchMedia(true);
    renderProbe();
    await waitFor(() => {
      expect(screen.getByTestId('mode')).toHaveTextContent('system');
      expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('resolves to light when the system preference is light', async () => {
    installMatchMedia(false);
    renderProbe();
    await waitFor(() => {
      expect(screen.getByTestId('resolved')).toHaveTextContent('light');
    });
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('reads a previously stored mode from localStorage', async () => {
    window.localStorage.setItem('pto-calendar-theme', 'dark');
    installMatchMedia(false);
    const { getProbe } = renderProbe();
    await waitFor(() => {
      expect(getProbe().mode).toBe('dark');
    });
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('persists mode changes to localStorage and updates the resolved theme', async () => {
    installMatchMedia(false);
    const { getProbe } = renderProbe();
    await waitFor(() => {
      expect(getProbe().mode).toBe('system');
    });
    act(() => getProbe().setMode('dark'));
    expect(window.localStorage.getItem('pto-calendar-theme')).toBe('dark');
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    act(() => getProbe().setMode('light'));
    expect(window.localStorage.getItem('pto-calendar-theme')).toBe('light');
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('reacts to live changes of prefers-color-scheme while in system mode', async () => {
    const mq = installMatchMedia(false);
    const { getProbe } = renderProbe();
    await waitFor(() => {
      expect(getProbe().mode).toBe('system');
      expect(screen.getByTestId('resolved')).toHaveTextContent('light');
    });
    act(() => mq.setMatches(true));
    await waitFor(() => {
      expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('ignores live changes of prefers-color-scheme when mode is explicit', async () => {
    const mq = installMatchMedia(false);
    window.localStorage.setItem('pto-calendar-theme', 'light');
    const { getProbe } = renderProbe();
    await waitFor(() => {
      expect(getProbe().mode).toBe('light');
    });
    act(() => mq.setMatches(true));
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
  });

  it('ignores an invalid stored value and falls back to system', async () => {
    window.localStorage.setItem('pto-calendar-theme', 'bogus');
    installMatchMedia(false);
    const { getProbe } = renderProbe();
    await waitFor(() => {
      expect(getProbe().mode).toBe('system');
    });
  });

  it('throws when useTheme is used outside a ThemeProvider', () => {
    const ProbeOutside = () => {
      useTheme();
      return null;
    };
    expect(() => render(<ProbeOutside />)).toThrow(/ThemeProvider/);
  });
});
