/**
 * The advertised schemas and the runtime validation of the mutation tools.
 *
 * This module is pure: it never opens a store, never sends a request and never
 * sees a credential. It owns two things:
 *
 * - the strict JSON Schema of every mutation input and output. Every object is
 *   closed, the mode is a discriminated pair, a `previewId` is admitted only on
 *   `apply`, and the update `changes` object is closed and nonempty;
 * - the runtime validation that mirrors the schemas. An unknown key, an
 *   accessor, an out-of-range date, a weekend endpoint, a malformed key, a
 *   non-canonical identifier or an empty change set is refused before any
 *   credential or network access, and every refusal is a fixed sentence that
 *   never echoes the supplied value.
 *
 * The date and day-part rules mirror the backend for the values a caller
 * supplies: every supplied endpoint must be a real weekday, a single-day entry
 * keeps the requested day part, and a longer range is stored as `all_day`. For
 * an update, the complete merged range is validated with the same real,
 * ordered, weekday rules before a preview or an apply continues. The preview
 * shows the effective value, so the normalization is never silent; the service
 * remains the final authority for its own overlapping-range and audit rules.
 */

import type { PtoDayPart } from '@pto-calendar/api-client';

import { MCP_SCHEMA_VERSION } from './contract.js';
import {
  MAX_NOTE_LENGTH,
  type InputResult,
  type SchemaNode,
  type ToolInputSchema,
  type ToolOutputSchema,
} from './schema.js';
import {
  CHANGED_FIELDS,
  WRITE_DAY_PARTS,
  WRITE_ERROR_CODES,
  WRITE_MODES,
  WRITE_RECOVERIES,
  type CreateArguments,
  type DeleteArguments,
  type NoteIntent,
  type UpdateArguments,
  type UpdateChanges,
  type WriteArguments,
  type WriteMode,
  type WriteToolName,
} from './write-contract.js';

/** One strict input schema of a mutation. `allOf` carries the mode condition. */
export type WriteInputSchema = ToolInputSchema & { readonly allOf?: readonly SchemaNode[] };

/** A structural failure can still be recognized as an attempted apply. */
type WriteInputFailure = Extract<InputResult<never>, { ok: false }> & {
  readonly attemptedApply?: true;
};
type WriteInputResult<T> = Extract<InputResult<T>, { ok: true }> | WriteInputFailure;

/** The highest record version the API accepts, a positive int32. */
const MAX_VERSION = 2_147_483_647;

/** The JSON Schema source of the UUID shape. */
const UUID_SOURCE = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const UUID_SHAPE = new RegExp(UUID_SOURCE);

/** The JSON Schema source of the calendar-day shape. */
const DAY_SOURCE = '^\\d{4}-\\d{2}-\\d{2}$';
const DAY_SHAPE = new RegExp(DAY_SOURCE);

/** The canonical create key: `v1.<13-digit UTC milliseconds>.<lowercase UUIDv4>`. */
const KEY_SOURCE =
  '^v1\\.[0-9]{13}\\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const KEY_SHAPE = new RegExp(KEY_SOURCE);

/** The JSON Schema source of the adapter request identifier. */
const REQUEST_ID_SOURCE = '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

/** The shape of the preview expiry, an absolute UTC instant. */
const EXPIRES_AT_SOURCE = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$';

