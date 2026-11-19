/**
 * The wire contract of the read-only PTO tool layer.
 *
 * This module is pure. It validates the arguments a model may pass, advertises
 * the JSON Schema of every tool and projects the answers of the shared API
 * client into the bounded, allowlisted records the protocol carries. It never
 * opens a store, never sends a request, never reads the environment and never
 * sees a credential.
 *
 * Three rules shape everything here:
 *
 * - an argument is never an instruction. The accepted keys are fixed, their
 *   types are fixed and their bounds are fixed, and a value that is not
 *   allowed is refused instead of being repaired;
 * - an answer is never more than it claims. Only allowlisted fields are
 *   copied, every text is bounded and scrubbed, and a note is only ever shown
 *   when the caller asked for it and the service returned one;
 * - a diagnostic is never an echo. Every message is a fixed sentence, so a
 *   rejected argument, a credential and an upstream cause can never reach the
 *   wire.
 */

import { createHash, randomUUID } from 'node:crypto';

import type { ListAllReason, PtoDayPart } from '@pto-calendar/api-client';

import {
  LIST_PAGE_DEFAULT,
  LIST_PAGE_LIMIT,
  LIST_PAGES_DEFAULT,
  LIST_PAGES_LIMIT,
  LIST_RECORD_LIMIT,
  MCP_SCHEMA_VERSION,
  TOOL_ERROR_CODES,
  type ReadToolInput,
  type ReadToolList,
  type ToolErrorCode,
  type ToolName,
  type ToolRecord,
} from './contract.js';

/** One JSON Schema node. The exact keywords are checked by the tests. */
export interface SchemaNode {
  readonly [keyword: string]: unknown;
}

/**
 * The strict object schema of one tool input.
 *
 * The type is an alias and not an interface on purpose: an alias of an object
 * type carries an implicit index signature, so the schema is assignable to the
 * input schema of the SDK without a cast.
 */
export type ToolInputSchema = {
  readonly type: 'object';
  readonly additionalProperties: false;
  readonly required: string[];
  readonly properties: Record<string, SchemaNode>;
  readonly not?: SchemaNode;
};

/** The bounded envelope schema of one tool output. */
export type ToolOutputSchema = {
  readonly type: 'object';
  readonly oneOf: readonly SchemaNode[];
};

/** The longest date range one read may cover, in days, inclusive. */
export const MAX_RANGE_DAYS = 366;

/** The longest owner name one record may carry. The service accepts the same bound. */
export const MAX_OWNER_NAME_LENGTH = 120;

/** The longest note one record may carry. The API accepts the same bound. */
export const MAX_NOTE_LENGTH = 500;

/** The placeholder that replaces any secret-shaped text. */
export const REDACTED = '[redacted]';

/** The length of the secret component at the end of a personal access token. */
const SECRET_LENGTH = 64;

/** The shape of a calendar day in the documented form. */
const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** The shape of the request identifier the adapter generates for itself. */
const REQUEST_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The JSON Schema source of the UUID shape. */
const UUID_SOURCE = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const UUID_SHAPE = new RegExp(UUID_SOURCE);

/** The JSON Schema source of the calendar day shape. */
const DAY_SOURCE = '^\\d{4}-\\d{2}-\\d{2}$';

/** The JSON Schema source of the request identifier shape. */
const REQUEST_ID_SOURCE = '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

/** The reasons a bounded traversal may stop with. */
export const LIST_REASONS: readonly ListAllReason[] = [
  'complete',
  'drift',
  'budget',
  'deadline',
  'aborted',
  'error',
  'invalid-response',
];

/** The half-day vocabulary the API reports. */
const DAY_PARTS: readonly PtoDayPart[] = ['morning', 'evening', 'all_day'];

/** The highest version the API reports, an int32. */
const MAX_VERSION = 2_147_483_647;

/** The keys the list tool accepts. Nothing else is ever read. */
const LIST_KEYS: readonly string[] = ['from', 'to', 'ownerId', 'mine', 'pageSize', 'maxPages'];

/** The keys the detail tool accepts. Nothing else is ever read. */
const GET_KEYS: readonly string[] = ['id', 'includeNote'];

/**
 * The fixed messages of the argument validation.
 *
 * Every sentence names the shape that was expected and never the value that
 * was given, so a rejected argument can never echo itself into the wire.
 */
