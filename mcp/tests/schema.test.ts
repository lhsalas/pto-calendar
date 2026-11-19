import { describe, expect, it } from 'vitest';

import type { PtoPageItem } from '@pto-calendar/api-client';

import {
  GET_INPUT_SCHEMA,
  GET_OUTPUT_SCHEMA,
  INPUT_MESSAGES,
  LIST_INPUT_SCHEMA,
  LIST_OUTPUT_SCHEMA,
  LIST_REASONS,
  MAX_NOTE_LENGTH,
  MAX_OWNER_NAME_LENGTH,
  MAX_RANGE_DAYS,
  PLAIN_SCRUB,
  REDACTED,
  adapterRequestId,
  projectList,
  projectRecord,
  randomRequestId,
  scrubberFor,
  scrubberForCredential,
  validateGetArguments,
  validateListArguments,
  type SchemaNode,
} from '../src/schema.js';

/** The keyword of one schema node, read without a cast at every use. */
function node(value: SchemaNode): Record<string, unknown> {
  return { ...value };
}

/** The properties of one schema node. */
function properties(value: SchemaNode): Record<string, Record<string, unknown>> {
  return node(value)['properties'] as Record<string, Record<string, unknown>>;
}

/** One branch of an envelope schema. */
function branch(value: SchemaNode, index: number): Record<string, unknown> {
  const branches = node(value)['oneOf'] as SchemaNode[];
  return node(branches[index]!);
}

/** The owner summary of a sample record. */
const OWNER = {
  id: '55555555-5555-4555-8555-555555555555',
  name: 'Ada Lovelace',
  colorCode: '#ff8800',
};

/** One sample record of the API. */
const ITEM: PtoPageItem = {
  id: '44444444-4444-4444-8444-444444444444',
  user: OWNER,
  startDate: '2026-03-02',
  endDate: '2026-03-04',
  dayPart: 'all_day',
  note: null,
  version: 3,
};

describe('the advertised input schemas', () => {
  it('are strict objects that name only the documented arguments', () => {
    expect(LIST_INPUT_SCHEMA.type).toBe('object');
    expect(LIST_INPUT_SCHEMA.additionalProperties).toBe(false);
    expect(LIST_INPUT_SCHEMA.required).toEqual(['from', 'to']);
    expect(Object.keys(LIST_INPUT_SCHEMA.properties).sort()).toEqual([
      'from',
      'maxPages',
      'mine',
      'ownerId',
      'pageSize',
      'to',
    ]);

    expect(GET_INPUT_SCHEMA.type).toBe('object');
    expect(GET_INPUT_SCHEMA.additionalProperties).toBe(false);
    expect(GET_INPUT_SCHEMA.required).toEqual(['id']);
    expect(Object.keys(GET_INPUT_SCHEMA.properties).sort()).toEqual(['id', 'includeNote']);
  });

  it('never accept a credential, an origin, a header, a path or a role', () => {
    const forbidden = [
      'token',
      'secret',
      'credential',
      'password',
      'url',
      'origin',
      'host',
      'header',
      'authorization',
      'path',
      'file',
      'role',
      'profile',
      'command',
      'shell',
      'cookie',
      'session',
      'scope',
      'user',
    ];
    for (const schema of [LIST_INPUT_SCHEMA, GET_INPUT_SCHEMA]) {
      for (const key of Object.keys(schema.properties)) {
        expect(forbidden).not.toContain(key);
      }
    }
  });

  it('bound the dates, the identifier and the page counts', () => {
    const list = properties(LIST_INPUT_SCHEMA);
    expect(list['from']!['pattern']).toBe('^\\d{4}-\\d{2}-\\d{2}$');
    expect(list['to']!['pattern']).toBe('^\\d{4}-\\d{2}-\\d{2}$');
    expect(list['ownerId']!['pattern']).toMatch(/^\^\[0-9a-fA-F\]/);
    expect(list['pageSize']!['minimum']).toBe(1);
    expect(list['pageSize']!['maximum']).toBe(100);
    expect(list['maxPages']!['minimum']).toBe(1);
    expect(list['maxPages']!['maximum']).toBe(10);
    expect(list['mine']!['type']).toBe('boolean');

    const get = properties(GET_INPUT_SCHEMA);
    expect(get['id']!['pattern']).toMatch(/^\^\[0-9a-fA-F\]/);
    expect(get['includeNote']!['type']).toBe('boolean');
  });
});

