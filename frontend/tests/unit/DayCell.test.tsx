import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DayCell } from '../../src/components/calendar/DayCell';
import { STUB_PTO } from '../mocks/handlers';
import type { CalendarDay } from '../../src/lib/calendar';
import type { PTOWithUser } from '../../src/types/api';

const IN_MONTH_DAY: CalendarDay = {
  iso: '2026-05-13',
  dayOfMonth: 13,
  isInMonth: true,
  isToday: false,
};
const OUT_OF_MONTH_DAY: CalendarDay = {
  iso: '2026-05-31',
  dayOfMonth: 31,
  isInMonth: false,
  isToday: false,
};

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

  describe('clickable weekday cells (onDayClick provided)', () => {
    const MONDAY: CalendarDay = {
      iso: '2026-05-11',
      dayOfMonth: 11,
      isInMonth: true,
      isToday: false,
    };
    const SATURDAY: CalendarDay = {
      iso: '2026-05-16',
      dayOfMonth: 16,
      isInMonth: true,
      isToday: false,
    };
    const SUNDAY: CalendarDay = {
      iso: '2026-05-17',
      dayOfMonth: 17,
      isInMonth: true,
      isToday: false,
    };
    const OUT_OF_MONTH_MONDAY: CalendarDay = {
      iso: '2026-06-01',
      dayOfMonth: 1,
      isInMonth: false,
      isToday: false,
    };

    it('fires onDayClick with the ISO when a weekday cell is clicked', async () => {
      const user = userEvent.setup();
      const onDayClick = vi.fn();
      render(<DayCell day={MONDAY} ptoList={[]} onChipClick={() => {}} onDayClick={onDayClick} />);
      await user.click(screen.getByTestId('day-cell-2026-05-11'));
      expect(onDayClick).toHaveBeenCalledWith('2026-05-11');
    });

    it('fires onDayClick when Enter is pressed on a focused weekday cell', async () => {
      const user = userEvent.setup();
      const onDayClick = vi.fn();
      render(<DayCell day={MONDAY} ptoList={[]} onChipClick={() => {}} onDayClick={onDayClick} />);
      const cell = screen.getByTestId('day-cell-2026-05-11');
      cell.focus();
      await user.keyboard('{Enter}');
      expect(onDayClick).toHaveBeenCalledWith('2026-05-11');
    });

    it('fires onDayClick when Space is pressed on a focused weekday cell', async () => {
      const user = userEvent.setup();
      const onDayClick = vi.fn();
      render(<DayCell day={MONDAY} ptoList={[]} onChipClick={() => {}} onDayClick={onDayClick} />);
      const cell = screen.getByTestId('day-cell-2026-05-11');
      cell.focus();
      await user.keyboard(' ');
      expect(onDayClick).toHaveBeenCalledWith('2026-05-11');
    });

    it('does not fire onDayClick when a Saturday cell is clicked', async () => {
      const user = userEvent.setup();
      const onDayClick = vi.fn();
      render(
        <DayCell day={SATURDAY} ptoList={[]} onChipClick={() => {}} onDayClick={onDayClick} />,
      );
      await user.click(screen.getByTestId('day-cell-2026-05-16'));
      expect(onDayClick).not.toHaveBeenCalled();
    });

    it('does not fire onDayClick when a Sunday cell is clicked', async () => {
      const user = userEvent.setup();
      const onDayClick = vi.fn();
      render(<DayCell day={SUNDAY} ptoList={[]} onChipClick={() => {}} onDayClick={onDayClick} />);
      await user.click(screen.getByTestId('day-cell-2026-05-17'));
      expect(onDayClick).not.toHaveBeenCalled();
    });

    it('fires onDayClick when an out-of-month weekday cell is clicked', async () => {
      const user = userEvent.setup();
      const onDayClick = vi.fn();
      render(
        <DayCell
          day={OUT_OF_MONTH_MONDAY}
          ptoList={[]}
          onChipClick={() => {}}
          onDayClick={onDayClick}
        />,
      );
      await user.click(screen.getByTestId('day-cell-2026-06-01'));
      expect(onDayClick).toHaveBeenCalledWith('2026-06-01');
    });

    it('exposes role=button, tabIndex=0 and an aria-label on weekday cells', () => {
      render(<DayCell day={MONDAY} ptoList={[]} onChipClick={() => {}} onDayClick={() => {}} />);
      const cell = screen.getByTestId('day-cell-2026-05-11');
      expect(cell.getAttribute('role')).toBe('button');
      expect(cell.tabIndex).toBe(0);
      expect(cell.getAttribute('aria-label')).toMatch(/monday, may 11, 2026/i);
    });

    it('does not expose role=button or tabIndex=0 on weekend cells', () => {
      render(<DayCell day={SATURDAY} ptoList={[]} onChipClick={() => {}} onDayClick={() => {}} />);
      const cell = screen.getByTestId('day-cell-2026-05-16');
      expect(cell.getAttribute('role')).toBeNull();
      expect(cell.tabIndex).toBe(-1);
      expect(cell.getAttribute('aria-label')).toBeNull();
    });

    it('does not fire onDayClick when a chip inside the cell is clicked', async () => {
      const user = userEvent.setup();
      const onDayClick = vi.fn();
      const onChipClick = vi.fn();
      render(
        <DayCell
          day={MONDAY}
          ptoList={[ptoOn('2026-05-11')]}
          onChipClick={onChipClick}
          onDayClick={onDayClick}
        />,
      );
      await user.click(screen.getByRole('button', { name: /team lead/i }));
      expect(onDayClick).not.toHaveBeenCalled();
      expect(onChipClick).toHaveBeenCalledWith(ptoOn('2026-05-11'));
    });
  });

  describe('defensive: no onDayClick', () => {
    it('does not expose role=button or tabIndex when onDayClick is omitted', () => {
      render(
        <DayCell
          day={{ iso: '2026-05-11', dayOfMonth: 11, isInMonth: true, isToday: false }}
          ptoList={[]}
          onChipClick={() => {}}
        />,
      );
      const cell = screen.getByTestId('day-cell-2026-05-11');
      expect(cell.getAttribute('role')).toBeNull();
      expect(cell.tabIndex).toBe(-1);
    });
  });

  describe('today highlight', () => {
    it('renders the day number inside a terracotta circle when isToday is true', () => {
      const today: CalendarDay = {
        iso: '2026-05-13',
        dayOfMonth: 13,
        isInMonth: true,
        isToday: true,
      };
      render(<DayCell day={today} ptoList={[]} onChipClick={() => {}} />);
      const cell = screen.getByTestId('day-cell-2026-05-13');
      const circle = cell.querySelector('.bg-accent.rounded-full');
      expect(circle).not.toBeNull();
      expect(circle).toHaveTextContent('13');
      expect(circle).toHaveClass('bg-accent', 'text-ink-inverse', 'rounded-full');
    });

    it('does not render the terracotta circle when isToday is false', () => {
      render(<DayCell day={IN_MONTH_DAY} ptoList={[]} onChipClick={() => {}} />);
      const cell = screen.getByTestId('day-cell-2026-05-13');
      expect(cell.querySelector('.bg-accent.rounded-full')).toBeNull();
    });

    it('still renders chips correctly on the today cell', () => {
      const today: CalendarDay = {
        iso: '2026-05-13',
        dayOfMonth: 13,
        isInMonth: true,
        isToday: true,
      };
      render(<DayCell day={today} ptoList={[ptoOn('2026-05-13')]} onChipClick={() => {}} />);
      const cell = screen.getByTestId('day-cell-2026-05-13');
      expect(cell.querySelector('.bg-accent.rounded-full')).toHaveTextContent('13');
      expect(screen.getByRole('button', { name: /team lead/i })).toBeInTheDocument();
    });
  });

  describe('holiday overlay', () => {
    it('renders a holiday badge when the day matches a holiday', () => {
      const holidays = [{ id: 'h-1', date: '2026-05-13', name: "Mother's Day", countryCode: null }];
      render(
        <DayCell day={IN_MONTH_DAY} ptoList={[]} onChipClick={() => {}} holidays={holidays} />,
      );
      const badge = screen.getByTestId('holiday-badge-2026-05-13-NONE');
      expect(badge).toHaveTextContent("Mother's Day");
      expect(badge).toHaveAttribute('aria-label', "Public holiday: Mother's Day");
    });

    it('does not render a holiday badge for a day with no holidays', () => {
      render(<DayCell day={IN_MONTH_DAY} ptoList={[]} onChipClick={() => {}} holidays={[]} />);
      expect(screen.queryByTestId('holiday-badge-2026-05-13-NONE')).not.toBeInTheDocument();
    });

    it('stacks multiple holiday badges from different countries', () => {
      const holidays = [
        { id: 'h-1', date: '2026-05-13', name: 'US Day', countryCode: 'US' },
        { id: 'h-2', date: '2026-05-13', name: 'MX Day', countryCode: 'MX' },
      ];
      render(
        <DayCell day={IN_MONTH_DAY} ptoList={[]} onChipClick={() => {}} holidays={holidays} />,
      );
      expect(screen.getByTestId('holiday-badge-2026-05-13-US')).toBeInTheDocument();
      expect(screen.getByTestId('holiday-badge-2026-05-13-MX')).toBeInTheDocument();
      expect(screen.getByText('US Day')).toBeInTheDocument();
      expect(screen.getByText('MX Day')).toBeInTheDocument();
    });

    it('renders both the holiday badge and a PTO chip when both apply', () => {
      const holidays = [{ id: 'h-1', date: '2026-05-13', name: "Mother's Day", countryCode: null }];
      render(
        <DayCell
          day={IN_MONTH_DAY}
          ptoList={[ptoOn('2026-05-13')]}
          onChipClick={() => {}}
          holidays={holidays}
        />,
      );
      expect(screen.getByTestId('holiday-badge-2026-05-13-NONE')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /team lead/i })).toBeInTheDocument();
    });
  });
});
