import { ApiError } from '../api/client';
import type { Role, TokenMetadata, TokenScope, TokenStatus } from '../types/api';

/** Every scope the server accepts, in the server's canonical order. */
export const TOKEN_SCOPE_VALUES: readonly TokenScope[] = [
  'pto:read',
  'pto:notes:read',
  'pto:create',
  'pto:update:self',
  'pto:delete:self',
  'pto:update:team',
  'pto:delete:team',
];

/** Read-only is the default grant. */
export const DEFAULT_TOKEN_SCOPES: readonly TokenScope[] = ['pto:read'];

/**
 * The "Manage my PTO" preset: shared calendar reads and personal writes.
 * It never grants note reads or team writes.
 */
export const MANAGE_MY_PTO_SCOPES: readonly TokenScope[] = [
  'pto:read',
  'pto:create',
  'pto:update:self',
  'pto:delete:self',
];

/** Offered lifetimes, in days. */
export const TOKEN_EXPIRY_OPTIONS: readonly number[] = [30, 90, 180, 365];

/** Default lifetime. */
export const DEFAULT_TOKEN_EXPIRY_DAYS = 90;

/** The server rejects names longer than this many Unicode code points. */
export const MAX_TOKEN_NAME_CODE_POINTS = 120;

/** The server rejects passwords longer than this many characters. */
export const MAX_TOKEN_PASSWORD_LENGTH = 72;

/** A live token inside this window is surfaced as expiring soon. */
export const NEAR_EXPIRY_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TokenScopeOption {
  scope: TokenScope;
  label: string;
  description: string;
}

/**
 * Presentation metadata for the scope controls. The scope id is always shown
 * next to the human label so the grant is unambiguous.
 *
 * The wording matches what the server actually grants: `pto:read` opens the
 * shared calendar, not one person's bookings, and `pto:notes:read` adds the
 * note text of the records the reader is allowed to manage.
 */
export const TOKEN_SCOPE_OPTIONS: readonly TokenScopeOption[] = [
  {
    scope: 'pto:read',
    label: 'Read the team calendar',
    description:
      'See when the whole team is off: dates, day parts and names. Note text stays hidden.',
  },
  {
    scope: 'pto:notes:read',
    label: 'Read note text',
    description: 'Include the note attached to time off. Needs the read scope.',
  },
  {
    scope: 'pto:create',
    label: 'Create your own time off',
    description: 'Book new time off for yourself.',
  },
  {
    scope: 'pto:update:self',
    label: 'Update your own time off',
    description: 'Change the dates or the day part of your own bookings.',
  },
  {
    scope: 'pto:delete:self',
    label: 'Delete your own time off',
    description: 'Remove your own bookings.',
  },
  {
    scope: 'pto:update:team',
    label: "Update teammates' time off",
    description:
      "Change any colleague's booking, not only your own. Needs a current team lead or administrator role.",
  },
  {
    scope: 'pto:delete:team',
    label: "Delete teammates' time off",
    description:
      "Remove any colleague's booking, not only your own. Needs a current team lead or administrator role.",
  },
];

/**
 * Who can see note text once `pto:notes:read` is granted.
 *
 * The server decides that per record: a member only ever sees the notes of
 * their own bookings, while a team lead or an administrator also sees the
 * notes of the bookings they are allowed to manage.
 */
export function noteScopeHint(role: Role): string {
  return canUseTeamScopes(role)
    ? 'With this scope you also read the notes of teammates, because your role can manage their time off.'
    : 'With this scope you read your own notes only. The notes of teammates stay hidden for your role.';
}

/**
 * The read scope covers the shared calendar, so it is part of every preset
 * that manages personal time off.
 */
export const READ_SCOPE_HINT =
  'Reading always covers the shared team calendar: who is off and when, without note text.';

export function isTeamScope(scope: TokenScope): boolean {
  return scope === 'pto:update:team' || scope === 'pto:delete:team';
}

export function canUseTeamScopes(role: Role): boolean {
  return role === 'team_lead' || role === 'admin';
}

