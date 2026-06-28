import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { RefObject } from 'react';
import { useModalA11y } from '../../src/hooks/useModalA11y';

function TestModal({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const cardRef = useModalA11y<HTMLDivElement>(open, onClose);
  return (
    <div role="dialog" aria-modal="true">
      <div ref={cardRef} data-testid="card">
        <button>First</button>
        <button>Middle</button>
        <button>Last</button>
        <a href="#x">Link</a>
      </div>
    </div>
  );
}

function HiddenModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const cardRef = useModalA11y<HTMLDivElement>(open, onClose);
  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true">
      <div ref={cardRef}>
        <button>Only</button>
      </div>
    </div>
  );
}

describe('useModalA11y', () => {
  beforeEach(() => {
    document.body.style.overflow = '';
  });

  afterEach(() => {
    document.body.style.overflow = '';
  });

  it('does not lock scroll when closed', () => {
    render(<TestModal open={false} onClose={() => {}} />);
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('locks body scroll while open and restores it on close', () => {
    const { rerender, unmount } = render(<TestModal open onClose={() => {}} />);
    expect(document.body.style.overflow).toBe('hidden');
    rerender(<TestModal open={false} onClose={() => {}} />);
    expect(document.body.style.overflow).not.toBe('hidden');
    unmount();
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<TestModal open onClose={onClose} />);
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on non-Escape keys', () => {
    const onClose = vi.fn();
    render(<TestModal open onClose={onClose} />);
    act(() => {
      fireEvent.keyDown(document, { key: 'a' });
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cycles Tab from last focusable back to first', () => {
    render(<TestModal open onClose={() => {}} />);
    const first = screen.getByRole('button', { name: 'First' });
    const link = screen.getByRole('link');
    link.focus();
    act(() => {
      fireEvent.keyDown(document, { key: 'Tab' });
    });
    expect(document.activeElement).toBe(first);
  });

  it('cycles Shift+Tab from first focusable back to last', () => {
    render(<TestModal open onClose={() => {}} />);
    const first = screen.getByRole('button', { name: 'First' });
    const link = screen.getByRole('link');
    first.focus();
    act(() => {
      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    });
    expect(document.activeElement).toBe(link);
  });

  it('does not throw when mounted while open=false then re-opened', () => {
    const onClose = vi.fn();
    const { rerender } = render(<HiddenModal open={false} onClose={onClose} />);
    rerender(<HiddenModal open onClose={onClose} />);
    expect(screen.getByRole('button', { name: 'Only' })).toBeInTheDocument();
  });

  it('returns a stable ref object', () => {
    const refHolder: { current: RefObject<HTMLDivElement> | null } = { current: null };
    function Probe({ open }: { open: boolean }): null {
      refHolder.current = useModalA11y<HTMLDivElement>(open, () => {});
      return null;
    }
    const { rerender } = render(<Probe open />);
    const first = refHolder.current;
    rerender(<Probe open />);
    expect(refHolder.current).toBe(first);
  });
});
