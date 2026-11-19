import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPtoClient, type PtoClient } from '../src/index.js';
import { classifyUpstreamCode } from '../src/errors.js';
import type { PtoApiError } from '../src/errors.js';
import {
  isIsoDate,
  isIsoDateTime,
  isUuid,
  isValidRange,
  MAX_CURSOR_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_PAGE_LIMIT,
  MAX_RANGE_DAYS,
  MAX_VERSION,
  PTO_DAY_PARTS,
  PTO_ROLES,
  PTO_SCOPES,
  requireCursor,
  requireLimit,
  requireNote,
  requireVersion,
  type CreatePtoPayload,
  type PatchPtoChanges,
} from '../src/wire.js';

/**
 * The contract between the maintained OpenAPI document and the real client.
 *
 * The document and the client encode the same wire contract twice. A test
 * that only reads the document proves that the document did not change; it
 * says nothing about the client. This file closes that gap in both
 * directions: the document is resolved (`$ref`, `allOf`, `oneOf`) into real
 * shapes and compared with what the client actually declares, accepts, sends
 * and reads.
 *
 * The client is exercised against an ephemeral loopback fixture, so every
 * value here is a value the client really produced. Nothing in this file
 * edits the document: the drift regression clones the parsed document in
 * memory and runs the very same comparison over the clone.
 *
 * Scope: this is a contract check for the operations this client performs
 * with a personal token. It is not a general OpenAPI validator and it does
 * not claim that every documented route is covered.
 */

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const documentPath = join(repoRoot, 'docs', 'openapi.yaml');

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** Whether a parsed node is a mapping. */
function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Schema {
  type?: string;
  format?: string;
  nullable?: boolean;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minProperties?: number;
  maxItems?: number;
  additionalProperties?: boolean;
  pattern?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
}

interface OpenApiDocument {
  paths: Record<string, Record<string, Json>>;
  components: {
    schemas: Record<string, Json>;
    parameters: Record<string, Json>;
    responses: Record<string, Json>;
    headers: Record<string, Json>;
  };
}

function loadDocument(): OpenApiDocument {
  return YAML.parse(readFileSync(documentPath, 'utf8')) as OpenApiDocument;
}

const document = loadDocument();