export const INPUT_MESSAGES = {
  notAnObject: 'The tool arguments must be a JSON object.',
  unknownField: 'The tool arguments contain a field this tool does not accept.',
  missingField: 'A required argument is missing.',
  wrongType: 'An argument has a type this tool does not accept.',
  invalidDate: 'Use real calendar dates in YYYY-MM-DD form.',
  invalidRange: 'The date range must be ordered and cover at most 366 days, inclusive.',
  invalidUuid: 'Use a canonical UUID for the owner or the entry.',
  ownerConflict: 'Choose either the own-records filter or an owner filter, not both.',
  invalidPageSize: 'The page size must be a whole number between 1 and 100.',
  invalidMaxPages: 'The page count must be a whole number between 1 and 10.',
  unknownTool: 'The requested tool is not one of the documented read tools.',
} as const;

/** The outcome of one validation: the value, or a fixed refusal. */
export type InputResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ToolErrorCode; readonly message: string };

/** The validated arguments of the list tool. */
export type ListArguments = Extract<ReadToolInput, { readonly name: 'pto_list' }>;

/** The validated arguments of the detail tool. */
export type GetArguments = Extract<ReadToolInput, { readonly name: 'pto_get' }>;

/* ------------------------------------------------------------------------- */
/* The advertised schemas.                                                     */
/* ------------------------------------------------------------------------- */

/** The owner summary one record carries. */
const OWNER_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name'],
  properties: {
    id: { type: 'string', pattern: UUID_SOURCE },
    name: { type: 'string', maxLength: MAX_OWNER_NAME_LENGTH },
  },
};

/** One PTO record. Every field is allowlisted and every text is bounded. */
const RECORD_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'owner', 'startDate', 'endDate', 'dayPart', 'note', 'version'],
  properties: {
    id: { type: 'string', pattern: UUID_SOURCE },
    owner: OWNER_SCHEMA,
    startDate: { type: 'string', pattern: DAY_SOURCE },
    endDate: { type: 'string', pattern: DAY_SOURCE },
    dayPart: { type: 'string', enum: [...DAY_PARTS] },
    note: { type: ['string', 'null'], maxLength: MAX_NOTE_LENGTH },
    version: { type: 'integer', minimum: 1, maximum: MAX_VERSION },
  },
};

/** The rows and the completeness of one bounded list read. */
const LIST_DATA_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'complete', 'reason', 'pages'],
  properties: {
    items: { type: 'array', maxItems: LIST_RECORD_LIMIT, items: RECORD_SCHEMA },
    complete: { type: 'boolean' },
    reason: { type: 'string', enum: [...LIST_REASONS] },
    pages: { type: 'integer', minimum: 0, maximum: LIST_PAGES_LIMIT },
  },
};

/** The typed error of one call. It never carries an upstream message. */
const ERROR_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'message', 'status', 'upstreamRequestId', 'retryAfterMs'],
  properties: {
    code: { type: 'string', enum: [...TOOL_ERROR_CODES] },
    message: { type: 'string', minLength: 1, maxLength: 400 },
    status: { type: ['integer', 'null'], minimum: 100, maximum: 599 },
    upstreamRequestId: { type: ['string', 'null'], maxLength: 200 },
    retryAfterMs: { type: ['integer', 'null'], minimum: 0 },
  },
};

/**
 * The closed envelope of one tool result.
 *
 * The envelope carries the schema version, the request identifier the adapter
 * generated for itself, and exactly one of a success payload or a typed
 * error. Every branch is closed: a field that is not listed is refused, so an
 * answer can never grow a field that no schema describes.
 */
function envelopeSchema(tool: ToolName, data: SchemaNode, withPartial: boolean): ToolOutputSchema {
  const common = {
    schemaVersion: { const: MCP_SCHEMA_VERSION },
    requestId: { type: 'string', pattern: REQUEST_ID_SOURCE },
  };
  return {
    type: 'object',
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['schemaVersion', 'requestId', 'ok', 'tool', 'data'],
        properties: {
          ...common,
          ok: { const: true },
          tool: { const: tool },
          data,
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['schemaVersion', 'requestId', 'ok', 'tool', 'error'],
        properties: {
          ...common,
          ok: { const: false },
          tool: { const: tool },
          error: ERROR_SCHEMA,
          ...(withPartial ? { partial: LIST_DATA_SCHEMA } : {}),
        },
      },
    ],
  };
}

