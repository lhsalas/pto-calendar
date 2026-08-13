import { useEffect, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useAuth } from '../context/useAuth';
import { ThemeToggle } from '../components/ThemeToggle';

export function SetupAccountPage(): JSX.Element {
  const location = useLocation();
  const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
  const queryToken = new URLSearchParams(location.search).get('token');
  const hashToken = hashParams.get('token');
  const token = queryToken ?? hashToken ?? '';
  const { setupAccount } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!queryToken && !hashToken) return;
    const queryParams = new URLSearchParams(location.search);
    queryParams.delete('token');
    const query = queryParams.toString();
    window.history.replaceState(
      null,
      document.title,
      `${location.pathname}${query ? `?${query}` : ''}`,
    );
  }, [hashToken, location.pathname, location.search, queryToken]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      await setupAccount({ token, password });
      navigate('/calendar', { replace: true });
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 401
          ? 'This setup link is invalid or has already been used.'
          : err instanceof Error
            ? err.message
            : 'Could not set password.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-full flex-col items-center justify-center bg-surface p-6 dark:bg-surface-dark">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-lg border border-border bg-surface-3 p-6 shadow-sm dark:border-border-dark dark:bg-surface-dark-3"
      >
        <h1 className="mb-1 font-display text-2xl font-semibold tracking-tight text-ink dark:text-ink-dark">
          Set your password
        </h1>
        <p className="mb-6 text-sm text-ink-muted dark:text-ink-muted-dark">
          Welcome! Pick a password to finish creating your account.
        </p>

        <label className="mb-3 block text-sm font-medium text-ink dark:text-ink-dark">
          Password
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            maxLength={72}
            value={password}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
            className="mt-1 block w-full min-h-11 rounded border border-border bg-surface-2 px-3 py-2 text-sm text-ink focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-0 dark:border-border-dark dark:bg-surface-dark-2 dark:text-ink-dark"
          />
        </label>

        <label className="mb-4 block text-sm font-medium text-ink dark:text-ink-dark">
          Confirm password
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            maxLength={72}
            value={confirm}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setConfirm(e.target.value)}
            className="mt-1 block w-full min-h-11 rounded border border-border bg-surface-2 px-3 py-2 text-sm text-ink focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-0 dark:border-border-dark dark:bg-surface-dark-2 dark:text-ink-dark"
          />
        </label>

        {error ? (
          <p role="alert" className="mb-3 text-sm text-danger">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={submitting || !token}
          className="min-h-11 w-full rounded bg-accent px-4 py-2 text-sm font-medium text-ink-inverse transition-colors duration-150 hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-60 dark:focus-visible:ring-offset-surface-dark"
        >
          {submitting ? 'Setting password…' : 'Set password'}
        </button>
      </form>
    </main>
  );
}