/** Resolves a local `$ref` pointer such as `#/components/schemas/PTO`. */
function lookup(doc: OpenApiDocument, pointer: string): Json {
  const parts = pointer.replace(/^#\//, '').split('/');
  let node: unknown = doc;
  for (const part of parts) {
    if (typeof node !== 'object' || node === null) {
      throw new Error(`the reference ${pointer} does not resolve`);
    }
    node = (node as Json)[part];
  }
  if (typeof node !== 'object' || node === null) {
    throw new Error(`the reference ${pointer} does not resolve`);
  }
  return node as Json;
}

function mergeSchema(target: Schema, source: Schema): void {
  for (const key of [
    'type',
    'format',
    'nullable',
    'enum',
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'minProperties',
    'maxItems',
    'pattern',
    'description',
  ] as const) {
    const value = source[key];
    if (value !== undefined) (target as Json)[key] = value;
  }
  if (source.additionalProperties === false) target.additionalProperties = false;
  if (source.properties) {
    target.properties = { ...(target.properties ?? {}), ...source.properties };
  }
  if (source.required) {
    target.required = [...new Set([...(target.required ?? []), ...source.required])];
  }
}

/**
 * Resolves a schema node into one plain shape.
 *
 * A `$ref` is followed, an `allOf` is merged into a single object schema and
 * every nested property and item is resolved as well. A `oneOf` is left to
 * the caller, which names the branch it means.
 */
function materialize(doc: OpenApiDocument, node: Json, seen: string[] = []): Schema {
  if (typeof node['$ref'] === 'string') {
    const reference = node['$ref'];
    if (seen.includes(reference)) throw new Error(`unexpected recursive reference ${reference}`);
    return materialize(doc, lookup(doc, reference), [...seen, reference]);
  }
  if (Array.isArray(node['allOf'])) {
    const merged: Schema = { type: 'object', properties: {}, required: [] };
    for (const part of node['allOf'] as Json[]) {
      mergeSchema(merged, materialize(doc, part, seen));
    }
    const own = { ...node };
    delete own['allOf'];
    mergeSchema(merged, materialize(doc, own, seen));
    return merged;
  }
  const result: Schema = {};
  mergeSchema(result, node as Schema);
  if (node['properties'] && typeof node['properties'] === 'object') {
    result.properties = {};
    for (const [name, sub] of Object.entries(node['properties'] as Record<string, Json>)) {
      result.properties[name] = materialize(doc, sub, seen);
    }
  }
  if (node['items'] && typeof node['items'] === 'object') {
    result.items = materialize(doc, node['items'] as Json, seen);
  }
  return result;
}

/** The schema of a component, resolved. */
function componentSchema(doc: OpenApiDocument, name: string): Schema {
  const node = doc.components.schemas[name];
  if (!node) throw new Error(`the document has no schema ${name}`);
  return materialize(doc, node);
}

/** A node of the document, with its `$ref` followed. */
function resolveNode(doc: OpenApiDocument, node: Json): Json {
  const reference = node['$ref'];
  if (typeof reference !== 'string') return node;
  return lookup(doc, reference);
}

/** The operation of a route, or nothing. */
function operation(doc: OpenApiDocument, path: string, method: string): Json | undefined {
  return doc.paths[path]?.[method.toLowerCase()];
}

/** The parameters of an operation, with the `$ref` ones resolved. */
function operationParameters(
  doc: OpenApiDocument,
  path: string,
  method: string,
): Array<{ name: string; in: string; required: boolean; schema: Schema }> {
  const raw = (operation(doc, path, method)?.['parameters'] ?? []) as Json[];
  const parameters: Array<{ name: string; in: string; required: boolean; schema: Schema }> = [];
  for (const entry of raw) {
    const resolved = resolveNode(doc, entry);
    const name = resolved['name'];
    const where = resolved['in'];
    if (typeof name !== 'string' || typeof where !== 'string') continue;
    const schemaNode = resolved['schema'];
    parameters.push({
      name,
      in: where,
      required: resolved['required'] === true,
      schema: isJson(schemaNode) ? materialize(doc, schemaNode) : {},
    });
  }
  return parameters;
}

/** The request body schema of an operation, or nothing. */
function requestBodySchema(doc: OpenApiDocument, path: string, method: string): Schema | undefined {
  const body = operation(doc, path, method)?.['requestBody'];
  if (!isJson(body)) return undefined;
  const content = body['content'];
  if (!isJson(content)) return undefined;
  const json = content['application/json'];
  if (!isJson(json)) return undefined;
  const schema = json['schema'];
  if (!isJson(schema)) return undefined;
  return materialize(doc, schema);
}

/** Whether a response documents a JSON body. */
function responseHasBody(
  doc: OpenApiDocument,
  path: string,
  method: string,
  status: string,
): boolean {
  const responses = operation(doc, path, method)?.['responses'];
  if (!responses || typeof responses !== 'object') return false;
  const entry = (responses as Json)[status];
  if (!isJson(entry)) return false;
  const resolved = resolveNode(doc, entry);
  const content = resolved['content'];
  if (!isJson(content)) return false;
  return Object.keys(content).length > 0;
}

/**
 * The success schema of a response, with the branch the client consumes.
 *
 * A `oneOf` names more than one representation. The client only ever reads
 * the personal-token branch of the identity answer and the paged branch of
 * the calendar answer, so those are the branches that are resolved here.
 */
function successSchema(
  doc: OpenApiDocument,
  path: string,
  method: string,
  status: string,
  prefer: string,
): Schema {
  const responses = operation(doc, path, method)?.['responses'];
  const entry = isJson(responses) ? responses[status] : undefined;
  if (!isJson(entry)) {
    throw new Error(`${method} ${path} has no documented ${status} answer`);
  }
  const resolved = resolveNode(doc, entry);
  const content = resolved['content'];
  const json = isJson(content) ? content['application/json'] : undefined;
  const schema = isJson(json) ? json['schema'] : undefined;
  if (!isJson(schema)) {
    throw new Error(`${method} ${path} ${status} documents no JSON body`);
  }
  const node = schema;
  if (Array.isArray(node['oneOf'])) {
    const branches = node['oneOf'] as Json[];
    const wanted = branches.find((branch) =>
      typeof branch['$ref'] === 'string' ? branch['$ref'].endsWith(`/${prefer}`) : false,
    );
    if (!wanted) {
      throw new Error(`${method} ${path} ${status} has no ${prefer} branch`);
    }
    return materialize(doc, wanted);
  }
  return materialize(doc, node);
}

/** The response headers of an answer, with the `$ref` ones resolved. */
function responseHeaders(
  doc: OpenApiDocument,
  path: string,
  method: string,
  status: string,
): Record<string, Schema> {
  const responses = operation(doc, path, method)?.['responses'];
  const entry = isJson(responses) ? responses[status] : undefined;
  if (!isJson(entry)) return {};
  const resolved = resolveNode(doc, entry);
  const headers = resolved['headers'];
  if (!isJson(headers)) return {};
  const result: Record<string, Schema> = {};
  for (const [name, value] of Object.entries(headers)) {
    const node = isJson(value) ? resolveNode(doc, value) : {};
    const schema = node['schema'];
    result[name] = isJson(schema) ? materialize(doc, schema) : {};
  }
  return result;
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

/** One difference between the document and the client. */
interface Difference {
  path: string;
  detail: string;
}

/** The facts the client really has. */
interface ClientFacts {
  dayParts: readonly string[];
  roles: readonly string[];
  scopes: readonly string[];
  minVersion: number;
  maxVersion: number;
  minLimit: number;
  maxLimit: number;
  minCursorLength: number;
  maxCursorLength: number;
  maxNoteLength: number;
  maxRangeDays: number;
  captures: Capture[];
  identityKeys: string[];
  identityAuthKeys: string[];
  pageKeys: string[];
  pageItemKeys: string[];
  userKeys: string[];
  detailKeys: string[];
  recordKeys: string[];
  patchKeys: string[];
  rateLimitSeconds: number;
  rateLimitMs: number;
  correlationId: string;
  upstreamMessage: string;
  clientMessage: string;
}

/** One request the client really sent, with the answer it got. */
interface Capture {
  name: string;
  method: string;
  pathTemplate: string;
  request: Recorded;
  status: number;
  reply?: unknown;
}

interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

function accepts(callback: () => unknown): boolean {
  try {
    callback();
    return true;
  } catch {
    return false;
  }
}

/** The accepted bounds of the client, taken from its own validators. */
function acceptedBounds(): Pick<
  ClientFacts,
  | 'minVersion'
  | 'maxVersion'
  | 'minLimit'
  | 'maxLimit'
  | 'minCursorLength'
  | 'maxCursorLength'
  | 'maxNoteLength'
> {
  // Test the real predicates at every boundary; never search an int32 range.
  expect(requireVersion(1)).toBe(1);
  expect(requireVersion(MAX_VERSION)).toBe(MAX_VERSION);
  expect(accepts(() => requireVersion(0))).toBe(false);
  expect(accepts(() => requireVersion(MAX_VERSION + 1))).toBe(false);
  expect(requireLimit(1)).toBe(1);
  expect(requireLimit(MAX_PAGE_LIMIT)).toBe(MAX_PAGE_LIMIT);
  expect(accepts(() => requireLimit(0))).toBe(false);
  expect(accepts(() => requireLimit(MAX_PAGE_LIMIT + 1))).toBe(false);
  expect(requireCursor('c')).toBe('c');
  expect(requireCursor('c'.repeat(MAX_CURSOR_LENGTH))).toHaveLength(MAX_CURSOR_LENGTH);
  expect(accepts(() => requireCursor(''))).toBe(false);
  expect(accepts(() => requireCursor('c'.repeat(MAX_CURSOR_LENGTH + 1)))).toBe(false);
  expect(requireNote('n'.repeat(MAX_NOTE_LENGTH))).toHaveLength(MAX_NOTE_LENGTH);
  expect(accepts(() => requireNote('n'.repeat(MAX_NOTE_LENGTH + 1)))).toBe(false);
  const end = (days: number) => new Date(Date.UTC(2026, 0, days)).toISOString().slice(0, 10);
  expect(isValidRange('2026-01-01', end(MAX_RANGE_DAYS))).toBe(true);
  expect(isValidRange('2026-01-01', end(MAX_RANGE_DAYS + 1))).toBe(false);
  return {
    minVersion: 1,
    maxVersion: MAX_VERSION,
    minLimit: 1,
    maxLimit: MAX_PAGE_LIMIT,
    minCursorLength: 1,
    maxCursorLength: MAX_CURSOR_LENGTH,
    maxNoteLength: MAX_NOTE_LENGTH,
  };
}

/** Whether a value satisfies a documented property schema. */
function valueSatisfies(schema: Schema | undefined, value: unknown): boolean {
  if (!schema) return true;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (value === null) return schema.nullable === true;
  if (schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return false;
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
    return true;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return false;
    if (schema.minLength !== undefined && value.length < schema.minLength) return false;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return false;
    if (schema.format === 'date' && !isIsoDate(value)) return false;
    if (schema.format === 'uuid' && !isUuid(value)) return false;
    if (schema.format === 'date-time' && !isIsoDateTime(value)) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
    return true;
  }
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'object') {
    if (!isJson(value)) return false;
    if (schema.required?.some((key) => !Object.hasOwn(value, key))) return false;
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) {
      return false;
    }
    return Object.entries(value).every(([key, field]) => {
      const property = schema.properties?.[key];
      return property ? valueSatisfies(property, field) : schema.additionalProperties !== false;
    });
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items && !value.every((entry) => valueSatisfies(schema.items, entry))) return false;
    return true;
  }
  return true;
}

