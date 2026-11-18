import { createHmac, timingSafeEqual } from 'node:crypto';
import { loadEnv } from '../../config/env.js';
import { MAX_CURSOR_LENGTH, isRealIsoDate } from './range.js';

/**
 * Opaque, server-minted continuation cursor for the paged calendar query.
 *
 * The cursor is an integrity token, never an authorization or snapshot
 * mechanism: it carries only the query context (range and owner filter) and
 * the sort-key anchor of the last delivered row. The reader and scope check
 * still runs on every request, and a cursor can never widen the rows a caller
 * may see.
 *
 * The envelope is `<base64url(payload)>.<base64url(HMAC-SHA256)>`:
 *
 * - `payload` is `version|start|end|userId|anchorStartDate|anchorUserId|anchorId`
 *   with `userId` empty when the query is unfiltered. Every field is
 *   re-validated on decode; nothing is trusted because it was signed.
 * - The signature is an HMAC-SHA256 over the payload with the active session
 *   key and a dedicated domain separator, so a cursor can never be confused
 *   with a session cookie signature.
 *
 * The signature is compared in constant time. Rotation of the active session
 * key invalidates previously issued cursors, which is the documented rotation
 * behaviour rather than a silent surprise.
 */
export const CURSOR_VERSION = 1;

const CURSOR_DOMAIN = 'pto-calendar:pto-list-cursor:v1';
const CURSOR_SEPARATOR = '|';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAYLOAD_FIELDS = 7;

/** The query a cursor is bound to. A continuation must repeat it exactly. */
export interface CalendarCursorContext {
  start: string;
  end: string;
  userId: string | null;
}

/** The sort key of the last delivered row: `(startDate, userId, id)`. */
export interface CalendarCursorAnchor {
  startDate: string;
  userId: string;
  id: string;
}

export interface CalendarCursor {
  context: CalendarCursorContext;
  anchor: CalendarCursorAnchor;
}

/**
 * The active signing key: the first configured session key, which is the key
 * the cookie session signs with. No new environment variable is introduced.
 */
export function activeCursorKey(): string {
  const active = loadEnv().SESSION_SECRET[0];
  if (!active) throw new Error('No active session key is configured.');
  return active;
}

function sign(payload: string, key: string): Buffer {
  return createHmac('sha256', key).update(CURSOR_DOMAIN).update(payload, 'utf8').digest();
}

function validContext(context: CalendarCursorContext): boolean {
  if (!isRealIsoDate(context.start)) return false;
  if (!isRealIsoDate(context.end)) return false;
  if (context.userId !== null && !UUID_PATTERN.test(context.userId)) return false;
  return true;
}

function validAnchor(anchor: CalendarCursorAnchor): boolean {
  if (!isRealIsoDate(anchor.startDate)) return false;
  if (!UUID_PATTERN.test(anchor.userId)) return false;
  if (!UUID_PATTERN.test(anchor.id)) return false;
  return true;
}

function encodePayload(context: CalendarCursorContext, anchor: CalendarCursorAnchor): string {
  return [
    String(CURSOR_VERSION),
    context.start,
    context.end,
    context.userId ?? '',
    anchor.startDate,
    anchor.userId,
    anchor.id,
  ].join(CURSOR_SEPARATOR);
}

/**
 * Decode one canonical base64url segment. A non-canonical encoding is
 * rejected so that one payload has exactly one envelope.
 */
function decodeBase64Url(value: string): Buffer | null {
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) return null;
  return decoded;
}

function decodePayload(payload: string): CalendarCursor | null {
  const fields = payload.split(CURSOR_SEPARATOR);
  if (fields.length !== PAYLOAD_FIELDS) return null;
  const [version, start, end, userId, anchorStart, anchorUser, anchorId] = fields as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (version !== String(CURSOR_VERSION)) return null;
  if (!isRealIsoDate(start) || !isRealIsoDate(end) || !isRealIsoDate(anchorStart)) return null;
  if (userId !== '' && !UUID_PATTERN.test(userId)) return null;
  if (!UUID_PATTERN.test(anchorUser) || !UUID_PATTERN.test(anchorId)) return null;
  return {
    context: { start, end, userId: userId === '' ? null : userId },
    anchor: { startDate: anchorStart, userId: anchorUser, id: anchorId },
  };
}

function sameContext(left: CalendarCursorContext, right: CalendarCursorContext): boolean {
  return left.start === right.start && left.end === right.end && left.userId === right.userId;
}

/**
 * Mint a cursor for the last delivered row of a page. The caller passes
 * already validated values; the envelope bound is the only mint-time
 * rejection, and decoding re-validates every field, so a cursor minted from
 * unexpected input is never accepted.
 */
export function mintCursor(
  context: CalendarCursorContext,
  anchor: CalendarCursorAnchor,
  key: string = activeCursorKey(),
): string {
  const payload = encodePayload(context, anchor);
  const envelope = `${Buffer.from(payload, 'utf8').toString('base64url')}.${sign(
    payload,
    key,
  ).toString('base64url')}`;
  if (envelope.length > MAX_CURSOR_LENGTH) {
    throw new Error('Cursor envelope exceeds the maximum length.');
  }
  if (!validContext(context) || !validAnchor(anchor)) {
    throw new Error('Cursor inputs are invalid.');
  }
  return envelope;
}

/**
 * Verify a cursor against the request context. Every failure mode — a
 * malformed envelope, a tampered signature, a rotated key, or a cursor that
 * was issued for a different range or owner filter — returns `null` so the
 * caller can answer with one generic error and no cursor echo.
 */
export function verifyCursor(
  raw: string,
  context: CalendarCursorContext,
  key: string = activeCursorKey(),
): CalendarCursor | null {
  if (raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) return null;
  const separator = raw.indexOf('.');
  if (separator < 1) return null;
  const payloadBytes = decodeBase64Url(raw.slice(0, separator));
  const signatureBytes = decodeBase64Url(raw.slice(separator + 1));
  if (!payloadBytes || !signatureBytes) return null;
  const expected = sign(payloadBytes.toString('utf8'), key);
  if (expected.length !== signatureBytes.length) return null;
  if (!timingSafeEqual(expected, signatureBytes)) return null;
  const decoded = decodePayload(payloadBytes.toString('utf8'));
  if (!decoded) return null;
  if (!sameContext(decoded.context, context)) return null;
  return decoded;
}
