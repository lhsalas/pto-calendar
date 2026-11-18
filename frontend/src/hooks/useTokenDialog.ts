import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useModalA11y } from './useModalA11y';

/**
 * Modal accessibility for the token dialogs.
 *
 * It reuses the shared trap (Escape to close, Tab cycling inside the card,
 * body scroll lock, initial focus) and adds focus restoration: the control
 * that opened the dialog gets its focus back when the dialog closes or
 * unmounts, so keyboard users never lose their place.
 *
 * Two details keep the trap stable:
 *
 *   - `onClose` is forwarded through a ref, so the shared effect is not torn
 *     down and re-created on every render. A re-created effect would steal
 *     focus back to the first control of the dialog on each state change.
 *   - The restore target is captured once, while the dialog mounts, and an
 *     explicit `returnFocusRef` wins over it. The capture therefore points
 *     at the control that opened the dialog and never at a field that is
 *     about to disappear (for example the submit button of the form that
 *     hands over to the reveal dialog).
 */
export function useTokenDialog<T extends HTMLElement = HTMLDivElement>(
  open: boolean,
  onClose: () => void,
  returnFocusRef?: RefObject<HTMLElement | null>,
): RefObject<T | null> {
  const onCloseRef = useRef(onClose);
  const [capturedTarget] = useState<HTMLElement | null>(() => {
    if (typeof document === 'undefined') return null;
    const active = document.activeElement;
    return active instanceof HTMLElement ? active : null;
  });

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const stableClose = useCallback((): void => {
    onCloseRef.current();
  }, []);

  const cardRef = useModalA11y<T>(open, stableClose);
  const restoreRef = useRef<HTMLElement | null>(capturedTarget);

  useEffect(() => {
    if (!open) return undefined;
    // The restore target is resolved while the dialog opens: the explicit
    // trigger wins, and the element that had the focus is the fallback.
    const target = returnFocusRef?.current ?? restoreRef.current;
    restoreRef.current = null;
    return () => {
      if (target && typeof target.focus === 'function' && document.contains(target)) {
        target.focus();
      }
    };
  }, [open, returnFocusRef]);

  return cardRef;
}
