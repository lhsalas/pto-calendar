import { describe, expect, it } from 'vitest';

import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

import {
  CREATE_INPUT_SCHEMA,
  CREATE_OUTPUT_SCHEMA,
  DELETE_INPUT_SCHEMA,
  DELETE_OUTPUT_SCHEMA,
  UPDATE_INPUT_SCHEMA,
  UPDATE_OUTPUT_SCHEMA,
  WRITE_INPUT_MESSAGES,
  validateCreateArguments,
  validateDeleteArguments,
  validateEffectiveRange,
  validateUpdateArguments,
  validateWriteArguments,
  type WriteInputSchema,
} from '../src/write-schema.js';
import type { SchemaNode, ToolOutputSchema } from '../src/schema.js';
import type {
  CreateApplyData,
  CreatePreviewData,
  DeleteApplyData,
  DeletePreviewData,
  UpdateApplyData,
  UpdatePreviewData,
  WriteToolResult,
} from '../src/write-contract.js';

const KEY = 'v1.1700000000000.11111111-1111-4111-8111-111111111111';
const RECORD_ID = '44444444-4444-4444-8444-444444444444';
const PREVIEW_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '77777777-7777-4777-8777-777777777777';
const ACTOR = '55555555-5555-4555-8555-555555555555';

const CREATE = {
  mode: 'preview',
  startDate: '2026-12-07',
  endDate: '2026-12-09',
  dayPart: 'all_day',
  idempotencyKey: KEY,
};
const UPDATE = {
  mode: 'preview',
  id: RECORD_ID,
  expectedVersion: 3,
  changes: { dayPart: 'morning' },
};
const DELETE = { mode: 'preview', id: RECORD_ID, expectedVersion: 3 };

/** The keyword view of one schema node, without a cast at every use. */
function node(value: SchemaNode): Record<string, unknown> {
  return { ...value };
}

/** The properties of one node. */
function properties(value: SchemaNode): Record<string, Record<string, unknown>> {
  return node(value)['properties'] as Record<string, Record<string, unknown>>;
}

/** One branch of an output envelope. */
function branch(value: ToolOutputSchema, index: number): Record<string, unknown> {
  const branches = node(value)['oneOf'] as SchemaNode[];
  return node(branches[index]!);
}

/** Validates a value against a JSON Schema with the validator of the SDK. */
function validates(schema: unknown, value: unknown): boolean {
  const validator = new AjvJsonSchemaValidator();
  const compiled = validator.getValidator(schema as Parameters<typeof validator.getValidator>[0]);
  return compiled(value).valid;
}

/** Whether one schema carries the exact mode condition. */
function hasModeCondition(schema: WriteInputSchema): boolean {
  const conditions = schema.allOf ?? [];
  return (
    conditions.length === 2 &&
    JSON.stringify(conditions).includes('"preview"') &&
    JSON.stringify(conditions).includes('"apply"')
  );
}

