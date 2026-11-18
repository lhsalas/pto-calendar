import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api/client';
import {
  DEFAULT_TOKEN_EXPIRY_DAYS,
  DEFAULT_TOKEN_SCOPES,
  MANAGE_MY_PTO_SCOPES,
  MAX_TOKEN_NAME_CODE_POINTS,
  MAX_TOKEN_PASSWORD_LENGTH,
  NEAR_EXPIRY_DAYS,
  TOKEN_EXPIRY_OPTIONS,
  applyTokenScopePreset,
  canUseTeamScopes,
  daysUntilExpiry,
  formatAbsoluteDateTime,
  isAbortError,
  isNearExpiry,
  isTeamScope,
  normalizeTokenScopes,
  resolveTokenStatus,
  scopeOption,
  toggleTokenScope,
  tokenErrorMessage,
  tokenStatusLabel,
  validateTokenName,
  validateTokenPassword,
} from '../../src/lib/tokens';
import type { TokenMetadata } from '../../src/types/api';

const NOW = Date.parse('2026-06-15T12:00:00.000Z');

function makeToken(overrides: Partial<TokenMetadata> = {}): TokenMetadata {
  return {
    id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    name: 'Laptop',
    displayPrefix: 'pto_pat_cccccccc-cccc-cccc-cccc-cccccccccccc',
    scopes: ['pto:read'],
    createdAt: '2026-06-01T10:00:00.000Z',
    expiresAt: '2026-09-15T12:00:00.000Z',
    lastUsedAt: null,
    revokedAt: null,
    status: 'active',
    ...overrides,
  };
}

describe('token name validation', () => {
  it('rejects an empty name', () => {
    expect(validateTokenName('')).toMatch(/enter a name/i);
  });

  it('rejects a name that is only whitespace', () => {
    expect(validateTokenName('   \t ')).toMatch(/enter a name/i);
  });

  it('accepts a trimmed name', () => {
    expect(validateTokenName('  Laptop  ')).toBeNull();
  });

  it('accepts a name of exactly 120 code points', () => {
    expect(validateTokenName('a'.repeat(MAX_TOKEN_NAME_CODE_POINTS))).toBeNull();
  });

  it('rejects a name of 121 code points', () => {
    expect(validateTokenName('a'.repeat(MAX_TOKEN_NAME_CODE_POINTS + 1))).toMatch(
      /at most 120 characters/i,
    );
  });

  it('counts code points, not code units', () => {
    // 120 astral characters are 240 UTF-16 code units but 120 code points.
    expect(validateTokenName('😀'.repeat(120))).toBeNull();
    expect(validateTokenName('😀'.repeat(121))).toMatch(/at most 120 characters/i);
  });
});

describe('token password validation', () => {
  it('rejects an empty password', () => {
    expect(validateTokenPassword('')).toMatch(/current password/i);
  });

  it('accepts a password of 72 characters', () => {
    expect(validateTokenPassword('a'.repeat(MAX_TOKEN_PASSWORD_LENGTH))).toBeNull();
  });

  it('rejects a password of 73 characters', () => {
    expect(validateTokenPassword('a'.repeat(MAX_TOKEN_PASSWORD_LENGTH + 1))).toMatch(
      /cannot be longer than 72 characters/i,
    );
  });

  it('does not trim the password', () => {
    expect(validateTokenPassword('   ')).toBeNull();
  });
});

