import { useEffect, useRef, useState } from 'react';
import type { PTOWithUser, User } from '../../types/api';
import { editViewerKey, isPreparedPto, loadPtoForEdit, type PreparedPto } from '../../lib/ptoEdit';
import { useModalA11y } from '../../hooks/useModalA11y';
import { PTOFormModal, type PTOFormModalProps } from './PTOFormModal';

interface Props {
  pto: PTOWithUser;
  currentUser: User;
  onSubmit: PTOFormModalProps['onSubmit'];
  onClose: () => void;
}
export function PTOEditModal(props: Props): JSX.Element {
  return <EditSession key={`${props.pto.id}:${editViewerKey(props.currentUser)}`} {...props} />;
}
function EditSession({ pto, currentUser, onSubmit, onClose }: Props): JSX.Element {
  const [ready, setReady] = useState<PreparedPto | null>(() =>
    isPreparedPto(pto, currentUser) ? pto : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const request = useRef<Promise<PreparedPto> | null>(null);
  const cardRef = useModalA11y(ready === null, onClose);
  useEffect(() => {
    if (isPreparedPto(pto, currentUser)) return;
    let active = true;
    request.current ??= loadPtoForEdit(pto, currentUser);
    void request.current.then(
      (prepared) => {
        if (active) setReady(prepared);
      },
      (err: unknown) => {
        request.current = null;
        if (active) setError(err instanceof Error ? err.message : 'Could not load PTO details.');
      },
    );
    return () => {
      active = false;
    };
  }, [pto, currentUser, attempt]);

  if (ready)
    return (
      <PTOFormModal
        open
        initialPto={ready}
        initialNoteLoaded
        onSubmit={onSubmit}
        onClose={onClose}
      />
    );
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pto-edit-loading-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 dark:bg-ink-dark/40"
    >
      <div
        ref={cardRef}
        className="w-full max-w-md rounded-lg border border-border bg-surface-3 p-6 text-ink shadow-lg dark:border-border-dark dark:bg-surface-dark-3 dark:text-ink-dark"
      >
        <h2 id="pto-edit-loading-title" className="mb-4 font-display text-xl font-semibold">
          Prepare PTO edit
        </h2>
        {error ? (
          <p role="alert" className="mb-3 text-danger">
            {error}
          </p>
        ) : (
          <p role="status" className="mb-3">
            Loading PTO note before editing…
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 rounded border border-border px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
          >
            Cancel
          </button>
          {error ? (
            <button
              type="button"
              onClick={() => {
                setError(null);
                setAttempt((n) => n + 1);
              }}
              className="min-h-11 rounded bg-accent px-3 py-2 text-ink-inverse focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
            >
              Retry
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