describe('the advertised mutation input schemas', () => {
  it('are closed create schemas with the frozen required keys', () => {
    expect(CREATE_INPUT_SCHEMA.type).toBe('object');
    expect(CREATE_INPUT_SCHEMA.additionalProperties).toBe(false);
    expect(CREATE_INPUT_SCHEMA.required).toEqual([
      'mode',
      'startDate',
      'endDate',
      'dayPart',
      'idempotencyKey',
    ]);
    expect(Object.keys(CREATE_INPUT_SCHEMA.properties).sort()).toEqual([
      'dayPart',
      'endDate',
      'idempotencyKey',
      'mode',
      'note',
      'previewId',
      'startDate',
    ]);
    expect(properties(CREATE_INPUT_SCHEMA)['dayPart']?.['enum']).toEqual([
      'morning',
      'evening',
      'all_day',
    ]);
    expect(hasModeCondition(CREATE_INPUT_SCHEMA)).toBe(true);
  });

  it('are closed update schemas with a closed nonempty changes object', () => {
    expect(UPDATE_INPUT_SCHEMA.required).toEqual(['mode', 'id', 'expectedVersion', 'changes']);
    expect(Object.keys(UPDATE_INPUT_SCHEMA.properties).sort()).toEqual([
      'changes',
      'expectedVersion',
      'id',
      'mode',
      'previewId',
    ]);
    const changes = node(properties(UPDATE_INPUT_SCHEMA)['changes'] as SchemaNode);
    expect(changes['additionalProperties']).toBe(false);
    expect(changes['minProperties']).toBe(1);
    expect(Object.keys(changes['properties'] as object).sort()).toEqual([
      'dayPart',
      'endDate',
      'note',
      'startDate',
    ]);
    expect(hasModeCondition(UPDATE_INPUT_SCHEMA)).toBe(true);
  });

  it('are closed delete schemas without a changes object', () => {
    expect(DELETE_INPUT_SCHEMA.required).toEqual(['mode', 'id', 'expectedVersion']);
    expect(Object.keys(DELETE_INPUT_SCHEMA.properties).sort()).toEqual([
      'expectedVersion',
      'id',
      'mode',
      'previewId',
    ]);
    expect(hasModeCondition(DELETE_INPUT_SCHEMA)).toBe(true);
  });

  it('admit a previewId only on apply and refuse every extra key', () => {
    expect(validates(CREATE_INPUT_SCHEMA, CREATE)).toBe(true);
    expect(validates(CREATE_INPUT_SCHEMA, { ...CREATE, mode: 'apply' })).toBe(false);
    expect(
      validates(CREATE_INPUT_SCHEMA, { ...CREATE, mode: 'apply', previewId: PREVIEW_ID }),
    ).toBe(true);
    expect(validates(CREATE_INPUT_SCHEMA, { ...CREATE, previewId: PREVIEW_ID })).toBe(false);
    expect(validates(CREATE_INPUT_SCHEMA, { ...CREATE, confirmed: true })).toBe(false);
    expect(validates(CREATE_INPUT_SCHEMA, { ...CREATE, actAs: ACTOR })).toBe(false);
    expect(validates(UPDATE_INPUT_SCHEMA, UPDATE)).toBe(true);
    expect(
      validates(UPDATE_INPUT_SCHEMA, { ...UPDATE, mode: 'apply', previewId: PREVIEW_ID }),
    ).toBe(true);
    expect(validates(UPDATE_INPUT_SCHEMA, { ...UPDATE, mode: 'apply' })).toBe(false);
    expect(validates(DELETE_INPUT_SCHEMA, DELETE)).toBe(true);
    expect(validates(DELETE_INPUT_SCHEMA, { ...DELETE, role: 'admin' })).toBe(false);
  });
});