/** The strict input schema of the list tool. */
export const LIST_INPUT_SCHEMA: ToolInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['from', 'to'],
  not: { required: ['ownerId', 'mine'], properties: { ownerId: {}, mine: { const: true } } },
  properties: {
    from: {
      type: 'string',
      pattern: DAY_SOURCE,
      description: 'The first day of the inclusive range, as YYYY-MM-DD.',
    },
    to: {
      type: 'string',
      pattern: DAY_SOURCE,
      description: 'The last day of the inclusive range, as YYYY-MM-DD.',
    },
    ownerId: {
      type: 'string',
      pattern: UUID_SOURCE,
      description: 'The identifier of one owner. It cannot be combined with mine.',
    },
    mine: {
      type: 'boolean',
      description:
        'Read only the records of the credential owner. It cannot be combined with ownerId.',
    },
    pageSize: {
      type: 'integer',
      minimum: 1,
      maximum: LIST_PAGE_LIMIT,
      description: `The rows read per page. The default is ${LIST_PAGE_DEFAULT} and the maximum is ${LIST_PAGE_LIMIT}.`,
    },
    maxPages: {
      type: 'integer',
      minimum: 1,
      maximum: LIST_PAGES_LIMIT,
      description: `The pages read per call. The default is ${LIST_PAGES_DEFAULT} and the maximum is ${LIST_PAGES_LIMIT}.`,
    },
  },
};

/** The strict input schema of the detail tool. */
export const GET_INPUT_SCHEMA: ToolInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: {
      type: 'string',
      pattern: UUID_SOURCE,
      description: 'The identifier of one PTO record.',
    },
    includeNote: {
      type: 'boolean',
      description:
        'Ask for the private note. The note is only returned when the credential is allowed to see it.',
    },
  },
};

/** The closed output schema of the list tool. */
export const LIST_OUTPUT_SCHEMA: ToolOutputSchema = envelopeSchema(
  'pto_list',
  LIST_DATA_SCHEMA,
  true,
);

/** The closed output schema of the detail tool. */
export const GET_OUTPUT_SCHEMA: ToolOutputSchema = envelopeSchema('pto_get', RECORD_SCHEMA, false);

/* ------------------------------------------------------------------------- */
/* The validation.                                                             */
/* ------------------------------------------------------------------------- */

/** Whether the value is a plain object with no inherited behaviour. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A property that is an accessor instead of a value is never read. */
const ACCESSOR = Symbol('accessor');

/**
 * Reads one own property without ever calling an accessor.
 *
 * A hostile argument object may carry a getter; reading it would run code the
 * model chose. The getter is never called: the property is reported as
 * unusable instead.
 */
function readProperty(descriptors: PropertyDescriptorMap, key: string): unknown {
  const descriptor = descriptors[key];
  if (descriptor === undefined) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) return ACCESSOR;
  return descriptor.value;
}

/** A refusal with a fixed message. */
function refuse<T>(message: string): InputResult<T> {
  return { ok: false, code: 'INPUT', message };
}

/** Whether the value is a real calendar day in the documented form. */
function isRealDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY_SHAPE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

/** Whether the value is a canonical UUID. */
function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_SHAPE.test(value);
}

/** Whether the value is a whole number inside an inclusive bound. */
function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
  );
}

/**
 * Refuses an argument object that carries a key the tool does not accept.
 *
 * The check runs before any value is read, so an unknown key is never even
 * looked at. Only own properties count: an inherited property is not part of
 * the argument object at all.
 */
function refuseUnknownKey<T>(
  descriptors: PropertyDescriptorMap,
  allowed: readonly string[],
): InputResult<T> | null {
  for (const key of Object.keys(descriptors)) {
    if (!allowed.includes(key)) return refuse(INPUT_MESSAGES.unknownField);
  }
  return null;
}

/**
 * Validates the arguments of the list tool.
 *
 * The validation is complete before it returns: a caller either has a bounded
 * argument object or a fixed refusal. Nothing is repaired, nothing is guessed
 * and the two owner filters can never be combined.
 */
