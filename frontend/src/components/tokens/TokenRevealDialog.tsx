import type { JSX } from 'react';
import type { RefObject } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { useToast } from '../../hooks/useToast';
import { useTokenDialog } from '../../hooks/useTokenDialog';
import { formatAbsoluteDateTime, scopeOption } from '../../lib/tokens';
import type { TokenMetadata } from '../../types/api';

export interface TokenRevealDialogProps {
  token: TokenMetadata | null;
  rawToken: string;
  onClose: () => void;
  /** Where the focus returns to; the trigger outlives this dialog. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Shows a freshly issued token exactly once.
 *
 * The dialog is mounted only while it is open, so closing it removes the
 * secret from the document at once: there is no exit transition that could
 * keep a credential in the page. The secret lives in the caller's memory
 * only; it is never written to storage, the URL, a toast or a log. Copying
 * is an explicit user action, and a blocked clipboard falls back to a
 * manually selectable value.
 */
export function TokenRevealDialog({
  token,
  rawToken,
  onClose,
  returnFocusRef,
}: TokenRevealDialogProps): JSX.Element {
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const valueRef = useRef<HTMLInputElement | null>(null);
  const { push: pushToast } = useToast();
  const cardRef = useTokenDialog<HTMLDivElement>(true, onClose, returnFocusRef);

  // Clear the value before the input is detached, including the synchronous
  // unmount on pagehide. Do not leave secret text in a detached control.
  useLayoutEffect(() => {
    const field = valueRef.current;
    return () => {
      if (field) field.value = '';
    };
  }, []);

  function handleBackdropClick(event: React.MouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) onClose();
  }

  async function handleCopy(): Promise<void> {
    if (!rawToken) return;
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      setCopyState('failed');
      return;
    }
    try {
      await clipboard.writeText(rawToken);
      setCopyState('copied');
      // The toast never carries the secret itself.
      pushToast({ tone: 'success', title: 'Token copied to your clipboard.' });
    } catch {
      setCopyState('failed');
    }
  }

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-labelledby="token-reveal-title"
      onClick={handleBackdropClick}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 dark:bg-ink-dark/40"
    >
      <motion.div
        ref={cardRef}
        initial={{ y: 8, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        className="my-8 w-full max-w-lg rounded-lg border border-border bg-surface-3 p-6 shadow-lg dark:border-border-dark dark:bg-surface-dark-3"
      >
        <h2
          id="token-reveal-title"
          className="mb-1 font-display text-xl font-semibold tracking-tight text-ink dark:text-ink-dark"
        >
          Copy your token
        </h2>
        <p className="mb-4 text-sm text-ink-muted dark:text-ink-muted-dark">
          This is the only time the secret is shown. If you lose it, revoke the token and create
          another one — it cannot be recovered.
        </p>

        <label
          htmlFor="new-token-value"
          className="block text-sm font-medium text-ink dark:text-ink-dark"
        >
          New token
          <input
            id="new-token-value"
            ref={valueRef}
            type="text"
            readOnly
            value={rawToken}
            onFocus={(event) => event.currentTarget.select()}
            autoComplete="off"
            spellCheck={false}
            data-testid="new-token-value"
            className="mt-1 block w-full break-all rounded border border-border bg-surface-2 px-3 py-2 font-mono text-xs text-ink focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-0 dark:border-border-dark dark:bg-surface-dark-2 dark:text-ink-dark"
          />
          <span className="mt-1 block text-xs text-ink-muted dark:text-ink-muted-dark">
            Select the value and copy it manually if the browser blocks the copy button.
          </span>
        </label>

        {token ? (
          <dl className="mt-4 grid gap-2 text-sm">
            <div className="flex flex-wrap gap-x-2">
              <dt className="font-medium text-ink dark:text-ink-dark">Expires</dt>
              <dd
                className="font-mono text-xs break-all tabular-nums text-ink-muted dark:text-ink-muted-dark"
                data-testid="token-reveal-expiry"
              >
                {formatAbsoluteDateTime(token.expiresAt)}
              </dd>
            </div>
            <div className="flex flex-wrap gap-x-2">
              <dt className="font-medium text-ink dark:text-ink-dark">Scopes</dt>
              <dd className="font-mono text-xs break-words text-ink-muted dark:text-ink-muted-dark">
                {token.scopes.length > 0
                  ? token.scopes.map((scope) => scopeOption(scope)?.label ?? scope).join(', ')
                  : 'None'}
              </dd>
            </div>
          </dl>
        ) : null}

        {copyState === 'copied' ? (
          <p role="status" className="mt-4 text-sm text-success" data-testid="token-copy-status">
            Copied to your clipboard.
          </p>
        ) : null}
        {copyState === 'failed' ? (
          <p role="alert" className="mt-4 text-sm text-danger" data-testid="token-copy-status">
            Copying was blocked. Select the value above and copy it manually.
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="min-h-11 rounded border border-border px-3 py-2 text-sm text-ink transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:border-border-dark dark:text-ink-dark dark:hover:bg-surface-dark-2 dark:focus-visible:ring-offset-surface-dark"
          >
            Copy token
          </button>
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 rounded bg-accent px-4 py-2 text-sm font-medium text-ink-inverse transition-colors duration-150 hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:focus-visible:ring-offset-surface-dark"
          >
            Done
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