describe('the advertised mutation output schemas', () => {
  const createPreview: CreatePreviewData = {
    phase: 'preview',
    operation: 'create',
    previewId: PREVIEW_ID,
    actorId: ACTOR,
    ownerId: ACTOR,
    expiresAt: '2026-11-21T12:05:00.000Z',
    target: null,
    before: null,
    after: { startDate: '2026-12-07', endDate: '2026-12-09', dayPart: 'all_day' },
    changedFields: ['startDate', 'endDate', 'dayPart', 'note'],
    noteIntent: 'set',
  };
  const updatePreview: UpdatePreviewData = {
    ...createPreview,
    operation: 'update',
    target: { id: RECORD_ID, version: 3 },
    before: { startDate: '2026-12-07', endDate: '2026-12-07', dayPart: 'all_day' },
    changedFields: ['note'],
    noteIntent: 'clear',
  };
  const deletePreview: DeletePreviewData = {
    ...createPreview,
    operation: 'delete',
    target: { id: RECORD_ID, version: 3 },
    before: { startDate: '2026-12-07', endDate: '2026-12-07', dayPart: 'all_day' },
    after: null,
    changedFields: [],
    noteIntent: 'none',
  };
  const record = {
    id: RECORD_ID,
    ownerId: ACTOR,
    version: 4,
    startDate: '2026-12-07',
    endDate: '2026-12-09',
    dayPart: 'all_day' as const,
  };
  const createApply: CreateApplyData = {
    phase: 'apply',
    operation: 'create',
    record,
    replayed: true,
    expiresAt: '2026-11-22T00:00:00.000Z',
  };
  const updateApply: UpdateApplyData = {
    phase: 'apply',
    operation: 'update',
    record,
    noteIntent: 'keep',
  };
  const deleteApply: DeleteApplyData = {
    phase: 'apply',
    operation: 'delete',
    deleted: { id: RECORD_ID, ownerId: ACTOR, version: 3 },
  };

  function envelope(tool: string, data: unknown): WriteToolResult {
    return { schemaVersion: 1, requestId: REQUEST_ID, ok: true, tool, data } as WriteToolResult;
  }

  it('are closed envelopes with a distinct preview and apply branch', () => {
    for (const schema of [CREATE_OUTPUT_SCHEMA, UPDATE_OUTPUT_SCHEMA, DELETE_OUTPUT_SCHEMA]) {
      expect(node(schema)['type']).toBe('object');
      expect((node(schema)['oneOf'] as SchemaNode[]).length).toBe(3);
      expect(branch(schema, 0)['additionalProperties']).toBe(false);
      expect(branch(schema, 2)['additionalProperties']).toBe(false);
    }
    expect(JSON.stringify(branch(CREATE_OUTPUT_SCHEMA, 0))).toContain('"before"');
    expect(JSON.stringify(branch(CREATE_OUTPUT_SCHEMA, 1))).toContain('"replayed"');
    expect(JSON.stringify(branch(UPDATE_OUTPUT_SCHEMA, 1))).toContain('"noteIntent"');
    expect(JSON.stringify(branch(DELETE_OUTPUT_SCHEMA, 1))).toContain('"deleted"');
  });

  it('accept every documented success and failure and no extra field', () => {
    expect(validates(CREATE_OUTPUT_SCHEMA, envelope('pto_create', createPreview))).toBe(true);
    expect(validates(CREATE_OUTPUT_SCHEMA, envelope('pto_create', createApply))).toBe(true);
    expect(validates(UPDATE_OUTPUT_SCHEMA, envelope('pto_update', updatePreview))).toBe(true);
    expect(validates(UPDATE_OUTPUT_SCHEMA, envelope('pto_update', updateApply))).toBe(true);
    expect(validates(DELETE_OUTPUT_SCHEMA, envelope('pto_delete', deletePreview))).toBe(true);
    expect(validates(DELETE_OUTPUT_SCHEMA, envelope('pto_delete', deleteApply))).toBe(true);

    const failure: WriteToolResult = {
      schemaVersion: 1,
      requestId: REQUEST_ID,
      ok: false,
      tool: 'pto_create',
      error: {
        code: 'CONFLICT',
        message: 'The entry changed.',
        status: 409,
        upstreamRequestId: null,
        retryAfterMs: null,
        recovery: 'refresh-version',
      },
    };
    expect(validates(CREATE_OUTPUT_SCHEMA, failure)).toBe(true);
    expect(
      validates(CREATE_OUTPUT_SCHEMA, {
        ...envelope('pto_create', createPreview),
        data: { ...createPreview, note: 'private' },
      }),
    ).toBe(false);
    expect(
      validates(CREATE_OUTPUT_SCHEMA, {
        ...envelope('pto_create', createPreview),
        data: { ...createPreview, tokenId: ACTOR },
      }),
    ).toBe(false);
    expect(
      validates(CREATE_OUTPUT_SCHEMA, {
        ...failure,
        error: { ...failure.error, recovery: 'retry-everything' },
      }),
    ).toBe(false);
    expect(
      validates(CREATE_OUTPUT_SCHEMA, {
        ...failure,
        error: { ...failure.error, code: 'SOMETHING' },
      }),
    ).toBe(false);
  });
});

