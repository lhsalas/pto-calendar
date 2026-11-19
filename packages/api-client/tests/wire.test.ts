import { describe, expect, it } from 'vitest';
import {
  isDayPart,
  isOrderedRange,
  isPlainObject,
  isValidRange,
  parseCreateKey,
  requireCursor,
  requireDate,
  requireIfMatch,
  requireLimit,
  requireNote,
  requireUuid,
  requireVersion,
  validateCreatePayload,
  validateListQuery,
  validatePatchChanges,
  isIsoDate,
  isIsoDateTime,
  isUuid,
  isV1CreateKey,
  isVersion,
  parseDetail,
  parseIdentity,
  parsePage,
  parsePageItem,
  parseRecord,
  PtoWireError,
} from '../src/wire.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const OTHER_UUID = '22222222-2222-4222-8222-222222222222';

const IDENTITY = {
  id: UUID,
  role: 'member',
  auth: {
    method: 'pat',
    tokenId: OTHER_UUID,
    scopes: ['pto:read', 'pto:create'],
    expiresAt: '2027-01-01T00:00:00.000Z',
  },
};

const RECORD = {
  id: UUID,
  userId: OTHER_UUID,
  startDate: '2026-05-10',
  endDate: '2026-05-10',
  dayPart: 'morning',
  note: 'Doctor appointment',
  createdAt: '2026-05-03T12:00:00.000Z',
  updatedAt: '2026-05-03T12:30:00.000Z',
  version: 1,
};

const DETAIL = {
  id: UUID,
  user: { id: OTHER_UUID, name: 'Owner', colorCode: '#123456' },
  startDate: '2026-05-10',
  endDate: '2026-05-10',
  dayPart: 'morning',
  note: 'Doctor appointment',
  version: 3,
};

const PAGE_ITEM = {
  id: UUID,
  user: { id: OTHER_UUID, name: 'Owner', colorCode: '#123456' },
  startDate: '2026-05-10',
  endDate: '2026-05-10',
  dayPart: 'morning',
  note: null,
  version: 4,
};

describe('the wire validators', () => {
  it('recognises only a plain object', () => {
    expect(isPlainObject({ id: 'x' })).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject('text')).toBe(false);
    expect(isPlainObject(7)).toBe(false);
  });

  it('accepts only a canonical UUID', () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid(UUID.toUpperCase())).toBe(true);
    expect(isUuid('11111111-1111-4111-8111-11111111111')).toBe(false);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });

  it('accepts only a real calendar date', () => {
    expect(isIsoDate('2026-05-10')).toBe(true);
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-5-10')).toBe(false);
    expect(isIsoDate('2026-05-10T00:00:00Z')).toBe(false);
    expect(isIsoDate(null)).toBe(false);
  });

  it('accepts only an absolute timestamp', () => {
    expect(isIsoDateTime('2026-05-03T12:00:00.000Z')).toBe(true);
    expect(isIsoDateTime('2026-05-03T12:00:00Z')).toBe(true);
    expect(isIsoDateTime('2026-05-03T12:00:00+02:00')).toBe(true);
    expect(isIsoDateTime('2026-05-03T12:00:00')).toBe(false);
    expect(isIsoDateTime('2026-05-03')).toBe(false);
    expect(isIsoDateTime('2026-05-03T24:00:00Z')).toBe(false);
    expect(isIsoDateTime('2026-05-03T12:00:00+25:00')).toBe(false);
    expect(isIsoDateTime('2026-02-30T12:00:00Z')).toBe(false);
    expect(isIsoDateTime(12)).toBe(false);
  });

  it('accepts only a positive int32 version', () => {
    expect(isVersion(1)).toBe(true);
    expect(isVersion(2_147_483_647)).toBe(true);
    expect(isVersion(0)).toBe(false);
    expect(isVersion(-1)).toBe(false);
    expect(isVersion(2_147_483_648)).toBe(false);
    expect(isVersion(1.5)).toBe(false);
    expect(isVersion('1')).toBe(false);
  });

  it('accepts only the documented half-day values', () => {
    expect(isDayPart('morning')).toBe(true);
    expect(isDayPart('evening')).toBe(true);
    expect(isDayPart('all_day')).toBe(true);
    expect(isDayPart('full')).toBe(false);
    expect(isDayPart(null)).toBe(false);
  });

  it('accepts only the canonical create key', () => {
    expect(isV1CreateKey('v1.1700000000000.9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f')).toBe(true);
    expect(isV1CreateKey('v2.1700000000000.9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f')).toBe(false);
    expect(isV1CreateKey('v1.170000000000.9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f')).toBe(false);
    expect(isV1CreateKey('v1.1700000000000.9F1C2D3E-4A5B-4C6D-8E9F-0A1B2C3D4E5F')).toBe(false);
    expect(isV1CreateKey('v1.1700000000000.9f1c2d3e-1a5b-1c6d-8e9f-0a1b2c3d4e5f')).toBe(false);
    expect(isV1CreateKey('v1.1700000000000.not-a-uuid')).toBe(false);
    expect(isV1CreateKey(undefined)).toBe(false);
  });
});

