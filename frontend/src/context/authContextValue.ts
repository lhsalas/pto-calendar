import { createContext } from 'react';
import type { LoginRequest, SetupAccountRequest, User } from '../types/api';

export interface AuthState {
  user: User | null;
  status: 'loading' | 'authenticated' | 'unauthenticated';
  error: string | null;
}

export interface AuthContextValue extends AuthState {
  login: (credentials: LoginRequest) => Promise<void>;
  logout: () => Promise<void>;
  setupAccount: (input: SetupAccountRequest) => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);
