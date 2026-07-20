import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiRequest, ApiError } from '../../api/client';
import type { Holiday, SeedHolidayRequest } from '../../types/api';
import { useAuth } from '../../context/useAuth';
import { useToast } from '../../hooks/useToast';
import { ThemeToggle } from '../../components/ThemeToggle';
import { ChevronLeft } from '../../components/icons';

const SUPPORTED_COUNTRY_CODES: SeedHolidayRequest['countryCode'][] = ['US', 'MX', 'CO', 'CL'];
const COUNTRY_LABELS: Record<SeedHolidayRequest['countryCode'], string> = {
  US: 'United States federal holidays',
  MX: 'Mexico federal holidays',
  CO: 'Colombia public holidays',
  CL: 'Chile public holidays',
};

interface FormState {
  date: string;
  name: string;
  countryCode: string;
  submitting: boolean;
  error: string | null;
}

function emptyForm(): FormState {
  return { date: '', name: '', countryCode: '', submitting: false, error: null };
}

export function AdminHolidaysPage(): JSX.Element {
  const { user, logout } = useAuth();
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [seeding, setSeeding] = useState<boolean>(false);
  const { push: pushToast } = useToast();

  const refetch = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await apiRequest<Holiday[]>('/holidays/all');
      setHolidays(list);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.body.message : 'Could not load holidays.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  async function handleCreate(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setForm((prev) => ({ ...prev, submitting: true, error: null }));
    const trimmed = {
      date: form.date.trim(),
      name: form.name.trim(),
      countryCode: form.countryCode.trim(),
    };
    try {
      const created = await apiRequest<Holiday>('/holidays', {
        method: 'POST',
        body: {
          date: trimmed.date,
          name: trimmed.name,
          countryCode: trimmed.countryCode === '' ? null : trimmed.countryCode,
        },
      });
      setForm(emptyForm());
      pushToast({
        tone: 'success',
        title: 'Holiday added.',
        description: `${created.name} on ${created.date}.`,
      });
      await refetch();
    } catch (err) {
      setForm((prev) => ({
        ...prev,
        submitting: false,
        error: err instanceof ApiError ? err.body.message : 'Could not add holiday.',
      }));
    }
  }

  async function handleDelete(id: string): Promise<void> {
    try {
      await apiRequest<void>(`/holidays/${encodeURIComponent(id)}`, { method: 'DELETE' });
      pushToast({ tone: 'success', title: 'Holiday removed.' });
      await refetch();
    } catch (err) {
      pushToast({
        tone: 'error',
        title: 'Could not remove holiday.',
        description: err instanceof ApiError ? err.body.message : 'Unknown error.',
      });
    }
  }

  async function handleSeed(countryCode: SeedHolidayRequest['countryCode']): Promise<void> {
    setSeeding(true);
    try {
      const result = await apiRequest<{ inserted: number; skipped: number; errors: string[] }>(
        '/holidays/seed',
        { method: 'POST', body: { countryCode } },
      );
      pushToast({
        tone: result.errors.length > 0 ? 'error' : 'success',
        title: `Seeded ${countryCode} holidays.`,
        description: `Inserted ${result.inserted}, skipped ${result.skipped}, errors ${result.errors.length}.`,
      });
      await refetch();
    } catch (err) {
      pushToast({
        tone: 'error',
        title: `Could not seed ${countryCode} holidays.`,
        description: err instanceof ApiError ? err.body.message : 'Unknown error.',
      });
    } finally {
      setSeeding(false);
    }
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
        <div className="flex items-center gap-3">
          <Link
            to="/calendar"
            data-testid="back-link"
            className="inline-flex min-h-11 items-center gap-1 rounded border border-border px-3 py-2 text-sm text-ink transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:border-border-dark dark:text-ink-dark dark:hover:bg-surface-dark-2 dark:focus-visible:ring-offset-surface-dark"
          >
            <ChevronLeft /> Back
          </Link>
          <h1 className="font-display text-xl font-semibold tracking-tight">Holidays</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm text-ink-muted dark:text-ink-muted-dark">
          <ThemeToggle />
          <Link
            to="/admin/users"
            data-testid="manage-users-link"
            className="min-h-11 rounded border border-border px-3 py-2 text-ink transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:border-border-dark dark:text-ink-dark dark:hover:bg-surface-dark-2 dark:focus-visible:ring-offset-surface-dark"
          >
            Manage users
          </Link>
          <span>
            {user.name}{' '}
            <span className="text-ink-muted/70 dark:text-ink-muted-dark/70">({user.role})</span>
          </span>
          <button
            type="button"
            onClick={() => void logout()}
            className="min-h-11 rounded border border-border px-3 py-2 transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:hover:bg-surface-dark-2 dark:focus-visible:ring-offset-surface-dark"
          >
            Sign out
          </button>
        </div>
      </header>

      <section className="mb-6 rounded-lg border border-border bg-surface-3 p-4 shadow-sm dark:border-border-dark dark:bg-surface-dark-3">
        <h2 className="mb-3 font-display text-base font-semibold">Seed defaults</h2>
        <p className="mb-3 text-sm text-ink-muted dark:text-ink-muted-dark">
          Insert a country&apos;s federal holidays. Existing rows on the same (date, country) are
          skipped.
        </p>
        <div className="flex flex-wrap gap-2">
          {SUPPORTED_COUNTRY_CODES.map((cc) => (
            <button
              key={cc}
              type="button"
              disabled={seeding}
              onClick={() => void handleSeed(cc)}
              data-testid={`seed-${cc}`}
              className="min-h-11 rounded border border-border bg-surface px-3 py-2 text-sm transition-colors duration-150 hover:bg-surface-2 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:border-border-dark dark:bg-surface-dark dark:hover:bg-surface-dark-2 dark:focus-visible:ring-offset-surface-dark"
            >
              {COUNTRY_LABELS[cc]}
            </button>
          ))}
        </div>
      </section>

      <section className="mb-6 rounded-lg border border-border bg-surface-3 p-4 shadow-sm dark:border-border-dark dark:bg-surface-dark-3">
        <h2 className="mb-3 font-display text-base font-semibold">Add a holiday</h2>
        <form
          onSubmit={(e) => void handleCreate(e)}
          data-testid="add-holiday-form"
          className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_2fr_120px_auto]"
        >
          <label className="flex flex-col text-sm">
            <span className="mb-1 font-medium">Date</span>
            <input
              type="date"
              required
              value={form.date}
              onChange={(e) => setForm((prev) => ({ ...prev, date: e.target.value }))}
              data-testid="add-holiday-date"
              className="min-h-11 rounded border border-border bg-surface px-3 py-2 font-mono text-ink dark:border-border-dark dark:bg-surface-dark dark:text-ink-dark"
            />
          </label>
          <label className="flex flex-col text-sm">
            <span className="mb-1 font-medium">Name</span>
            <input
              type="text"
              required
              maxLength={120}
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              data-testid="add-holiday-name"
              className="min-h-11 rounded border border-border bg-surface px-3 py-2 text-ink dark:border-border-dark dark:bg-surface-dark dark:text-ink-dark"
            />
          </label>
          <label className="flex flex-col text-sm">
            <span className="mb-1 font-medium">Country (optional)</span>
            <select
              value={form.countryCode}
              onChange={(e) => setForm((prev) => ({ ...prev, countryCode: e.target.value }))}
              data-testid="add-holiday-country"
              className="min-h-11 rounded border border-border bg-surface px-3 py-2 text-ink dark:border-border-dark dark:bg-surface-dark dark:text-ink-dark"
            >
              <option value="">—</option>
              {SUPPORTED_COUNTRY_CODES.map((cc) => (
                <option key={cc} value={cc}>
                  {cc}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={form.submitting}
            data-testid="add-holiday-submit"
            className="self-end rounded bg-accent px-4 py-2 text-sm font-medium text-ink-inverse transition-colors duration-150 hover:bg-accent-hover disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:focus-visible:ring-offset-surface-dark"
          >
            {form.submitting ? 'Adding…' : 'Add'}
          </button>
          {form.error ? (
            <p
              role="alert"
              data-testid="add-holiday-error"
              className="sm:col-span-4 text-sm text-danger"
            >
              {form.error}
            </p>
          ) : null}
        </form>
      </section>

      <section className="rounded-lg border border-border bg-surface-3 p-4 shadow-sm dark:border-border-dark dark:bg-surface-dark-3">
        <h2 className="mb-3 font-display text-base font-semibold">All holidays</h2>
        {loading ? (
          <p
            role="status"
            aria-busy="true"
            className="text-sm text-ink-muted dark:text-ink-muted-dark"
          >
            Loading…
          </p>
        ) : loadError ? (
          <p role="alert" className="text-sm text-danger">
            {loadError}
          </p>
        ) : holidays.length === 0 ? (
          <p className="text-sm text-ink-muted dark:text-ink-muted-dark">
            No holidays yet. Add one above, or seed defaults.
          </p>
        ) : (
          <ul data-testid="holiday-list" className="divide-y divide-border dark:divide-border-dark">
            {holidays.map((h) => (
              <li
                key={h.id}
                data-testid={`holiday-row-${h.date}-${h.countryCode ?? 'NONE'}`}
                className="flex items-center justify-between gap-3 py-2"
              >
                <div className="flex items-baseline gap-3">
                  <span className="font-mono text-sm tabular-nums text-ink-muted dark:text-ink-muted-dark">
                    {h.date}
                  </span>
                  <span className="text-sm">{h.name}</span>
                  {h.countryCode ? (
                    <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-muted dark:border-border-dark dark:text-ink-muted-dark">
                      {h.countryCode}
                    </span>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => void handleDelete(h.id)}
                  data-testid={`holiday-delete-${h.id}`}
                  className="min-h-11 rounded border border-border px-3 py-1.5 text-xs transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:border-border-dark dark:hover:bg-surface-dark-2 dark:focus-visible:ring-offset-surface-dark"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
