import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/useAuth';

export function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const { status } = useAuth();
  if (status === 'loading') {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading"
        className="flex min-h-full items-center justify-center gap-2 text-sm text-ink-muted dark:text-ink-muted-dark"
      >
        <span className="h-3 w-3 animate-pulse rounded-full bg-accent" />
        Loading…
      </div>
    );
  }
  if (status === 'unauthenticated') {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
