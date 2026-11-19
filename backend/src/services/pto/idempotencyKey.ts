import { HttpError } from '../../middleware/errorHandler.js';

/**
 * The parsed form of one client-supplied create key.
 *
 * `value` is the exact header value the client sent. It is never logged,
 * echoed in an error, or persisted in the clear: the persistence layer stores
 * its SHA-256 digest instead. Time bounds are enforced by the database clock.
 */
export interface ParsedPtoKey {
  value: string;
  issuedAtMs: number;
  expiresAt: Date;
}

/**
 * The key states its own version, the millisecond it was issued and a client
 * nonce: `v1.<13-digit UTC Unix milliseconds>.<canonical lowercase UUIDv4>`.
 * There is no opaque fragment, no list and no alternative spelling.
 */
const KEY_PATTERN =
  /^v1\.(\d{13})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

/** The replay window is exactly 24 hours from the issued time in the key. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** A key may not claim to be issued more than two minutes in the future. */
export const IDEMPOTENCY_MAX_FUTURE_MS = 120 * 1000;

/** A fixed message: the submitted key is never quoted back to the caller. */
function malformed(): never {
  throw new HttpError(400, 'VALIDATION_ERROR', 'The Idempotency-Key header is malformed.');
}

/**
 * Parses the raw occurrences of the `Idempotency-Key` header.
 *
 * `raw` is the list of header occurrences, not the joined value: a repeated
 * header is refused even when both occurrences carry the same text. `required`
 * is true for the credential kinds that must always send one.
 */
export function parseIdempotencyKey(
  raw: string[] | undefined,
  required: boolean,
): ParsedPtoKey | null {
  if (raw === undefined) {
    if (required) {
      throw new HttpError(
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
        'This request requires an Idempotency-Key header.',
      );
    }
    return null;
  }
  if (raw.length !== 1) malformed();
  const value = raw[0]!;
  const match = KEY_PATTERN.exec(value);
  if (!match) malformed();
  const issuedAtMs = Number(match[1]!);
  return { value, issuedAtMs, expiresAt: new Date(issuedAtMs + IDEMPOTENCY_TTL_MS) };
}
