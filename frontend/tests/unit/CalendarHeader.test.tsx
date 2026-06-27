import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarHeader } from '../../src/components/calendar/CalendarHeader';
import { currentYearMonth, addMonths } from '../../src/lib/calendar';

describe('CalendarHeader', () => {
  it('shows the formatted month label', () => {
    render(
      <CalendarHeader
        yearMonth={{ year: 2026, month: 5 }}
        onPrev={() => {}}
        onNext={() => {}}
        onToday={() => {}}
      />,
    );
    expect(screen.getByRole('heading', { name: /june 2026/i })).toBeInTheDocument();
  });

  it('invokes onPrev when the previous button is clicked', async () => {
    const user = userEvent.setup();
    const onPrev = vi.fn();
    render(
      <CalendarHeader
        yearMonth={{ year: 2026, month: 5 }}
        onPrev={onPrev}
        onNext={() => {}}
        onToday={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /previous month/i }));
    expect(onPrev).toHaveBeenCalled();
  });

  it('invokes onNext when the next button is clicked', async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    render(
      <CalendarHeader
        yearMonth={{ year: 2026, month: 5 }}
        onPrev={() => {}}
        onNext={onNext}
        onToday={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /next month/i }));
    expect(onNext).toHaveBeenCalled();
  });

  it('invokes onToday when the Today button is clicked', async () => {
    const user = userEvent.setup();
    const onToday = vi.fn();
    render(
      <CalendarHeader
        yearMonth={addMonths(currentYearMonth(), 2)}
        onPrev={() => {}}
        onNext={() => {}}
        onToday={onToday}
      />,
    );
    await user.click(screen.getByTestId('today-button'));
    expect(onToday).toHaveBeenCalledTimes(1);
  });

  it('disables the Today button when already on the current month', () => {
    render(
      <CalendarHeader
        yearMonth={currentYearMonth()}
        onPrev={() => {}}
        onNext={() => {}}
        onToday={() => {}}
      />,
    );
    expect(screen.getByTestId('today-button')).toBeDisabled();
  });

  it('enables the Today button when on a different month', () => {
    render(
      <CalendarHeader
        yearMonth={addMonths(currentYearMonth(), 1)}
        onPrev={() => {}}
        onNext={() => {}}
        onToday={() => {}}
      />,
    );
    expect(screen.getByTestId('today-button')).not.toBeDisabled();
  });
});
