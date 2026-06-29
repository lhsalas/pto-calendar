import { describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../src/context/ToastProvider';
import { ToastViewport } from '../../src/components/common/ToastViewport';
import { useToast } from '../../src/hooks/useToast';

function Pusher({ tone, title }: { tone: 'success' | 'error'; title: string }): JSX.Element {
  const { push } = useToast();
  return (
    <button
      type="button"
      onClick={() => {
        push({ tone, title });
      }}
    >
      push {title}
    </button>
  );
}

function RePusher({ title, description }: { title: string; description: string }): JSX.Element {
  const { push } = useToast();
  return (
    <button
      type="button"
      onClick={() => {
        push({ tone: 'success', title, description });
      }}
    >
      push {description}
    </button>
  );
}

describe('ToastViewport', () => {
  it('caps the stack at 3 visible toasts (oldest auto-evicted)', async () => {
    render(
      <ToastProvider>
        <ToastViewport />
        <Pusher tone="success" title="alpha" />
        <Pusher tone="success" title="bravo" />
        <Pusher tone="success" title="charlie" />
        <Pusher tone="success" title="delta" />
      </ToastProvider>,
    );
    for (const title of ['alpha', 'bravo', 'charlie', 'delta']) {
      await act(async () => {
        screen.getByRole('button', { name: `push ${title}` }).click();
      });
    }
    await waitFor(() => {
      expect(screen.queryByText('alpha')).not.toBeInTheDocument();
    });
    expect(screen.getByText('bravo')).toBeInTheDocument();
    expect(screen.getByText('charlie')).toBeInTheDocument();
    expect(screen.getByText('delta')).toBeInTheDocument();
    expect(screen.getAllByTestId('toast-success')).toHaveLength(3);
  });

  it('dedupes same tone+title in place (updates timestamp and content)', async () => {
    render(
      <ToastProvider>
        <ToastViewport />
        <RePusher title="Saved." description="first" />
        <RePusher title="Saved." description="second" />
      </ToastProvider>,
    );
    await act(async () => {
      screen.getByRole('button', { name: 'push first' }).click();
    });
    expect(await screen.findByText('first')).toBeInTheDocument();
    await act(async () => {
      screen.getByRole('button', { name: 'push second' }).click();
    });
    await waitFor(() => {
      expect(screen.getByText('second')).toBeInTheDocument();
    });
    expect(screen.queryByText('first')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('toast-success')).toHaveLength(1);
  });
});
