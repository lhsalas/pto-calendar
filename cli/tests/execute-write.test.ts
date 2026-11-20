import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  AgentAuthError,
  type AgentAuth,
  type AgentAuthCredential,
  type ResolveInput,
} from '@pto-calendar/agent-auth';
import {
  PtoApiError,
  type CreatePtoResult,
  type PtoClientOptions,
  type PtoDetail,
  type PtoIdentity,
  type PtoRecord,
} from '@pto-calendar/api-client';

import type { CliSuccessFor, ReadAuthOptions } from '../src/contract.js';
import {
  CreateIntentError,
  withCreateIntent,
  type CreateIntentBinding,
  type CreateIntentLease,
} from '../src/create-intent.js';
import {
  executeWrite,
  type CreateJournal,
  type WriteClient,
  type WriteContext,
  type WriteDependencies,
  type WriteResult,
} from '../src/execute-write.js';
import type { WriteCommand } from '../src/write-contract.js';

/*
 * Synthetic fixtures only. The token is a shape-valid fake that never authenticates
 * anything, and every store, client and journal below is an in-memory double, except
 * the one integration block at the end, which uses the real journal inside a
 * temporary HOME that is removed afterwards.
 */

const ORIGIN = 'https://pto.example.com';
const SECRET = '0123456789abcdef'.repeat(4);
const DIGEST = createHash('sha256').update(SECRET, 'utf8').digest('hex');
const TOKEN_ID = '55555555-5555-4555-8555-555555555555';
const TOKEN = `pto_pat_${TOKEN_ID}.${SECRET}`;
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '66666666-6666-4666-8666-666666666666';
const ENTRY_ID = '44444444-4444-4444-8444-444444444444';
const OP_ID = '77777777-7777-4777-8777-777777777777';
const FRESH_OP = '88888888-8888-4888-8888-888888888888';
const KEY = 'v1.1795000000000.8a4f2c1e-5b7d-4c3a-9e1f-2d6b8a0c4e7f';
const REQUEST_ID = 'req-20261119-0001';
const ISSUED_MS = 1_795_000_000_000;
const EXPIRES_AT = new Date(ISSUED_MS + 86_400_000).toISOString();
const READ: ReadAuthOptions = { allowLoopbackHttp: false };
const MORNING = { startDate: '2026-12-01', endDate: '2026-12-01', dayPart: 'morning' };

const BUNDLE: AgentAuthCredential = {
  baseUrl: ORIGIN,
  credential: { origin: ORIGIN, token: TOKEN },
  allowLoopbackHttp: false,
  profile: 'default',
  source: 'keyring',
};

const MEMBER_SCOPES = ['pto:read', 'pto:create', 'pto:update:self', 'pto:delete:self'] as const;

function identityOf(
  overrides: Partial<PtoIdentity> = {},
  scopes: readonly string[] = MEMBER_SCOPES,
): PtoIdentity {
  return {
    id: OWNER_ID,
    role: 'member',
    auth: {
      method: 'pat',
      tokenId: TOKEN_ID,
      scopes: [...scopes] as PtoIdentity['auth']['scopes'],
      expiresAt: '2027-01-01T00:00:00.000Z',
    },
    ...overrides,
  };
}

function detailOf(overrides: Partial<PtoDetail> = {}): PtoDetail {
  return {
    id: ENTRY_ID,
    user: { id: OWNER_ID, name: 'Ada Lovelace', colorCode: '#3366ff' },
    startDate: '2026-12-01',
    endDate: '2026-12-01',
    dayPart: 'morning',
    note: null,
    version: 2,
    ...overrides,
  };
}

