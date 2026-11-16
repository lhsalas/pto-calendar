import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Toast } from '../../src/components/common/Toast';
import type * as Motion from 'motion/react';

vi.mock('motion/react', async (importOriginal) => {
  const original = await importOriginal<typeof Motion>();
  return { ...original, useReducedMotion: () => true };
});

describe('Toast with reduced motion', () => {
  it('derives the zero progress display without changing the dismissal timer', () => {
    const onDismiss = vi.fn();
    render(
      <Toast
        toast={{
          id: 'one',
          tone: 'success',
          title: 'Saved',
          durationMs: 4000,
          createdAt: Date.now(),
        }}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByTestId('toast-progress')).toHaveAttribute('data-progress', '0.000');
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