/** An unpaired surrogate, which UTF-8 cannot represent without changing the value. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The fixed messages of the argument validation. None echoes its input. */
export const WRITE_INPUT_MESSAGES = {
  notAnObject: 'The tool arguments must be a JSON object.',
  unknownField: 'The tool arguments contain a field this tool does not accept.',
  missingField: 'A required argument is missing.',
  wrongType: 'An argument has a type this tool does not accept.',
  invalidMode: 'Use mode preview for a read-only proposal, or mode apply with its previewId.',
  invalidDate: 'Use real calendar dates in YYYY-MM-DD form.',
  invalidRange: 'The end date must not be before the start date.',
  weekend: 'Dates must fall on weekdays. This tool never moves a date to a weekday.',
  invalidDayPart: 'Use dayPart morning, evening or all_day.',
  invalidNote: 'A note must be well-formed text.',
  noteLength: 'A note may be at most 500 characters.',
  invalidKey:
    'Use a canonical idempotency key of the form v1.<13-digit UTC milliseconds>.<lowercase UUIDv4>.',
  invalidUuid: 'Use the canonical UUID of one PTO entry or preview.',
  invalidVersion: 'Use expectedVersion with a whole number from 1 to 2147483647.',
  previewIdNotAllowed: 'previewId is admitted only on apply.',
  previewIdRequired: 'An apply call needs the previewId of the preview it applies.',
  emptyChanges: 'Name at least one of startDate, endDate, dayPart or note in changes.',
  storedDayPart: 'The stored day part does not fit the requested range. Send an explicit dayPart.',
  noChange: 'The update does not change any field of the entry.',
  unknownTool: 'The requested tool is not one of the documented mutation tools.',
} as const;

/** The keys each mutation accepts. Nothing else is ever read. */
const CREATE_KEYS: readonly string[] = [
  'mode',
  'startDate',
  'endDate',
  'dayPart',
  'note',
  'idempotencyKey',
  'previewId',
];
const UPDATE_KEYS: readonly string[] = ['mode', 'id', 'expectedVersion', 'changes', 'previewId'];
const DELETE_KEYS: readonly string[] = ['mode', 'id', 'expectedVersion', 'previewId'];
const CHANGE_KEYS: readonly string[] = ['startDate', 'endDate', 'dayPart', 'note'];

/* ------------------------------------------------------------------------- */
/* The advertised schemas.                                                     */
/* ------------------------------------------------------------------------- */

/** The mode discriminator every mutation carries. */
const MODE_SCHEMA: SchemaNode = {
  type: 'string',
  enum: [...WRITE_MODES],
  description:
    'preview performs a read-only proposal. apply performs the one mutation after the host showed that exact preview and the user approved it.',
};

/** The opaque preview reference. It is admitted only on apply. */
const PREVIEW_ID_SCHEMA: SchemaNode = {
  type: 'string',
  pattern: UUID_SOURCE,
  description:
    'The opaque previewId returned by the preview of these exact arguments. It is not evidence of user approval and is never sent to the API.',
};

/** One exact inclusive calendar day. */
const DATE_SCHEMA: SchemaNode = {
  type: 'string',
  pattern: DAY_SOURCE,
  description: 'A real calendar day in YYYY-MM-DD form.',
};

/** The half-day vocabulary of the service. */
const DAY_PART_SCHEMA: SchemaNode = {
  type: 'string',
  enum: [...WRITE_DAY_PARTS],
  description: 'The requested day part: morning, evening or all_day.',
};

/** The create note. An empty note is the same as no note. */
const NOTE_SCHEMA: SchemaNode = {
  type: 'string',
  maxLength: MAX_NOTE_LENGTH,
  description:
    'An optional private note. It is never returned by a tool result. An empty note stores none.',
};

/** The update note. Null and the empty string clear the stored note. */
const CHANGE_NOTE_SCHEMA: SchemaNode = {
  type: ['string', 'null'],
  maxLength: MAX_NOTE_LENGTH,
  description:
    'Replace the note with text, or clear it with null or the empty string. Omit the field to preserve the stored note, including one this credential cannot read.',
};

/**
 * The mode condition of every mutation.
 *
 * `previewId` is refused on `preview` and required on `apply`, so the two
 * phases are discriminated before any runtime check.
 */
function modeConditions(): readonly SchemaNode[] {
  return [
    {
      if: { properties: { mode: { const: 'preview' } }, required: ['mode'] },
      then: { not: { required: ['previewId'] } },
    },
    {
      if: { properties: { mode: { const: 'apply' } }, required: ['mode'] },
      then: { required: ['previewId'] },
    },
  ];
}

