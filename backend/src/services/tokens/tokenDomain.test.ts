import { describe, expect, it } from 'vitest';
import {
  createTokenMaterial,
  parseToken,
  tokenDigestMatches,
  tokenExpiry,
  TokenInputError,
  validateTokenName,
  validateTokenScopes,
} from './tokenDomain.js';

describe('personal token primitives', () => {
  it('creates a unique public prefix and a 32-byte secret, storing only its digest', () => {
    const first = createTokenMaterial();
    const second = createTokenMaterial();
    const parsed = parseToken(first.rawToken);
    expect(parsed?.publicId).toBe(first.publicId);
    expect(parsed?.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(first.displayPrefix).toBe(`pto_pat_${first.publicId}`);
    expect(first.displayPrefix).not.toContain(parsed!.secret);
    expect(first.secretDigest).not.toBe(parsed!.secret);
    expect(tokenDigestMatches(parsed!.secret, first.secretDigest)).toBe(true);
    expect(first.rawToken).not.toBe(second.rawToken);
    expect(tokenDigestMatches(parsed!.secret, second.secretDigest)).toBe(false);
  });

  it.each([
    '',
    'pto_pat_bad.bad',
    'PTO_PAT_00000000-0000-4000-8000-000000000000.' + 'a'.repeat(64),
    'pto_pat_00000000-0000-4000-8000-000000000000.' + 'A'.repeat(64),
    'pto_pat_00000000-0000-1000-8000-000000000000.' + 'a'.repeat(64),
    'pto_pat_00000000-0000-4000-8000-000000000000.' + 'a'.repeat(64) + '\n',
  ])('rejects noncanonical token strings', (raw) => {
    expect(parseToken(raw)).toBeNull();
  });

  it('refuses malformed digest inputs before comparing', () => {
    expect(tokenDigestMatches('bad', 'a'.repeat(64))).toBe(false);
    expect(tokenDigestMatches('a'.repeat(64), 'bad')).toBe(false);
  });

  it('defaults to read, sorts scopes canonically and requires explicit privileged scopes', () => {
    expect(validateTokenScopes(undefined, 'member')).toEqual(['pto:read']);
    expect(validateTokenScopes(['pto:delete:team', 'pto:read', 'pto:notes:read'], 'admin')).toEqual(
      ['pto:read', 'pto:notes:read', 'pto:delete:team'],
    );
    expect(validateTokenScopes(['pto:update:team'], 'team_lead')).toEqual(['pto:update:team']);
  });

  it.each([
    [null, 'member'],
    [[], 'member'],
    [['unknown'], 'member'],
    [[3], 'member'],
    [['pto:read', 'pto:read'], 'member'],
    [['pto:notes:read'], 'member'],
    [['pto:update:team'], 'member'],
    [['pto:delete:team'], 'member'],
  ] as const)('rejects invalid or unauthorized scopes', (scopes, role) => {
    expect(() => validateTokenScopes(scopes, role)).toThrow(TokenInputError);
  });

  it('accepts only bounded, nonempty names without surrounding whitespace', () => {
    expect(validateTokenName('Developer laptop')).toBe('Developer laptop');
    expect(validateTokenName('x'.repeat(120))).toHaveLength(120);
    for (const value of ['', ' a', 'a ', 'x'.repeat(121), null]) {
      expect(() => validateTokenName(value)).toThrow(TokenInputError);
    }
  });

  it('limits lifetime to positive whole days and defaults to 90', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(tokenExpiry(now).getTime() - now.getTime()).toBe(90 * 86400000);
    expect(tokenExpiry(now, 365).getTime() - now.getTime()).toBe(365 * 86400000);
    for (const days of [0, -1, 1.5, 366, '90', null]) {
      expect(() => tokenExpiry(now, days)).toThrow(TokenInputError);
    }
    expect(() => tokenExpiry(new Date(NaN), 1)).toThrow(TokenInputError);
    expect(() => tokenExpiry(new Date(8640000000000000), 1)).toThrow(TokenInputError);
  });
});