describe('the create argument validation', () => {
  it('accepts one exact create and keeps its canonical fields', () => {
    expect(validateCreateArguments(CREATE)).toEqual({
      ok: true,
      value: {
        name: 'pto_create',
        mode: 'preview',
        startDate: '2026-12-07',
        endDate: '2026-12-09',
        dayPart: 'all_day',
        idempotencyKey: KEY,
      },
    });
    expect(
      validateCreateArguments({ ...CREATE, startDate: '2026-12-07', endDate: '2026-12-07' }),
    ).toMatchObject({
      ok: true,
      value: { startDate: '2026-12-07', endDate: '2026-12-07' },
    });
  });

  it('normalises an empty note to no note and keeps nonempty text', () => {
    const empty = validateCreateArguments({ ...CREATE, note: '' });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(Object.hasOwn(empty.value, 'note')).toBe(false);
    expect(validateCreateArguments({ ...CREATE, note: 'Doctor' })).toMatchObject({
      ok: true,
      value: { note: 'Doctor' },
    });
  });

  it('refuses a non-object and an object with another prototype', () => {
    for (const value of [null, [], 'text', 3, undefined]) {
      expect(validateCreateArguments(value)).toEqual({
        ok: false,
        code: 'INPUT',
        message: WRITE_INPUT_MESSAGES.notAnObject,
      });
    }
    expect(validateCreateArguments(Object.create({ ...CREATE }))).toMatchObject({
      ok: false,
      message: WRITE_INPUT_MESSAGES.notAnObject,
    });
    expect(validateCreateArguments(Object.assign(Object.create(null), CREATE))).toMatchObject({
      ok: true,
    });
  });

  it('refuses an unknown, missing or accessor field before reading a value', () => {
    expect(validateCreateArguments({ ...CREATE, actAs: ACTOR })).toEqual({
      ok: false,
      code: 'INPUT',
      message: WRITE_INPUT_MESSAGES.unknownField,
    });
    expect(validateCreateArguments({ ...CREATE, mode: undefined })).toMatchObject({
      ok: false,
      message: WRITE_INPUT_MESSAGES.missingField,
    });
    const hostile = { ...CREATE };
    Object.defineProperty(hostile, 'mode', { enumerable: true, get: () => 'preview' });
    expect(validateCreateArguments(hostile)).toEqual({
      ok: false,
      code: 'INPUT',
      message: WRITE_INPUT_MESSAGES.wrongType,
    });
  });

  it('refuses every malformed date, range and day part', () => {
    expect(validateCreateArguments({ ...CREATE, startDate: '2026-02-30' })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.invalidDate,
    });
    expect(validateCreateArguments({ ...CREATE, startDate: '2026-13-01' })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.invalidDate,
    });
    expect(validateCreateArguments({ ...CREATE, endDate: undefined })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.missingField,
    });
    expect(validateCreateArguments({ ...CREATE, endDate: 3 })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.wrongType,
    });
    expect(validateCreateArguments({ ...CREATE, startDate: '2026-12-05' })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.weekend,
    });
    expect(validateCreateArguments({ ...CREATE, endDate: '2026-12-06' })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.weekend,
    });
    expect(
      validateCreateArguments({ ...CREATE, startDate: '2026-12-09', endDate: '2026-12-07' }),
    ).toMatchObject({ message: WRITE_INPUT_MESSAGES.invalidRange });
    expect(validateCreateArguments({ ...CREATE, startDate: 3 })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.wrongType,
    });
    expect(validateCreateArguments({ ...CREATE, endDate: 'soon' })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.invalidDate,
    });
    expect(validateCreateArguments({ ...CREATE, dayPart: 'AM' })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.invalidDayPart,
    });
    expect(validateCreateArguments({ ...CREATE, dayPart: 1 })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.invalidDayPart,
    });
    expect(validateCreateArguments({ ...CREATE, dayPart: undefined })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.missingField,
    });
    const hostile = { ...CREATE };
    Object.defineProperty(hostile, 'dayPart', { enumerable: true, get: () => 'all_day' });
    expect(validateCreateArguments(hostile)).toMatchObject({
      message: WRITE_INPUT_MESSAGES.wrongType,
    });
  });

  it('refuses every malformed note', () => {
    expect(validateCreateArguments({ ...CREATE, note: null })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.invalidNote,
    });
    expect(validateCreateArguments({ ...CREATE, note: 3 })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.invalidNote,
    });
    expect(validateCreateArguments({ ...CREATE, note: 'x'.repeat(501) })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.noteLength,
    });
    expect(validateCreateArguments({ ...CREATE, note: '\uD800' })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.invalidNote,
    });
    const hostile = { ...CREATE };
    Object.defineProperty(hostile, 'note', { enumerable: true, get: () => 'text' });
    expect(validateCreateArguments(hostile)).toMatchObject({
      message: WRITE_INPUT_MESSAGES.wrongType,
    });
  });

  it('refuses a missing, malformed or non-canonical create key', () => {
    expect(validateCreateArguments({ ...CREATE, idempotencyKey: undefined })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.missingField,
    });
    expect(validateCreateArguments({ ...CREATE, idempotencyKey: 3 })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.wrongType,
    });
    expect(validateCreateArguments({ ...CREATE, idempotencyKey: 'v1.123.x' })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.invalidKey,
    });
    expect(
      validateCreateArguments({
        ...CREATE,
        idempotencyKey: 'v1.1700000000000.11111111-1111-4111-8111-11111111111A',
      }),
    ).toMatchObject({ message: WRITE_INPUT_MESSAGES.invalidKey });
  });

  it('admits a previewId only on apply and requires it there', () => {
    expect(validateCreateArguments({ ...CREATE, previewId: PREVIEW_ID })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.previewIdNotAllowed,
    });
    expect(validateCreateArguments({ ...CREATE, mode: 'apply' })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.previewIdRequired,
    });
    expect(validateCreateArguments({ ...CREATE, mode: 'apply', previewId: 'x' })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.invalidUuid,
    });
    expect(validateCreateArguments({ ...CREATE, mode: 'apply', previewId: 3 })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.invalidUuid,
    });
    expect(
      validateCreateArguments({
        ...CREATE,
        mode: 'apply',
        previewId: PREVIEW_ID.toUpperCase(),
      }),
    ).toMatchObject({ ok: true, value: { previewId: PREVIEW_ID } });
    const hostile = { ...CREATE, mode: 'apply' };
    Object.defineProperty(hostile, 'previewId', { enumerable: true, get: () => PREVIEW_ID });
    expect(validateCreateArguments(hostile)).toMatchObject({
      message: WRITE_INPUT_MESSAGES.wrongType,
    });
    expect(validateCreateArguments({ ...CREATE, mode: 'other' })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.invalidMode,
    });
    expect(validateCreateArguments({ ...CREATE, mode: 3 })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.wrongType,
    });
  });
});