export function validateListArguments(input: unknown): InputResult<ListArguments> {
  if (!isPlainObject(input)) return refuse(INPUT_MESSAGES.notAnObject);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const unknown = refuseUnknownKey<ListArguments>(descriptors, LIST_KEYS);
  if (unknown !== null) return unknown;

  const from = readProperty(descriptors, 'from');
  const to = readProperty(descriptors, 'to');
  if (from === undefined || to === undefined) return refuse(INPUT_MESSAGES.missingField);
  if (typeof from !== 'string' || typeof to !== 'string') {
    return refuse(INPUT_MESSAGES.wrongType);
  }
  if (!isRealDay(from) || !isRealDay(to)) return refuse(INPUT_MESSAGES.invalidDate);
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (end < start) return refuse(INPUT_MESSAGES.invalidRange);
  if (Math.round((end - start) / 86_400_000) + 1 > MAX_RANGE_DAYS) {
    return refuse(INPUT_MESSAGES.invalidRange);
  }

  const ownerId = readProperty(descriptors, 'ownerId');
  if (ownerId !== undefined) {
    if (ownerId === ACCESSOR) return refuse(INPUT_MESSAGES.wrongType);
    if (!isCanonicalUuid(ownerId)) return refuse(INPUT_MESSAGES.invalidUuid);
  }

  const mine = readProperty(descriptors, 'mine');
  if (mine !== undefined) {
    if (typeof mine !== 'boolean') return refuse(INPUT_MESSAGES.wrongType);
  }

  const pageSize = readProperty(descriptors, 'pageSize');
  if (pageSize !== undefined) {
    if (pageSize === ACCESSOR) return refuse(INPUT_MESSAGES.wrongType);
    if (!isBoundedInteger(pageSize, 1, LIST_PAGE_LIMIT)) {
      return refuse(INPUT_MESSAGES.invalidPageSize);
    }
  }

  const maxPages = readProperty(descriptors, 'maxPages');
  if (maxPages !== undefined) {
    if (maxPages === ACCESSOR) return refuse(INPUT_MESSAGES.wrongType);
    if (!isBoundedInteger(maxPages, 1, LIST_PAGES_LIMIT)) {
      return refuse(INPUT_MESSAGES.invalidMaxPages);
    }
  }

  if (mine === true && ownerId !== undefined) return refuse(INPUT_MESSAGES.ownerConflict);

  return {
    ok: true,
    value: {
      name: 'pto_list',
      from,
      to,
      ...(ownerId === undefined ? {} : { ownerId }),
      mine: mine === true,
      pageSize: pageSize === undefined ? LIST_PAGE_DEFAULT : pageSize,
      maxPages: maxPages === undefined ? LIST_PAGES_DEFAULT : maxPages,
    },
  };
}

/**
 * Validates the arguments of the detail tool.
 *
 * The note is an explicit opt-in: without it the note of the record is never
 * carried, whatever the service answers.
 */
export function validateGetArguments(input: unknown): InputResult<GetArguments> {
  if (!isPlainObject(input)) return refuse(INPUT_MESSAGES.notAnObject);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const unknown = refuseUnknownKey<GetArguments>(descriptors, GET_KEYS);
  if (unknown !== null) return unknown;

  const id = readProperty(descriptors, 'id');
  if (id === undefined) return refuse(INPUT_MESSAGES.missingField);
  if (typeof id !== 'string') return refuse(INPUT_MESSAGES.wrongType);
  if (!isCanonicalUuid(id)) return refuse(INPUT_MESSAGES.invalidUuid);

  const includeNote = readProperty(descriptors, 'includeNote');
  if (includeNote !== undefined && typeof includeNote !== 'boolean') {
    return refuse(INPUT_MESSAGES.wrongType);
  }

  return {
    ok: true,
    value: { name: 'pto_get', id, includeNote: includeNote === true },
  };
}

/* ------------------------------------------------------------------------- */
/* The redaction.                                                              */
/* ------------------------------------------------------------------------- */

/** A function that makes displayed text safe. */
export type Scrub = (value: string) => string;

/** Control, format, unpaired surrogate and line or paragraph separators. */
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

/** Any personal-token-shaped text, complete or truncated. */
const PTO_SHAPED = /pto_pat_[A-Za-z0-9._-]*/gi;

/** A digest or a secret component: any run of at least 64 hexadecimal digits. */
const DIGEST_SHAPED = /[0-9a-f]{64,}/gi;

