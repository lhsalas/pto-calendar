import type { JSX } from 'react';
import type { FormEvent, RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import type { Role, TokenScope } from '../../types/api';
import {
  DEFAULT_TOKEN_EXPIRY_DAYS,
  DEFAULT_TOKEN_SCOPES,
  TOKEN_EXPIRY_OPTIONS,
  normalizeTokenScopes,
  validateTokenName,
  validateTokenPassword,
} from '../../lib/tokens';
import { useTokenDialog } from '../../hooks/useTokenDialog';
import { TokenScopePicker } from './TokenScopePicker';

export interface TokenCreateValues {
  name: string;
  password: string;
  scopes: TokenScope[];
  expiresInDays: number;
}

export interface TokenCreateDialogProps {
  role: Role;
  submitting: boolean;
  /** Safe, static copy for a failed request. */
  error: string | null;
  onSubmit: (values: TokenCreateValues) => void;
  onClose: () => void;
  /** Where the focus returns to; the trigger outlives this dialog. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

type FieldName = 'name' | 'password' | 'scopes';

interface FieldError {
  field: FieldName;
  message: string;
}

/**
 * Issuance form for one personal access token.
 *
 * The dialog is mounted only while it is open, so closing it unmounts the
 * form and the password with it: there is no exit transition that could keep
 * a credential in the document. The current password is held in component
 * state only, is cleared the moment the form is submitted or closed, and is
 * never stored, logged or put in the URL.
 */
export function TokenCreateDialog({
  role,
  submitting,
  error,
  onSubmit,
  onClose,
  returnFocusRef,
}: TokenCreateDialogProps): JSX.Element {
  const [name, setName] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [expiresInDays, setExpiresInDays] = useState<number>(DEFAULT_TOKEN_EXPIRY_DAYS);
  const [scopes, setScopes] = useState<TokenScope[]>([...DEFAULT_TOKEN_SCOPES]);
  const [fieldError, setFieldError] = useState<FieldError | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);

  const cardRef = useTokenDialog<HTMLFormElement>(true, onClose, returnFocusRef);

  // A native navigation or a frozen back/forward cache must not keep the
  // password around, so the field is emptied synchronously as well.
  useEffect(() => {
    function handlePageHide(): void {
      if (passwordRef.current) passwordRef.current.value = '';
      setPassword('');
    }
    window.addEventListener('pagehide', handlePageHide);
    return () => window.removeEventListener('pagehide', handlePageHide);
  }, []);

  function handleBackdropClick(event: React.MouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) handleClose();
  }

  function handleClose(): void {
    if (passwordRef.current) passwordRef.current.value = '';
    setPassword('');
    setFieldError(null);
    onClose();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (submitting) return;
    const nameError = validateTokenName(name);
    if (nameError) {
      setFieldError({ field: 'name', message: nameError });
      return;
    }
    const passwordError = validateTokenPassword(password);
    if (passwordError) {
      setFieldError({ field: 'password', message: passwordError });
      return;
    }
    const selectedScopes = normalizeTokenScopes(scopes, role);
    if (selectedScopes.length === 0) {
      setFieldError({ field: 'scopes', message: 'Select at least one scope.' });
      return;
    }
    setFieldError(null);
    const values: TokenCreateValues = {
      name: name.trim(),
      password,
      scopes: selectedScopes,
      expiresInDays,
    };
    // The password leaves component state with the submission; it is never
    // kept around while the request is in flight.
    if (passwordRef.current) passwordRef.current.value = '';
    setPassword('');
    onSubmit(values);
  }

  const message = fieldError?.message ?? error;
  const nameInvalid = fieldError?.field === 'name';
  const passwordInvalid = fieldError?.field === 'password';
  const scopesInvalid = fieldError?.field === 'scopes';

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-labelledby="token-create-title"
      onClick={handleBackdropClick}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 dark:bg-ink-dark/40"
    >
      <motion.form
        ref={cardRef}
        onSubmit={handleSubmit}
        aria-busy={submitting}
        aria-describedby={message ? 'token-create-error' : undefined}
        initial={{ y: 8, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        className="my-8 w-full max-w-lg rounded-lg border border-border bg-surface-3 p-6 shadow-lg dark:border-border-dark dark:bg-surface-dark-3"
      >
        <h2
          id="token-create-title"
          className="mb-1 font-display text-xl font-semibold tracking-tight text-ink dark:text-ink-dark"
        >
          New personal access token
        </h2>
        <p className="mb-4 text-sm text-ink-muted dark:text-ink-muted-dark">
          The token belongs to your account. The secret is shown once, right after it is created.
        </p>

        <div className="mb-4 grid gap-4">
          <label
            htmlFor="token-name"
            className="block text-sm font-medium text-ink dark:text-ink-dark"
          >
            Token name
            <input
              id="token-name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={nameInvalid || undefined}
              aria-describedby={nameInvalid && message ? 'token-create-error' : undefined}
              className="mt-1 block w-full rounded border border-border bg-surface-2 px-3 py-2 text-sm text-ink focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-0 dark:border-border-dark dark:bg-surface-dark-2 dark:text-ink-dark"
            />
            <span className="mt-1 block text-xs text-ink-muted dark:text-ink-muted-dark">
              Up to 120 characters. Spaces at the ends are removed.
            </span>
          </label>

          <label
            htmlFor="token-password"
            className="block text-sm font-medium text-ink dark:text-ink-dark"
          >
            Current password
            <input
              id="token-password"
              ref={passwordRef}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              aria-invalid={passwordInvalid || undefined}
              aria-describedby={passwordInvalid && message ? 'token-create-error' : undefined}
              className="mt-1 block w-full rounded border border-border bg-surface-2 px-3 py-2 text-sm text-ink focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-0 dark:border-border-dark dark:bg-surface-dark-2 dark:text-ink-dark"
            />
            <span className="mt-1 block text-xs text-ink-muted dark:text-ink-muted-dark">
              Confirms it is you. The password is checked on the server and never stored here.
            </span>
          </label>

          <label
            htmlFor="token-expiry"
            className="block text-sm font-medium text-ink dark:text-ink-dark"
          >
            Expires after
            <select
              id="token-expiry"
              value={expiresInDays}
              onChange={(event) => setExpiresInDays(Number(event.target.value))}
              className="mt-1 block w-full rounded border border-border bg-surface-2 px-3 py-2 text-sm text-ink focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-0 dark:border-border-dark dark:bg-surface-dark-2 dark:text-ink-dark"
            >
              {TOKEN_EXPIRY_OPTIONS.map((days) => (
                <option key={days} value={days}>
                  {days} days
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mb-4">
          <TokenScopePicker
            role={role}
            scopes={scopes}
            onChange={setScopes}
            invalid={scopesInvalid}
          />
        </div>

        {message ? (
          <p id="token-create-error" role="alert" className="mb-3 text-sm text-danger">
            {message}
          </p>
        ) : null}

        {submitting ? (
          <p role="status" className="mb-3 text-sm text-ink-muted dark:text-ink-muted-dark">
            Creating token…
          </p>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={handleClose}
            className="min-h-11 rounded border border-border px-3 py-2 text-sm text-ink transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:border-border-dark dark:text-ink-dark dark:hover:bg-surface-dark-2 dark:focus-visible:ring-offset-surface-dark"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="min-h-11 rounded bg-accent px-4 py-2 text-sm font-medium text-ink-inverse transition-colors duration-150 hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-60 dark:focus-visible:ring-offset-surface-dark"
          >
            Create token
          </button>
        </div>
      </motion.form>
    </motion.div>
  );
}
