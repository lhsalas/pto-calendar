import { describe, expect, it } from 'vitest';
import { HttpError } from '../../middleware/errorHandler.js';
import {
  MAX_PTO_VERSION,
  malformedPrecondition,
  parseExpectedVersion,
  preconditionRequired,
  staleWrite,
} from './preconditions.js';

function expectHttpError(run: () => unknown, status: number, code: string): HttpError {
  let caught: unknown;
  try {
    run();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(HttpError);
  const error = caught as HttpError;
  expect(error.status).toBe(status);
  expect(error.code).toBe(code);
  return error;
}

describe('the expected version precondition', () => {
  it('reads one quoted canonical version', () => {
    expect(parseExpectedVersion('"1"')).toBe(1);
    expect(parseExpectedVersion('"42"')).toBe(42);
    expect(parseExpectedVersion(`"${MAX_PTO_VERSION}"`)).toBe(MAX_PTO_VERSION);
  });

  it('refuses a missing precondition with the reload instruction', () => {
    const error = expectHttpError(
      () => parseExpectedVersion(undefined),
      428,
      'PRECONDITION_REQUIRED',
    );
    expect(error.message).toMatch(/reload/i);
    expect(error.message).not.toMatch(/\d/);
  });

  it.each([
    ['an empty value', ''],
    ['a wildcard', '*'],
    ['a weak validator', 'W/"1"'],
    ['an unquoted number', '1'],
    ['a list of values', '"1", "2"'],
    ['a duplicate header', '"1", "1"'],
    ['a leading zero', '"01"'],
    ['a zero version', '"0"'],
    ['a negative version', '"-1"'],
    ['a fraction', '"1.5"'],
    ['an exponent', '"1e2"'],
    ['text', 'not-a-version'],
    ['a version above the stored range', `"${MAX_PTO_VERSION + 1}"`],
    ['a value with surrounding whitespace', ' "1" '],
    ['an unterminated value', '"1'],
  ])('refuses %s without echoing it', (label, header) => {
    const error = expectHttpError(() => parseExpectedVersion(header), 400, 'VALIDATION_ERROR');
    if (header.length > 0) expect(error.message).not.toContain(header);
    expect(error.message).not.toContain('1');
  });
  it('refuses more than one header value', () => {
    const error = expectHttpError(
      () => parseExpectedVersion(['"1"', '"2"']),
      400,
      'VALIDATION_ERROR',
    );
    expect(error.message).not.toContain('"2"');
  });

  it('reports the stale write without naming a version or a note', () => {
    const error = expectHttpError(() => staleWrite(), 412, 'STALE_WRITE');
    expect(error.message).toMatch(/reload/i);
    expect(error.message).not.toMatch(/\d/);
    expect(error.message).not.toMatch(/note/i);
  });

  it('reports a malformed precondition without repeating the value', () => {
    const error = expectHttpError(() => malformedPrecondition(), 400, 'VALIDATION_ERROR');
    expect(error.message).toMatch(/if-match/i);
    expect(error.message).not.toMatch(/\d/);
  });

  it('reports a missing precondition without naming a version', () => {
    const error = expectHttpError(() => preconditionRequired(), 428, 'PRECONDITION_REQUIRED');
    expect(error.message).not.toMatch(/\d/);
  });
});