export function scopeOption(scope: TokenScope): TokenScopeOption | undefined {
  return TOKEN_SCOPE_OPTIONS.find((option) => option.scope === scope);
}

/**
 * Applies the server's scope rules to a selection: notes require read, and
 * team writes are dropped for anyone who is not a live lead or administrator.
 */
export function normalizeTokenScopes(scopes: readonly TokenScope[], role: Role): TokenScope[] {
  const selected = new Set<TokenScope>(scopes);
  if (!selected.has('pto:read')) selected.delete('pto:notes:read');
  if (!canUseTeamScopes(role)) {
    selected.delete('pto:update:team');
    selected.delete('pto:delete:team');
  }
  return TOKEN_SCOPE_VALUES.filter((scope) => selected.has(scope));
}

/** Flips one scope and re-applies the dependency rules. */
export function toggleTokenScope(
  scopes: readonly TokenScope[],
  scope: TokenScope,
  role: Role,
): TokenScope[] {
  const selected = new Set<TokenScope>(scopes);
  if (selected.has(scope)) {
    selected.delete(scope);
  } else {
    selected.add(scope);
  }
  return normalizeTokenScopes([...selected], role);
}

export type TokenScopePreset = 'read-only' | 'manage-my-pto';

/** The preset never grants note reads or team writes. */
export function applyTokenScopePreset(preset: TokenScopePreset): TokenScope[] {
  return preset === 'manage-my-pto' ? [...MANAGE_MY_PTO_SCOPES] : [...DEFAULT_TOKEN_SCOPES];
}

/**
 * Validates a token name the way the server does: trimmed, non-empty and at
 * most 120 Unicode code points. The submitted value is never echoed back.
 */
export function validateTokenName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'Enter a name for this token.';
  if ([...trimmed].length > MAX_TOKEN_NAME_CODE_POINTS) {
    return `Use at most ${MAX_TOKEN_NAME_CODE_POINTS} characters for the token name.`;
  }
  return null;
}

/**
 * Validates the current password the way the server does: 1 to 72 characters,
 * untrimmed, so a leading or trailing space is part of the secret.
 */
