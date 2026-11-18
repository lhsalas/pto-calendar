import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/useAuth';
import { useToast } from '../../hooks/useToast';
import { useTokens } from '../../hooks/useTokens';
import { issueToken } from '../../api/tokens';
import { ThemeToggle } from '../../components/ThemeToggle';
import { TokenCard } from '../../components/tokens/TokenCard';
import { TokenConfirmDialog } from '../../components/tokens/TokenConfirmDialog';
import { TokenCreateDialog } from '../../components/tokens/TokenCreateDialog';
import type { TokenCreateValues } from '../../components/tokens/TokenCreateDialog';
import { TokenRevealDialog } from '../../components/tokens/TokenRevealDialog';
import { isAbortError, tokenErrorMessage } from '../../lib/tokens';
import type { TokenMetadata, User } from '../../types/api';

interface RevealedToken {
  rawToken: string;
  token: TokenMetadata;
}

type ConfirmState = { kind: 'one'; token: TokenMetadata } | { kind: 'all' } | null;

/**
 * Self-service account page for personal access tokens.
 *
 * The signed-in account owns everything on this page. The private pane is
 * mounted per account, so a swap of the signed-in user starts a fresh list
 * and drops the previous one, and the raw secret is held in component
 * memory for the length of the reveal dialog only — never in storage, the
 * URL, a toast or a log.
 */
export function TokenSettingsPage(): JSX.Element {
  const { user } = useAuth();

  if (!user) {
    return (
      <div role="status" aria-busy="true" className="p-6 text-ink-muted dark:text-ink-muted-dark">
        Loading…
      </div>
    );
  }

  return <TokenSettingsPane key={user.id} user={user} />;
}

interface TokenSettingsPaneProps {
  user: User;
}

