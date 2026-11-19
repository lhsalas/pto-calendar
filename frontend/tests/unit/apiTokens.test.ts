import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api/client';
import { issueToken, listTokens } from '../../src/api/tokens';
import type { IssueTokenRequest, TokenMetadata } from '../../src/types/api';
import { STUB_RAW_TOKEN, STUB_TOKEN } from '../mocks/handlers';
import { server } from '../mocks/server';

/** A valid record with the public prefix that belongs to the given id. */
function tokenWith(id: string, overrides: Partial<TokenMetadata> = {}): TokenMetadata {
  return { ...STUB_TOKEN, id, displayPrefix: `pto_pat_${id}`, ...overrides };
}

const PAYLOAD: IssueTokenRequest = {
  name: 'Laptop',
  password: 'current-password',
  scopes: ['pto:read'],
  expiresInDays: 90,
};

const METADATA_KEYS = [
  'createdAt',
  'displayPrefix',
  'expiresAt',
  'id',
  'lastUsedAt',
  'name',
  'revokedAt',
  'scopes',
  'status',
];

function respondWithList(body: unknown): void {
  server.use(http.get('/auth/tokens', () => HttpResponse.json(body as never)));
}

function respondWithIssuance(body: unknown): void {
  server.use(http.post('/auth/tokens', () => HttpResponse.json(body as never, { status: 201 })));
}

/** Asserts the fixed, non-echoing failure the adapter uses for a bad answer. */
async function expectBadResponse(promise: Promise<unknown>): Promise<ApiError> {
  const outcome = await promise.then(
    () => {
      throw new Error('the adapter accepted a malformed answer');
    },
    (err: unknown) => err,
  );
  expect(outcome).toBeInstanceOf(ApiError);
  const error = outcome as ApiError;
  expect(error.status).toBe(0);
  expect(error.body.code).toBe('BAD_RESPONSE');
  expect(error.body.message).toBe('The server returned an invalid token response.');
  return error;
}

