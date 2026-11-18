import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({ loadEnv: vi.fn() }));

import { loadEnv } from '../../config/env.js';
import {
  CURSOR_VERSION,
  activeCursorKey,
  mintCursor,
  verifyCursor,
  type CalendarCursorAnchor,
  type CalendarCursorContext,
} from './cursor.js';

const KEY = 'aB1!cD2@eF3#gH4$iJ5%kL6&mN7*oP8+';
const OTHER_KEY = 'zZ9@xY8#wV7!uT6%rS5&qP4&oN3*mL2+kJ1';
const OWNER = '11111111-1111-4111-8111-111111111111';
const ROW = '22222222-2222-4222-8222-222222222222';
const DOMAIN = 'pto-calendar:pto-list-cursor:v1';

const context: CalendarCursorContext = { start: '2026-05-01', end: '2026-05-31', userId: null };
const anchor: CalendarCursorAnchor = { startDate: '2026-05-11', userId: OWNER, id: ROW };

/** Build the wire envelope for an arbitrary payload with the known domain. */
function envelope(payload: string, key = KEY): string {
  const signature = createHmac('sha256', key)
    .update(DOMAIN)
    .update(payload, 'utf8')
    .digest('base64url');
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${signature}`;
}

const validPayload = `1|2026-05-01|2026-05-31||2026-05-11|${OWNER}|${ROW}`;

describe('calendar cursor', () => {
  beforeEach(() => {
    vi.mocked(loadEnv).mockReturnValue({ SESSION_SECRET: [KEY, OTHER_KEY] } as never);
  });
  afterEach(() => vi.clearAllMocks());

  describe('activeCursorKey', () => {
    it('uses the first configured session key, the one the cookie session signs with', () => {
      expect(activeCursorKey()).toBe(KEY);
    });

    it('fails closed when no session key is configured', () => {
      vi.mocked(loadEnv).mockReturnValue({ SESSION_SECRET: [] } as never);
      expect(() => activeCursorKey()).toThrow(/No active session key/);
    });
  });

  describe('mintCursor', () => {
    it('issues a bounded, opaque envelope that verifies against the same context', () => {
      const minted = mintCursor(context, anchor, KEY);
      expect(minted.length).toBeLessThanOrEqual(512);
      expect(minted).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect(verifyCursor(minted, context, KEY)).toEqual({ context, anchor });
    });

    it('binds the owner filter into the cursor', () => {
      const filtered = { ...context, userId: OWNER };
      const minted = mintCursor(filtered, anchor, KEY);
      expect(verifyCursor(minted, filtered, KEY)).toEqual({ context: filtered, anchor });
      expect(verifyCursor(minted, context, KEY)).toBeNull();
    });

    it('refuses to issue an envelope beyond the maximum length', () => {
      expect(() => mintCursor({ ...context, userId: 'x'.repeat(600) }, anchor, KEY)).toThrow(
        /maximum length/,
      );
    });

    it('refuses to issue a cursor from an invalid range or anchor', () => {
      expect(() => mintCursor({ ...context, start: 'not-a-date' }, anchor, KEY)).toThrow(
        /inputs are invalid/,
      );
      expect(() => mintCursor({ ...context, end: 'not-a-date' }, anchor, KEY)).toThrow(
        /inputs are invalid/,
      );
      expect(() => mintCursor(context, { ...anchor, startDate: 'not-a-date' }, KEY)).toThrow(
        /inputs are invalid/,
      );
      expect(() => mintCursor(context, { ...anchor, userId: 'nope' }, KEY)).toThrow(
        /inputs are invalid/,
      );
      expect(() => mintCursor(context, { ...anchor, id: 'nope' }, KEY)).toThrow(
        /inputs are invalid/,
      );
      expect(() => mintCursor({ ...context, userId: 'nope' }, anchor, KEY)).toThrow(
        /inputs are invalid/,
      );
    });
  });

  describe('verifyCursor', () => {
    it('rejects an empty, oversized or dotless envelope', () => {
      expect(verifyCursor('', context, KEY)).toBeNull();
      expect(verifyCursor('a'.repeat(513), context, KEY)).toBeNull();
      expect(verifyCursor('no-dot-here', context, KEY)).toBeNull();
    });

    it('rejects a non-canonical base64url segment', () => {
      const minted = mintCursor(context, anchor, KEY);
      const [payload] = minted.split('.') as [string, string];
      expect(verifyCursor('aa.bb', context, KEY)).toBeNull();
      expect(verifyCursor(`${payload}.aa`, context, KEY)).toBeNull();
    });

    it('rejects a signature of the wrong length or a tampered signature', () => {
      const minted = mintCursor(context, anchor, KEY);
      const [payload, signature] = minted.split('.') as [string, string];
      expect(verifyCursor(`${payload}.AAAA`, context, KEY)).toBeNull();
      const flipped = signature[10] === 'A' ? 'B' : 'A';
      const tampered = `${signature.slice(0, 10)}${flipped}${signature.slice(11)}`;
      expect(verifyCursor(`${payload}.${tampered}`, context, KEY)).toBeNull();
    });

    it('rejects a cursor signed with a rotated key', () => {
      const minted = mintCursor(context, anchor, KEY);
      expect(verifyCursor(minted, context, OTHER_KEY)).toBeNull();
    });

    it('rejects a payload with the wrong shape or an unsupported version', () => {
      expect(verifyCursor(envelope('1|2026-05-01'), context, KEY)).toBeNull();
      expect(
        verifyCursor(envelope(`2|2026-05-01|2026-05-31||2026-05-11|${OWNER}|${ROW}`), context, KEY),
      ).toBeNull();
    });

    it('rejects a payload with an impossible date or a malformed identifier', () => {
      const payloads = [
        `1|2026-13-01|2026-05-31||2026-05-11|${OWNER}|${ROW}`,
        `1|2026-05-01|2026-02-30||2026-05-11|${OWNER}|${ROW}`,
        `1|2026-05-01|2026-05-31||2026-99-01|${OWNER}|${ROW}`,
        `1|2026-05-01|2026-05-31|nope|2026-05-11|${OWNER}|${ROW}`,
        `1|2026-05-01|2026-05-31||2026-05-11|nope|${ROW}`,
        `1|2026-05-01|2026-05-31||2026-05-11|${OWNER}|nope`,
      ];
      for (const payload of payloads) {
        expect(verifyCursor(envelope(payload), context, KEY)).toBeNull();
      }
    });

    it('rejects a cursor that belongs to a different range or owner filter', () => {
      const minted = mintCursor(context, anchor, KEY);
      expect(verifyCursor(minted, { ...context, start: '2026-05-02' }, KEY)).toBeNull();
      expect(verifyCursor(minted, { ...context, end: '2026-06-01' }, KEY)).toBeNull();
      expect(verifyCursor(minted, { ...context, userId: OWNER }, KEY)).toBeNull();
    });

    it('accepts a payload whose owner filter is the empty unfiltered marker', () => {
      const decoded = verifyCursor(envelope(validPayload), context, KEY);
      expect(decoded?.context.userId).toBeNull();
      expect(CURSOR_VERSION).toBe(1);
    });
  });
});
