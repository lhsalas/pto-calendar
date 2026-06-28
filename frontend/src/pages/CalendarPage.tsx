import { useCallback, useMemo, useState } from 'react';
import { useAuth } from '../context/useAuth';
import { usePtoList } from '../hooks/usePtoList';
import { PTOFormModal } from '../components/pto/PTOFormModal';
import { PTOViewModal } from '../components/pto/PTOViewModal';
import { UpcomingPtoList } from '../components/pto/UpcomingPtoList';
import { CalendarHeader } from '../components/calendar/CalendarHeader';
import { MonthGrid } from '../components/calendar/MonthGrid';
import { ThemeToggle } from '../components/ThemeToggle';
import {
  addDays,
  addMonths,
  compareYearMonth,
  currentYearMonth,
  firstOfMonthIso,
  formatYearMonth,
  grid,
  isCurrentYearMonth,
  listWindow,
  todayIso,
  type YearMonth,
} from '../lib/calendar';
import type { ViewMode } from '../components/calendar/ViewToggle';
import type { CreatePTORequest, PTOWithUser } from '../types/api';

const LIST_WINDOW_DAYS = 90;

export function CalendarPage(): JSX.Element {
  const { user, logout } = useAuth();
  const [view, setView] = useState<ViewMode>('grid');
  const [yearMonth, setYearMonth] = useState<YearMonth>(() => currentYearMonth());
  const [listStart, setListStart] = useState<string>(() => todayIso());

  const gridData = useMemo(() => grid(yearMonth), [yearMonth]);
  const listRange = useMemo(() => listWindow(listStart, LIST_WINDOW_DAYS), [listStart]);

  const fetchStart = view === 'grid' ? gridData.start : listRange.start;
  const fetchEnd = view === 'grid' ? gridData.end : listRange.end;

  const { items, loading, error, refetch, create, update, remove } = usePtoList(
    fetchStart,
    fetchEnd,
  );
  const [createOpen, setCreateOpen] = useState<boolean>(false);
  const [viewing, setViewing] = useState<PTOWithUser | null>(null);
  const [editing, setEditing] = useState<PTOWithUser | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  function showToast(message: string): void {
    setToast(message);
    window.setTimeout(() => setToast(null), 3000);
  }

  const handlePrev = useCallback((): void => {
    if (view === 'grid') {
      setYearMonth((m) => addMonths(m, -1));
    } else {
      setListStart((s) => addDays(s, -LIST_WINDOW_DAYS));
    }
  }, [view]);

  const handleNext = useCallback((): void => {
    if (view === 'grid') {
      setYearMonth((m) => addMonths(m, 1));
    } else {
      setListStart((s) => addDays(s, LIST_WINDOW_DAYS));
    }
  }, [view]);

  const handleToday = useCallback((): void => {
    if (view === 'grid') {
      setYearMonth(currentYearMonth());
    } else {
      setListStart(todayIso());
    }
  }, [view]);

  const handleViewChange = useCallback((next: ViewMode): void => {
    setView(next);
    if (next === 'list') {
      setListStart(todayIso());
    }
  }, []);

  const headerLabel = view === 'grid' ? formatYearMonth(yearMonth) : listRange.label;
  const todayDisabled = view === 'grid' ? isCurrentYearMonth(yearMonth) : listStart === todayIso();

  const defaultCreateStartDate =
    view === 'grid' && compareYearMonth(yearMonth, currentYearMonth()) === 1
      ? firstOfMonthIso(yearMonth)
      : todayIso();

  const [createDayStartDate, setCreateDayStartDate] = useState<string | undefined>(undefined);

  const handleDayClick = useCallback((iso: string): void => {
    setCreateDayStartDate(iso);
    setCreateOpen(true);
  }, []);

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
          Showing {fetchStart} to {fetchEnd}
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
        label={headerLabel}
        view={view}
        onViewChange={handleViewChange}
        onPrev={handlePrev}
        onNext={handleNext}
        onToday={handleToday}
        todayDisabled={todayDisabled}
      />

      {view === 'grid' ? (
        loading && items.length === 0 ? (
          <p className="rounded-lg border border-slate-200 bg-white p-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
            Loading…
          </p>
        ) : (
          <MonthGrid
            weeks={gridData.weeks}
            ptoList={items}
            onChipClick={setViewing}
            onDayClick={handleDayClick}
          />
        )
      ) : (
        <UpcomingPtoList
          ptoList={items}
          currentUser={user}
          onRowClick={setViewing}
          onEdit={(p) => {
            setViewing(null);
            setEditing(p);
          }}
          onDelete={handleDelete}
        />
      )}

      <PTOFormModal
        open={createOpen}
        defaultStartDate={createDayStartDate ?? defaultCreateStartDate}
        onSubmit={handleCreate}
        onClose={() => {
          setCreateOpen(false);
          setCreateDayStartDate(undefined);
        }}
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
