import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MonthGrid } from '../../src/components/calendar/MonthGrid';
import { grid } from '../../src/lib/calendar';
import { STUB_PTO } from '../mocks/handlers';

describe('MonthGrid', () => {
  it('renders 7 weekday header labels and 6 weeks of cells', () => {
    const { weeks } = grid({ year: 2026, month: 5 });
    render(<MonthGrid weeks={weeks} ptoList={[]} onChipClick={() => {}} />);
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach((label) => {
      expect(screen.getByText(label)).toBeInTheDocument();
    });
    expect(screen.getAllByRole('row')).toHaveLength(7);
    expect(screen.getAllByTestId(/^day-cell-/)).toHaveLength(42);
  });

  it('passes a chip click through to the onChipClick handler', async () => {
    const user = userEvent.setup();
    const { weeks } = grid({ year: 2026, month: 4 });
    const onChipClick = vi.fn();
    const inMonth = weeks.flat().find((d) => d.isInMonth && d.dayOfMonth === 11);
    expect(inMonth).toBeDefined();
    const pto = { ...STUB_PTO, startDate: inMonth!.iso, endDate: inMonth!.iso };
    render(<MonthGrid weeks={weeks} ptoList={[pto]} onChipClick={onChipClick} />);
    await user.click(screen.getByRole('button', { name: /team lead/i }));
    expect(onChipClick).toHaveBeenCalledWith(pto);
  });
});
