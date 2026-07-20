import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/useAuth';
import { usePtoList } from '../hooks/usePtoList';
import { useHolidays } from '../hooks/useHolidays';
import { useToast } from '../hooks/useToast';
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
import { canManageUsers } from '../lib/permissions';

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
  const { items: holidays } = useHolidays(fetchStart, fetchEnd);
  const [createOpen, setCreateOpen] = useState<boolean>(false);
  const [viewing, setViewing] = useState<PTOWithUser | null>(null);
  const [editing, setEditing] = useState<PTOWithUser | null>(null);
  const { push: pushToast } = useToast();
  const lastErrorRef = useRef<string | null>(null);

  useEffect(() => {
    if (!error) {
      lastErrorRef.current = null;
      return;
    }
    if (error === lastErrorRef.current) return;
    lastErrorRef.current = error;
    pushToast({
      tone: 'error',
      title: 'Could not load PTO.',
      description: 'Tap retry to try again.',
      action: {
        label: 'Retry',
        onClick: () => {
          void refetch();
        },
      },
    });
  }, [error, pushToast, refetch]);

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
    pushToast({ tone: 'success', title: 'PTO saved.' });
  }

  async function handleUpdate(payload: CreatePTORequest): Promise<void> {
    if (!editing) return;
    await update(editing.id, payload);
    setEditing(null);
    setViewing(null);
    pushToast({ tone: 'success', title: 'PTO updated.' });
  }

  async function handleDelete(pto: PTOWithUser): Promise<void> {
    await remove(pto.id);
    setViewing(null);
    pushToast({ tone: 'success', title: 'PTO deleted.' });
  }

  if (!user) {
    return (
      <div role="status" aria-busy="true" className="p-6 text-ink-muted dark:text-ink-muted-dark">
        Loading…
      </div>
    );
  }

  return (
    <div className="min-h-full bg-surface p-4 text-ink sm:p-6 lg:p-8 dark:bg-surface-dark dark:text-ink-dark">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-xl font-semibold tracking-tight">Calendar</h1>
        <div className="flex flex-wrap items-center gap-3 text-sm text-ink-muted dark:text-ink-muted-dark">
          <ThemeToggle />
          {canManageUsers(user) ? (
            <>
              <Link
                to="/admin/holidays"
                data-testid="manage-holidays-link"
                className="min-h-11 rounded border border-border px-3 py-2 text-ink transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:border-border-dark dark:text-ink-dark dark:hover:bg-surface-dark-2 dark:focus-visible:ring-offset-surface-dark"
              >
                Holidays
              </Link>
              <Link
                to="/admin/users"
                data-testid="manage-users-link"
                className="min-h-11 rounded border border-border px-3 py-2 text-ink transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:border-border-dark dark:text-ink-dark dark:hover:bg-surface-dark-2 dark:focus-visible:ring-offset-surface-dark"
              >
                Manage users
              </Link>
            </>
          ) : null}
          <span>
            {user.name}{' '}
            <span className="text-ink-muted/70 dark:text-ink-muted-dark/70">({user.role})</span>
          </span>
          <button
            type="button"
            onClick={() => void logout()}
            className="min-h-11 rounded border border-border px-3 py-2 transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:border-border-dark dark:hover:bg-surface-dark-2 dark:focus-visible:ring-offset-surface-dark"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p
          className="font-mono text-sm tabular-nums text-ink-muted dark:text-ink-muted-dark"
          data-testid="range-label"
        >
          {listRange.label}
        </p>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="min-h-11 rounded bg-accent px-4 py-2 text-sm font-medium text-ink-inverse transition-colors duration-150 hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:focus-visible:ring-offset-surface-dark"
        >
          Add PTO
        </button>
      </div>

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
          <div
            role="status"
            aria-busy="true"
            aria-label="Loading calendar"
            className="grid animate-pulse grid-cols-7 gap-2 rounded-lg border border-border bg-surface-3 p-2 dark:border-border-dark dark:bg-surface-dark-3"
          >
            {Array.from({ length: 42 }).map((_, i) => (
              <div
                key={i}
                className="h-28 rounded border border-border bg-surface-2 dark:border-border-dark dark:bg-surface-dark-2"
              />
            ))}
          </div>
        ) : (
          <MonthGrid
            weeks={gridData.weeks}
            ptoList={items}
            onChipClick={setViewing}
            onDayClick={handleDayClick}
            holidays={holidays}
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