function recordOf(overrides: Partial<PtoRecord> = {}): PtoRecord {
  return {
    id: ENTRY_ID,
    userId: OWNER_ID,
    startDate: '2026-12-01',
    endDate: '2026-12-01',
    dayPart: 'morning',
    note: null,
    createdAt: '2026-11-19T10:00:00.000Z',
    updatedAt: '2026-11-19T10:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

const CREATED: CreatePtoResult = { record: recordOf(), replayed: false, expiresAt: EXPIRES_AT };

/** A command as the argument parser would hand it over. Invalid values are cast on purpose. */
function command(fields: Record<string, unknown>): WriteCommand {
  return { auth: READ, yes: true, ...fields } as unknown as WriteCommand;
}

function createCmd(fields: Record<string, unknown> = {}): WriteCommand {
  return command({ kind: 'create', payload: { ...MORNING }, ...fields });
}

function updateCmd(fields: Record<string, unknown> = {}): WriteCommand {
  return command({
    kind: 'update',
    id: ENTRY_ID,
    version: 2,
    changes: { dayPart: 'evening' },
    ...fields,
  });
}

function deleteCmd(fields: Record<string, unknown> = {}): WriteCommand {
  return command({ kind: 'delete', id: ENTRY_ID, version: 2, ...fields });
}

/** The context of one run: the terminal, the host's confirmation and the optional hook. */
interface Harness {
  readonly context: WriteContext;
  readonly controller: AbortController;
  readonly confirm: Mock<(preview: string) => Promise<boolean>>;
  readonly publish: Mock<(result: CliSuccessFor<'create'>) => Promise<boolean>> | undefined;
}

function harness(
  options: {
    interactive?: boolean;
    env?: NodeJS.ProcessEnv;
    controller?: AbortController;
    confirm?: (preview: string) => Promise<boolean>;
    publish?: (result: CliSuccessFor<'create'>) => Promise<boolean>;
  } = {},
): Harness {
  const controller = options.controller ?? new AbortController();
  const confirm = vi.fn<(preview: string) => Promise<boolean>>(
    options.confirm ?? (async () => true),
  );
  const publish =
    options.publish === undefined
      ? undefined
      : vi.fn<(result: CliSuccessFor<'create'>) => Promise<boolean>>(options.publish);
  const context: WriteContext = {
    env: options.env ?? { PTO_CLI_WRITES: '1' },
    input: new PassThrough(),
    interactive: options.interactive ?? false,
    signal: controller.signal,
    prompt: () => undefined,
    confirm,
    ...(publish === undefined ? {} : { publishCreateResult: publish }),
  };
  return { context, controller, confirm, publish };
}

/** The client of one run. Every operation is a spy, and each one answers with a safe default. */
interface ClientDouble {
  readonly client: WriteClient;
  readonly getIdentity: Mock<WriteClient['getIdentity']>;
  readonly getDetail: Mock<WriteClient['getDetail']>;
  readonly create: Mock<WriteClient['create']>;
  readonly patch: Mock<WriteClient['patch']>;
  readonly delete: Mock<WriteClient['delete']>;
}

function clientDouble(options: { identity?: PtoIdentity; detail?: PtoDetail } = {}): ClientDouble {
  const identity = options.identity ?? identityOf();
  const detail = options.detail ?? detailOf();
  const getIdentity = vi.fn<WriteClient['getIdentity']>(async () => identity);
  const getDetail = vi.fn<WriteClient['getDetail']>(async () => detail);
  const create = vi.fn<WriteClient['create']>(async () => CREATED);
  const patch = vi.fn<WriteClient['patch']>(async () =>
    recordOf({ version: 3, dayPart: 'evening' }),
  );
  const remove = vi.fn<WriteClient['delete']>(async () => undefined);
  const client: WriteClient = { getIdentity, getDetail, create, patch, delete: remove };
  return { client, getIdentity, getDetail, create, patch, delete: remove };
}

/** The journal of one run. The plan decides where a refusal, a hook or a failure happens. */
interface JournalPlan {
  /** Runs at entry, before admission and before any refusal. */
  readonly onEntry?: () => void;
  /** Thrown instead of admitting the request. */
  readonly refuse?: unknown;
  /** Runs after admission and before the callback starts. */
  readonly beforeAct?: () => void;
  /** Thrown after the callback settled. */
  readonly afterAct?: unknown;
  /** Makes `complete()` throw, as a storage failure would. */
  readonly completeFails?: boolean;
  /** The operation identifier of a fresh intent. */
  readonly operationId?: string;
}

interface LeaseLog {
  readonly key: string;
  readonly operationId: string;
  readonly complete: Mock<() => void>;
}

interface JournalCall {
  readonly binding: CreateIntentBinding;
  readonly payload: unknown;
  readonly operationId: string | null | undefined;
  readonly signal: AbortSignal | undefined;
}

interface JournalDouble {
  readonly journal: CreateJournal;
  readonly calls: JournalCall[];
  readonly leases: LeaseLog[];
}

function journalDouble(plan: JournalPlan = {}): JournalDouble {
  const calls: JournalCall[] = [];
  const leases: LeaseLog[] = [];
  const journal: CreateJournal = async (binding, payload, operationId, act, options) => {
    calls.push({ binding, payload, operationId, signal: options?.signal });
    plan.onEntry?.();
    if (plan.refuse !== undefined) throw plan.refuse;
    const intent = {
      operationId: operationId ?? plan.operationId ?? FRESH_OP,
      key: KEY,
      expiresAt: EXPIRES_AT,
    };
    const complete = vi.fn<() => void>(() => {
      if (plan.completeFails === true) throw new Error('storage failed at complete');
    });
    leases.push({ key: KEY, operationId: intent.operationId, complete });
    const lease: CreateIntentLease = { intent, complete };
    plan.beforeAct?.();
    const value = await act(lease);
    if (plan.afterAct !== undefined) throw plan.afterAct;
    return value;
  };
  return { journal, calls, leases };
}

/** The credential double. Resolution either returns the bundle or refuses with the given error. */
function authDouble(options: { bundle?: AgentAuthCredential; error?: unknown } = {}): {
  readonly auth: AgentAuth;
  readonly resolve: Mock<(input?: ResolveInput) => Promise<AgentAuthCredential>>;
} {
  const resolve = vi.fn<(input?: ResolveInput) => Promise<AgentAuthCredential>>(async () => {
    if (options.error !== undefined) throw options.error;
    return options.bundle ?? BUNDLE;
  });
  const unused = (): Promise<never> => Promise.reject(new Error('not used by a write'));
  const auth: AgentAuth = {
    setProfile: unused,
    resolve,
    status: unused,
    removeProfile: unused,
  };
  return { auth, resolve };
}

interface Rig {
  readonly deps: WriteDependencies;
  readonly client: ClientDouble;
  readonly journal: JournalDouble;
  readonly auth: ReturnType<typeof authDouble>;
  readonly createAuth: Mock<() => AgentAuth>;
  readonly createClient: Mock<(options: PtoClientOptions) => WriteClient>;
}

function rig(
  options: {
    client?: ClientDouble;
    journal?: JournalPlan;
    auth?: ReturnType<typeof authDouble>;
    identity?: PtoIdentity;
    detail?: PtoDetail;
  } = {},
): Rig {
  const client =
    options.client ?? clientDouble({ identity: options.identity, detail: options.detail });
  const journal = journalDouble(options.journal);
  const auth = options.auth ?? authDouble();
  const createAuth = vi.fn<() => AgentAuth>(() => auth.auth);
  const createClient = vi.fn<(clientOptions: PtoClientOptions) => WriteClient>(() => client.client);
  const deps: WriteDependencies = {
    createAuth,
    createClient,
    withCreateIntent: journal.journal,
  };
  return { deps, client, journal, auth, createAuth, createClient };
}

function successOf(
  result: WriteResult,
): CliSuccessFor<'create'> | CliSuccessFor<'update'> | CliSuccessFor<'delete'> {
  expect(result.ok).toBe(true);
  return result as CliSuccessFor<'create'>;
}

function failureOf(result: WriteResult): Extract<WriteResult, { readonly ok: false }> {
  expect(result.ok).toBe(false);
  return result as Extract<WriteResult, { readonly ok: false }>;
}

/** The fixed copy of a result, serialized: no secret, digest, key, token prefix or note text may appear. */
function expectNoSecrets(value: unknown, extra: readonly string[] = []): void {
  const text = JSON.stringify(value);
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(DIGEST);
  expect(text).not.toContain('pto_pat_');
  expect(text).not.toContain(KEY);
  for (const needle of extra) expect(text).not.toContain(needle);
}

/** Nothing reached the store, the credential resolver, the client or the journal. */
function expectUntouched(rigUnderTest: Rig, h?: Harness): void {
  expect(rigUnderTest.createAuth).not.toHaveBeenCalled();
  expect(rigUnderTest.auth.resolve).not.toHaveBeenCalled();
  expect(rigUnderTest.createClient).not.toHaveBeenCalled();
  expect(rigUnderTest.journal.calls).toHaveLength(0);
  expect(rigUnderTest.client.create).not.toHaveBeenCalled();
  expect(rigUnderTest.client.patch).not.toHaveBeenCalled();
  expect(rigUnderTest.client.delete).not.toHaveBeenCalled();
  if (h !== undefined) expect(h.confirm).not.toHaveBeenCalled();
}

/* ------------------------------------------------------------------------- */

describe('the local write gate', () => {
  it.each([
    ['unset', undefined],
    ['zero', '0'],
    ['the word true', 'true'],
    ['padded one', ' 1'],
    ['an empty value', ''],
  ])(
    'refuses every write when PTO_CLI_WRITES is %s, before any store or request',
    async (_label, value) => {
      const env: NodeJS.ProcessEnv = value === undefined ? {} : { PTO_CLI_WRITES: value };
      const h = harness({ env, interactive: true });
      const r = rig();
      for (const cmd of [createCmd(), updateCmd(), deleteCmd()]) {
        const result = failureOf(await executeWrite(cmd, h.context, r.deps));
        expect(result.error.code).toBe('PERMISSION');
        expect(result.error.message).toContain('PTO_CLI_WRITES=1');
      }
      expectUntouched(r, h);
    },
  );

  it('does not accept the switch when it is only inherited through a prototype', async () => {
    const env = Object.create({ PTO_CLI_WRITES: '1' }) as NodeJS.ProcessEnv;
    const h = harness({ env });
    const r = rig();
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result).toMatchObject({ command: 'create', error: { code: 'PERMISSION' } });
    expectUntouched(r, h);
  });

  it('opens for the exact own value 1 and runs the write', async () => {
    const h = harness({ interactive: false, env: { PTO_CLI_WRITES: '1' } });
    const r = rig();
    const result = await executeWrite(createCmd(), h.context, r.deps);
    expect(result.ok).toBe(true);
  });
});

describe('the confirmation mode', () => {
  it('refuses a pipe without --yes before any store, credential or request', async () => {
    const h = harness({ interactive: false });
    const r = rig();
    const result = failureOf(await executeWrite(createCmd({ yes: false }), h.context, r.deps));
    expect(result.error.code).toBe('USAGE');
    expect(result.error.message).toContain('--yes');
    expectUntouched(r, h);
  });

  it('refuses a non-boolean --yes flag as a usage error', async () => {
    const h = harness({ interactive: true });
    const r = rig();
    const result = failureOf(await executeWrite(createCmd({ yes: 'true' }), h.context, r.deps));
    expect(result).toMatchObject({ command: 'create', error: { code: 'USAGE' } });
    expectUntouched(r, h);
  });

  it('never prompts on a pipe even when --yes is given', async () => {
    const h = harness({ interactive: false });
    const r = rig();
    const result = await executeWrite(createCmd({ yes: true }), h.context, r.deps);
    expect(result.ok).toBe(true);
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('asks on a terminal even when --yes is given', async () => {
    const h = harness({ interactive: true });
    const r = rig();
    const result = await executeWrite(createCmd({ yes: true }), h.context, r.deps);
    expect(result.ok).toBe(true);
    expect(h.confirm).toHaveBeenCalledTimes(1);
  });
});

describe('cancellation and unknown operations', () => {
  it('reports a write cancelled before it starts without any store or request', async () => {
    const h = harness();
    h.controller.abort();
    const r = rig();
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result).toMatchObject({ command: 'create', error: { code: 'CANCELLED' } });
    expectUntouched(r, h);
  });

  it('reports an operation that is not a write as a local failure with no command name', async () => {
    const h = harness();
    const r = rig();
    const result = failureOf(await executeWrite(command({ kind: 'list' }), h.context, r.deps));
    expect(result).toMatchObject({ command: null, error: { code: 'LOCAL' } });
    expectUntouched(r, h);
  });

  it('reports an unexpected local error before the write as a local failure', async () => {
    const h = harness();
    const r = rig();
    r.createAuth.mockImplementationOnce(() => {
      throw new TypeError('unexpected seam fault');
    });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error.code).toBe('LOCAL');
    expect(JSON.stringify(result)).not.toContain('unexpected seam fault');
    expect(r.client.create).not.toHaveBeenCalled();
  });
});

describe('create argument validation', () => {
  it.each([
    ['no start date', { endDate: '2026-12-01', dayPart: 'morning' }],
    ['a short month', { startDate: '2026-1-01', endDate: '2026-12-01', dayPart: 'morning' }],
    [
      'a day that does not exist',
      { startDate: '2026-02-30', endDate: '2026-02-30', dayPart: 'morning' },
    ],
    [
      'a month that does not exist',
      { startDate: '2026-13-01', endDate: '2026-13-01', dayPart: 'morning' },
    ],
    [
      'a trailing newline on the end date',
      { startDate: '2026-12-01', endDate: '2026-12-01\n', dayPart: 'morning' },
    ],
    [
      'a number as the start date',
      { startDate: 20261201, endDate: '2026-12-01', dayPart: 'morning' },
    ],
    ['a Saturday start', { startDate: '2026-12-05', endDate: '2026-12-07', dayPart: 'all_day' }],
    ['a Sunday end', { startDate: '2026-12-01', endDate: '2026-12-06', dayPart: 'all_day' }],
    [
      'an end before the start',
      { startDate: '2026-12-02', endDate: '2026-12-01', dayPart: 'all_day' },
    ],
    [
      'a natural-language day part',
      { startDate: '2026-12-01', endDate: '2026-12-01', dayPart: 'afternoon' },
    ],
    ['a single day without a day part', { startDate: '2026-12-01', endDate: '2026-12-01' }],
    ['a note that is a number', { ...MORNING, note: 12 }],
    ['a note that is null', { ...MORNING, note: null }],
    ['a note longer than 500 characters', { ...MORNING, note: 'x'.repeat(501) }],
    ['a note with an unpaired surrogate', { ...MORNING, note: 'bad\uD800note' }],
    ['a field outside the allowlist', { ...MORNING, owner: OTHER_ID }],
    ['a payload that is null', null],
    ['a payload that is an array', [MORNING]],
    ['a payload that is text', 'MORNING'],
  ])('refuses a create with %s before any store or request', async (_label, payload) => {
    const h = harness();
    const r = rig();
    const result = failureOf(await executeWrite(createCmd({ payload }), h.context, r.deps));
    expect(result).toMatchObject({ command: 'create', error: { code: 'USAGE' } });
    expectUntouched(r, h);
  });

  it('refuses a payload whose required field exists only through the prototype', async () => {
    const h = harness();
    const r = rig();
    const payload = Object.create({ startDate: '2026-12-01' }) as Record<string, unknown>;
    payload['endDate'] = '2026-12-01';
    payload['dayPart'] = 'morning';
    const result = failureOf(await executeWrite(createCmd({ payload }), h.context, r.deps));
    expect(result.error.code).toBe('USAGE');
    expectUntouched(r, h);
  });

  it('accepts an empty note as no note and keeps a multi-day request on the wire', async () => {
    const h = harness();
    const r = rig();
    const payload = {
      startDate: '2026-12-01',
      endDate: '2026-12-02',
      dayPart: 'morning',
      note: '',
    };
    const result = await executeWrite(createCmd({ payload }), h.context, r.deps);
    expect(result.ok).toBe(true);
    expect(r.client.create.mock.calls[0]?.[0]).toEqual({
      startDate: '2026-12-01',
      endDate: '2026-12-02',
      dayPart: 'morning',
    });
  });

  it('accepts a note of exactly 500 characters', async () => {
    const h = harness();
    const r = rig();
    const note = 'x'.repeat(500);
    const result = await executeWrite(
      createCmd({ payload: { ...MORNING, note } }),
      h.context,
      r.deps,
    );
    expect(result.ok).toBe(true);
    expect(r.client.create.mock.calls[0]?.[0]).toMatchObject({ note });
  });

  it.each([
    ['an identifier that is not a UUID', { operationId: 'not-a-uuid' }],
    ['a version-one UUID', { operationId: '11111111-1111-1111-8111-111111111111' }],
    ['an identifier with a trailing newline', { operationId: `${OP_ID}\n` }],
    ['a profile with spaces', { auth: { allowLoopbackHttp: false, profile: 'Bad Name' } }],
    [
      'a profile with a trailing newline',
      { auth: { allowLoopbackHttp: false, profile: 'work\n' } },
    ],
    [
      'an origin with another scheme',
      { auth: { allowLoopbackHttp: false, origin: 'ftp://pto.example.com' } },
    ],
    [
      'an origin with a trailing newline',
      { auth: { allowLoopbackHttp: false, origin: `${ORIGIN}\n` } },
    ],
    ['an origin with a path', { auth: { allowLoopbackHttp: false, origin: `${ORIGIN}/app` } }],
    [
      'an origin that is a plain-HTTP remote host',
      { auth: { allowLoopbackHttp: false, origin: 'http://pto.example.com' } },
    ],
    [
      'an origin spelled as an alternate IP',
      { auth: { allowLoopbackHttp: false, origin: 'https://0x7f.1' } },
    ],
    [
      'an origin with an unusable IP literal',
      { auth: { allowLoopbackHttp: false, origin: 'https://[1.2.3.4]' } },
    ],
    [
      'an origin with a double dot',
      { auth: { allowLoopbackHttp: false, origin: 'https://a..b.example.com' } },
    ],
    [
      'an origin longer than 512 characters',
      { auth: { allowLoopbackHttp: false, origin: `https://${'a'.repeat(600)}.example` } },
    ],
    ['a loopback flag that is not a boolean', { auth: { allowLoopbackHttp: 'yes' } }],
  ])('refuses a create with %s before any store or request', async (_label, fields) => {
    const h = harness();
    const r = rig();
    const result = failureOf(await executeWrite(createCmd(fields), h.context, r.deps));
    expect(result.error.code).toBe('USAGE');
    expectUntouched(r, h);
  });

  it('lowercases an upper-case operation identifier before the journal sees it', async () => {
    const h = harness({ interactive: false });
    const r = rig();
    await executeWrite(createCmd({ operationId: OP_ID.toUpperCase() }), h.context, r.deps);
    expect(r.journal.calls[0]?.operationId).toBe(OP_ID);
  });

  it('accepts a loopback origin when the loopback opt-in is named', async () => {
    const h = harness();
    const bundle: AgentAuthCredential = {
      ...BUNDLE,
      baseUrl: 'http://127.0.0.1:3000',
      credential: { origin: 'http://127.0.0.1:3000', token: TOKEN },
      allowLoopbackHttp: true,
    };
    const r = rig({ auth: authDouble({ bundle }) });
    const cmd = createCmd({ auth: { allowLoopbackHttp: true, origin: 'http://127.0.0.1:3000' } });
    const result = await executeWrite(cmd, h.context, r.deps);
    expect(result.ok).toBe(true);
    expect(r.auth.resolve.mock.calls).toHaveLength(1);
  });

  it('passes the profile, the expected origin and only the managed pair to the facade', async () => {
    const h = harness();
    const r = rig();
    const env = {
      PTO_CLI_WRITES: '1',
      PTO_API_ORIGIN: ORIGIN,
      PTO_API_TOKEN: TOKEN,
      UNRELATED: 'ignored',
    } as NodeJS.ProcessEnv;
    const cmd = createCmd({ auth: { allowLoopbackHttp: false, profile: 'work', origin: ORIGIN } });
    await executeWrite(cmd, { ...h.context, env }, r.deps);
    expect(r.auth.resolve).toHaveBeenCalledTimes(1);
    expect(r.auth.resolve.mock.calls[0]?.[0]).toEqual({
      profile: 'work',
      baseUrl: ORIGIN,
      allowLoopbackHttp: false,
      env: { PTO_API_ORIGIN: ORIGIN, PTO_API_TOKEN: TOKEN },
    });
  });
});

describe('create approval, identity and scope', () => {
  it('shows the exact preview on a terminal and dispatches after an explicit yes', async () => {
    const h = harness({ interactive: true });
    const r = rig();
    const result = successOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.confirm.mock.calls[0]?.[0]).toBe(
      [
        'Create one PTO entry for the token holder:',
        `Origin: ${ORIGIN}`,
        `Acting user: ${OWNER_ID}`,
        `Owner: ${OWNER_ID}`,
        'Entry: new entry, with no identifier until it is created',
        'Dates: 2026-12-01..2026-12-01',
        'Day part: morning',
        'Note: none',
        'Changed fields: startDate, endDate, dayPart',
      ].join('\n'),
    );
    expect(result).toMatchObject({ ok: true, command: 'create' });
    expect(r.client.create).toHaveBeenCalledTimes(1);
  });

  it('binds the journal to the origin, the live actor, the live token and the raw token', async () => {
    const h = harness();
    const r = rig();
    await executeWrite(createCmd(), h.context, r.deps);
    expect(r.journal.calls[0]?.binding).toEqual({
      origin: ORIGIN,
      actorId: OWNER_ID,
      tokenId: TOKEN_ID,
      token: TOKEN,
    });
    expect(r.journal.calls[0]?.payload).toEqual(MORNING);
    expect(r.journal.calls[0]?.operationId).toBeUndefined();
    expect(r.journal.calls[0]?.signal).toBe(h.controller.signal);
  });

  it('gives the client the origin the facade resolved, the bounded timeout and the read retries', async () => {
    const h = harness();
    const r = rig();
    await executeWrite(createCmd(), h.context, r.deps);
    expect(r.createClient.mock.calls[0]?.[0]).toEqual({
      baseUrl: ORIGIN,
      credential: { origin: ORIGIN, token: TOKEN },
      allowLoopbackHttp: false,
      timeoutMs: 15_000,
      readRetries: 2,
    });
    expect(r.client.create.mock.calls[0]?.[2]).toEqual({
      signal: h.controller.signal,
      timeoutMs: 15_000,
    });
  });

  it('dispatches with the key the journal lease holds and never with a key of its own', async () => {
    const h = harness();
    const r = rig();
    await executeWrite(createCmd(), h.context, r.deps);
    expect(r.client.create.mock.calls[0]?.[1]).toBe(KEY);
    expect(r.client.create.mock.calls[0]?.[0]).toEqual(MORNING);
  });

  it('returns the safe record and the operation identifier, and completes the lease without a hook', async () => {
    const h = harness();
    const r = rig();
    const result = successOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result).toEqual({
      schemaVersion: 1,
      ok: true,
      command: 'create',
      data: {
        record: {
          id: ENTRY_ID,
          ownerId: OWNER_ID,
          version: 1,
          startDate: '2026-12-01',
          endDate: '2026-12-01',
          dayPart: 'morning',
        },
        operationId: FRESH_OP,
        replayed: false,
        expiresAt: EXPIRES_AT,
      },
    });
    expect(r.journal.leases[0]?.complete).toHaveBeenCalledTimes(1);
    expectNoSecrets(result, [KEY]);
  });

  it('refuses before the preview when the token lacks the create scope', async () => {
    const h = harness({ interactive: true });
    const r = rig({ identity: identityOf({}, ['pto:read', 'pto:update:self']) });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error.code).toBe('PERMISSION');
    expect(h.confirm).not.toHaveBeenCalled();
    expect(r.journal.calls).toHaveLength(0);
    expect(r.client.create).not.toHaveBeenCalled();
  });

  it('keeps the classification of a rejected credential and its safe correlation', async () => {
    const h = harness();
    const client = clientDouble();
    client.getIdentity.mockRejectedValueOnce(
      new PtoApiError('UNAUTHENTICATED', { status: 401, requestId: REQUEST_ID }),
    );
    const r = rig({ client });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error).toMatchObject({ code: 'AUTH', status: 401, requestId: REQUEST_ID });
    expect(r.journal.calls).toHaveLength(0);
  });

  it('reports a credential store refusal with its fixed category and no cause', async () => {
    const h = harness();
    const r = rig({ auth: authDouble({ error: new AgentAuthError('KEYRING_LOCKED') }) });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error.code).toBe('AUTH');
    expect(result.error.message).toContain('locked');
    // The store was asked; the client, the journal and the prompt were not reached.
    expect(r.auth.resolve).toHaveBeenCalledTimes(1);
    expect(r.createClient).not.toHaveBeenCalled();
    expect(r.journal.calls).toHaveLength(0);
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('stops after the credential resolves when the caller aborted during the resolution', async () => {
    const h = harness();
    const r = rig();
    r.auth.resolve.mockImplementationOnce(async () => {
      h.controller.abort();
      return BUNDLE;
    });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error.code).toBe('CANCELLED');
    expect(r.createClient).not.toHaveBeenCalled();
    expect(r.journal.calls).toHaveLength(0);
  });

  it('reports a decline with no journal, no request and no completed lease', async () => {
    const h = harness({ interactive: true, confirm: async () => false });
    const r = rig();
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result).toMatchObject({ command: 'create', error: { code: 'CANCELLED' } });
    expect(result.error.message).toContain('not confirmed');
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(r.journal.calls).toHaveLength(0);
    expect(r.client.create).not.toHaveBeenCalled();
  });

  it('treats an answer that is not exactly true as a refusal', async () => {
    const answer = (async () => 'yes') as unknown as (preview: string) => Promise<boolean>;
    const h = harness({ interactive: true, confirm: answer });
    const r = rig();
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error.code).toBe('CANCELLED');
    expect(r.client.create).not.toHaveBeenCalled();
  });

  it('treats a rejected confirmation, such as an ended input, as a refusal', async () => {
    const h = harness({
      interactive: true,
      confirm: async () => {
        throw new Error('stdin ended');
      },
    });
    const r = rig();
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error.code).toBe('CANCELLED');
    expect(JSON.stringify(result)).not.toContain('stdin ended');
    expect(r.journal.calls).toHaveLength(0);
  });

  it('refuses an approval that arrives after the caller aborted', async () => {
    const controller = new AbortController();
    const h = harness({
      interactive: true,
      controller,
      confirm: async () => {
        controller.abort();
        return true;
      },
    });
    const r = rig();
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error.code).toBe('CANCELLED');
    expect(r.journal.calls).toHaveLength(0);
    expect(r.client.create).not.toHaveBeenCalled();
  });

  it('resumes the named operation with the same key and marks the preview as a resume', async () => {
    const h = harness({ interactive: true });
    const r = rig({ journal: { operationId: OP_ID } });
    const result = successOf(
      await executeWrite(createCmd({ operationId: OP_ID }), h.context, r.deps),
    );
    expect(r.journal.calls[0]?.operationId).toBe(OP_ID);
    expect(h.confirm.mock.calls[0]?.[0]).toContain(
      `Resume: pending operation ${OP_ID}, same key and the same fields`,
    );
    expect(result.data).toMatchObject({ operationId: OP_ID, replayed: false });
  });

  it('reports a server replay as a success with replayed true', async () => {
    const h = harness();
    const client = clientDouble();
    client.create.mockResolvedValueOnce({ ...CREATED, replayed: true });
    const r = rig({ client, journal: { operationId: OP_ID } });
    const result = successOf(
      await executeWrite(createCmd({ operationId: OP_ID }), h.context, r.deps),
    );
    expect(result.data).toMatchObject({ replayed: true, operationId: OP_ID });
    expect(r.journal.leases[0]?.complete).toHaveBeenCalledTimes(1);
  });

  it('shows the note as set and never its text, on the preview or in the result', async () => {
    const h = harness({ interactive: true });
    const r = rig();
    const payload = { ...MORNING, note: 'PRIVATE-NOTE-TEXT' };
    const result = await executeWrite(createCmd({ payload }), h.context, r.deps);
    expect(result.ok).toBe(true);
    const preview = h.confirm.mock.calls[0]?.[0] ?? '';
    expect(preview).toContain('Note: set');
    expect(preview).toContain('Changed fields: startDate, endDate, dayPart, note');
    expect(preview).not.toContain('PRIVATE-NOTE-TEXT');
    expectNoSecrets(result, ['PRIVATE-NOTE-TEXT']);
    expect(r.client.create.mock.calls[0]?.[0]).toMatchObject({ note: 'PRIVATE-NOTE-TEXT' });
  });

  it('keeps a requested morning on a multi-day range on the wire and says where it is stored', async () => {
    const h = harness({ interactive: true });
    const r = rig();
    const payload = { startDate: '2026-12-01', endDate: '2026-12-02', dayPart: 'morning' };
    await executeWrite(createCmd({ payload }), h.context, r.deps);
    expect(r.client.create.mock.calls[0]?.[0]).toEqual(payload);
    expect(h.confirm.mock.calls[0]?.[0]).toContain(
      'Day part: all_day (requested morning; a range longer than one day is stored as all_day)',
    );
    expect(h.confirm.mock.calls[0]?.[0]).toContain('Dates: 2026-12-01..2026-12-02');
  });

  it('shows the stored day part of a multi-day range that was requested without a day part', async () => {
    const h = harness({ interactive: true });
    const r = rig();
    const payload = { startDate: '2026-12-01', endDate: '2026-12-02' };
    await executeWrite(createCmd({ payload }), h.context, r.deps);
    expect(r.client.create.mock.calls[0]?.[0]).toEqual(payload);
    expect(h.confirm.mock.calls[0]?.[0]).toContain('Day part: all_day\n');
    expect(h.confirm.mock.calls[0]?.[0]).not.toContain('requested');
  });

  it('shows a requested day part without a note when it is stored exactly as asked', async () => {
    const h = harness({ interactive: true });
    const r = rig();
    await executeWrite(
      createCmd({ payload: { ...MORNING, dayPart: 'evening' } }),
      h.context,
      r.deps,
    );
    expect(h.confirm.mock.calls[0]?.[0]).toContain('Day part: evening\n');
  });
});

