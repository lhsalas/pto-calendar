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
  type ListAllClientResult,
  type ListAllOptions,
  type ListAllQuery,
  type PtoDetail,
  type PtoIdentity,
  type PtoPageItem,
  type RequestOptions,
} from '@pto-calendar/api-client';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';

import type {
  LaunchOptions,
  ReadToolList,
  ToolErrorCode,
  ToolRecord,
  ToolResult,
} from '../src/contract.js';
import {
  executeReadTool,
  toolFailure,
  TOOL_DEFINITIONS,
  type ReadClient,
  type ToolDependencies,
} from '../src/tools.js';

const TOKEN = `pto_pat_11111111-1111-4111-8111-111111111111.${'a'.repeat(64)}`;
const ORIGIN = 'https://pto.example.test';

const BUNDLE: AgentAuthCredential = {
  baseUrl: ORIGIN,
  credential: { origin: ORIGIN, token: TOKEN },
  allowLoopbackHttp: false,
  profile: 'default',
  source: 'keyring',
};

const IDENTITY: PtoIdentity = {
  id: '55555555-5555-4555-8555-555555555555',
  role: 'member',
  auth: {
    method: 'pat',
    tokenId: '66666666-6666-4666-8666-666666666666',
    scopes: ['pto:read'],
    expiresAt: '2027-01-01T00:00:00.000Z',
  },
};

const ITEM: PtoPageItem = {
  id: '44444444-4444-4444-8444-444444444444',
  user: {
    id: '55555555-5555-4555-8555-555555555555',
    name: 'Ada Lovelace',
    colorCode: '#ff8800',
  },
  startDate: '2026-03-02',
  endDate: '2026-03-04',
  dayPart: 'all_day',
  note: null,
  version: 3,
};

const DETAIL: PtoDetail = {
  id: '44444444-4444-4444-8444-444444444444',
  user: ITEM.user,
  startDate: '2026-03-02',
  endDate: '2026-03-04',
  dayPart: 'all_day',
  note: 'Family day',
  version: 3,
};

const LAUNCH: LaunchOptions = { allowLoopbackHttp: false };

/** The recorded calls of the fake client. */
interface ClientCalls {
  readonly identity: RequestOptions[];
  readonly list: { readonly query: ListAllQuery; readonly options: ListAllOptions }[];
  readonly detail: { readonly id: string; readonly options: RequestOptions }[];
}

/** The handlers of the fake client. */
interface ClientHandlers {
  readonly identity?: () => Promise<PtoIdentity>;
  readonly list?: (query: ListAllQuery, options: ListAllOptions) => Promise<ListAllClientResult>;
  readonly detail?: (id: string, options: RequestOptions) => Promise<PtoDetail>;
}

/** A complete traversal of one row. */
const COMPLETE: ListAllClientResult = {
  items: [ITEM],
  complete: true,
  reason: 'complete',
  pages: 1,
};

/**
 * Builds a fake client that has no member but the three read methods.
 *
 * Any other member is refused at the first access, so a write could not be
 * expressed against this client even by accident.
 */
function fakeClient(handlers: ClientHandlers = {}): { client: ReadClient; calls: ClientCalls } {
  const calls: ClientCalls = { identity: [], list: [], detail: [] };
  const allowed = new Set(['getIdentity', 'listAll', 'getDetail']);
  const target = {
    getIdentity: async (options: RequestOptions = {}): Promise<PtoIdentity> => {
      calls.identity.push(options);
      return handlers.identity ? await handlers.identity() : IDENTITY;
    },
    listAll: async (
      query: ListAllQuery,
      options: ListAllOptions = {},
    ): Promise<ListAllClientResult> => {
      calls.list.push({ query, options });
      return handlers.list ? await handlers.list(query, options) : COMPLETE;
    },
    getDetail: async (id: string, options: RequestOptions = {}): Promise<PtoDetail> => {
      calls.detail.push({ id, options });
      return handlers.detail ? await handlers.detail(id, options) : DETAIL;
    },
  };
  const client = new Proxy(target, {
    get(object, property, receiver): unknown {
      if (typeof property === 'string' && !allowed.has(property)) {
        throw new Error(`the read surface has no member named ${property}`);
      }
      return Reflect.get(object, property, receiver);
    },
  }) as ReadClient;
  return { client, calls };
}