export function validateTokenPassword(password: string): string | null {
  if (password.length === 0) return 'Enter your current password.';
  if (password.length > MAX_TOKEN_PASSWORD_LENGTH) {
    return `Your current password cannot be longer than ${MAX_TOKEN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

/**
 * Uses the status the server computed. The browser never infers invalidation;
 * the fallback only covers an older server that omits the field, and it can
 * never report `invalidated`.
 */
export function resolveTokenStatus(token: TokenMetadata, now: number = Date.now()): TokenStatus {
  const status = token.status;
  if (
    status === 'active' ||
    status === 'expired' ||
    status === 'revoked' ||
    status === 'invalidated'
  ) {
    return status;
  }
  if (token.revokedAt) return 'revoked';
  const expiry = Date.parse(token.expiresAt);
  if (Number.isFinite(expiry) && expiry <= now) return 'expired';
  return 'active';
}

export function tokenStatusLabel(status: TokenStatus): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'expired':
      return 'Expired';
    case 'revoked':
      return 'Revoked';
    case 'invalidated':
      return 'Invalidated';
  }
}

/** Whole days left before expiry; negative once the token has expired. */
export function daysUntilExpiry(token: TokenMetadata, now: number = Date.now()): number | null {
  const expiry = Date.parse(token.expiresAt);
  if (!Number.isFinite(expiry)) return null;
  return Math.ceil((expiry - now) / DAY_MS);
}

/** A live token that lapses within the near-expiry window. */
export function isNearExpiry(token: TokenMetadata, now: number = Date.now()): boolean {
  if (resolveTokenStatus(token, now) !== 'active') return false;
  const expiry = Date.parse(token.expiresAt);
  if (!Number.isFinite(expiry)) return false;
  const remaining = expiry - now;
  return remaining > 0 && remaining <= NEAR_EXPIRY_DAYS * DAY_MS;
}

/**
 * Formats an absolute server timestamp with the reader's time zone, so the
 * expiry shown in the UI is unambiguous.
 */
export function formatAbsoluteDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  const formatted = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${formatted} (${zone})`;
}

/**
 * Maps a failed credential request onto static copy. The server's message and
 * the submitted values are never shown, and no secret is echoed.
 */
export function tokenErrorMessage(err: unknown, kind: 'request' | 'issue' = 'request'): string {
  if (err instanceof ApiError) {
    if (err.body.code === 'TIMEOUT') {
      return 'The server did not confirm in time. The token may not have been created — refresh the list before creating another.';
    }
    if (err.body.code === 'ABORTED') {
      return 'The request was cancelled.';
    }
    if (err.body.code === 'NETWORK') {
      return 'Could not reach the server. Check your connection and try again.';
    }
    if (err.status === 400) {
      return 'The server rejected these details. Check the name, scopes and expiry, then try again.';
    }
    if (err.status === 401) {
      return kind === 'issue'
        ? 'Your current password or session was not accepted. Check it and try again.'
        : 'Your session is no longer valid. Sign in again, then retry.';
    }
    if (err.status === 403) {
      return 'Your role does not allow those scopes. Remove the team scopes and try again.';
    }
    if (err.status === 404) {
      return 'That token is no longer available. Refresh the list and try again.';
    }
    if (err.status === 409) {
      return 'You already have the maximum number of active tokens. Revoke one, then try again.';
    }
    if (err.status === 413) {
      return 'The request was too large. Use a shorter token name and try again.';
    }
    if (err.status === 415) {
      return 'The server rejected the request format. Try again.';
    }
    if (err.status === 429) {
      return 'Too many attempts. Wait a moment, then try again.';
    }
  }
  return 'Something went wrong. Try again.';
}

/** True when a request was cancelled on purpose; such a result is not an error. */
export function isAbortError(err: unknown): boolean {
  if (err instanceof ApiError) return err.body.code === 'ABORTED';
  return err instanceof DOMException && err.name === 'AbortError';
}

/**
 * Shown when an issuance could not be confirmed. The request may still have
 * reached the server, so the copy never claims that nothing was created.
 */
export const UNKNOWN_ISSUE_MESSAGE =
  'We could not confirm whether your last token was created. The request may have reached the server, so a token may exist even though no secret was shown. Refresh the token list and check for it before trying again. A slow request can still finish later; if you are unsure, wait and refresh again. If a token was created but its secret was lost, revoke it.';

/** Shown while the issuance is blocked until the list has been refreshed. */
export const ISSUE_BLOCKED_MESSAGE =
  'Creating another token stays blocked until the token list has been refreshed. The previous attempt may have created one.';

export type TokenIssueFailureKind = 'rejected' | 'unknown';

export interface TokenIssueFailure {
  kind: TokenIssueFailureKind;
  message: string;
}

/**
 * Classifies a failed issuance.
 *
 * A refusal from the server (a validation, an authentication, a limit or a
 * rate limit) is definite: nothing was created and the user may try again
 * after fixing the request. Everything else - a timeout, an unreachable
 * server, a server error or an unreadable answer - leaves the outcome
 * unknown, because the server may have committed the token before the
 * answer was lost.
 */
export function classifyIssueFailure(err: unknown): TokenIssueFailure {
  if (err instanceof ApiError) {
    const code = err.body.code;
    if (code === 'TIMEOUT' || code === 'NETWORK' || code === 'ABORTED' || code === 'BAD_RESPONSE') {
      return { kind: 'unknown', message: UNKNOWN_ISSUE_MESSAGE };
    }
    if (err.status === 0 || err.status >= 500) {
      return { kind: 'unknown', message: UNKNOWN_ISSUE_MESSAGE };
    }
    return { kind: 'rejected', message: tokenErrorMessage(err, 'issue') };
  }
  return { kind: 'unknown', message: UNKNOWN_ISSUE_MESSAGE };
}
