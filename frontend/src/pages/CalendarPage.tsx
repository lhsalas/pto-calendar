import { useAuth } from '../context/useAuth';

export function CalendarPage(): JSX.Element {
  const { user, logout } = useAuth();
  return (
    <div className="min-h-full p-6">
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

      <section className="rounded-lg border border-dashed border-slate-300 bg-white p-12 text-center text-slate-500">
        Calendar grid will land in Sprint 3.
      </section>
    </div>
  );
}
