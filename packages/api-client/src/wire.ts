import { PtoApiError } from './errors.js';

/**
 * The wire vocabulary of the PTO API.
 *
 * Everything here mirrors `docs/openapi.yaml` exactly: the same field names,
 * the same required fields, the same null rules and the same enumerations.
 * Response parsers project the documented fields without coercing them.
 * Request validators reject unsupported fields.
 *
 * The module is deliberately free of any transport, logger or domain import,
 * so it can be unit tested on its own and reused without a cycle.
 */

/** The roles the API knows. */
export type PtoRole = 'member' | 'team_lead' | 'admin';

/** The half-day vocabulary. */
export type PtoDayPart = 'morning' | 'evening' | 'all_day';

/** The personal-token scopes the API reports. */
export type PtoScope =
  | 'pto:read'
  | 'pto:notes:read'
  | 'pto:create'
  | 'pto:update:self'
  | 'pto:delete:self'
  | 'pto:update:team'
  | 'pto:delete:team';

export const PTO_ROLES: readonly PtoRole[] = ['member', 'team_lead', 'admin'];
export const PTO_DAY_PARTS: readonly PtoDayPart[] = ['morning', 'evening', 'all_day'];
export const PTO_SCOPES: readonly PtoScope[] = [
  'pto:read',
  'pto:notes:read',
  'pto:create',
  'pto:update:self',
  'pto:delete:self',
  'pto:update:team',
  'pto:delete:team',
];

/** The owner summary the calendar carries. */
export interface PtoUserSummary {
  id: string;
  name: string;
  colorCode: string;
}

/** The verified identity of a personal token. */
export interface PtoIdentity {
  id: string;
  role: PtoRole;
  auth: {
    method: 'pat';
    tokenId: string;
    scopes: PtoScope[];
    expiresAt: string;
  };
}

/** One PTO record as a mutation returns it. */
export interface PtoRecord {
  id: string;
  userId: string;
  startDate: string;
  endDate: string;
  dayPart: PtoDayPart;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** One PTO as the detail endpoint returns it, with its owner summary. */
export interface PtoDetail {
  id: string;
  user: PtoUserSummary;
  startDate: string;
  endDate: string;
  dayPart: PtoDayPart;
  note: string | null;
  version: number;
}

/** One row of the paged calendar list. Its note is always null. */
export interface PtoPageItem {
  id: string;
  user: PtoUserSummary;
  startDate: string;
  endDate: string;
  dayPart: PtoDayPart;
  note: null;
  version: number;
}

/** One page of the opt-in paged calendar list. */
export interface PtoPage {
  items: PtoPageItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** The body a create accepts. */
export interface CreatePtoPayload {
  startDate: string;
  endDate: string;
  dayPart?: PtoDayPart;
  note?: string;
}

/** The body a partial update accepts. */
export interface PatchPtoChanges {
  startDate?: string;
  endDate?: string;
  dayPart?: PtoDayPart;
  note?: string | null;
}

/** The result of a create, including the replay state the server reported. */
export interface CreatePtoResult {
  record: PtoRecord;
  replayed: boolean;
  expiresAt: string;
}

/** The maximum note length the API accepts. */
export const MAX_NOTE_LENGTH = 500;
/** The highest version the API accepts, an int32. */
export const MAX_VERSION = 2_147_483_647;
/** The longest cursor the API accepts. */
export const MAX_CURSOR_LENGTH = 512;
/** The largest page the API accepts. */
export const MAX_PAGE_LIMIT = 200;
/** The longest date range the API accepts, in days, inclusive. */
export const MAX_RANGE_DAYS = 366;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const V1_KEY_PATTERN =
  /^v1\.\d{13}\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * A malformed response. The message is fixed and carries no response data,
 * so it can never leak an upstream body into a log or an error.
 */
export class PtoWireError extends Error {
  constructor() {
    super('The response does not match the PTO wire contract.');
    this.name = 'PtoWireError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether the value is a plain object. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Whether the value is a canonical UUID. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** A real calendar date in the documented `YYYY-MM-DD` form. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

/** An absolute timestamp in the documented form. */
export function isIsoDateTime(value: unknown): value is string {
  return (
    typeof value === 'string' && DATE_TIME_PATTERN.test(value) && isIsoDate(value.slice(0, 10))
  );
}

/** A positive int32, the shape of a record version. */
export function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_VERSION;
}

/** The canonical create key: `v1.<13-digit UTC milliseconds>.<uuid v4>`. */
export function isV1CreateKey(value: unknown): value is string {
  return typeof value === 'string' && V1_KEY_PATTERN.test(value);
}

/** Whether the value is one of the documented half-day values. */
export function isDayPart(value: unknown): value is PtoDayPart {
  return typeof value === 'string' && (PTO_DAY_PARTS as readonly string[]).includes(value);
}

function isRole(value: unknown): value is PtoRole {
  return typeof value === 'string' && (PTO_ROLES as readonly string[]).includes(value);
}

function isScope(value: unknown): value is PtoScope {
  return typeof value === 'string' && (PTO_SCOPES as readonly string[]).includes(value);
}

function isNote(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= MAX_NOTE_LENGTH);
}

function requireUser(value: unknown): PtoUserSummary {
  if (!isRecord(value)) throw new PtoWireError();
  const { id, name, colorCode } = value;
  if (!isUuid(id) || typeof name !== 'string' || typeof colorCode !== 'string') {
    throw new PtoWireError();
  }
  return { id, name, colorCode };
}

function requireCommon(value: Record<string, unknown>): {
  id: string;
  startDate: string;
  endDate: string;
  dayPart: PtoDayPart;
  note: string | null;
  version: number;
} {
  const { id, startDate, endDate, dayPart, note, version } = value;
  if (
    !isUuid(id) ||
    !isIsoDate(startDate) ||
    !isIsoDate(endDate) ||
    endDate < startDate ||
    !isDayPart(dayPart) ||
    !isNote(note) ||
    !isVersion(version)
  ) {
    throw new PtoWireError();
  }
  return { id, startDate, endDate, dayPart, note, version };
}

/** The filters of one page request. */
export interface ListQuery {
  start: string;
  end: string;
  userId?: string;
  limit?: number;
  cursor?: string;
}

/** The filters of a traversal. A traversal never starts in the middle. */
export type ListAllQuery = Omit<ListQuery, 'cursor'>;

function invalidInput(): never {
  throw new PtoApiError('INVALID_INPUT');
}

/** A canonical UUID, or nothing at all. */
export function requireUuid(value: unknown): string {
  if (!isUuid(value)) invalidInput();
  return value;
}

/** A positive int32 record version. */
export function requireVersion(value: unknown): number {
  if (!isVersion(value)) invalidInput();
  return value;
}

/** The canonical quoted precondition of a write. */
export function requireIfMatch(value: unknown): string {
  return `"${requireVersion(value)}"`;
}

/** A real calendar date. */
export function requireDate(value: unknown): string {
  if (!isIsoDate(value)) invalidInput();
  return value;
}

/** A note: null clears it, a string replaces it, anything else is refused. */
export function requireNote(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > MAX_NOTE_LENGTH) invalidInput();
  return value;
}

/** An opaque continuation cursor. */
export function requireCursor(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CURSOR_LENGTH) {
    invalidInput();
  }
  return value;
}