/** Builds a fake local store that resolves one bundle or refuses. */
function fakeAuth(
  outcome: AgentAuthCredential | Error,
  onResolve?: () => void,
): {
  auth: AgentAuth;
  calls: ResolveInput[];
} {
  const calls: ResolveInput[] = [];
  const auth: AgentAuth = {
    setProfile: async () => {
      throw new Error('a tool call never stores a credential');
    },
    resolve: async (input: ResolveInput = {}) => {
      calls.push(input);
      if (onResolve !== undefined) onResolve();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    status: async () => {
      throw new Error('a tool call never reports the state of the store');
    },
    removeProfile: async () => {
      throw new Error('a tool call never removes a credential');
    },
  };
  return { auth, calls };
}

/** The dependencies of one call and the calls they recorded. */
interface Harness {
  readonly dependencies: ToolDependencies;
  readonly authCalls: ResolveInput[];
  readonly clientCalls: ClientCalls;
  readonly clientOptions: { value: unknown }[];
}

/**
 * Builds the dependencies of one call.
 *
 * The clock is frozen, so the deadline of every request is the documented
 * one, and the request identifier is the documented one.
 */
function harness(
  options: {
    readonly auth?: AgentAuthCredential | Error;
    readonly onResolve?: () => void;
    readonly handlers?: ClientHandlers;
    readonly now?: () => number;
    readonly requestId?: () => string;
  } = {},
): Harness {
  const { auth, calls: authCalls } = fakeAuth(options.auth ?? BUNDLE, options.onResolve);
  const { client, calls: clientCalls } = fakeClient(options.handlers ?? {});
  const clientOptions: { value: unknown }[] = [];
  const dependencies: ToolDependencies = {
    createAuth: () => auth,
    createClient: (value) => {
      clientOptions.push({ value });
      return client;
    },
    now: options.now ?? (() => 1_000),
    newRequestId: options.requestId ?? (() => '77777777-7777-4777-8777-777777777777'),
  };
  return { dependencies, authCalls, clientCalls, clientOptions };
}

/** The signal of a call that is not cancelled. */
function liveSignal(): AbortSignal {
  return new AbortController().signal;
}

/** The error of one failed answer. */
function failureOf(result: ToolResult): { code: ToolErrorCode; message: string } {
  if (result.ok) throw new Error('the call was expected to fail');
  return { code: result.error.code, message: result.error.message };
}

/** The rows of a finished list call. */
function listDataOf(result: ToolResult): ReadToolList {
  if (result.ok && result.tool === 'pto_list') return result.data;
  throw new Error('the call did not return a list of rows');
}

/** The record of a finished detail call. */
function recordOf(result: ToolResult): ToolRecord {
  if (result.ok && result.tool === 'pto_get') return result.data;
  throw new Error('the call did not return a record');
}

/** Validates a value against a schema with the validator of the SDK. */
function validates(schema: unknown, value: unknown): boolean {
  const validator = new AjvJsonSchemaValidator();
  const compiled = validator.getValidator(schema as Parameters<typeof validator.getValidator>[0]);
  return compiled(value).valid;
}

/** The advertised schema of one tool. */
function schemaOf(name: string): unknown {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name);
  if (definition === undefined) throw new Error(`the tool ${name} is not advertised`);
  return definition.outputSchema;
}