/** Compares a documented object shape with the fields the client really reads. */
function compareObjectShape(
  path: string,
  schema: Schema | undefined,
  clientKeys: readonly string[],
): Difference[] {
  const differences: Difference[] = [];
  const supported = Object.keys(schema?.properties ?? {}).sort();
  const required = [...(schema?.required ?? [])].sort();
  for (const key of clientKeys) {
    if (!supported.includes(key)) {
      differences.push({
        path: `${path}.${key}`,
        detail: 'the client reads this field, but the document does not describe it',
      });
    }
  }
  for (const key of required) {
    if (!clientKeys.includes(key)) {
      differences.push({
        path: `${path}.${key}`,
        detail: 'the document requires this field, but the client does not read it',
      });
    }
  }
  for (const key of clientKeys) {
    if (required.includes(key)) continue;
    const property = schema?.properties?.[key];
    if (property && property.nullable !== true) {
      differences.push({
        path: `${path}.${key}`,
        detail: 'the client always reads this field, so the document has to declare it nullable',
      });
    }
  }
  return differences;
}

/** Compares a documented enumeration with the values the client accepts. */
function compareVocabulary(
  doc: OpenApiDocument,
  name: string,
  clientValues: readonly string[],
): Difference[] {
  const differences: Difference[] = [];
  const schema = componentSchema(doc, name);
  const documented = (schema.enum ?? []).map((value) => String(value)).sort();
  const client = [...clientValues].sort();
  for (const value of documented) {
    if (!client.includes(value)) {
      differences.push({
        path: `components.schemas.${name}.enum`,
        detail: `the document allows "${value}", but the client does not accept it`,
      });
    }
  }
  for (const value of client) {
    if (!documented.includes(value)) {
      differences.push({
        path: `components.schemas.${name}.enum`,
        detail: `the client accepts "${value}", but the document does not allow it`,
      });
    }
  }
  return differences;
}

/** The vocabulary, the bounds and the flags the document and the client share. */
function checkVocabulary(doc: OpenApiDocument, facts: ClientFacts): Difference[] {
  return [
    ...compareVocabulary(doc, 'DayPart', facts.dayParts),
    ...compareVocabulary(doc, 'Role', facts.roles),
    ...compareVocabulary(doc, 'PersonalTokenScope', facts.scopes),
  ];
}

function checkBounds(doc: OpenApiDocument, facts: ClientFacts): Difference[] {
  const differences: Difference[] = [];

  const version = componentSchema(doc, 'PTORecordVersion');
  if (version.type !== 'integer') {
    differences.push({
      path: 'components.schemas.PTORecordVersion.type',
      detail: `the document says "${String(version.type)}", but the client reads an integer version`,
    });
  }
  if (version.minimum !== facts.minVersion) {
    differences.push({
      path: 'components.schemas.PTORecordVersion.minimum',
      detail: `the document allows from ${String(version.minimum)}, but the client accepts from ${facts.minVersion}`,
    });
  }
  if (version.maximum !== facts.maxVersion) {
    differences.push({
      path: 'components.schemas.PTORecordVersion.maximum',
      detail: `the document allows up to ${String(version.maximum)}, but the client accepts up to ${facts.maxVersion}`,
    });
  }

  for (const name of ['CreatePTORequest', 'PatchPTORequest'] as const) {
    const note = componentSchema(doc, name).properties?.['note'];
    if (note?.maxLength !== facts.maxNoteLength) {
      differences.push({
        path: `components.schemas.${name}.properties.note.maxLength`,
        detail: `the document allows ${String(note?.maxLength)} characters, but the client accepts ${facts.maxNoteLength}`,
      });
    }
  }

  const page = componentSchema(doc, 'PTOCalendarPage');
  const cursor = page.properties?.['nextCursor'];
  if (cursor?.minLength !== facts.minCursorLength) {
    differences.push({
      path: 'components.schemas.PTOCalendarPage.properties.nextCursor.minLength',
      detail: `the document allows from ${String(cursor?.minLength)} characters, but the client accepts from ${facts.minCursorLength}`,
    });
  }
  if (cursor?.maxLength !== facts.maxCursorLength) {
    differences.push({
      path: 'components.schemas.PTOCalendarPage.properties.nextCursor.maxLength',
      detail: `the document allows up to ${String(cursor?.maxLength)} characters, but the client accepts up to ${facts.maxCursorLength}`,
    });
  }
  // The client refuses a page with more rows than the documented maximum, so
  // the two numbers have to be the same one.
  const items = page.properties?.['items'];
  if (items?.maxItems !== facts.maxLimit) {
    differences.push({
      path: 'components.schemas.PTOCalendarPage.properties.items.maxItems',
      detail: `the document allows ${String(items?.maxItems)} rows per page, but the client accepts up to ${facts.maxLimit}`,
    });
  }

  const limit = operationParameters(doc, '/pto', 'get').find(
    (parameter) => parameter.name === 'limit',
  );
  if (limit?.schema.minimum !== facts.minLimit) {
    differences.push({
      path: 'paths./pto.get.parameters.limit.schema.minimum',
      detail: `the document allows from ${String(limit?.schema.minimum)}, but the client accepts from ${facts.minLimit}`,
    });
  }
  if (limit?.schema.maximum !== facts.maxLimit) {
    differences.push({
      path: 'paths./pto.get.parameters.limit.schema.maximum',
      detail: `the document allows up to ${String(limit?.schema.maximum)}, but the client accepts up to ${facts.maxLimit}`,
    });
  }

  // The length of a calendar range is documented in prose only.
  const responses = operation(doc, '/pto', 'get')?.['responses'];
  const rangeResponse = isJson(responses) ? responses['400'] : undefined;
  const rangeText = String(isJson(rangeResponse) ? rangeResponse['description'] : '');
  if (!rangeText.includes(String(facts.maxRangeDays))) {
    differences.push({
      path: 'paths./pto.get.responses.400.description',
      detail: `the document does not mention a range of ${facts.maxRangeDays} days, which is the range the client accepts`,
    });
  }

  return differences;
}