/** The strict input schema of the create tool. */
export const CREATE_INPUT_SCHEMA: WriteInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'startDate', 'endDate', 'dayPart', 'idempotencyKey'],
  properties: {
    mode: MODE_SCHEMA,
    startDate: DATE_SCHEMA,
    endDate: DATE_SCHEMA,
    dayPart: DAY_PART_SCHEMA,
    note: NOTE_SCHEMA,
    idempotencyKey: {
      type: 'string',
      pattern: KEY_SOURCE,
      description:
        'One canonical create key for one intent: v1.<13-digit UTC milliseconds>.<lowercase UUIDv4>. Reuse the exact same key only for the same payload and credential when resuming a lost create.',
    },
    previewId: PREVIEW_ID_SCHEMA,
  },
  allOf: modeConditions(),
};

/** The closed changes object of the update tool. */
const CHANGES_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    startDate: DATE_SCHEMA,
    endDate: DATE_SCHEMA,
    dayPart: DAY_PART_SCHEMA,
    note: CHANGE_NOTE_SCHEMA,
  },
};

/** The strict input schema of the update tool. */
export const UPDATE_INPUT_SCHEMA: WriteInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'id', 'expectedVersion', 'changes'],
  properties: {
    mode: MODE_SCHEMA,
    id: {
      type: 'string',
      pattern: UUID_SOURCE,
      description: 'The exact identifier of one PTO entry.',
    },
    expectedVersion: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_VERSION,
      description:
        'The exact version the preview read. It is sent as the conditional precondition.',
    },
    changes: CHANGES_SCHEMA,
    previewId: PREVIEW_ID_SCHEMA,
  },
  allOf: modeConditions(),
};

/** The strict input schema of the delete tool. */
export const DELETE_INPUT_SCHEMA: WriteInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'id', 'expectedVersion'],
  properties: {
    mode: MODE_SCHEMA,
    id: {
      type: 'string',
      pattern: UUID_SOURCE,
      description: 'The exact identifier of one PTO entry.',
    },
    expectedVersion: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_VERSION,
      description:
        'The exact version the preview read. It is sent as the conditional precondition.',
    },
    previewId: PREVIEW_ID_SCHEMA,
  },
  allOf: modeConditions(),
};

/** The exact target of an update or a delete. */
const TARGET_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version'],
  properties: {
    id: { type: 'string', pattern: UUID_SOURCE },
    version: { type: 'integer', minimum: 1, maximum: MAX_VERSION },
  },
};

/** One effective range. */
const EFFECTIVE_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['startDate', 'endDate', 'dayPart'],
  properties: {
    startDate: { type: 'string', pattern: DAY_SOURCE },
    endDate: { type: 'string', pattern: DAY_SOURCE },
    dayPart: { type: 'string', enum: [...WRITE_DAY_PARTS] },
  },
};

/** One safe record of a mutation answer. */
const APPLIED_RECORD_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'ownerId', 'version', 'startDate', 'endDate', 'dayPart'],
  properties: {
    id: { type: 'string', pattern: UUID_SOURCE },
    ownerId: { type: 'string', pattern: UUID_SOURCE },
    version: { type: 'integer', minimum: 1, maximum: MAX_VERSION },
    startDate: { type: 'string', pattern: DAY_SOURCE },
    endDate: { type: 'string', pattern: DAY_SOURCE },
    dayPart: { type: 'string', enum: [...WRITE_DAY_PARTS] },
  },
};

/** The fields that describe one side of a change. */
const CHANGED_FIELDS_SCHEMA: SchemaNode = {
  type: 'array',
  maxItems: CHANGED_FIELDS.length,
  uniqueItems: true,
  items: { type: 'string', enum: [...CHANGED_FIELDS] },
};

/**
 * The common fields of one preview.
 *
 * The preview names the actor, the owner, the target and the effective change,
 * and never a note, a key, a token identifier or a display name.
 */
const PREVIEW_FIELDS: Record<string, SchemaNode> = {
  phase: { const: 'preview' },
  previewId: { type: 'string', pattern: UUID_SOURCE },
  actorId: { type: 'string', pattern: UUID_SOURCE },
  ownerId: { type: 'string', pattern: UUID_SOURCE },
  expiresAt: { type: 'string', pattern: EXPIRES_AT_SOURCE },
  changedFields: CHANGED_FIELDS_SCHEMA,
};

