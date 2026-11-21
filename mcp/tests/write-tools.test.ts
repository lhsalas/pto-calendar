import { describe, expect, it } from 'vitest';

import {
  AgentAuthError,
  type AgentAuth,
  type AgentAuthCredential,
  type AgentAuthErrorCode,
  type ResolveInput,
} from '@pto-calendar/agent-auth';
import {
  PtoApiError,
  type CreatePtoPayload,
  type CreatePtoResult,
  type PatchPtoChanges,
  type PtoClientOptions,
  type PtoDayPart,
  type PtoDetail,
  type PtoIdentity,
  type PtoRecord,
  type PtoScope,
  type RequestOptions,
} from '@pto-calendar/api-client';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

import type { LaunchOptions } from '../src/contract.js';
import {
  CREATE_OUTPUT_SCHEMA,
  DELETE_OUTPUT_SCHEMA,
  UPDATE_OUTPUT_SCHEMA,
} from '../src/write-schema.js';
import {
  CreateKeyRegistry,
  MutationGuard,
  PreviewStore,
  createKeyFingerprint,
  credentialFingerprint,
  payloadDigest,
  type PreviewBinding,
} from '../src/write-preview.js';
import {
  WRITE_TOOL_DEFINITIONS,
  anyToolFailure,
  executeTool,
  executeWriteTool,
  writeToolFailure,
  type WriteClient,
  type WriteToolDependencies,
} from '../src/write-tools.js';
import type {
  CreateArguments,
  DeleteArguments,
  UpdateArguments,
  WriteArguments,
  WriteError,
  WriteToolName,
  WriteToolResult,
} from '../src/write-contract.js';

const SECRET = 'a'.repeat(64);
const TOKEN_ID = '11111111-2222-4333-8444-555555555555';
const TOKEN = `pto_pat_${TOKEN_ID}.${SECRET}`;
const TOKEN_TWO = `pto_pat_22222222-2222-4222-8222-222222222222.${'b'.repeat(64)}`;
const ORIGIN = 'https://pto.example.test';
const ORIGIN_TWO = 'https://other.example.test';
const ACTOR = '11111111-aaaa-4111-8111-000000000001';
const RECORD_ID = '11111111-aaaa-4111-8111-000000000002';
const COLLEAGUE = '11111111-aaaa-4111-8111-000000000003';
const REQUEST_ID = '77777777-7777-4777-8777-777777777777';
const PREVIEW_ID = '22222222-2222-4222-8222-222222222222';
const KEY = 'v1.1700000000000.11111111-1111-4111-8111-111111111111';
const KEY_TWO = 'v1.1700000000001.22222222-2222-4222-8222-222222222222';
const NOW = 1_000_000;
const DAY = '2026-12-07';
const OTHER_DAY = '2026-12-09';
const LAUNCH: LaunchOptions = { allowLoopbackHttp: false };
const ENABLED: NodeJS.ProcessEnv = { PTO_MCP_WRITES: '1' };

const SCOPES: PtoScope[] = ['pto:read', 'pto:create', 'pto:update:self', 'pto:delete:self'];

const BUNDLE: AgentAuthCredential = {
  baseUrl: ORIGIN,
  credential: { origin: ORIGIN, token: TOKEN },
  allowLoopbackHttp: false,
  profile: 'default',
  source: 'keyring',
};

const DETAIL: PtoDetail = {
  id: RECORD_ID,
  user: { id: ACTOR, name: 'Ada Lovelace', colorCode: '#336699' },
  startDate: DAY,
  endDate: DAY,
  dayPart: 'all_day',
  note: 'hidden synthetic note',
  version: 3,
};

const RECORD: PtoRecord = {
  id: RECORD_ID,
  userId: ACTOR,
  startDate: DAY,
  endDate: DAY,
  dayPart: 'all_day',
  note: 'hidden synthetic note',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-21T00:00:01.000Z',
  version: 4,
};

const CREATED: CreatePtoResult = {
  record: RECORD,
  replayed: false,
  expiresAt: '2026-11-22T00:00:00.000Z',
};

const CREATE: CreateArguments = {
  name: 'pto_create',
  mode: 'preview',
  startDate: DAY,
  endDate: DAY,
  dayPart: 'all_day',
  idempotencyKey: KEY,
};

const UPDATE: UpdateArguments = {
  name: 'pto_update',
  mode: 'preview',
  id: RECORD_ID,
  expectedVersion: 3,
  changes: { dayPart: 'morning' },
};

const DELETE: DeleteArguments = {
  name: 'pto_delete',
  mode: 'preview',
  id: RECORD_ID,
  expectedVersion: 3,
};

/** One live identity with the requested overrides. */
function identity(
  overrides: {
    readonly id?: string;
    readonly role?: PtoIdentity['role'];
    readonly tokenId?: string;
    readonly scopes?: PtoScope[];
  } = {},
): PtoIdentity {
  return {
    id: overrides.id ?? ACTOR,
    role: overrides.role ?? 'member',
    auth: {
      method: 'pat',
      tokenId: overrides.tokenId ?? TOKEN_ID,
      scopes: [...(overrides.scopes ?? SCOPES)],
      expiresAt: '2030-01-01T00:00:00.000Z',
    },
  };
}

/** A local credential store whose current bundle a test may replace. */
class FakeAuth implements AgentAuth {
  bundle: AgentAuthCredential | Error;
  readonly calls: ResolveInput[] = [];
  onResolve: ((input: ResolveInput) => void) | undefined;

  constructor(bundle: AgentAuthCredential | Error = BUNDLE) {
    this.bundle = bundle;
  }

  readonly setProfile = async (): Promise<never> => {
    throw new Error('a tool call never stores a credential');
  };

  readonly resolve = async (input: ResolveInput = {}): Promise<AgentAuthCredential> => {
    this.calls.push(input);
    this.onResolve?.(input);
    if (this.bundle instanceof Error) throw this.bundle;
    return this.bundle;
  };

  readonly status = async (): Promise<never> => {
    throw new Error('a tool call never reports the credential state');
  };

  readonly removeProfile = async (): Promise<never> => {
    throw new Error('a tool call never removes a credential');
  };
}

/** The recorded calls of the fake shared client. */
interface Calls {
  readonly identity: RequestOptions[];
  readonly detail: { readonly id: string; readonly options: RequestOptions }[];
  readonly create: {
    readonly payload: CreatePtoPayload;
    readonly key: string;
    readonly options: RequestOptions;
  }[];
  readonly patch: {
    readonly id: string;
    readonly version: number;
    readonly changes: PatchPtoChanges;
    readonly options: RequestOptions;
  }[];
  readonly delete: {
    readonly id: string;
    readonly version: number;
    readonly options: RequestOptions;
  }[];
}

/** The handlers a test may replace. */
interface Handlers {
  identity?: (options: RequestOptions) => Promise<PtoIdentity>;
  detail?: (id: string, options: RequestOptions) => Promise<PtoDetail>;
  create?: (
    payload: CreatePtoPayload,
    key: string,
    options: RequestOptions,
  ) => Promise<CreatePtoResult>;
  patch?: (
    id: string,
    version: number,
    changes: PatchPtoChanges,
    options: RequestOptions,
  ) => Promise<PtoRecord>;
  delete?: (id: string, version: number, options: RequestOptions) => Promise<void>;
}

/** A shared client that records every call and returns the configured answer. */
class FakeClient implements WriteClient {
  readonly calls: Calls = { identity: [], detail: [], create: [], patch: [], delete: [] };
  identityValue: PtoIdentity = identity();
  detailValue: PtoDetail = DETAIL;
  handlers: Handlers;

  constructor(handlers: Handlers = {}) {
    this.handlers = handlers;
  }

  async getIdentity(options: RequestOptions = {}): Promise<PtoIdentity> {
    this.calls.identity.push(options);
    return this.handlers.identity ? await this.handlers.identity(options) : this.identityValue;
  }

  async getDetail(id: string, options: RequestOptions = {}): Promise<PtoDetail> {
    this.calls.detail.push({ id, options });
    return this.handlers.detail ? await this.handlers.detail(id, options) : this.detailValue;
  }

  async create(
    payload: CreatePtoPayload,
    key: string,
    options: RequestOptions = {},
  ): Promise<CreatePtoResult> {
    this.calls.create.push({ payload, key, options });
    return this.handlers.create ? await this.handlers.create(payload, key, options) : CREATED;
  }

  async patch(
    id: string,
    version: number,
    changes: PatchPtoChanges,
    options: RequestOptions = {},
  ): Promise<PtoRecord> {
    this.calls.patch.push({ id, version, changes, options });
    return this.handlers.patch ? await this.handlers.patch(id, version, changes, options) : RECORD;
  }

  async delete(id: string, version: number, options: RequestOptions = {}): Promise<void> {
    this.calls.delete.push({ id, version, options });
    return this.handlers.delete ? await this.handlers.delete(id, version, options) : undefined;
  }
}

/** The dependencies of one call and the calls they recorded. */
interface Harness {
  dependencies: WriteToolDependencies;
  readonly auth: FakeAuth;
  readonly client: FakeClient;
  readonly previews: PreviewStore;
  readonly mutations: MutationGuard;
  readonly createKeys: CreateKeyRegistry;
  readonly clock: { now: number };
  readonly clientOptions: PtoClientOptions[];
}

/** Builds the dependencies of one call with a frozen clock. */
function harness(
  options: {
    readonly auth?: AgentAuthCredential | Error;
    readonly handlers?: Handlers;
    readonly previews?: PreviewStore;
    readonly createKeys?: CreateKeyRegistry;
    readonly now?: () => number;
    readonly requestId?: () => string;
  } = {},
): Harness {
  const clock = { now: NOW };
  const now = options.now ?? (() => clock.now);
  const auth = new FakeAuth(options.auth ?? BUNDLE);
  const client = new FakeClient(options.handlers);
  const previews = options.previews ?? new PreviewStore({ now });
  const mutations = new MutationGuard();
  const createKeys = options.createKeys ?? new CreateKeyRegistry();
  const clientOptions: PtoClientOptions[] = [];
  const dependencies: WriteToolDependencies = {
    createAuth: () => auth,
    createClient: (value) => {
      clientOptions.push(value);
      return client;
    },
    now,
    newRequestId: options.requestId ?? (() => REQUEST_ID),
    previews,
    mutations,
    createKeys,
  };
  return { dependencies, auth, client, previews, mutations, createKeys, clock, clientOptions };
}

/** The raw protocol arguments of one validated test argument object. */
function inputOf(value: WriteArguments | Record<string, unknown>): unknown {
  if (typeof value === 'object' && value !== null && 'name' in value) {
    const { name: _name, ...rest } = value as WriteArguments;
    return rest;
  }
  return value;
}

/** Runs one mutation call. */
function run(
  target: Harness,
  name: WriteToolName,
  args: WriteArguments | Record<string, unknown>,
  options: { readonly env?: NodeJS.ProcessEnv; readonly signal?: AbortSignal } = {},
): Promise<WriteToolResult> {
  return executeWriteTool(
    name,
    inputOf(args),
    LAUNCH,
    options.env ?? ENABLED,
    options.signal ?? new AbortController().signal,
    target.dependencies,
  );
}

/** The data of a successful result. */
function dataOf(result: WriteToolResult): Record<string, unknown> {
  if (!result.ok)
    throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result.data as unknown as Record<string, unknown>;
}