/** The shapes of the answers, compared with the fields the client reads. */
function checkResponseShapes(doc: OpenApiDocument, facts: ClientFacts): Difference[] {
  const differences: Difference[] = [];

  const identity = successSchema(doc, '/auth/me', 'get', '200', 'PersonalTokenIdentity');
  differences.push(
    ...compareObjectShape('GET /auth/me 200 PersonalTokenIdentity', identity, facts.identityKeys),
  );
  differences.push(
    ...compareObjectShape(
      'GET /auth/me 200 PersonalTokenIdentity.auth',
      identity.properties?.['auth'],
      facts.identityAuthKeys,
    ),
  );

  const page = successSchema(doc, '/pto', 'get', '200', 'PTOCalendarPage');
  differences.push(...compareObjectShape('GET /pto 200 PTOCalendarPage', page, facts.pageKeys));
  const item = componentSchema(doc, 'PTOPagedListItem');
  differences.push(
    ...compareObjectShape('GET /pto 200 PTOPagedListItem', item, facts.pageItemKeys),
  );

  const withUser = componentSchema(doc, 'PTOWithUser');
  differences.push(
    ...compareObjectShape(
      'GET /pto 200 PTOWithUser.user',
      withUser.properties?.['user'],
      facts.userKeys,
    ),
  );

  const detail = successSchema(doc, '/pto/{id}', 'get', '200', 'PTODetail');
  differences.push(...compareObjectShape('GET /pto/{id} 200 PTODetail', detail, facts.detailKeys));

  const record = successSchema(doc, '/pto', 'post', '201', 'PTO');
  differences.push(...compareObjectShape('POST /pto 201 PTO', record, facts.recordKeys));
  const patched = successSchema(doc, '/pto/{id}', 'patch', '200', 'PTO');
  differences.push(...compareObjectShape('PATCH /pto/{id} 200 PTO', patched, facts.patchKeys));
  const schemasForCalls: Record<string, Schema> = {
    getIdentity: identity,
    listPage: page,
    listNext: page,
    getDetail: detail,
    create: record,
    createMinimal: record,
    patch: patched,
    patchDates: patched,
  };
  for (const entry of facts.captures) {
    const schema = schemasForCalls[entry.name];
    const value =
      entry.method === 'POST' && isJson(entry.reply) ? entry.reply['record'] : entry.reply;
    if (schema && !valueSatisfies(schema, value)) {
      differences.push({
        path: `${entry.method} ${entry.pathTemplate} ${entry.status}`,
        detail: 'the response parsed by the client does not satisfy this operation’s schema',
      });
    }
  }

  const method = componentSchema(doc, 'PersonalTokenIdentity').properties?.['auth']?.properties?.[
    'method'
  ];
  if (method?.enum?.map(String).join(',') !== 'pat') {
    differences.push({
      path: 'components.schemas.PersonalTokenIdentity.properties.auth.properties.method.enum',
      detail: 'the document does not describe the personal-token identity the client reads',
    });
  }

  const pageNote = item.properties?.['note'];
  if (pageNote?.nullable !== true || (pageNote.enum ?? []).map(String).join(',') !== 'null') {
    differences.push({
      path: 'components.schemas.PTOPagedListItem.properties.note',
      detail: 'the document does not restrict a paged row to an explicit null note',
    });
  }

  return differences;
}