/** One preview branch of one mutation. */
function previewSchema(
  operation: 'create' | 'update' | 'delete',
  target: SchemaNode,
  before: SchemaNode,
  after: SchemaNode,
  noteIntent: readonly NoteIntent[],
): SchemaNode {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'phase',
      'operation',
      'previewId',
      'actorId',
      'ownerId',
      'expiresAt',
      'target',
      'before',
      'after',
      'changedFields',
      'noteIntent',
    ],
    properties: {
      ...PREVIEW_FIELDS,
      operation: { const: operation },
      target,
      before,
      after,
      noteIntent: { type: 'string', enum: [...noteIntent] },
    },
  };
}

/** The one success branch of an applied create. */
const CREATE_APPLY_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['phase', 'operation', 'record', 'replayed', 'expiresAt'],
  properties: {
    phase: { const: 'apply' },
    operation: { const: 'create' },
    record: APPLIED_RECORD_SCHEMA,
    replayed: { type: 'boolean' },
    expiresAt: { type: 'string', pattern: EXPIRES_AT_SOURCE },
  },
};

/** The one success branch of an applied update. */
const UPDATE_APPLY_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['phase', 'operation', 'record', 'noteIntent'],
  properties: {
    phase: { const: 'apply' },
    operation: { const: 'update' },
    record: APPLIED_RECORD_SCHEMA,
    noteIntent: { type: 'string', enum: ['keep', 'set', 'clear'] },
  },
};

/** The one success branch of an applied delete. */
const DELETE_APPLY_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['phase', 'operation', 'deleted'],
  properties: {
    phase: { const: 'apply' },
    operation: { const: 'delete' },
    deleted: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'ownerId', 'version'],
      properties: {
        id: { type: 'string', pattern: UUID_SOURCE },
        ownerId: { type: 'string', pattern: UUID_SOURCE },
        version: { type: 'integer', minimum: 1, maximum: MAX_VERSION },
      },
    },
  },
};

/** The closed failure of one mutation. */
const WRITE_ERROR_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'message', 'status', 'upstreamRequestId', 'retryAfterMs', 'recovery'],
  properties: {
    code: { type: 'string', enum: [...WRITE_ERROR_CODES] },
    message: { type: 'string', minLength: 1, maxLength: 600 },
    status: { type: ['integer', 'null'], minimum: 100, maximum: 599 },
    upstreamRequestId: { type: ['string', 'null'], maxLength: 200 },
    retryAfterMs: { type: ['integer', 'null'], minimum: 0 },
    recovery: { type: 'string', enum: [...WRITE_RECOVERIES] },
  },
};

/** The closed envelope of one mutation call. */
function writeEnvelopeSchema(
  tool: WriteToolName,
  success: readonly SchemaNode[],
): ToolOutputSchema {
  const common = {
    schemaVersion: { const: MCP_SCHEMA_VERSION },
    requestId: { type: 'string', pattern: REQUEST_ID_SOURCE },
  };
  return {
    type: 'object',
    oneOf: [
      ...success.map((data) => ({
        type: 'object',
        additionalProperties: false,
        required: ['schemaVersion', 'requestId', 'ok', 'tool', 'data'],
        properties: {
          ...common,
          ok: { const: true },
          tool: { const: tool },
          data,
        },
      })),
      {
        type: 'object',
        additionalProperties: false,
        required: ['schemaVersion', 'requestId', 'ok', 'tool', 'error'],
        properties: {
          ...common,
          ok: { const: false },
          tool: { const: tool },
          error: WRITE_ERROR_SCHEMA,
        },
      },
    ],
  };
}

const NULL_SCHEMA: SchemaNode = { type: 'null' };

