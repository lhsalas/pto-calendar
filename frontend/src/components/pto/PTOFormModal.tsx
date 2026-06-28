import { useEffect, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { CreatePTORequest, DayPart, PTOWithUser } from '../../types/api';
import { useModalA11y } from '../../hooks/useModalA11y';

const NOTE_MAX = 500;
const DAY_PARTS: DayPart[] = ['morning', 'evening', 'all_day'];

export interface PTOFormModalProps {
  open: boolean;
  initialPto?: PTOWithUser;
  defaultStartDate?: string;
  onSubmit: (payload: CreatePTORequest) => Promise<void> | void;
  onClose: () => void;
}

function isWeekend(dateStr: string): boolean {
  const parts = dateStr.split('-').map(Number);
  if (parts.length !== 3) return false;
  const [y, m, d] = parts as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6;
}

export function PTOFormModal({
  open,
  initialPto,
  defaultStartDate,
  onSubmit,
  onClose,
}: PTOFormModalProps): JSX.Element | null {
  const today = new Date().toISOString().slice(0, 10);
  const initialStart = initialPto?.startDate ?? defaultStartDate ?? today;
  const initialEnd = initialPto?.endDate ?? defaultStartDate ?? today;
  const [startDate, setStartDate] = useState<string>(initialStart);
  const [endDate, setEndDate] = useState<string>(initialEnd);
  const [dayPart, setDayPart] = useState<DayPart>(initialPto?.dayPart ?? 'all_day');
  const [note, setNote] = useState<string>(initialPto?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);

  useEffect(() => {
    if (open) {
      setError(null);
      setStartDate(initialPto?.startDate ?? defaultStartDate ?? today);
      setEndDate(initialPto?.endDate ?? defaultStartDate ?? today);
      setDayPart(initialPto?.dayPart ?? 'all_day');
      setNote(initialPto?.note ?? '');
    }
  }, [open, initialPto, defaultStartDate, today]);

  function handleStartDateChange(value: string): void {
    setStartDate(value);
    setEndDate(value);
  }

  const isSingleDay = startDate !== '' && endDate !== '' && startDate === endDate;
  const cardRef = useModalA11y<HTMLFormElement>(open, onClose);

  function handleBackdropClick(event: React.MouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) onClose();
  }

  function validate(): string | null {
    if (endDate < startDate) return 'End date cannot be before start date.';
    if (isWeekend(startDate)) return 'Start date cannot fall on a weekend.';
    if (isWeekend(endDate)) return 'End date cannot fall on a weekend.';
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const payload: CreatePTORequest = {
        startDate,
        endDate,
        ...(isSingleDay ? { dayPart } : {}),
        ...(note.length > 0 ? { note } : {}),
      };
      await onSubmit(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save PTO.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pto-form-title"
          onClick={handleBackdropClick}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 dark:bg-ink-dark/40"
        >
          <motion.form
            ref={cardRef}
            onSubmit={handleSubmit}
            initial={{ y: 8, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 4, opacity: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg border border-border bg-surface-3 p-6 shadow-lg dark:border-border-dark dark:bg-surface-dark-3"
          >
            <h2
              id="pto-form-title"
              className="mb-4 font-display text-xl font-semibold tracking-tight text-ink dark:text-ink-dark"
            >
              {initialPto ? 'Edit PTO' : 'Add PTO'}
            </h2>

            <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block text-sm font-medium text-ink dark:text-ink-dark">
                Start date
                <input
                  type="date"
                  required
                  value={startDate}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    handleStartDateChange(e.target.value)
                  }
                  className="mt-1 block w-full rounded border border-border bg-surface-2 px-3 py-2 font-mono text-sm tabular-nums text-ink focus:border-accent-500 focus:outline-none dark:border-border-dark dark:bg-surface-dark-2 dark:text-ink-dark"
                />
              </label>
              <label className="block text-sm font-medium text-ink dark:text-ink-dark">
                End date
                <input
                  type="date"
                  required
                  value={endDate}
                  min={startDate}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setEndDate(e.target.value)}
                  className="mt-1 block w-full rounded border border-border bg-surface-2 px-3 py-2 font-mono text-sm tabular-nums text-ink focus:border-accent-500 focus:outline-none dark:border-border-dark dark:bg-surface-dark-2 dark:text-ink-dark"
                />
              </label>
            </div>

            {isSingleDay ? (
              <label className="mb-3 block text-sm font-medium text-ink dark:text-ink-dark">
                Day part
                <select
                  required
                  value={dayPart}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                    setDayPart(e.target.value as DayPart)
                  }
                  className="mt-1 block w-full rounded border border-border bg-surface-2 px-3 py-2 text-sm text-ink focus:border-accent-500 focus:outline-none dark:border-border-dark dark:bg-surface-dark-2 dark:text-ink-dark"
                >
                  {DAY_PARTS.map((dp) => (
                    <option key={dp} value={dp}>
                      {dp === 'all_day' ? 'All day' : dp === 'morning' ? 'Morning' : 'Evening'}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="mb-4 block text-sm font-medium text-ink dark:text-ink-dark">
              Note (optional)
              <textarea
                value={note}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setNote(e.target.value)}
                maxLength={NOTE_MAX}
                rows={3}
                className="mt-1 block w-full rounded border border-border bg-surface-2 px-3 py-2 text-sm text-ink focus:border-accent-500 focus:outline-none dark:border-border-dark dark:bg-surface-dark-2 dark:text-ink-dark"
              />
              <span className="mt-1 block text-right font-mono text-xs tabular-nums text-ink-muted dark:text-ink-muted-dark">
                {note.length}/{NOTE_MAX}
              </span>
            </label>

            {error ? (
              <p role="alert" className="mb-3 text-sm text-danger">
                {error}
              </p>
            ) : null}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="min-h-11 rounded border border-border px-3 py-2 text-sm text-ink transition-colors duration-150 hover:bg-surface-2 disabled:opacity-60 dark:border-border-dark dark:text-ink-dark dark:hover:bg-surface-dark-2"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="min-h-11 rounded bg-accent px-3 py-2 text-sm font-medium text-ink-inverse transition-colors duration-150 hover:bg-accent-hover disabled:opacity-60"
              >
                {submitting ? 'Saving…' : 'Save PTO'}
              </button>
            </div>
          </motion.form>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
