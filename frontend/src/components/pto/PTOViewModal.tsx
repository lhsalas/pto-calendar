import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { DayPart, PTO, PTOWithUser, User } from '../../types/api';
import { canModifyPto } from '../../lib/permissions';
import { formatRangeLabel } from '../../lib/calendar';
import { X } from '../icons';
import { useModalA11y } from '../../hooks/useModalA11y';

export interface PTOViewModalProps {
  pto: PTOWithUser;
  currentUser: User;
  onClose: () => void;
  onEdit: (pto: PTOWithUser) => void;
  onDelete: (pto: PTOWithUser) => Promise<void>;
}

function dayPartLabel(dp: DayPart): string {
  if (dp === 'morning') return 'Morning (AM)';
  if (dp === 'evening') return 'Evening (PM)';
  return 'All day';
}

export function PTOViewModal({
  pto,
  currentUser,
  onClose,
  onEdit,
  onDelete,
}: PTOViewModalProps): JSX.Element {
  const [confirming, setConfirming] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [fullPto, setFullPto] = useState<PTOWithUser>(pto);

  const canModify = canModifyPto(
    { id: currentUser.id, role: currentUser.role },
    { userId: pto.user.id },
  );

  useEffect(() => {
    setConfirming(false);
    setError(null);
    setFullPto(pto);
  }, [pto]);

  async function loadDetail(): Promise<void> {
    try {
      const detail = await fetch(`/pto/${pto.id}`, { credentials: 'include' }).then(async (res) => {
        if (!res.ok) throw new Error('Could not load PTO details.');
        return (await res.json()) as PTO & { user: PTOWithUser['user'] };
      });
      setFullPto({
        id: detail.id,
        user: pto.user,
        startDate: detail.startDate,
        endDate: detail.endDate,
        dayPart: detail.dayPart,
        note: detail.note,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load PTO details.');
    }
  }

  async function handleDelete(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await onDelete(pto);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete PTO.');
      setBusy(false);
    }
  }

  const cardRef = useModalA11y(true, onClose);

  function handleBackdropClick(event: React.MouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) onClose();
  }

  return (
    <AnimatePresence>
      <motion.div
        key="backdrop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pto-view-title"
        onClick={handleBackdropClick}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 dark:bg-ink-dark/40"
      >
        <motion.div
          ref={cardRef}
          initial={{ y: 8, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 4, opacity: 0 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg border border-border bg-surface-3 p-6 shadow-lg dark:border-border-dark dark:bg-surface-dark-3"
        >
          <div className="mb-4 flex items-center justify-between">
            <h2
              id="pto-view-title"
              className="font-display text-xl font-semibold tracking-tight text-ink dark:text-ink-dark"
            >
              PTO details
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Dismiss"
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:text-ink-muted-dark dark:hover:bg-surface-dark-2 dark:hover:text-ink-dark dark:focus-visible:ring-offset-surface-dark"
            >
              <X aria-hidden className="h-4 w-4" />
            </button>
          </div>

          <dl className="mb-4 space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-ink-muted dark:text-ink-muted-dark">User</dt>
              <dd className="flex items-center gap-2 font-medium text-ink dark:text-ink-dark">
                <span
                  aria-hidden="true"
                  className="inline-block h-3 w-3 rounded"
                  style={{ backgroundColor: pto.user.colorCode }}
                />
                {pto.user.name}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-ink-muted dark:text-ink-muted-dark">Date(s)</dt>
              <dd className="font-mono text-sm tabular-nums font-medium text-ink dark:text-ink-dark">
                {formatRangeLabel(pto.startDate, pto.endDate)}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-ink-muted dark:text-ink-muted-dark">Day part</dt>
              <dd className="font-medium text-ink dark:text-ink-dark">
                {dayPartLabel(pto.dayPart)}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="text-ink-muted dark:text-ink-muted-dark">Note</dt>
              <dd className="max-w-xs text-right text-ink dark:text-ink-dark">
                {fullPto.note ?? (
                  <span className="text-ink-muted/70 dark:text-ink-muted-dark/70">(no note)</span>
                )}
                {canModify && fullPto.note === null ? (
                  <button
                    type="button"
                    onClick={() => void loadDetail()}
                    className="ml-2 text-xs text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:focus-visible:ring-offset-surface-dark"
                  >
                    Load note
                  </button>
                ) : null}
              </dd>
            </div>
          </dl>

          {error ? (
            <p role="alert" className="mb-3 text-sm text-danger">
              {error}
            </p>
          ) : null}

          {confirming ? (
            <div className="mb-3 rounded border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
              <p className="mb-2">Delete this PTO? This cannot be undone.</p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={busy}
                  className="min-h-11 rounded border border-border bg-surface-3 px-3 py-2 text-sm text-ink transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-60 dark:border-border-dark dark:bg-surface-dark-3 dark:text-ink-dark dark:hover:bg-surface-dark-2 dark:focus-visible:ring-offset-surface-dark"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete()}
                  disabled={busy}
                  className="min-h-11 rounded bg-danger px-3 py-2 text-sm font-medium text-ink-inverse transition-colors duration-150 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-60 dark:focus-visible:ring-offset-surface-dark"
                >
                  {busy ? 'Deleting…' : 'Yes, delete'}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="min-h-11 rounded border border-border px-3 py-2 text-sm text-ink transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:border-border-dark dark:text-ink-dark dark:hover:bg-surface-dark-2 dark:focus-visible:ring-offset-surface-dark"
              >
                Close
              </button>
              {canModify ? (
                <>
                  <button
                    type="button"
                    onClick={() => onEdit(pto)}
                    className="min-h-11 rounded bg-accent px-3 py-2 text-sm font-medium text-ink-inverse transition-colors duration-150 hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:focus-visible:ring-offset-surface-dark"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(true)}
                    className="min-h-11 rounded bg-danger px-3 py-2 text-sm font-medium text-ink-inverse transition-colors duration-150 hover:opacity-90"
                  >
                    Delete
                  </button>
                </>
              ) : null}
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
