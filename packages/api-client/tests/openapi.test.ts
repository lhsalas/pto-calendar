import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  isV1CreateKey,
  MAX_CURSOR_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_PAGE_LIMIT,
  MAX_RANGE_DAYS,
  MAX_VERSION,
  PTO_DAY_PARTS,
  PTO_ROLES,
  PTO_SCOPES,
  requireIfMatch,
} from '../src/wire.js';

/**
 * The contract test against the maintained root OpenAPI document.
 *
 * The client encodes the wire shapes once. This test proves that the shapes
 * it encodes are the ones the API documents, so a change in the contract
 * cannot pass unnoticed.
 *
 * Every literal below is anchored to a value the client really has: the
 * document is compared with the runtime vocabulary and the runtime bounds of
 * the client, not with a copy of itself. `openapi-wire.test.ts` proves the
 * same contract in the other direction, with the requests the client really
 * sends and the answers it really reads.
 */

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const document = YAML.parse(readFileSync(join(repoRoot, 'docs', 'openapi.yaml'), 'utf8')) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: {
    schemas: Record<string, Record<string, unknown>>;
    parameters: Record<string, Record<string, unknown>>;
    responses: Record<string, Record<string, unknown>>;
  };
};

const schemas = document.components.schemas;
const paths = document.paths;

function operation(path: string, method: string): Record<string, unknown> {
  const found = paths[path]?.[method];
  expect(found, `${method.toUpperCase()} ${path} must be documented`).toBeDefined();
  return found!;
}

function responseCodes(path: string, method: string): string[] {
  const responses = operation(path, method)['responses'] as Record<string, unknown>;
  return Object.keys(responses).sort();
}

/**
 * The precondition the client would send for a version, or nothing when the
 * client refuses the version itself.
 */
function versionTheClientWouldSend(version: number): string | undefined {
  try {
    return requireIfMatch(version);
  } catch {
    return undefined;
  }
}

describe('the documented PTO schemas', () => {
  it('gives every mutation result a positive integer version', () => {
    const pto = schemas['PTO'] as { required: string[]; properties: Record<string, unknown> };
    expect(pto.required).toContain('version');
    expect(pto.properties['note']).toMatchObject({ nullable: true });
    const version = schemas['PTORecordVersion'] as {
      type: string;
      minimum: number;
      maximum: number;
    };
    expect(version.type).toBe('integer');
    expect(version.minimum).toBe(1);
    expect(version.maximum).toBe(2_147_483_647);
  });

  it('gives the detail and the paged row a version, and keeps the note rules', () => {
    const detail = schemas['PTODetail'] as { allOf: Array<{ required?: string[] }> };
    expect(detail.allOf[1]?.required).toEqual(['version']);

    const paged = schemas['PTOPagedListItem'] as {
      allOf: Array<{ required?: string[]; properties?: Record<string, unknown> }>;
    };
    expect(paged.allOf[1]?.required).toEqual(['note', 'version']);
    expect(paged.allOf[1]?.properties?.['note']).toMatchObject({ nullable: true, enum: [null] });
  });

  it('keeps the historical capped array free of a version', () => {
    const legacy = schemas['PTOListItem'] as {
      allOf: Array<{ required?: string[]; properties?: Record<string, unknown> }>;
    };
    expect(legacy.allOf[1]?.required).toEqual(['note']);
    expect(legacy.allOf[1]?.properties).not.toHaveProperty('version');
  });

  it('describes the paged envelope', () => {
    const page = schemas['PTOCalendarPage'] as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(page.required).toEqual(['items', 'nextCursor', 'hasMore']);
    expect(page.properties['items']).toMatchObject({
      type: 'array',
      maxItems: 200,
    });
  });

  it('describes the personal-token identity', () => {
    const identity = schemas['PersonalTokenIdentity'] as {
      required: string[];
      properties: Record<string, { required?: string[] }>;
    };
    expect(identity.required).toEqual(['id', 'role', 'auth']);
    expect(identity.properties['auth']?.required).toEqual([
      'method',
      'tokenId',
      'scopes',
      'expiresAt',
    ]);
  });
});