describe('the advertised tools', () => {
  it('advertises the same exact IDs and mutually exclusive owner filters that the handler admits', () => {
    const id = 'B0000000-1111-4111-8111-000000000001';
    const date = { from: '2026-12-07', to: '2026-12-08' };
    const advertised = ListToolsResultSchema.parse({ tools: TOOL_DEFINITIONS }).tools;
    const list = advertised.find((entry) => entry.name === 'pto_list')!.inputSchema;
    const get = advertised.find((entry) => entry.name === 'pto_get')!.inputSchema;
    expect(validates(get, { id })).toBe(true);
    expect(validates(get, { id: `${id}\n` })).toBe(false);
    expect(validates(list, { ...date, ownerId: id, mine: true })).toBe(false);
    expect(validates(list, { ...date, ownerId: id, mine: false })).toBe(true);
    expect(validates(list, { ...date, mine: true })).toBe(true);
  });

  it('are exactly the two documented read tools', () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(['pto_list', 'pto_get']);
  });

  it('are read-only and never destructive', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.idempotentHint).toBe(true);
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
    }
  });

  it('never offer a write', () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name);
    for (const name of ['pto_create', 'pto_update', 'pto_delete', 'pto_write']) {
      expect(names).not.toContain(name);
    }
  });

  it('survive the parsing of the SDK tool list and stay closed', () => {
    const parsed = ListToolsResultSchema.parse({ tools: TOOL_DEFINITIONS });
    for (const tool of parsed.tools) {
      if (tool.outputSchema === undefined) throw new Error('the tool advertises no output schema');
      const envelope = {
        schemaVersion: 1,
        requestId: '77777777-7777-4777-8777-777777777777',
        ok: false,
        tool: tool.name,
        error: {
          code: 'AUTH',
          message: 'fixed',
          status: null,
          upstreamRequestId: null,
          retryAfterMs: null,
        },
      };
      expect(validates(tool.outputSchema, envelope)).toBe(true);
      expect(validates(tool.outputSchema, { ...envelope, unexpected: true })).toBe(false);
    }
  });
});

