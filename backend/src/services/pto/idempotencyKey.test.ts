import { describe, expect, it } from 'vitest';
import { HttpError } from '../../middleware/errorHandler.js';
import { IDEMPOTENCY_TTL_MS, parseIdempotencyKey } from './idempotencyKey.js';

const NONCE = '9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

function canonicalKey(issuedAtMs: number, nonce = NONCE): string {
  return `v1.${String(issuedAtMs).padStart(13, '0')}.${nonce}`;
}

function expectHttpError(run: () => unknown, status: number, code: string): void {
  try {
    run();
    throw new Error('expected the parse to fail');
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(status);
    expect((err as HttpError).code).toBe(code);
  }
}

describe('parseIdempotencyKey', () => {
  it('returns null for an absent header when the caller does not require one', () => {
    expect(parseIdempotencyKey(undefined, false)).toBeNull();
  });

  it('requires a key for the credential kinds that must always send one', () => {
    expectHttpError(() => parseIdempotencyKey(undefined, true), 400, 'IDEMPOTENCY_KEY_REQUIRED');
  });

  it('parses the canonical form and fixes the expiry 24 hours after the issued time', () => {
    const issuedAtMs = 1_700_000_000_000;
    const parsed = parseIdempotencyKey([canonicalKey(issuedAtMs)], false);
    expect(parsed).not.toBeNull();
    expect(parsed?.value).toBe(canonicalKey(issuedAtMs));
    expect(parsed?.issuedAtMs).toBe(issuedAtMs);
    expect(parsed?.expiresAt.getTime()).toBe(issuedAtMs + IDEMPOTENCY_TTL_MS);
  });

  it('refuses a repeated header, even when both occurrences carry the same text', () => {
    const key = canonicalKey(1_700_000_000_000);
    expectHttpError(() => parseIdempotencyKey([key, key], false), 400, 'VALIDATION_ERROR');
  });

  it('refuses every spelling that is not the canonical form', () => {
    const issuedAtMs = 1_700_000_000_000;
    const malformed = [
      '',
      'not-a-key',
      'v2.1700000000000.' + NONCE,
      'v1.170000000000.' + NONCE,
      'v1.17000000000000.' + NONCE,
      'v1.1700000000000.' + NONCE.toUpperCase(),
      'v1.1700000000000.9f1c2d3e-4a5b-1c6d-8e9f-0a1b2c3d4e5f',
      'v1.1700000000000.' + NONCE + '.extra',
      'v1.1700000000000.' + NONCE + ' ',
      ' v1.1700000000000.' + NONCE,
      'v1.1700000000000.' + NONCE + '\t',
    ];
    for (const value of malformed) {
      expectHttpError(() => parseIdempotencyKey([value], false), 400, 'VALIDATION_ERROR');
    }
    expect(issuedAtMs).toBeGreaterThan(0);
  });

  it('never quotes the submitted key back to the caller', () => {
    const secretish = 'v1.1700000000000.SECRETSECRETSECRET-SECRET-4bee-8eef-deadbeefdead';
    try {
      parseIdempotencyKey([secretish], false);
      throw new Error('expected the parse to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).message).not.toContain('SECRET');
      expect((err as HttpError).message).not.toContain(secretish);
    }
  });

  it('parses the timestamp without substituting the app clock for database admission', () => {
    const issuedAtMs = 3_700_000_000_000;
    const parsed = parseIdempotencyKey([canonicalKey(issuedAtMs)], false);
    expect(parsed?.issuedAtMs).toBe(issuedAtMs);
  });
});