/** The requests the client really sent, compared with the documented operation. */
function checkEmittedRequests(doc: OpenApiDocument, facts: ClientFacts): Difference[] {
  const differences: Difference[] = [];

  for (const capture of facts.captures) {
    const where = `${capture.method} ${capture.pathTemplate}`;
    if (
      capture.request.method !== capture.method ||
      capture.request.path !== capture.pathTemplate.replace('{id}', PTO_ID)
    ) {
      differences.push({ path: where, detail: 'the client sent a different method or route' });
    }
    const documented = operation(doc, capture.pathTemplate, capture.method);
    if (!documented) {
      differences.push({
        path: where,
        detail: 'the client calls an operation the document does not describe',
      });
      continue;
    }
    const responses = documented['responses'];
    if (!isJson(responses) || !Object.hasOwn(responses, capture.status)) {
      differences.push({
        path: `${where} responses.${capture.status}`,
        detail: 'the client handled a status this operation does not document',
      });
    }

    const parameters = operationParameters(doc, capture.pathTemplate, capture.method);
    const queryParameters = new Map(
      parameters.filter((parameter) => parameter.in === 'query').map((p) => [p.name, p]),
    );
    for (const [name, value] of Object.entries(capture.request.query)) {
      const parameter = queryParameters.get(name);
      if (!parameter) {
        differences.push({
          path: `${where} query.${name}`,
          detail: 'the client sends a query parameter the operation does not document',
        });
        continue;
      }
      const wireValue =
        parameter.schema.type === 'integer' && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : value;
      if (!valueSatisfies(parameter.schema, wireValue)) {
        differences.push({
          path: `${where} query.${name}`,
          detail: `the client sends "${value}", which the documented schema does not allow`,
        });
      }
    }
    for (const parameter of parameters) {
      if (parameter.in !== 'query' || !parameter.required) continue;
      if (!(parameter.name in capture.request.query)) {
        differences.push({
          path: `${where} query.${parameter.name}`,
          detail: 'the operation requires this query parameter, but the client does not send it',
        });
      }
    }

    const bodySchema = requestBodySchema(doc, capture.pathTemplate, capture.method);
    const body = capture.request.body;
    if (body === undefined || body === null) {
      if (bodySchema && (bodySchema.required ?? []).length > 0) {
        differences.push({
          path: `${where} requestBody`,
          detail: 'the operation requires a body, but the client sends none',
        });
      }
    } else {
      if (!bodySchema) {
        differences.push({
          path: `${where} requestBody`,
          detail: 'the client sends a body, but the operation documents none',
        });
      } else if (typeof body === 'object' && !Array.isArray(body)) {
        const fields = body as Record<string, unknown>;
        const supported = Object.keys(bodySchema.properties ?? {});
        for (const key of Object.keys(fields)) {
          if (!supported.includes(key)) {
            differences.push({
              path: `${where} requestBody.${key}`,
              detail: 'the client sends a field the documented body does not describe',
            });
          }
        }
        for (const key of bodySchema.required ?? []) {
          if (!(key in fields)) {
            differences.push({
              path: `${where} requestBody.${key}`,
              detail: 'the documented body requires this field, but the client does not send it',
            });
          }
        }
        if (
          bodySchema.minProperties !== undefined &&
          Object.keys(fields).length < bodySchema.minProperties
        ) {
          differences.push({
            path: `${where} requestBody`,
            detail: `the documented body needs at least ${bodySchema.minProperties} field(s), but the client sends ${Object.keys(fields).length}`,
          });
        }
        for (const [key, value] of Object.entries(fields)) {
          const property = bodySchema.properties?.[key];
          if (!valueSatisfies(property, value)) {
            differences.push({
              path: `${where} requestBody.${key}`,
              detail: `the client sends ${JSON.stringify(value)}, which the documented body does not allow`,
            });
          }
        }
      }
    }

    const headerParameters = new Map(
      parameters.filter((parameter) => parameter.in === 'header').map((p) => [p.name, p]),
    );
    const ifMatch = capture.request.headers['if-match'];
    if (typeof ifMatch === 'string') {
      const parameter = headerParameters.get('If-Match');
      if (!parameter) {
        differences.push({
          path: `${where} header.If-Match`,
          detail: 'the client sends the precondition, but the operation does not document it',
        });
      } else {
        if (!parameter.required) {
          differences.push({
            path: `${where} header.If-Match`,
            detail: 'the documented precondition is not required, but the client always sends it',
          });
        }
        const pattern = parameter.schema.pattern;
        if (typeof pattern === 'string' && !new RegExp(pattern).test(ifMatch)) {
          differences.push({
            path: `${where} header.If-Match`,
            detail: `the client sends ${ifMatch}, which the documented pattern does not allow`,
          });
        }
      }
    }

    const key = capture.request.headers['idempotency-key'];
    if (typeof key === 'string') {
      const parameter = headerParameters.get('Idempotency-Key');
      if (!parameter) {
        differences.push({
          path: `${where} header.Idempotency-Key`,
          detail: 'the client sends the replay key, but the operation does not document it',
        });
      } else {
        const pattern = parameter.schema.pattern;
        if (typeof pattern === 'string' && !new RegExp(pattern).test(key)) {
          differences.push({
            path: `${where} header.Idempotency-Key`,
            detail: `the client sends ${key}, which the documented pattern does not allow`,
          });
        }
      }
    }

    if (capture.method === 'DELETE') {
      if (responseHasBody(doc, capture.pathTemplate, capture.method, '204')) {
        differences.push({
          path: `${where} responses.204`,
          detail: 'the document gives the delete a body, but the client expects an empty answer',
        });
      }
      if (capture.request.body !== undefined) {
        differences.push({
          path: `${where} requestBody`,
          detail: 'the client sends a body with a delete, but the documented answer is empty',
        });
      }
    }
  }

  return differences;
}

/** The documented error envelope and the metadata the client keeps. */
function checkErrorEnvelope(doc: OpenApiDocument, facts: ClientFacts): Difference[] {
  const differences: Difference[] = [];

  const envelope = componentSchema(doc, 'ErrorResponse');
  if (!envelope.properties?.['error']) {
    differences.push({
      path: 'components.schemas.ErrorResponse.properties.error',
      detail: 'the document describes no error envelope for the client',
    });
  }
  const error = envelope.properties?.['error'];
  for (const key of ['code', 'message']) {
    if (!(error?.required ?? []).includes(key)) {
      differences.push({
        path: `components.schemas.ErrorResponse.properties.error.required`,
        detail: `the documented error envelope does not require "${key}"`,
      });
    }
  }

  // Every code the document allows has to be understood by the client, and
  // every other code has to become the fixed fallback.
  const codes = new Set<string>();
  for (const text of describedErrorTexts(doc)) {
    for (const match of text.matchAll(/\b[A-Z][A-Z0-9_]{3,}\b/g)) {
      codes.add(match[0]);
    }
  }
  for (const code of codes) {
    const classified = classifyUpstreamCode(code);
    if (classified !== code) {
      differences.push({
        path: 'components.schemas.ErrorResponse.properties.error.properties.code',
        detail: `the document allows "${code}", but the client reports it as "${classified}"`,
      });
    }
  }
  if (classifyUpstreamCode('NOT_A_DOCUMENTED_CODE') !== 'HTTP_ERROR') {
    differences.push({
      path: 'components.schemas.ErrorResponse.properties.error.properties.code',
      detail: 'the client reports an unknown upstream code as a code of its own',
    });
  }
  if (facts.upstreamMessage === facts.clientMessage) {
    differences.push({
      path: 'components.schemas.ErrorResponse.properties.error.properties.message',
      detail: 'the client copies the upstream message into its own error',
    });
  }

  const rateLimited = doc.components.responses['RateLimited'];
  const headers = rateLimited?.['headers'];
  const retryAfter = isJson(headers) ? headers['Retry-After'] : undefined;
  const retrySchema =
    isJson(retryAfter) && isJson(retryAfter['schema'])
      ? materialize(doc, retryAfter['schema'])
      : undefined;
  if (retrySchema?.type !== 'integer' || retrySchema.minimum !== 0) {
    differences.push({
      path: 'components.responses.RateLimited.headers.Retry-After',
      detail: 'the document does not describe the retry hint the client keeps',
    });
  }
  if (facts.rateLimitMs !== facts.rateLimitSeconds * 1000) {
    differences.push({
      path: 'components.responses.RateLimited.headers.Retry-After',
      detail: 'the client does not turn the documented retry hint into milliseconds',
    });
  }
  if (!isUuid(facts.correlationId)) {
    differences.push({
      path: 'components.responses.RateLimited.headers.X-Request-Id',
      detail: 'the correlation id the client keeps is not the documented one',
    });
  }

  return differences;
}

