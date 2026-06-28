import { useEffect, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import type { CreatePTORequest, DayPart, PTOWithUser } from '../../types/api';

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

  if (!open) return null;

  const isSingleDay = startDate !== '' && endDate !== '' && startDate === endDate;

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
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pto-form-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-lg dark:border-slate-700 dark:bg-slate-900"
      >
        <h2
          id="pto-form-title"
          className="mb-4 text-lg font-semibold text-slate-900 dark:text-slate-100"
        >
          {initialPto ? 'Edit PTO' : 'Add PTO'}
        </h2>

        <div className="mb-3 grid grid-cols-2 gap-3">
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
            Start date
            <input
              type="date"
              required
              value={startDate}
              onChange={(e: ChangeEvent<HTMLInputElement>) => handleStartDateChange(e.target.value)}
              className="mt-1 block w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
            End date
            <input
              type="date"
              required
              value={endDate}
              min={startDate}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setEndDate(e.target.value)}
              className="mt-1 block w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            />
          </label>
        </div>

        {isSingleDay ? (
          <label className="mb-3 block text-sm font-medium text-slate-700 dark:text-slate-300">
            Day part
            <select
              required
              value={dayPart}
              onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                setDayPart(e.target.value as DayPart)
              }
              className="mt-1 block w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            >
              {DAY_PARTS.map((dp) => (
                <option key={dp} value={dp}>
                  {dp === 'all_day' ? 'All day' : dp === 'morning' ? 'Morning' : 'Evening'}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="mb-4 block text-sm font-medium text-slate-700 dark:text-slate-300">
          Note (optional)
          <textarea
            value={note}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setNote(e.target.value)}
            maxLength={NOTE_MAX}
            rows={3}
            className="mt-1 block w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          />
          <span className="mt-1 block text-right text-xs text-slate-400 dark:text-slate-500">
            {note.length}/{NOTE_MAX}
          </span>
        </label>

        {error ? (
          <p role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {submitting ? 'Saving…' : 'Save PTO'}
          </button>
        </div>
      </form>
    </div>
  );
}