/** The closed output schema of the create tool. */
export const CREATE_OUTPUT_SCHEMA: ToolOutputSchema = writeEnvelopeSchema('pto_create', [
  previewSchema('create', NULL_SCHEMA, NULL_SCHEMA, EFFECTIVE_SCHEMA, ['none', 'set']),
  CREATE_APPLY_SCHEMA,
]);

/** The closed output schema of the update tool. */
export const UPDATE_OUTPUT_SCHEMA: ToolOutputSchema = writeEnvelopeSchema('pto_update', [
  previewSchema('update', TARGET_SCHEMA, EFFECTIVE_SCHEMA, EFFECTIVE_SCHEMA, [
    'keep',
    'set',
    'clear',
  ]),
  UPDATE_APPLY_SCHEMA,
]);

/** The closed output schema of the delete tool. */
export const DELETE_OUTPUT_SCHEMA: ToolOutputSchema = writeEnvelopeSchema('pto_delete', [
  previewSchema('delete', TARGET_SCHEMA, EFFECTIVE_SCHEMA, NULL_SCHEMA, ['none']),
  DELETE_APPLY_SCHEMA,
]);

/* ------------------------------------------------------------------------- */
/* The runtime validation.                                                     */
/* ------------------------------------------------------------------------- */

/** A property that was present but not a readable value. */
const UNUSABLE = Symbol('unusable');

/** Reads one own property without ever calling an accessor. */
function ownValue(descriptors: PropertyDescriptorMap, key: string): unknown | undefined {
  const descriptor = descriptors[key];
  if (descriptor === undefined) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) return UNUSABLE;
  return descriptor.value;
}

/** Whether the value is a plain object with no inherited behaviour. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A refusal with a fixed message. */
function refuse<T>(message: string): InputResult<T> {
  return { ok: false, code: 'INPUT', message };
}

/** Refuses a key the tool does not accept, before any value is read. */
function refuseUnknownKey<T>(
  descriptors: PropertyDescriptorMap,
  allowed: readonly string[],
): InputResult<T> | null {
  for (const key of Object.keys(descriptors)) {
    if (!allowed.includes(key)) return refuse(WRITE_INPUT_MESSAGES.unknownField);
  }
  return null;
}

/** Whether the value is a real calendar day in the documented form. */
function isRealDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY_SHAPE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

/** Whether the day is a Saturday or a Sunday, read in UTC as the service does. */
function isWeekend(day: string): boolean {
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
}

/** A real weekday, or a fixed refusal. */
function requireDay(value: unknown): InputResult<string> {
  if (!isRealDay(value)) return refuse(WRITE_INPUT_MESSAGES.invalidDate);
  if (isWeekend(value)) return refuse(WRITE_INPUT_MESSAGES.weekend);
  return { ok: true, value };
}

/** An ordered weekday range, or a fixed refusal. */
export function validateEffectiveRange(startDate: string, endDate: string): InputResult<null> {
  if (!isRealDay(startDate) || !isRealDay(endDate)) {
    return refuse(WRITE_INPUT_MESSAGES.invalidDate);
  }
  if (endDate < startDate) return refuse(WRITE_INPUT_MESSAGES.invalidRange);
  if (isWeekend(startDate) || isWeekend(endDate)) {
    return refuse(WRITE_INPUT_MESSAGES.weekend);
  }
  return { ok: true, value: null };
}

/** One half-day value, or a fixed refusal. */
function requireDayPart(value: unknown): InputResult<PtoDayPart> {
  if (typeof value !== 'string' || !(WRITE_DAY_PARTS as readonly string[]).includes(value)) {
    return refuse(WRITE_INPUT_MESSAGES.invalidDayPart);
  }
  return { ok: true, value: value as PtoDayPart };
}

/** Whether the text carries no unpaired surrogate. */
function isWellFormed(value: string): boolean {
  return !LONE_SURROGATE.test(value);
}

/** A note as text with the length and well-formedness bounds. */
function requireText(value: unknown): InputResult<string> {
  if (typeof value !== 'string' || !isWellFormed(value)) {
    return refuse(WRITE_INPUT_MESSAGES.invalidNote);
  }
  if (value.length > MAX_NOTE_LENGTH) return refuse(WRITE_INPUT_MESSAGES.noteLength);
  return { ok: true, value };
}