describe('the update argument validation', () => {
  it('accepts one exact update and normalises every note intent', () => {
    expect(validateUpdateArguments(UPDATE)).toEqual({
      ok: true,
      value: {
        name: 'pto_update',
        mode: 'preview',
        id: RECORD_ID,
        expectedVersion: 3,
        changes: { dayPart: 'morning' },
      },
    });
    expect(validateUpdateArguments({ ...UPDATE, changes: { note: null } })).toMatchObject({
      ok: true,
      value: { changes: { note: null } },
    });
    expect(validateUpdateArguments({ ...UPDATE, changes: { note: '' } })).toMatchObject({
      ok: true,
      value: { changes: { note: null } },
    });
    expect(validateUpdateArguments({ ...UPDATE, changes: { note: 'Doctor' } })).toMatchObject({
      ok: true,
      value: { changes: { note: 'Doctor' } },
    });
    expect(
      validateUpdateArguments({
        ...UPDATE,
        id: RECORD_ID.toUpperCase(),
        changes: { startDate: '2026-12-07', endDate: '2026-12-09', dayPart: 'all_day' },
      }),
    ).toMatchObject({ ok: true, value: { id: RECORD_ID } });
  });

  it('refuses a malformed target, version or change set', () => {
    expect(validateUpdateArguments({ ...UPDATE, changes: { endDate: undefined } })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.wrongType,
    });
    expect(validateUpdateArguments(null)).toMatchObject({
      message: WRITE_INPUT_MESSAGES.notAnObject,
    });
    expect(validateUpdateArguments({ ...UPDATE, id: undefined })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.missingField,
    });
    expect(validateUpdateArguments({ ...UPDATE, id: 3 })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.wrongType,
    });
    expect(validateUpdateArguments({ ...UPDATE, id: 'not-a-uuid' })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.invalidUuid,
    });
    expect(validateUpdateArguments({ ...UPDATE, expectedVersion: undefined })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.missingField,
    });
    expect(validateUpdateArguments({ ...UPDATE, expectedVersion: '3' })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.invalidVersion,
    });
    for (const expectedVersion of [0, 1.5, 2_147_483_648, Number.NaN]) {
      expect(validateUpdateArguments({ ...UPDATE, expectedVersion })).toMatchObject({
        message: WRITE_INPUT_MESSAGES.invalidVersion,
      });
    }
    const hostile = { ...UPDATE };
    Object.defineProperty(hostile, 'expectedVersion', { enumerable: true, get: () => 3 });
    expect(validateUpdateArguments(hostile)).toMatchObject({
      message: WRITE_INPUT_MESSAGES.wrongType,
    });
    expect(validateUpdateArguments({ ...UPDATE, changes: undefined })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.missingField,
    });
    expect(validateUpdateArguments({ ...UPDATE, changes: [] })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.wrongType,
    });
    const hostileChanges = { ...UPDATE };
    Object.defineProperty(hostileChanges, 'changes', {
      enumerable: true,
      get: () => ({ note: null }),
    });
    expect(validateUpdateArguments(hostileChanges)).toMatchObject({
      message: WRITE_INPUT_MESSAGES.wrongType,
    });
    expect(validateUpdateArguments({ ...UPDATE, changes: {} })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.emptyChanges,
    });
    expect(validateUpdateArguments({ ...UPDATE, changes: { extra: 1 } })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.unknownField,
    });
    expect(validateUpdateArguments({ ...UPDATE, changes: { dayPart: undefined } })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.wrongType,
    });
  });

  it('refuses every malformed member of a change set', () => {
    const cases: Array<[unknown, string]> = [
      [{ startDate: '2026-02-30' }, WRITE_INPUT_MESSAGES.invalidDate],
      [{ startDate: '2026-12-05' }, WRITE_INPUT_MESSAGES.weekend],
      [{ endDate: '2026-12-06' }, WRITE_INPUT_MESSAGES.weekend],
      [{ endDate: 3 }, WRITE_INPUT_MESSAGES.invalidDate],
      [{ dayPart: 'AM' }, WRITE_INPUT_MESSAGES.invalidDayPart],
      [{ dayPart: 3 }, WRITE_INPUT_MESSAGES.invalidDayPart],
      [{ note: 3 }, WRITE_INPUT_MESSAGES.invalidNote],
      [{ note: 'x'.repeat(501) }, WRITE_INPUT_MESSAGES.noteLength],
      [{ note: '\uDC00' }, WRITE_INPUT_MESSAGES.invalidNote],
      [{ startDate: '2026-12-09', endDate: '2026-12-07' }, WRITE_INPUT_MESSAGES.invalidRange],
    ];
    for (const [changes, message] of cases) {
      expect(validateUpdateArguments({ ...UPDATE, changes })).toMatchObject({ message });
    }
    for (const key of ['startDate', 'endDate', 'dayPart', 'note']) {
      const changes: Record<string, unknown> = { dayPart: 'morning' };
      Object.defineProperty(changes, key, { enumerable: true, get: () => 'x' });
      expect(validateUpdateArguments({ ...UPDATE, changes })).toMatchObject({
        message: WRITE_INPUT_MESSAGES.wrongType,
      });
    }
  });

  it('admits a previewId only on apply', () => {
    expect(validateUpdateArguments({ ...UPDATE, previewId: PREVIEW_ID })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.previewIdNotAllowed,
    });
    expect(validateUpdateArguments({ ...UPDATE, mode: 'apply' })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.previewIdRequired,
    });
    expect(
      validateUpdateArguments({ ...UPDATE, mode: 'apply', previewId: PREVIEW_ID }),
    ).toMatchObject({ ok: true, value: { mode: 'apply', previewId: PREVIEW_ID } });
  });
});

