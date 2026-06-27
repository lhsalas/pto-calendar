import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DayCell } from '../../src/components/calendar/DayCell';
import { STUB_PTO } from '../mocks/handlers';
import type { CalendarDay } from '../../src/lib/calendar';
import type { PTOWithUser } from '../../src/types/api';

const IN_MONTH_DAY: CalendarDay = { iso: '2026-05-13', dayOfMonth: 13, isInMonth: true };
const OUT_OF_MONTH_DAY: CalendarDay = { iso: '2026-05-31', dayOfMonth: 31, isInMonth: false };

function ptoOn(iso: string): PTOWithUser {
  return { ...STUB_PTO, id: `pto-${iso}`, startDate: iso, endDate: iso };
}

describe('DayCell', () => {
  it('renders the day number for in-month days', () => {
    render(<DayCell day={IN_MONTH_DAY} ptoList={[]} onChipClick={() => {}} />);
    const cell = screen.getByTestId('day-cell-2026-05-13');
    expect(cell).toHaveTextContent('13');
  });

  it('renders PTOs that cover the day', () => {
    render(<DayCell day={IN_MONTH_DAY} ptoList={[ptoOn('2026-05-13')]} onChipClick={() => {}} />);
    expect(screen.getByRole('button', { name: /team lead/i })).toBeInTheDocument();
  });

  it('omits PTOs that do not cover the day', () => {
    render(<DayCell day={IN_MONTH_DAY} ptoList={[ptoOn('2026-05-14')]} onChipClick={() => {}} />);
    expect(screen.queryByRole('button', { name: /team lead/i })).not.toBeInTheDocument();
  });

  it('shows a +N more pill when more than 3 PTOs cover the day', () => {
    const many = [1, 2, 3, 4, 5].map((i) => ({ ...ptoOn('2026-05-13'), id: `pto-${i}` }));
    render(<DayCell day={IN_MONTH_DAY} ptoList={many} onChipClick={() => {}} />);
    expect(screen.getByText('+2 more')).toBeInTheDocument();
  });

  it('passes the PTO to onChipClick when a chip is clicked', async () => {
    const user = userEvent.setup();
    const onChipClick = vi.fn();
    const pto = ptoOn('2026-05-13');
    render(<DayCell day={IN_MONTH_DAY} ptoList={[pto]} onChipClick={onChipClick} />);
    await user.click(screen.getByRole('button', { name: /team lead/i }));
    expect(onChipClick).toHaveBeenCalledWith(pto);
  });

  it('does not show a +N more pill for exactly 3 chips', () => {
    const three = [1, 2, 3].map((i) => ({ ...ptoOn('2026-05-13'), id: `pto-${i}` }));
    render(<DayCell day={IN_MONTH_DAY} ptoList={three} onChipClick={() => {}} />);
    expect(screen.queryByText(/more/)).not.toBeInTheDocument();
  });

  it('renders out-of-month days without the in-month emphasis', () => {
    render(<DayCell day={OUT_OF_MONTH_DAY} ptoList={[]} onChipClick={() => {}} />);
    expect(screen.getByTestId('day-cell-2026-05-31')).toHaveTextContent('31');
  });
});