describe('the documented PTO operations', () => {
  it('documents the create with its replay header and its conflict answers', () => {
    const parameters = operation('/pto', 'post')['parameters'] as Array<Record<string, unknown>>;
    const key = parameters.find((parameter) => parameter['name'] === 'Idempotency-Key');
    expect(key).toBeDefined();
    expect(key?.['in']).toBe('header');
    expect(key?.['required']).toBe(false);
    expect(responseCodes('/pto', 'post')).toEqual(['201', '400', '401', '403', '409', '429']);
  });

  it('documents the precondition parameter the client sends', () => {
    const ifMatch = document.components.parameters['IfMatchVersion'] as {
      name: string;
      in: string;
      required: boolean;
      schema: { pattern: string };
    };
    expect(ifMatch.name).toBe('If-Match');
    expect(ifMatch.in).toBe('header');
    expect(ifMatch.required).toBe(true);
    expect(ifMatch.schema.pattern).toContain('"');
  });

  it('requires the precondition on every write of a record', () => {
    for (const method of ['put', 'patch', 'delete']) {
      const parameters = operation('/pto/{id}', method)['parameters'] as Array<
        Record<string, unknown>
      >;
      const ifMatch = parameters.find((parameter) => parameter['$ref'] !== undefined);
      expect(parameters.length, `${method} must name the precondition`).toBeGreaterThan(0);
      expect(
        parameters.some(
          (parameter) =>
            parameter['$ref'] === '#/components/parameters/IfMatchVersion' ||
            parameter['name'] === 'If-Match',
        ),
        `${method} must require the If-Match precondition`,
      ).toBe(true);
      expect(ifMatch).toBeDefined();
    }
  });

  it('answers a stale or missing precondition with its own status', () => {
    expect(responseCodes('/pto/{id}', 'put')).toContain('412');
    expect(responseCodes('/pto/{id}', 'put')).toContain('428');
    expect(responseCodes('/pto/{id}', 'patch')).toContain('412');
    expect(responseCodes('/pto/{id}', 'patch')).toContain('428');
    expect(responseCodes('/pto/{id}', 'delete')).toContain('412');
    expect(responseCodes('/pto/{id}', 'delete')).toContain('428');
  });

  it('answers a delete with an empty 204 and a patch with the record', () => {
    expect(responseCodes('/pto/{id}', 'delete')).toContain('204');
    expect(responseCodes('/pto/{id}', 'patch')).toContain('200');
    expect(responseCodes('/pto/{id}', 'patch')).toContain('409');
  });

  it('documents the error codes the client allows', () => {
    const error = schemas['ErrorResponse'] as {
      properties: { error: { properties: { code: { description: string } } } };
    };
    const description = error.properties.error.properties.code.description;
    expect(description).toContain('STALE_WRITE');
    expect(description).toContain('PRECONDITION_REQUIRED');
    expect(description).toContain('CONFLICT');
    expect(description).toContain('VALIDATION_ERROR');
  });
});

describe('the documented contract and the client that serves it', () => {
  it('documents exactly the vocabulary the client accepts', () => {
    const dayPart = schemas['DayPart'] as { enum: string[] };
    expect([...dayPart.enum].sort()).toEqual([...PTO_DAY_PARTS].sort());

    const role = schemas['Role'] as { enum: string[] };
    expect([...role.enum].sort()).toEqual([...PTO_ROLES].sort());

    const scope = schemas['PersonalTokenScope'] as { enum: string[] };
    expect([...scope.enum].sort()).toEqual([...PTO_SCOPES].sort());
  });

  it('documents exactly the bounds the client enforces', () => {
    const version = schemas['PTORecordVersion'] as { minimum: number; maximum: number };
    expect(version.minimum).toBe(1);
    expect(version.maximum).toBe(MAX_VERSION);

    const create = schemas['CreatePTORequest'] as {
      properties: { note: { maxLength: number } };
    };
    expect(create.properties.note.maxLength).toBe(MAX_NOTE_LENGTH);

    const patch = schemas['PatchPTORequest'] as {
      properties: { note: { maxLength: number; nullable: boolean } };
    };
    expect(patch.properties.note.maxLength).toBe(MAX_NOTE_LENGTH);
    // The partial update may clear the note; the create may not.
    expect(patch.properties.note.nullable).toBe(true);

    const page = schemas['PTOCalendarPage'] as {
      properties: { nextCursor: { minLength: number; maxLength: number } };
    };
    expect(page.properties.nextCursor.minLength).toBe(1);
    expect(page.properties.nextCursor.maxLength).toBe(MAX_CURSOR_LENGTH);

    const parameters = operation('/pto', 'get')['parameters'] as Array<Record<string, unknown>>;
    const limit = parameters.find((parameter) => parameter['name'] === 'limit');
    const limitSchema = limit?.['schema'] as { minimum: number; maximum: number };
    expect(limitSchema.minimum).toBe(1);
    expect(limitSchema.maximum).toBe(MAX_PAGE_LIMIT);

    // The length of a calendar range is documented in prose only.
    const responses = operation('/pto', 'get')['responses'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(String(responses['400']?.['description'])).toContain(String(MAX_RANGE_DAYS));
  });

  it('documents the precondition and the replay key the client sends', () => {
    const ifMatch = document.components.parameters['IfMatchVersion'] as {
      schema: { pattern: string };
    };
    const pattern = new RegExp(ifMatch.schema.pattern);
    expect(pattern.test(requireIfMatch(1))).toBe(true);
    expect(pattern.test(requireIfMatch(MAX_VERSION))).toBe(true);
    // A version below the documented minimum is never sent.
    expect(versionTheClientWouldSend(0)).toBeUndefined();

    const parameters = operation('/pto', 'post')['parameters'] as Array<Record<string, unknown>>;
    const key = parameters.find((parameter) => parameter['name'] === 'Idempotency-Key');
    const keyPattern = new RegExp(String((key?.['schema'] as { pattern: string }).pattern));
    expect(keyPattern.test('v1.1700000000000.9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f')).toBe(true);
    // The client only ever sends the canonical key of its own shape.
    expect(isV1CreateKey('v1.1700000000000.9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f')).toBe(true);
    expect(keyPattern.test('v2.1700000000000.9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f')).toBe(false);
  });

  it('documents the replay markers the client reads on a create', () => {
    const responses = operation('/pto', 'post')['responses'] as Record<
      string,
      Record<string, unknown>
    >;
    const headers = responses['201']?.['headers'] as Record<
      string,
      { schema?: { enum?: string[]; format?: string } }
    >;
    expect(headers['Idempotency-Replayed']?.schema?.enum).toEqual(['false', 'true']);
    expect(headers['Idempotency-Key-Expires-At']?.schema?.format).toBe('date-time');
    expect(headers['X-Request-Id']).toBeDefined();
  });
});
