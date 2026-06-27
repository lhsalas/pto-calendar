import { useMemo, useState } from 'react';
import { useAuth } from '../context/useAuth';
import { usePtoList } from '../hooks/usePtoList';
import { PTOFormModal } from '../components/pto/PTOFormModal';
import type { CreatePTORequest, DayPart } from '../types/api';

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function currentMonthRange(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return { start: isoDate(start), end: isoDate(end) };
}

function dayPartLabel(dp: DayPart): string {
  if (dp === 'morning') return 'AM';
  if (dp === 'evening') return 'PM';
  return 'Full';
}

export function CalendarPage(): JSX.Element {
  const { user, logout } = useAuth();
  const range = useMemo(currentMonthRange, []);
  const { items, loading, error, refetch, create } = usePtoList(range.start, range.end);
  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [toast, setToast] = useState<string | null>(null);

  async function handleCreate(payload: CreatePTORequest): Promise<void> {
    await create(payload);
    setModalOpen(false);
    setToast('PTO saved.');
    window.setTimeout(() => setToast(null), 3000);
  }

  return (
    <div className="min-h-full bg-slate-50 p-6">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">Calendar</h1>
        <div className="flex items-center gap-4 text-sm text-slate-700">
          <span>
            {user?.name} <span className="text-slate-400">({user?.role})</span>
          </span>
          <button
            type="button"
            onClick={() => void logout()}
            className="rounded border border-slate-300 px-3 py-1 hover:bg-slate-100"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-slate-600">
          Showing {range.start} to {range.end}
        </p>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Add PTO
        </button>
      </div>

      {toast ? (
        <div
          role="status"
          className="mb-4 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"
        >
          {toast}
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}{' '}
          <button type="button" onClick={() => void refetch()} className="ml-2 underline">
            Retry
          </button>
        </div>
      ) : null}

      <section className="rounded-lg border border-slate-200 bg-white">
        {loading && items.length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-500">Loading…</p>
        ) : items.length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-500">
            No PTOs in this range. Click <span className="font-medium">Add PTO</span> to create one.
          </p>
        ) : (
          <ul className="divide-y divide-slate-200">
            {items.map((p) => (
              <li key={p.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <div className="flex items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="inline-block h-3 w-3 rounded"
                    style={{ backgroundColor: p.user.colorCode }}
                  />
                  <span className="font-medium text-slate-900">{p.user.name}</span>
                  <span className="text-slate-600">
                    {p.startDate === p.endDate ? p.startDate : `${p.startDate} → ${p.endDate}`}
                  </span>
                </div>
                <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                  {dayPartLabel(p.dayPart)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <PTOFormModal open={modalOpen} onSubmit={handleCreate} onClose={() => setModalOpen(false)} />
    </div>
  );
}