describe('scope rules', () => {
  it('drops the note scope when read is not granted', () => {
    expect(normalizeTokenScopes(['pto:notes:read'], 'admin')).toEqual([]);
    expect(normalizeTokenScopes(['pto:notes:read', 'pto:create'], 'admin')).toEqual(['pto:create']);
  });

  it('keeps the note scope when read is granted', () => {
    expect(normalizeTokenScopes(['pto:read', 'pto:notes:read'], 'admin')).toEqual([
      'pto:read',
      'pto:notes:read',
    ]);
  });

  it('drops team writes for a member', () => {
    expect(
      normalizeTokenScopes(['pto:read', 'pto:update:team', 'pto:delete:team'], 'member'),
    ).toEqual(['pto:read']);
  });

  it('keeps team writes for a lead and an administrator', () => {
    expect(normalizeTokenScopes(['pto:update:team'], 'team_lead')).toEqual(['pto:update:team']);
    expect(normalizeTokenScopes(['pto:delete:team'], 'admin')).toEqual(['pto:delete:team']);
  });

  it('returns the scopes in the canonical order', () => {
    expect(normalizeTokenScopes(['pto:delete:self', 'pto:read'], 'member')).toEqual([
      'pto:read',
      'pto:delete:self',
    ]);
  });

  it('resets the note scope when read is switched off', () => {
    expect(toggleTokenScope(['pto:read', 'pto:notes:read'], 'pto:read', 'admin')).toEqual([]);
  });

  it('grants the note scope only together with the read scope', () => {
    expect(toggleTokenScope(['pto:read'], 'pto:notes:read', 'admin')).toEqual([
      'pto:read',
      'pto:notes:read',
    ]);
  });

  it('grants a team scope only to a lead or an administrator', () => {
    expect(toggleTokenScope(['pto:read'], 'pto:update:team', 'member')).toEqual(['pto:read']);
    expect(toggleTokenScope(['pto:read'], 'pto:update:team', 'team_lead')).toEqual([
      'pto:read',
      'pto:update:team',
    ]);
  });

  it('removes a scope that is toggled twice', () => {
    expect(toggleTokenScope(['pto:read', 'pto:create'], 'pto:create', 'member')).toEqual([
      'pto:read',
    ]);
  });

  it('knows which scopes reach the team', () => {
    expect(isTeamScope('pto:update:team')).toBe(true);
    expect(isTeamScope('pto:delete:team')).toBe(true);
    expect(isTeamScope('pto:update:self')).toBe(false);
    expect(isTeamScope('pto:read')).toBe(false);
  });

  it('only offers team scopes to a lead or an administrator', () => {
    expect(canUseTeamScopes('member')).toBe(false);
    expect(canUseTeamScopes('team_lead')).toBe(true);
    expect(canUseTeamScopes('admin')).toBe(true);
  });

  it('applies the read-only preset', () => {
    expect(applyTokenScopePreset('read-only')).toEqual(['pto:read']);
    expect(DEFAULT_TOKEN_SCOPES).toEqual(['pto:read']);
  });

  it('applies the Manage my PTO preset without notes or team writes', () => {
    const preset = applyTokenScopePreset('manage-my-pto');
    expect(preset).toEqual(['pto:read', 'pto:create', 'pto:update:self', 'pto:delete:self']);
    expect(preset).not.toContain('pto:notes:read');
    expect(preset).not.toContain('pto:update:team');
    expect(preset).not.toContain('pto:delete:team');
    expect(MANAGE_MY_PTO_SCOPES).toEqual(preset);
  });

  it('describes every scope and ignores unknown ones', () => {
    expect(scopeOption('pto:read')?.label).toMatch(/view/i);
    expect(scopeOption('pto:notes:read')?.label).toMatch(/notes/i);
    expect(scopeOption('pto:create')?.label).toMatch(/create/i);
    expect(scopeOption('pto:update:self')?.label).toMatch(/update your own/i);
    expect(scopeOption('pto:delete:self')?.label).toMatch(/delete your own/i);
    expect(scopeOption('pto:update:team')?.label).toMatch(/teammates/i);
    expect(scopeOption('pto:delete:team')?.label).toMatch(/teammates/i);
    expect(scopeOption('pto:unknown' as never)).toBeUndefined();
  });
});

describe('token status', () => {
  it('uses the status the server computed', () => {
    expect(resolveTokenStatus(makeToken({ status: 'invalidated' }), NOW)).toBe('invalidated');
    expect(resolveTokenStatus(makeToken({ status: 'revoked' }), NOW)).toBe('revoked');
    expect(resolveTokenStatus(makeToken({ status: 'expired' }), NOW)).toBe('expired');
    expect(resolveTokenStatus(makeToken({ status: 'active' }), NOW)).toBe('active');
  });

  it('falls back to a revoked state when the server omits the status', () => {
    const token = makeToken({ status: undefined as never, revokedAt: '2026-06-10T10:00:00.000Z' });
    expect(resolveTokenStatus(token, NOW)).toBe('revoked');
  });

  it('falls back to an expired state when the server omits the status', () => {
    const token = makeToken({ status: undefined as never, expiresAt: '2026-06-01T10:00:00.000Z' });
    expect(resolveTokenStatus(token, NOW)).toBe('expired');
  });

  it('never infers an invalidated state in the browser', () => {
    const token = makeToken({ status: undefined as never });
    expect(resolveTokenStatus(token, NOW)).toBe('active');
    expect(resolveTokenStatus(token, NOW)).not.toBe('invalidated');
  });

  it('labels every status', () => {
    expect(tokenStatusLabel('active')).toBe('Active');
    expect(tokenStatusLabel('expired')).toBe('Expired');
    expect(tokenStatusLabel('revoked')).toBe('Revoked');
    expect(tokenStatusLabel('invalidated')).toBe('Invalidated');
  });
});

