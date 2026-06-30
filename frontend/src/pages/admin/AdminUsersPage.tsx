import { useCallback, useEffect, useState } from 'react';
import { apiRequest, ApiError } from '../../api/client';
import type {
  CreateUserRequest,
  CreateUserResponse,
  ResetPasswordResponse,
  User,
} from '../../types/api';
import { ThemeToggle } from '../../components/ThemeToggle';

interface FormState {
  email: string;
  name: string;
  submitting: boolean;
  error: string | null;
}

interface CreatedState {
  email: string;
  setupToken: string;
  expiresAt: string;
}

interface ResetState {
  userId: string;
  setupToken: string;
  expiresAt: string;
}

export function AdminUsersPage(): JSX.Element {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>({
    email: '',
    name: '',
    submitting: false,
    error: null,
  });
  const [created, setCreated] = useState<CreatedState | null>(null);
  const [reset, setReset] = useState<ResetState | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');

  const refetch = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await apiRequest<User[]>('/users');
      setUsers(list);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load users.');
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
    const payload: CreateUserRequest = {
      email: form.email.trim(),
      name: form.name.trim(),
    };
    try {
      const res = await apiRequest<CreateUserResponse>('/users', {
        method: 'POST',
        body: payload,
      });
      setCreated({
        email: res.user.email,
        setupToken: res.setupToken,
        expiresAt: res.expiresAt,
      });
      setForm({ email: '', name: '', submitting: false, error: null });
      void refetch();
    } catch (err) {
      setForm((prev) => ({
        ...prev,
        submitting: false,
        error: err instanceof ApiError ? err.body.message : 'Could not create user.',
      }));
    }
  }

  async function handleReset(userId: string): Promise<void> {
    try {
      const res = await apiRequest<ResetPasswordResponse>(
        `/users/${encodeURIComponent(userId)}/reset-password`,
        {
          method: 'POST',
        },
      );
      setReset({ userId, setupToken: res.setupToken, expiresAt: res.expiresAt });
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.body.message : 'Could not reset password.');
    }
  }

  async function handleCopy(token: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(token);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      // ignore — user can manually copy
    }
  }

  return (
    <main className="min-h-full bg-surface p-6 dark:bg-surface-dark">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="mx-auto max-w-3xl space-y-6">
        <header>
          <h1 className="mb-1 font-display text-2xl font-semibold tracking-tight text-ink dark:text-ink-dark">
            Manage users
          </h1>
          <p className="text-sm text-ink-muted dark:text-ink-muted-dark">
            Create new members and reset passwords. The setup link is shown once — copy it to share
            with the new member.
          </p>
        </header>

        <section className="rounded-lg border border-border bg-surface-3 p-4 shadow-sm dark:border-border-dark dark:bg-surface-dark-3">
          <h2 className="mb-3 font-display text-lg font-semibold text-ink dark:text-ink-dark">
            Add a user
          </h2>
          <form onSubmit={handleCreate} className="space-y-3">
            <label className="block text-sm font-medium text-ink dark:text-ink-dark">
              Name
              <input
                type="text"
                required
                maxLength={120}
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                className="mt-1 block w-full min-h-11 rounded border border-border bg-surface-2 px-3 py-2 text-sm text-ink focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-0 dark:border-border-dark dark:bg-surface-dark-2 dark:text-ink-dark"
              />
            </label>
            <label className="block text-sm font-medium text-ink dark:text-ink-dark">
              Email
              <input
                type="email"
                required
                maxLength={254}
                value={form.email}
                onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
                className="mt-1 block w-full min-h-11 rounded border border-border bg-surface-2 px-3 py-2 text-sm text-ink focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-0 dark:border-border-dark dark:bg-surface-dark-2 dark:text-ink-dark"
              />
            </label>
            {form.error ? (
              <p role="alert" className="text-sm text-danger">
                {form.error}
              </p>
            ) : null}
            <button
              type="submit"
              disabled={form.submitting}
              className="min-h-11 rounded bg-accent px-4 py-2 text-sm font-medium text-ink-inverse transition-colors duration-150 hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-60 dark:focus-visible:ring-offset-surface-dark"
            >
              {form.submitting ? 'Creating…' : 'Create user'}
            </button>
          </form>
        </section>

        {created ? (
          <section className="rounded-lg border border-border bg-surface-3 p-4 shadow-sm dark:border-border-dark dark:bg-surface-dark-3">
            <h2 className="mb-2 font-display text-lg font-semibold text-ink dark:text-ink-dark">
              Setup link for {created.email}
            </h2>
            <p className="mb-2 text-sm text-ink-muted dark:text-ink-muted-dark">
              This link expires at {new Date(created.expiresAt).toLocaleString()}. Share it with the
              new member. The link is shown only once.
            </p>
            <div className="mb-2 flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={`${window.location.origin}/setup-account?token=${created.setupToken}`}
                className="block w-full rounded border border-border bg-surface-2 px-3 py-2 text-xs text-ink focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-0 dark:border-border-dark dark:bg-surface-dark-2 dark:text-ink-dark"
              />
              <button
                type="button"
                onClick={() => void handleCopy(created.setupToken)}
                className="min-h-11 rounded bg-accent px-3 py-2 text-sm font-medium text-ink-inverse transition-colors duration-150 hover:bg-accent-hover"
              >
                {copyState === 'copied' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <button
              type="button"
              onClick={() => setCreated(null)}
              className="text-sm text-ink-muted underline hover:text-ink dark:text-ink-muted-dark dark:hover:text-ink-dark"
            >
              Dismiss
            </button>
          </section>
        ) : null}

        <section className="rounded-lg border border-border bg-surface-3 p-4 shadow-sm dark:border-border-dark dark:bg-surface-dark-3">
          <h2 className="mb-3 font-display text-lg font-semibold text-ink dark:text-ink-dark">
            Users
          </h2>
          {loadError ? (
            <p role="alert" className="mb-3 text-sm text-danger">
              {loadError}
            </p>
          ) : null}
          {loading ? (
            <p className="text-sm text-ink-muted dark:text-ink-muted-dark">Loading…</p>
          ) : (
            <ul className="space-y-2">
              {users.map((u) => (
                <li
                  key={u.id}
                  className="flex items-center justify-between gap-2 rounded border border-border bg-surface-2 p-3 dark:border-border-dark dark:bg-surface-dark-2"
                >
                  <div>
                    <div className="text-sm font-medium text-ink dark:text-ink-dark">
                      {u.name}{' '}
                      <span className="ml-1 text-xs text-ink-muted dark:text-ink-muted-dark">
                        ({u.role})
                      </span>
                    </div>
                    <div className="text-xs text-ink-muted dark:text-ink-muted-dark">{u.email}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleReset(u.id)}
                    className="min-h-9 rounded border border-border bg-surface px-3 py-1 text-xs text-ink transition-colors duration-150 hover:bg-surface-3 dark:border-border-dark dark:bg-surface-dark dark:text-ink-dark dark:hover:bg-surface-dark-3"
                  >
                    Reset password
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {reset ? (
          <section className="rounded-lg border border-border bg-surface-3 p-4 shadow-sm dark:border-border-dark dark:bg-surface-dark-3">
            <h2 className="mb-2 font-display text-lg font-semibold text-ink dark:text-ink-dark">
              New password setup link
            </h2>
            <p className="mb-2 text-sm text-ink-muted dark:text-ink-muted-dark">
              Expires at {new Date(reset.expiresAt).toLocaleString()}. Share with the user.
            </p>
            <div className="mb-2 flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={`${window.location.origin}/setup-account?token=${reset.setupToken}`}
                className="block w-full rounded border border-border bg-surface-2 px-3 py-2 text-xs text-ink focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-0 dark:border-border-dark dark:bg-surface-dark-2 dark:text-ink-dark"
              />
              <button
                type="button"
                onClick={() => void handleCopy(reset.setupToken)}
                className="min-h-11 rounded bg-accent px-3 py-2 text-sm font-medium text-ink-inverse transition-colors duration-150 hover:bg-accent-hover"
              >
                {copyState === 'copied' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <button
              type="button"
              onClick={() => setReset(null)}
              className="text-sm text-ink-muted underline hover:text-ink dark:text-ink-muted-dark dark:hover:text-ink-dark"
            >
              Dismiss
            </button>
          </section>
        ) : null}
      </div>
    </main>
  );
}
