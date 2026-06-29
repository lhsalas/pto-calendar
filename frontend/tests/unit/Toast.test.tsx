import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../../src/context/ToastProvider';
import { ToastViewport } from '../../src/components/common/ToastViewport';
import { useToast } from '../../src/hooks/useToast';

function Pusher(): JSX.Element {
  const { push } = useToast();
  return (
    <button
      type="button"
      onClick={() =>
        push({
          tone: 'success',
          title: 'PTO saved.',
          description: 'See you on the other side.',
          durationMs: 4000,
        })
      }
    >
      push
    </button>
  );
}

function ErrorPusher(): JSX.Element {
  const { push } = useToast();
  return (
    <button
      type="button"
      onClick={() =>
        push({
          tone: 'error',
          title: 'Could not load PTO.',
          action: { label: 'Retry', onClick: () => undefined },
        })
      }
    >
      push error
    </button>
  );
}

function ShortErrorPusher(): JSX.Element {
  const { push } = useToast();
  return (
    <button
      type="button"
      onClick={() =>
        push({
          tone: 'error',
          title: 'Boom.',
          action: { label: 'Retry', onClick: () => undefined },
          durationMs: 500,
        })
      }
    >
      push short error
    </button>
  );
}

function renderWithPusher(ui: React.ReactNode): ReturnType<typeof render> {
  return render(
    <ToastProvider>
      <ToastViewport />
      {ui}
    </ToastProvider>,
  );
}

describe('Toast', () => {
  it('renders a success toast with title and description', async () => {
    renderWithPusher(<Pusher />);
    await act(async () => {
      screen.getByRole('button', { name: 'push' }).click();
    });
    const toast = await screen.findByTestId('toast-success');
    expect(toast).toHaveTextContent(/pto saved\./i);
    expect(toast).toHaveTextContent(/see you on the other side/i);
    expect(screen.getByTestId('toast-icon')).toBeInTheDocument();
    expect(screen.getByTestId('toast-progress')).toBeInTheDocument();
  });

  it('renders an error toast with role=alert and aria-live=assertive', async () => {
    renderWithPusher(<ErrorPusher />);
    await act(async () => {
      screen.getByRole('button', { name: 'push error' }).click();
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
    expect(alert).toHaveTextContent(/could not load pto/i);
    expect(alert).toHaveTextContent(/retry/i);
  });

  it('dismisses via the close button', async () => {
    const user = userEvent.setup();
    renderWithPusher(<Pusher />);
    await act(async () => {
      screen.getByRole('button', { name: 'push' }).click();
    });
    const dismiss = await screen.findByTestId('toast-dismiss');
    await user.click(dismiss);
    await waitFor(() => {
      expect(screen.queryByTestId('toast-success')).not.toBeInTheDocument();
    });
  });

  it('invokes the action button and dismisses the toast', async () => {
    let clicked = 0;
    function ActionPusher(): JSX.Element {
      const { push } = useToast();
      return (
        <button
          type="button"
          onClick={() =>
            push({
              tone: 'error',
              title: 'Boom.',
              action: {
                label: 'Retry',
                onClick: () => {
                  clicked += 1;
                },
              },
            })
          }
        >
          push action
        </button>
      );
    }
    const user = userEvent.setup();
    renderWithPusher(<ActionPusher />);
    await act(async () => {
      screen.getByRole('button', { name: 'push action' }).click();
    });
    const action = await screen.findByTestId('toast-action');
    await user.click(action);
    expect(clicked).toBe(1);
    await waitFor(() => {
      expect(screen.queryByTestId('toast-error')).not.toBeInTheDocument();
    });
  });

  it('pauses the progress bar on hover and resumes on leave (RAF restarts)', async () => {
    const user = userEvent.setup();
    const { container } = renderWithPusher(<Pusher />);
    await act(async () => {
      screen.getByRole('button', { name: 'push' }).click();
    });
    const li = await screen.findByTestId('toast-success');
    const progress = container.querySelector('[data-testid="toast-progress"]') as HTMLElement;
    expect(progress).not.toBeNull();
    const before = Number(progress.getAttribute('data-progress'));
    await user.hover(li);
    expect(progress).toHaveAttribute('data-paused', 'true');
    await user.unhover(li);
    expect(progress).toHaveAttribute('data-paused', 'false');
    await waitFor(() => {
      const after = Number(progress.getAttribute('data-progress'));
      expect(after).toBeLessThanOrEqual(before);
    });
  });

  it('renders the sub-second remaining time in the sr-only label', async () => {
    renderWithPusher(<ShortErrorPusher />);
    await act(async () => {
      screen.getByRole('button', { name: 'push short error' }).click();
    });
    const toast = await screen.findByTestId('toast-error');
    const sr = toast.querySelector('.sr-only');
    expect(sr).not.toBeNull();
    expect(sr?.textContent).toMatch(/Auto-dismiss in \d+ms/);
  });

  it('auto-dismisses after durationMs', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderWithPusher(<Pusher />);
      await act(async () => {
        screen.getByRole('button', { name: 'push' }).click();
      });
      expect(screen.getByTestId('toast-success')).toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(4500);
      });
      await waitFor(() => {
        expect(screen.queryByTestId('toast-success')).not.toBeInTheDocument();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('Escape dismisses the topmost toast when the viewport has focus', async () => {
    renderWithPusher(<Pusher />);
    await act(async () => {
      screen.getByRole('button', { name: 'push' }).click();
    });
    const viewport = screen.getByTestId('toast-viewport');
    viewport.focus();
    fireEvent.keyDown(viewport, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('toast-success')).not.toBeInTheDocument();
    });
  });

  it('ignores non-Escape keys and Escape fired outside the viewport', async () => {
    renderWithPusher(<Pusher />);
    await act(async () => {
      screen.getByRole('button', { name: 'push' }).click();
    });
    const viewport = screen.getByTestId('toast-viewport');
    viewport.focus();
    fireEvent.keyDown(viewport, { key: 'Enter' });
    expect(screen.getByTestId('toast-success')).toBeInTheDocument();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    fireEvent.keyDown(outside, { key: 'Escape' });
    expect(screen.getByTestId('toast-success')).toBeInTheDocument();
    document.body.removeChild(outside);
  });
});