describe('listTokens response validation', () => {
  it('returns the decoded metadata of a valid list', async () => {
    respondWithList({ tokens: [STUB_TOKEN] });
    const tokens = await listTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual(STUB_TOKEN);
    expect(Object.keys(tokens[0]!).sort()).toEqual(METADATA_KEYS);
  });

  it('keeps an empty list authoritative', async () => {
    respondWithList({ tokens: [] });
    await expect(listTokens()).resolves.toEqual([]);
  });

  it('accepts an absolute offset timestamp for a real calendar day', async () => {
    const token = { ...STUB_TOKEN, createdAt: '2024-02-29T20:30:00+05:30' };
    respondWithList({ tokens: [token] });
    await expect(listTokens()).resolves.toEqual([token]);
  });

  it('keeps every legitimate status and scope', async () => {
    respondWithList({
      tokens: [
        tokenWith('11111111-1111-1111-1111-111111111111', { status: 'expired' }),
        tokenWith('22222222-2222-2222-2222-222222222222', {
          status: 'revoked',
          revokedAt: '2026-07-01T10:00:00.000Z',
        }),
        tokenWith('33333333-3333-3333-3333-333333333333', { status: 'invalidated' }),
        tokenWith('44444444-4444-4444-4444-444444444444', {
          status: 'active',
          lastUsedAt: '2026-07-02T10:00:00.000Z',
          scopes: ['pto:read', 'pto:notes:read', 'pto:update:team'],
        }),
      ],
    });
    const tokens = await listTokens();
    expect(tokens.map((token) => token.status)).toEqual([
      'expired',
      'revoked',
      'invalidated',
      'active',
    ]);
    expect(tokens[3]!.scopes).toEqual(['pto:read', 'pto:notes:read', 'pto:update:team']);
    expect(tokens[1]!.revokedAt).toBe('2026-07-01T10:00:00.000Z');
    expect(tokens[3]!.lastUsedAt).toBe('2026-07-02T10:00:00.000Z');
  });

  it('drops unknown properties instead of keeping them', async () => {
    respondWithList({
      tokens: [
        {
          ...STUB_TOKEN,
          secretDigest: 'a'.repeat(64),
          rawToken: STUB_RAW_TOKEN,
          issuedSessionVersion: 3,
          ownerId: '99999999-9999-9999-9999-999999999999',
        },
      ],
    });
    const tokens = await listTokens();
    const token = tokens[0]!;
    expect(Object.keys(token).sort()).toEqual(METADATA_KEYS);
    expect(token).not.toHaveProperty('secretDigest');
    expect(token).not.toHaveProperty('rawToken');
    expect(token).not.toHaveProperty('issuedSessionVersion');
    expect(token).not.toHaveProperty('ownerId');
    expect(JSON.stringify(token)).not.toContain(STUB_RAW_TOKEN);
  });

  it.each([
    ['a missing list', {}],
    ['a null list', { tokens: null }],
    ['a list that is not an array', { tokens: {} }],
    ['a null body', null],
    ['a body that is not an object', []],
  ])('refuses %s', async (_label, body) => {
    respondWithList(body);
    await expectBadResponse(listTokens());
  });

  it.each([
    ['a null member', null],
    ['an empty member', {}],
    ['a member without a name', { ...STUB_TOKEN, name: undefined }],
    ['a member without an expiry', { ...STUB_TOKEN, expiresAt: undefined }],
    ['a member without a creation date', { ...STUB_TOKEN, createdAt: undefined }],
    ['a member without a status', { ...STUB_TOKEN, status: undefined }],
    ['a member without an id', { ...STUB_TOKEN, id: undefined }],
    ['a member without a prefix', { ...STUB_TOKEN, displayPrefix: undefined }],
    ['a member without scopes', { ...STUB_TOKEN, scopes: undefined }],
    ['a member with a blank name', { ...STUB_TOKEN, name: '   ' }],
    ['a member with an overlong name', { ...STUB_TOKEN, name: 'x'.repeat(121) }],
    ['a member with an unsupported scope', { ...STUB_TOKEN, scopes: ['pto:read', 'pto:all'] }],
    ['a member with a scope that is not a string', { ...STUB_TOKEN, scopes: ['pto:read', 7] }],
    ['a member with an empty scope list', { ...STUB_TOKEN, scopes: [] }],
    ['a member with an unparseable date', { ...STUB_TOKEN, createdAt: 'yesterday' }],
    ['a member with a local date', { ...STUB_TOKEN, createdAt: '2026-06-01T10:00:00' }],
    ['a member with a date only', { ...STUB_TOKEN, expiresAt: '2026-09-01' }],
    ['a member with an impossible month', { ...STUB_TOKEN, expiresAt: '2026-13-01T10:00:00.000Z' }],
    ['a member with a rollover day', { ...STUB_TOKEN, expiresAt: '2026-02-30T10:00:00.000Z' }],
    ['a member with an unknown status', { ...STUB_TOKEN, status: 'unknown' }],
    ['a member with an unusable last-used date', { ...STUB_TOKEN, lastUsedAt: 'yesterday' }],
    ['a member with a revoked date that is not a date', { ...STUB_TOKEN, revokedAt: 42 }],
    ['a member with an id that is not an id', { ...STUB_TOKEN, id: 'not-an-id' }],
    [
      'a member with a prefix that is not the public one',
      { ...STUB_TOKEN, displayPrefix: 'pto_pat_' },
    ],
    [
      'a member whose prefix carries a secret',
      { ...STUB_TOKEN, displayPrefix: `${STUB_TOKEN.displayPrefix}.${'a'.repeat(64)}` },
    ],
  ])('refuses %s', async (_label, member) => {
    respondWithList({ tokens: [member] });
    await expectBadResponse(listTokens());
  });

  it('refuses a list whose second member is malformed', async () => {
    respondWithList({ tokens: [STUB_TOKEN, { ...STUB_TOKEN, status: 'unknown' }] });
    await expectBadResponse(listTokens());
  });
});