describe('the advertised output schemas', () => {
  it('are closed envelopes with a success branch and an error branch', () => {
    for (const schema of [LIST_OUTPUT_SCHEMA, GET_OUTPUT_SCHEMA]) {
      expect(schema.type).toBe('object');
      const branches = node(schema)['oneOf'] as SchemaNode[];
      expect(branches).toHaveLength(2);

      const success = branch(schema, 0);
      expect(success['additionalProperties']).toBe(false);
      expect(success['required']).toEqual(['schemaVersion', 'requestId', 'ok', 'tool', 'data']);

      const failure = branch(schema, 1);
      expect(failure['additionalProperties']).toBe(false);
      expect(failure['required']).toEqual(['schemaVersion', 'requestId', 'ok', 'tool', 'error']);
    }
  });

  it('name the schema version, the request identifier and the tool', () => {
    const success = branch(LIST_OUTPUT_SCHEMA, 0);
    const successProperties = properties(success as SchemaNode);
    expect(successProperties['schemaVersion']!['const']).toBe(1);
    expect(successProperties['requestId']!['pattern']).toMatch(/^\^\[0-9a-f\]/);
    expect(successProperties['ok']!['const']).toBe(true);
    expect(successProperties['tool']!['const']).toBe('pto_list');

    const failure = branch(GET_OUTPUT_SCHEMA, 1);
    const failureProperties = properties(failure as SchemaNode);
    expect(failureProperties['ok']!['const']).toBe(false);
    expect(failureProperties['tool']!['const']).toBe('pto_get');
  });

  it('keep the partial rows for the list tool only', () => {
    expect(properties(branch(LIST_OUTPUT_SCHEMA, 1) as SchemaNode)['partial']).toBeDefined();
    expect(properties(branch(GET_OUTPUT_SCHEMA, 1) as SchemaNode)['partial']).toBeUndefined();
  });

  it('bound the rows, the strings and the error members', () => {
    const data = properties(branch(LIST_OUTPUT_SCHEMA, 0) as SchemaNode)['data'] as SchemaNode;
    const dataProperties = properties(data);
    expect(dataProperties['items']!['maxItems']).toBe(250);
    expect(dataProperties['reason']!['enum']).toEqual([...LIST_REASONS]);

    const error = properties(branch(LIST_OUTPUT_SCHEMA, 1) as SchemaNode)['error'] as SchemaNode;
    const errorProperties = properties(error);
    expect(errorProperties['code']!['enum']).toContain('AUTH');
    expect(errorProperties['status']!['type']).toEqual(['integer', 'null']);
    expect(errorProperties['upstreamRequestId']!['type']).toEqual(['string', 'null']);
    expect(errorProperties['retryAfterMs']!['type']).toEqual(['integer', 'null']);
  });
});