describe('the delete argument validation', () => {
  it('accepts one exact delete and its apply form', () => {
    expect(validateDeleteArguments(DELETE)).toEqual({
      ok: true,
      value: {
        name: 'pto_delete',
        mode: 'preview',
        id: RECORD_ID,
        expectedVersion: 3,
      },
    });
    expect(
      validateDeleteArguments({ ...DELETE, mode: 'apply', previewId: PREVIEW_ID }),
    ).toMatchObject({ ok: true, value: { mode: 'apply', previewId: PREVIEW_ID } });
  });

  it('refuses malformed fields and a misplaced preview reference', () => {
    expect(validateDeleteArguments(null)).toMatchObject({
      message: WRITE_INPUT_MESSAGES.notAnObject,
    });
    expect(validateDeleteArguments({ ...DELETE, id: undefined })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.missingField,
    });
    expect(validateDeleteArguments({ ...DELETE, id: 3 })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.wrongType,
    });
    expect(validateDeleteArguments({ ...DELETE, id: 'x' })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.invalidUuid,
    });
    expect(validateDeleteArguments({ ...DELETE, expectedVersion: undefined })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.missingField,
    });
    expect(validateDeleteArguments({ ...DELETE, expectedVersion: '3' })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.invalidVersion,
    });
    expect(validateDeleteArguments({ ...DELETE, expectedVersion: 0 })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.invalidVersion,
    });
    const hostile = { ...DELETE };
    Object.defineProperty(hostile, 'expectedVersion', { enumerable: true, get: () => 3 });
    expect(validateDeleteArguments(hostile)).toMatchObject({
      message: WRITE_INPUT_MESSAGES.wrongType,
    });
    expect(validateDeleteArguments({ ...DELETE, previewId: PREVIEW_ID })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.previewIdNotAllowed,
    });
    expect(validateDeleteArguments({ ...DELETE, mode: 'apply' })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.previewIdRequired,
    });
    expect(validateDeleteArguments({ ...DELETE, changes: {} })).toMatchObject({
      message: WRITE_INPUT_MESSAGES.unknownField,
    });
  });
});

