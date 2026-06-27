import type { ChangeEvent } from 'react';
import { useState } from 'react';
import { useAuth } from '../context/useAuth';

export function LoginPage(): JSX.Element {
  const { login, error, status } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

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
    <main className="flex min-h-full items-center justify-center bg-slate-50 p-6">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h1 className="mb-1 text-xl font-semibold text-slate-900">PTO Calendar</h1>
        <p className="mb-6 text-sm text-slate-500">Sign in to manage your time off.</p>

        <label className="mb-3 block text-sm font-medium text-slate-700">
          Email
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </label>

        <label className="mb-4 block text-sm font-medium text-slate-700">
          Password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </label>

        {error ? (
          <p role="alert" className="mb-3 text-sm text-red-600">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={submitting || status === 'loading'}
          className="w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