describe('the argument validation', () => {
  it('refuses a malformed call before the local store is opened', async () => {
    const { dependencies, authCalls, clientCalls } = harness();
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-13-40', to: '2026-03-04' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(failureOf(result).code).toBe('INPUT');
    expect(authCalls).toHaveLength(0);
    expect(clientCalls.list).toHaveLength(0);
  });

  it('refuses an unknown argument before the local store is opened', async () => {
    const { dependencies, authCalls } = harness();
    const result = await executeReadTool(
      'pto_get',
      { id: '44444444-4444-4444-8444-444444444444', token: 'secret' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(failureOf(result).code).toBe('INPUT');
    expect(authCalls).toHaveLength(0);
  });

  it('refuses a tool that is not one of the documented ones', async () => {
    const { dependencies, authCalls } = harness();
    const result = await executeReadTool(
      'pto_delete' as 'pto_get',
      { id: '44444444-4444-4444-8444-444444444444' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(failureOf(result).code).toBe('INPUT');
    expect(authCalls).toHaveLength(0);
  });
});

describe('the list tool', () => {
  it('reads a complete range and reports the completeness', async () => {
    const { dependencies, clientCalls } = harness();
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tool).toBe('pto_list');
    const data = listDataOf(result);
    expect(data.complete).toBe(true);
    expect(data.reason).toBe('complete');
    expect(data.pages).toBe(1);
    expect(data.items).toHaveLength(1);
    expect(data.items[0]!.note).toBeNull();
    expect(data.items[0]!.owner).toEqual({
      id: '55555555-5555-4555-8555-555555555555',
      name: 'Ada Lovelace',
    });
    expect(clientCalls.list).toHaveLength(1);
    expect(clientCalls.list[0]!.query).toEqual({
      start: '2026-03-02',
      end: '2026-03-04',
      limit: 50,
    });
    expect(clientCalls.list[0]!.options.maxPages).toBe(6);
    expect(clientCalls.list[0]!.options.maxRecords).toBe(250);
  });

  it('resolves the own records through the identity of the credential', async () => {
    const { dependencies, clientCalls } = harness();
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04', mine: true },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(result.ok).toBe(true);
    expect(clientCalls.identity).toHaveLength(1);
    expect(clientCalls.list[0]!.query.userId).toBe(IDENTITY.id);
    // The identity call and the traversal share the one deadline.
    expect(clientCalls.identity[0]!.timeoutMs).toBe(20_000);
    expect(clientCalls.list[0]!.options.timeoutMs).toBe(20_000);
  });

  it('sends the requested owner constraint to the API without broadening the list', async () => {
    const { dependencies, clientCalls } = harness();
    const ownerId = '55555555-5555-4555-8555-555555555555';
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04', ownerId },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(result.ok).toBe(true);
    expect(clientCalls.identity).toHaveLength(0);
    expect(clientCalls.list.map(({ query }) => query)).toEqual([
      { start: '2026-03-02', end: '2026-03-04', userId: ownerId, limit: 50 },
    ]);
  });

  it('passes the signal to the identity call and to the traversal', async () => {
    const controller = new AbortController();
    const { dependencies, clientCalls } = harness();
    await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04', mine: true },
      LAUNCH,
      {},
      controller.signal,
      dependencies,
    );
    expect(clientCalls.identity[0]!.signal).toBe(controller.signal);
    expect(clientCalls.list[0]!.options.signal).toBe(controller.signal);
  });

  it('reports an exhausted budget as an incomplete read with the rows it read', async () => {
    const { dependencies } = harness({
      handlers: {
        list: async () => ({
          items: [ITEM],
          complete: false,
          reason: 'budget',
          pages: 6,
        }),
      },
    });
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INCOMPLETE');
    expect(result.partial?.items).toHaveLength(1);
    expect(result.partial?.complete).toBe(false);
    expect(result.partial?.reason).toBe('budget');
    expect(result.partial?.pages).toBe(6);
  });

  it('reports defensive result truncation as incomplete despite a complete client result', async () => {
    const { dependencies } = harness({
      handlers: {
        list: async () => ({
          items: Array.from({ length: 251 }, () => ITEM),
          complete: true,
          reason: 'complete',
          pages: 6,
        }),
      },
    });
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INCOMPLETE' },
      partial: { complete: false, reason: 'budget' },
    });
    if (!result.ok) expect(result.partial?.items).toHaveLength(250);
  });

  it('reports a drifted page as an incomplete read', async () => {
    const { dependencies } = harness({
      handlers: {
        list: async () => ({
          items: [ITEM],
          complete: false,
          reason: 'drift',
          pages: 2,
          error: new PtoApiError('INVALID_RESPONSE'),
        }),
      },
    });
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INCOMPLETE');
    expect(result.partial?.reason).toBe('drift');
  });

  it('keeps the category of a failure of the service', async () => {
    const { dependencies } = harness({
      handlers: {
        list: async () => ({
          items: [],
          complete: false,
          reason: 'error',
          pages: 0,
          error: new PtoApiError('UNAUTHENTICATED', {
            status: 401,
            requestId: 'req-1234',
            retryAfterMs: 1_000,
          }),
        }),
      },
    });
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTH');
    expect(result.error.status).toBe(401);
    expect(result.error.upstreamRequestId).toBe('req-1234');
    expect(result.error.retryAfterMs).toBe(1_000);
  });

  it('keeps an unknown upstream code as a network failure', async () => {
    const { dependencies } = harness({
      handlers: {
        list: async () => ({
          items: [],
          complete: false,
          reason: 'error',
          pages: 0,
          error: new PtoApiError('SOMETHING_NEW'),
        }),
      },
    });
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NETWORK');
    expect(result.error.status).toBeNull();
    expect(result.error.upstreamRequestId).toBeNull();
  });

  it('reports a missing row of a failed read as incomplete', async () => {
    const { dependencies } = harness({
      handlers: {
        list: async () => ({
          items: [ITEM],
          complete: false,
          reason: 'error',
          pages: 1,
          error: new PtoApiError('RATE_LIMITED', { status: 429, retryAfterMs: 2_000 }),
        }),
      },
    });
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INCOMPLETE');
    expect(result.error.retryAfterMs).toBe(2_000);
    expect(result.partial?.items).toHaveLength(1);
  });

  it('drops a correlation id that carries a secret or is not an identifier', async () => {
    const { dependencies } = harness({
      handlers: {
        list: async () => ({
          items: [],
          complete: false,
          reason: 'error',
          pages: 0,
          error: new PtoApiError('UNAUTHENTICATED', {
            status: 401,
            requestId: TOKEN,
          }),
        }),
      },
    });
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.upstreamRequestId).toBeNull();
  });

  it('drops a correlation id that is not an identifier', async () => {
    const { dependencies } = harness({
      handlers: {
        list: async () => ({
          items: [],
          complete: false,
          reason: 'error',
          pages: 0,
          error: new PtoApiError('UNAUTHENTICATED', {
            status: 401,
            requestId: 'not an identifier',
          }),
        }),
      },
    });
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.upstreamRequestId).toBeNull();
  });

  it('drops a retry hint that is not a whole number of milliseconds', async () => {
    const { dependencies } = harness({
      handlers: {
        list: async () => ({
          items: [],
          complete: false,
          reason: 'error',
          pages: 0,
          error: new PtoApiError('RATE_LIMITED', { status: 429, retryAfterMs: -5 }),
        }),
      },
    });
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.retryAfterMs).toBeNull();
  });
});

