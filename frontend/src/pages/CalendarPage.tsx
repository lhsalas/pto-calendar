import { useMemo, useState } from 'react';
import { useAuth } from '../context/useAuth';
import { usePtoList } from '../hooks/usePtoList';
import { PTOFormModal } from '../components/pto/PTOFormModal';
import { PTOViewModal } from '../components/pto/PTOViewModal';
import { CalendarHeader } from '../components/calendar/CalendarHeader';
import { MonthGrid } from '../components/calendar/MonthGrid';
import { ThemeToggle } from '../components/ThemeToggle';
import { addMonths, currentYearMonth, grid, type YearMonth } from '../lib/calendar';
import type { CreatePTORequest, PTOWithUser } from '../types/api';

export function CalendarPage(): JSX.Element {
  const { user, logout } = useAuth();
  const [yearMonth, setYearMonth] = useState<YearMonth>(() => currentYearMonth());
  const { start, end, weeks } = useMemo(() => {
    const g = grid(yearMonth);
    return { start: g.start, end: g.end, weeks: g.weeks };
  }, [yearMonth]);
  const { items, loading, error, refetch, create, update, remove } = usePtoList(start, end);
  const [createOpen, setCreateOpen] = useState<boolean>(false);
  const [viewing, setViewing] = useState<PTOWithUser | null>(null);
  const [editing, setEditing] = useState<PTOWithUser | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  function showToast(message: string): void {
    setToast(message);
    window.setTimeout(() => setToast(null), 3000);
  }

  async function handleCreate(payload: CreatePTORequest): Promise<void> {
    await create(payload);
    setCreateOpen(false);
    showToast('PTO saved.');
  }

  async function handleUpdate(payload: CreatePTORequest): Promise<void> {
    if (!editing) return;
    await update(editing.id, payload);
    setEditing(null);
    setViewing(null);
    showToast('PTO updated.');
  }

  async function handleDelete(pto: PTOWithUser): Promise<void> {
    await remove(pto.id);
    setViewing(null);
    showToast('PTO deleted.');
  }

  if (!user) {
    return <div className="p-6 text-slate-500 dark:text-slate-400">Loading…</div>;
  }

  return (
    <div className="min-h-full bg-slate-50 p-6 dark:bg-slate-950">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Calendar</h1>
        <div className="flex items-center gap-4 text-sm text-slate-700 dark:text-slate-300">
          <ThemeToggle />
          <span>
            {user.name} <span className="text-slate-400 dark:text-slate-500">({user.role})</span>
          </span>
          <button
            type="button"
            onClick={() => void logout()}
            className="rounded border border-slate-300 px-3 py-1 hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-slate-600 dark:text-slate-400" data-testid="range-label">
          Showing {start} to {end}
        </p>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Add PTO
        </button>
      </div>

      {toast ? (
        <div
          role="status"
          className="mb-4 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300"
        >
          {toast}
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300"
        >
          {error}{' '}
          <button type="button" onClick={() => void refetch()} className="ml-2 underline">
            Retry
          </button>
        </div>
      ) : null}

      <CalendarHeader
        yearMonth={yearMonth}
        onPrev={() => setYearMonth((m) => addMonths(m, -1))}
        onNext={() => setYearMonth((m) => addMonths(m, 1))}
        onToday={() => setYearMonth(currentYearMonth())}
      />

      {loading && items.length === 0 ? (
        <p className="rounded-lg border border-slate-200 bg-white p-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
          Loading…
        </p>
      ) : (
        <MonthGrid weeks={weeks} ptoList={items} onChipClick={setViewing} />
      )}

      <PTOFormModal
        open={createOpen}
        onSubmit={handleCreate}
        onClose={() => setCreateOpen(false)}
      />
      <PTOFormModal
        open={editing !== null}
        initialPto={editing ?? undefined}
        onSubmit={handleUpdate}
        onClose={() => setEditing(null)}
      />
      {viewing ? (
        <PTOViewModal
          pto={viewing}
          currentUser={user}
          onClose={() => setViewing(null)}
          onEdit={(p) => {
            setViewing(null);
            setEditing(p);
          }}
          onDelete={handleDelete}
        />
      ) : null}
    </div>
  );
}