describe('create journal refusals', () => {
  it.each([
    ['BUSY', 'CONFLICT'],
    ['MISMATCH', 'CONFLICT'],
    ['EXPIRED', 'CONFLICT'],
    ['UNAVAILABLE', 'LOCAL'],
  ] as const)(
    'reports a journal %s refusal as %s and dispatches nothing',
    async (code, category) => {
      const h = harness();
      const r = rig({ journal: { refuse: new CreateIntentError(code) } });
      const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
      expect(result.error.code).toBe(category);
      expect(result).not.toHaveProperty('recovery');
      expect(r.client.create).not.toHaveBeenCalled();
      expect(r.journal.calls).toHaveLength(1);
    },
  );

  it('reports a pending refusal with the safe operation identifier and deadline', async () => {
    const h = harness();
    const refusal = new CreateIntentError('PENDING', { operationId: OP_ID, expiresAt: EXPIRES_AT });
    const r = rig({ journal: { refuse: refusal } });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result).toMatchObject({
      command: 'create',
      error: { code: 'CONFLICT' },
      recovery: { kind: 'create-pending', operationId: OP_ID, expiresAt: EXPIRES_AT },
    });
    expect(r.client.create).not.toHaveBeenCalled();
  });

  it('drops a pending refusal whose operation identifier or deadline is not safe to show', async () => {
    const h = harness();
    const unsafeId = new CreateIntentError('PENDING', {
      operationId: 'not-a-uuid',
      expiresAt: EXPIRES_AT,
    });
    const unsafeDeadline = new CreateIntentError('PENDING', {
      operationId: OP_ID,
      expiresAt: 'tomorrow',
    });
    const first = failureOf(
      await executeWrite(createCmd(), h.context, rig({ journal: { refuse: unsafeId } }).deps),
    );
    const second = failureOf(
      await executeWrite(createCmd(), h.context, rig({ journal: { refuse: unsafeDeadline } }).deps),
    );
    expect(first).not.toHaveProperty('recovery');
    expect(second).not.toHaveProperty('recovery');
  });

  it('reports a journal refusal with an unknown code as a local fault', async () => {
    const h = harness();
    const refusal = new CreateIntentError('BUSY');
    Object.defineProperty(refusal, 'code', { value: 'SOMETHING_NEW' });
    const r = rig({ journal: { refuse: refusal } });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error.code).toBe('LOCAL');
    expect(r.client.create).not.toHaveBeenCalled();
  });

  it('reports a malformed journal request as a local fault without its text', async () => {
    const h = harness();
    const r = rig({ journal: { refuse: new TypeError('the journal said something private') } });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error.code).toBe('LOCAL');
    expect(result.error.message).toContain('could not be used');
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('reports an abort before admission as a cancellation with nothing sent', async () => {
    const h = harness();
    const refusal = new DOMException('aborted', 'AbortError');
    const r = rig({
      journal: {
        onEntry: () => h.controller.abort(),
        refuse: refusal,
      },
    });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result).toMatchObject({ command: 'create', error: { code: 'CANCELLED' } });
    expect(r.client.create).not.toHaveBeenCalled();
  });

  it('reports a journal fault that is not an abort as a local fault even with a signal', async () => {
    const h = harness();
    const r = rig({ journal: { refuse: new DOMException('aborted', 'AbortError') } });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error.code).toBe('LOCAL');
  });

  it('keeps the category of a journal refusal when the caller also aborted', async () => {
    const h = harness();
    const r = rig({
      journal: {
        onEntry: () => h.controller.abort(),
        refuse: new CreateIntentError('BUSY'),
      },
    });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error.code).toBe('CONFLICT');
    expect(r.client.create).not.toHaveBeenCalled();
  });
});