/** The error of a failed result. */
function errorOf(result: WriteToolResult): WriteError {
  if (result.ok) throw new Error('expected a failure');
  return result.error;
}

/** The preview reference of a successful preview. */
function previewIdOf(result: WriteToolResult): string {
  return String(dataOf(result)['previewId']);
}

/** Validates one result against the advertised output schema of its tool. */
function validatesOutput(tool: WriteToolName, value: unknown): boolean {
  const schema =
    tool === 'pto_create'
      ? CREATE_OUTPUT_SCHEMA
      : tool === 'pto_update'
        ? UPDATE_OUTPUT_SCHEMA
        : DELETE_OUTPUT_SCHEMA;
  const validator = new AjvJsonSchemaValidator();
  const compiled = validator.getValidator(schema as Parameters<typeof validator.getValidator>[0]);
  return compiled(value).valid;
}

/** Whether every result shape used in the tests conforms to its schema. */
function expectValid(tool: WriteToolName, result: WriteToolResult): void {
  expect(validatesOutput(tool, result)).toBe(true);
}

/** The words that may not appear in a mutation answer. */
const PRIVATE = [
  TOKEN,
  SECRET,
  KEY,
  KEY_TWO,
  'hidden synthetic note',
  'caller synthetic note',
  'Ada Lovelace',
];

/** The JSON of one result, for a leak check. */
function jsonOf(result: WriteToolResult): string {
  return JSON.stringify(result);
}

/** The plan of one create preview. */
function createPlan(overrides: Partial<CreateArguments> = {}): CreateArguments {
  return { ...CREATE, ...overrides };
}

/** Issues one manual binding with the exact canonical create digest. */
function manualCreateBinding(
  target: Harness,
  args: CreateArguments,
  overrides: Partial<PreviewBinding> = {},
  observe = true,
): string {
  const plan = {
    startDate: args.startDate,
    endDate: args.endDate,
    dayPart: args.startDate === args.endDate ? args.dayPart : ('all_day' as PtoDayPart),
  };
  const binding: PreviewBinding = {
    operation: 'create',
    actorId: ACTOR,
    ownerId: ACTOR,
    origin: ORIGIN,
    tokenId: TOKEN_ID,
    credential: credentialFingerprint(
      target.auth.bundle instanceof Error ? TOKEN : target.auth.bundle.credential.token,
    ),
    digest: payloadDigest({
      operation: 'create',
      startDate: args.startDate,
      endDate: args.endDate,
      dayPart: args.dayPart,
      note: args.note ?? null,
      idempotencyKey: args.idempotencyKey,
    }),
    role: 'member',
    target: null,
    before: null,
    after: plan,
    changedFields: ['startDate', 'endDate', 'dayPart'],
    noteIntent: 'none',
    ...overrides,
  };
  if (observe) {
    const liveBundle = target.auth.bundle instanceof Error ? BUNDLE : target.auth.bundle;
    target.createKeys.observe(createKeyFingerprint(args.idempotencyKey), {
      origin: liveBundle.baseUrl,
      actorId: target.client.identityValue.id,
      tokenId: target.client.identityValue.auth.tokenId,
      credential: credentialFingerprint(liveBundle.credential.token),
      intent: binding.digest,
    });
  }
  const issued = target.previews.issue(binding);
  if (issued === null) throw new Error('the preview store refused the manual binding');
  return issued.id;
}

/** Issues one manual update binding with the exact canonical digest. */
function manualUpdateBinding(
  target: Harness,
  args: UpdateArguments,
  overrides: Partial<PreviewBinding> = {},
): string {
  const changes: Record<string, unknown> = {};
  if (args.changes.startDate !== undefined) changes['startDate'] = args.changes.startDate;
  if (args.changes.endDate !== undefined) changes['endDate'] = args.changes.endDate;
  if (args.changes.dayPart !== undefined) changes['dayPart'] = args.changes.dayPart;
  if (args.changes.note !== undefined) changes['note'] = args.changes.note;
  const binding: PreviewBinding = {
    operation: 'update',
    actorId: ACTOR,
    ownerId: ACTOR,
    origin: ORIGIN,
    tokenId: TOKEN_ID,
    credential: credentialFingerprint(TOKEN),
    digest: payloadDigest({
      operation: 'update',
      id: args.id,
      expectedVersion: args.expectedVersion,
      changes,
    }),
    role: 'member',
    target: { id: args.id, version: args.expectedVersion },
    before: { startDate: DETAIL.startDate, endDate: DETAIL.endDate, dayPart: DETAIL.dayPart },
    after: { startDate: DETAIL.startDate, endDate: DETAIL.endDate, dayPart: DETAIL.dayPart },
    changedFields: [],
    noteIntent: 'keep',
    ...overrides,
  };
  const issued = target.previews.issue(binding);
  if (issued === null) throw new Error('the preview store refused the manual binding');
  return issued.id;
}

/* ------------------------------------------------------------------------- */
/* Definitions and the local switch.                                         */
/* ------------------------------------------------------------------------- */

describe('the mutation definitions', () => {
  it('are exactly three strict, non-read-only tools with accurate hints', () => {
    expect(WRITE_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      'pto_create',
      'pto_update',
      'pto_delete',
    ]);
    const parsed = ListToolsResultSchema.parse({ tools: WRITE_TOOL_DEFINITIONS }).tools;
    expect(parsed).toHaveLength(3);
    for (const tool of parsed) {
      expect(tool.annotations?.readOnlyHint).toBe(false);
      expect(tool.annotations?.openWorldHint).toBe(true);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.required).toContain('mode');
    }
    const create = parsed.find((tool) => tool.name === 'pto_create');
    const update = parsed.find((tool) => tool.name === 'pto_update');
    const remove = parsed.find((tool) => tool.name === 'pto_delete');
    expect(create?.annotations).toMatchObject({ destructiveHint: false, idempotentHint: true });
    expect(update?.annotations).toMatchObject({ destructiveHint: true, idempotentHint: false });
    expect(remove?.annotations).toMatchObject({ destructiveHint: true, idempotentHint: false });
    const inputs = JSON.stringify(WRITE_TOOL_DEFINITIONS.map((tool) => tool.inputSchema));
    for (const forbidden of ['actAs', 'confirmed', 'ownerId', 'tokenId', 'origin', 'url']) {
      expect(inputs).not.toContain(`"${forbidden}"`);
    }
  });
});

