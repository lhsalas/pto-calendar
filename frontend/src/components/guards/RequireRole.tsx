import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../../context/useAuth';
import type { Role } from '../../lib/permissions';

interface RequireRoleProps {
  role: Role;
  children: ReactNode;
}

/**
 * Route guard. Redirects to /login if unauthenticated, or to /calendar if
 * the authenticated user's role doesn't match the required role.
 */
export function RequireRole({ role, children }: RequireRoleProps): JSX.Element {
  const { user, status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div className="flex min-h-full items-center justify-center bg-surface p-6 dark:bg-surface-dark">
        <p className="text-sm text-ink-muted dark:text-ink-muted-dark">Loading…</p>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  const allowed =
    role === 'team_lead' ? user.role === 'team_lead' || user.role === 'admin' : user.role === role;
  if (!allowed) {
    return <Navigate to="/calendar" replace />;
  }

  return <>{children}</>;
}
