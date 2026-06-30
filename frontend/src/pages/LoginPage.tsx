import { useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/useAuth';
import { ThemeToggle } from '../components/ThemeToggle';

export function LoginPage(): JSX.Element {
  const { login, error, status } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (status === 'authenticated') {
      navigate('/calendar', { replace: true });
    }
  }, [status, navigate]);

  async function handleSubmit(event: ChangeEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    try {
      await login({ email, password });
    } catch {
      // Error is exposed via AuthContext; nothing to do here.
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
          PTO Calendar
        </h1>
        <p className="mb-6 text-sm text-ink-muted dark:text-ink-muted-dark">
          Sign in to manage your time off.
        </p>

        <label className="mb-3 block text-sm font-medium text-ink dark:text-ink-dark">
          Email
          <input
            type="email"
            autoComplete="username"
            required
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 block w-full min-h-11 rounded border border-border bg-surface-2 px-3 py-2 text-sm text-ink focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-0 dark:border-border-dark dark:bg-surface-dark-2 dark:text-ink-dark"
          />
        </label>

        <label className="mb-4 block text-sm font-medium text-ink dark:text-ink-dark">
          Password
          <input
            type="password"
            autoComplete="current-password"
            required
            maxLength={72}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
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
          disabled={submitting}
          className="min-h-11 w-full rounded bg-accent px-4 py-2 text-sm font-medium text-ink-inverse transition-colors duration-150 hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-60 dark:focus-visible:ring-offset-surface-dark"
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
