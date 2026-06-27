import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarHeader } from '../../src/components/calendar/CalendarHeader';

describe('CalendarHeader', () => {
  it('shows the formatted month label', () => {
    render(
      <CalendarHeader yearMonth={{ year: 2026, month: 5 }} onPrev={() => {}} onNext={() => {}} />,
    );
    expect(screen.getByRole('heading', { name: /june 2026/i })).toBeInTheDocument();
  });

  it('invokes onPrev when the previous button is clicked', async () => {
    const user = userEvent.setup();
    const onPrev = vi.fn();
    render(
      <CalendarHeader yearMonth={{ year: 2026, month: 5 }} onPrev={onPrev} onNext={() => {}} />,
    );
    await user.click(screen.getByRole('button', { name: /previous month/i }));
    expect(onPrev).toHaveBeenCalled();
  });

  it('invokes onNext when the next button is clicked', async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    render(
      <CalendarHeader yearMonth={{ year: 2026, month: 5 }} onPrev={() => {}} onNext={onNext} />,
    );
    await user.click(screen.getByRole('button', { name: /next month/i }));
    expect(onNext).toHaveBeenCalled();
  });
});
