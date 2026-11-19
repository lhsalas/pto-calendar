import { HttpError } from '../../middleware/errorHandler.js';

/**
 * The expected revision travels in `If-Match` as one quoted integer. Only a
 * single canonical value is accepted: a wildcard, a weak validator, an
 * unquoted number, a list, a duplicate header and every other malformed value
 * are refused instead of being coerced into a guess.
 */
const QUOTED_VERSION = /^"([1-9][0-9]*)"$/;

/** The stored version is a positive 32-bit integer. */
export const MAX_PTO_VERSION = 2147483647;

/**
 * The write did not name the version it changes. The client has to read the
 * entry again; the message never names a version.
 */
export function preconditionRequired(): never {
  throw new HttpError(
    428,
    'PRECONDITION_REQUIRED',
    'This write needs the version of the PTO entry it changes. Reload the entry and try again.',
  );
}

/**
 * The header was present but unusable. The received value is never echoed, so
 * a caller cannot learn anything about the stored version from the answer.
 */
export function malformedPrecondition(): never {
  throw new HttpError(
    400,
    'VALIDATION_ERROR',
    'The If-Match header must hold the expected version as one quoted integer.',
  );
}

/**
 * The entry changed after the caller read it, or another writer won the
 * race. The message asks for a reload and never names a version or a note.
 */
export function staleWrite(): never {
  throw new HttpError(
    412,
    'STALE_WRITE',
    'This PTO entry changed since it was loaded. Reload the entry and apply the change again.',
  );
}

/**
 * Reads the expected version from the request header. A missing header is a
 * missing precondition; a present but unusable header is a validation error.
 */
export function parseExpectedVersion(header: string | string[] | undefined): number {
  if (header === undefined) preconditionRequired();
  const values = Array.isArray(header) ? header : [header];
  if (values.length !== 1) malformedPrecondition();
  const match = QUOTED_VERSION.exec(values[0]!);
  if (!match) malformedPrecondition();
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version) || version > MAX_PTO_VERSION) malformedPrecondition();
  return version;
}
