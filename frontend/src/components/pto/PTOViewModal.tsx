import { useEffect, useState } from 'react';
import type { DayPart, PTO, PTOWithUser, User } from '../../types/api';
import { canModifyPto } from '../../lib/permissions';

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

function formatRange(p: PTOWithUser): string {
  if (p.startDate === p.endDate) return p.startDate;
  return `${p.startDate} → ${p.endDate}`;
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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pto-view-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
    >
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-lg dark:border-slate-700 dark:bg-slate-900">
        <div className="mb-4 flex items-center justify-between">
          <h2
            id="pto-view-title"
            className="text-lg font-semibold text-slate-900 dark:text-slate-100"
          >
            PTO details
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Dismiss"
            className="text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
          >
            ×
          </button>
        </div>

        <dl className="mb-4 space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <dt className="text-slate-500 dark:text-slate-400">User</dt>
            <dd className="flex items-center gap-2 font-medium text-slate-900 dark:text-slate-100">
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 rounded"
                style={{ backgroundColor: pto.user.colorCode }}
              />
              {pto.user.name}
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-slate-500 dark:text-slate-400">Date(s)</dt>
            <dd className="font-medium text-slate-900 dark:text-slate-100">{formatRange(pto)}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-slate-500 dark:text-slate-400">Day part</dt>
            <dd className="font-medium text-slate-900 dark:text-slate-100">
              {dayPartLabel(pto.dayPart)}
            </dd>
          </div>
          <div className="flex items-start justify-between gap-3">
            <dt className="text-slate-500 dark:text-slate-400">Note</dt>
            <dd className="max-w-xs text-right text-slate-900 dark:text-slate-100">
              {fullPto.note ?? (
                <span className="text-slate-400 dark:text-slate-500">(no note)</span>
              )}
              {canModify && fullPto.note === null ? (
                <button
                  type="button"
                  onClick={() => void loadDetail()}
                  className="ml-2 text-xs text-blue-600 hover:underline dark:text-blue-400"
                >
                  Load note
                </button>
              ) : null}
            </dd>
          </div>
        </dl>

        {error ? (
          <p role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}

        {confirming ? (
          <div className="mb-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300">
            <p className="mb-2">Delete this PTO? This cannot be undone.</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={busy}
                className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
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
              className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              Close
            </button>
            {canModify ? (
              <>
                <button
                  type="button"
                  onClick={() => onEdit(pto)}
                  className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  className="rounded bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700"
                >
                  Delete
                </button>
              </>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
