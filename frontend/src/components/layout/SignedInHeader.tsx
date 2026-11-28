import type { JSX } from 'react';
import { Link, matchPath, useLocation } from 'react-router-dom';
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

const API_ACCESS_PATH = '/settings/tokens';
const HOLIDAYS_PATH = '/admin/holidays';
const USERS_PATH = '/admin/users';

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
  const { pathname } = useLocation();
  const mayManage = user !== null && canManageUsers(user);
  // Use the same matching rules as the routes, including trailing slashes.
  const isCurrent = (path: string): boolean => matchPath({ path, end: true }, pathname) !== null;

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
          <DestinationLink
            to={API_ACCESS_PATH}
            label="API access"
            testId="api-access-link"
            current={isCurrent(API_ACCESS_PATH)}
          />
          {mayManage ? (
            <>
              <DestinationLink
                to={HOLIDAYS_PATH}
                label="Holidays"
                testId="manage-holidays-link"
                current={isCurrent(HOLIDAYS_PATH)}
              />
              <DestinationLink
                to={USERS_PATH}
                label="Manage users"
                testId="manage-users-link"
                current={isCurrent(USERS_PATH)}
              />
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

interface DestinationLinkProps {
  to: string;
  label: string;
  testId: string;
  /** Whether the destination is the route that is open. */
  current: boolean;
}

/**
 * One destination of the header navigation.
 *
 * The current destination is marked explicitly, so a route that is reached
 * with a trailing slash is marked too.
 */
function DestinationLink({ to, label, testId, current }: DestinationLinkProps): JSX.Element {
  return (
    <Link
      to={to}
      data-testid={testId}
      aria-current={current ? 'page' : undefined}
      className={destinationClass(current)}
    >
      {label}
    </Link>
  );
}

/**
 * One style for every destination. The active one is marked with the accent
 * border and the stronger surface, so the current page is recognizable
 * without relying on colour alone.
 */
function destinationClass(current: boolean): string {
  const base =
    'min-h-11 rounded border px-3 py-2 text-ink transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:text-ink-dark dark:focus-visible:ring-offset-surface-dark';
  return current
    ? `${base} border-accent bg-surface-2 font-semibold dark:bg-surface-dark-2`
    : `${base} border-border hover:bg-surface-2 dark:border-border-dark dark:hover:bg-surface-dark-2`;
}