describe('create dispatch outcomes', () => {
  it('clears a fresh pending create after a proven refusal of the service', async () => {
    const h = harness();
    const client = clientDouble();
    client.create.mockRejectedValueOnce(
      new PtoApiError('VALIDATION_ERROR', {
        status: 400,
        requestId: REQUEST_ID,
        unknownWriteOutcome: false,
      }),
    );
    const r = rig({ client });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error).toMatchObject({ code: 'USAGE', status: 400, requestId: REQUEST_ID });
    expect(result).not.toHaveProperty('recovery');
    expect(r.journal.leases[0]?.complete).toHaveBeenCalledTimes(1);
  });

  it('clears a fresh pending create after an overlap refusal', async () => {
    const h = harness();
    const client = clientDouble();
    client.create.mockRejectedValueOnce(
      new PtoApiError('CONFLICT', { status: 409, unknownWriteOutcome: false }),
    );
    const r = rig({ client });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error.code).toBe('CONFLICT');
    expect(result).not.toHaveProperty('recovery');
    expect(r.journal.leases[0]?.complete).toHaveBeenCalledTimes(1);
  });

  it('clears a fresh pending create that failed before any request left the process', async () => {
    const h = harness();
    const client = clientDouble();
    client.create.mockRejectedValueOnce(
      new PtoApiError('INVALID_INPUT', { unknownWriteOutcome: false }),
    );
    const r = rig({ client });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error.code).toBe('USAGE');
    expect(r.journal.leases[0]?.complete).toHaveBeenCalledTimes(1);
  });

  it('keeps the pending record after a key-bound refusal, with its recovery facts', async () => {
    const h = harness();
    const client = clientDouble();
    client.create.mockRejectedValueOnce(
      new PtoApiError('IDEMPOTENCY_CONFLICT', { status: 409, unknownWriteOutcome: false }),
    );
    const r = rig({ client });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error.code).toBe('CONFLICT');
    expect(result).toMatchObject({
      recovery: { kind: 'create-pending', operationId: FRESH_OP, expiresAt: EXPIRES_AT },
    });
    expect(r.journal.leases[0]?.complete).not.toHaveBeenCalled();
  });

  it('keeps a resumed pending create after a proven refusal, and reports its recovery', async () => {
    const h = harness();
    const client = clientDouble();
    client.create.mockRejectedValueOnce(
      new PtoApiError('VALIDATION_ERROR', { status: 400, unknownWriteOutcome: false }),
    );
    const r = rig({ client, journal: { operationId: OP_ID } });
    const result = failureOf(
      await executeWrite(createCmd({ operationId: OP_ID }), h.context, r.deps),
    );
    expect(result.error.code).toBe('USAGE');
    expect(result).toMatchObject({ recovery: { kind: 'create-pending', operationId: OP_ID } });
    expect(r.journal.leases[0]?.complete).not.toHaveBeenCalled();
  });

  it('keeps a fresh pending create when the completion itself fails after a refusal', async () => {
    const h = harness();
    const client = clientDouble();
    client.create.mockRejectedValueOnce(
      new PtoApiError('FORBIDDEN', { status: 403, unknownWriteOutcome: false }),
    );
    const r = rig({ client, journal: { completeFails: true } });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error.code).toBe('PERMISSION');
    expect(result).toHaveProperty('recovery.kind', 'create-pending');
  });

  it('reports a lost answer as an unknown outcome and never as a failure', async () => {
    const h = harness();
    const client = clientDouble();
    client.create.mockRejectedValueOnce(
      new PtoApiError('NETWORK_ERROR', { status: 0, requestId: null, unknownWriteOutcome: true }),
    );
    const r = rig({ client });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error.code).toBe('NETWORK');
    expect(result.error.message).toContain('outcome is unknown');
    expect(result).toMatchObject({
      recovery: { kind: 'create-pending', operationId: FRESH_OP, expiresAt: EXPIRES_AT },
    });
    expect(r.journal.leases[0]?.complete).not.toHaveBeenCalled();
  });

  it('keeps a server failure after dispatch as an unknown outcome with its correlation', async () => {
    const h = harness();
    const client = clientDouble();
    client.create.mockRejectedValueOnce(
      new PtoApiError('INTERNAL_ERROR', {
        status: 500,
        requestId: REQUEST_ID,
        unknownWriteOutcome: true,
      }),
    );
    const r = rig({ client });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error).toMatchObject({ code: 'NETWORK', status: 500, requestId: REQUEST_ID });
    expect(result.recovery?.kind).toBe('create-pending');
  });

  it('treats an untyped error after dispatch as an unknown outcome and never leaks its text', async () => {
    const h = harness();
    const client = clientDouble();
    client.create.mockRejectedValueOnce(new Error('socket hang up at the edge'));
    const r = rig({ client });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error.code).toBe('NETWORK');
    expect(result.recovery?.kind).toBe('create-pending');
    expect(JSON.stringify(result)).not.toContain('socket');
    expect(r.journal.leases[0]?.complete).not.toHaveBeenCalled();
  });

  it('cancels before the request leaves and clears a fresh admission', async () => {
    const h = harness();
    const r = rig({ journal: { beforeAct: () => h.controller.abort() } });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result).toMatchObject({ command: 'create', error: { code: 'CANCELLED' } });
    expect(result).not.toHaveProperty('recovery');
    expect(r.client.create).not.toHaveBeenCalled();
    expect(r.journal.leases[0]?.complete).toHaveBeenCalledTimes(1);
  });

  it('cancels before the request leaves and keeps a resumed admission with its recovery', async () => {
    const h = harness();
    const r = rig({
      journal: { operationId: OP_ID, beforeAct: () => h.controller.abort() },
    });
    const result = failureOf(
      await executeWrite(createCmd({ operationId: OP_ID }), h.context, r.deps),
    );
    expect(result.error.code).toBe('CANCELLED');
    expect(result).toMatchObject({ recovery: { kind: 'create-pending', operationId: OP_ID } });
    expect(r.client.create).not.toHaveBeenCalled();
    expect(r.journal.leases[0]?.complete).not.toHaveBeenCalled();
  });

  it('reports an abort during the request as an unknown outcome, not as a cancellation', async () => {
    const h = harness();
    const client = clientDouble();
    client.create.mockImplementationOnce(async () => {
      h.controller.abort();
      throw new PtoApiError('ABORTED', { unknownWriteOutcome: true });
    });
    const r = rig({ client });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error.code).toBe('NETWORK');
    expect(result.recovery?.kind).toBe('create-pending');
  });

  it('keeps a known success even when the caller aborts after the answer was read', async () => {
    const h = harness();
    const client = clientDouble();
    client.create.mockImplementationOnce(async () => {
      h.controller.abort();
      return CREATED;
    });
    const r = rig({ client });
    const result = successOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.data).toMatchObject({ operationId: FRESH_OP, replayed: false });
    expect(r.journal.leases[0]?.complete).toHaveBeenCalledTimes(1);
  });

  it('keeps a known success when the journal fails afterwards, and never retries', async () => {
    const h = harness();
    const r = rig({ journal: { afterAct: new Error('journal finalize failed') } });
    const result = successOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.data).toMatchObject({ operationId: FRESH_OP });
    expect(r.client.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('finalize');
  });

  it('keeps a known success when the storage cleanup fails after it', async () => {
    const h = harness();
    const r = rig({ journal: { completeFails: true } });
    const result = successOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result).toMatchObject({ ok: true, command: 'create' });
    expect(r.client.create).toHaveBeenCalledTimes(1);
  });

  it('reports an answer after a refusal as unknown when the journal fails afterwards', async () => {
    const h = harness();
    const client = clientDouble();
    client.create.mockRejectedValueOnce(
      new PtoApiError('VALIDATION_ERROR', { status: 400, unknownWriteOutcome: false }),
    );
    const r = rig({ client, journal: { afterAct: new Error('journal finalize failed') } });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error.code).toBe('NETWORK');
    expect(result.error).toMatchObject({ status: 400 });
    expect(result.recovery?.kind).toBe('create-pending');
  });

  it('reports a cancelled attempt as unknown when the journal fails afterwards', async () => {
    const h = harness();
    const r = rig({
      journal: {
        beforeAct: () => h.controller.abort(),
        afterAct: new Error('journal finalize failed'),
      },
    });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error.code).toBe('NETWORK');
    expect(result.error).toMatchObject({ status: null, requestId: null });
    expect(result.recovery?.kind).toBe('create-pending');
  });

  it('reports an unknown attempt with no correlation when the journal fails afterwards', async () => {
    const h = harness();
    const client = clientDouble();
    client.create.mockRejectedValueOnce(new Error('opaque'));
    const r = rig({ client, journal: { afterAct: new Error('journal finalize failed') } });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error).toMatchObject({ code: 'NETWORK', status: null, requestId: null });
  });
});

