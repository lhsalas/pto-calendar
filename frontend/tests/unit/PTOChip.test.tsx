import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PTOChip } from '../../src/components/pto/PTOChip';
import { STUB_PTO } from '../mocks/handlers';

describe('PTOChip', () => {
  it('renders the user initials, name, and day-part label for a single-day PTO', () => {
    render(<PTOChip pto={STUB_PTO} />);
    const button = screen.getByRole('button', { name: /team lead.*am/i });
    expect(button).toBeInTheDocument();
    expect(button).toHaveTextContent(/tl/i);
    expect(button).toHaveTextContent(/team lead/i);
    expect(button).toHaveTextContent(/am/i);
  });

  it('hides the day-part label for multi-day PTOs', () => {
    render(<PTOChip pto={{ ...STUB_PTO, endDate: '2026-05-15' }} />);
    const button = screen.getByRole('button', { name: /team lead/i });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute('title', expect.stringMatching(/full/i));
  });

  it('invokes onClick with the PTO when clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<PTOChip pto={STUB_PTO} onClick={onClick} />);
    await user.click(screen.getByRole('button', { name: /team lead/i }));
    expect(onClick).toHaveBeenCalledWith(STUB_PTO);
  });
});
