import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ToastContext, type Toast, type ToastContextValue, type ToastInput } from './ToastContext';

const MAX_VISIBLE = 3;
const DEFAULT_DURATION_MS = 4000;

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function scheduleDismiss(
  timers: Map<string, ReturnType<typeof setTimeout>>,
  id: string,
  durationMs: number,
  onExpire: () => void,
): void {
  const previous = timers.get(id);
  if (previous !== undefined) clearTimeout(previous);
  const handle = setTimeout(() => {
    timers.delete(id);
    onExpire();
  }, durationMs);
  timers.set(id, handle);
}

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const idCounterRef = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const handle = timersRef.current.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      timersRef.current.delete(id);
    }
  }, []);

  const push = useCallback((input: ToastInput): string => {
    const durationMs = input.durationMs ?? DEFAULT_DURATION_MS;
    const tone = input.tone;
    const title = input.title;
    const createdAt = Date.now();

    let assignedId = '';
    setToasts((prev) => {
      const existing = prev.find((t) => t.tone === tone && t.title === title);
      const id = existing?.id ?? `${makeId()}-${++idCounterRef.current}`;
      assignedId = id;

      const next: Toast = {
        id,
        tone,
        title,
        description: input.description,
        action: input.action,
        durationMs,
        createdAt,
      };

      const without = existing ? prev.filter((t) => t.id !== id) : prev;
      const ordered = [next, ...without];
      return ordered.length > MAX_VISIBLE ? ordered.slice(0, MAX_VISIBLE) : ordered;
    });

    queueMicrotask(() => {
      if (!assignedId) return;
      scheduleDismiss(timersRef.current, assignedId, durationMs, () => {
        setToasts((prev) => prev.filter((t) => t.id !== assignedId));
      });
    });

    return assignedId;
  }, []);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((handle) => clearTimeout(handle));
      timers.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({ toasts, push, dismiss }),
    [toasts, push, dismiss],
  );

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}