describe('the request validators', () => {
  it('accepts only a canonical UUID', () => {
    expect(requireUuid(UUID)).toBe(UUID);
    expect(() => requireUuid('nope')).toThrow();
    expect(() => requireUuid(undefined)).toThrow();
  });

  it('accepts only a positive int32 version and quotes it canonically', () => {
    expect(requireVersion(1)).toBe(1);
    expect(requireIfMatch(1)).toBe('"1"');
    expect(requireIfMatch(2_147_483_647)).toBe('"2147483647"');
    expect(() => requireVersion(0)).toThrow();
    expect(() => requireVersion(2_147_483_648)).toThrow();
    expect(() => requireVersion('1')).toThrow();
    expect(() => requireIfMatch(0)).toThrow();
  });

  it('accepts only a real date', () => {
    expect(requireDate('2026-05-10')).toBe('2026-05-10');
    expect(() => requireDate('2026-02-30')).toThrow();
    expect(() => requireDate('2026-5-10')).toThrow();
    expect(() => requireDate(null)).toThrow();
  });

  it('accepts a note only as null or a bounded string', () => {
    expect(requireNote(null)).toBeNull();
    expect(requireNote('Doctor')).toBe('Doctor');
    expect(requireNote('x'.repeat(500))).toHaveLength(500);
    expect(() => requireNote('x'.repeat(501))).toThrow();
    expect(() => requireNote(7)).toThrow();
  });

  it('accepts only a bounded cursor and page size', () => {
    expect(requireCursor('cursor-1')).toBe('cursor-1');
    expect(requireCursor('x'.repeat(512))).toHaveLength(512);
    expect(() => requireCursor('')).toThrow();
    expect(() => requireCursor('x'.repeat(513))).toThrow();
    expect(() => requireCursor(7)).toThrow();
    expect(requireLimit(1)).toBe(1);
    expect(requireLimit(200)).toBe(200);
    expect(() => requireLimit(0)).toThrow();
    expect(() => requireLimit(201)).toThrow();
    expect(() => requireLimit(1.5)).toThrow();
    expect(() => requireLimit('50')).toThrow();
  });

  it('reads the issued time of a canonical create key', () => {
    const parsed = parseCreateKey('v1.1700000000000.9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f');
    expect(parsed).toEqual({
      value: 'v1.1700000000000.9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
      issuedAtMs: 1_700_000_000_000,
    });
    expect(parseCreateKey('v1.1700000000000.not-a-uuid')).toBeNull();
    expect(parseCreateKey(undefined)).toBeNull();
  });

  it('separates the ordered dates of a write from the range of a read', () => {
    expect(isOrderedRange('2026-01-01', '2027-06-01')).toBe(true);
    expect(isOrderedRange('2027-06-01', '2026-01-01')).toBe(false);
    expect(isOrderedRange('nope', '2026-01-01')).toBe(false);
    // A read is bounded to 366 inclusive days.
    expect(isValidRange('2026-05-01', '2026-05-31')).toBe(true);
    expect(isValidRange('2026-05-01', '2026-05-01')).toBe(true);
    expect(isValidRange('2026-01-01', '2027-01-01')).toBe(true);
    expect(isValidRange('2027-01-01', '2026-01-01')).toBe(false);
    expect(isValidRange('2026-01-01', '2027-01-02')).toBe(false);
    expect(isValidRange('2026-02-30', '2026-03-01')).toBe(false);
    expect(isValidRange('nope', '2026-05-31')).toBe(false);
  });

  it('validates the filters of a list request', () => {
    expect(() =>
      validateListQuery({ start: '2026-05-01', end: '2026-05-31' }, false),
    ).not.toThrow();
    expect(() =>
      validateListQuery(
        { start: '2026-05-01', end: '2026-05-31', userId: UUID, limit: 50, cursor: 'c' },
        true,
      ),
    ).not.toThrow();
    expect(() => validateListQuery({ start: 'nope', end: '2026-05-31' }, false)).toThrow();
    // A read is bounded to 366 inclusive days.
    expect(() => validateListQuery({ start: '2026-01-01', end: '2027-01-02' }, false)).toThrow();
    expect(() => validateListQuery({ start: '2027-01-01', end: '2026-01-01' }, false)).toThrow();
    expect(() =>
      validateListQuery({ start: '2026-05-01', end: '2026-05-31', userId: 'nope' }, false),
    ).toThrow();
    expect(() =>
      validateListQuery({ start: '2026-05-01', end: '2026-05-31', limit: 0 }, false),
    ).toThrow();
    expect(() =>
      validateListQuery({ start: '2026-05-01', end: '2026-05-31', cursor: 'c' }, false),
    ).toThrow();
    expect(() =>
      validateListQuery({ start: '2026-05-01', end: '2026-05-31', cursor: '' }, true),
    ).toThrow();
    expect(() =>
      validateListQuery({ start: '2026-05-01', end: '2026-05-31', extra: 1 } as never, false),
    ).toThrow();
    expect(() => validateListQuery(null as never, false)).toThrow();
  });

  it('validates a create body without imposing the business rules of the service', () => {
    expect(() =>
      validateCreatePayload({ startDate: '2026-05-10', endDate: '2026-05-10', dayPart: 'morning' }),
    ).not.toThrow();
    // The range of a read is not a rule of a create.
    expect(() =>
      validateCreatePayload({ startDate: '2026-01-01', endDate: '2027-06-01' }),
    ).not.toThrow();
    // A single day still needs a day part.
    expect(() =>
      validateCreatePayload({ startDate: '2026-05-10', endDate: '2026-05-10' }),
    ).toThrow();
    expect(() =>
      validateCreatePayload({ startDate: '2026-05-10', endDate: '2026-05-09' }),
    ).toThrow();
    expect(() =>
      validateCreatePayload({
        startDate: '2026-05-10',
        endDate: '2026-05-10',
        dayPart: 'afternoon',
      } as never),
    ).toThrow();
    expect(() =>
      validateCreatePayload({
        startDate: '2026-05-10',
        endDate: '2026-05-10',
        dayPart: 'morning',
        note: 'x'.repeat(501),
      }),
    ).toThrow();
    expect(() =>
      validateCreatePayload({
        startDate: '2026-05-10',
        endDate: '2026-05-10',
        dayPart: 'morning',
        userId: UUID,
      } as never),
    ).toThrow();
    expect(() => validateCreatePayload(null as never)).toThrow();
    expect(() =>
      validateCreatePayload({
        startDate: '2026-05-10',
        endDate: '2026-05-10',
        dayPart: 'morning',
        note: null,
      } as never),
    ).toThrow();
  });

  it('validates a partial update body', () => {
    expect(() => validatePatchChanges({ dayPart: 'evening' })).not.toThrow();
    expect(() => validatePatchChanges({ note: null })).not.toThrow();
    expect(() => validatePatchChanges({})).toThrow();
    expect(() => validatePatchChanges({ note: undefined })).toThrow();
    expect(() => validatePatchChanges({ startDate: 'nope' })).toThrow();
    expect(() => validatePatchChanges({ endDate: 'nope' })).toThrow();
    expect(() => validatePatchChanges({ dayPart: 'afternoon' } as never)).toThrow();
    expect(() => validatePatchChanges({ note: 7 } as never)).toThrow();
    expect(() => validatePatchChanges({ userId: UUID } as never)).toThrow();
    expect(() => validatePatchChanges(null as never)).toThrow();
  });

  it('does not execute getters or serialize hidden input fields', () => {
    let read = false;
    const accessor = {
      get note() {
        read = true;
        return 'should not be used';
      },
    };
    expect(() => validatePatchChanges(accessor)).toThrow();
    expect(read).toBe(false);
    const hidden = Object.defineProperty({ dayPart: 'morning' as const }, 'note', {
      value: 'not enumerable',
    });
    expect(() => validatePatchChanges(hidden)).toThrow();
  });
});

