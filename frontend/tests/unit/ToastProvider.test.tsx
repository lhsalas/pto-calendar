import type { JSX, ReactNode } from 'react';
import { StrictMode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../src/context/ToastProvider';
import { useToast } from '../../src/hooks/useToast';

function wrapper({ children }: { children: ReactNode }): JSX.Element {
  return (
    <StrictMode>
      <ToastProvider>{children}</ToastProvider>
    </StrictMode>
  );
}

describe('ToastProvider batched updates', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('expires a deferred push even when its microtask runs before the render', async () => {
    const { result } = renderHook(() => useToast(), { wrapper });
    await act(async () => {
      result.current.push({ tone: 'success', title: 'first', durationMs: 500 });
    });
    await act(async () => {
      result.current.push({ tone: 'success', title: 'deferred', durationMs: 1000 });
      await Promise.resolve();
    });
    expect(result.current.toasts.map((toast) => toast.title)).toContain('deferred');
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.toasts).toEqual([]);
  });

  it('returns rendered IDs synchronously, coalesces duplicates and expires batched pushes', () => {
    const { result } = renderHook(() => useToast(), { wrapper });
    let first = '';
    let second = '';
    let duplicate = '';
    act(() => {
      first = result.current.push({ tone: 'success', title: 'first', durationMs: 1000 });
      second = result.current.push({ tone: 'error', title: 'second', durationMs: 2000 });
      duplicate = result.current.push({
        tone: 'success',
        title: 'first',
        description: 'updated',
        durationMs: 3000,
      });
    });
    expect(first).not.toBe('');
    expect(second).not.toBe('');
    expect(second).not.toBe(first);
    expect(duplicate).toBe(first);
    expect(result.current.toasts.map((toast) => toast.id)).toEqual([first, second]);
    expect(result.current.toasts[0]?.description).toBe('updated');
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.toasts.map((toast) => toast.id)).toEqual([first]);
    act(() => vi.advanceTimersByTime(999));
    expect(result.current.toasts.map((toast) => toast.id)).toEqual([first]);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.toasts).toEqual([]);
  });

  it('refreshes default expiry and clears timers on eviction, dismissal, and unmount', () => {
    const { result, unmount } = renderHook(() => useToast(), { wrapper });
    let first = '';
    let second = '';
    act(() => {
      first = result.current.push({ tone: 'success', title: 'one' });
      second = result.current.push({ tone: 'success', title: 'two' });
    });
    act(() => vi.advanceTimersByTime(2000));
    let refreshed = '';
    act(() => {
      refreshed = result.current.push({ tone: 'success', title: 'one' });
    });
    expect(refreshed).toBe(first);
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.toasts.map((toast) => toast.id)).toEqual([first]);
    expect(result.current.toasts.some((toast) => toast.id === second)).toBe(false);

    act(() => {
      result.current.push({ tone: 'success', title: 'three' });
      result.current.push({ tone: 'success', title: 'four' });
      result.current.push({ tone: 'error', title: 'five' });
    });
    expect(result.current.toasts.map((toast) => toast.title)).toEqual(['five', 'four', 'three']);
    expect(vi.getTimerCount()).toBe(3);
    act(() => result.current.dismiss(result.current.toasts[0]!.id));
    expect(vi.getTimerCount()).toBe(2);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(10000));
  });

  it('does not resurrect a dismissed toast when it is pushed again in the same batch', () => {
    const { result } = renderHook(() => useToast(), { wrapper });
    const action = { label: 'Retry', onClick: vi.fn() };
    let first = '';
    let replacement = '';
    act(() => {
      first = result.current.push({ tone: 'error', title: 'retry', action, durationMs: 500 });
      result.current.dismiss(first);
      replacement = result.current.push({
        tone: 'error',
        title: 'retry',
        action,
        durationMs: 1000,
      });
    });
    expect(first).not.toBe('');
    expect(replacement).not.toBe(first);
    expect(result.current.toasts).toMatchObject([{ id: replacement, action }]);
    act(() => vi.advanceTimersByTime(500));
    expect(result.current.toasts.map((toast) => toast.id)).toEqual([replacement]);
    act(() => vi.advanceTimersByTime(500));
    expect(result.current.toasts).toEqual([]);
  });
});
