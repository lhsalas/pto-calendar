import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { ThemeToggle } from '../../src/components/ThemeToggle';

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove('dark');
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});

function renderToggle(): void {
  render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
}

describe('ThemeToggle', () => {
  it('renders three radio buttons for Light, Dark, and System', () => {
    renderToggle();
    expect(screen.getByRole('radio', { name: /use light theme/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /use dark theme/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /use system theme/i })).toBeInTheDocument();
  });

  it('marks the current mode as the checked radio', () => {
    window.localStorage.setItem('pto-calendar-theme', 'dark');
    renderToggle();
    expect(screen.getByRole('radio', { name: /use dark theme/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('persists the chosen mode when a radio is clicked', async () => {
    const user = userEvent.setup();
    renderToggle();
    await user.click(screen.getByRole('radio', { name: /use dark theme/i }));
    expect(window.localStorage.getItem('pto-calendar-theme')).toBe('dark');
    expect(screen.getByRole('radio', { name: /use dark theme/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });
});
