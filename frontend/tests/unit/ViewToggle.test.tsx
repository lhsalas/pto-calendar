import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ViewToggle, type ViewMode } from '../../src/components/calendar/ViewToggle';

function renderToggle(view: ViewMode = 'grid'): { onViewChange: ReturnType<typeof vi.fn> } {
  const onViewChange = vi.fn();
  render(<ViewToggle view={view} onViewChange={onViewChange} />);
  return { onViewChange };
}

describe('ViewToggle', () => {
  it('renders two radio buttons for Calendar and List', () => {
    renderToggle();
    expect(screen.getByRole('radio', { name: /show month grid/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /show upcoming pto list/i })).toBeInTheDocument();
  });

  it('marks the active view as the checked radio', () => {
    renderToggle('list');
    expect(screen.getByRole('radio', { name: /show upcoming pto list/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: /show month grid/i })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('invokes onViewChange with the clicked value', async () => {
    const { onViewChange } = renderToggle('grid');
    await userEvent.setup().click(screen.getByTestId('view-option-list'));
    expect(onViewChange).toHaveBeenCalledWith('list');
  });
});