describe('the exact local write switch', () => {
  it('refuses a write without the exact own PTO_MCP_WRITES=1 before any store', async () => {
    const target = harness();
    for (const env of [
      {},
      { PTO_MCP_WRITES: 'true' },
      { PTO_MCP_WRITES: ' 1' },
      { PTO_MCP_WRITES: '0' },
      Object.assign(Object.create({ PTO_MCP_WRITES: '1' }), {}),
    ] as NodeJS.ProcessEnv[]) {
      const result = await run(target, 'pto_create', createPlan(), { env });
      expect(errorOf(result).code).toBe('PERMISSION');
      expect(errorOf(result).message).toContain('PTO_MCP_WRITES=1');
    }
    expect(target.auth.calls).toHaveLength(0);
    expect(target.clientOptions).toHaveLength(0);
  });

  it('refuses an already cancelled call before any store', async () => {
    const target = harness();
    const control = new AbortController();
    control.abort();
    const result = await run(target, 'pto_create', createPlan(), { signal: control.signal });
    expect(errorOf(result).code).toBe('CANCELLED');
    expect(target.auth.calls).toHaveLength(0);
  });

  it('refuses malformed arguments before any store or request', async () => {
    const target = harness();
    const result = await run(target, 'pto_create', { mode: 'preview', extra: true });
    expect(errorOf(result)).toMatchObject({ code: 'INPUT', recovery: 'none' });
    expect(target.auth.calls).toHaveLength(0);
    expect(target.clientOptions).toHaveLength(0);
  });

  it('requires reconciliation of an invalid apply without opening any store or client', async () => {
    const target = harness();
    const intents = [
      ['pto_create', createPlan()],
      ['pto_update', UPDATE],
      ['pto_delete', DELETE],
    ] as const;
    for (const [tool, intent] of intents) {
      for (const preview of [{}, { previewId: 'not-a-preview' }, { previewId: null }]) {
        const result = await run(target, tool, { ...intent, mode: 'apply', ...preview });
        const error = errorOf(result);
        expect(error).toMatchObject({ code: 'INPUT', recovery: 'reconcile' });
        expect(error.message).toContain('This call sent no mutation');
        expect(error.message).toContain('an earlier attempt may have committed');
        expect(error.message).toContain('before preparing a new preview');
        expect(error.message).toContain('with a new key or changed credential');
        expect(error.message).not.toContain('not-a-preview');
      }
    }
    expect(target.auth.calls).toHaveLength(0);
    expect(target.clientOptions).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------- */
/* Create preview.                                                           */
/* ------------------------------------------------------------------------- */

describe('the create preview', () => {
  it('names the live actor and derived owner and dispatches no mutation', async () => {
    const target = harness();
    const result = await run(target, 'pto_create', createPlan());
    const data = dataOf(result);
    expect(result).toMatchObject({ ok: true, tool: 'pto_create' });
    expect(data).toMatchObject({
      phase: 'preview',
      operation: 'create',
      actorId: ACTOR,
      ownerId: ACTOR,
      target: null,
      before: null,
      after: { startDate: DAY, endDate: DAY, dayPart: 'all_day' },
      changedFields: ['startDate', 'endDate', 'dayPart'],
      noteIntent: 'none',
    });
    expect(previewIdOf(result)).toMatch(/^[0-9a-f-]{36}$/);
    expect(target.client.calls.identity).toHaveLength(1);
    expect(target.client.calls.detail).toHaveLength(0);
    expect(target.client.calls.create).toHaveLength(0);
    expect(target.client.calls.patch).toHaveLength(0);
    expect(target.client.calls.delete).toHaveLength(0);
    expect(target.clientOptions[0]).toMatchObject({
      baseUrl: ORIGIN,
      credential: { origin: ORIGIN, token: TOKEN },
      allowLoopbackHttp: false,
      timeoutMs: 20_000,
      readRetries: 2,
    });
    expect(target.client.calls.identity[0]?.signal).toBeTypeOf('object');
    expect(target.client.calls.identity[0]?.timeoutMs).toBeGreaterThan(0);
    expectValid('pto_create', result);
    for (const value of PRIVATE) expect(jsonOf(result)).not.toContain(value);
  });

  it('shows the effective all_day of a longer range next to the request', async () => {
    const target = harness();
    const result = await run(
      target,
      'pto_create',
      createPlan({ startDate: DAY, endDate: OTHER_DAY, dayPart: 'morning' }),
    );
    expect(dataOf(result)['after']).toEqual({
      startDate: DAY,
      endDate: OTHER_DAY,
      dayPart: 'all_day',
    });
  });

  it('shows the note intention and never the note text', async () => {
    const withNoteTarget = harness();
    const withNote = await run(
      withNoteTarget,
      'pto_create',
      createPlan({ note: 'caller synthetic note' }),
    );
    expect(dataOf(withNote)['noteIntent']).toBe('set');
    expect(dataOf(withNote)['changedFields']).toContain('note');
    expect(jsonOf(withNote)).not.toContain('caller synthetic note');
    const emptyTarget = harness();
    const empty = await run(emptyTarget, 'pto_create', createPlan({ note: '' }));
    expect(dataOf(empty)['noteIntent']).toBe('none');
    expect(dataOf(empty)['changedFields']).not.toContain('note');
  });

  it('refuses a credential without pto:create', async () => {
    const target = harness();
    target.client.identityValue = identity({ scopes: ['pto:read'] });
    const result = await run(target, 'pto_create', createPlan());
    expect(errorOf(result)).toMatchObject({ code: 'PERMISSION', recovery: 'reauthenticate' });
    expect(target.client.calls.create).toHaveLength(0);
  });

  it('maps every local credential failure without opening a client', async () => {
    const cases: Array<[AgentAuthErrorCode, string]> = [
      ['PROFILE_NOT_CONFIGURED', 'AUTH'],
      ['FILE_BUSY', 'BUSY'],
      ['INVALID_PROFILE', 'LOCAL'],
    ];
    for (const [code, expected] of cases) {
      const target = harness({ auth: new AgentAuthError(code) });
      const result = await run(target, 'pto_create', createPlan());
      expect(errorOf(result).code).toBe(expected);
      expect(target.clientOptions).toHaveLength(0);
    }
  });

  it('treats an unknown local error and an unknown auth code as local faults', async () => {
    const broken = harness({ auth: new Error('unexpected') });
    expect(errorOf(await run(broken, 'pto_create', createPlan())).code).toBe('LOCAL');
    const unknown = new AgentAuthError('NOT_A_REAL_CODE' as AgentAuthErrorCode);
    const target = harness({ auth: unknown });
    expect(errorOf(await run(target, 'pto_create', createPlan())).code).toBe('LOCAL');
  });

  it('stops a cancelled credential lookup', async () => {
    const target = harness();
    const control = new AbortController();
    target.auth.onResolve = () => control.abort();
    const result = await run(target, 'pto_create', createPlan(), { signal: control.signal });
    expect(errorOf(result).code).toBe('CANCELLED');
    const cancelled = harness({ auth: new AgentAuthError('INPUT_CANCELLED') });
    expect(errorOf(await run(cancelled, 'pto_create', createPlan())).code).toBe('CANCELLED');

    const failing = harness();
    const failingControl = new AbortController();
    failing.auth.onResolve = () => failingControl.abort();
    failing.auth.bundle = new AgentAuthError('PROFILE_NOT_CONFIGURED');
    expect(
      errorOf(await run(failing, 'pto_create', createPlan(), { signal: failingControl.signal }))
        .code,
    ).toBe('CANCELLED');
  });

  it('fails closed when the client cannot be created or the identity read fails', async () => {
    const target = harness();
    target.dependencies = {
      ...target.dependencies,
      createClient: () => {
        throw new Error('broken client');
      },
    };
    expect(errorOf(await run(target, 'pto_create', createPlan())).code).toBe('LOCAL');

    const timeout = harness({
      handlers: { identity: async () => Promise.reject(new PtoApiError('TIMEOUT')) },
    });
    const timed = await run(timeout, 'pto_create', createPlan());
    expect(errorOf(timed).code).toBe('NETWORK');
    expect(errorOf(timed).message).toContain('time budget');

    const unexpected = harness({
      handlers: { identity: async () => Promise.reject(new Error('unexpected')) },
    });
    expect(errorOf(await run(unexpected, 'pto_create', createPlan())).code).toBe('LOCAL');
  });

  it('stops a call whose identity read is cancelled', async () => {
    const target = harness();
    const control = new AbortController();
    target.client.handlers = {
      identity: async () => {
        control.abort();
        throw new PtoApiError('ABORTED');
      },
    };
    const result = await run(target, 'pto_create', createPlan(), { signal: control.signal });
    expect(errorOf(result).code).toBe('CANCELLED');
  });

  it('refuses a new preview when the bounded store is full', async () => {
    const previews = new PreviewStore({ now: () => NOW, limit: 1 });
    const target = harness({ previews });
    expect(previews.issue(manualBindingOf())).not.toBeNull();
    const result = await run(
      target,
      'pto_create',
      createPlan({ startDate: OTHER_DAY, endDate: OTHER_DAY }),
    );
    expect(errorOf(result).code).toBe('BUSY');
    expect(target.client.calls.create).toHaveLength(0);
  });
});

/** One dummy binding that only fills the bounded preview store. */
function manualBindingOf(): PreviewBinding {
  return {
    operation: 'create',
    actorId: ACTOR,
    ownerId: ACTOR,
    origin: ORIGIN,
    tokenId: TOKEN_ID,
    credential: credentialFingerprint(TOKEN),
    digest: payloadDigest({ dummy: true }),
    role: 'member',
    target: null,
    before: null,
    after: { startDate: DAY, endDate: DAY, dayPart: 'all_day' },
    changedFields: [],
    noteIntent: 'none',
  };
}

/* ------------------------------------------------------------------------- */
/* Create apply.                                                             */
/* ------------------------------------------------------------------------- */

describe('the create apply', () => {
  it('dispatches one create with the exact payload and key, and nothing else', async () => {
    const target = harness();
    const plan = createPlan({ note: 'caller synthetic note' });
    const preview = await run(target, 'pto_create', plan);
    const previewId = previewIdOf(preview);
    const result = await run(target, 'pto_create', {
      ...plan,
      mode: 'apply',
      previewId,
    });
    const data = dataOf(result);
    expect(target.client.calls.create).toHaveLength(1);
    const sent = target.client.calls.create[0];
    expect(sent?.payload).toEqual({
      startDate: DAY,
      endDate: DAY,
      dayPart: 'all_day',
      note: 'caller synthetic note',
    });
    expect(sent?.key).toBe(KEY);
    expect(sent?.options.signal).toBeTypeOf('object');
    expect(sent?.options.timeoutMs).toBeGreaterThan(0);
    expect(data).toMatchObject({
      phase: 'apply',
      operation: 'create',
      replayed: false,
      expiresAt: CREATED.expiresAt,
      record: { id: RECORD_ID, ownerId: ACTOR, version: 4 },
    });
    expect(target.client.calls.identity).toHaveLength(2);
    expect(target.client.calls.detail).toHaveLength(0);
    expect(target.client.calls.patch).toHaveLength(0);
    expect(target.client.calls.delete).toHaveLength(0);
    expectValid('pto_create', result);
    for (const value of PRIVATE) expect(jsonOf(result)).not.toContain(value);
  });

  it('keeps the create body free of an empty or omitted note', async () => {
    const target = harness();
    const plan = createPlan();
    const previewId = previewIdOf(await run(target, 'pto_create', plan));
    await run(target, 'pto_create', { ...plan, mode: 'apply', previewId });
    expect(Object.hasOwn(target.client.calls.create[0]?.payload ?? {}, 'note')).toBe(false);
  });

  it('refuses an unknown preview before opening the store', async () => {
    const target = harness();
    const result = await run(target, 'pto_create', {
      ...createPlan(),
      mode: 'apply',
      previewId: PREVIEW_ID,
    });
    expect(errorOf(result)).toMatchObject({ code: 'PREVIEW', recovery: 'reconcile' });
    expect(errorOf(result).message).toContain('an earlier attempt may have committed');
    expect(errorOf(result).message).toContain('before preparing a new preview');
    expect(errorOf(result).message).toContain('with a new key or changed credential');
    expect(target.auth.calls).toHaveLength(0);
  });

  it('refuses every mismatch between the preview and the apply', async () => {
    const cases: Array<Partial<CreateArguments>> = [
      { dayPart: 'evening' },
      { idempotencyKey: KEY_TWO },
      { note: 'caller synthetic note' },
      { startDate: OTHER_DAY, endDate: OTHER_DAY },
    ];
    for (const mismatch of cases) {
      const target = harness();
      const plan = createPlan();
      const previewId = previewIdOf(await run(target, 'pto_create', plan));
      const result = await run(target, 'pto_create', {
        ...plan,
        ...mismatch,
        mode: 'apply',
        previewId,
      });
      expect(errorOf(result)).toMatchObject({ code: 'PREVIEW', recovery: 'reconcile' });
      expect(errorOf(result).message).toContain('an earlier attempt may have committed');
      expect(errorOf(result).message).toContain('before preparing a new preview');
      expect(target.client.calls.create).toHaveLength(0);
    }
  });

  it('refuses an apply from a rotated credential, another actor or another origin', async () => {
    const rotated = harness();
    const plan = createPlan();
    const rotatedId = previewIdOf(await run(rotated, 'pto_create', plan));
    rotated.auth.bundle = {
      ...BUNDLE,
      credential: { origin: ORIGIN, token: TOKEN_TWO },
    };
    expect(
      errorOf(await run(rotated, 'pto_create', { ...plan, mode: 'apply', previewId: rotatedId }))
        .code,
    ).toBe('PERMISSION');
    expect(rotated.client.calls.create).toHaveLength(0);

    const movedOrigin = harness();
    const originId = previewIdOf(await run(movedOrigin, 'pto_create', plan));
    movedOrigin.auth.bundle = { ...BUNDLE, baseUrl: ORIGIN_TWO };
    expect(
      errorOf(await run(movedOrigin, 'pto_create', { ...plan, mode: 'apply', previewId: originId }))
        .code,
    ).toBe('PERMISSION');
    expect(movedOrigin.client.calls.create).toHaveLength(0);

    const actor = harness();
    const actorId = previewIdOf(await run(actor, 'pto_create', plan));
    actor.client.identityValue = identity({ id: COLLEAGUE });
    expect(
      errorOf(await run(actor, 'pto_create', { ...plan, mode: 'apply', previewId: actorId })).code,
    ).toBe('PERMISSION');
    expect(actor.client.calls.create).toHaveLength(0);

    const tokenId = harness();
    const tokenIdValue = previewIdOf(await run(tokenId, 'pto_create', plan));
    tokenId.client.identityValue = identity({ tokenId: '22222222-2222-4222-8222-222222222222' });
    expect(
      errorOf(await run(tokenId, 'pto_create', { ...plan, mode: 'apply', previewId: tokenIdValue }))
        .code,
    ).toBe('PERMISSION');
    expect(tokenId.client.calls.create).toHaveLength(0);
  });

  it('re-checks the live create scope at apply', async () => {
    const target = harness();
    const plan = createPlan();
    const previewId = previewIdOf(await run(target, 'pto_create', plan));
    target.client.identityValue = identity({ scopes: ['pto:read'] });
    const result = await run(target, 'pto_create', { ...plan, mode: 'apply', previewId });
    expect(errorOf(result).code).toBe('PERMISSION');
    expect(target.client.calls.create).toHaveLength(0);
  });

  it('refuses a manual binding that names another owner or another proposed range', async () => {
    const owner = harness();
    const ownerId = manualCreateBinding(owner, createPlan(), { ownerId: COLLEAGUE });
    expect(
      errorOf(
        await run(owner, 'pto_create', { ...createPlan(), mode: 'apply', previewId: ownerId }),
      ).code,
    ).toBe('PERMISSION');
    expect(owner.client.calls.create).toHaveLength(0);

    const range = harness();
    const rangeId = manualCreateBinding(range, createPlan(), { after: null });
    expect(
      errorOf(
        await run(range, 'pto_create', { ...createPlan(), mode: 'apply', previewId: rangeId }),
      ).code,
    ).toBe('PREVIEW');
    expect(range.client.calls.create).toHaveLength(0);

    const intent = harness();
    const intentId = manualCreateBinding(intent, createPlan(), { noteIntent: 'set' });
    expect(
      errorOf(
        await run(intent, 'pto_create', { ...createPlan(), mode: 'apply', previewId: intentId }),
      ).code,
    ).toBe('PREVIEW');
    expect(intent.client.calls.create).toHaveLength(0);
  });

  it('reports a lost create answer as unknown and allows the exact same intent to replay', async () => {
    const target = harness();
    target.client.handlers = {
      create: async () => {
        throw new PtoApiError('NETWORK_ERROR', { unknownWriteOutcome: true });
      },
    };
    const plan = createPlan();
    const previewId = previewIdOf(await run(target, 'pto_create', plan));
    const unknown = await run(target, 'pto_create', { ...plan, mode: 'apply', previewId });
    expect(errorOf(unknown)).toMatchObject({ code: 'UNKNOWN_OUTCOME', recovery: 'reconcile' });
    expect(errorOf(unknown).message).toMatch(/reconcil/i);
    expect(target.client.calls.create).toHaveLength(1);
    expectValid('pto_create', unknown);

    target.client.handlers = {
      create: async () => ({ ...CREATED, replayed: true }),
    };
    const replay = await run(target, 'pto_create', { ...plan, mode: 'apply', previewId });
    expect(dataOf(replay)['replayed']).toBe(true);
    expect(target.client.calls.create).toHaveLength(2);
    expect(target.client.calls.create[0]?.key).toBe(plan.idempotencyKey);
    expect(target.client.calls.create[1]?.key).toBe(plan.idempotencyKey);
    expect(target.client.calls.create[1]?.payload).toEqual(target.client.calls.create[0]?.payload);
  });

  it('retains the observed create key and refuses every changed replay binding', async () => {
    const target = harness();
    const plan = createPlan();
    target.client.handlers = {
      create: async () => {
        throw new PtoApiError('NETWORK_ERROR', { unknownWriteOutcome: true });
      },
    };
    const firstPreview = previewIdOf(await run(target, 'pto_create', plan));
    expect(
      errorOf(await run(target, 'pto_create', { ...plan, mode: 'apply', previewId: firstPreview }))
        .code,
    ).toBe('UNKNOWN_OUTCOME');
    expect(target.client.calls.create).toHaveLength(1);

    const changedPayload = await run(
      target,
      'pto_create',
      createPlan({ note: 'caller synthetic note' }),
    );
    expect(errorOf(changedPayload)).toMatchObject({ code: 'CONFLICT', recovery: 'reconcile' });
    expect(errorOf(changedPayload).message).toMatch(/already observed/i);
    expect(target.client.calls.create).toHaveLength(1);

    target.auth.bundle = { ...BUNDLE, credential: { origin: ORIGIN, token: TOKEN_TWO } };
    const changedCredential = await run(target, 'pto_create', plan);
    expect(errorOf(changedCredential)).toMatchObject({
      code: 'CONFLICT',
      recovery: 'reconcile',
    });
    expect(errorOf(changedCredential).message).not.toMatch(
      /prepare a new preview with the current credential/i,
    );
    expect(target.client.calls.create).toHaveLength(1);

    target.auth.bundle = BUNDLE;
    target.client.identityValue = identity({ id: COLLEAGUE });
    const changedActor = await run(target, 'pto_create', plan);
    expect(errorOf(changedActor)).toMatchObject({ code: 'CONFLICT', recovery: 'reconcile' });
    expect(target.client.calls.create).toHaveLength(1);

    target.client.identityValue = identity();
    target.auth.bundle = {
      ...BUNDLE,
      baseUrl: ORIGIN_TWO,
      credential: { origin: ORIGIN_TWO, token: TOKEN },
    };
    const changedOrigin = await run(target, 'pto_create', plan);
    expect(errorOf(changedOrigin)).toMatchObject({ code: 'CONFLICT', recovery: 'reconcile' });
    expect(target.client.calls.create).toHaveLength(1);

    target.auth.bundle = BUNDLE;
    const exactPreview = previewIdOf(await run(target, 'pto_create', plan));
    target.client.handlers = {
      create: async () => ({ ...CREATED, replayed: true }),
    };
    const replay = await run(target, 'pto_create', {
      ...plan,
      mode: 'apply',
      previewId: exactPreview,
    });
    expect(dataOf(replay)['replayed']).toBe(true);
    expect(target.client.calls.create).toHaveLength(2);
    expect(target.client.calls.create[1]?.key).toBe(plan.idempotencyKey);
    expect(target.client.calls.create[1]?.payload).toEqual(target.client.calls.create[0]?.payload);
  });

  it('bounds the observed create-key registry and fails closed without evicting', async () => {
    const target = harness({ createKeys: new CreateKeyRegistry(1) });
    const first = createPlan();
    const firstPreview = previewIdOf(await run(target, 'pto_create', first));
    const second = createPlan({ idempotencyKey: KEY_TWO });
    const full = await run(target, 'pto_create', second);
    expect(errorOf(full)).toMatchObject({ code: 'CONFLICT', recovery: 'reconcile' });
    expect(errorOf(full).message).toMatch(/registry is full/i);
    expect(target.client.calls.create).toHaveLength(0);

    // The first observation is retained, not evicted, and still replays exactly.
    const again = previewIdOf(await run(target, 'pto_create', first));
    const applied = await run(target, 'pto_create', {
      ...first,
      mode: 'apply',
      previewId: again,
    });
    expect(dataOf(applied)['operation']).toBe('create');
    expect(target.client.calls.create).toHaveLength(1);
    expect(target.client.calls.create[0]?.key).toBe(first.idempotencyKey);
    expect(firstPreview).not.toBe(again);
  });

  it('fails closed at dispatch when the key proof is missing or conflicts', async () => {
    const missing = harness();
    const args = createPlan();
    const missingPreview = manualCreateBinding(missing, args, {}, false);
    const missingResult = await run(missing, 'pto_create', {
      ...args,
      mode: 'apply',
      previewId: missingPreview,
    });
    expect(errorOf(missingResult)).toMatchObject({ code: 'CONFLICT', recovery: 'reconcile' });
    expect(errorOf(missingResult).message).toMatch(/No retained process-local binding/i);
    expect(missing.client.calls.create).toHaveLength(0);

    const conflict = harness();
    const conflictArgs = createPlan();
    conflict.createKeys.observe(createKeyFingerprint(conflictArgs.idempotencyKey), {
      origin: ORIGIN,
      actorId: ACTOR,
      tokenId: TOKEN_ID,
      credential: credentialFingerprint(TOKEN),
      intent: 'a-different-intent',
    });
    const conflictPreview = manualCreateBinding(conflict, conflictArgs, {}, false);
    const conflictResult = await run(conflict, 'pto_create', {
      ...conflictArgs,
      mode: 'apply',
      previewId: conflictPreview,
    });
    expect(errorOf(conflictResult)).toMatchObject({ code: 'CONFLICT', recovery: 'reconcile' });
    expect(errorOf(conflictResult).message).toMatch(/already observed/i);
    expect(conflict.client.calls.create).toHaveLength(0);
  });

  it('allows an exact successful preview to replay the same intent only', async () => {
    const target = harness();
    const plan = createPlan();
    const previewId = previewIdOf(await run(target, 'pto_create', plan));
    await run(target, 'pto_create', { ...plan, mode: 'apply', previewId });
    const replay = await run(target, 'pto_create', { ...plan, mode: 'apply', previewId });
    expect(dataOf(replay)['replayed']).toBe(false);
    expect(target.client.calls.create).toHaveLength(2);
  });

  it('allows only one concurrent dispatch from one preview', async () => {
    const target = harness();
    let started: () => void = () => undefined;
    const atCreate = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    target.client.handlers = {
      create: async () => {
        started();
        await gate;
        return CREATED;
      },
    };
    const plan = createPlan();
    const previewId = previewIdOf(await run(target, 'pto_create', plan));
    const first = run(target, 'pto_create', { ...plan, mode: 'apply', previewId });
    await atCreate;
    const second = await run(target, 'pto_create', { ...plan, mode: 'apply', previewId });
    expect(errorOf(second).code).toBe('BUSY');
    finish();
    expect(dataOf(await first)['operation']).toBe('create');
    expect(target.client.calls.create).toHaveLength(1);
  });

  it('allows only one concurrent dispatch for the same create key', async () => {
    const target = harness();
    let started: () => void = () => undefined;
    const atCreate = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    target.client.handlers = {
      create: async () => {
        started();
        await gate;
        return CREATED;
      },
    };
    const plan = createPlan();
    const firstPreview = previewIdOf(await run(target, 'pto_create', plan));
    const secondPreview = previewIdOf(await run(target, 'pto_create', plan));
    const first = run(target, 'pto_create', { ...plan, mode: 'apply', previewId: firstPreview });
    await atCreate;
    const second = await run(target, 'pto_create', {
      ...plan,
      mode: 'apply',
      previewId: secondPreview,
    });
    expect(errorOf(second).code).toBe('BUSY');
    finish();
    await first;
    expect(target.client.calls.create).toHaveLength(1);
  });

  it('reports a definite key conflict and an expired key with reconciliation guidance', async () => {
    const cases: Array<[string, string]> = [
      ['IDEMPOTENCY_CONFLICT', 'CONFLICT'],
      ['IDEMPOTENCY_EXPIRED', 'CONFLICT'],
    ];
    for (const [code, expected] of cases) {
      const target = harness();
      target.client.handlers = {
        create: async () => Promise.reject(new PtoApiError(code, { status: 409 })),
      };
      const plan = createPlan();
      const previewId = previewIdOf(await run(target, 'pto_create', plan));
      const result = await run(target, 'pto_create', { ...plan, mode: 'apply', previewId });
      expect(errorOf(result)).toMatchObject({ code: expected, recovery: 'reconcile' });
      expect(errorOf(result).message).toMatch(/reconcil/i);
      expect(target.client.calls.create).toHaveLength(1);
    }
  });

  it('reports a rate limit with the server wait hint and one dispatch', async () => {
    const target = harness();
    target.client.handlers = {
      create: async () =>
        Promise.reject(
          new PtoApiError('RATE_LIMITED', {
            status: 429,
            retryAfterMs: 7_000,
            requestId: 'safe-request-1',
          }),
        ),
    };
    const plan = createPlan();
    const previewId = previewIdOf(await run(target, 'pto_create', plan));
    const result = await run(target, 'pto_create', { ...plan, mode: 'apply', previewId });
    expect(errorOf(result)).toMatchObject({
      code: 'QUOTA',
      recovery: 'wait-retry-after',
      status: 429,
      retryAfterMs: 7_000,
      upstreamRequestId: null,
    });
    expect(target.client.calls.create).toHaveLength(1);
    expectValid('pto_create', result);
  });

  it('never exposes an upstream correlation or a note/key/token-like sentinel and bounds the wait hint', async () => {
    const sentinels = [
      'safe-request-1',
      'bad id!',
      `req-${SECRET}`,
      TOKEN,
      KEY,
      'hidden synthetic note',
      'caller synthetic note',
    ];
    for (const requestId of sentinels) {
      for (const retryAfterMs of [-1, 3]) {
        const target = harness();
        target.client.handlers = {
          create: async () =>
            Promise.reject(
              new PtoApiError('RATE_LIMITED', { status: 429, requestId, retryAfterMs }),
            ),
        };
        const plan = createPlan();
        const previewId = previewIdOf(await run(target, 'pto_create', plan));
        const result = await run(target, 'pto_create', { ...plan, mode: 'apply', previewId });
        expect(errorOf(result).upstreamRequestId).toBeNull();
        expect(errorOf(result).retryAfterMs).toBe(retryAfterMs < 0 ? null : retryAfterMs);
        expect(errorOf(result).status).toBe(429);
        const text = jsonOf(result);
        expect(text).not.toContain(requestId);
        for (const sentinel of sentinels) expect(text).not.toContain(sentinel);
      }
    }
  });

  it('classifies a stale answer, an overlap, a denial and an unknown code', async () => {
    const cases: Array<[string, string]> = [
      ['STALE_WRITE', 'CONFLICT'],
      ['CONFLICT', 'CONFLICT'],
      ['FORBIDDEN', 'PERMISSION'],
      ['SOMETHING_NEW', 'NETWORK'],
    ];
    for (const [code, expected] of cases) {
      const target = harness();
      target.client.handlers = {
        create: async () => Promise.reject(new PtoApiError(code, { status: 409 })),
      };
      const plan = createPlan();
      const previewId = previewIdOf(await run(target, 'pto_create', plan));
      const result = await run(target, 'pto_create', { ...plan, mode: 'apply', previewId });
      expect(errorOf(result).code).toBe(expected);
      expect(target.client.calls.create).toHaveLength(1);
    }
  });

  it('never reports an ambiguous dispatch as cancelled', async () => {
    const aborted = harness();
    const control = new AbortController();
    aborted.client.handlers = {
      create: async () => {
        control.abort();
        throw new PtoApiError('ABORTED', { unknownWriteOutcome: true });
      },
    };
    const plan = createPlan();
    const previewId = previewIdOf(await run(aborted, 'pto_create', plan));
    const result = await run(
      aborted,
      'pto_create',
      { ...plan, mode: 'apply', previewId },
      {
        signal: control.signal,
      },
    );
    expect(errorOf(result).code).toBe('UNKNOWN_OUTCOME');

    const broken = harness();
    broken.client.handlers = {
      create: async () => Promise.reject(new Error('unexpected after dispatch')),
    };
    const brokenPreview = previewIdOf(await run(broken, 'pto_create', plan));
    expect(
      errorOf(
        await run(broken, 'pto_create', {
          ...plan,
          mode: 'apply',
          previewId: brokenPreview,
        }),
      ).code,
    ).toBe('UNKNOWN_OUTCOME');
  });

  it('stops before dispatch when the whole-call budget is exhausted', async () => {
    const target = harness();
    target.client.handlers = {
      identity: async () => {
        target.clock.now += 20_000;
        return identity();
      },
    };
    const plan = createPlan();
    const result = await run(target, 'pto_create', {
      ...plan,
      mode: 'apply',
      previewId: PREVIEW_ID,
    });
    // No preview was claimed, so this is the ordinary unknown-preview refusal.
    expect(errorOf(result).code).toBe('PREVIEW');
    void result;

    const prepared = harness();
    const previewId = previewIdOf(await run(prepared, 'pto_create', plan));
    prepared.client.handlers = {
      identity: async () => {
        prepared.clock.now += 20_000;
        return identity();
      },
    };
    const timed = await run(prepared, 'pto_create', { ...plan, mode: 'apply', previewId });
    expect(errorOf(timed).code).toBe('NETWORK');
    expect(errorOf(timed).message).toContain('time budget');
    expect(prepared.client.calls.create).toHaveLength(0);
  });

  it('stops an apply before dispatch when the call is cancelled', async () => {
    const target = harness();
    const control = new AbortController();
    const plan = createPlan();
    const previewId = previewIdOf(await run(target, 'pto_create', plan));
    target.client.identityValue = identity();
    target.client.handlers = {
      identity: async () => {
        control.abort();
        return identity();
      },
    };
    const result = await run(
      target,
      'pto_create',
      { ...plan, mode: 'apply', previewId },
      { signal: control.signal },
    );
    expect(errorOf(result).code).toBe('CANCELLED');
    expect(target.client.calls.create).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------- */
/* Update preview and apply.                                                 */
/* ------------------------------------------------------------------------- */

describe('the update preview', () => {
  it('shows the exact target, version, before, after and diff without a note', async () => {
    const target = harness();
    const result = await run(target, 'pto_update', {
      ...UPDATE,
      changes: { startDate: '2026-12-08', endDate: OTHER_DAY },
    });
    const data = dataOf(result);
    expect(data).toMatchObject({
      phase: 'preview',
      operation: 'update',
      actorId: ACTOR,
      ownerId: ACTOR,
      target: { id: RECORD_ID, version: 3 },
      before: { startDate: DAY, endDate: DAY, dayPart: 'all_day' },
      after: { startDate: '2026-12-08', endDate: OTHER_DAY, dayPart: 'all_day' },
      changedFields: ['startDate', 'endDate'],
      noteIntent: 'keep',
    });
    expect(target.client.calls.identity).toHaveLength(1);
    expect(target.client.calls.detail).toHaveLength(1);
    expect(target.client.calls.patch).toHaveLength(0);
    expectValid('pto_update', result);
    expect(jsonOf(result)).not.toContain('hidden synthetic note');
  });

  it('shows set and clear note intentions without the text', async () => {
    const target = harness();
    const clearNull = await run(target, 'pto_update', { ...UPDATE, changes: { note: null } });
    expect(dataOf(clearNull)['noteIntent']).toBe('clear');
    const clearEmpty = await run(target, 'pto_update', { ...UPDATE, changes: { note: '' } });
    expect(dataOf(clearEmpty)['noteIntent']).toBe('clear');
    const set = await run(target, 'pto_update', {
      ...UPDATE,
      changes: { note: 'caller synthetic note' },
    });
    expect(dataOf(set)['noteIntent']).toBe('set');
    expect(jsonOf(set)).not.toContain('caller synthetic note');
  });

  it('keeps a single-day stored half-day and normalises a longer range', async () => {
    const target = harness();
    target.client.detailValue = { ...DETAIL, dayPart: 'morning' };
    const single = await run(target, 'pto_update', {
      ...UPDATE,
      changes: { startDate: OTHER_DAY, endDate: OTHER_DAY },
    });
    expect(dataOf(single)['after']).toEqual({
      startDate: OTHER_DAY,
      endDate: OTHER_DAY,
      dayPart: 'morning',
    });

    const longer = await run(target, 'pto_update', {
      ...UPDATE,
      changes: { endDate: OTHER_DAY, dayPart: 'evening' },
    });
    expect(dataOf(longer)['after']).toEqual({
      startDate: DAY,
      endDate: OTHER_DAY,
      dayPart: 'all_day',
    });

    const refusal = await run(target, 'pto_update', {
      ...UPDATE,
      changes: { endDate: OTHER_DAY },
    });
    expect(errorOf(refusal).code).toBe('INPUT');
    expect(errorOf(refusal).message).toMatch(/dayPart/);
  });

  it('refuses an update that changes no effective field', async () => {
    const target = harness();
    const sameDate = await run(target, 'pto_update', {
      ...UPDATE,
      changes: { startDate: DAY },
    });
    expect(errorOf(sameDate).code).toBe('INPUT');
    const sameDayPart = await run(target, 'pto_update', {
      ...UPDATE,
      changes: { dayPart: 'all_day' },
    });
    expect(errorOf(sameDayPart).code).toBe('INPUT');
    expect(target.client.calls.patch).toHaveLength(0);
  });

  it('refuses a stale version before issuing a preview', async () => {
    const target = harness();
    const result = await run(target, 'pto_update', { ...UPDATE, expectedVersion: 2 });
    expect(errorOf(result)).toMatchObject({ code: 'CONFLICT', recovery: 'refresh-version' });
    expect(target.client.calls.patch).toHaveLength(0);
  });

  it('validates both merged range inversions before a preview and before a PATCH', async () => {
    const target = harness();
    const startInversion = await run(target, 'pto_update', {
      ...UPDATE,
      changes: { startDate: OTHER_DAY },
    });
    expect(errorOf(startInversion).code).toBe('INPUT');
    expect(errorOf(startInversion).message).toMatch(/end date must not be before the start date/i);

    const endInversion = await run(target, 'pto_update', {
      ...UPDATE,
      changes: { endDate: '2026-12-03' },
    });
    expect(errorOf(endInversion).code).toBe('INPUT');
    expect(errorOf(endInversion).message).toMatch(/end date must not be before the start date/i);
    expect(target.client.calls.patch).toHaveLength(0);

    // The same validation runs on the apply path after the live detail is read.
    const manual = harness();
    const applyArgs: UpdateArguments = { ...UPDATE, changes: { startDate: OTHER_DAY } };
    const previewId = manualUpdateBinding(manual, applyArgs, {
      before: { startDate: DAY, endDate: DAY, dayPart: 'all_day' },
      after: { startDate: OTHER_DAY, endDate: DAY, dayPart: 'all_day' },
      changedFields: ['startDate'],
    });
    const applied = await run(manual, 'pto_update', {
      ...applyArgs,
      mode: 'apply',
      previewId,
    });
    expect(errorOf(applied).code).toBe('INPUT');
    expect(manual.client.calls.patch).toHaveLength(0);
  });

  it('applies the live ownership and scope rules before a preview', async () => {
    const teammate = { ...DETAIL, user: { ...DETAIL.user, id: COLLEAGUE } };
    const other = harness();
    other.client.detailValue = teammate;
    expect(errorOf(await run(other, 'pto_update', UPDATE)).code).toBe('PERMISSION');

    const noSelf = harness();
    noSelf.client.identityValue = identity({ scopes: ['pto:read'] });
    expect(errorOf(await run(noSelf, 'pto_update', UPDATE)).code).toBe('PERMISSION');

    const lead = harness();
    lead.client.detailValue = teammate;
    lead.client.identityValue = identity({
      role: 'team_lead',
      scopes: ['pto:read', 'pto:update:team'],
    });
    expect((await run(lead, 'pto_update', UPDATE)).ok).toBe(true);

    const leadWithoutTeam = harness();
    leadWithoutTeam.client.detailValue = teammate;
    leadWithoutTeam.client.identityValue = identity({ role: 'team_lead', scopes: ['pto:read'] });
    expect(errorOf(await run(leadWithoutTeam, 'pto_update', UPDATE)).code).toBe('PERMISSION');

    const admin = harness();
    admin.client.detailValue = teammate;
    admin.client.identityValue = identity({
      role: 'admin',
      scopes: ['pto:read', 'pto:update:self', 'pto:update:team'],
    });
    expect((await run(admin, 'pto_update', UPDATE)).ok).toBe(true);
  });

  it('reports a missing target and a read scope failure', async () => {
    const target = harness();
    target.client.handlers = {
      detail: async () => Promise.reject(new PtoApiError('NOT_FOUND', { status: 404 })),
    };
    expect(errorOf(await run(target, 'pto_update', UPDATE)).code).toBe('NOT_FOUND');

    const noRead = harness();
    noRead.client.identityValue = identity({ scopes: ['pto:create'] });
    expect(errorOf(await run(noRead, 'pto_update', UPDATE)).code).toBe('PERMISSION');
  });

  it('refuses a new preview when the store is full', async () => {
    const previews = new PreviewStore({ now: () => NOW, limit: 1 });
    const target = harness({ previews });
    expect(previews.issue(manualBindingOf())).not.toBeNull();
    expect(errorOf(await run(target, 'pto_update', UPDATE)).code).toBe('BUSY');
  });
});

describe('the update apply', () => {
  it('sends one conditional PATCH with only the named fields and an omitted note', async () => {
    const target = harness();
    const intent = { ...UPDATE, changes: { dayPart: 'morning' as PtoDayPart } };
    const previewId = previewIdOf(await run(target, 'pto_update', intent));
    const result = await run(target, 'pto_update', { ...intent, mode: 'apply', previewId });
    expect(target.client.calls.patch).toHaveLength(1);
    expect(target.client.calls.patch[0]).toMatchObject({
      id: RECORD_ID,
      version: 3,
      changes: { dayPart: 'morning' },
    });
    expect(Object.hasOwn(target.client.calls.patch[0]?.changes ?? {}, 'note')).toBe(false);
    expect(Object.hasOwn(target.client.calls.patch[0]?.changes ?? {}, 'startDate')).toBe(false);
    expect(Object.hasOwn(target.client.calls.patch[0]?.changes ?? {}, 'endDate')).toBe(false);
    expect(dataOf(result)).toMatchObject({
      phase: 'apply',
      operation: 'update',
      noteIntent: 'keep',
      record: { id: RECORD_ID, version: 4 },
    });
    expect(target.client.calls.identity).toHaveLength(2);
    expect(target.client.calls.detail).toHaveLength(2);
    expectValid('pto_update', result);
    expect(jsonOf(result)).not.toContain('hidden synthetic note');
  });

  it('sends an explicit clear as null and a set as the exactly requested text', async () => {
    for (const note of ['', null]) {
      const target = harness();
      const intent = { ...UPDATE, changes: { note } };
      const previewId = previewIdOf(await run(target, 'pto_update', intent));
      await run(target, 'pto_update', { ...intent, mode: 'apply', previewId });
      expect(target.client.calls.patch[0]?.changes).toEqual({ note: null });
    }
    const target = harness();
    const intent = {
      ...UPDATE,
      changes: { startDate: OTHER_DAY, endDate: OTHER_DAY, note: 'caller synthetic note' },
    };
    const previewId = previewIdOf(await run(target, 'pto_update', intent));
    const result = await run(target, 'pto_update', { ...intent, mode: 'apply', previewId });
    expect(target.client.calls.patch[0]?.changes).toEqual({
      startDate: OTHER_DAY,
      endDate: OTHER_DAY,
      note: 'caller synthetic note',
    });
    expect(dataOf(result)['noteIntent']).toBe('set');
    expect(jsonOf(result)).not.toContain('caller synthetic note');
  });

  it('sends only actual effective fields and preserves an explicit note', async () => {
    const target = harness();
    const intent = {
      ...UPDATE,
      changes: {
        startDate: OTHER_DAY,
        endDate: OTHER_DAY,
        dayPart: 'all_day' as PtoDayPart,
        note: '',
      },
    };
    const previewId = previewIdOf(await run(target, 'pto_update', intent));
    await run(target, 'pto_update', { ...intent, mode: 'apply', previewId });
    expect(target.client.calls.patch[0]?.changes).toEqual({
      startDate: OTHER_DAY,
      endDate: OTHER_DAY,
      note: null,
    });
    expect(Object.hasOwn(target.client.calls.patch[0]?.changes ?? {}, 'dayPart')).toBe(false);
  });

  it('sends the effective day part and drops a repeated unchanged date', async () => {
    const target = harness();
    target.client.detailValue = { ...DETAIL, dayPart: 'morning' };
    const intent = {
      ...UPDATE,
      changes: {
        startDate: DAY,
        endDate: OTHER_DAY,
        dayPart: 'evening' as PtoDayPart,
      },
    };
    const previewId = previewIdOf(await run(target, 'pto_update', intent));
    await run(target, 'pto_update', { ...intent, mode: 'apply', previewId });
    expect(target.client.calls.patch[0]?.changes).toEqual({
      endDate: OTHER_DAY,
      dayPart: 'all_day',
    });
  });

  it('refuses changed arguments and a consumed update preview', async () => {
    const target = harness();
    const intent = { ...UPDATE, changes: { dayPart: 'morning' as PtoDayPart } };
    const previewId = previewIdOf(await run(target, 'pto_update', intent));
    const mismatch = await run(target, 'pto_update', {
      ...intent,
      changes: { dayPart: 'evening' },
      mode: 'apply',
      previewId,
    });
    expect(errorOf(mismatch).code).toBe('PREVIEW');
    expect(target.client.calls.patch).toHaveLength(0);
    const freshPreview = previewIdOf(await run(target, 'pto_update', intent));
    await run(target, 'pto_update', { ...intent, mode: 'apply', previewId: freshPreview });
    const reused = await run(target, 'pto_update', {
      ...intent,
      mode: 'apply',
      previewId: freshPreview,
    });
    expect(errorOf(reused).code).toBe('PREVIEW');
    expect(target.client.calls.patch).toHaveLength(1);
  });

  it('refuses a target that changed after the preview without substituting a version', async () => {
    const target = harness();
    const intent = { ...UPDATE, changes: { dayPart: 'morning' as PtoDayPart } };
    const previewId = previewIdOf(await run(target, 'pto_update', intent));
    target.client.detailValue = { ...DETAIL, version: 4 };
    const result = await run(target, 'pto_update', { ...intent, mode: 'apply', previewId });
    expect(errorOf(result)).toMatchObject({ code: 'CONFLICT', recovery: 'refresh-version' });
    expect(target.client.calls.patch).toHaveLength(0);
  });

  it('refuses a field change, a same-version date change and a manual partial binding', async () => {
    const field = harness();
    const fieldIntent = { ...UPDATE, changes: { dayPart: 'morning' as PtoDayPart } };
    const fieldPreview = previewIdOf(await run(field, 'pto_update', fieldIntent));
    field.client.detailValue = {
      ...DETAIL,
      startDate: OTHER_DAY,
      endDate: OTHER_DAY,
      dayPart: 'all_day',
    };
    expect(
      errorOf(
        await run(field, 'pto_update', { ...fieldIntent, mode: 'apply', previewId: fieldPreview }),
      ).code,
    ).toBe('CONFLICT');

    const dayPart = harness();
    const dayPartIntent = { ...UPDATE, changes: { dayPart: 'morning' as PtoDayPart } };
    const dayPartPreview = previewIdOf(await run(dayPart, 'pto_update', dayPartIntent));
    dayPart.client.detailValue = { ...DETAIL, dayPart: 'evening' };
    expect(
      errorOf(
        await run(dayPart, 'pto_update', {
          ...dayPartIntent,
          mode: 'apply',
          previewId: dayPartPreview,
        }),
      ).code,
    ).toBe('CONFLICT');

    const manual = harness();
    const digest = payloadDigest({
      operation: 'update',
      id: RECORD_ID,
      expectedVersion: 3,
      changes: { dayPart: 'morning' },
    });
    const issued = manual.previews.issue({
      ...manualBindingOf(),
      operation: 'update',
      digest,
      target: null,
      before: null,
      after: { startDate: DAY, endDate: DAY, dayPart: 'morning' },
      changedFields: ['dayPart'],
      noteIntent: 'keep',
    });
    const result = await run(manual, 'pto_update', {
      ...UPDATE,
      mode: 'apply',
      previewId: issued?.id ?? '',
    });
    expect(errorOf(result).code).toBe('CONFLICT');
    expect(manual.client.calls.patch).toHaveLength(0);
  });

  it('refuses a manual binding whose plan or note intention does not match the live entry', async () => {
    const storedHalfDay = harness();
    storedHalfDay.client.detailValue = { ...DETAIL, dayPart: 'morning' };
    const refusalArgs: UpdateArguments = {
      ...UPDATE,
      changes: { endDate: OTHER_DAY },
    };
    const refusalId = manualUpdateBinding(storedHalfDay, refusalArgs, {
      before: { startDate: DAY, endDate: DAY, dayPart: 'morning' },
      after: { startDate: DAY, endDate: OTHER_DAY, dayPart: 'all_day' },
      changedFields: ['endDate'],
    });
    expect(
      errorOf(
        await run(storedHalfDay, 'pto_update', {
          ...refusalArgs,
          mode: 'apply',
          previewId: refusalId,
        }),
      ).code,
    ).toBe('INPUT');
    expect(storedHalfDay.client.calls.patch).toHaveLength(0);

    const wrongNote = harness();
    const noteArgs: UpdateArguments = { ...UPDATE, changes: { dayPart: 'morning' } };
    const noteId = manualUpdateBinding(wrongNote, noteArgs, {
      after: { startDate: DAY, endDate: DAY, dayPart: 'morning' },
      changedFields: ['dayPart'],
      noteIntent: 'set',
    });
    expect(
      errorOf(
        await run(wrongNote, 'pto_update', {
          ...noteArgs,
          mode: 'apply',
          previewId: noteId,
        }),
      ).code,
    ).toBe('PREVIEW');
    expect(wrongNote.client.calls.patch).toHaveLength(0);

    const wrongRange = harness();
    const rangeArgs: UpdateArguments = { ...UPDATE, changes: { dayPart: 'morning' } };
    const rangeId = manualUpdateBinding(wrongRange, rangeArgs, {
      after: { startDate: DAY, endDate: OTHER_DAY, dayPart: 'all_day' },
      changedFields: ['dayPart'],
    });
    expect(
      errorOf(
        await run(wrongRange, 'pto_update', {
          ...rangeArgs,
          mode: 'apply',
          previewId: rangeId,
        }),
      ).code,
    ).toBe('PREVIEW');
    expect(wrongRange.client.calls.patch).toHaveLength(0);
  });

  it('refuses a target whose owner changed under the same version', async () => {
    const target = harness();
    target.client.identityValue = identity({
      role: 'team_lead',
      scopes: ['pto:read', 'pto:update:team'],
    });
    const intent = { ...UPDATE, changes: { dayPart: 'morning' as PtoDayPart } };
    const previewId = previewIdOf(await run(target, 'pto_update', intent));
    target.client.detailValue = { ...DETAIL, user: { ...DETAIL.user, id: COLLEAGUE } };
    const result = await run(target, 'pto_update', { ...intent, mode: 'apply', previewId });
    expect(errorOf(result).code).toBe('CONFLICT');
    expect(target.client.calls.patch).toHaveLength(0);
  });

  it('re-checks the live role and scope at apply', async () => {
    const target = harness();
    target.client.detailValue = { ...DETAIL, user: { ...DETAIL.user, id: COLLEAGUE } };
    target.client.identityValue = identity({
      role: 'team_lead',
      scopes: ['pto:read', 'pto:update:team'],
    });
    const intent = { ...UPDATE, changes: { dayPart: 'morning' as PtoDayPart } };
    const previewId = previewIdOf(await run(target, 'pto_update', intent));
    target.client.identityValue = identity({ role: 'member', scopes: ['pto:read'] });
    const result = await run(target, 'pto_update', { ...intent, mode: 'apply', previewId });
    expect(errorOf(result).code).toBe('PERMISSION');
    expect(target.client.calls.patch).toHaveLength(0);
  });

  it('refuses an apply when the live role changed even though it retains authority', async () => {
    const target = harness();
    target.client.identityValue = identity({ role: 'member', scopes: [...SCOPES] });
    const intent = { ...UPDATE, changes: { dayPart: 'morning' as PtoDayPart } };
    const previewId = previewIdOf(await run(target, 'pto_update', intent));
    target.client.identityValue = identity({ role: 'admin', scopes: [...SCOPES] });
    const result = await run(target, 'pto_update', { ...intent, mode: 'apply', previewId });
    expect(errorOf(result)).toMatchObject({ code: 'PERMISSION', recovery: 'reconcile' });
    expect(errorOf(result).message).toMatch(/live role/i);
    expect(target.client.calls.patch).toHaveLength(0);

    const create = harness();
    const plan = createPlan();
    const createPreview = previewIdOf(await run(create, 'pto_create', plan));
    create.client.identityValue = identity({ role: 'admin', scopes: [...SCOPES] });
    expect(
      errorOf(await run(create, 'pto_create', { ...plan, mode: 'apply', previewId: createPreview }))
        .code,
    ).toBe('PERMISSION');
    expect(create.client.calls.create).toHaveLength(0);
  });

  it('re-checks the live scope at apply without a role change', async () => {
    const update = harness();
    update.client.identityValue = identity({
      role: 'team_lead',
      scopes: ['pto:read', 'pto:update:team'],
    });
    const updateIntent = { ...UPDATE, changes: { dayPart: 'morning' as PtoDayPart } };
    const updatePreview = previewIdOf(await run(update, 'pto_update', updateIntent));
    update.client.identityValue = identity({ role: 'team_lead', scopes: ['pto:read'] });
    expect(
      errorOf(
        await run(update, 'pto_update', {
          ...updateIntent,
          mode: 'apply',
          previewId: updatePreview,
        }),
      ).code,
    ).toBe('PERMISSION');
    expect(update.client.calls.patch).toHaveLength(0);

    const remove = harness();
    remove.client.identityValue = identity({
      role: 'team_lead',
      scopes: ['pto:read', 'pto:delete:team'],
    });
    const deletePreview = previewIdOf(await run(remove, 'pto_delete', DELETE));
    remove.client.identityValue = identity({ role: 'team_lead', scopes: ['pto:read'] });
    expect(
      errorOf(
        await run(remove, 'pto_delete', { ...DELETE, mode: 'apply', previewId: deletePreview }),
      ).code,
    ).toBe('PERMISSION');
    expect(remove.client.calls.delete).toHaveLength(0);
  });

  it('reports a lost update answer as unknown and never retries', async () => {
    const target = harness();
    target.client.handlers = {
      patch: async () => {
        throw new PtoApiError('NETWORK_ERROR', { unknownWriteOutcome: true });
      },
    };
    const intent = { ...UPDATE, changes: { dayPart: 'morning' as PtoDayPart } };
    const previewId = previewIdOf(await run(target, 'pto_update', intent));
    const result = await run(target, 'pto_update', { ...intent, mode: 'apply', previewId });
    expect(errorOf(result)).toMatchObject({ code: 'UNKNOWN_OUTCOME', recovery: 'reconcile' });
    expect(errorOf(result).message).toMatch(/reconcil/i);
    expect(target.client.calls.patch).toHaveLength(1);
  });

  it('classifies an exact stale answer and one overlapping conflict', async () => {
    const cases: Array<[string, string]> = [
      ['STALE_WRITE', 'CONFLICT'],
      ['CONFLICT', 'CONFLICT'],
    ];
    for (const [code, expected] of cases) {
      const target = harness();
      target.client.handlers = {
        patch: async () => Promise.reject(new PtoApiError(code, { status: 412 })),
      };
      const intent = { ...UPDATE, changes: { dayPart: 'morning' as PtoDayPart } };
      const previewId = previewIdOf(await run(target, 'pto_update', intent));
      const result = await run(target, 'pto_update', { ...intent, mode: 'apply', previewId });
      expect(errorOf(result).code).toBe(expected);
      expect(target.client.calls.patch).toHaveLength(1);
    }
  });

  it('allows only one concurrent PATCH for one entry and version', async () => {
    const target = harness();
    let started: () => void = () => undefined;
    const atPatch = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    target.client.handlers = {
      patch: async () => {
        started();
        await gate;
        return RECORD;
      },
    };
    const intent = { ...UPDATE, changes: { dayPart: 'morning' as PtoDayPart } };
    const firstPreview = previewIdOf(await run(target, 'pto_update', intent));
    const secondPreview = previewIdOf(await run(target, 'pto_update', intent));
    const first = run(target, 'pto_update', { ...intent, mode: 'apply', previewId: firstPreview });
    await atPatch;
    const second = await run(target, 'pto_update', {
      ...intent,
      mode: 'apply',
      previewId: secondPreview,
    });
    expect(errorOf(second).code).toBe('BUSY');
    finish();
    await first;
    expect(target.client.calls.patch).toHaveLength(1);
  });

  it('stops a cancelled apply before PATCH and an unexpected preflight read', async () => {
    const target = harness();
    const control = new AbortController();
    const intent = { ...UPDATE, changes: { dayPart: 'morning' as PtoDayPart } };
    const previewId = previewIdOf(await run(target, 'pto_update', intent));
    target.client.handlers = {
      detail: async () => {
        control.abort();
        throw new PtoApiError('ABORTED');
      },
    };
    expect(
      errorOf(
        await run(
          target,
          'pto_update',
          { ...intent, mode: 'apply', previewId },
          {
            signal: control.signal,
          },
        ),
      ).code,
    ).toBe('CANCELLED');
    expect(target.client.calls.patch).toHaveLength(0);

    const broken = harness();
    const brokenIntent = { ...UPDATE, changes: { dayPart: 'morning' as PtoDayPart } };
    const brokenPreview = previewIdOf(await run(broken, 'pto_update', brokenIntent));
    broken.client.handlers = {
      detail: async () => Promise.reject(new Error('unexpected')),
    };
    expect(
      errorOf(
        await run(broken, 'pto_update', {
          ...brokenIntent,
          mode: 'apply',
          previewId: brokenPreview,
        }),
      ).code,
    ).toBe('LOCAL');
  });
});

/* ------------------------------------------------------------------------- */
/* Delete.                                                                   */
/* ------------------------------------------------------------------------- */

describe('the delete preview and apply', () => {
  it('previews the exact target and version with no proposed record', async () => {
    const target = harness();
    const result = await run(target, 'pto_delete', DELETE);
    expect(dataOf(result)).toMatchObject({
      phase: 'preview',
      operation: 'delete',
      actorId: ACTOR,
      ownerId: ACTOR,
      target: { id: RECORD_ID, version: 3 },
      before: { startDate: DAY, endDate: DAY, dayPart: 'all_day' },
      after: null,
      changedFields: [],
      noteIntent: 'none',
    });
    expect(target.client.calls.delete).toHaveLength(0);
    expectValid('pto_delete', result);
  });

  it('refuses a stale preview, a teammate and a missing read scope', async () => {
    const stale = harness();
    expect(errorOf(await run(stale, 'pto_delete', { ...DELETE, expectedVersion: 2 })).code).toBe(
      'CONFLICT',
    );

    const teammate = harness();
    teammate.client.detailValue = { ...DETAIL, user: { ...DETAIL.user, id: COLLEAGUE } };
    expect(errorOf(await run(teammate, 'pto_delete', DELETE)).code).toBe('PERMISSION');

    const noRead = harness();
    noRead.client.identityValue = identity({ scopes: ['pto:create'] });
    expect(errorOf(await run(noRead, 'pto_delete', DELETE)).code).toBe('PERMISSION');
  });

  it('deletes with one conditional call and reports only the deleted target', async () => {
    const target = harness();
    const previewId = previewIdOf(await run(target, 'pto_delete', DELETE));
    const result = await run(target, 'pto_delete', { ...DELETE, mode: 'apply', previewId });
    expect(target.client.calls.delete).toHaveLength(1);
    expect(target.client.calls.delete[0]).toMatchObject({ id: RECORD_ID, version: 3 });
    expect(dataOf(result)).toEqual({
      phase: 'apply',
      operation: 'delete',
      deleted: { id: RECORD_ID, ownerId: ACTOR, version: 3 },
    });
    expectValid('pto_delete', result);
  });

  it('refuses a target that changed after the preview without a substitute version', async () => {
    const target = harness();
    const previewId = previewIdOf(await run(target, 'pto_delete', DELETE));
    target.client.detailValue = { ...DETAIL, version: 4 };
    const result = await run(target, 'pto_delete', { ...DELETE, mode: 'apply', previewId });
    expect(errorOf(result).code).toBe('CONFLICT');
    expect(target.client.calls.delete).toHaveLength(0);
  });

  it('refuses a consumed preview and a changed credential', async () => {
    const reused = harness();
    const previewId = previewIdOf(await run(reused, 'pto_delete', DELETE));
    await run(reused, 'pto_delete', { ...DELETE, mode: 'apply', previewId });
    expect(
      errorOf(await run(reused, 'pto_delete', { ...DELETE, mode: 'apply', previewId })).code,
    ).toBe('PREVIEW');
    expect(reused.client.calls.delete).toHaveLength(1);

    const rotated = harness();
    const rotatedPreview = previewIdOf(await run(rotated, 'pto_delete', DELETE));
    rotated.auth.bundle = { ...BUNDLE, credential: { origin: ORIGIN, token: TOKEN_TWO } };
    expect(
      errorOf(
        await run(rotated, 'pto_delete', { ...DELETE, mode: 'apply', previewId: rotatedPreview }),
      ).code,
    ).toBe('PERMISSION');
    expect(rotated.client.calls.delete).toHaveLength(0);
  });

  it('re-checks the live role at apply and never deletes', async () => {
    const target = harness();
    target.client.detailValue = { ...DETAIL, user: { ...DETAIL.user, id: COLLEAGUE } };
    target.client.identityValue = identity({
      role: 'team_lead',
      scopes: ['pto:read', 'pto:delete:team'],
    });
    const previewId = previewIdOf(await run(target, 'pto_delete', DELETE));
    target.client.identityValue = identity({ role: 'member', scopes: ['pto:read'] });
    const result = await run(target, 'pto_delete', { ...DELETE, mode: 'apply', previewId });
    expect(errorOf(result).code).toBe('PERMISSION');
    expect(target.client.calls.delete).toHaveLength(0);
  });

  it('reports a lost delete answer as unknown and never retries', async () => {
    const target = harness();
    target.client.handlers = {
      delete: async () => {
        throw new PtoApiError('NETWORK_ERROR', { unknownWriteOutcome: true });
      },
    };
    const previewId = previewIdOf(await run(target, 'pto_delete', DELETE));
    const result = await run(target, 'pto_delete', { ...DELETE, mode: 'apply', previewId });
    expect(errorOf(result)).toMatchObject({ code: 'UNKNOWN_OUTCOME', recovery: 'reconcile' });
    expect(target.client.calls.delete).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------- */
/* The last mutation boundaries.                                             */
/* ------------------------------------------------------------------------- */

describe('the remaining mutation boundaries', () => {
  it('stops a preview whose detail read is cancelled after it answered', async () => {
    const target = harness();
    const control = new AbortController();
    target.client.handlers = {
      detail: async () => {
        control.abort();
        return DETAIL;
      },
    };
    const result = await run(target, 'pto_delete', DELETE, { signal: control.signal });
    expect(errorOf(result).code).toBe('CANCELLED');
  });

  it('refuses a delete preview when the bounded store is full', async () => {
    const previews = new PreviewStore({ now: () => NOW, limit: 1 });
    const target = harness({ previews });
    expect(previews.issue(manualBindingOf())).not.toBeNull();
    expect(errorOf(await run(target, 'pto_delete', DELETE)).code).toBe('BUSY');
  });

  it('stops a create apply that is cancelled at the one-dispatch guard', async () => {
    const target = harness();
    const control = new AbortController();
    const plan = createPlan();
    const previewId = previewIdOf(await run(target, 'pto_create', plan));
    target.dependencies = { ...target.dependencies, mutations: abortingGuard(control) };
    const result = await run(
      target,
      'pto_create',
      { ...plan, mode: 'apply', previewId },
      { signal: control.signal },
    );
    expect(errorOf(result).code).toBe('CANCELLED');
    expect(target.client.calls.create).toHaveLength(0);
  });

  it('re-checks the read scope and stops an update apply cancelled after its detail', async () => {
    const target = harness();
    const intent = { ...UPDATE, changes: { dayPart: 'morning' as PtoDayPart } };
    const previewId = previewIdOf(await run(target, 'pto_update', intent));
    target.client.identityValue = identity({ scopes: ['pto:update:self'] });
    expect(
      errorOf(await run(target, 'pto_update', { ...intent, mode: 'apply', previewId })).code,
    ).toBe('PERMISSION');
    expect(target.client.calls.patch).toHaveLength(0);

    const cancelled = harness();
    const cancelledIntent = { ...UPDATE, changes: { dayPart: 'morning' as PtoDayPart } };
    const cancelledPreview = previewIdOf(await run(cancelled, 'pto_update', cancelledIntent));
    const control = new AbortController();
    cancelled.client.handlers = {
      detail: async () => {
        control.abort();
        return DETAIL;
      },
    };
    expect(
      errorOf(
        await run(
          cancelled,
          'pto_update',
          { ...cancelledIntent, mode: 'apply', previewId: cancelledPreview },
          { signal: control.signal },
        ),
      ).code,
    ).toBe('CANCELLED');
    expect(cancelled.client.calls.patch).toHaveLength(0);
  });

  it('stops an update apply cancelled at the one-dispatch guard', async () => {
    const target = harness();
    const control = new AbortController();
    const intent = { ...UPDATE, changes: { dayPart: 'morning' as PtoDayPart } };
    const previewId = previewIdOf(await run(target, 'pto_update', intent));
    target.dependencies = { ...target.dependencies, mutations: abortingGuard(control) };
    const result = await run(
      target,
      'pto_update',
      { ...intent, mode: 'apply', previewId },
      { signal: control.signal },
    );
    expect(errorOf(result).code).toBe('CANCELLED');
    expect(target.client.calls.patch).toHaveLength(0);
  });

  it('allows only one concurrent DELETE and stops a delete at the guard', async () => {
    const target = harness();
    let started: () => void = () => undefined;
    const atDelete = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    target.client.handlers = {
      delete: async () => {
        started();
        await gate;
      },
    };
    const firstPreview = previewIdOf(await run(target, 'pto_delete', DELETE));
    const secondPreview = previewIdOf(await run(target, 'pto_delete', DELETE));
    const first = run(target, 'pto_delete', { ...DELETE, mode: 'apply', previewId: firstPreview });
    await atDelete;
    const second = await run(target, 'pto_delete', {
      ...DELETE,
      mode: 'apply',
      previewId: secondPreview,
    });
    expect(errorOf(second).code).toBe('BUSY');
    finish();
    await first;
    expect(target.client.calls.delete).toHaveLength(1);

    const cancelled = harness();
    const control = new AbortController();
    const previewId = previewIdOf(await run(cancelled, 'pto_delete', DELETE));
    cancelled.dependencies = { ...cancelled.dependencies, mutations: abortingGuard(control) };
    expect(
      errorOf(
        await run(
          cancelled,
          'pto_delete',
          { ...DELETE, mode: 'apply', previewId },
          {
            signal: control.signal,
          },
        ),
      ).code,
    ).toBe('CANCELLED');
    expect(cancelled.client.calls.delete).toHaveLength(0);
  });

  it('rechecks the claimed preview expiry at equality and past before every dispatch', async () => {
    for (const offset of [0, 1]) {
      const create = harness();
      const plan = createPlan();
      const createPreview = await run(create, 'pto_create', plan);
      const createAt = Date.parse(String(dataOf(createPreview)['expiresAt'])) + offset;
      create.dependencies = {
        ...create.dependencies,
        mutations: advancingGuard(create.clock, createAt),
      };
      const createResult = await run(create, 'pto_create', {
        ...plan,
        mode: 'apply',
        previewId: previewIdOf(createPreview),
      });
      expect(errorOf(createResult).code).toBe('PREVIEW');
      expect(create.client.calls.create).toHaveLength(0);

      const update = harness();
      const intent = { ...UPDATE, changes: { dayPart: 'morning' as PtoDayPart } };
      const updatePreview = await run(update, 'pto_update', intent);
      const updateAt = Date.parse(String(dataOf(updatePreview)['expiresAt'])) + offset;
      update.dependencies = {
        ...update.dependencies,
        mutations: advancingGuard(update.clock, updateAt),
      };
      const updateResult = await run(update, 'pto_update', {
        ...intent,
        mode: 'apply',
        previewId: previewIdOf(updatePreview),
      });
      expect(errorOf(updateResult).code).toBe('PREVIEW');
      expect(update.client.calls.patch).toHaveLength(0);

      const remove = harness();
      const deletePreview = await run(remove, 'pto_delete', DELETE);
      const deleteAt = Date.parse(String(dataOf(deletePreview)['expiresAt'])) + offset;
      remove.dependencies = {
        ...remove.dependencies,
        mutations: advancingGuard(remove.clock, deleteAt),
      };
      const deleteResult = await run(remove, 'pto_delete', {
        ...DELETE,
        mode: 'apply',
        previewId: previewIdOf(deletePreview),
      });
      expect(errorOf(deleteResult).code).toBe('PREVIEW');
      expect(remove.client.calls.delete).toHaveLength(0);
    }
  });

  it('holds one normalized target guard across PATCH and DELETE in both orders', async () => {
    const patchGate = deferred();
    const patchStarted = deferred();
    const updateFirst = harness();
    updateFirst.client.handlers = {
      patch: async () => {
        patchStarted.resolve();
        await patchGate.promise;
        return RECORD;
      },
    };
    const updateIntent = { ...UPDATE, changes: { dayPart: 'morning' as PtoDayPart } };
    const updatePreview = previewIdOf(await run(updateFirst, 'pto_update', updateIntent));
    const deletePreview = previewIdOf(await run(updateFirst, 'pto_delete', DELETE));
    const patching = run(updateFirst, 'pto_update', {
      ...updateIntent,
      mode: 'apply',
      previewId: updatePreview,
    });
    await patchStarted.promise;
    const blockedDelete = await run(updateFirst, 'pto_delete', {
      ...DELETE,
      mode: 'apply',
      previewId: deletePreview,
    });
    expect(errorOf(blockedDelete).code).toBe('BUSY');
    expect(updateFirst.client.calls.delete).toHaveLength(0);
    patchGate.resolve();
    await patching;
    expect(updateFirst.client.calls.patch).toHaveLength(1);

    const deleteGate = deferred();
    const deleteStarted = deferred();
    const deleteFirst = harness();
    deleteFirst.client.handlers = {
      delete: async () => {
        deleteStarted.resolve();
        await deleteGate.promise;
      },
    };
    const laterUpdatePreview = previewIdOf(await run(deleteFirst, 'pto_update', updateIntent));
    const laterDeletePreview = previewIdOf(await run(deleteFirst, 'pto_delete', DELETE));
    const deleting = run(deleteFirst, 'pto_delete', {
      ...DELETE,
      mode: 'apply',
      previewId: laterDeletePreview,
    });
    await deleteStarted.promise;
    const blockedUpdate = await run(deleteFirst, 'pto_update', {
      ...updateIntent,
      mode: 'apply',
      previewId: laterUpdatePreview,
    });
    expect(errorOf(blockedUpdate).code).toBe('BUSY');
    expect(deleteFirst.client.calls.patch).toHaveLength(0);
    deleteGate.resolve();
    await deleting;
    expect(deleteFirst.client.calls.delete).toHaveLength(1);
  });

  it('builds the write failure of either surface helper', () => {
    const write = anyToolFailure('pto_delete', 'BUSY');
    expect(write).toMatchObject({ ok: false, tool: 'pto_delete' });
    if (!write.ok) expect(write.error.code).toBe('BUSY');
  });
});

/** A guard that cancels the call at the moment the dispatch would start. */
function abortingGuard(control: AbortController): MutationGuard {
  return {
    acquire: () => {
      control.abort();
      return () => undefined;
    },
  } as unknown as MutationGuard;
}

/** A guard that advances the shared clock at the moment the dispatch would start. */
function advancingGuard(clock: { now: number }, at: number): MutationGuard {
  return {
    acquire: () => {
      clock.now = at;
      return () => undefined;
    },
  } as unknown as MutationGuard;
}

/** One externally completed gate. */
interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((completed) => {
    resolve = completed;
  });
  return { promise, resolve };
}

/* ------------------------------------------------------------------------- */
/* Dispatch and failure helpers.                                             */
/* ------------------------------------------------------------------------- */

describe('the combined dispatch helpers', () => {
  it('routes both surfaces and maps every failure category', async () => {
    expect(
      (await executeTool('pto_create', {}, LAUNCH, ENABLED, new AbortController().signal)).ok,
    ).toBe(false);
    expect(
      (await executeTool('pto_get', {}, LAUNCH, ENABLED, new AbortController().signal)).ok,
    ).toBe(false);

    const write = writeToolFailure('pto_create', 'CANCELLED');
    expect(errorOf(write).code).toBe('CANCELLED');
    expect(write.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const incomplete = writeToolFailure('pto_update', 'INCOMPLETE');
    expect(errorOf(incomplete).code).toBe('LOCAL');
    const read = anyToolFailure('pto_list', 'AUTH');
    expect(read).toMatchObject({ ok: false, tool: 'pto_list' });
  });

  it('keeps the adapter request id canonical when the runtime one is not', async () => {
    const target = harness({ requestId: () => 'not-a-request-id' });
    const result = await run(target, 'pto_delete', DELETE);
    expect(result.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('wraps an unexpected thrown identity with a local failure', async () => {
    const target = harness();
    target.dependencies = {
      ...target.dependencies,
      createAuth: () => {
        throw new Error('broken factory');
      },
    };
    const result = await run(target, 'pto_create', createPlan());
    expect(errorOf(result).code).toBe('LOCAL');
  });

  it('covers the update and delete unknown-outcome texts', async () => {
    for (const [name, args] of [
      ['pto_update', UPDATE],
      ['pto_delete', DELETE],
    ] as Array<[WriteToolName, WriteArguments]>) {
      const target = harness();
      const previewId = previewIdOf(await run(target, name, args));
      target.client.handlers =
        name === 'pto_update'
          ? {
              patch: async () => {
                throw new PtoApiError('TIMEOUT', { unknownWriteOutcome: true });
              },
            }
          : {
              delete: async () => {
                throw new PtoApiError('TIMEOUT', { unknownWriteOutcome: true });
              },
            };
      const result = await run(target, name, { ...args, mode: 'apply', previewId });
      expect(errorOf(result).code).toBe('UNKNOWN_OUTCOME');
      expect(errorOf(result).message).toMatch(/read the entry|reconcil/i);
    }
  });
});