describe('the shared validators', () => {
  it('dispatches every mutation and agrees on the common shapes', () => {
    expect(validateWriteArguments('pto_create', CREATE)).toMatchObject({ ok: true });
    expect(validateWriteArguments('pto_update', UPDATE)).toMatchObject({ ok: true });
    expect(validateWriteArguments('pto_delete', DELETE)).toMatchObject({ ok: true });
    expect(validateWriteArguments('pto_delete', CREATE)).toMatchObject({
      message: WRITE_INPUT_MESSAGES.unknownField,
    });
  });

  it('marks structurally recognizable apply refusals without reading accessors', () => {
    for (const input of [
      { ...CREATE, mode: 'apply' },
      { ...CREATE, mode: 'apply', previewId: 'not-a-preview' },
      { ...CREATE, mode: 'apply', previewId: null, extra: true },
    ]) {
      expect(validateWriteArguments('pto_create', input)).toMatchObject({
        ok: false,
        code: 'INPUT',
        attemptedApply: true,
      });
    }
    const hostile = Object.defineProperty({ ...CREATE }, 'mode', {
      enumerable: true,
      get() {
        throw new Error('The mode getter must not run.');
      },
    });
    for (const input of [
      null,
      {},
      hostile,
      { ...CREATE, mode: 'preview', previewId: PREVIEW_ID },
    ]) {
      const result = validateWriteArguments('pto_create', input);
      expect(result).toMatchObject({ ok: false, code: 'INPUT' });
      expect(result).not.toHaveProperty('attemptedApply');
    }
  });

  it('validates an effective range for real ordered weekdays', () => {
    expect(validateEffectiveRange('2026-12-07', '2026-12-09')).toEqual({
      ok: true,
      value: null,
    });
    expect(validateEffectiveRange('2026-02-30', '2026-12-09')).toMatchObject({
      message: WRITE_INPUT_MESSAGES.invalidDate,
    });
    expect(validateEffectiveRange('2026-12-09', '2026-12-07')).toMatchObject({
      message: WRITE_INPUT_MESSAGES.invalidRange,
    });
    expect(validateEffectiveRange('2026-12-05', '2026-12-09')).toMatchObject({
      message: WRITE_INPUT_MESSAGES.weekend,
    });
    expect(validateEffectiveRange('2026-12-11', '2026-12-13')).toMatchObject({
      message: WRITE_INPUT_MESSAGES.weekend,
    });
  });
});
