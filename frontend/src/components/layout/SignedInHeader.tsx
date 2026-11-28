import type { JSX } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../../context/useAuth';
import { canManageUsers } from '../../lib/permissions';
import { ThemeToggle } from '../ThemeToggle';
import { ChevronLeft } from '../icons';

interface SignedInHeaderProps {
  /** The one heading of the route. */
  title: string;
  /** Whether the route offers a way back to the calendar. */
  showBackToCalendar?: boolean;
  /** Extra classes for the header element, e.g. its bottom spacing. */
  className?: string;
}

/**
 * The top menu of every signed-in route.
 *
 * The pattern is the Calendar/Holidays one: the title on the left, the
 * account controls on the right. The controls always keep the same order —
 * theme, page navigation, signed-in identity, sign out — so a reader finds
 * the same thing in the same place on every route. The destinations are the
 * ones the signed-in role may visit: API access for everybody, Holidays and
 * Manage users for team leads and admins. The current destination carries
 * `aria-current="page"` and a visible emphasis.
 *
 * The component never decides what a route may show: the guards in
 * `frontend/src/routes/AppRoutes.tsx` stay where they are, and this header
 * only mirrors them for the navigation it offers.
 */
export function SignedInHeader({
  title,
  showBackToCalendar = false,
  className = '',
}: SignedInHeaderProps): JSX.Element {
  const { user, logout } = useAuth();
  const mayManage = user !== null && canManageUsers(user);

  return (
    <header className={`flex flex-wrap items-center justify-between gap-3 ${className}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        {showBackToCalendar ? (
          <Link
            to="/calendar"
            data-testid="back-to-calendar-link"
            className="inline-flex min-h-11 items-center gap-1 rounded border border-border px-3 py-2 text-sm text-ink transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:border-border-dark dark:text-ink-dark dark:hover:bg-surface-dark-2 dark:focus-visible:ring-offset-surface-dark"
          >
            <ChevronLeft aria-hidden className="h-4 w-4" />
            Back to calendar
          </Link>
        ) : null}
        <h1 className="font-display text-xl font-semibold tracking-tight text-ink dark:text-ink-dark">
          {title}
        </h1>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-3 text-sm text-ink-muted dark:text-ink-muted-dark">
        {/* The switcher keeps its own width so its options are never clipped. */}
        <div className="shrink-0">
          <ThemeToggle />
        </div>

        <nav aria-label="Main" className="flex min-w-0 flex-wrap items-center gap-3">
          <NavLink to="/settings/tokens" end data-testid="api-access-link" className={navLinkClass}>
            API access
          </NavLink>
          {mayManage ? (
            <>
              <NavLink
                to="/admin/holidays"
                end
                data-testid="manage-holidays-link"
                className={navLinkClass}
              >
                Holidays
              </NavLink>
              <NavLink
                to="/admin/users"
                end
                data-testid="manage-users-link"
                className={navLinkClass}
              >
                Manage users
              </NavLink>
            </>
          ) : null}
        </nav>

        {user ? (
          <span data-testid="signed-in-user" className="min-w-0 max-w-full break-words">
            {user.name}{' '}
            <span className="text-ink-muted/70 dark:text-ink-muted-dark/70">({user.role})</span>
          </span>
        ) : null}

        <button
          type="button"
          onClick={() => void logout()}
          className="min-h-11 rounded border border-border px-3 py-2 transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:border-border-dark dark:hover:bg-surface-dark-2 dark:focus-visible:ring-offset-surface-dark"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}

/**
 * One style for every destination. The active one is marked with the accent
 * border and the stronger surface, so the current page is recognizable
 * without relying on colour alone.
 */
function navLinkClass({ isActive }: { isActive: boolean }): string {
  const base =
    'min-h-11 rounded border px-3 py-2 text-ink transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:text-ink-dark dark:focus-visible:ring-offset-surface-dark';
  return isActive
    ? `${base} border-accent bg-surface-2 font-semibold dark:bg-surface-dark-2`
    : `${base} border-border hover:bg-surface-2 dark:border-border-dark dark:hover:bg-surface-dark-2`;
}