describe('the delivery hook of a create', () => {
  it('delivers the single known success before the lease completes, and returns that same object', async () => {
    const h = harness({ publish: async () => true });
    const r = rig();
    const result = await executeWrite(createCmd(), h.context, r.deps);
    const delivered = h.publish?.mock.calls[0]?.[0];
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(result).toBe(delivered);
    const complete = r.journal.leases[0]?.complete;
    expect(complete).toHaveBeenCalledTimes(1);
    expect(h.publish!.mock.invocationCallOrder[0]!).toBeLessThan(
      complete!.mock.invocationCallOrder[0]!,
    );
  });

  it('keeps the pending record when the host does not confirm delivery, and still returns the success', async () => {
    const h = harness({ publish: async () => false });
    const r = rig();
    const result = successOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.data).toMatchObject({ operationId: FRESH_OP, replayed: false });
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(r.journal.leases[0]?.complete).not.toHaveBeenCalled();
    expect(r.client.create).toHaveBeenCalledTimes(1);
    expect(result).not.toHaveProperty('recovery');
  });

  it('keeps the pending record when the hook rejects, and never reports the write as failed', async () => {
    const h = harness({
      publish: async () => {
        throw new Error('render failed at the terminal');
      },
    });
    const r = rig();
    const result = successOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result).toMatchObject({ ok: true, command: 'create' });
    expect(r.journal.leases[0]?.complete).not.toHaveBeenCalled();
    expect(r.client.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('render failed');
  });

  it('keeps the pending record when the hook throws synchronously', async () => {
    const h = harness({
      publish: (() => {
        throw new Error('flush failed');
      }) as unknown as (result: CliSuccessFor<'create'>) => Promise<boolean>,
    });
    const r = rig();
    const result = successOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.ok).toBe(true);
    expect(r.journal.leases[0]?.complete).not.toHaveBeenCalled();
  });

  it('treats a hook answer that is not exactly true as not delivered', async () => {
    const h = harness({ publish: (async () => undefined) as unknown as () => Promise<boolean> });
    const r = rig();
    const result = successOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.ok).toBe(true);
    expect(r.journal.leases[0]?.complete).not.toHaveBeenCalled();
  });

  it('treats a hook that is supplied but is not a function as not delivered', async () => {
    const h = harness();
    const context = { ...h.context, publishCreateResult: 42 as unknown as () => Promise<boolean> };
    const r = rig();
    const result = successOf(await executeWrite(createCmd(), context, r.deps));
    expect(result.ok).toBe(true);
    expect(r.journal.leases[0]?.complete).not.toHaveBeenCalled();
  });

  it('keeps the pending record of a resumed success that was not delivered', async () => {
    const h = harness({ publish: async () => false });
    const client = clientDouble();
    client.create.mockResolvedValueOnce({ ...CREATED, replayed: true });
    const r = rig({ client, journal: { operationId: OP_ID } });
    const result = successOf(
      await executeWrite(createCmd({ operationId: OP_ID }), h.context, r.deps),
    );
    expect(result.data).toMatchObject({ operationId: OP_ID, replayed: true });
    expect(r.journal.leases[0]?.complete).not.toHaveBeenCalled();
  });

  it('keeps a known success when the journal fails after an undelivered hand-off', async () => {
    const h = harness({ publish: async () => false });
    const r = rig({ journal: { afterAct: new Error('journal finalize failed') } });
    const result = successOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.data).toMatchObject({ operationId: FRESH_OP });
    expect(r.client.create).toHaveBeenCalledTimes(1);
  });

  it('abandons a delivery that is still pending when the caller aborts, and keeps the record', async () => {
    const controller = new AbortController();
    const h = harness({
      controller,
      // A host that never answers, and whose caller then cancels.
      publish: () =>
        new Promise<boolean>(() => {
          controller.abort();
        }),
    });
    const r = rig();
    const result = successOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.data).toMatchObject({ operationId: FRESH_OP, replayed: false });
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(r.journal.leases[0]?.complete).not.toHaveBeenCalled();
    expect(r.client.create).toHaveBeenCalledTimes(1);
  });

  it('does not start the hook once the caller has aborted, and keeps the record', async () => {
    const controller = new AbortController();
    const h = harness({ controller, publish: async () => true });
    const client = clientDouble();
    client.create.mockImplementationOnce(async () => {
      controller.abort();
      return CREATED;
    });
    const r = rig({ client });
    const result = successOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.data).toMatchObject({ operationId: FRESH_OP });
    expect(h.publish).not.toHaveBeenCalled();
    expect(r.journal.leases[0]?.complete).not.toHaveBeenCalled();
  });

  it('is never called for a refused, cancelled or unknown attempt', async () => {
    const h = harness({ publish: async () => true });
    const client = clientDouble();
    client.create.mockRejectedValueOnce(
      new PtoApiError('VALIDATION_ERROR', { status: 400, unknownWriteOutcome: false }),
    );
    const r = rig({ client });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error.code).toBe('USAGE');
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('is not required: an omitted hook completes the lease exactly as before', async () => {
    const h = harness();
    const r = rig();
    await executeWrite(createCmd(), h.context, r.deps);
    expect(r.journal.leases[0]?.complete).toHaveBeenCalledTimes(1);
  });
});