describe('parseIdentity', () => {
  it('parses the verified identity of a personal token', () => {
    expect(parseIdentity(IDENTITY)).toEqual({
      id: UUID,
      role: 'member',
      auth: {
        method: 'pat',
        tokenId: OTHER_UUID,
        scopes: ['pto:read', 'pto:create'],
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
    });
  });

  it('refuses anything that is not a personal-token identity', () => {
    const cookie = {
      id: UUID,
      name: 'Owner',
      email: 'o@example.test',
      role: 'member',
      colorCode: '#1',
    };
    const cases: unknown[] = [
      cookie,
      null,
      'text',
      { ...IDENTITY, id: 'nope' },
      { ...IDENTITY, role: 'wizard' },
      { ...IDENTITY, auth: { ...IDENTITY.auth, method: 'session' } },
      { ...IDENTITY, auth: { ...IDENTITY.auth, tokenId: 'nope' } },
      { ...IDENTITY, auth: { ...IDENTITY.auth, expiresAt: '2027-01-01' } },
      { ...IDENTITY, auth: { ...IDENTITY.auth, scopes: ['pto:teleport'] } },
      { ...IDENTITY, auth: { ...IDENTITY.auth, scopes: 'pto:read' } },
      { ...IDENTITY, auth: 'pat' },
    ];
    for (const value of cases) {
      expect(() => parseIdentity(value)).toThrow(PtoWireError);
    }
  });

  it('never repeats the upstream text in its message', () => {
    try {
      parseIdentity({ ...IDENTITY, id: 'secret-value' });
      throw new Error('expected the parse to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(PtoWireError);
      expect((error as Error).message).not.toContain('secret-value');
    }
  });
});

describe('parseRecord', () => {
  it('parses a mutation result', () => {
    expect(parseRecord(RECORD)).toEqual(RECORD);
  });

  it('refuses a record that does not match the contract', () => {
    const cases: unknown[] = [
      null,
      'text',
      { ...RECORD, id: 'nope' },
      { ...RECORD, userId: 'nope' },
      { ...RECORD, startDate: '2026-5-10' },
      { ...RECORD, endDate: '2026-02-30' },
      { ...RECORD, endDate: '2026-05-09' },
      { ...RECORD, dayPart: 'full' },
      { ...RECORD, note: 7 },
      { ...RECORD, version: 0 },
      { ...RECORD, version: '1' },
      { ...RECORD, createdAt: '2026-05-03' },
      { ...RECORD, updatedAt: 'yesterday' },
    ];
    for (const value of cases) {
      expect(() => parseRecord(value)).toThrow(PtoWireError);
    }
  });
});

describe('parseDetail', () => {
  it('parses a detail with its owner summary', () => {
    expect(parseDetail(DETAIL)).toEqual(DETAIL);
  });

  it('refuses a detail without a usable owner', () => {
    const cases: unknown[] = [
      null,
      'text',
      { ...DETAIL, user: undefined },
      { ...DETAIL, user: { ...DETAIL.user, id: 'nope' } },
      { ...DETAIL, user: { ...DETAIL.user, name: 7 } },
      { ...DETAIL, user: { ...DETAIL.user, colorCode: null } },
      { ...DETAIL, version: 0 },
      { ...DETAIL, note: 7 },
    ];
    for (const value of cases) {
      expect(() => parseDetail(value)).toThrow(PtoWireError);
    }
  });
});

describe('parsePageItem', () => {
  it('parses a paged row', () => {
    expect(parsePageItem(PAGE_ITEM)).toEqual(PAGE_ITEM);
  });

  it('refuses a paged row whose note is not null', () => {
    expect(() => parsePageItem(null)).toThrow(PtoWireError);
    expect(() => parsePageItem('text')).toThrow(PtoWireError);
    expect(() => parsePageItem({ ...PAGE_ITEM, note: 'leak' })).toThrow(PtoWireError);
    expect(() => parsePageItem({ ...PAGE_ITEM, note: undefined })).toThrow(PtoWireError);
  });
});

describe('parsePage', () => {
  it('parses a page envelope', () => {
    expect(parsePage({ items: [PAGE_ITEM], nextCursor: 'cursor-1', hasMore: true })).toEqual({
      items: [PAGE_ITEM],
      nextCursor: 'cursor-1',
      hasMore: true,
    });
    expect(parsePage({ items: [], nextCursor: null, hasMore: false })).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
  });

  it('refuses a malformed page envelope', () => {
    const cases: unknown[] = [
      null,
      'text',
      { items: 'nope', nextCursor: null, hasMore: false },
      { items: [], nextCursor: null, hasMore: 'yes' },
      { items: [], nextCursor: '', hasMore: true },
      { items: [], nextCursor: 7, hasMore: true },
      { items: [], nextCursor: 'x'.repeat(513), hasMore: true },
      { items: [PAGE_ITEM], nextCursor: null, hasMore: true },
      { items: [PAGE_ITEM], nextCursor: 'cursor-1', hasMore: false },
      { items: [], nextCursor: 'cursor-1', hasMore: true },
      { items: Array(201).fill(PAGE_ITEM), nextCursor: null, hasMore: false },
      { items: [{ ...PAGE_ITEM, version: 0 }], nextCursor: null, hasMore: false },
    ];
    for (const value of cases) {
      expect(() => parsePage(value)).toThrow(PtoWireError);
    }
  });
});