/** The parts of the document that name the machine-readable error codes. */
function describedErrorTexts(doc: OpenApiDocument): string[] {
  const texts: string[] = [];
  const code = componentSchema(doc, 'ErrorResponse').properties?.['error']?.properties?.['code'];
  const description = code ? code['description'] : undefined;
  if (typeof description === 'string') texts.push(description);
  const responses = operation(doc, '/pto', 'post')?.['responses'];
  for (const status of ['400', '409'] as const) {
    const response = isJson(responses) ? responses[status] : undefined;
    if (isJson(response)) {
      const text = response['description'];
      if (typeof text === 'string') texts.push(text);
    }
  }
  return texts;
}

/**
 * The whole comparison.
 *
 * The very same function reads the maintained document and a clone of it, so
 * a drifted document has to produce a difference instead of passing quietly.
 */
function checkContract(doc: OpenApiDocument, facts: ClientFacts): Difference[] {
  return [
    ...checkVocabulary(doc, facts),
    ...checkBounds(doc, facts),
    ...checkResponseShapes(doc, facts),
    ...checkEmittedRequests(doc, facts),
    ...checkErrorEnvelope(doc, facts),
  ];
}

function describeDifferences(differences: readonly Difference[]): string {
  return differences.map((difference) => `${difference.path}: ${difference.detail}`).join('\n');
}

// ---------------------------------------------------------------------------
// The loopback fixture
// ---------------------------------------------------------------------------

const TOKEN = `pto_pat_44444444-4444-4444-8444-444444444444.${'a'.repeat(64)}`;
const OWNER = '11111111-1111-4111-8111-111111111111';
const PTO_ID = '22222222-2222-4222-8222-222222222222';
const ISSUED_AT = Date.now();
const KEY = `v1.${ISSUED_AT}.9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f`;
const SECOND_KEY = `v1.${ISSUED_AT}.9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e60`;
const EXPIRES_AT = new Date(ISSUED_AT + 86_400_000).toISOString();
const CORRELATION_ID = '55555555-5555-4555-8555-555555555555';

const IDENTITY = {
  id: OWNER,
  role: 'member',
  auth: {
    method: 'pat',
    tokenId: '33333333-3333-4333-8333-333333333333',
    scopes: ['pto:read', 'pto:create'],
    expiresAt: '2027-01-01T00:00:00.000Z',
  },
};

const RECORD = {
  id: PTO_ID,
  userId: OWNER,
  startDate: '2026-05-10',
  endDate: '2026-05-10',
  dayPart: 'morning',
  note: 'Doctor appointment',
  createdAt: '2026-05-03T12:00:00.000Z',
  updatedAt: '2026-05-03T12:30:00.000Z',
  version: 1,
};

const DETAIL = {
  id: PTO_ID,
  user: { id: OWNER, name: 'Owner', colorCode: '#123456' },
  startDate: '2026-05-10',
  endDate: '2026-05-10',
  dayPart: 'morning',
  note: 'Doctor appointment',
  version: 1,
};

const PAGE_ITEM = {
  id: PTO_ID,
  user: { id: OWNER, name: 'Owner', colorCode: '#123456' },
  startDate: '2026-05-10',
  endDate: '2026-05-10',
  dayPart: 'morning',
  note: null,
  version: 1,
};