describe('expiry helpers', () => {
  it('counts the days left', () => {
    const token = makeToken({ expiresAt: '2026-06-20T12:00:00.000Z' });
    expect(daysUntilExpiry(token, NOW)).toBe(5);
  });

  it('returns null for an unreadable expiry', () => {
    expect(daysUntilExpiry(makeToken({ expiresAt: 'not-a-date' }), NOW)).toBeNull();
  });

  it('flags a live token that lapses within the near-expiry window', () => {
    const soon = new Date(NOW + (NEAR_EXPIRY_DAYS - 1) * 24 * 60 * 60 * 1000).toISOString();
    expect(isNearExpiry(makeToken({ expiresAt: soon }), NOW)).toBe(true);
  });

  it('does not flag a token that lapses later', () => {
    const later = new Date(NOW + (NEAR_EXPIRY_DAYS + 5) * 24 * 60 * 60 * 1000).toISOString();
    expect(isNearExpiry(makeToken({ expiresAt: later }), NOW)).toBe(false);
  });

  it('does not flag a revoked or expired token', () => {
    const soon = new Date(NOW + 24 * 60 * 60 * 1000).toISOString();
    expect(isNearExpiry(makeToken({ status: 'revoked', expiresAt: soon }), NOW)).toBe(false);
    expect(isNearExpiry(makeToken({ status: 'expired', expiresAt: soon }), NOW)).toBe(false);
  });

  it('does not flag a token with an unreadable expiry', () => {
    expect(isNearExpiry(makeToken({ expiresAt: 'not-a-date' }), NOW)).toBe(false);
  });

  it('offers 30, 90, 180 and 365 day lifetimes with 90 as the default', () => {
    expect(TOKEN_EXPIRY_OPTIONS).toEqual([30, 90, 180, 365]);
    expect(DEFAULT_TOKEN_EXPIRY_DAYS).toBe(90);
  });
});

describe('absolute timestamps', () => {
  it('shows the date, the time and the time zone', () => {
    const formatted = formatAbsoluteDateTime('2026-09-15T12:00:00.000Z');
    expect(formatted).toMatch(/2026/);
    expect(formatted).toMatch(/\(.+\)/);
  });

  it('reports an unreadable timestamp', () => {
    expect(formatAbsoluteDateTime('not-a-date')).toBe('Unknown');
  });
});

describe('safe error copy', () => {
  it('explains a rejected request without echoing the server message', () => {
    const message = tokenErrorMessage(
      new ApiError(400, { code: 'VALIDATION_ERROR', message: 'name must not contain secret' }),
    );
    expect(message).toMatch(/rejected these details/i);
    expect(message).not.toMatch(/secret/);
  });

  it('asks for the password again on a rejected issuance', () => {
    expect(
      tokenErrorMessage(new ApiError(401, { code: 'UNAUTHENTICATED', message: 'x' }), 'issue'),
    ).toMatch(/current password/i);
    expect(tokenErrorMessage(new ApiError(401, { code: 'UNAUTHENTICATED', message: 'x' }))).toMatch(
      /sign in again/i,
    );
  });

  it('explains a forbidden scope', () => {
    expect(tokenErrorMessage(new ApiError(403, { code: 'FORBIDDEN', message: 'x' }))).toMatch(
      /role does not allow/i,
    );
  });

  it('explains a missing token', () => {
    expect(tokenErrorMessage(new ApiError(404, { code: 'NOT_FOUND', message: 'x' }))).toMatch(
      /no longer available/i,
    );
  });

  it('explains the active token limit', () => {
    expect(tokenErrorMessage(new ApiError(409, { code: 'CONFLICT', message: 'x' }))).toMatch(
      /maximum number/i,
    );
  });

  it('explains an oversized request', () => {
    expect(
      tokenErrorMessage(new ApiError(413, { code: 'PAYLOAD_TOO_LARGE', message: 'x' })),
    ).toMatch(/too large/i);
  });

  it('explains an unsupported request', () => {
    expect(tokenErrorMessage(new ApiError(415, { code: 'UNSUPPORTED', message: 'x' }))).toMatch(
      /request format/i,
    );
  });

  it('explains a rate limit', () => {
    expect(tokenErrorMessage(new ApiError(429, { code: 'RATE_LIMITED', message: 'x' }))).toMatch(
      /too many attempts/i,
    );
  });

  it('asks the reader to refresh before issuing again after a timeout', () => {
    expect(tokenErrorMessage(new ApiError(0, { code: 'TIMEOUT', message: 'x' }))).toMatch(
      /refresh the list before creating another/i,
    );
  });

  it('reports a cancelled request', () => {
    expect(tokenErrorMessage(new ApiError(0, { code: 'ABORTED', message: 'x' }))).toMatch(
      /cancelled/i,
    );
  });

  it('reports an unreachable server', () => {
    expect(tokenErrorMessage(new ApiError(0, { code: 'NETWORK', message: 'x' }))).toMatch(
      /could not reach the server/i,
    );
  });

  it('falls back to generic copy', () => {
    expect(tokenErrorMessage(new ApiError(500, { code: 'INTERNAL', message: 'boom' }))).toMatch(
      /something went wrong/i,
    );
    expect(tokenErrorMessage(new Error('boom'))).toMatch(/something went wrong/i);
  });
});

describe('abort detection', () => {
  it('recognises an aborted api request', () => {
    expect(isAbortError(new ApiError(0, { code: 'ABORTED', message: 'x' }))).toBe(true);
  });

  it('recognises an aborted DOM exception', () => {
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true);
  });

  it('does not treat other failures as aborts', () => {
    expect(isAbortError(new ApiError(500, { code: 'INTERNAL', message: 'x' }))).toBe(false);
    expect(isAbortError(new Error('boom'))).toBe(false);
  });
});