describe('update', () => {
  it('reads the exact target first and sends one versioned PATCH with only the named field', async () => {
    const h = harness();
    const r = rig();
    const result = successOf(await executeWrite(updateCmd(), h.context, r.deps));
    expect(r.client.getDetail.mock.calls[0]?.[0]).toBe(ENTRY_ID);
    expect(r.client.patch).toHaveBeenCalledTimes(1);
    expect(r.client.patch.mock.calls[0]?.slice(0, 3)).toEqual([
      ENTRY_ID,
      2,
      { dayPart: 'evening' },
    ]);
    expect(result).toEqual({
      schemaVersion: 1,
      ok: true,
      command: 'update',
      data: {
        record: {
          id: ENTRY_ID,
          ownerId: OWNER_ID,
          version: 3,
          startDate: '2026-12-01',
          endDate: '2026-12-01',
          dayPart: 'evening',
        },
      },
    });
  });

  it('omits the note from the PATCH when the note is not named, so a hidden note is preserved', async () => {
    const h = harness();
    const r = rig();
    await executeWrite(updateCmd({ changes: { dayPart: 'evening' } }), h.context, r.deps);
    const body = r.client.patch.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(Object.hasOwn(body, 'note')).toBe(false);
  });

  it('sends an explicit null to clear the note, and an empty note clears it the same way', async () => {
    const h = harness();
    const r = rig();
    await executeWrite(updateCmd({ changes: { note: null } }), h.context, r.deps);
    await executeWrite(updateCmd({ changes: { note: '' } }), h.context, r.deps);
    expect(r.client.patch.mock.calls[0]?.[2]).toEqual({ note: null });
    expect(r.client.patch.mock.calls[1]?.[2]).toEqual({ note: null });
  });

  it('sends a replacement note, and previews it as set without its text', async () => {
    const h = harness({ interactive: true });
    const r = rig();
    await executeWrite(updateCmd({ changes: { note: 'REPLACEMENT-TEXT' } }), h.context, r.deps);
    expect(r.client.patch.mock.calls[0]?.[2]).toEqual({ note: 'REPLACEMENT-TEXT' });
    const preview = h.confirm.mock.calls[0]?.[0] ?? '';
    expect(preview).toContain('Note: set');
    expect(preview).not.toContain('REPLACEMENT-TEXT');
  });

  it('previews an explicit clear as clear, without any note text', async () => {
    const h = harness({ interactive: true });
    const r = rig();
    await executeWrite(updateCmd({ changes: { note: null } }), h.context, r.deps);
    const preview = h.confirm.mock.calls[0]?.[0] ?? '';
    expect(preview).toContain('Note: clear');
    expect(preview).toContain('Changed fields: note');
    expect(r.client.patch.mock.calls[0]?.[2]).toEqual({ note: null });
  });

  it('names a changed start date and shows its before and after', async () => {
    const h = harness({ interactive: true });
    const r = rig({
      detail: detailOf({ startDate: '2026-12-02', endDate: '2026-12-03', dayPart: 'all_day' }),
    });
    await executeWrite(updateCmd({ changes: { startDate: '2026-12-01' } }), h.context, r.deps);
    const preview = h.confirm.mock.calls[0]?.[0] ?? '';
    expect(preview).toContain('Dates: 2026-12-02..2026-12-03 -> 2026-12-01..2026-12-03');
    expect(preview).toContain('Changed fields: startDate');
  });

  it('shows the exact before and after of an update on a terminal and dispatches after yes', async () => {
    const h = harness({ interactive: true });
    const r = rig();
    await executeWrite(updateCmd(), h.context, r.deps);
    expect(h.confirm.mock.calls[0]?.[0]).toBe(
      [
        'Update one PTO entry:',
        `Origin: ${ORIGIN}`,
        `Acting user: ${OWNER_ID}`,
        `Owner: ${OWNER_ID}`,
        `Entry: ${ENTRY_ID} at version 2`,
        'Dates: 2026-12-01..2026-12-01 -> 2026-12-01..2026-12-01',
        'Day part: morning -> evening',
        'Note: keep',
        'Changed fields: dayPart',
      ].join('\n'),
    );
    expect(r.client.patch).toHaveBeenCalledTimes(1);
  });

  it('names every changed date and the set note in the preview', async () => {
    const h = harness({ interactive: true });
    const r = rig({ detail: detailOf({ endDate: '2026-12-02' }) });
    const changes = {
      startDate: '2026-12-01',
      endDate: '2026-12-03',
      dayPart: 'all_day',
      note: 'x',
    };
    await executeWrite(updateCmd({ changes }), h.context, r.deps);
    const preview = h.confirm.mock.calls[0]?.[0] ?? '';
    expect(preview).toContain('Dates: 2026-12-01..2026-12-02 -> 2026-12-01..2026-12-03');
    expect(preview).toContain('Changed fields: endDate, dayPart, note');
  });

  it('reports changed fields as none when the named values are the stored ones', async () => {
    const h = harness({ interactive: true });
    const r = rig();
    await executeWrite(updateCmd({ changes: { dayPart: 'morning' } }), h.context, r.deps);
    expect(h.confirm.mock.calls[0]?.[0]).toContain('Changed fields: none');
  });

  it('shows a requested half-day that the stored multi-day range keeps as all_day', async () => {
    const h = harness({ interactive: true });
    const r = rig({ detail: detailOf({ endDate: '2026-12-02', dayPart: 'all_day' }) });
    await executeWrite(updateCmd({ changes: { dayPart: 'evening' } }), h.context, r.deps);
    expect(r.client.patch.mock.calls[0]?.[2]).toEqual({ dayPart: 'evening' });
    expect(h.confirm.mock.calls[0]?.[0]).toContain(
      'Day part: all_day -> all_day (requested evening; a range longer than one day is stored as all_day)',
    );
  });

  it('refuses a stale expected version before any preview or PATCH', async () => {
    const h = harness({ interactive: true });
    const r = rig({ detail: detailOf({ version: 5 }) });
    const result = failureOf(await executeWrite(updateCmd({ version: 2 }), h.context, r.deps));
    expect(result).toMatchObject({
      command: 'update',
      error: { code: 'CONFLICT' },
      recovery: {
        kind: 'stale',
        id: ENTRY_ID,
        expectedVersion: 2,
        before: null,
        current: { id: ENTRY_ID, ownerId: OWNER_ID, version: 5 },
      },
    });
    expect(h.confirm).not.toHaveBeenCalled();
    expect(r.client.patch).not.toHaveBeenCalled();
  });

  it('refuses a missing target before any PATCH and never guesses one', async () => {
    const h = harness();
    const client = clientDouble();
    client.getDetail.mockRejectedValueOnce(new PtoApiError('NOT_FOUND', { status: 404 }));
    const r = rig({ client });
    const result = failureOf(await executeWrite(updateCmd(), h.context, r.deps));
    expect(result.error).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(r.client.patch).not.toHaveBeenCalled();
  });

  it('refuses before reading the target when the token cannot read entries', async () => {
    const h = harness({ interactive: true });
    const r = rig({ identity: identityOf({}, ['pto:update:self']) });
    const result = failureOf(await executeWrite(updateCmd(), h.context, r.deps));
    expect(result.error.code).toBe('PERMISSION');
    expect(r.client.getDetail).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('refuses a teammate entry for a member token before the preview', async () => {
    const h = harness({ interactive: true });
    const r = rig({
      detail: detailOf({ user: { id: OTHER_ID, name: 'Grace', colorCode: '#000000' } }),
    });
    const result = failureOf(await executeWrite(updateCmd(), h.context, r.deps));
    expect(result.error.code).toBe('PERMISSION');
    expect(result.error.message).toContain('own entries');
    expect(h.confirm).not.toHaveBeenCalled();
    expect(r.client.patch).not.toHaveBeenCalled();
  });

  it('refuses an own entry when the token lacks the self scope', async () => {
    const h = harness();
    const r = rig({ identity: identityOf({}, ['pto:read', 'pto:create']) });
    const result = failureOf(await executeWrite(updateCmd(), h.context, r.deps));
    expect(result.error.code).toBe('PERMISSION');
    expect(result.error.message).toContain('scope');
    expect(r.client.patch).not.toHaveBeenCalled();
  });

  it('refuses a teammate entry for a self-only lead token', async () => {
    const h = harness();
    const r = rig({
      identity: identityOf({ role: 'team_lead' }, ['pto:read', 'pto:update:self']),
      detail: detailOf({ user: { id: OTHER_ID, name: 'Grace', colorCode: '#000000' } }),
    });
    const result = failureOf(await executeWrite(updateCmd(), h.context, r.deps));
    expect(result.error.code).toBe('PERMISSION');
    expect(r.client.patch).not.toHaveBeenCalled();
  });

  it('allows a teammate entry for a team lead with the team scope', async () => {
    const h = harness();
    const r = rig({
      identity: identityOf({ role: 'team_lead' }, ['pto:read', 'pto:update:team']),
      detail: detailOf({ user: { id: OTHER_ID, name: 'Grace', colorCode: '#000000' } }),
    });
    const result = successOf(await executeWrite(updateCmd(), h.context, r.deps));
    expect(result.command).toBe('update');
  });

  it('allows an own entry for an administrator with the team scope', async () => {
    const h = harness();
    const r = rig({ identity: identityOf({ role: 'admin' }, ['pto:read', 'pto:update:team']) });
    const result = successOf(await executeWrite(updateCmd(), h.context, r.deps));
    expect(result.command).toBe('update');
  });

  it('refuses a member with the team scope on a teammate entry, since the role is not lead', async () => {
    const h = harness();
    const r = rig({
      identity: identityOf({ role: 'member' }, ['pto:read', 'pto:update:team']),
      detail: detailOf({ user: { id: OTHER_ID, name: 'Grace', colorCode: '#000000' } }),
    });
    const result = failureOf(await executeWrite(updateCmd(), h.context, r.deps));
    expect(result.error.code).toBe('PERMISSION');
    expect(r.client.patch).not.toHaveBeenCalled();
  });

  it('refuses a stored half-day that cannot describe a longer range without an explicit day part', async () => {
    const h = harness();
    const r = rig();
    const result = failureOf(
      await executeWrite(updateCmd({ changes: { endDate: '2026-12-02' } }), h.context, r.deps),
    );
    expect(result.error.code).toBe('USAGE');
    expect(result.error.message).toContain('explicit --day-part');
    expect(r.client.patch).not.toHaveBeenCalled();
  });

  it('accepts a longer range when the stored day part is all_day', async () => {
    const h = harness();
    const r = rig({ detail: detailOf({ dayPart: 'all_day' }) });
    const result = successOf(
      await executeWrite(updateCmd({ changes: { endDate: '2026-12-02' } }), h.context, r.deps),
    );
    expect(result.command).toBe('update');
    expect(r.client.patch.mock.calls[0]?.[2]).toEqual({ endDate: '2026-12-02' });
  });

  it('refuses a merged range that ends on a weekend without moving the date', async () => {
    const h = harness();
    const r = rig();
    const result = failureOf(
      await executeWrite(
        updateCmd({ changes: { endDate: '2026-12-06', dayPart: 'all_day' } }),
        h.context,
        r.deps,
      ),
    );
    expect(result.error.message).toContain('weekdays');
    expect(r.client.patch).not.toHaveBeenCalled();
  });

  it('refuses an update that names no field, a teammate-free stale version and invalid fields before any read', async () => {
    const h = harness();
    const r = rig();
    for (const changes of [
      {},
      { owner: OTHER_ID },
      { dayPart: 'afternoon' },
      { startDate: '2026-02-30' },
      null,
    ]) {
      const result = failureOf(await executeWrite(updateCmd({ changes }), h.context, r.deps));
      expect(result.error.code).toBe('USAGE');
    }
    expect(r.client.getIdentity).not.toHaveBeenCalled();
    expect(r.client.getDetail).not.toHaveBeenCalled();
  });

  it.each([
    ['a wildcard', '*'],
    ['a prefix', '44444444'],
    ['a trailing newline', `${ENTRY_ID}\n`],
    ['a number', 44444444],
  ])('refuses an update whose identifier is %s before any read', async (_label, id) => {
    const h = harness();
    const r = rig();
    const result = failureOf(await executeWrite(updateCmd({ id }), h.context, r.deps));
    expect(result.error.code).toBe('USAGE');
    expect(r.client.getIdentity).not.toHaveBeenCalled();
  });

  it.each([
    ['zero', 0],
    ['a negative number', -1],
    ['a fraction', 1.5],
    ['a text number', '2'],
    ['a value above int32', 2_147_483_648],
    ['not a number', Number.NaN],
  ])('refuses an update whose version is %s before any read', async (_label, version) => {
    const h = harness();
    const r = rig();
    const result = failureOf(await executeWrite(updateCmd({ version }), h.context, r.deps));
    expect(result.error.code).toBe('USAGE');
    expect(r.client.getIdentity).not.toHaveBeenCalled();
  });

  it('accepts the largest int32 version and compares it exactly', async () => {
    const h = harness();
    const max = 2_147_483_647;
    const r = rig({ detail: detailOf({ version: max }) });
    const result = successOf(await executeWrite(updateCmd({ version: max }), h.context, r.deps));
    expect(result.command).toBe('update');
    expect(r.client.patch.mock.calls[0]?.[1]).toBe(max);
  });

  it('upper-case identifiers are read and sent in their canonical lower-case form', async () => {
    const h = harness();
    const r = rig();
    await executeWrite(updateCmd({ id: ENTRY_ID.toUpperCase() }), h.context, r.deps);
    expect(r.client.getDetail.mock.calls[0]?.[0]).toBe(ENTRY_ID);
    expect(r.client.patch.mock.calls[0]?.[0]).toBe(ENTRY_ID);
  });

  it('reports a conflict after dispatch as stale, refetches once, and reports the baseline beside the current fields', async () => {
    const h = harness();
    const client = clientDouble();
    client.patch.mockRejectedValueOnce(
      new PtoApiError('STALE_WRITE', {
        status: 412,
        requestId: REQUEST_ID,
        unknownWriteOutcome: false,
      }),
    );
    client.getDetail
      .mockResolvedValueOnce(detailOf())
      .mockResolvedValueOnce(detailOf({ version: 3, dayPart: 'all_day' }));
    const r = rig({ client });
    const result = failureOf(await executeWrite(updateCmd(), h.context, r.deps));
    expect(result.error).toMatchObject({ code: 'CONFLICT', status: 412, requestId: REQUEST_ID });
    expect(result.recovery).toEqual({
      kind: 'stale',
      id: ENTRY_ID,
      expectedVersion: 2,
      before: {
        id: ENTRY_ID,
        ownerId: OWNER_ID,
        version: 2,
        startDate: '2026-12-01',
        endDate: '2026-12-01',
        dayPart: 'morning',
      },
      current: {
        id: ENTRY_ID,
        ownerId: OWNER_ID,
        version: 3,
        startDate: '2026-12-01',
        endDate: '2026-12-01',
        dayPart: 'all_day',
      },
    });
    expect(client.getDetail).toHaveBeenCalledTimes(2);
    expect(client.patch).toHaveBeenCalledTimes(1);
  });

  it('reports the current side as unavailable when the single refetch fails', async () => {
    const h = harness();
    const client = clientDouble();
    client.patch.mockRejectedValueOnce(
      new PtoApiError('STALE_WRITE', { status: 412, unknownWriteOutcome: false }),
    );
    client.getDetail
      .mockResolvedValueOnce(detailOf())
      .mockRejectedValueOnce(new PtoApiError('NETWORK_ERROR', { unknownWriteOutcome: false }));
    const r = rig({ client });
    const result = failureOf(await executeWrite(updateCmd(), h.context, r.deps));
    expect(result.recovery).toMatchObject({ kind: 'stale', current: null, before: { version: 2 } });
    expect(client.patch).toHaveBeenCalledTimes(1);
  });

  it('reports the current side as unavailable when the refetch names another entry', async () => {
    const h = harness();
    const client = clientDouble();
    client.patch.mockRejectedValueOnce(
      new PtoApiError('STALE_WRITE', { status: 412, unknownWriteOutcome: false }),
    );
    client.getDetail
      .mockResolvedValueOnce(detailOf())
      .mockResolvedValueOnce(detailOf({ id: OTHER_ID, version: 9 }));
    const r = rig({ client });
    const result = failureOf(await executeWrite(updateCmd(), h.context, r.deps));
    expect(result.recovery).toMatchObject({
      kind: 'stale',
      current: null,
      before: { id: ENTRY_ID },
    });
  });

  it('does not refetch when the caller already aborted the stale answer', async () => {
    const h = harness();
    const client = clientDouble();
    client.patch.mockImplementationOnce(async () => {
      h.controller.abort();
      throw new PtoApiError('STALE_WRITE', { status: 412, unknownWriteOutcome: false });
    });
    const r = rig({ client });
    const result = failureOf(await executeWrite(updateCmd(), h.context, r.deps));
    expect(result.recovery).toMatchObject({ kind: 'stale', current: null });
    expect(client.getDetail).toHaveBeenCalledTimes(1);
  });

  it('reports a lost PATCH answer as an outcome-unknown with the target and its version', async () => {
    const h = harness();
    const client = clientDouble();
    client.patch.mockRejectedValueOnce(
      new PtoApiError('NETWORK_ERROR', { status: 0, unknownWriteOutcome: true }),
    );
    const r = rig({ client });
    const result = failureOf(await executeWrite(updateCmd(), h.context, r.deps));
    expect(result.error.code).toBe('NETWORK');
    expect(result.error.message).toContain('outcome is unknown');
    expect(result.error.message).not.toMatch(/failed|cancelled/);
    expect(result.recovery).toEqual({ kind: 'outcome-unknown', id: ENTRY_ID, expectedVersion: 2 });
  });

  it('reports an untyped PATCH failure as an outcome-unknown, never as a definite failure', async () => {
    const h = harness();
    const client = clientDouble();
    client.patch.mockRejectedValueOnce(new TypeError('something unexpected'));
    const r = rig({ client });
    const result = failureOf(await executeWrite(updateCmd(), h.context, r.deps));
    expect(result.recovery?.kind).toBe('outcome-unknown');
    expect(JSON.stringify(result)).not.toContain('unexpected');
  });

  it('keeps the category of a definite refusal after dispatch, with no recovery', async () => {
    const h = harness();
    const client = clientDouble();
    client.patch.mockRejectedValueOnce(
      new PtoApiError('FORBIDDEN', {
        status: 403,
        requestId: REQUEST_ID,
        unknownWriteOutcome: false,
      }),
    );
    const r = rig({ client });
    const result = failureOf(await executeWrite(updateCmd(), h.context, r.deps));
    expect(result.error).toMatchObject({ code: 'PERMISSION', status: 403, requestId: REQUEST_ID });
    expect(result).not.toHaveProperty('recovery');
  });

  it('refuses to send when the caller aborted during the detail read', async () => {
    const h = harness();
    const client = clientDouble();
    client.getDetail.mockImplementationOnce(async () => {
      h.controller.abort();
      return detailOf();
    });
    const r = rig({ client });
    const result = failureOf(await executeWrite(updateCmd(), h.context, r.deps));
    expect(result.error.code).toBe('CANCELLED');
    expect(client.patch).not.toHaveBeenCalled();
  });

  it('keeps a known PATCH success even when the caller aborts after the answer was read', async () => {
    const h = harness();
    const client = clientDouble();
    client.patch.mockImplementationOnce(async () => {
      h.controller.abort();
      return recordOf({ version: 3 });
    });
    const r = rig({ client });
    const result = successOf(await executeWrite(updateCmd(), h.context, r.deps));
    expect(result.data).toMatchObject({ record: { version: 3 } });
  });

  it('reports a declined update with no PATCH', async () => {
    const h = harness({ interactive: true, confirm: async () => false });
    const r = rig();
    const result = failureOf(await executeWrite(updateCmd(), h.context, r.deps));
    expect(result.error.code).toBe('CANCELLED');
    expect(r.client.patch).not.toHaveBeenCalled();
  });
});

describe('delete', () => {
  it('reads the exact target and sends one versioned DELETE, returning the exact target and owner', async () => {
    const h = harness();
    const r = rig();
    const result = successOf(await executeWrite(deleteCmd(), h.context, r.deps));
    expect(r.client.delete.mock.calls[0]?.slice(0, 2)).toEqual([ENTRY_ID, 2]);
    expect(result).toEqual({
      schemaVersion: 1,
      ok: true,
      command: 'delete',
      data: { id: ENTRY_ID, version: 2, ownerId: OWNER_ID },
    });
  });

  it('shows the exact entry and states that it is deleted, on a terminal', async () => {
    const h = harness({ interactive: true });
    const r = rig();
    await executeWrite(deleteCmd(), h.context, r.deps);
    expect(h.confirm.mock.calls[0]?.[0]).toBe(
      [
        'Delete one PTO entry:',
        `Origin: ${ORIGIN}`,
        `Acting user: ${OWNER_ID}`,
        `Owner: ${OWNER_ID}`,
        `Entry: ${ENTRY_ID} at version 2`,
        'Dates: 2026-12-01..2026-12-01',
        'Day part: morning',
        'Changed fields: none; the entry is deleted',
      ].join('\n'),
    );
    expect(r.client.delete).toHaveBeenCalledTimes(1);
  });

  it('refuses a stale version before any DELETE', async () => {
    const h = harness();
    const r = rig({ detail: detailOf({ version: 7 }) });
    const result = failureOf(await executeWrite(deleteCmd(), h.context, r.deps));
    expect(result.recovery).toMatchObject({
      kind: 'stale',
      expectedVersion: 2,
      before: null,
      current: { version: 7 },
    });
    expect(r.client.delete).not.toHaveBeenCalled();
  });

  it('refuses a teammate entry without the team delete scope', async () => {
    const h = harness();
    const r = rig({
      detail: detailOf({ user: { id: OTHER_ID, name: 'Grace', colorCode: '#000000' } }),
    });
    const result = failureOf(await executeWrite(deleteCmd(), h.context, r.deps));
    expect(result.error.code).toBe('PERMISSION');
    expect(r.client.delete).not.toHaveBeenCalled();
  });

  it('refuses an own entry when the token lacks the self delete scope', async () => {
    const h = harness();
    const r = rig({ identity: identityOf({}, ['pto:read', 'pto:update:self']) });
    const result = failureOf(await executeWrite(deleteCmd(), h.context, r.deps));
    expect(result.error.code).toBe('PERMISSION');
    expect(r.client.delete).not.toHaveBeenCalled();
  });

  it('refuses a missing target with no DELETE', async () => {
    const h = harness();
    const client = clientDouble();
    client.getDetail.mockRejectedValueOnce(new PtoApiError('NOT_FOUND', { status: 404 }));
    const r = rig({ client });
    const result = failureOf(await executeWrite(deleteCmd(), h.context, r.deps));
    expect(result.error.code).toBe('NOT_FOUND');
    expect(client.delete).not.toHaveBeenCalled();
  });

  it('reports a conflict after dispatch as stale with the approved baseline', async () => {
    const h = harness();
    const client = clientDouble();
    client.delete.mockRejectedValueOnce(
      new PtoApiError('STALE_WRITE', { status: 412, unknownWriteOutcome: false }),
    );
    client.getDetail
      .mockResolvedValueOnce(detailOf())
      .mockResolvedValueOnce(detailOf({ version: 4 }));
    const r = rig({ client });
    const result = failureOf(await executeWrite(deleteCmd(), h.context, r.deps));
    expect(result.error.code).toBe('CONFLICT');
    expect(result.recovery).toMatchObject({
      kind: 'stale',
      expectedVersion: 2,
      before: { version: 2 },
      current: { version: 4 },
    });
  });

  it('reports a lost DELETE answer as an outcome-unknown with the exact target', async () => {
    const h = harness();
    const client = clientDouble();
    client.delete.mockRejectedValueOnce(
      new PtoApiError('NETWORK_ERROR', { unknownWriteOutcome: true }),
    );
    const r = rig({ client });
    const result = failureOf(await executeWrite(deleteCmd(), h.context, r.deps));
    expect(result.error.message).toContain('delete outcome is unknown');
    expect(result.recovery).toEqual({ kind: 'outcome-unknown', id: ENTRY_ID, expectedVersion: 2 });
  });

  it('reports a definite refusal after dispatch with no recovery', async () => {
    const h = harness();
    const client = clientDouble();
    client.delete.mockRejectedValueOnce(
      new PtoApiError('VALIDATION_ERROR', { status: 400, unknownWriteOutcome: false }),
    );
    const r = rig({ client });
    const result = failureOf(await executeWrite(deleteCmd(), h.context, r.deps));
    expect(result.error.code).toBe('USAGE');
    expect(result).not.toHaveProperty('recovery');
  });

  it('keeps a known DELETE success when the caller aborts after the answer', async () => {
    const h = harness();
    const client = clientDouble();
    client.delete.mockImplementationOnce(async () => {
      h.controller.abort();
    });
    const r = rig({ client });
    const result = successOf(await executeWrite(deleteCmd(), h.context, r.deps));
    expect(result.data).toEqual({ id: ENTRY_ID, version: 2, ownerId: OWNER_ID });
  });

  it('reports a declined delete with no DELETE', async () => {
    const h = harness({ interactive: true, confirm: async () => false });
    const r = rig();
    const result = failureOf(await executeWrite(deleteCmd(), h.context, r.deps));
    expect(result.error.code).toBe('CANCELLED');
    expect(r.client.delete).not.toHaveBeenCalled();
  });

  it('refuses before the DELETE when the caller aborted during the detail read', async () => {
    const h = harness();
    const client = clientDouble();
    client.getDetail.mockImplementationOnce(async () => {
      h.controller.abort();
      return detailOf();
    });
    const r = rig({ client });
    const result = failureOf(await executeWrite(deleteCmd(), h.context, r.deps));
    expect(result.error.code).toBe('CANCELLED');
    expect(client.delete).not.toHaveBeenCalled();
  });

  it('refuses to send when the caller aborts while the approval is pending', async () => {
    const h = harness({ interactive: true });
    h.confirm.mockImplementationOnce(async () => {
      h.controller.abort();
      return true;
    });
    const r = rig();
    const result = failureOf(await executeWrite(deleteCmd(), h.context, r.deps));
    expect(result.error.code).toBe('CANCELLED');
    expect(r.client.delete).not.toHaveBeenCalled();
  });
});

describe('redaction and hostile input', () => {
  it('removes the token, its secret and its digest from every rendered origin', async () => {
    const h = harness({ interactive: true });
    const bundle: AgentAuthCredential = {
      ...BUNDLE,
      baseUrl: `${ORIGIN}/${TOKEN}`,
    };
    const r = rig({ auth: authDouble({ bundle }) });
    await executeWrite(createCmd(), h.context, r.deps);
    const preview = h.confirm.mock.calls[0]?.[0] ?? '';
    expect(preview).not.toContain(TOKEN);
    expect(preview).not.toContain(SECRET);
    expect(preview).toContain('[redacted]');
  });

  it('cannot add a line to the preview through an identifier that contains a line break', async () => {
    const h = harness({ interactive: true });
    const r = rig({ identity: identityOf({ id: `${OWNER_ID}\nOwner: spoofed` }) });
    await executeWrite(createCmd(), h.context, r.deps);
    const lines = (h.confirm.mock.calls[0]?.[0] ?? '').split('\n');
    expect(lines).toHaveLength(9);
    expect(lines.some((line) => line.startsWith('Owner: spoofed'))).toBe(false);
  });

  it('drops a request identifier that carries the credential secret', async () => {
    const h = harness();
    const client = clientDouble();
    client.create.mockRejectedValueOnce(
      new PtoApiError('INTERNAL_ERROR', {
        status: 500,
        requestId: SECRET,
        unknownWriteOutcome: true,
      }),
    );
    const r = rig({ client });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error.requestId).toBeNull();
    expectNoSecrets(result);
  });

  it('drops a request identifier that is not a safe identifier', async () => {
    const h = harness();
    const client = clientDouble();
    client.create.mockRejectedValueOnce(
      new PtoApiError('VALIDATION_ERROR', {
        status: 400,
        requestId: 'has spaces',
        unknownWriteOutcome: false,
      }),
    );
    const r = rig({ client });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error.requestId).toBeNull();
    expect(result.error.status).toBe(400);
  });

  it('keeps an unavailable status as null and a retry hint as given', async () => {
    const h = harness();
    const client = clientDouble();
    client.create.mockRejectedValueOnce(
      new PtoApiError('RATE_LIMITED', {
        status: 429,
        retryAfterMs: 2000,
        unknownWriteOutcome: false,
      }),
    );
    const r = rig({ client });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error).toMatchObject({ code: 'QUOTA', status: 429, retryAfterMs: 2000 });
  });

  it('maps an unrecognized service code to the local category without its name', async () => {
    const h = harness();
    const client = clientDouble();
    client.create.mockRejectedValueOnce(
      new PtoApiError('TOTALLY_NEW_CODE', { status: 418, unknownWriteOutcome: false }),
    );
    const r = rig({ client });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error.code).toBe('LOCAL');
    expect(JSON.stringify(result)).not.toContain('TOTALLY_NEW_CODE');
  });

  it('reports a rejected token with its fixed category and no secret', async () => {
    const h = harness();
    const r = rig({ auth: authDouble({ error: new AgentAuthError('INVALID_TOKEN') }) });
    const result = failureOf(await executeWrite(createCmd(), h.context, r.deps));
    expect(result.error.code).toBe('AUTH');
    expectNoSecrets(result);
  });
});

