import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * The contract test against the maintained root OpenAPI document.
 *
 * The client encodes the wire shapes once. This test proves that the shapes
 * it encodes are the ones the API documents, so a change in the contract
 * cannot pass unnoticed.
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
