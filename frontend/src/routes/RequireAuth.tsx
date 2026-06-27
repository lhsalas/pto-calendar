import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/useAuth';

export function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const { status } = useAuth();
  if (status === 'loading') {
    return (
      <div className="flex min-h-full items-center justify-center text-sm text-slate-500">
        Loading…
      </div>
    );
  }
  if (status === 'unauthenticated') {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