describe('the seams and their defaults', () => {
  it('uses the production seams without touching them when a gate refuses first', async () => {
    const h = harness({ env: {} });
    const result = failureOf(await executeWrite(createCmd(), h.context));
    expect(result.error.code).toBe('PERMISSION');
  });

  it('uses the production journal and client defaults for any seam that is not supplied', async () => {
    const h = harness({ interactive: false });
    const r = rig();
    const result = failureOf(
      await executeWrite(createCmd({ yes: false }), h.context, {
        withCreateIntent: r.journal.journal,
      }),
    );
    expect(result.error.code).toBe('USAGE');
    expect(r.journal.calls).toHaveLength(0);
  });

  it('accepts every seam from the caller and uses none of the production defaults', async () => {
    const h = harness();
    const r = rig();
    const result = await executeWrite(createCmd(), h.context, { ...r.deps });
    expect(result.ok).toBe(true);
    expect(r.createAuth).toHaveBeenCalledTimes(1);
  });
});

describe('the exact end of every identifier pattern', () => {
  it('refuses a trailing line break after a date, identifier, profile or origin', async () => {
    const h = harness();
    const r = rig();
    const cases: WriteCommand[] = [
      createCmd({ payload: { ...MORNING, startDate: '2026-12-01\n' } }),
      createCmd({ operationId: `${OP_ID}\n` }),
      createCmd({ auth: { allowLoopbackHttp: false, profile: 'work\n' } }),
      createCmd({ auth: { allowLoopbackHttp: false, origin: `${ORIGIN}\n` } }),
      updateCmd({ id: `${ENTRY_ID}\n` }),
      deleteCmd({ id: `${ENTRY_ID}\r\n` }),
    ];
    for (const cmd of cases) {
      const result = failureOf(await executeWrite(cmd, h.context, r.deps));
      expect(result.error.code).toBe('USAGE');
    }
    expectUntouched(r, h);
  });
});

