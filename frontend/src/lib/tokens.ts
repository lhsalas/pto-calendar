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
 * The "Manage my PTO" preset: everything a person can do to their own
 * calendar, and nothing else. It never grants note reads or team writes.
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
 */
export const TOKEN_SCOPE_OPTIONS: readonly TokenScopeOption[] = [
  {
    scope: 'pto:read',
    label: 'View your own PTO',
    description: 'Read the time off you booked. Nothing else.',
  },
  {
    scope: 'pto:notes:read',
    label: 'Read your own PTO notes',
    description: 'Include the note text attached to your own bookings.',
  },
  {
    scope: 'pto:create',
    label: 'Create your own PTO',
    description: 'Book new time off for yourself.',
  },
  {
    scope: 'pto:update:self',
    label: 'Update your own PTO',
    description: 'Change dates or day parts on your own bookings.',
  },
  {
    scope: 'pto:delete:self',
    label: 'Delete your own PTO',
    description: 'Remove your own bookings.',
  },
  {
    scope: 'pto:update:team',
    label: "Update teammates' PTO",
    description: "Change any colleague's bookings, not only your own.",
  },
  {
    scope: 'pto:delete:team',
    label: "Delete teammates' PTO",
    description: "Remove any colleague's booking, not only your own.",
  },
];

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
