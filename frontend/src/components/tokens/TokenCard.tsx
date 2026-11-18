import type { JSX } from 'react';
import {
  daysUntilExpiry,
  formatAbsoluteDateTime,
  isNearExpiry,
  noteScopeHint,
  resolveTokenStatus,
  scopeOption,
  tokenStatusLabel,
} from '../../lib/tokens';
import type { Role, TokenMetadata, TokenStatus } from '../../types/api';

export interface TokenCardProps {
  token: TokenMetadata;
  /** The reader's role, which decides whose note text a token can read. */
  role: Role;
  onRevoke: (token: TokenMetadata) => void;
}

const STATUS_CLASS: Record<TokenStatus, string> = {
  active: 'bg-success/15 text-success',
  expired: 'bg-ink-muted/15 text-ink-muted',
  revoked: 'bg-danger/15 text-danger',
  invalidated: 'bg-accent-100 text-accent-900',
};

const STATUS_DARK_CLASS: Record<TokenStatus, string> = {
  active: 'bg-success/20 text-[#a8c98a]',
  expired: 'bg-ink-muted-dark/20 text-ink-muted-dark',
  revoked: 'bg-danger/25 text-[#e0917f]',
  invalidated: 'bg-accent-900/40 text-accent-100',
};

/**
 * One owned token, shown as metadata only. The secret is never part of this
 * view, and the status is the one the server computed.
 */
export function TokenCard({ token, role, onRevoke }: TokenCardProps): JSX.Element {
  const headingId = `token-name-${token.id}`;
  const status = resolveTokenStatus(token);
  const nearExpiry = isNearExpiry(token);
  const daysLeft = daysUntilExpiry(token);

  return (
    <li
      aria-labelledby={headingId}
      data-testid={`token-card-${token.id}`}
      className="rounded-lg border border-border bg-surface-3 p-4 dark:border-border-dark dark:bg-surface-dark-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3
          id={headingId}
          className="min-w-0 font-display text-lg font-semibold tracking-tight text-ink [overflow-wrap:anywhere] dark:text-ink-dark"
        >
          <span className="[overflow-wrap:anywhere]">{token.name}</span>{' '}
          <span
            className="font-mono text-xs font-normal break-all text-ink-muted dark:text-ink-muted-dark"
            data-testid="token-prefix"
          >
            {token.displayPrefix}
          </span>
        </h3>
        <span
          data-testid="token-status"
          className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${STATUS_CLASS[status]} ${STATUS_DARK_CLASS[status]}`}
        >
          {tokenStatusLabel(status)}
        </span>
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-ink-muted dark:text-ink-muted-dark">Created</dt>
          <dd className="font-mono text-xs tabular-nums text-ink dark:text-ink-dark">
            {formatAbsoluteDateTime(token.createdAt)}
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-ink-muted dark:text-ink-muted-dark">Expires</dt>
          <dd
            className="font-mono text-xs tabular-nums text-ink dark:text-ink-dark"
            data-testid="token-expiry"
          >
            {formatAbsoluteDateTime(token.expiresAt)}
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-ink-muted dark:text-ink-muted-dark">Last used</dt>
          <dd className="font-mono text-xs tabular-nums text-ink dark:text-ink-dark">
            {token.lastUsedAt ? formatAbsoluteDateTime(token.lastUsedAt) : 'Never'}
          </dd>
        </div>
        {token.revokedAt ? (
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-ink-muted dark:text-ink-muted-dark">Revoked</dt>
            <dd className="font-mono text-xs tabular-nums text-ink dark:text-ink-dark">
              {formatAbsoluteDateTime(token.revokedAt)}
            </dd>
          </div>
        ) : null}
      </dl>

      <div className="mt-3">
        <h4 className="text-xs font-semibold tracking-wide text-ink-muted uppercase dark:text-ink-muted-dark">
          Scopes
        </h4>
        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {token.scopes.length > 0 ? (
            token.scopes.map((scope) => (
              <li key={scope} className="min-w-0 text-xs text-ink dark:text-ink-dark">
                {scopeOption(scope)?.label ?? scope}{' '}
                <span className="font-mono text-ink-muted dark:text-ink-muted-dark">{scope}</span>
                {scope === 'pto:notes:read' ? (
                  <span className="mt-0.5 block text-ink-muted dark:text-ink-muted-dark">
                    {noteScopeHint(role)}
                  </span>
                ) : null}
              </li>
            ))
          ) : (
            <li className="text-xs text-ink-muted dark:text-ink-muted-dark">None</li>
          )}
        </ul>
      </div>

      {nearExpiry ? (
        <p
          role="status"
          data-testid="token-near-expiry"
          className="mt-3 text-sm text-accent-900 dark:text-accent-100"
        >
          Expires in {daysLeft ?? 1} day{daysLeft === 1 ? '' : 's'} — revoke it or create a
          replacement before it lapses.
        </p>
      ) : null}

      <div className="mt-4">
        <button
          type="button"
          onClick={() => onRevoke(token)}
          className="min-h-11 rounded border border-border px-3 py-2 text-sm text-ink transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:border-border-dark dark:text-ink-dark dark:hover:bg-surface-dark-2 dark:focus-visible:ring-offset-surface-dark"
        >
          Revoke {token.name}
        </button>
      </div>
    </li>
  );
}