describe('the list arguments', () => {
  it('accept a bounded range and apply the documented defaults', () => {
    const parsed = validateListArguments({ from: '2026-03-02', to: '2026-03-04' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      name: 'pto_list',
      from: '2026-03-02',
      to: '2026-03-04',
      mine: false,
      pageSize: 50,
      maxPages: 6,
    });
  });

  it('keep the values the caller chose', () => {
    const parsed = validateListArguments({
      from: '2026-03-02',
      to: '2026-03-04',
      ownerId: '55555555-5555-4555-8555-555555555555',
      mine: false,
      pageSize: 25,
      maxPages: 2,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.ownerId).toBe('55555555-5555-4555-8555-555555555555');
    expect(parsed.value.pageSize).toBe(25);
    expect(parsed.value.maxPages).toBe(2);
  });

  it('refuse anything that is not a plain object', () => {
    for (const input of [null, undefined, 42, 'text', [], [{ from: '2026-03-02' }]]) {
      const parsed = validateListArguments(input);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.code).toBe('INPUT');
      expect(parsed.message).toBe(INPUT_MESSAGES.notAnObject);
    }
  });

  it('refuse an object with a prototype of its own', () => {
    const hostile = Object.create({ from: '2026-03-02', to: '2026-03-04' }) as Record<
      string,
      unknown
    >;
    const parsed = validateListArguments(hostile);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toBe(INPUT_MESSAGES.notAnObject);
  });

  it('refuse an unknown argument', () => {
    const parsed = validateListArguments({
      from: '2026-03-02',
      to: '2026-03-04',
      token: 'secret',
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toBe(INPUT_MESSAGES.unknownField);
  });

  it('refuse an argument that tries to change a prototype', () => {
    const hostile = JSON.parse(
      '{"__proto__": {"polluted": true}, "from": "2026-03-02", "to": "2026-03-04"}',
    ) as Record<string, unknown>;
    const parsed = validateListArguments(hostile);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toBe(INPUT_MESSAGES.unknownField);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('accept an object without a prototype', () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, {
      from: '2026-03-02',
      to: '2026-03-04',
    });
    const parsed = validateListArguments(bare);
    expect(parsed.ok).toBe(true);
  });

  it('never call an accessor and never read a non-enumerable property', () => {
    let called = false;
    const hostile = {
      from: '2026-03-02',
      to: '2026-03-04',
      get mine(): boolean {
        called = true;
        return true;
      },
    };
    const parsed = validateListArguments(hostile);
    expect(called).toBe(false);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toBe(INPUT_MESSAGES.wrongType);

    const hidden = Object.defineProperty({ from: '2026-03-02', to: '2026-03-04' }, 'token', {
      value: 'secret',
      enumerable: false,
    });
    const refused = validateListArguments(hidden);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.message).toBe(INPUT_MESSAGES.unknownField);
  });

  it('refuse a missing or mistyped range', () => {
    const missing = validateListArguments({ from: '2026-03-02' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toBe(INPUT_MESSAGES.missingField);

    const mistyped = validateListArguments({ from: 20260302, to: '2026-03-04' });
    expect(mistyped.ok).toBe(false);
    if (!mistyped.ok) expect(mistyped.message).toBe(INPUT_MESSAGES.wrongType);
  });

  it('refuse a date that is not a real calendar day', () => {
    for (const from of [
      '2026-02-30',
      '2026-13-01',
      '2026-3-2',
      'not-a-date',
      '2026-03-02T00:00:00Z',
    ]) {
      const parsed = validateListArguments({ from, to: '2026-03-04' });
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.message).toBe(INPUT_MESSAGES.invalidDate);
    }
  });

  it('refuse a range that is reversed or longer than 366 days', () => {
    const reversed = validateListArguments({ from: '2026-03-04', to: '2026-03-02' });
    expect(reversed.ok).toBe(false);
    if (!reversed.ok) expect(reversed.message).toBe(INPUT_MESSAGES.invalidRange);

    const tooLong = validateListArguments({ from: '2026-01-01', to: '2027-01-02' });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.message).toBe(INPUT_MESSAGES.invalidRange);

    const longest = validateListArguments({ from: '2026-01-01', to: '2027-01-01' });
    expect(longest.ok).toBe(true);
    expect(MAX_RANGE_DAYS).toBe(366);
  });

  it('refuse an owner that is not a canonical identifier', () => {
    const parsed = validateListArguments({
      from: '2026-03-02',
      to: '2026-03-04',
      ownerId: 'not-a-uuid',
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toBe(INPUT_MESSAGES.invalidUuid);
  });

  it('refuse the two owner filters together', () => {
    const parsed = validateListArguments({
      from: '2026-03-02',
      to: '2026-03-04',
      ownerId: '55555555-5555-4555-8555-555555555555',
      mine: true,
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toBe(INPUT_MESSAGES.ownerConflict);
  });

  it('refuse a page size and a page count outside their bounds', () => {
    for (const pageSize of [0, 101, 1.5, '50', Number.NaN]) {
      const parsed = validateListArguments({
        from: '2026-03-02',
        to: '2026-03-04',
        pageSize,
      });
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.message).toBe(INPUT_MESSAGES.invalidPageSize);
    }
    for (const maxPages of [0, 11, 2.5, '6']) {
      const parsed = validateListArguments({
        from: '2026-03-02',
        to: '2026-03-04',
        maxPages,
      });
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.message).toBe(INPUT_MESSAGES.invalidMaxPages);
    }
  });

  it('refuse an accessor of a bounded argument', () => {
    const hostile = {
      from: '2026-03-02',
      to: '2026-03-04',
      get pageSize(): number {
        return 10;
      },
    };
    const parsed = validateListArguments(hostile);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toBe(INPUT_MESSAGES.wrongType);
  });

  it('refuse an accessor of the owner and of the page count', () => {
    const owner = {
      from: '2026-03-02',
      to: '2026-03-04',
      get ownerId(): string {
        return '55555555-5555-4555-8555-555555555555';
      },
    };
    const refusedOwner = validateListArguments(owner);
    expect(refusedOwner.ok).toBe(false);
    if (!refusedOwner.ok) expect(refusedOwner.message).toBe(INPUT_MESSAGES.wrongType);

    const pages = {
      from: '2026-03-02',
      to: '2026-03-04',
      get maxPages(): number {
        return 2;
      },
    };
    const refusedPages = validateListArguments(pages);
    expect(refusedPages.ok).toBe(false);
    if (!refusedPages.ok) expect(refusedPages.message).toBe(INPUT_MESSAGES.wrongType);
  });

  it('refuse an own-records filter that is not a boolean', () => {
    const parsed = validateListArguments({
      from: '2026-03-02',
      to: '2026-03-04',
      mine: 'yes',
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toBe(INPUT_MESSAGES.wrongType);
  });
});

describe('the detail arguments', () => {
  it('accept a canonical identifier and default the note opt-in to false', () => {
    const parsed = validateGetArguments({ id: '44444444-4444-4444-8444-444444444444' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      name: 'pto_get',
      id: '44444444-4444-4444-8444-444444444444',
      includeNote: false,
    });
  });

  it('keep an explicit note opt-in', () => {
    const parsed = validateGetArguments({
      id: '44444444-4444-4444-8444-444444444444',
      includeNote: true,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.includeNote).toBe(true);
  });

  it('refuse anything that is not a plain object', () => {
    const parsed = validateGetArguments('id');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toBe(INPUT_MESSAGES.notAnObject);
  });

  it('refuse an unknown argument', () => {
    const parsed = validateGetArguments({
      id: '44444444-4444-4444-8444-444444444444',
      note: true,
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toBe(INPUT_MESSAGES.unknownField);
  });

  it('refuse a missing or mistyped identifier', () => {
    const missing = validateGetArguments({});
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toBe(INPUT_MESSAGES.missingField);

    const mistyped = validateGetArguments({ id: 42 });
    expect(mistyped.ok).toBe(false);
    if (!mistyped.ok) expect(mistyped.message).toBe(INPUT_MESSAGES.wrongType);
  });

  it('refuse an identifier that is not canonical', () => {
    const parsed = validateGetArguments({ id: '44444444-4444-4444-8444' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toBe(INPUT_MESSAGES.invalidUuid);
  });

  it('refuse a note opt-in that is not a boolean', () => {
    const parsed = validateGetArguments({
      id: '44444444-4444-4444-8444-444444444444',
      includeNote: 'true',
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toBe(INPUT_MESSAGES.wrongType);
  });
});

describe('the redaction', () => {
  const token = `pto_pat_11111111-1111-4111-8111-111111111111.${'a'.repeat(64)}`;
  const secret = 'a'.repeat(64);

  it('removes control characters and collapses whitespace', () => {
    expect(PLAIN_SCRUB('Ada\u0000 Lovelace')).toBe('Ada Lovelace');
    expect(PLAIN_SCRUB('line\nbreak')).toBe('linebreak');
    expect(PLAIN_SCRUB('\u0007')).toBe('');
  });

  it('removes a known secret, its secret part and its digest', () => {
    const scrub = scrubberForCredential(token);
    expect(scrub(`token ${token}`)).toBe(`token ${REDACTED}`);
    expect(scrub(`secret ${secret}`)).toBe(`secret ${REDACTED}`);
    expect(scrub('a'.repeat(64))).toBe(REDACTED);
  });

  it('removes a token-shaped string that was never known', () => {
    const scrub = scrubberFor([]);
    expect(scrub(`hostile pto_pat_abcdef${'0'.repeat(8)} here`)).toContain(REDACTED);
    expect(scrub(`hostile pto_pat_abcdef${'0'.repeat(8)} here`)).not.toContain('pto_pat_');
  });

  it('removes a secret of its own', () => {
    const scrub = scrubberFor(['s3cr3t(value)']);
    expect(scrub('a s3cr3t(value) b')).toBe(`a ${REDACTED} b`);
  });

  it('keeps a plain text untouched', () => {
    expect(PLAIN_SCRUB('Ada Lovelace')).toBe('Ada Lovelace');
    expect(PLAIN_SCRUB('Family day')).toBe('Family day');
  });
});

describe('the projection', () => {
  it('carries only the allowlisted fields', () => {
    const scrub = PLAIN_SCRUB;
    const record = projectRecord(ITEM, scrub, false);
    expect(Object.keys(record).sort()).toEqual([
      'dayPart',
      'endDate',
      'id',
      'note',
      'owner',
      'startDate',
      'version',
    ]);
    expect(Object.keys(record.owner).sort()).toEqual(['id', 'name']);
    expect(record.owner.name).toBe('Ada Lovelace');
  });

  it('never carries a note without an explicit opt-in', () => {
    const withNote = { ...ITEM, note: 'Family day' };
    expect(projectRecord(withNote, PLAIN_SCRUB, false).note).toBeNull();
    expect(projectRecord(withNote, PLAIN_SCRUB, true).note).toBe('Family day');
  });

  it('keeps a null note null', () => {
    expect(projectRecord(ITEM, PLAIN_SCRUB, true).note).toBeNull();
  });

  it('bounds the owner name and the note', () => {
    const long = {
      ...ITEM,
      user: { ...OWNER, name: 'x'.repeat(MAX_OWNER_NAME_LENGTH + 50) },
      note: 'y'.repeat(MAX_NOTE_LENGTH + 50),
    };
    const record = projectRecord(long, PLAIN_SCRUB, true);
    expect(Array.from(record.owner.name)).toHaveLength(MAX_OWNER_NAME_LENGTH);
    expect(Array.from(record.note ?? '')).toHaveLength(MAX_NOTE_LENGTH);
  });

  it('never carries a note in a list', () => {
    const list = projectList([{ ...ITEM, note: 'Family day' }], true, 'complete', 1, PLAIN_SCRUB);
    expect(list.items[0]!.note).toBeNull();
    expect(list.complete).toBe(true);
    expect(list.reason).toBe('complete');
    expect(list.pages).toBe(1);
  });

  it('caps the rows of a list at the documented bound', () => {
    const rows = Array.from({ length: 300 }, () => ITEM);
    const list = projectList(rows, true, 'complete', 10, PLAIN_SCRUB);
    expect(list.items).toHaveLength(250);
    expect(list).toMatchObject({ complete: false, reason: 'budget', pages: 10 });
  });
});

describe('the request identifier of the adapter', () => {
  it('keeps a canonical identifier', () => {
    const identifier = '66666666-6666-4666-8666-666666666666';
    expect(adapterRequestId(identifier)).toBe(identifier);
  });

  it('replaces an identifier that is not canonical', () => {
    const replaced = adapterRequestId('not-an-identifier');
    expect(replaced).not.toBe('not-an-identifier');
    expect(replaced).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('generates a canonical identifier of its own', () => {
    expect(randomRequestId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
