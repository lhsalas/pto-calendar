import type { JSX } from 'react';
import type { RefObject } from 'react';
import { motion } from 'motion/react';
import { useTokenDialog } from '../../hooks/useTokenDialog';

export interface TokenConfirmDialogProps {
  title: string;
  description: string;
  busy: boolean;
  error: string | null;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Where the focus returns to; the trigger outlives this dialog. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * Confirmation for a destructive credential action.
 *
 * The dialog is mounted only while it is open, so closing it removes it from
 * the document at once. Nothing is revoked until the confirmation is
 * accepted, the accept button is disabled while the request is in flight so
 * it cannot be submitted twice, and no password is ever asked for: a valid
 * session is enough.
 */
export function TokenConfirmDialog({
  title,
  description,
  busy,
  error,
  confirmLabel = 'Confirm revocation',
  onConfirm,
  onCancel,
  returnFocusRef,
}: TokenConfirmDialogProps): JSX.Element {
  const cardRef = useTokenDialog<HTMLDivElement>(true, onCancel, returnFocusRef);

  function handleBackdropClick(event: React.MouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget && !busy) onCancel();
  }

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-labelledby="token-confirm-title"
      onClick={handleBackdropClick}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 dark:bg-ink-dark/40"
    >
      <motion.div
        ref={cardRef}
        initial={{ y: 8, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        className="my-8 w-full max-w-md rounded-lg border border-border bg-surface-3 p-6 shadow-lg dark:border-border-dark dark:bg-surface-dark-3"
      >
        <h2
          id="token-confirm-title"
          className="mb-2 font-display text-xl font-semibold tracking-tight text-ink dark:text-ink-dark"
        >
          {title}
        </h2>
        <p className="mb-4 text-sm break-words text-ink-muted dark:text-ink-muted-dark">
          {description}
        </p>

        {error ? (
          <p role="alert" className="mb-3 text-sm text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="min-h-11 rounded border border-border px-3 py-2 text-sm text-ink transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-60 dark:border-border-dark dark:text-ink-dark dark:hover:bg-surface-dark-2 dark:focus-visible:ring-offset-surface-dark"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="min-h-11 rounded bg-danger px-4 py-2 text-sm font-medium text-ink-inverse transition-colors duration-150 hover:bg-accent-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-60 dark:focus-visible:ring-offset-surface-dark"
          >
            {confirmLabel}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
