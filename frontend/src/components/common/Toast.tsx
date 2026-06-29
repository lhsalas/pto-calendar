import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { CheckCircle2, XCircle, X } from '../icons';
import type { Toast as ToastModel } from '../../context/ToastContext';

export interface ToastProps {
  toast: ToastModel;
  onDismiss: (id: string) => void;
}

function relativeAge(createdAt: number, now: number): string {
  const diff = Math.max(0, Math.floor((now - createdAt) / 1000));
  if (diff < 1) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  const minutes = Math.floor(diff / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 100) / 10;
  return `${seconds.toFixed(1)}s`;
}

export function Toast({ toast, onDismiss }: ToastProps): JSX.Element {
  const prefersReducedMotion = useReducedMotion();
  const isError = toast.tone === 'error';
  const Icon = isError ? XCircle : CheckCircle2;

  const [hovered, setHovered] = useState<boolean>(false);
  const [focusWithin, setFocusWithin] = useState<boolean>(false);
  const [now, setNow] = useState<number>(() => Date.now());
  const [progress, setProgress] = useState<number>(1);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const startedAtRef = useRef<number>(toast.createdAt);
  const remainingRef = useRef<number>(toast.durationMs);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, []);

  useEffect(() => {
    if (isError) {
      closeRef.current?.focus();
    }
  }, [isError]);

  useEffect(() => {
    if (prefersReducedMotion) {
      setProgress(0);
      return;
    }
    rafRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    function tick(): void {
      const elapsed = Date.now() - startedAtRef.current;
      const remaining = Math.max(0, remainingRef.current - elapsed);
      const next = remaining / toast.durationMs;
      setProgress(next);
      if (remaining > 0) {
        rafRef.current = window.requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    }
  }, [prefersReducedMotion, toast.durationMs]);

  useEffect(() => {
    if (hovered || focusWithin) {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      const elapsed = Date.now() - startedAtRef.current;
      remainingRef.current = Math.max(0, remainingRef.current - elapsed);
      return;
    }
    if (rafRef.current !== null) return;
    startedAtRef.current = Date.now();
    const tick = (): void => {
      const elapsed = Date.now() - startedAtRef.current;
      const remaining = Math.max(0, remainingRef.current - elapsed);
      const next = remaining / toast.durationMs;
      setProgress(next);
      if (remaining > 0) {
        rafRef.current = window.requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = window.requestAnimationFrame(tick);
  }, [hovered, focusWithin, toast.durationMs]);

  const paused = hovered || focusWithin;
  const remainingMs = Math.max(0, toast.durationMs * progress);

  return (
    <motion.li
      layout
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      data-testid={`toast-${toast.tone}`}
      data-toast-id={toast.id}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocusWithin(true)}
      onBlur={() => setFocusWithin(false)}
      initial={prefersReducedMotion ? { opacity: 0 } : { x: 16, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={prefersReducedMotion ? { opacity: 0 } : { x: 16, opacity: 0 }}
      transition={{ duration: prefersReducedMotion ? 0.12 : 0.18, ease: 'easeOut' }}
      className="pointer-events-auto relative w-[min(360px,calc(100vw-1rem))] overflow-hidden rounded-lg border border-border bg-surface-3 shadow-lg dark:border-border-dark dark:bg-surface-dark-3"
    >
      <span
        aria-hidden="true"
        data-testid="toast-stripe"
        className={`absolute inset-y-0 left-0 w-[3px] ${isError ? 'bg-danger' : 'bg-accent'}`}
      />
      <div className="flex items-start gap-3 px-3 py-2.5 pl-4">
        <Icon
          aria-hidden
          data-testid="toast-icon"
          className={`mt-0.5 h-5 w-5 flex-shrink-0 ${isError ? 'text-danger' : 'text-success'}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p className="truncate font-display text-sm font-medium text-ink dark:text-ink-dark">
              {toast.title}
            </p>
            <span
              data-testid="toast-timestamp"
              className="flex-shrink-0 font-mono text-[10px] tabular-nums text-ink-muted/70 dark:text-ink-muted-dark/70"
            >
              {relativeAge(toast.createdAt, now)}
            </span>
          </div>
          {toast.description ? (
            <p className="mt-0.5 text-xs text-ink-muted dark:text-ink-muted-dark">
              {toast.description}
            </p>
          ) : null}
          {toast.action ? (
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={() => {
                  toast.action?.onClick();
                  onDismiss(toast.id);
                }}
                data-testid="toast-action"
                className="min-h-9 rounded border border-border bg-surface-3 px-3 py-1 text-xs font-medium text-ink transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:border-border-dark dark:bg-surface-dark-3 dark:text-ink-dark dark:hover:bg-surface-dark-2 dark:focus-visible:ring-offset-surface-dark"
              >
                {toast.action.label}
              </button>
            </div>
          ) : null}
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={() => onDismiss(toast.id)}
          aria-label="Dismiss"
          data-testid="toast-dismiss"
          className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:text-ink-muted-dark dark:hover:bg-surface-dark-2 dark:hover:text-ink-dark dark:focus-visible:ring-offset-surface-dark"
        >
          <X aria-hidden className="h-4 w-4" />
        </button>
      </div>
      <div
        aria-hidden="true"
        data-testid="toast-progress"
        data-paused={paused ? 'true' : 'false'}
        data-duration-ms={toast.durationMs}
        data-progress={progress.toFixed(3)}
        className="absolute inset-x-0 bottom-0 h-[2px] origin-left bg-accent/40"
        style={{ transform: `scaleX(${progress})` }}
      >
        <span className="sr-only">
          Auto-dismiss in {formatDuration(remainingMs)}
          {paused ? ', paused' : ''}
        </span>
      </div>
    </motion.li>
  );
}
