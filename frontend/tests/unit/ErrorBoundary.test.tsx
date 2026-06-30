import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorBoundary } from '../../src/components/ErrorBoundary';

function Bomb({ shouldThrow }: { shouldThrow: boolean }): JSX.Element {
  if (shouldThrow) {
    throw new Error('boom from render');
  }
  return <div data-testid="bomb">safe</div>;
}

describe('ErrorBoundary', () => {
  it('renders children when no error is thrown', () => {
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('bomb')).toBeInTheDocument();
  });

  it('renders the fallback UI when a child throws during render', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={true} />
      </ErrorBoundary>,
    );
    expect(screen.queryByTestId('bomb')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/something went wrong/i);
    expect(screen.getByRole('button', { name: /back to calendar/i })).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('does NOT echo the raw error message into the fallback (no info leak)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={true} />
      </ErrorBoundary>,
    );
    const alertText = screen.getByRole('alert').textContent ?? '';
    expect(alertText).not.toContain('boom from render');
    errorSpy.mockRestore();
  });

  it('Back to calendar button assigns window.location', async () => {
    const original = window.location;
    const assignMock = vi.fn();
    // jsdom doesn't let us fully replace window.location; stub the assign
    // method instead.
    Object.defineProperty(window, 'location', {
      value: { ...original, assign: assignMock },
      writable: true,
      configurable: true,
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={true} />
      </ErrorBoundary>,
    );
    await user.click(screen.getByRole('button', { name: /back to calendar/i }));
    expect(assignMock).toHaveBeenCalledWith('/calendar');
    errorSpy.mockRestore();
    Object.defineProperty(window, 'location', { value: original, configurable: true });
  });
});
