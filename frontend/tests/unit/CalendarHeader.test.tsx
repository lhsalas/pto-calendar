import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarHeader } from '../../src/components/calendar/CalendarHeader';

describe('CalendarHeader', () => {
  function renderHeader(
    overrides: Partial<React.ComponentProps<typeof CalendarHeader>> = {},
  ): void {
    const props: React.ComponentProps<typeof CalendarHeader> = {
      label: 'June 2026',
      view: 'grid',
      onViewChange: () => {},
      onPrev: () => {},
      onNext: () => {},
      onToday: () => {},
      todayDisabled: false,
      ...overrides,
    };
    render(<CalendarHeader {...props} />);
  }

  it('shows the provided label', () => {
    renderHeader({ label: 'Jul – Sep 2026' });
    expect(screen.getByTestId('header-label')).toHaveTextContent('Jul – Sep 2026');
  });

  it('invokes onPrev when the previous button is clicked', async () => {
    const user = userEvent.setup();
    const onPrev = vi.fn();
    renderHeader({ onPrev });
    await user.click(screen.getByRole('button', { name: /previous/i }));
    expect(onPrev).toHaveBeenCalled();
  });

  it('invokes onNext when the next button is clicked', async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    renderHeader({ onNext });
    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(onNext).toHaveBeenCalled();
  });

  it('invokes onToday when the Today button is clicked', async () => {
    const user = userEvent.setup();
    const onToday = vi.fn();
    renderHeader({ onToday });
    await user.click(screen.getByTestId('today-button'));
    expect(onToday).toHaveBeenCalledTimes(1);
  });

  it('disables the Today button when todayDisabled is true', () => {
    renderHeader({ todayDisabled: true });
    expect(screen.getByTestId('today-button')).toBeDisabled();
  });

  it('enables the Today button when todayDisabled is false', () => {
    renderHeader({ todayDisabled: false });
    expect(screen.getByTestId('today-button')).not.toBeDisabled();
  });

  it('invokes onViewChange when a view option is clicked', async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    renderHeader({ onViewChange });
    await user.click(screen.getByTestId('view-option-list'));
    expect(onViewChange).toHaveBeenCalledWith('list');
  });

  it('marks the active view as the checked radio', () => {
    renderHeader({ view: 'list' });
    expect(screen.getByRole('radio', { name: /show upcoming pto list/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: /show month grid/i })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });
});
