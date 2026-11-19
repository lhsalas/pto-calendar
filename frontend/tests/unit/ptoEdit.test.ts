import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api/client';
import {
  ifMatchHeader,
  isPreparedPto,
  preparePtoForEdit,
  toPtoWriteError,
} from '../../src/lib/ptoEdit';
import { STUB_OTHER_USER, STUB_PTO, STUB_PTO_DETAIL, STUB_USER } from '../mocks/handlers';

describe('PTO write preparation', () => {
  it('does not prepare a snapshot for an unrelated member', () => {
    expect(() => preparePtoForEdit(STUB_PTO, STUB_OTHER_USER, STUB_PTO_DETAIL)).toThrow(
      'You cannot edit this PTO.',
    );
  });

  it('requires a valid version even for an otherwise prepared note', () => {
    const { version: _, ...withoutVersion } = preparePtoForEdit(
      STUB_PTO,
      STUB_USER,
      STUB_PTO_DETAIL,
    );
    expect(isPreparedPto(withoutVersion, STUB_USER)).toBe(false);
    const invalid = { ...withoutVersion, version: 0 };
    expect(isPreparedPto(invalid, STUB_USER)).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN, 2_147_483_648])(
    'refuses invalid version %s before sending a write',
    (version) => {
      expect(() => ifMatchHeader(version)).toThrow('Could not check the PTO version.');
    },
  );

  it('quotes the accepted int32 bounds', () => {
    expect(ifMatchHeader(1)).toEqual({ 'If-Match': '"1"' });
    expect(ifMatchHeader(2_147_483_647)).toEqual({ 'If-Match': '"2147483647"' });
  });

  it('leaves business conflicts and other request errors unchanged', () => {
    const businessConflict = new ApiError(409, { code: 'CONFLICT', message: 'Dates overlap.' });
    const networkError = new Error('Could not connect.');
    expect(toPtoWriteError(businessConflict)).toBe(businessConflict);
    expect(toPtoWriteError(networkError)).toBe(networkError);
  });
});
