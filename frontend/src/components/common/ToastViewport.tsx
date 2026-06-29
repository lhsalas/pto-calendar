import { useEffect, useRef } from 'react';
import { AnimatePresence } from 'motion/react';
import { useToast } from '../../hooks/useToast';
import { Toast } from './Toast';

export function ToastViewport(): JSX.Element {
  const { toasts, dismiss } = useToast();
  const listRef = useRef<HTMLOListElement | null>(null);

  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      const target = event.target as Node | null;
      if (!target || !node?.contains(target)) return;
      const top = node?.querySelector<HTMLElement>('[data-testid^="toast-"]');
      const id = top?.getAttribute('data-toast-id');
      if (id) {
        event.preventDefault();
        dismiss(id);
      }
    }
    node.addEventListener('keydown', handleKeyDown);
    return () => node.removeEventListener('keydown', handleKeyDown);
  }, [dismiss, toasts]);

  return (
    <ol
      ref={listRef}
      aria-label="Notifications"
      data-testid="toast-viewport"
      className="pointer-events-none fixed top-4 right-4 z-50 flex max-w-[calc(100vw-1rem)] flex-col items-end gap-2 outline-none md:top-4 md:right-4 max-md:inset-x-2 max-md:top-2 max-md:items-stretch"
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <Toast key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </AnimatePresence>
    </ol>
  );
}