describe('the detail tool', () => {
  it('hides the note without an explicit opt-in', async () => {
    const { dependencies, clientCalls } = harness();
    const result = await executeReadTool(
      'pto_get',
      { id: '44444444-4444-4444-8444-444444444444' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tool).toBe('pto_get');
    expect(recordOf(result).note).toBeNull();
    expect(clientCalls.detail[0]!.id).toBe('44444444-4444-4444-8444-444444444444');
    expect(clientCalls.detail[0]!.options.timeoutMs).toBe(15_000);
  });

  it('carries the note of the service when it was asked for', async () => {
    const { dependencies } = harness();
    const result = await executeReadTool(
      'pto_get',
      { id: '44444444-4444-4444-8444-444444444444', includeNote: true },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(recordOf(result).note).toBe('Family day');
  });

  it('reports a record that does not exist', async () => {
    const { dependencies } = harness({
      handlers: {
        detail: async () => {
          throw new PtoApiError('NOT_FOUND', { status: 404 });
        },
      },
    });
    const result = await executeReadTool(
      'pto_get',
      { id: '44444444-4444-4444-8444-444444444444' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
    expect(result.error.status).toBe(404);
  });

  it('reports a credential the service no longer accepts', async () => {
    const { dependencies } = harness({
      handlers: {
        detail: async () => {
          throw new PtoApiError('UNAUTHENTICATED', { status: 401 });
        },
      },
    });
    const result = await executeReadTool(
      'pto_get',
      { id: '44444444-4444-4444-8444-444444444444' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTH');
  });

  it('reports a credential without the scope of the read', async () => {
    const { dependencies } = harness({
      handlers: {
        detail: async () => {
          throw new PtoApiError('FORBIDDEN', { status: 403 });
        },
      },
    });
    const result = await executeReadTool(
      'pto_get',
      { id: '44444444-4444-4444-8444-444444444444' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PERMISSION');
  });
});

describe('the cancellation', () => {
  it('never opens the local store of a cancelled call', async () => {
    const controller = new AbortController();
    controller.abort();
    const { dependencies, authCalls } = harness();
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      LAUNCH,
      {},
      controller.signal,
      dependencies,
    );
    expect(failureOf(result).code).toBe('CANCELLED');
    expect(authCalls).toHaveLength(0);
  });

  it('never opens the local store of a cancelled detail call', async () => {
    const controller = new AbortController();
    controller.abort();
    const { dependencies, authCalls } = harness();
    const result = await executeReadTool(
      'pto_get',
      { id: '44444444-4444-4444-8444-444444444444' },
      LAUNCH,
      {},
      controller.signal,
      dependencies,
    );
    expect(failureOf(result).code).toBe('CANCELLED');
    expect(authCalls).toHaveLength(0);
  });

  it('reports a cancelled traversal as a cancellation with the rows it read', async () => {
    const controller = new AbortController();
    const { dependencies } = harness({
      handlers: {
        list: async () => {
          controller.abort();
          return { items: [ITEM], complete: false, reason: 'aborted', pages: 1 };
        },
      },
    });
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      LAUNCH,
      {},
      controller.signal,
      dependencies,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CANCELLED');
    expect(result.partial?.reason).toBe('aborted');
    expect(result.partial?.complete).toBe(false);
  });

  it('reports a cancelled request as a cancellation', async () => {
    const controller = new AbortController();
    const { dependencies } = harness({
      handlers: {
        detail: async () => {
          controller.abort();
          throw new PtoApiError('ABORTED');
        },
      },
    });
    const result = await executeReadTool(
      'pto_get',
      { id: '44444444-4444-4444-8444-444444444444' },
      LAUNCH,
      {},
      controller.signal,
      dependencies,
    );
    expect(failureOf(result).code).toBe('CANCELLED');
  });

  it('never reaches the service of a call that was cancelled while the store was read', async () => {
    const controller = new AbortController();
    const { dependencies, clientCalls } = harness({ onResolve: () => controller.abort() });
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      LAUNCH,
      {},
      controller.signal,
      dependencies,
    );
    expect(failureOf(result).code).toBe('CANCELLED');
    expect(clientCalls.list).toHaveLength(0);
  });
});

describe('the local credential', () => {
  it('is bound to the origin of the local store', async () => {
    const { dependencies, clientOptions } = harness();
    await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(clientOptions).toHaveLength(1);
    expect(clientOptions[0]!.value).toEqual({
      baseUrl: ORIGIN,
      credential: { origin: ORIGIN, token: TOKEN },
      allowLoopbackHttp: false,
      timeoutMs: 20_000,
      readRetries: 2,
    });
  });

  it('is read from the named profile when one was named', async () => {
    const { dependencies, authCalls } = harness();
    await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      { profile: 'default', allowLoopbackHttp: false },
      {},
      liveSignal(),
      dependencies,
    );
    expect(authCalls[0]!.profile).toBe('default');
    expect(authCalls[0]!.env).toBeUndefined();
  });

  it('reads only the managed environment pair', async () => {
    const { dependencies, authCalls } = harness();
    await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      LAUNCH,
      {
        PTO_API_ORIGIN: ORIGIN,
        PTO_API_TOKEN: TOKEN,
        PTO_API_OTHER: 'ignored',
        SESSION_SECRET: 'ignored',
      },
      liveSignal(),
      dependencies,
    );
    expect(authCalls[0]!.env).toEqual({ PTO_API_ORIGIN: ORIGIN, PTO_API_TOKEN: TOKEN });
  });

  it('reports a missing credential without asking for one', async () => {
    const { dependencies } = harness({ auth: new AgentAuthError('PROFILE_NOT_CONFIGURED') });
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(failureOf(result).code).toBe('AUTH');
    expect(result.ok).toBe(false);
  });

  it('reports a locked credential store', async () => {
    const { dependencies } = harness({ auth: new AgentAuthError('KEYRING_LOCKED') });
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(failureOf(result).code).toBe('AUTH');
  });

  it('reports an ambiguous credential as a local failure', async () => {
    const { dependencies } = harness({ auth: new AgentAuthError('AMBIGUOUS_CREDENTIALS') });
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(failureOf(result).code).toBe('LOCAL');
  });

  it('reports a busy credential store', async () => {
    const { dependencies } = harness({ auth: new AgentAuthError('FILE_BUSY') });
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(failureOf(result).code).toBe('BUSY');
  });

  it('reports a failure of the store that it does not know', async () => {
    const { dependencies } = harness({
      auth: new AgentAuthError('SOMETHING_ELSE' as AgentAuthErrorCode),
    });
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(failureOf(result).code).toBe('LOCAL');
  });

  it('reports a failure of the store that is not a classified one', async () => {
    const { dependencies } = harness({ auth: new Error('the store is unreachable') });
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(failureOf(result).code).toBe('LOCAL');
  });

  it('refuses a partial managed environment instead of falling back', async () => {
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      LAUNCH,
      { PTO_API_ORIGIN: ORIGIN },
      liveSignal(),
    );
    expect(failureOf(result).code).toBe('LOCAL');
  });

  it('refuses a named profile together with a managed environment', async () => {
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      { profile: 'default', allowLoopbackHttp: false },
      { PTO_API_ORIGIN: ORIGIN, PTO_API_TOKEN: TOKEN },
      liveSignal(),
    );
    expect(failureOf(result).code).toBe('LOCAL');
  });
});

describe('the sealed answers', () => {
  it('never carry a secret of the credential', async () => {
    const secret = 'a'.repeat(64);
    const { dependencies } = harness({
      handlers: {
        detail: async () => ({
          ...DETAIL,
          user: { ...DETAIL.user, name: `Ada ${TOKEN}` },
          note: `Family ${secret} day`,
        }),
      },
    });
    const result = await executeReadTool(
      'pto_get',
      { id: '44444444-4444-4444-8444-444444444444', includeNote: true },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('[redacted]');
  });

  it('never carry a control character of the service', async () => {
    const { dependencies } = harness({
      handlers: {
        detail: async () => ({ ...DETAIL, user: { ...DETAIL.user, name: 'Ada\u0000Lovelace' } }),
      },
    });
    const result = await executeReadTool(
      'pto_get',
      { id: '44444444-4444-4444-8444-444444444444' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(recordOf(result).owner.name).toBe('AdaLovelace');
    expect(recordOf(result).owner.name).not.toContain('\u0000');
  });

  it('report an exhausted deadline as a timeout', async () => {
    let tick = 0;
    const { dependencies } = harness({
      now: () => {
        tick += 1;
        return tick === 1 ? 0 : 100_000;
      },
    });
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(failureOf(result).code).toBe('NETWORK');
  });

  it('report an unexpected local failure as a local failure', async () => {
    const { dependencies } = harness({
      handlers: {
        detail: async () => {
          throw new Error('a defect of this server');
        },
      },
    });
    const result = await executeReadTool(
      'pto_get',
      { id: '44444444-4444-4444-8444-444444444444' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('LOCAL');
    expect(result.error.message).not.toContain('defect');
  });
});

describe('the failure envelope', () => {
  it('carries the fixed message of its category', () => {
    for (const code of [
      'INPUT',
      'AUTH',
      'PERMISSION',
      'NOT_FOUND',
      'QUOTA',
      'NETWORK',
      'INCOMPLETE',
      'CANCELLED',
      'LOCAL',
      'BUSY',
    ] as const) {
      const result = toolFailure('pto_get', code);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.tool).toBe('pto_get');
      expect(result.error.code).toBe(code);
      expect(result.error.message.length).toBeGreaterThan(0);
      expect(result.error.status).toBeNull();
      expect(result.error.upstreamRequestId).toBeNull();
      expect(result.error.retryAfterMs).toBeNull();
    }
  });

  it('carries its own request identifier', () => {
    const first = toolFailure('pto_list', 'AUTH');
    const second = toolFailure('pto_list', 'AUTH');
    expect(first.requestId).not.toBe(second.requestId);
    expect(first.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('validates against the advertised output schema', () => {
    for (const tool of ['pto_list', 'pto_get'] as const) {
      expect(validates(schemaOf(tool), toolFailure(tool, 'AUTH'))).toBe(true);
    }
  });
});

describe('the envelope of a finished read', () => {
  it('validates against the advertised output schema of the list tool', async () => {
    const { dependencies } = harness();
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(validates(schemaOf('pto_list'), result)).toBe(true);
  });

  it('validates against the advertised output schema of the detail tool', async () => {
    const { dependencies } = harness();
    const result = await executeReadTool(
      'pto_get',
      { id: '44444444-4444-4444-8444-444444444444' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(validates(schemaOf('pto_get'), result)).toBe(true);
  });

  it('validates an incomplete read against the advertised output schema', async () => {
    const { dependencies } = harness({
      handlers: {
        list: async () => ({ items: [ITEM], complete: false, reason: 'budget', pages: 6 }),
      },
    });
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(validates(schemaOf('pto_list'), result)).toBe(true);
  });

  it('uses the request identifier of the adapter', async () => {
    const { dependencies } = harness({
      requestId: () => '88888888-8888-4888-8888-888888888888',
    });
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(result.requestId).toBe('88888888-8888-4888-8888-888888888888');
  });

  it('replaces a request identifier that is not canonical', async () => {
    const { dependencies } = harness({ requestId: () => 'not-an-identifier' });
    const result = await executeReadTool(
      'pto_list',
      { from: '2026-03-02', to: '2026-03-04' },
      LAUNCH,
      {},
      liveSignal(),
      dependencies,
    );
    expect(result.requestId).not.toBe('not-an-identifier');
    expect(result.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