describe('the production journal with an unconfirmed hand-off', () => {
  let home: string;
  let savedHome: string | undefined;
  const journalDirectory = (): string =>
    join(home, '.local', 'state', 'pto-calendar', 'create-intents');
  const ownerRecords = (): string[] => {
    try {
      return readdirSync(journalDirectory()).filter((name) => name.startsWith('owner-'));
    } catch {
      return [];
    }
  };

  beforeEach(() => {
    savedHome = process.env['HOME'];
    home = mkdtempSync(join(tmpdir(), 'pto262-journal-'));
    process.env['HOME'] = home;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('keeps the pending record on an unconfirmed hand-off, refuses a plain retry, and resumes the same key', async () => {
    const r = rig({ journal: {} });
    const deps: WriteDependencies = { ...r.deps, withCreateIntent };
    const first = successOf(
      await executeWrite(createCmd(), harness({ publish: async () => false }).context, deps),
    );
    const operationId = (first.data as { readonly operationId: string }).operationId;
    expect(ownerRecords()).toHaveLength(1);
    const firstKey = r.client.create.mock.calls[0]?.[1];
    expect(firstKey).toMatch(/^v1\.\d{13}\.[0-9a-f-]{36}$/);

    const second = failureOf(await executeWrite(createCmd(), harness().context, deps));
    expect(second.error.code).toBe('CONFLICT');
    expect(second.recovery).toMatchObject({ kind: 'create-pending', operationId });
    expect(r.client.create).toHaveBeenCalledTimes(1);

    r.client.create.mockResolvedValueOnce({ ...CREATED, replayed: true });
    const resumed = successOf(
      await executeWrite(
        createCmd({ operationId }),
        harness({ publish: async () => true }).context,
        deps,
      ),
    );
    expect(resumed.data).toMatchObject({ operationId, replayed: true });
    expect(r.client.create.mock.calls[1]?.[1]).toBe(firstKey);
    expect(ownerRecords()).toHaveLength(0);
  });

  it('clears a fresh pending record after a proven refusal of the service', async () => {
    const client = clientDouble();
    client.create.mockRejectedValueOnce(
      new PtoApiError('VALIDATION_ERROR', { status: 400, unknownWriteOutcome: false }),
    );
    const r = rig({ client });
    const deps: WriteDependencies = { ...r.deps, withCreateIntent };
    const result = failureOf(await executeWrite(createCmd(), harness().context, deps));
    expect(result.error.code).toBe('USAGE');
    expect(ownerRecords()).toHaveLength(0);
  });

  it('removes the pending record when the host confirms delivery', async () => {
    const r = rig();
    const deps: WriteDependencies = { ...r.deps, withCreateIntent };
    const result = successOf(
      await executeWrite(createCmd(), harness({ publish: async () => true }).context, deps),
    );
    expect(result.command).toBe('create');
    expect(ownerRecords()).toHaveLength(0);
  });
});