/**
 * A note change: `null` and the empty string clear the note, any other text
 * replaces it. An omitted member is not represented at all.
 */
function requireChangeNote(value: unknown): InputResult<string | null> {
  if (value === null) return { ok: true, value: null };
  const text = requireText(value);
  if (!text.ok) return text;
  return { ok: true, value: text.value === '' ? null : text.value };
}

/** A canonical UUID, returned in lowercase. */
function requireUuid(value: unknown): InputResult<string> {
  if (typeof value !== 'string' || !UUID_SHAPE.test(value)) {
    return refuse(WRITE_INPUT_MESSAGES.invalidUuid);
  }
  return { ok: true, value: value.toLowerCase() };
}

/** A positive int32 version, never a coerced number. */
function requireVersion(value: unknown): InputResult<number> {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_VERSION
  ) {
    return refuse(WRITE_INPUT_MESSAGES.invalidVersion);
  }
  return { ok: true, value };
}

/** The mode discriminator and its preview reference. */
function requireMode(
  descriptors: PropertyDescriptorMap,
): InputResult<{ readonly mode: WriteMode; readonly previewId?: string }> {
  const rawMode = ownValue(descriptors, 'mode');
  if (rawMode === undefined) return refuse(WRITE_INPUT_MESSAGES.missingField);
  if (rawMode === UNUSABLE || typeof rawMode !== 'string') {
    return refuse(WRITE_INPUT_MESSAGES.wrongType);
  }
  if (!(WRITE_MODES as readonly string[]).includes(rawMode)) {
    return refuse(WRITE_INPUT_MESSAGES.invalidMode);
  }
  const mode = rawMode as WriteMode;
  const rawPreview = ownValue(descriptors, 'previewId');
  if (rawPreview === undefined) {
    if (mode === 'apply') return refuse(WRITE_INPUT_MESSAGES.previewIdRequired);
    return { ok: true, value: { mode } };
  }
  if (mode === 'preview') return refuse(WRITE_INPUT_MESSAGES.previewIdNotAllowed);
  if (rawPreview === UNUSABLE) return refuse(WRITE_INPUT_MESSAGES.wrongType);
  const previewId = requireUuid(rawPreview);
  if (!previewId.ok) return previewId;
  return { ok: true, value: { mode, previewId: previewId.value } };
}

/** The shared first step: a plain object with only accepted keys. */
function begin(input: unknown, allowed: readonly string[]): InputResult<PropertyDescriptorMap> {
  if (!isPlainObject(input)) return refuse(WRITE_INPUT_MESSAGES.notAnObject);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const unknown = refuseUnknownKey<PropertyDescriptorMap>(descriptors, allowed);
  if (unknown !== null) return unknown;
  return { ok: true, value: descriptors };
}

/** A required string property, or a fixed refusal. */
function requiredString(descriptors: PropertyDescriptorMap, key: string): InputResult<string> {
  const value = ownValue(descriptors, key);
  if (value === undefined) return refuse(WRITE_INPUT_MESSAGES.missingField);
  if (value === UNUSABLE || typeof value !== 'string') {
    return refuse(WRITE_INPUT_MESSAGES.wrongType);
  }
  return { ok: true, value };
}

