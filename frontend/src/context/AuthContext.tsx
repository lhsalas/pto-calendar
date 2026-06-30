import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { apiRequest, ApiError } from '../api/client';
import type { LoginRequest, LoginResponse, User } from '../types/api';
import { AuthContext } from './authContextValue';
import type { AuthContextValue, AuthState } from './authContextValue';

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<AuthState>({
    user: null,
    status: 'loading',
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    apiRequest<User>('/auth/me')
      .then((user) => {
        if (cancelled) return;
        setState({ user, status: 'authenticated', error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          setState({ user: null, status: 'unauthenticated', error: null });
        } else {
          setState({ user: null, status: 'unauthenticated', error: 'Could not reach server' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (credentials: LoginRequest) => {
    setState((prev) => ({ ...prev, error: null }));
    try {
      const res = await apiRequest<LoginResponse>('/auth/login', {
        method: 'POST',
        body: credentials,
      });
      setState({ user: res.user, status: 'authenticated', error: null });
    } catch (err) {
      const message = err instanceof ApiError ? err.body.message : 'Login failed';
      setState((prev) => ({ ...prev, error: message }));
      throw err;
    }
  }, []);

  const logout = useCallback(async () => {
    await apiRequest<void>('/auth/logout', { method: 'POST' });
    setState({ user: null, status: 'unauthenticated', error: null });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, login, logout }),
    [state, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