/** A page size the API accepts. */
export function requireLimit(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_PAGE_LIMIT
  ) {
    invalidInput();
  }
  return value;
}

/**
 * The canonical create key with the time it was issued.
 *
 * The key states its own version, the millisecond it was issued and a client
 * nonce: `v1.<13-digit UTC Unix milliseconds>.<canonical lowercase UUIDv4>`.
 * There is no opaque fragment, no list and no alternative spelling.
 */
export function parseCreateKey(value: unknown): { value: string; issuedAtMs: number } | null {
  if (!isV1CreateKey(value)) return null;
  const issuedAtMs = Number(value.split('.')[1]);
  return { value, issuedAtMs };
}

/**
 * Whether the dates are in order. The business rules of a create — the range
 * length, the overlap and the day part — belong to the service, so the client
 * only refuses dates that cannot describe a record at all.
 */
export function isOrderedRange(start: string, end: string): boolean {
  if (!isIsoDate(start) || !isIsoDate(end)) return false;
  return Date.parse(`${start}T00:00:00.000Z`) <= Date.parse(`${end}T00:00:00.000Z`);
}

/** Whether the requested range is one a calendar read accepts. */
export function isValidRange(start: string, end: string): boolean {
  if (!isOrderedRange(start, end)) return false;
  const from = Date.parse(`${start}T00:00:00.000Z`);
  const to = Date.parse(`${end}T00:00:00.000Z`);
  return Math.round((to - from) / 86_400_000) + 1 <= MAX_RANGE_DAYS;
}

/** The filters of a list request, validated before anything is sent. */
export function validateListQuery(query: ListQuery | ListAllQuery, allowCursor: boolean): void {
  const raw = assertPlainObject(query) as unknown as Record<string, unknown>;
  assertOnlyKeys(
    raw,
    allowCursor
      ? ['start', 'end', 'userId', 'limit', 'cursor']
      : ['start', 'end', 'userId', 'limit'],
  );
  requireDate(raw['start']);
  requireDate(raw['end']);
  if (!isValidRange(query.start, query.end)) invalidInput();
  if (raw['userId'] !== undefined) requireUuid(raw['userId']);
  if (raw['limit'] !== undefined) requireLimit(raw['limit']);
  if (allowCursor && raw['cursor'] !== undefined) requireCursor(raw['cursor']);
}