/** The closed, nonempty changes object of an update. */
function requireChanges(value: unknown): InputResult<UpdateChanges> {
  if (!isPlainObject(value)) return refuse(WRITE_INPUT_MESSAGES.wrongType);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const unknown = refuseUnknownKey<UpdateChanges>(descriptors, CHANGE_KEYS);
  if (unknown !== null) return unknown;
  if (Object.keys(descriptors).length === 0) return refuse(WRITE_INPUT_MESSAGES.emptyChanges);
  // A present member with no value is not an omitted member: it is refused,
  // so a caller can never smuggle an unusable field past the closed schema.
  for (const descriptor of Object.values(descriptors)) {
    if (Object.hasOwn(descriptor, 'value') && descriptor.value === undefined) {
      return refuse(WRITE_INPUT_MESSAGES.wrongType);
    }
  }

  const changes: {
    startDate?: string;
    endDate?: string;
    dayPart?: PtoDayPart;
    note?: string | null;
  } = {};
  const startDate = ownValue(descriptors, 'startDate');
  if (startDate !== undefined) {
    if (startDate === UNUSABLE) return refuse(WRITE_INPUT_MESSAGES.wrongType);
    const parsed = requireDay(startDate);
    if (!parsed.ok) return parsed;
    changes.startDate = parsed.value;
  }
  const endDate = ownValue(descriptors, 'endDate');
  if (endDate !== undefined) {
    if (endDate === UNUSABLE) return refuse(WRITE_INPUT_MESSAGES.wrongType);
    const parsed = requireDay(endDate);
    if (!parsed.ok) return parsed;
    changes.endDate = parsed.value;
  }
  const dayPart = ownValue(descriptors, 'dayPart');
  if (dayPart !== undefined) {
    if (dayPart === UNUSABLE) return refuse(WRITE_INPUT_MESSAGES.wrongType);
    const parsed = requireDayPart(dayPart);
    if (!parsed.ok) return parsed;
    changes.dayPart = parsed.value;
  }
  const note = ownValue(descriptors, 'note');
  if (note !== undefined) {
    if (note === UNUSABLE) return refuse(WRITE_INPUT_MESSAGES.wrongType);
    const parsed = requireChangeNote(note);
    if (!parsed.ok) return parsed;
    changes.note = parsed.value;
  }
  // A range whose two endpoints are supplied must be ordered. A single supplied
  // endpoint is validated against the live entry by the caller.
  if (changes.startDate !== undefined && changes.endDate !== undefined) {
    const range = validateEffectiveRange(changes.startDate, changes.endDate);
    if (!range.ok) return range;
  }
  return { ok: true, value: changes };
}

/** Validates the arguments of the create tool. */
export function validateCreateArguments(input: unknown): InputResult<CreateArguments> {
  const started = begin(input, CREATE_KEYS);
  if (!started.ok) return started;
  const descriptors = started.value;

  const mode = requireMode(descriptors);
  if (!mode.ok) return mode;

  const rawStart = requiredString(descriptors, 'startDate');
  if (!rawStart.ok) return rawStart;
  const rawEnd = requiredString(descriptors, 'endDate');
  if (!rawEnd.ok) return rawEnd;
  const startDate = requireDay(rawStart.value);
  if (!startDate.ok) return startDate;
  const endDate = requireDay(rawEnd.value);
  if (!endDate.ok) return endDate;
  const range = validateEffectiveRange(startDate.value, endDate.value);
  if (!range.ok) return range;

  const rawDayPart = ownValue(descriptors, 'dayPart');
  if (rawDayPart === undefined) return refuse(WRITE_INPUT_MESSAGES.missingField);
  if (rawDayPart === UNUSABLE) return refuse(WRITE_INPUT_MESSAGES.wrongType);
  const dayPart = requireDayPart(rawDayPart);
  if (!dayPart.ok) return dayPart;

  const rawNote = ownValue(descriptors, 'note');
  let note: string | undefined;
  if (rawNote !== undefined) {
    if (rawNote === UNUSABLE) return refuse(WRITE_INPUT_MESSAGES.wrongType);
    const parsed = requireText(rawNote);
    if (!parsed.ok) return parsed;
    // An empty create note stores none, exactly as the service and the CLI treat it.
    note = parsed.value === '' ? undefined : parsed.value;
  }

  const rawKey = requiredString(descriptors, 'idempotencyKey');
  if (!rawKey.ok) return rawKey;
  if (!KEY_SHAPE.test(rawKey.value)) return refuse(WRITE_INPUT_MESSAGES.invalidKey);

  return {
    ok: true,
    value: {
      name: 'pto_create',
      mode: mode.value.mode,
      startDate: startDate.value,
      endDate: endDate.value,
      dayPart: dayPart.value,
      ...(note === undefined ? {} : { note }),
      idempotencyKey: rawKey.value,
      ...(mode.value.previewId === undefined ? {} : { previewId: mode.value.previewId }),
    },
  };
}

