import { createContext } from 'react';

export type ToastTone = 'success' | 'error';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastInput {
  tone: ToastTone;
  title: string;
  description?: string;
  action?: ToastAction;
  durationMs?: number;
}

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
  action?: ToastAction;
  durationMs: number;
  createdAt: number;
}

export interface ToastContextValue {
  toasts: Toast[];
  push: (input: ToastInput) => string;
  dismiss: (id: string) => void;
}

export const ToastContext = createContext<ToastContextValue | undefined>(undefined);
