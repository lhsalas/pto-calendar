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
    <main className="flex min-h-full flex-col items-center justify-center bg-slate-50 p-6 dark:bg-slate-950">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900"
      >
        <h1 className="mb-1 text-xl font-semibold text-slate-900 dark:text-slate-100">
          PTO Calendar
        </h1>
        <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">
          Sign in to manage your time off.
        </p>

        <label className="mb-3 block text-sm font-medium text-slate-700 dark:text-slate-300">
          Email
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 block w-full min-h-11 rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          />
        </label>

        <label className="mb-4 block text-sm font-medium text-slate-700 dark:text-slate-300">
          Password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 block w-full min-h-11 rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          />
        </label>

        {error ? (
          <p role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={submitting}
          className="min-h-11 w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