/** Validates the arguments of the update tool. */
export function validateUpdateArguments(input: unknown): InputResult<UpdateArguments> {
  const started = begin(input, UPDATE_KEYS);
  if (!started.ok) return started;
  const descriptors = started.value;

  const mode = requireMode(descriptors);
  if (!mode.ok) return mode;

  const rawId = requiredString(descriptors, 'id');
  if (!rawId.ok) return rawId;
  const id = requireUuid(rawId.value);
  if (!id.ok) return id;

  const rawVersion = ownValue(descriptors, 'expectedVersion');
  if (rawVersion === undefined) return refuse(WRITE_INPUT_MESSAGES.missingField);
  if (rawVersion === UNUSABLE) return refuse(WRITE_INPUT_MESSAGES.wrongType);
  const expectedVersion = requireVersion(rawVersion);
  if (!expectedVersion.ok) return expectedVersion;

  const rawChanges = ownValue(descriptors, 'changes');
  if (rawChanges === undefined) return refuse(WRITE_INPUT_MESSAGES.missingField);
  if (rawChanges === UNUSABLE) return refuse(WRITE_INPUT_MESSAGES.wrongType);
  const changes = requireChanges(rawChanges);
  if (!changes.ok) return changes;

  return {
    ok: true,
    value: {
      name: 'pto_update',
      mode: mode.value.mode,
      id: id.value,
      expectedVersion: expectedVersion.value,
      changes: changes.value,
      ...(mode.value.previewId === undefined ? {} : { previewId: mode.value.previewId }),
    },
  };
}

/** Validates the arguments of the delete tool. */
export function validateDeleteArguments(input: unknown): InputResult<DeleteArguments> {
  const started = begin(input, DELETE_KEYS);
  if (!started.ok) return started;
  const descriptors = started.value;

  const mode = requireMode(descriptors);
  if (!mode.ok) return mode;

  const rawId = requiredString(descriptors, 'id');
  if (!rawId.ok) return rawId;
  const id = requireUuid(rawId.value);
  if (!id.ok) return id;

  const rawVersion = ownValue(descriptors, 'expectedVersion');
  if (rawVersion === undefined) return refuse(WRITE_INPUT_MESSAGES.missingField);
  if (rawVersion === UNUSABLE) return refuse(WRITE_INPUT_MESSAGES.wrongType);
  const expectedVersion = requireVersion(rawVersion);
  if (!expectedVersion.ok) return expectedVersion;

  return {
    ok: true,
    value: {
      name: 'pto_delete',
      mode: mode.value.mode,
      id: id.value,
      expectedVersion: expectedVersion.value,
      ...(mode.value.previewId === undefined ? {} : { previewId: mode.value.previewId }),
    },
  };
}

/** Validates the arguments of one mutation tool. */
export function validateWriteArguments(
  name: WriteToolName,
  input: unknown,
): WriteInputResult<WriteArguments> {
  switch (name) {
    case 'pto_create':
      return classifyApplyRefusal(input, validateCreateArguments(input));
    case 'pto_update':
      return classifyApplyRefusal(input, validateUpdateArguments(input));
    case 'pto_delete':
      return classifyApplyRefusal(input, validateDeleteArguments(input));
  }
}

/**
 * A recognized apply can be a retry even when its preview reference or other
 * arguments are malformed. Mark its refusal without invoking an accessor,
 * changing validation precedence, or accessing credentials or preview state.
 */
function classifyApplyRefusal<T>(input: unknown, result: InputResult<T>): WriteInputResult<T> {
  if (result.ok || !isPlainObject(input)) return result;
  const mode = Object.getOwnPropertyDescriptor(input, 'mode');
  if (mode === undefined || !Object.hasOwn(mode, 'value') || mode.value !== 'apply') return result;
  return { ...result, attemptedApply: true };
}
