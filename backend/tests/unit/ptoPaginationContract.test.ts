import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CALENDAR_PAGE_SIZE,
  MAX_CALENDAR_PAGE_SIZE,
  MAX_CALENDAR_RESULTS,
  MAX_CURSOR_LENGTH,
  MIN_CALENDAR_PAGE_SIZE,
} from '../../src/services/calendar/range.js';

interface Operation {
  security: Record<string, unknown[]>[];
  parameters: { in: string; name: string; required: boolean; schema: Record<string, unknown> }[];
  responses: Record<
    string,
    {
      $ref?: string;
      content?: { 'application/json': { schema: Record<string, unknown> } };
      headers?: { 'X-Request-Id': { $ref: string } };
    }
  >;
}

const api = parse(readFileSync(new URL('../../../docs/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, { get: Operation }>;
  components: { schemas: Record<string, unknown> };
};
const operation = api.paths['/pto']!.get;
const schemaRef = (name: string) => ({ $ref: `#/components/schemas/${name}` });

describe('GET /pto OpenAPI pagination contract', () => {
  it('documents opt-in paging and the same query bounds as the implementation', () => {
    expect(operation.parameters.map(({ name }) => name)).toEqual([
      'start',
      'end',
      'userId',
      'format',
      'limit',
      'cursor',
    ]);
    const param = (name: string) => operation.parameters.find((p) => p.name === name);
    for (const name of ['start', 'end']) {
      expect(param(name)).toMatchObject({
        in: 'query',
        required: true,
        schema: { type: 'string', format: 'date' },
      });
    }
    expect(param('userId')).toMatchObject({ required: false, schema: { format: 'uuid' } });
    expect(param('format')).toMatchObject({ required: false, schema: { enum: ['page'] } });
    expect(param('limit')).toMatchObject({
      required: false,
      schema: {
        type: 'integer',
        default: DEFAULT_CALENDAR_PAGE_SIZE,
        minimum: MIN_CALENDAR_PAGE_SIZE,
        maximum: MAX_CALENDAR_PAGE_SIZE,
      },
    });
    expect(param('cursor')).toMatchObject({
      required: false,
      schema: { type: 'string', minLength: 1, maxLength: MAX_CURSOR_LENGTH },
    });
  });

  it('keeps the legacy array and defines the bounded envelope without nullable notes becoming text', () => {
    expect(operation.responses['200']?.content?.['application/json'].schema).toEqual({
      oneOf: [
        schemaRef('PTOCalendarPage'),
        {
          type: 'array',
          maxItems: MAX_CALENDAR_RESULTS,
          items: schemaRef('PTOListItem'),
        },
      ],
    });
    const page = api.components.schemas['PTOCalendarPage'];
    expect(page).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['items', 'nextCursor', 'hasMore'],
      properties: {
        items: { type: 'array', maxItems: MAX_CALENDAR_PAGE_SIZE, items: schemaRef('PTOListItem') },
        nextCursor: { type: 'string', nullable: true, maxLength: MAX_CURSOR_LENGTH },
        hasMore: { type: 'boolean' },
      },
    });
    expect(api.components.schemas['PTOListItem']).toMatchObject({
      allOf: [
        schemaRef('PTOWithUser'),
        {
          type: 'object',
          required: ['note'],
          properties: { note: { type: 'string', nullable: true, enum: [null] } },
        },
      ],
    });
    expect(
      api.paths['/pto/{id}']?.get.responses['200']?.content?.['application/json'].schema,
    ).toEqual(schemaRef('PTOWithUser'));
    expect(api.components.schemas['PTOWithUser']).toMatchObject({
      properties: { note: { type: 'string', nullable: true } },
    });
  });

  it('retains cookie/PAT authorization, standard errors and request correlation', () => {
    expect(operation.security).toEqual([{ cookieAuth: [] }, { personalToken: [] }]);
    for (const status of ['200', '400']) {
      expect(operation.responses[status]?.headers?.['X-Request-Id']).toEqual({
        $ref: '#/components/headers/TokenRequestId',
      });
    }
    for (const status of ['400', '401']) {
      expect(operation.responses[status]?.content?.['application/json'].schema).toEqual(
        schemaRef('ErrorResponse'),
      );
    }
    expect(operation.responses['403']?.$ref).toBe('#/components/responses/PatForbidden');
    expect(operation.responses['429']?.$ref).toBe('#/components/responses/RateLimited');
  });
});