interface Canned {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

let server: ReturnType<typeof createServer>;
let client: PtoClient;
let recorded: Recorded[] = [];
let canned: Canned = { status: 200, body: {} };
let queue: Canned[] = [];

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function send(res: ServerResponse, answer: Canned): void {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...answer.headers };
  res.writeHead(answer.status, headers);
  if (answer.status === 204 || answer.body === undefined) {
    res.end();
    return;
  }
  res.end(JSON.stringify(answer.body));
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      recorded.push({
        method: req.method ?? 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: req.headers,
        body: await readBody(req),
      });
      send(res, queue.shift() ?? canned);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  client = createPtoClient({
    baseUrl,
    credential: { origin: baseUrl, token: TOKEN },
    allowLoopbackHttp: true,
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Performs one call and returns what the client sent and what it read. */
async function capture(
  name: string,
  method: string,
  pathTemplate: string,
  answer: Canned,
  call: () => Promise<unknown>,
): Promise<{ capture: Capture; result: unknown; error: unknown }> {
  recorded = [];
  canned = answer;
  queue = [];
  try {
    const result = await call();
    const request = recorded[0];
    if (!request) throw new Error(`${name} did not reach the server`);
    return {
      capture: { name, method, pathTemplate, request, status: answer.status, reply: result },
      result,
      error: undefined,
    };
  } catch (error) {
    const request = recorded[0];
    if (!request) throw error;
    return {
      capture: { name, method, pathTemplate, request, status: answer.status },
      result: undefined,
      error,
    };
  }
}

// ---------------------------------------------------------------------------
// The facts the client really has
// ---------------------------------------------------------------------------

let facts: ClientFacts;

beforeAll(async () => {
  const identity = await capture(
    'getIdentity',
    'GET',
    '/auth/me',
    { status: 200, body: IDENTITY },
    () => client.getIdentity(),
  );
  const page = await capture(
    'listPage',
    'GET',
    '/pto',
    {
      status: 200,
      body: { items: [PAGE_ITEM], nextCursor: null, hasMore: false },
    },
    () => client.listPage({ start: '2026-05-01', end: '2026-05-31', userId: OWNER, limit: 50 }),
  );
  const detail = await capture('getDetail', 'GET', '/pto/{id}', { status: 200, body: DETAIL }, () =>
    client.getDetail(PTO_ID),
  );
  const create = await capture(
    'create',
    'POST',
    '/pto',
    {
      status: 201,
      body: RECORD,
      headers: { 'Idempotency-Replayed': 'false', 'Idempotency-Key-Expires-At': EXPIRES_AT },
    },
    () =>
      client.create(
        {
          startDate: '2026-05-10',
          endDate: '2026-05-10',
          dayPart: 'morning',
          note: 'Doctor appointment',
        } satisfies CreatePtoPayload,
        KEY,
      ),
  );
  const createMinimal = await capture(
    'createMinimal',
    'POST',
    '/pto',
    {
      status: 201,
      body: {
        ...RECORD,
        startDate: '2026-05-11',
        endDate: '2026-05-12',
        dayPart: 'all_day',
        note: null,
      },
      headers: { 'Idempotency-Replayed': 'false', 'Idempotency-Key-Expires-At': EXPIRES_AT },
    },
    () => client.create({ startDate: '2026-05-11', endDate: '2026-05-12' }, SECOND_KEY),
  );
  const patchRecord = { ...RECORD, version: 2, note: null };
  const patch = await capture(
    'patch',
    'PATCH',
    '/pto/{id}',
    { status: 200, body: patchRecord },
    () => client.patch(PTO_ID, 1, { dayPart: 'evening', note: null } satisfies PatchPtoChanges),
  );
  const patchDates = await capture(
    'patchDates',
    'PATCH',
    '/pto/{id}',
    { status: 200, body: patchRecord },
    () => client.patch(PTO_ID, 1, { startDate: '2026-05-11', endDate: '2026-05-12' }),
  );
  const listNext = await capture(
    'listNext',
    'GET',
    '/pto',
    { status: 200, body: { items: [], nextCursor: null, hasMore: false } },
    () => client.listPage({ start: '2026-05-01', end: '2026-05-31', cursor: 'cursor-1' }),
  );
  const remove = await capture('delete', 'DELETE', '/pto/{id}', { status: 204 }, () =>
    client.delete(PTO_ID, 1),
  );
  const limited = await capture(
    'rateLimited',
    'GET',
    '/pto',
    {
      status: 429,
      body: { error: { code: 'RATE_LIMITED', message: 'slow down' } },
      headers: { 'Retry-After': '7', 'X-Request-Id': CORRELATION_ID },
    },
    () => client.listPage({ start: '2026-05-01', end: '2026-05-31' }),
  );

  const identityValue = identity.result as { auth: Record<string, unknown> };
  const pageValue = page.result as { items: Array<Record<string, unknown>> };
  const detailValue = detail.result as { user: Record<string, unknown> };
  const recordValue = create.result as { record: Record<string, unknown> };
  const patchValue = patch.result as Record<string, unknown>;
  for (const success of [
    identity,
    page,
    detail,
    create,
    createMinimal,
    patch,
    patchDates,
    listNext,
    remove,
  ]) {
    expect(success.error, success.capture.name).toBeUndefined();
  }
  const error = limited.error as PtoApiError;

  facts = {
    dayParts: PTO_DAY_PARTS,
    roles: PTO_ROLES,
    scopes: PTO_SCOPES,
    ...acceptedBounds(),
    maxRangeDays: MAX_RANGE_DAYS,
    captures: [
      identity.capture,
      page.capture,
      detail.capture,
      create.capture,
      createMinimal.capture,
      patch.capture,
      patchDates.capture,
      listNext.capture,
      remove.capture,
      limited.capture,
    ],
    identityKeys: Object.keys(identityValue),
    identityAuthKeys: Object.keys(identityValue.auth),
    pageKeys: Object.keys(pageValue),
    pageItemKeys: Object.keys(pageValue.items[0] ?? {}),
    userKeys: Object.keys(detailValue.user),
    detailKeys: Object.keys(detailValue),
    recordKeys: Object.keys(recordValue.record),
    patchKeys: Object.keys(patchValue),
    rateLimitSeconds: 7,
    rateLimitMs: error.retryAfterMs ?? 0,
    correlationId: error.requestId ?? '',
    upstreamMessage: 'slow down',
    clientMessage: error.message,
  };
});

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

describe('the documented contract and the real client', () => {
  it('agrees with the client on every documented shape', () => {
    const differences = checkContract(document, facts);
    expect(describeDifferences(differences)).toBe('');
    expect(differences).toEqual([]);
  });

  it('reads the personal-token branch and the paged branch, never a legacy one', () => {
    // The identity answer has two documented representations; this client
    // only ever reads the personal-token one.
    const identity = successSchema(document, '/auth/me', 'get', '200', 'PersonalTokenIdentity');
    expect(identity.properties?.['auth']?.properties?.['method']?.enum).toEqual(['pat']);

    // The calendar answer has the paged envelope and the historical array;
    // the client always asks for the paged one.
    const listCaptures = facts.captures.filter(
      (entry) => entry.method === 'GET' && entry.pathTemplate === '/pto',
    );
    expect(listCaptures.length).toBeGreaterThan(0);
    for (const entry of listCaptures) {
      expect(entry.request.query['format']).toBe('page');
    }
    const page = successSchema(document, '/pto', 'get', '200', 'PTOCalendarPage');
    expect(Object.keys(page.properties ?? {}).sort()).toEqual(['hasMore', 'items', 'nextCursor']);
  });

  it('accepts every documented value of the vocabulary', () => {
    const dayParts = componentSchema(document, 'DayPart').enum ?? [];
    expect(dayParts.length).toBeGreaterThan(0);
    for (const dayPart of dayParts) {
      expect(PTO_DAY_PARTS as readonly string[]).toContain(String(dayPart));
    }
    const roles = componentSchema(document, 'Role').enum ?? [];
    for (const role of roles) {
      expect(PTO_ROLES as readonly string[]).toContain(String(role));
    }
    const scopes = componentSchema(document, 'PersonalTokenScope').enum ?? [];
    expect(scopes.length).toBeGreaterThan(0);
    for (const scope of scopes) {
      expect(PTO_SCOPES as readonly string[]).toContain(String(scope));
    }
  });

  it('sends the documented request of every operation', () => {
    const byName = new Map(facts.captures.map((entry) => [entry.name, entry]));
    const create = byName.get('create');
    expect(create?.method).toBe('POST');
    expect(create?.pathTemplate).toBe('/pto');
    expect(Object.keys(create?.request.body as Record<string, unknown>).sort()).toEqual([
      'dayPart',
      'endDate',
      'note',
      'startDate',
    ]);
    expect(create?.request.headers['idempotency-key']).toBe(KEY);

    const patch = byName.get('patch');
    expect(patch?.method).toBe('PATCH');
    // Only the changed fields are sent; the stored dates are not written back.
    expect(Object.keys(patch?.request.body as Record<string, unknown>).sort()).toEqual([
      'dayPart',
      'note',
    ]);
    expect((patch?.request.body as Record<string, unknown>)['note']).toBeNull();
    expect(patch?.request.headers['if-match']).toBe('"1"');

    const remove = byName.get('delete');
    expect(remove?.method).toBe('DELETE');
    expect(remove?.request.body).toBeUndefined();
    expect(remove?.request.headers['if-match']).toBe('"1"');

    const page = byName.get('listPage');
    expect(page?.request.query).toEqual({
      start: '2026-05-01',
      end: '2026-05-31',
      userId: OWNER,
      format: 'page',
      limit: '50',
    });
  });

  it('reads the documented answer of every operation', () => {
    const byName = new Map(facts.captures.map((entry) => [entry.name, entry]));
    expect(byName.get('getIdentity')?.status).toBe(200);
    expect(byName.get('listPage')?.status).toBe(200);
    expect(byName.get('getDetail')?.status).toBe(200);
    expect(byName.get('create')?.status).toBe(201);
    expect(byName.get('patch')?.status).toBe(200);
    expect(byName.get('delete')?.status).toBe(204);
    expect(facts.pageItemKeys).toContain('note');
    expect(facts.pageItemKeys).toContain('version');
  });

  it('is deliberately narrower than the document, and says so', () => {
    // The server always sends an explicit nullable note, also where the
    // document only allows it to be omitted. The client always reads that
    // note, so the document has to keep declaring it nullable.
    const record = componentSchema(document, 'PTO');
    expect(record.required).not.toContain('note');
    expect(record.properties?.['note']?.nullable).toBe(true);
    expect(facts.recordKeys).toContain('note');
    expect(facts.detailKeys).toContain('note');

    // The identity answer has a browser-session branch that this client
    // never reads: it is a personal-token client.
    const identity = componentSchema(document, 'PersonalTokenIdentity');
    expect(identity.required).toEqual(['id', 'role', 'auth']);
    expect(facts.identityKeys).toEqual(['id', 'role', 'auth']);

    // The client fails closed: an answer it cannot use is a fixed error and
    // never a value it made up.
    expect(facts.clientMessage).not.toBe(facts.upstreamMessage);
  });

  it('keeps the documented replay, expiry, correlation and rate-limit metadata', () => {
    const headers = responseHeaders(document, '/pto', 'post', '201');
    expect(headers['Idempotency-Replayed']?.enum).toEqual(['false', 'true']);
    expect(headers['Idempotency-Key-Expires-At']?.format).toBe('date-time');
    expect(headers['X-Request-Id']).toBeDefined();

    const rateLimited = responseHeaders(document, '/pto', 'get', '429');
    expect(rateLimited['Retry-After']?.type).toBe('integer');
    expect(rateLimited['X-Request-Id']?.format).toBe('uuid');

    expect(facts.rateLimitMs).toBe(7000);
    expect(facts.correlationId).toBe(CORRELATION_ID);
  });

  it('refuses the answers and the requests the document does not describe', async () => {
    // A paged row may only carry an explicit null note.
    canned = {
      status: 200,
      body: { items: [{ ...PAGE_ITEM, note: 'secret' }], nextCursor: null, hasMore: false },
    };
    await expect(client.listPage({ start: '2026-05-01', end: '2026-05-31' })).rejects.toMatchObject(
      {
        code: 'INVALID_RESPONSE',
      },
    );

    // A page may not carry more rows than the documented maximum.
    canned = {
      status: 200,
      body: {
        items: Array.from({ length: 201 }, (_, index) => ({
          ...PAGE_ITEM,
          id: `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`,
        })),
        nextCursor: null,
        hasMore: false,
      },
    };
    await expect(client.listPage({ start: '2026-05-01', end: '2026-05-31' })).rejects.toMatchObject(
      {
        code: 'INVALID_RESPONSE',
      },
    );

    // The documented create body does not allow a null note.
    await expect(
      client.create(
        { startDate: '2026-05-10', endDate: '2026-05-10', dayPart: 'morning', note: null } as never,
        KEY,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    // The documented precondition is a canonical quoted version.
    await expect(client.patch(PTO_ID, 0, { dayPart: 'evening' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(client.delete(PTO_ID, MAX_VERSION + 1)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});

describe('the contract against a drifted document', () => {
  it('notices a vocabulary that drifted away from the client', () => {
    const drifted = structuredClone(document);
    const dayPart = drifted.components.schemas['DayPart'] as Json;
    const vocabulary = dayPart['enum'] as string[];
    dayPart['enum'] = vocabulary.map((value) => (value === 'all_day' ? 'full_day' : value));

    const differences = checkContract(drifted, facts);
    expect(differences.length).toBeGreaterThan(0);
    const text = describeDifferences(differences);
    expect(text).toContain('components.schemas.DayPart.enum');
    expect(text).toContain('full_day');
  });

  it('notices a bound that drifted away from the client', () => {
    const drifted = structuredClone(document);
    const create = drifted.components.schemas['CreatePTORequest'] as Json;
    const properties = create['properties'] as Record<string, Json>;
    properties['note'] = { ...(properties['note'] as Json), maxLength: 1000 };

    const differences = checkContract(drifted, facts);
    expect(differences.length).toBeGreaterThan(0);
    const text = describeDifferences(differences);
    expect(text).toContain('components.schemas.CreatePTORequest.properties.note.maxLength');
  });

  it('notices a shape that drifted away from the client', () => {
    const drifted = structuredClone(document);
    const detail = drifted.components.schemas['PTODetail'] as Json;
    const parts = detail['allOf'] as Json[];
    parts[1] = { type: 'object', required: [], properties: {} };

    const differences = checkContract(drifted, facts);
    expect(differences.length).toBeGreaterThan(0);
    const text = describeDifferences(differences);
    expect(text).toContain('GET /pto/{id} 200 PTODetail.version');
  });

  it('notices when the PATCH response diverges from the create response contract', () => {
    const drifted = structuredClone(document);
    const response = successSchema(drifted, '/pto/{id}', 'patch', '200', 'PTO');
    expect(response.properties).toHaveProperty('version');
    const patch = operation(drifted, '/pto/{id}', 'PATCH')!;
    (patch['responses'] as Json)['200'] = {
      content: { 'application/json': { schema: { $ref: '#/components/schemas/PTOCalendarPage' } } },
    };
    const differences = checkContract(drifted, facts);
    expect(describeDifferences(differences)).toContain('PATCH /pto/{id} 200 PTO.version');
  });

  it('finds nothing to complain about in the maintained document', () => {
    expect(checkContract(document, facts)).toEqual([]);
  });
});