/** Every run of whitespace, so a line break never becomes a second line. */
const WHITESPACE = /\s+/g;

/** A pattern that never matches, used when there is no known secret. */
const NEVER_MATCHES = '(?!)';

function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds the scrubber for the given exact secrets.
 *
 * Invisible and control characters are removed before matching, so a secret
 * split by them still matches. The known secrets are matched
 * case-insensitively, then the token shape and any digest-shaped run are
 * replaced.
 */
export function scrubberFor(secrets: readonly string[]): Scrub {
  const alternatives = secrets.map(escapeForPattern).join('|') || NEVER_MATCHES;
  const known = new RegExp(alternatives, 'gi');
  return (value) =>
    value
      .normalize('NFC')
      .replace(UNSAFE_CHARACTERS, '')
      .replace(known, REDACTED)
      .replace(PTO_SHAPED, REDACTED)
      .replace(DIGEST_SHAPED, REDACTED)
      .replace(WHITESPACE, ' ')
      .trim();
}

/**
 * Builds the scrubber for one resolved credential.
 *
 * The exact token, its secret component (the last 64 characters of a validated
 * token) and the SHA-256 digest of that secret are all removed. The digest
 * uses the same algorithm as the token domain: SHA-256 of the UTF-8 secret.
 */
export function scrubberForCredential(token: string): Scrub {
  const secret = token.slice(-SECRET_LENGTH);
  const digest = createHash('sha256').update(secret, 'utf8').digest('hex');
  return scrubberFor([token, secret, digest]);
}

/** The scrubber for text that never met a credential. */
export const PLAIN_SCRUB: Scrub = scrubberFor([]);

/* ------------------------------------------------------------------------- */
/* The projection.                                                             */
/* ------------------------------------------------------------------------- */

/** The shape a list row and a detail share. */
export interface RecordSource {
  readonly id: string;
  readonly user: { readonly id: string; readonly name: string };
  readonly startDate: string;
  readonly endDate: string;
  readonly dayPart: PtoDayPart;
  readonly note: string | null;
  readonly version: number;
}

/** Shortens a text to a bound without splitting a character in half. */
function bound(value: string, maximum: number): string {
  const points = Array.from(value);
  if (points.length <= maximum) return value;
  return points.slice(0, maximum).join('');
}

/**
 * Projects one record of the API into the record the protocol carries.
 *
 * Only the allowlisted fields are copied: the colour of the owner and every
 * other field of the answer stay behind. The note is carried only when it was
 * asked for explicitly and the service returned one; a list row never carries
 * one, whatever the service answered.
 */
export function projectRecord(
  source: RecordSource,
  scrub: Scrub,
  includeNote: boolean,
): ToolRecord {
  return {
    id: source.id,
    owner: {
      id: source.user.id,
      name: bound(scrub(source.user.name), MAX_OWNER_NAME_LENGTH),
    },
    startDate: source.startDate,
    endDate: source.endDate,
    dayPart: source.dayPart,
    note: includeNote && source.note !== null ? bound(scrub(source.note), MAX_NOTE_LENGTH) : null,
    version: source.version,
  };
}

/**
 * Projects the rows of a bounded read into the list the protocol carries.
 *
 * The rows are capped again on the way out, so a service that answered with
 * more rows than the bound allows can never grow the answer past it.
 */
export function projectList(
  items: readonly RecordSource[],
  complete: boolean,
  reason: ListAllReason,
  pages: number,
  scrub: Scrub,
): ReadToolList {
  const truncated = items.length > LIST_RECORD_LIMIT;
  return {
    items: items.slice(0, LIST_RECORD_LIMIT).map((item) => projectRecord(item, scrub, false)),
    complete: complete && !truncated,
    reason: complete && truncated ? 'budget' : reason,
    pages,
  };
}

/**
 * The request identifier the adapter generates for itself.
 *
 * A candidate that is not a canonical identifier is replaced: the envelope
 * always carries an identifier that matches the advertised schema.
 */
export function adapterRequestId(candidate: string): string {
  return REQUEST_ID_SHAPE.test(candidate) ? candidate : randomRequestId();
}

/** The identifier of one request, generated by the runtime. */
export function randomRequestId(): string {
  return randomUUID();
}