/** A create body, validated before anything is sent. */
export function validateCreatePayload(payload: CreatePtoPayload): void {
  const raw = assertPlainObject(payload) as unknown as Record<string, unknown>;
  assertOnlyKeys(raw, ['startDate', 'endDate', 'dayPart', 'note']);
  const startDate = requireDate(raw['startDate']);
  const endDate = requireDate(raw['endDate']);
  if (!isOrderedRange(startDate, endDate)) invalidInput();
  if (raw['dayPart'] !== undefined && !isDayPart(raw['dayPart'])) invalidInput();
  if (raw['note'] !== undefined && requireNote(raw['note']) === null) invalidInput();
  // A single-day entry needs a day part; a multi-day entry is normalised to
  // all_day by the API, so the client never guesses one.
  if (startDate === endDate && raw['dayPart'] === undefined) invalidInput();
}

/** A partial update body, validated before anything is sent. */
export function validatePatchChanges(changes: PatchPtoChanges): void {
  const raw = assertPlainObject(changes) as unknown as Record<string, unknown>;
  assertOnlyKeys(raw, ['startDate', 'endDate', 'dayPart', 'note']);
  if (!Object.values(raw).some((value) => value !== undefined)) invalidInput();
  if (raw['startDate'] !== undefined) requireDate(raw['startDate']);
  if (raw['endDate'] !== undefined) requireDate(raw['endDate']);
  if (raw['dayPart'] !== undefined && !isDayPart(raw['dayPart'])) invalidInput();
  if (raw['note'] !== undefined) requireNote(raw['note']);
}

function assertPlainObject(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) invalidInput();
  return value;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || !allowed.includes(key)) {
      invalidInput();
    }
  }
}

/** Parses the verified identity of a personal token. */
export function parseIdentity(body: unknown): PtoIdentity {
  if (!isRecord(body)) throw new PtoWireError();
  const { id, role, auth } = body;
  if (!isUuid(id) || !isRole(role) || !isRecord(auth)) throw new PtoWireError();
  const { method, tokenId, scopes, expiresAt } = auth;
  if (method !== 'pat' || !isUuid(tokenId) || !isIsoDateTime(expiresAt)) {
    throw new PtoWireError();
  }
  if (!Array.isArray(scopes) || !scopes.every((scope) => isScope(scope))) {
    throw new PtoWireError();
  }
  return {
    id,
    role,
    auth: { method: 'pat', tokenId, scopes: scopes as PtoScope[], expiresAt },
  };
}

/** Parses one PTO as a mutation returns it. */
export function parseRecord(body: unknown): PtoRecord {
  if (!isRecord(body)) throw new PtoWireError();
  const { userId, createdAt, updatedAt } = body;
  if (!isUuid(userId) || !isIsoDateTime(createdAt) || !isIsoDateTime(updatedAt)) {
    throw new PtoWireError();
  }
  return { ...requireCommon(body), userId, createdAt, updatedAt };
}

/** Parses one PTO as the detail endpoint returns it. */
export function parseDetail(body: unknown): PtoDetail {
  if (!isRecord(body)) throw new PtoWireError();
  const common = requireCommon(body);
  return { ...common, user: requireUser(body['user']) };
}

/** Parses one row of the paged list. Its note is always null. */
export function parsePageItem(body: unknown): PtoPageItem {
  if (!isRecord(body)) throw new PtoWireError();
  const common = requireCommon(body);
  if (body['note'] !== null) throw new PtoWireError();
  return { ...common, user: requireUser(body['user']), note: null };
}

/** Parses one page of the opt-in paged list. */
export function parsePage(body: unknown): PtoPage {
  if (!isRecord(body)) throw new PtoWireError();
  const { items, nextCursor, hasMore } = body;
  if (!Array.isArray(items) || items.length > MAX_PAGE_LIMIT || typeof hasMore !== 'boolean') {
    throw new PtoWireError();
  }
  if (nextCursor !== null && (typeof nextCursor !== 'string' || nextCursor.length === 0)) {
    throw new PtoWireError();
  }
  if (nextCursor !== null && nextCursor.length > MAX_CURSOR_LENGTH) {
    throw new PtoWireError();
  }
  if (hasMore !== (nextCursor !== null) || (hasMore && items.length === 0)) {
    throw new PtoWireError();
  }
  return {
    items: items.map((item) => parsePageItem(item)),
    nextCursor,
    hasMore,
  };
}