function TokenSettingsPane({ user }: TokenSettingsPaneProps): JSX.Element {
  const { logout } = useAuth();
  const { push: pushToast } = useToast();
  const { tokens, loading, error, refetch, revoke, revokeAll } = useTokens(user.id);

  const generateTriggerRef = useRef<HTMLButtonElement | null>(null);
  const revokeAllTriggerRef = useRef<HTMLButtonElement | null>(null);
  const revokeTriggerRef = useRef<HTMLElement | null>(null);

  const [createOpen, setCreateOpen] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<RevealedToken | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [revoking, setRevoking] = useState<boolean>(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const issueGeneration = useRef<number>(0);
  const issueAbort = useRef<AbortController | null>(null);
  const issuingRef = useRef<boolean>(false);
  const revokingRef = useRef<boolean>(false);
  const mountedRef = useRef<boolean>(true);

  const cancelIssuance = useCallback((): void => {
    issueGeneration.current += 1;
    issueAbort.current?.abort();
    issueAbort.current = null;
    issuingRef.current = false;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // A late issuance response must never be rendered: the request is
      // aborted and its result is ignored once the pane is left.
      issueGeneration.current += 1;
      issueAbort.current?.abort();
      issueAbort.current = null;
      issuingRef.current = false;
    };
  }, []);

  // A native navigation or a frozen back/forward cache must not keep the
  // secret or a half-finished issuance alive, so both are dropped at once.
  useEffect(() => {
    function handlePageHide(): void {
      cancelIssuance();
      // React must commit the removal before a browser freezes this document.
      // A cancelled request cannot reset its own pending state later.
      flushSync(() => {
        setRevealed(null);
        setCreateOpen(false);
        setSubmitting(false);
        setIssueError(null);
      });
    }
    window.addEventListener('pagehide', handlePageHide);
    return () => window.removeEventListener('pagehide', handlePageHide);
  }, [cancelIssuance]);

  async function handleCreate(values: TokenCreateValues): Promise<void> {
    // One issuance at a time: a second submit is refused before the first
    // request has even answered.
    if (issuingRef.current) return;
    issuingRef.current = true;
    const generation = ++issueGeneration.current;
    const controller = new AbortController();
    issueAbort.current = controller;
    setSubmitting(true);
    setIssueError(null);
    try {
      const response = await issueToken(
        {
          name: values.name,
          password: values.password,
          scopes: values.scopes,
          expiresInDays: values.expiresInDays,
        },
        controller.signal,
      );
      if (generation !== issueGeneration.current || !mountedRef.current) return;
      setCreateOpen(false);
      setRevealed({ rawToken: response.rawToken, token: response.token });
      await refetch({ silent: true });
    } catch (err) {
      if (generation !== issueGeneration.current || !mountedRef.current) return;
      if (isAbortError(err)) return;
      setIssueError(tokenErrorMessage(err, 'issue'));
    } finally {
      if (generation === issueGeneration.current) {
        issuingRef.current = false;
        setSubmitting(false);
        issueAbort.current = null;
      }
    }
  }

  function handleCloseCreate(): void {
    cancelIssuance();
    setSubmitting(false);
    setIssueError(null);
    setCreateOpen(false);
  }

  function handleRequestRevoke(token: TokenMetadata): void {
    // The control that asked for the revocation is remembered so the focus
    // can go back to it when the confirmation closes.
    const active = document.activeElement;
    revokeTriggerRef.current = active instanceof HTMLElement ? active : null;
    setRevokeError(null);
    setConfirm({ kind: 'one', token });
  }

  async function handleConfirmRevoke(): Promise<void> {
    if (!confirm || revokingRef.current) return;
    revokingRef.current = true;
    setRevoking(true);
    setRevokeError(null);
    try {
      if (confirm.kind === 'one') {
        await revoke(confirm.token.id);
      } else {
        await revokeAll();
      }
      if (!mountedRef.current) return;
      setConfirm(null);
      pushToast({
        tone: 'success',
        title: confirm.kind === 'one' ? 'Token revoked.' : 'All tokens revoked.',
      });
    } catch (err) {
      if (!mountedRef.current) return;
      setRevokeError(tokenErrorMessage(err));
    } finally {
      revokingRef.current = false;
      if (mountedRef.current) setRevoking(false);
    }
  }

  const activeCount = tokens.filter((token) => token.status === 'active').length;

  return (
    <div className="min-h-full bg-surface p-4 text-ink sm:p-6 lg:p-8 dark:bg-surface-dark dark:text-ink-dark">
      <div className="mx-auto max-w-4xl">
        <header className="mb-8 border-b border-border pb-6 dark:border-border-dark">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <Link
                to="/calendar"
                data-testid="back-to-calendar-link"
                className="inline-flex min-h-11 items-center text-sm text-ink-muted underline decoration-dotted underline-offset-4 transition-colors duration-150 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:text-ink-muted-dark dark:hover:text-ink-dark dark:focus-visible:ring-offset-surface-dark"
              >
                Back to calendar
              </Link>
              <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight sm:text-3xl">
                Personal access tokens
              </h1>
              <p className="mt-2 max-w-2xl text-sm text-ink-muted dark:text-ink-muted-dark">
                A personal access token is a separate credential, not your session: this page is
                reached with your signed-in session, and a tool uses the token instead. You manage
                only your own tokens here, and every secret is shown once.{' '}
                <a
                  href="#cli-setup"
                  className="underline decoration-dotted underline-offset-4 transition-colors duration-150 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:hover:text-ink-dark dark:focus-visible:ring-offset-surface-dark"
                >
                  CLI and local MCP setup
                </a>
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm text-ink-muted dark:text-ink-muted-dark">
              <ThemeToggle />
              <span>
                {user.name}{' '}
                <span className="text-ink-muted/70 dark:text-ink-muted-dark/70">({user.role})</span>
              </span>
              <button
                type="button"
                onClick={() => void logout()}
                className="min-h-11 rounded border border-border px-3 py-2 transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:border-border-dark dark:text-ink-dark dark:hover:bg-surface-dark-2 dark:focus-visible:ring-offset-surface-dark"
              >
                Sign out
              </button>
            </div>
          </div>
        </header>

        <section aria-labelledby="issue-token-heading" className="mb-8">
          <h2
            id="issue-token-heading"
            className="font-display text-lg font-semibold tracking-tight"
          >
            Issue a token
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted dark:text-ink-muted-dark">
            Start read-only, or use the “Manage my PTO” preset to let a client work with your own
            calendar. Issuing one checks your current password, and the token expires on its own.
            Personal access tokens are still being rolled out: a deployment that has them switched
            off refuses the request and creates nothing.
          </p>
          <button
            type="button"
            ref={generateTriggerRef}
            onClick={() => setCreateOpen(true)}
            data-testid="generate-token-button"
            className="mt-3 min-h-11 rounded bg-accent px-4 py-2 text-sm font-medium text-ink-inverse transition-colors duration-150 hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:focus-visible:ring-offset-surface-dark"
          >
            Generate token
          </button>
        </section>

        <section aria-labelledby="your-tokens-heading" className="mb-8">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2
              id="your-tokens-heading"
              className="font-display text-lg font-semibold tracking-tight"
            >
              Your tokens
            </h2>
            <p className="text-xs text-ink-muted dark:text-ink-muted-dark">
              {tokens.length === 0
                ? 'No tokens yet'
                : `${tokens.length} token${tokens.length === 1 ? '' : 's'} · ${activeCount} active`}
            </p>
          </div>

          {loading ? (
            <p
              role="status"
              aria-busy="true"
              data-testid="tokens-loading"
              className="mt-3 text-sm text-ink-muted dark:text-ink-muted-dark"
            >
              Loading your tokens…
            </p>
          ) : error ? (
            <div role="alert" className="mt-3 rounded border border-border p-4">
              <p className="text-sm text-danger">{error}</p>
              <button
                type="button"
                onClick={() => void refetch()}
                className="mt-3 min-h-11 rounded border border-border px-3 py-2 text-sm text-ink transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:border-border-dark dark:text-ink-dark dark:hover:bg-surface-dark-2 dark:focus-visible:ring-offset-surface-dark"
              >
                Retry
              </button>
            </div>
          ) : tokens.length === 0 ? (
            <p
              data-testid="tokens-empty"
              className="mt-3 rounded border border-dashed border-border p-6 text-sm text-ink-muted dark:border-border-dark dark:text-ink-muted-dark"
            >
              You have no personal access tokens yet. Generate one to let a local script or an AI
              assistant work with your calendar.
            </p>
          ) : (
            <ul className="mt-3 grid gap-3">
              {tokens.map((token) => (
                <TokenCard key={token.id} token={token} onRevoke={handleRequestRevoke} />
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="revoke-all-heading" className="mb-8">
          <h2 id="revoke-all-heading" className="font-display text-lg font-semibold tracking-tight">
            Revoke every token
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted dark:text-ink-muted-dark">
            Emergency revocation needs only a valid session — no password. It takes effect
            immediately for every client. Signing out is a separate thing: it ends this browser
            session and does not revoke tokens.
          </p>
          <button
            type="button"
            ref={revokeAllTriggerRef}
            onClick={() => {
              setRevokeError(null);
              setConfirm({ kind: 'all' });
            }}
            data-testid="revoke-all-button"
            className="mt-3 min-h-11 rounded border border-border px-4 py-2 text-sm text-ink transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:border-border-dark dark:text-ink-dark dark:hover:bg-surface-dark-2 dark:focus-visible:ring-offset-surface-dark"
          >
            Revoke all tokens
          </button>
        </section>

        <section
          id="cli-setup"
          aria-labelledby="cli-setup-heading"
          className="mb-10 border-t border-border pt-6 dark:border-border-dark"
        >
          <h2 id="cli-setup-heading" className="font-display text-lg font-semibold tracking-tight">
            CLI and local MCP setup
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted dark:text-ink-muted-dark">
            <span className="font-medium text-ink dark:text-ink-dark">Not available yet.</span> The
            command-line client and the local MCP server are not distributed yet, and the rollout
            that would turn personal access tokens on is still off. When they ship, this section is
            replaced by the exact commands, the place to put the token, and how to rotate it — until
            then, there is nothing to install and nothing to paste.
          </p>
          <p className="mt-3 max-w-2xl text-sm text-ink-muted dark:text-ink-muted-dark">
            <span className="font-medium text-ink dark:text-ink-dark">About AI providers.</span> An
            assistant that reads your calendar can see whatever the tool sends it, including note
            text, and that text reaches whichever provider you configured. Never paste a token into
            a chat, a prompt or a shared document, and prefer a token with the narrowest scope that
            still works.
          </p>
        </section>
      </div>

      {createOpen ? (
        <TokenCreateDialog
          role={user.role}
          submitting={submitting}
          error={issueError}
          returnFocusRef={generateTriggerRef}
          onSubmit={(values) => void handleCreate(values)}
          onClose={handleCloseCreate}
        />
      ) : null}

      {revealed ? (
        <TokenRevealDialog
          token={revealed.token}
          rawToken={revealed.rawToken}
          returnFocusRef={generateTriggerRef}
          onClose={() => setRevealed(null)}
        />
      ) : null}

      {confirm ? (
        <TokenConfirmDialog
          title={confirm.kind === 'all' ? 'Revoke all tokens' : 'Revoke token'}
          description={
            confirm.kind === 'all'
              ? `Revoke all ${tokens.length} of your tokens? Every client stops working immediately, and the secrets cannot be recovered.`
              : `Revoke “${confirm.token.name}”? Any client using it stops working immediately, and the secret cannot be recovered.`
          }
          busy={revoking}
          error={revokeError}
          returnFocusRef={confirm.kind === 'all' ? revokeAllTriggerRef : revokeTriggerRef}
          onConfirm={() => void handleConfirmRevoke()}
          onCancel={() => {
            setConfirm(null);
            setRevokeError(null);
          }}
        />
      ) : null}
    </div>
  );
}