describe('issueToken response validation', () => {
  it('returns the raw token and the decoded metadata of a valid issuance', async () => {
    respondWithIssuance({ rawToken: STUB_RAW_TOKEN, token: STUB_TOKEN });
    const response = await issueToken(PAYLOAD);
    expect(response.rawToken).toBe(STUB_RAW_TOKEN);
    expect(response.token).toEqual(STUB_TOKEN);
    expect(Object.keys(response.token).sort()).toEqual(METADATA_KEYS);
  });

  it.each([
    ['an empty answer', {}],
    ['a null answer', null],
    ['an answer without a raw token', { token: STUB_TOKEN }],
    ['an answer without metadata', { rawToken: STUB_RAW_TOKEN }],
    ['a raw token that is not a string', { rawToken: 42, token: STUB_TOKEN }],
    ['a raw token with a malformed secret', { rawToken: 'pto_pat_nope', token: STUB_TOKEN }],
    [
      'a raw token with a malformed public part',
      { rawToken: `pto_pat_x.${'a'.repeat(64)}`, token: STUB_TOKEN },
    ],
    [
      'a raw token whose secret is too short',
      { rawToken: `${STUB_TOKEN.displayPrefix}.abc`, token: STUB_TOKEN },
    ],
    [
      'a raw token that belongs to another token',
      {
        rawToken: `pto_pat_dddddddd-dddd-dddd-dddd-dddddddddddd.${'a'.repeat(64)}`,
        token: STUB_TOKEN,
      },
    ],
    [
      'a partially populated metadata record',
      { rawToken: STUB_RAW_TOKEN, token: { id: STUB_TOKEN.id, scopes: ['pto:read'] } },
    ],
    [
      'a metadata record without a status',
      { rawToken: STUB_RAW_TOKEN, token: { ...STUB_TOKEN, status: undefined } },
    ],
    [
      'a metadata record without an expiry',
      { rawToken: STUB_RAW_TOKEN, token: { ...STUB_TOKEN, expiresAt: undefined } },
    ],
    [
      'a metadata record with a secret in the prefix',
      {
        rawToken: STUB_RAW_TOKEN,
        token: { ...STUB_TOKEN, displayPrefix: `${STUB_TOKEN.displayPrefix}.${'a'.repeat(64)}` },
      },
    ],
  ])('refuses %s', async (_label, body) => {
    respondWithIssuance(body);
    const error = await expectBadResponse(issueToken(PAYLOAD));
    // The refused answer is never echoed and the secret never survives it.
    expect(error.message).not.toContain(STUB_RAW_TOKEN);
    expect(JSON.stringify(error.body)).not.toContain(STUB_RAW_TOKEN);
  });

  it('never returns the raw token of a refused issuance', async () => {
    respondWithIssuance({ rawToken: STUB_RAW_TOKEN, token: { id: STUB_TOKEN.id } });
    const outcome = await issueToken(PAYLOAD).then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(String(outcome.err)).not.toContain(STUB_RAW_TOKEN);
    expect(String(outcome.err)).not.toContain(STUB_RAW_TOKEN.split('.')[1]!);
    expect(JSON.stringify(outcome.err)).not.toContain(STUB_RAW_TOKEN);
  });
});

describe('credential request options', () => {
  it('keeps no-store and the redirect guard on listing and issuance', async () => {
    const captured: RequestInit[] = [];
    // The mock replaces the intercepted fetch for this test only; the mock
    // server's own fetch is restored afterwards.
    const intercepted = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.push(init ?? {});
      const isIssue = init?.method === 'POST';
      const body = isIssue
        ? { rawToken: STUB_RAW_TOKEN, token: STUB_TOKEN }
        : { tokens: [STUB_TOKEN] };
      return {
        status: isIssue ? 201 : 200,
        ok: true,
        statusText: 'OK',
        text: async () => JSON.stringify(body),
      } as Response;
    }) as unknown as typeof fetch;

    try {
      await listTokens();
      await issueToken(PAYLOAD);
    } finally {
      globalThis.fetch = intercepted;
    }
    expect(captured).toHaveLength(2);
    for (const init of captured) {
      expect(init.cache).toBe('no-store');
      expect(init.redirect).toBe('error');
    }
    // The issuance keeps its real deadline, so the request itself is aborted.
    expect(captured[1]?.signal).toBeDefined();
    expect(captured[0]?.signal).toBeUndefined();
    expect(String(captured[1]?.body)).toContain('"name":"Laptop"');
  });
});
