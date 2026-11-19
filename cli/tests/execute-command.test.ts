import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import {
  AgentAuthError,
  type AgentAuth,
  type AgentAuthCredential,
  type AgentAuthEnvironment,
  type AgentAuthErrorCode,
  type RemoveProfileResult,
  type ResolveInput,
  type SecretInputSource,
  type SetProfileInput,
} from '@pto-calendar/agent-auth';
import {
  createPtoClient,
  PtoApiError,
  type ListAllClientResult,
  type ListAllOptions,
  type ListAllQuery,
  type PtoClientOptions,
  type PtoDetail,
  type PtoIdentity,
  type PtoPageItem,
  type RequestOptions,
} from '@pto-calendar/api-client';

import type {
  CliFailure,
  CliResult,
  CliSuccess,
  ListData,
  Operation,
  ReadAuthOptions,
} from '../src/contract.js';
import {
  executeCommand,
  executeWithDependencies,
  type ExecuteDependencies,
  type OperationContext,
  type ReadClient,
} from '../src/execute-command.js';

/*
 * Synthetic fixtures only. The token below is a shape-valid fake, never a real
 * credential, and every store and transport in this file is an in-memory double.
 */

const ORIGIN = 'https://pto.example.com';
const LOOPBACK = 'http://127.0.0.1:3000';
const SECRET = '0123456789abcdef'.repeat(4);
/** SHA-256 of the UTF-8 secret component, as the backend token domain computes it. */
const DIGEST = 'a8ae6e6ee929abea3afcfc5258c8ccd6f85273e0d4626d26c7279f3250f77c8e';
const TOKEN = `pto_pat_11111111-1111-4111-8111-111111111111.${SECRET}`;
const OTHER_TOKEN = `pto_pat_22222222-2222-4222-8222-222222222222.${'b'.repeat(64)}`;
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_OWNER_ID = '66666666-6666-4666-8666-666666666666';
const ENTRY_ID = '44444444-4444-4444-8444-444444444444';
const TOKEN_ID = '55555555-5555-4555-8555-555555555555';
const REQUEST_ID = 'req-20261119-0001';
const GUIDANCE_FRAGMENT = 'does not revoke the token on the server';

const BUNDLE: AgentAuthCredential = {
  baseUrl: ORIGIN,
  credential: { origin: ORIGIN, token: TOKEN },
  allowLoopbackHttp: false,
  profile: 'default',
  source: 'keyring',
};

const IDENTITY: PtoIdentity = {
  id: OWNER_ID,
  role: 'member',
  auth: {
    method: 'pat',
    tokenId: TOKEN_ID,
    scopes: ['pto:read'],
    expiresAt: '2027-01-01T00:00:00.000Z',
  },
};

const USER = { id: OWNER_ID, name: 'Ada Lovelace', colorCode: '#3366ff' };

function item(overrides: Partial<PtoPageItem> = {}): PtoPageItem {
  return {
    id: ENTRY_ID,
    user: { ...USER },
    startDate: '2026-12-01',
    endDate: '2026-12-02',
    dayPart: 'all_day',
    note: null,
    version: 1,
    ...overrides,
  };
}

function detail(overrides: Partial<PtoDetail> = {}): PtoDetail {
  return {
    id: ENTRY_ID,
    user: { ...USER },
    startDate: '2026-12-01',
    endDate: '2026-12-01',
    dayPart: 'morning',
    note: null,
    version: 2,
    ...overrides,
  };
}

function traversal(overrides: Partial<ListAllClientResult> = {}): ListAllClientResult {
  return { items: [], complete: true, reason: 'complete', pages: 1, ...overrides };
}

/** A clock the test moves by hand. It never reads the real time. */
function makeClock(start = 1_000) {
  let now = start;
  return {
    now: (): number => now,
    advance: (ms: number): void => {
      now += ms;
    },
  };
}

type Clock = ReturnType<typeof makeClock>;

function authDouble(overrides: Partial<AgentAuth> = {}): AgentAuth {
  return {
    setProfile: (input: SetProfileInput) =>
      Promise.resolve({
        profile: input.profile,
        origin: input.baseUrl,
        source: input.storage ?? 'keyring',
        allowLoopbackHttp: input.allowLoopbackHttp ?? false,
      }),
    resolve: () => Promise.resolve(BUNDLE),
    status: () => Promise.reject(new Error('status is not used by the CLI')),
    removeProfile: (profile: string) =>
      Promise.resolve({ profile, source: 'keyring', removed: true, guidance: 'unused' }),
    ...overrides,
  };
}

function clientDouble(overrides: Partial<ReadClient> = {}): ReadClient {
  return {
    getIdentity: () => Promise.resolve(IDENTITY),
    listAll: () => Promise.resolve(traversal()),
    getDetail: () => Promise.resolve(detail()),
    ...overrides,
  };
}

interface Harness {
  readonly deps: ExecuteDependencies;
  readonly auth: AgentAuth;
  readonly client: ReadClient;
  readonly clientOptions: PtoClientOptions[];
  readonly clock: Clock;
}

/** The seam: the stores and the transport are replaced, nothing else is. */
function harness(parts: { auth?: AgentAuth; client?: ReadClient; clock?: Clock } = {}): Harness {
  const auth = parts.auth ?? authDouble();
  const client = parts.client ?? clientDouble();
  const clock = parts.clock ?? makeClock();
  const clientOptions: PtoClientOptions[] = [];
  const deps: ExecuteDependencies = {
    createAuth: () => auth,
    createClient: (options) => {
      clientOptions.push(options);
      return client;
    },
    now: clock.now,
  };
  return { deps, auth, client, clientOptions, clock };
}

interface Ctx {
  readonly context: OperationContext;
  readonly controller: AbortController;
  readonly prompt: ReturnType<typeof vi.fn<(message: string) => void>>;
}

function ctx(
  parts: {
    input?: SecretInputSource;
    interactive?: boolean;
    env?: NodeJS.ProcessEnv;
    prompt?: (message: string) => void;
  } = {},
): Ctx {
  const controller = new AbortController();
  const prompt = vi.fn<(message: string) => void>(parts.prompt ?? (() => undefined));
  const context: OperationContext = {
    env: parts.env ?? {},
    input: parts.input ?? new PassThrough(),
    interactive: parts.interactive ?? false,
    signal: controller.signal,
    prompt,
  };
  return { context, controller, prompt };
}

/** A synthetic terminal that records every raw-mode change. It never touches a real TTY. */
class FakeTerminal extends PassThrough {
  readonly isTTY = true;
  isRaw = false;
  readonly rawHistory: boolean[] = [];
  setRawMode(mode: boolean): void {
    this.rawHistory.push(mode);
    this.isRaw = mode;
  }
}

function asSuccess(result: CliResult): CliSuccess {
  expect(result.ok).toBe(true);
  return result as CliSuccess;
}

function asFailure(result: CliResult): CliFailure {
  expect(result.ok).toBe(false);
  return result as CliFailure;
}

/** The rows of a successful list. */
function rowsOf(result: CliResult): readonly PtoPageItem[] {
  return (asSuccess(result).data as ListData).items;
}

/** No secret, digest or token prefix may appear in any value the CLI returns. */
function expectNoSecrets(value: unknown): void {
  const text = JSON.stringify(value);
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(DIGEST);
  expect(text).not.toContain('pto_pat_');
}

const READ: ReadAuthOptions = { allowLoopbackHttp: false };

function authSetOp(overrides: Partial<Extract<Operation, { kind: 'auth-set' }>> = {}): Operation {
  return {
    kind: 'auth-set',
    profile: 'work',
    origin: ORIGIN,
    storage: 'keyring',
    allowLoopbackHttp: false,
    tokenStdin: true,
    ...overrides,
  };
}

function statusOp(auth: Partial<ReadAuthOptions> = {}): Operation {
  return { kind: 'auth-status', auth: { ...READ, ...auth } };
}

function listOp(overrides: Partial<Extract<Operation, { kind: 'list' }>> = {}): Operation {
  return {
    kind: 'list',
    auth: READ,
    from: '2026-12-01',
    to: '2026-12-31',
    mine: false,
    pageSize: 100,
    maxPages: 30,
    ...overrides,
  };
}

function getOp(id: unknown = ENTRY_ID, auth: Partial<ReadAuthOptions> = {}): Operation {
  return { kind: 'get', auth: { ...READ, ...auth }, id } as Operation;
}

function removeOp(profile: unknown = 'work'): Operation {
  return { kind: 'auth-remove', profile } as Operation;
}

/** Runs a command against the seam and returns the result. */
function run(operation: Operation, h: Harness, c: Ctx): Promise<CliResult> {
  return executeWithDependencies(h.deps, operation, c.context);
}

describe('the public entry point', () => {
  it('does not start a client if cancellation happens while the local resolution was pending', async () => {
    const c = ctx();
    const resolve = vi.fn(async () => {
      c.controller.abort();
      return BUNDLE;
    });
    const h = harness({ auth: authDouble({ resolve }) });
    const result = asFailure(await run(getOp(), h, c));
    expect(result.error.code).toBe('CANCELLED');
    expect(h.clientOptions).toHaveLength(0);
  });

  it('refuses a cancelled operation before any store or transport is touched', async () => {
    const controller = new AbortController();
    controller.abort();
    const context: OperationContext = {
      env: {},
      input: new PassThrough(),
      interactive: false,
      signal: controller.signal,
      prompt: () => undefined,
    };

    const result = await executeCommand(removeOp(), context);

    expect(result).toEqual({
      schemaVersion: 1,
      ok: false,
      command: 'auth-remove',
      error: {
        code: 'CANCELLED',
        message: 'The command was cancelled.',
        status: null,
        requestId: null,
        retryAfterMs: null,
      },
    });
  });

  it('classifies an operation of an unexpected kind as a local failure', async () => {
    const h = harness();
    const c = ctx();
    const result = await run({ kind: 'help' } as unknown as Operation, h, c);

    const failed = asFailure(result);
    expect(failed.command).toBe('help');
    expect(failed.error.code).toBe('LOCAL');
  });

  it('never echoes a thrown value that is not a classified error', async () => {
    const auth = authDouble({
      resolve: () => Promise.reject('raw cause with pto_pat_secret'),
    });
    const h = harness({ auth });
    const c = ctx();

    const result = await run(statusOp(), h, c);

    const failed = asFailure(result);
    expect(failed.error.code).toBe('LOCAL');
    expect(JSON.stringify(result)).not.toContain('raw cause');
  });

  it('maps an unknown service code to a local failure with the fixed text', async () => {
    const client = clientDouble({
      getIdentity: () => Promise.reject(new PtoApiError('SOMETHING_NEW', { status: 418 })),
    });
    const h = harness({ client });
    const c = ctx();

    const failed = asFailure(await run(statusOp(), h, c));

    expect(failed.error.code).toBe('LOCAL');
    expect(failed.error.message).toBe(
      'An unexpected local error occurred. No further details are available.',
    );
  });
});

describe('auth set', () => {
  it('stores a token read from explicit stdin and reports only the safe fields', async () => {
    const setProfile = vi.fn((input: SetProfileInput) =>
      Promise.resolve({
        profile: input.profile,
        origin: input.baseUrl,
        source: input.storage ?? 'keyring',
        allowLoopbackHttp: input.allowLoopbackHttp ?? false,
      }),
    );
    const h = harness({ auth: authDouble({ setProfile }) });
    const input = new PassThrough();
    const c = ctx({ input });

    const pending = run(authSetOp(), h, c);
    input.end(`${TOKEN}\n`);
    const result = await pending;

    expect(asSuccess(result)).toEqual({
      schemaVersion: 1,
      ok: true,
      command: 'auth-set',
      data: { profile: 'work', origin: ORIGIN, source: 'keyring' },
    });
    expect(setProfile).toHaveBeenCalledWith({
      profile: 'work',
      baseUrl: ORIGIN,
      token: TOKEN,
      allowLoopbackHttp: false,
      storage: 'keyring',
    });
    expect(c.prompt).not.toHaveBeenCalled();
    expectNoSecrets(result);
  });

  it('passes the file storage choice and a loopback opt-in through unchanged', async () => {
    const setProfile = vi.fn((input: SetProfileInput) =>
      Promise.resolve({
        profile: input.profile,
        origin: input.baseUrl,
        source: 'file' as const,
        allowLoopbackHttp: true,
      }),
    );
    const h = harness({ auth: authDouble({ setProfile }) });
    const input = new PassThrough();
    const c = ctx({ input });

    const pending = run(
      authSetOp({ origin: LOOPBACK, storage: 'file', allowLoopbackHttp: true }),
      h,
      c,
    );
    input.end(`${TOKEN}\n`);
    const result = asSuccess(await pending);

    expect(setProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: LOOPBACK,
        allowLoopbackHttp: true,
        storage: 'file',
      }),
    );
    expect(result.data).toEqual({ profile: 'work', origin: LOOPBACK, source: 'file' });
  });

  it('refuses an invalid profile before the input is read', async () => {
    const setProfile = vi.fn((_input: SetProfileInput) =>
      Promise.reject(new Error('setProfile must not run')),
    );
    const h = harness({ auth: authDouble({ setProfile }) });
    const input = new PassThrough();
    const c = ctx({ input });

    const failed = asFailure(await run(authSetOp({ profile: 'Work!' }), h, c));

    expect(failed).toMatchObject({ command: 'auth-set', error: { code: 'USAGE' } });
    expect(input.listenerCount('data')).toBe(0);
    expect(setProfile).not.toHaveBeenCalled();
  });

  it.each([
    ['plain http to a remote host', 'http://pto.example.com'],
    ['an origin with a path', 'https://pto.example.com/app'],
    ['an origin with userinfo', 'https://user@pto.example.com'],
    ['an empty origin', ''],
  ])('refuses %s before the input is read', async (_label, origin) => {
    const setProfile = vi.fn((_input: SetProfileInput) =>
      Promise.reject(new Error('setProfile must not run')),
    );
    const h = harness({ auth: authDouble({ setProfile }) });
    const input = new PassThrough();
    const c = ctx({ input });

    const failed = asFailure(await run(authSetOp({ origin }), h, c));

    expect(failed.error.code).toBe('USAGE');
    expect(input.listenerCount('data')).toBe(0);
    expect(setProfile).not.toHaveBeenCalled();
  });

  it('refuses an unknown storage choice before the input is read', async () => {
    const h = harness();
    const input = new PassThrough();
    const c = ctx({ input });

    const failed = asFailure(await run(authSetOp({ storage: 'cloud' as unknown as 'file' }), h, c));

    expect(failed.error.code).toBe('USAGE');
    expect(input.listenerCount('data')).toBe(0);
  });

  it('refuses a non-boolean loopback or stdin flag before the input is read', async () => {
    const h = harness();
    const input = new PassThrough();
    const c = ctx({ input });

    const loopback = asFailure(
      await run(authSetOp({ allowLoopbackHttp: 'yes' as unknown as boolean }), h, c),
    );
    const stdin = asFailure(await run(authSetOp({ tokenStdin: 1 as unknown as boolean }), h, c));

    expect(loopback.error.code).toBe('USAGE');
    expect(stdin.error.code).toBe('USAGE');
    expect(input.listenerCount('data')).toBe(0);
  });

  it('refuses to read a secret when neither stdin nor an interactive terminal is given', async () => {
    const h = harness();
    const input = new PassThrough();
    const c = ctx({ input, interactive: false });

    const failed = asFailure(await run(authSetOp({ tokenStdin: false }), h, c));

    expect(failed.error).toMatchObject({
      code: 'USAGE',
      message: 'Provide the token with --token-stdin, or run in an interactive terminal.',
    });
    expect(input.listenerCount('data')).toBe(0);
    expect(c.prompt).not.toHaveBeenCalled();
  });

  it('refuses a missing newline with the fixed stdin guidance', async () => {
    const h = harness();
    const input = new PassThrough();
    const c = ctx({ input });

    const pending = run(authSetOp(), h, c);
    input.end(TOKEN);
    const failed = asFailure(await pending);

    expect(failed.error).toMatchObject({ code: 'USAGE' });
    expect(failed.error.message).toContain('followed by a newline');
  });

  it('refuses two lines of stdin without echoing any of them', async () => {
    const h = harness();
    const input = new PassThrough();
    const c = ctx({ input });

    const pending = run(authSetOp(), h, c);
    input.end(`${TOKEN}\n${TOKEN}\n`);
    const failed = asFailure(await pending);

    expect(failed.error.code).toBe('USAGE');
    expectNoSecrets(failed);
  });

  it('refuses stdin that is not a token with an authentication category and no echo', async () => {
    const h = harness();
    const input = new PassThrough();
    const c = ctx({ input });

    const pending = run(authSetOp(), h, c);
    input.end('not-a-token\n');
    const failed = asFailure(await pending);

    expect(failed.error).toEqual({
      code: 'AUTH',
      message: 'The secret input is not a valid personal access token.',
      status: null,
      requestId: null,
      retryAfterMs: null,
    });
    expect(JSON.stringify(failed)).not.toContain('not-a-token');
  });

  it('refuses a terminal given to --token-stdin, because it would echo', async () => {
    const h = harness();
    const terminal = new FakeTerminal();
    const c = ctx({ input: terminal, interactive: true });

    const failed = asFailure(await run(authSetOp({ tokenStdin: true }), h, c));

    expect(failed.error.code).toBe('USAGE');
    expect(terminal.rawHistory).toEqual([]);
    expect(c.prompt).not.toHaveBeenCalled();
  });

  it('reads a hidden line from an interactive terminal after the reader is running', async () => {
    let rawWhenPrompted: boolean | undefined;
    const terminal = new FakeTerminal();
    const setProfile = vi.fn((input: SetProfileInput) =>
      Promise.resolve({
        profile: input.profile,
        origin: input.baseUrl,
        source: 'keyring' as const,
        allowLoopbackHttp: false,
      }),
    );
    const h = harness({ auth: authDouble({ setProfile }) });
    const c = ctx({
      input: terminal,
      interactive: true,
      prompt: () => {
        rawWhenPrompted = terminal.isRaw;
      },
    });

    const pending = run(authSetOp({ tokenStdin: false }), h, c);
    terminal.write(`${TOKEN}\r`);
    const result = asSuccess(await pending);

    expect(rawWhenPrompted).toBe(true);
    expect(c.prompt).toHaveBeenCalledTimes(1);
    expect(c.prompt.mock.calls[0]?.[0]).toMatch(/hidden/);
    expect(terminal.rawHistory).toEqual([true, false]);
    expect(terminal.isRaw).toBe(false);
    expect(setProfile).toHaveBeenCalledWith(expect.objectContaining({ token: TOKEN }));
    expect(result.data).toEqual({ profile: 'work', origin: ORIGIN, source: 'keyring' });
    expectNoSecrets(result);
  });

  it('restores the terminal and stores nothing when the label cannot be shown', async () => {
    const terminal = new FakeTerminal();
    const setProfile = vi.fn((_input: SetProfileInput) =>
      Promise.reject(new Error('setProfile must not run')),
    );
    const h = harness({ auth: authDouble({ setProfile }) });
    const c = ctx({
      input: terminal,
      interactive: true,
      prompt: () => {
        throw new Error('stderr is closed');
      },
    });

    const failed = asFailure(await run(authSetOp({ tokenStdin: false }), h, c));

    expect(failed.error).toMatchObject({
      code: 'LOCAL',
      message: 'The secret prompt could not be shown. Nothing was read.',
    });
    expect(terminal.rawHistory).toEqual([true, false]);
    expect(terminal.isRaw).toBe(false);
    expect(setProfile).not.toHaveBeenCalled();
  });

  it('cancels the hidden reader from the caller signal and restores the terminal', async () => {
    const terminal = new FakeTerminal();
    const setProfile = vi.fn((_input: SetProfileInput) =>
      Promise.reject(new Error('setProfile must not run')),
    );
    const h = harness({ auth: authDouble({ setProfile }) });
    const c = ctx({
      input: terminal,
      interactive: true,
      prompt: () => c.controller.abort(),
    });

    const failed = asFailure(await run(authSetOp({ tokenStdin: false }), h, c));

    expect(failed.error.code).toBe('CANCELLED');
    expect(terminal.rawHistory).toEqual([true, false]);
    expect(setProfile).not.toHaveBeenCalled();
  });

  it('does not show a label when entering raw mode fails on a terminal', async () => {
    const terminal = new FakeTerminal();
    vi.spyOn(terminal, 'setRawMode').mockImplementation(() => {
      throw new Error('untrusted terminal error');
    });
    const c = ctx({ input: terminal, interactive: true });
    const store = vi.fn();
    const h = harness({ auth: authDouble({ setProfile: store }) });
    const result = asFailure(await run(authSetOp({ tokenStdin: false }), h, c));
    expect(result.error.code).toBe('USAGE');
    expect(c.prompt).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });

  it('refuses a hidden entry on an input that cannot hide input, before any label', async () => {
    const h = harness();
    const plain = new PassThrough();
    const c = ctx({ input: plain, interactive: true });

    const failed = asFailure(await run(authSetOp({ tokenStdin: false }), h, c));

    expect(failed.error.code).toBe('USAGE');
    expect(failed.error.message).toContain('--token-stdin');
    expect(c.prompt).not.toHaveBeenCalled();
    expect(plain.listenerCount('data')).toBe(0);
  });

  it('refuses a terminal without a raw mode switch, before any label', async () => {
    const h = harness();
    const terminal = new FakeTerminal();
    Object.defineProperty(terminal, 'setRawMode', { value: undefined });
    const c = ctx({ input: terminal, interactive: true });

    const failed = asFailure(await run(authSetOp({ tokenStdin: false }), h, c));

    expect(failed.error.code).toBe('USAGE');
    expect(c.prompt).not.toHaveBeenCalled();
  });

  it('stores nothing when the signal is cancelled before the input is read', async () => {
    const setProfile = vi.fn((_input: SetProfileInput) =>
      Promise.reject(new Error('setProfile must not run')),
    );
    const h = harness({ auth: authDouble({ setProfile }) });
    const input = new PassThrough();
    const c = ctx({ input });
    c.controller.abort();

    const failed = asFailure(await run(authSetOp(), h, c));

    expect(failed.error.code).toBe('CANCELLED');
    expect(input.listenerCount('data')).toBe(0);
    expect(setProfile).not.toHaveBeenCalled();
  });

  it('stores nothing when the caller cancels after the secret was read', async () => {
    const setProfile = vi.fn((_input: SetProfileInput) =>
      Promise.reject(new Error('setProfile must not run')),
    );
    const h = harness({ auth: authDouble({ setProfile }) });
    const input = new PassThrough();
    const c = ctx({ input });

    const pending = run(authSetOp(), h, c);
    // Registered after the reader's own end listener, so it runs once the line is read.
    input.on('end', () => c.controller.abort());
    input.end(`${TOKEN}\n`);
    const failed = asFailure(await pending);

    expect(failed.error.code).toBe('CANCELLED');
    expect(setProfile).not.toHaveBeenCalled();
  });

  it('reports a cancelled stdin read as cancelled', async () => {
    const h = harness();
    const input = new PassThrough();
    const c = ctx({ input });

    const pending = run(authSetOp(), h, c);
    c.controller.abort();
    const failed = asFailure(await pending);

    expect(failed.error.code).toBe('CANCELLED');
  });

  it('reports a profile conflict as a conflict without the local text', async () => {
    const auth = authDouble({
      setProfile: () => Promise.reject(new AgentAuthError('PROFILE_CONFLICT')),
    });
    const h = harness({ auth });
    const input = new PassThrough();
    const c = ctx({ input });

    const pending = run(authSetOp(), h, c);
    input.end(`${TOKEN}\n`);
    const failed = asFailure(await pending);

    expect(failed.error).toMatchObject({
      code: 'CONFLICT',
      message:
        'The local profile is bound to another origin or storage backend. Run pto auth remove before changing it.',
    });
  });

  it('reports an unexpected store failure with the fixed text only', async () => {
    const auth = authDouble({
      setProfile: () => Promise.reject(new Error(`boom ${TOKEN}`)),
    });
    const h = harness({ auth });
    const input = new PassThrough();
    const c = ctx({ input });

    const pending = run(authSetOp(), h, c);
    input.end(`${TOKEN}\n`);
    const failed = asFailure(await pending);

    expect(failed.error.code).toBe('LOCAL');
    expectNoSecrets(failed);
    expect(JSON.stringify(failed)).not.toContain('boom');
  });
});

describe('auth status', () => {
  it('verifies the one resolved binding and reports owner, origin, scopes and expiry only', async () => {
    const resolve = vi.fn((_input: ResolveInput) => Promise.resolve(BUNDLE));
    const getIdentity = vi.fn((_options?: RequestOptions) => Promise.resolve(IDENTITY));
    const h = harness({
      auth: authDouble({ resolve }),
      client: clientDouble({ getIdentity }),
    });
    const c = ctx();

    const result = asSuccess(await run(statusOp(), h, c));

    expect(result).toEqual({
      schemaVersion: 1,
      ok: true,
      command: 'auth-status',
      data: {
        profile: 'default',
        origin: ORIGIN,
        source: 'keyring',
        ownerId: OWNER_ID,
        scopes: ['pto:read'],
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(getIdentity).toHaveBeenCalledTimes(1);
    expect(getIdentity.mock.calls[0]?.[0]?.timeoutMs).toBe(15_000);
    expect(h.clientOptions[0]).toMatchObject({
      baseUrl: ORIGIN,
      credential: { origin: ORIGIN, token: TOKEN },
      allowLoopbackHttp: false,
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN_ID);
    expectNoSecrets(result);
  });

  it('projects only the managed pair from the environment and nothing else', async () => {
    const resolve = vi.fn((_input: ResolveInput) =>
      Promise.resolve({ ...BUNDLE, profile: null, source: 'environment' as const }),
    );
    const h = harness({ auth: authDouble({ resolve }) });
    const c = ctx({
      env: {
        PTO_API_ORIGIN: ORIGIN,
        PTO_API_TOKEN: TOKEN,
        HOME: '/home/someone',
        PATH: '/usr/bin',
      },
    });

    const result = asSuccess(await run(statusOp(), h, c));

    expect(resolve.mock.calls[0]?.[0]).toEqual({
      allowLoopbackHttp: false,
      env: { PTO_API_ORIGIN: ORIGIN, PTO_API_TOKEN: TOKEN },
    });
    expect(result.data).toMatchObject({ profile: null, source: 'environment' });
  });

  it('passes a lone managed origin on so the facade can refuse the partial pair', async () => {
    const resolve = vi.fn((_input: ResolveInput) =>
      Promise.reject(new AgentAuthError('INVALID_OPTIONS')),
    );
    const h = harness({ auth: authDouble({ resolve }) });
    const c = ctx({ env: { PTO_API_ORIGIN: ORIGIN } });

    const failed = asFailure(await run(statusOp(), h, c));

    expect(resolve.mock.calls[0]?.[0]).toEqual({
      allowLoopbackHttp: false,
      env: { PTO_API_ORIGIN: ORIGIN },
    });
    expect(failed.error.code).toBe('AUTH');
  });

  it('passes a lone managed token on so the facade can refuse the partial pair', async () => {
    const resolve = vi.fn((_input: ResolveInput) =>
      Promise.reject(new AgentAuthError('INVALID_OPTIONS')),
    );
    const h = harness({ auth: authDouble({ resolve }) });
    const c = ctx({ env: { PTO_API_TOKEN: TOKEN } });

    await run(statusOp(), h, c);

    expect(resolve.mock.calls[0]?.[0]).toEqual({
      allowLoopbackHttp: false,
      env: { PTO_API_TOKEN: TOKEN },
    });
  });

  it('keeps an empty managed value present, so the facade sees it as supplied', async () => {
    const resolve = vi.fn((_input: ResolveInput) =>
      Promise.reject(new AgentAuthError('INVALID_ORIGIN')),
    );
    const h = harness({ auth: authDouble({ resolve }) });
    const c = ctx({ env: { PTO_API_ORIGIN: '', PTO_API_TOKEN: TOKEN } });

    await run(statusOp(), h, c);

    expect(resolve.mock.calls[0]?.[0]).toEqual({
      allowLoopbackHttp: false,
      env: { PTO_API_ORIGIN: '', PTO_API_TOKEN: TOKEN },
    });
  });

  it('does not send an environment record when neither managed field is present', async () => {
    const resolve = vi.fn((_input: ResolveInput) => Promise.resolve(BUNDLE));
    const h = harness({ auth: authDouble({ resolve }) });
    const c = ctx({ env: { PATH: '/usr/bin' } });

    await run(statusOp({ profile: 'work' }), h, c);

    const input = resolve.mock.calls[0]?.[0];
    expect(input).toEqual({ profile: 'work', allowLoopbackHttp: false });
    expect(input && 'env' in input).toBe(false);
  });

  it('passes the named profile, the expected origin and the loopback opt-in to the facade', async () => {
    const resolve = vi.fn((_input: ResolveInput) =>
      Promise.resolve({ ...BUNDLE, baseUrl: LOOPBACK, allowLoopbackHttp: true }),
    );
    const h = harness({ auth: authDouble({ resolve }) });
    const c = ctx();

    await run(statusOp({ profile: 'work', origin: LOOPBACK, allowLoopbackHttp: true }), h, c);

    expect(resolve.mock.calls[0]?.[0]).toEqual({
      profile: 'work',
      baseUrl: LOOPBACK,
      allowLoopbackHttp: true,
    });
    // The client is bound to the binding the facade resolved, not to the expected origin.
    expect(h.clientOptions[0]).toMatchObject({ baseUrl: LOOPBACK, allowLoopbackHttp: true });
  });

  it('refuses an invalid profile or expected origin before any store is opened', async () => {
    const resolve = vi.fn((_input: ResolveInput) => Promise.resolve(BUNDLE));
    const h = harness({ auth: authDouble({ resolve }) });
    const c = ctx();

    const badProfile = asFailure(await run(statusOp({ profile: 'BAD' }), h, c));
    const badOrigin = asFailure(await run(statusOp({ origin: 'http://example.com' }), h, c));

    expect(badProfile.error.code).toBe('USAGE');
    expect(badOrigin.error.code).toBe('USAGE');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('reports a missing profile as an authentication failure with setup guidance', async () => {
    const auth = authDouble({
      resolve: () => Promise.reject(new AgentAuthError('PROFILE_NOT_CONFIGURED')),
    });
    const h = harness({ auth });
    const c = ctx();

    const failed = asFailure(await run(statusOp(), h, c));

    expect(failed.error).toMatchObject({
      code: 'AUTH',
      message: 'No local credential is configured for this profile. Run pto auth set to store one.',
      status: null,
    });
  });

  it('reports a rejected credential with replacement guidance and the safe correlation', async () => {
    const client = clientDouble({
      getIdentity: () =>
        Promise.reject(new PtoApiError('UNAUTHENTICATED', { status: 401, requestId: REQUEST_ID })),
    });
    const h = harness({ client });
    const c = ctx();

    const failed = asFailure(await run(statusOp(), h, c));

    expect(failed.error).toEqual({
      code: 'AUTH',
      message:
        'The service did not accept this credential. It may be revoked or expired. Replace or revoke it in the signed-in browser UI, then run pto auth set again.',
      status: 401,
      requestId: REQUEST_ID,
      retryAfterMs: null,
    });
  });

  it('drops a correlation id that carries the credential digest', async () => {
    const client = clientDouble({
      getIdentity: () =>
        Promise.reject(
          new PtoApiError('UNAUTHENTICATED', { status: 401, requestId: `req-${DIGEST}` }),
        ),
    });
    const h = harness({ client });
    const c = ctx();

    const failed = asFailure(await run(statusOp(), h, c));

    expect(failed.error.requestId).toBeNull();
    expectNoSecrets(failed);
  });

  it('drops a correlation id that is not a safe identifier', async () => {
    const client = clientDouble({
      getIdentity: () =>
        Promise.reject(
          new PtoApiError('NOT_READY', { status: 503, requestId: 'bad id with spaces' }),
        ),
    });
    const h = harness({ client });

    const failed = asFailure(await run(statusOp(), h, ctx()));

    expect(failed.error).toMatchObject({ code: 'NETWORK', status: 503, requestId: null });
  });

  it('keeps a plain safe correlation id and the Retry-After wait', async () => {
    const client = clientDouble({
      getIdentity: () =>
        Promise.reject(
          new PtoApiError('RATE_LIMITED', {
            status: 429,
            requestId: REQUEST_ID,
            retryAfterMs: 2_000,
          }),
        ),
    });
    const h = harness({ client });

    const failed = asFailure(await run(statusOp(), h, ctx()));

    expect(failed.error).toEqual({
      code: 'QUOTA',
      message:
        'The service is rate limiting this credential. Wait for the Retry-After period, then try again.',
      status: 429,
      requestId: REQUEST_ID,
      retryAfterMs: 2_000,
    });
  });

  it('reports a cancelled verification as cancelled', async () => {
    const client = clientDouble({
      getIdentity: () => Promise.reject(new PtoApiError('ABORTED')),
    });
    const h = harness({ client });

    const failed = asFailure(await run(statusOp(), h, ctx()));

    expect(failed.error.code).toBe('CANCELLED');
  });

  it('reports cancelled when the caller aborts after the identity answer', async () => {
    const c = ctx();
    const client = clientDouble({
      getIdentity: () => {
        c.controller.abort();
        return Promise.resolve(IDENTITY);
      },
    });
    const h = harness({ client });

    const failed = asFailure(await run(statusOp(), h, c));

    expect(failed.error.code).toBe('CANCELLED');
    expect(failed.command).toBe('auth-status');
  });

  it('stops before the store is opened when the signal is already cancelled', async () => {
    const resolve = vi.fn((_input: ResolveInput) => Promise.resolve(BUNDLE));
    const h = harness({ auth: authDouble({ resolve }) });
    const c = ctx();
    c.controller.abort();

    const failed = asFailure(await run(statusOp(), h, c));

    expect(failed.error.code).toBe('CANCELLED');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('turns a cancellation during a store failure into cancelled, never another category', async () => {
    const c = ctx();
    const auth = authDouble({
      resolve: () => {
        c.controller.abort();
        return Promise.reject(new AgentAuthError('KEYRING_LOCKED'));
      },
    });
    const h = harness({ auth });

    const failed = asFailure(await run(statusOp(), h, c));

    expect(failed.error.code).toBe('CANCELLED');
  });
});

describe('auth remove', () => {
  it('removes the local profile and reports the guidance without revoking anything', async () => {
    const removeProfile = vi.fn((profile: string): Promise<RemoveProfileResult> =>
      Promise.resolve({
        profile,
        source: 'keyring',
        removed: true,
        guidance: 'the store guidance',
      }),
    );
    const h = harness({ auth: authDouble({ removeProfile }) });
    const c = ctx();

    const result = asSuccess(await run(removeOp('work'), h, c));

    expect(result).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: 'auth-remove',
      data: { profile: 'work', source: 'keyring', removed: true },
    });
    const data = result.data as { readonly guidance: string };
    expect(data.guidance).toContain(GUIDANCE_FRAGMENT);
    expect(data.guidance).not.toContain('the store guidance');
    expect(removeProfile).toHaveBeenCalledWith('work');
    expect(h.clientOptions).toEqual([]);
  });

  it('never reports a removal that the store did not confirm', async () => {
    const auth = authDouble({
      removeProfile: (profile: string) =>
        Promise.resolve({ profile, source: 'file', removed: false, guidance: 'unused' }),
    });
    const h = harness({ auth });

    const failed = asFailure(await run(removeOp(), h, ctx()));

    expect(failed.error).toMatchObject({
      code: 'LOCAL',
      message:
        'The local removal could not be confirmed. Check the local profile before retrying; removal never revokes the token on the server.',
    });
  });

  it('reports a profile that is not configured as not found', async () => {
    const auth = authDouble({
      removeProfile: () => Promise.reject(new AgentAuthError('PROFILE_NOT_CONFIGURED')),
    });

    const failed = asFailure(await run(removeOp(), harness({ auth }), ctx()));

    expect(failed.error).toMatchObject({
      code: 'NOT_FOUND',
      message: 'No local profile with this name exists.',
    });
  });

  it('keeps the category of any other local store failure', async () => {
    const auth = authDouble({
      removeProfile: () => Promise.reject(new AgentAuthError('PROFILE_CORRUPT')),
    });

    const failed = asFailure(await run(removeOp(), harness({ auth }), ctx()));

    expect(failed.error.code).toBe('LOCAL');
  });

  it('reports an unclassified removal failure with the fixed text only', async () => {
    const auth = authDouble({
      removeProfile: () => Promise.reject(new TypeError(`${TOKEN} unexpected`)),
    });

    const failed = asFailure(await run(removeOp(), harness({ auth }), ctx()));

    expect(failed.error.code).toBe('LOCAL');
    expectNoSecrets(failed);
  });

  it('refuses an invalid profile before the store is opened', async () => {
    const removeProfile = vi.fn((profile: string) =>
      Promise.resolve({ profile, source: 'keyring' as const, removed: true, guidance: '' }),
    );
    const h = harness({ auth: authDouble({ removeProfile }) });

    const failed = asFailure(await run(removeOp('Not Valid'), h, ctx()));

    expect(failed.error.code).toBe('USAGE');
    expect(removeProfile).not.toHaveBeenCalled();
  });

  it('removes nothing when cancelled before the store is opened', async () => {
    const removeProfile = vi.fn((profile: string) =>
      Promise.resolve({ profile, source: 'keyring' as const, removed: true, guidance: '' }),
    );
    const h = harness({ auth: authDouble({ removeProfile }) });
    const c = ctx();
    c.controller.abort();

    const failed = asFailure(await run(removeOp(), h, c));

    expect(failed.error.code).toBe('CANCELLED');
    expect(removeProfile).not.toHaveBeenCalled();
  });
});

/** The traversal arguments of one list call, read back from the double. */
function listCall(listAll: ReturnType<typeof vi.fn>): {
  readonly query: ListAllQuery;
  readonly options: ListAllOptions;
} {
  const args = listAll.mock.calls[0] as [ListAllQuery, ListAllOptions];
  return { query: args[0], options: args[1] };
}

describe('list validation', () => {
  it.each([
    ['a slash-separated start', { from: '2026/12/01' }],
    ['a start that is not a real day', { from: '2026-02-30' }],
    ['a start with an invalid month', { from: '2026-13-01' }],
    ['a non-string end', { to: 20261231 }],
    ['an end before the start', { from: '2026-12-31', to: '2026-12-01' }],
    ['a range of 367 days', { from: '2026-01-01', to: '2027-01-02' }],
  ])('refuses %s before any store is opened', async (_label, overrides) => {
    const resolve = vi.fn((_input: ResolveInput) => Promise.resolve(BUNDLE));
    const h = harness({ auth: authDouble({ resolve }) });

    const failed = asFailure(
      await run(listOp(overrides as Partial<Extract<Operation, { kind: 'list' }>>), h, ctx()),
    );

    expect(failed.command).toBe('list');
    expect(failed.error.code).toBe('USAGE');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('accepts a range of exactly 366 days', async () => {
    const listAll = vi.fn((_query: ListAllQuery, _options?: ListAllOptions) =>
      Promise.resolve(traversal()),
    );
    const h = harness({ client: clientDouble({ listAll }) });

    const result = asSuccess(await run(listOp({ from: '2026-01-01', to: '2027-01-01' }), h, ctx()));

    expect(result.data).toMatchObject({ complete: true, reason: 'complete' });
    expect(listCall(listAll).query).toMatchObject({ start: '2026-01-01', end: '2027-01-01' });
  });

  it('accepts a leap day and refuses a day that does not exist in that year', async () => {
    const h = harness();

    const leap = asSuccess(await run(listOp({ from: '2028-02-29', to: '2028-02-29' }), h, ctx()));
    const missing = asFailure(
      await run(listOp({ from: '2026-02-29', to: '2026-02-29' }), h, ctx()),
    );

    expect(leap.data).toMatchObject({ complete: true });
    expect(missing.error.code).toBe('USAGE');
  });

  it('refuses --mine together with --owner', async () => {
    const h = harness();

    const failed = asFailure(await run(listOp({ mine: true, ownerId: OTHER_OWNER_ID }), h, ctx()));

    expect(failed.error).toMatchObject({
      code: 'USAGE',
      message: 'Choose either --mine or --owner, not both.',
    });
  });

  it.each([
    ['a malformed owner', { ownerId: 'not-a-uuid' }],
    ['a non-string owner', { ownerId: 7 }],
    ['a page size of zero', { pageSize: 0 }],
    ['a page size above the maximum', { pageSize: 201 }],
    ['a fractional page size', { pageSize: 1.5 }],
    ['a text page size', { pageSize: '10' }],
    ['a page budget of zero', { maxPages: 0 }],
    ['a page budget above the maximum', { maxPages: 31 }],
    ['a non-boolean mine flag', { mine: 'yes' }],
    ['a non-boolean loopback flag', { auth: { allowLoopbackHttp: 'no' } }],
    ['an invalid profile', { auth: { allowLoopbackHttp: false, profile: 'Bad Name' } }],
    ['an invalid expected origin', { auth: { allowLoopbackHttp: false, origin: 'ftp://x' } }],
  ])('refuses %s before any store is opened', async (_label, overrides) => {
    const resolve = vi.fn((_input: ResolveInput) => Promise.resolve(BUNDLE));
    const h = harness({ auth: authDouble({ resolve }) });

    const failed = asFailure(
      await run(listOp(overrides as Partial<Extract<Operation, { kind: 'list' }>>), h, ctx()),
    );

    expect(failed.error.code).toBe('USAGE');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses a cancelled list before the store is opened', async () => {
    const resolve = vi.fn((_input: ResolveInput) => Promise.resolve(BUNDLE));
    const h = harness({ auth: authDouble({ resolve }) });
    const c = ctx();
    c.controller.abort();

    const failed = asFailure(await run(listOp(), h, c));

    expect(failed.error.code).toBe('CANCELLED');
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('list traversal', () => {
  it('lists the calendar of the verified caller with --mine and the shared bounds', async () => {
    const getIdentity = vi.fn((_options?: RequestOptions) => Promise.resolve(IDENTITY));
    const listAll = vi.fn((_query: ListAllQuery, _options?: ListAllOptions) =>
      Promise.resolve(traversal({ items: [item()] })),
    );
    const h = harness({ client: clientDouble({ getIdentity, listAll }) });
    const c = ctx();

    const result = asSuccess(await run(listOp({ mine: true, pageSize: 50, maxPages: 4 }), h, c));

    expect(getIdentity).toHaveBeenCalledTimes(1);
    const { query, options } = listCall(listAll);
    expect(query).toEqual({
      start: '2026-12-01',
      end: '2026-12-31',
      userId: OWNER_ID,
      limit: 50,
    });
    expect(options).toMatchObject({ timeoutMs: 30_000, maxPages: 4, maxRecords: 5_000 });
    expect(options.signal).toBe(c.controller.signal);
    expect(result.data).toEqual({
      items: [item()],
      complete: true,
      reason: 'complete',
      pages: 1,
    });
  });

  it('lists the calendar of one owner without any identity call', async () => {
    const getIdentity = vi.fn((_options?: RequestOptions) => Promise.resolve(IDENTITY));
    const listAll = vi.fn((_query: ListAllQuery, _options?: ListAllOptions) =>
      Promise.resolve(traversal()),
    );
    const h = harness({ client: clientDouble({ getIdentity, listAll }) });

    const result = asSuccess(await run(listOp({ ownerId: OTHER_OWNER_ID }), h, ctx()));

    expect(getIdentity).not.toHaveBeenCalled();
    expect(listCall(listAll).query).toMatchObject({ userId: OTHER_OWNER_ID });
    expect(result.data).toMatchObject({ items: [], complete: true });
  });

  it('lists every owner the credential may see when no owner is named', async () => {
    const listAll = vi.fn((_query: ListAllQuery, _options?: ListAllOptions) =>
      Promise.resolve(traversal()),
    );
    const h = harness({ client: clientDouble({ listAll }) });

    asSuccess(await run(listOp(), h, ctx()));

    expect(listCall(listAll).query).toEqual({
      start: '2026-12-01',
      end: '2026-12-31',
      limit: 100,
    });
  });

  it('spends the one budget on the identity call before the traversal', async () => {
    const clock = makeClock();
    const listAll = vi.fn((_query: ListAllQuery, _options?: ListAllOptions) =>
      Promise.resolve(traversal()),
    );
    const getIdentity = vi.fn((_options?: RequestOptions) => {
      clock.advance(5_000);
      return Promise.resolve(IDENTITY);
    });
    const h = harness({ clock, client: clientDouble({ getIdentity, listAll }) });

    asSuccess(await run(listOp({ mine: true }), h, ctx()));

    expect(getIdentity.mock.calls[0]?.[0]?.timeoutMs).toBe(30_000);
    expect(listCall(listAll).options.timeoutMs).toBe(25_000);
  });

  it('rounds a sub-millisecond remainder up and never passes zero', async () => {
    const clock = makeClock();
    const listAll = vi.fn((_query: ListAllQuery, _options?: ListAllOptions) =>
      Promise.resolve(traversal()),
    );
    const getIdentity = vi.fn((_options?: RequestOptions) => {
      clock.advance(29_999.4);
      return Promise.resolve(IDENTITY);
    });
    const h = harness({ clock, client: clientDouble({ getIdentity, listAll }) });

    asSuccess(await run(listOp({ mine: true }), h, ctx()));

    expect(listCall(listAll).options.timeoutMs).toBe(1);
  });

  it('reports a timeout without a traversal when the identity call used the whole budget', async () => {
    const clock = makeClock();
    const listAll = vi.fn((_query: ListAllQuery, _options?: ListAllOptions) =>
      Promise.resolve(traversal()),
    );
    const getIdentity = vi.fn((_options?: RequestOptions) => {
      clock.advance(30_000);
      return Promise.resolve(IDENTITY);
    });
    const h = harness({ clock, client: clientDouble({ getIdentity, listAll }) });

    const failed = asFailure(await run(listOp({ mine: true }), h, ctx()));

    expect(listAll).not.toHaveBeenCalled();
    expect(failed).toEqual({
      schemaVersion: 1,
      ok: false,
      command: 'list',
      error: {
        code: 'NETWORK',
        message: 'The service did not answer within the time limit.',
        status: null,
        requestId: null,
        retryAfterMs: null,
      },
    });
  });

  it('keeps the explicit page and record bounds the traversal was given', async () => {
    const listAll = vi.fn((_query: ListAllQuery, _options?: ListAllOptions) =>
      Promise.resolve(traversal()),
    );
    const h = harness({ client: clientDouble({ listAll }) });

    asSuccess(await run(listOp({ pageSize: 200, maxPages: 1 }), h, ctx()));

    expect(listCall(listAll).query.limit).toBe(200);
    expect(listCall(listAll).options).toMatchObject({ maxPages: 1, maxRecords: 5_000 });
  });

  it('reports an empty complete traversal as a success with no rows', async () => {
    const h = harness();

    const result = asSuccess(await run(listOp(), h, ctx()));

    expect(result.data).toEqual({ items: [], complete: true, reason: 'complete', pages: 1 });
  });

  it('projects each row to the allowlisted fields and scrubs the owner name', async () => {
    const listAll = vi.fn((_query: ListAllQuery, _options?: ListAllOptions) =>
      Promise.resolve(
        traversal({
          items: [
            item({
              user: { id: OWNER_ID, name: 'Ada\u202E lovelace', colorCode: '#3366ff\u0007' },
            }),
          ],
        }),
      ),
    );
    const h = harness({ client: clientDouble({ listAll }) });

    const result = asSuccess(await run(listOp(), h, ctx()));

    expect(result.data).toEqual({
      items: [
        {
          id: ENTRY_ID,
          user: { id: OWNER_ID, name: 'Ada lovelace', colorCode: '#3366ff' },
          startDate: '2026-12-01',
          endDate: '2026-12-02',
          dayPart: 'all_day',
          note: null,
          version: 1,
        },
      ],
      complete: true,
      reason: 'complete',
      pages: 1,
    });
  });

  it('removes a control byte, a bidi override and a separator from displayed names', async () => {
    const names = [
      'Ann\u0000Lee',
      'Bob\u0007\u001b[31m',
      'Zed\u2028Yo',
      'Ivy\uD800',
      'Kim \t \t Park',
      'Jose\u0301',
    ];
    const listAll = vi.fn((_query: ListAllQuery, _options?: ListAllOptions) =>
      Promise.resolve(
        traversal({
          items: names.map((name, index) =>
            item({
              id: `00000000-0000-4000-8000-00000000000${index}`,
              user: { id: OWNER_ID, name, colorCode: '#000000' },
            }),
          ),
        }),
      ),
    );
    const h = harness({ client: clientDouble({ listAll }) });

    const result = asSuccess(await run(listOp(), h, ctx()));
    const shown = rowsOf(result).map((row) => row.user.name);

    expect(shown).toEqual(['AnnLee', 'Bob[31m', 'ZedYo', 'Ivy', 'Kim Park', 'José']);
    // The check reads the strings themselves: JSON escapes control bytes, which would hide them.
    for (const name of shown) expect(name).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u);
  });

  it('redacts an echoed credential, its secret and digest, and any token-shaped text', async () => {
    const splitToken = `${TOKEN.slice(0, 12)}\u200B${TOKEN.slice(12)}`;
    const names = [
      `Eve ${TOKEN}`,
      `Dan ${DIGEST}`,
      `Fay ${OTHER_TOKEN}`,
      `Gil ${splitToken}`,
      `Hal ${TOKEN.toUpperCase()}`,
      `Ian ${SECRET}`,
      'Jo pto_pat_',
    ];
    const listAll = vi.fn((_query: ListAllQuery, _options?: ListAllOptions) =>
      Promise.resolve(
        traversal({
          items: names.map((name, index) =>
            item({
              id: `00000000-0000-4000-8000-00000000001${index}`,
              user: { id: OWNER_ID, name, colorCode: `#00000${index}` },
            }),
          ),
        }),
      ),
    );
    const h = harness({ client: clientDouble({ listAll }) });

    const result = asSuccess(await run(listOp(), h, ctx()));
    const shown = rowsOf(result).map((row) => row.user.name);

    expect(shown).toEqual([
      'Eve [redacted]',
      'Dan [redacted]',
      'Fay [redacted]',
      'Gil [redacted]',
      'Hal [redacted]',
      'Ian [redacted]',
      'Jo [redacted]',
    ]);
    expectNoSecrets(result);
  });

  it('redacts a long run of hexadecimal digits, whatever its origin', async () => {
    const listAll = vi.fn((_query: ListAllQuery, _options?: ListAllOptions) =>
      Promise.resolve(
        traversal({
          items: [item({ user: { id: OWNER_ID, name: 'f'.repeat(80), colorCode: '#fff' } })],
        }),
      ),
    );
    const h = harness({ client: clientDouble({ listAll }) });

    const result = asSuccess(await run(listOp(), h, ctx()));

    expect(rowsOf(result)[0]?.user.name).toBe('[redacted]');
  });

  it('reports a budget stop with rows as incomplete with the reason and page count', async () => {
    const listAll = vi.fn((_query: ListAllQuery, _options?: ListAllOptions) =>
      Promise.resolve(traversal({ items: [item()], complete: false, reason: 'budget', pages: 3 })),
    );
    const h = harness({ client: clientDouble({ listAll }) });

    const failed = asFailure(await run(listOp(), h, ctx()));

    expect(failed).toEqual({
      schemaVersion: 1,
      ok: false,
      command: 'list',
      error: {
        code: 'INCOMPLETE',
        message:
          'The calendar read is incomplete. Rows already read are included as partial data; missing rows are not confirmed absent.',
        status: null,
        requestId: null,
        retryAfterMs: null,
      },
      partial: {
        items: [item()],
        complete: false,
        reason: 'budget',
        pages: 3,
      },
    });
  });

  it('keeps the category of a usable failure when no rows were read', async () => {
    const listAll = vi.fn((_query: ListAllQuery, _options?: ListAllOptions) =>
      Promise.resolve(
        traversal({
          items: [],
          complete: false,
          reason: 'error',
          pages: 0,
          error: new PtoApiError('RATE_LIMITED', {
            status: 429,
            requestId: REQUEST_ID,
            retryAfterMs: 4_000,
          }),
        }),
      ),
    );
    const h = harness({ client: clientDouble({ listAll }) });

    const failed = asFailure(await run(listOp(), h, ctx()));

    expect(failed).toEqual({
      schemaVersion: 1,
      ok: false,
      command: 'list',
      error: {
        code: 'QUOTA',
        message:
          'The service is rate limiting this credential. Wait for the Retry-After period, then try again.',
        status: 429,
        requestId: REQUEST_ID,
        retryAfterMs: 4_000,
      },
      partial: { items: [], complete: false, reason: 'error', pages: 0 },
    });
  });

  it('keeps the authentication category of a rejected credential when no rows were read', async () => {
    const listAll = vi.fn((_query: ListAllQuery, _options?: ListAllOptions) =>
      Promise.resolve(
        traversal({
          items: [],
          complete: false,
          reason: 'error',
          pages: 0,
          error: new PtoApiError('UNAUTHENTICATED', { status: 401 }),
        }),
      ),
    );
    const h = harness({ client: clientDouble({ listAll }) });

    const failed = asFailure(await run(listOp(), h, ctx()));

    expect(failed.error).toMatchObject({ code: 'AUTH', status: 401 });
    expect(failed.partial).toEqual({ items: [], complete: false, reason: 'error', pages: 0 });
  });

  it('reports an incomplete read with rows as INCOMPLETE and keeps the failing page correlation', async () => {
    const listAll = vi.fn((_query: ListAllQuery, _options?: ListAllOptions) =>
      Promise.resolve(
        traversal({
          items: [item()],
          complete: false,
          reason: 'error',
          pages: 1,
          error: new PtoApiError('RATE_LIMITED', { status: 429, retryAfterMs: 9_000 }),
        }),
      ),
    );
    const h = harness({ client: clientDouble({ listAll }) });

    const failed = asFailure(await run(listOp(), h, ctx()));

    expect(failed.error).toMatchObject({ code: 'INCOMPLETE', status: 429, retryAfterMs: 9_000 });
    expect(failed.partial?.items).toEqual([item()]);
  });

  it('reports a timeout with no rows as a network failure', async () => {
    const listAll = vi.fn((_query: ListAllQuery, _options?: ListAllOptions) =>
      Promise.resolve(
        traversal({
          items: [],
          complete: false,
          reason: 'deadline',
          pages: 0,
          error: new PtoApiError('TIMEOUT'),
        }),
      ),
    );
    const h = harness({ client: clientDouble({ listAll }) });

    const failed = asFailure(await run(listOp(), h, ctx()));

    expect(failed.error.code).toBe('NETWORK');
  });

  it('reports an unsafe service answer with no rows as a network failure', async () => {
    const listAll = vi.fn((_query: ListAllQuery, _options?: ListAllOptions) =>
      Promise.resolve(
        traversal({
          items: [],
          complete: false,
          reason: 'invalid-response',
          pages: 1,
          error: new PtoApiError('INVALID_RESPONSE', { status: 200 }),
        }),
      ),
    );
    const h = harness({ client: clientDouble({ listAll }) });

    const failed = asFailure(await run(listOp(), h, ctx()));

    expect(failed.error).toMatchObject({ code: 'NETWORK', status: 200 });
  });

  it('keeps the local category of an unknown traversal failure', async () => {
    const listAll = vi.fn((_query: ListAllQuery, _options?: ListAllOptions) =>
      Promise.resolve(
        traversal({
          items: [],
          complete: false,
          reason: 'error',
          pages: 0,
          error: new PtoApiError('SOMETHING_NEW'),
        }),
      ),
    );
    const h = harness({ client: clientDouble({ listAll }) });

    const failed = asFailure(await run(listOp(), h, ctx()));

    expect(failed.error.code).toBe('LOCAL');
  });

  it('reports a drift stop with no rows as incomplete, never as a service failure', async () => {
    const listAll = vi.fn((_query: ListAllQuery, _options?: ListAllOptions) =>
      Promise.resolve(
        traversal({
          items: [],
          complete: false,
          reason: 'drift',
          pages: 2,
          error: new PtoApiError('INVALID_RESPONSE'),
        }),
      ),
    );
    const h = harness({ client: clientDouble({ listAll }) });

    const failed = asFailure(await run(listOp(), h, ctx()));

    expect(failed).toMatchObject({
      error: { code: 'INCOMPLETE', status: null, requestId: null, retryAfterMs: null },
      partial: { items: [], complete: false, reason: 'drift', pages: 2 },
    });
  });

  it('reports a budget stop with no rows as incomplete', async () => {
    const listAll = vi.fn((_query: ListAllQuery, _options?: ListAllOptions) =>
      Promise.resolve(traversal({ items: [], complete: false, reason: 'budget', pages: 30 })),
    );
    const h = harness({ client: clientDouble({ listAll }) });

    const failed = asFailure(await run(listOp(), h, ctx()));

    expect(failed.error.code).toBe('INCOMPLETE');
    expect(failed.partial).toEqual({ items: [], complete: false, reason: 'budget', pages: 30 });
  });

  it('reports a drift stop with rows as incomplete without any correlation', async () => {
    const listAll = vi.fn((_query: ListAllQuery, _options?: ListAllOptions) =>
      Promise.resolve(
        traversal({
          items: [item()],
          complete: false,
          reason: 'drift',
          pages: 2,
          error: new PtoApiError('INVALID_RESPONSE'),
        }),
      ),
    );
    const h = harness({ client: clientDouble({ listAll }) });

    const failed = asFailure(await run(listOp(), h, ctx()));

    expect(failed.error).toMatchObject({ code: 'INCOMPLETE', status: null });
    expect(failed.partial?.items).toHaveLength(1);
  });

  it('reports an aborted traversal as cancelled and keeps the rows it read', async () => {
    const listAll = vi.fn((_query: ListAllQuery, _options?: ListAllOptions) =>
      Promise.resolve(
        traversal({
          items: [item()],
          complete: false,
          reason: 'aborted',
          pages: 1,
          error: new PtoApiError('ABORTED'),
        }),
      ),
    );
    const h = harness({ client: clientDouble({ listAll }) });

    const failed = asFailure(await run(listOp(), h, ctx()));

    expect(failed.error.code).toBe('CANCELLED');
    expect(failed.partial).toMatchObject({ complete: false, reason: 'aborted', pages: 1 });
  });

  it('lets a cancelled caller beat a complete-looking traversal, which is then incomplete', async () => {
    const c = ctx();
    const listAll = vi.fn((_query: ListAllQuery, _options?: ListAllOptions) => {
      c.controller.abort();
      return Promise.resolve(traversal({ items: [item()] }));
    });
    const h = harness({ client: clientDouble({ listAll }) });

    const failed = asFailure(await run(listOp(), h, c));

    expect(failed.error.code).toBe('CANCELLED');
    expect(failed.partial).toEqual({
      items: [item()],
      complete: false,
      reason: 'aborted',
      pages: 1,
    });
  });

  it('reports a cancelled identity call as cancelled with no traversal', async () => {
    const getIdentity = vi.fn((_options?: RequestOptions) =>
      Promise.reject(new PtoApiError('ABORTED')),
    );
    const listAll = vi.fn((_query: ListAllQuery, _options?: ListAllOptions) =>
      Promise.resolve(traversal()),
    );
    const h = harness({ client: clientDouble({ getIdentity, listAll }) });

    const failed = asFailure(await run(listOp({ mine: true }), h, ctx()));

    expect(failed.error.code).toBe('CANCELLED');
    expect(failed.partial).toBeUndefined();
    expect(listAll).not.toHaveBeenCalled();
  });

  it('reports a rejected identity call with no partial data', async () => {
    const getIdentity = vi.fn((_options?: RequestOptions) =>
      Promise.reject(new PtoApiError('FORBIDDEN', { status: 403, requestId: REQUEST_ID })),
    );
    const h = harness({ client: clientDouble({ getIdentity }) });

    const failed = asFailure(await run(listOp({ mine: true }), h, ctx()));

    expect(failed).toEqual({
      schemaVersion: 1,
      ok: false,
      command: 'list',
      error: {
        code: 'PERMISSION',
        message:
          'This credential lacks the scope this command needs. Ask for a token with the required read scope in the signed-in browser UI.',
        status: 403,
        requestId: REQUEST_ID,
        retryAfterMs: null,
      },
    });
  });

  it('reports an exhausted budget before the traversal starts as a timeout', async () => {
    const clock = makeClock();
    const listAll = vi.fn((_query: ListAllQuery, _options?: ListAllOptions) =>
      Promise.resolve(traversal()),
    );
    const getIdentity = vi.fn((_options?: RequestOptions) => {
      clock.advance(30_001);
      return Promise.resolve(IDENTITY);
    });
    const h = harness({ clock, client: clientDouble({ getIdentity, listAll }) });

    const failed = asFailure(await run(listOp({ mine: true }), h, ctx()));

    expect(failed.error.code).toBe('NETWORK');
    expect(listAll).not.toHaveBeenCalled();
  });

  it('keeps the rows of a traversal even when its own error carries no category', async () => {
    const listAll = vi.fn((_query: ListAllQuery, _options?: ListAllOptions) =>
      Promise.resolve(
        traversal({
          items: [item()],
          complete: false,
          reason: 'deadline',
          pages: 1,
        }),
      ),
    );
    const h = harness({ client: clientDouble({ listAll }) });

    const failed = asFailure(await run(listOp(), h, ctx()));

    expect(failed.error.code).toBe('INCOMPLETE');
    expect(failed.partial?.reason).toBe('deadline');
  });
});

describe('get', () => {
  it('reads one detail with the read deadline and reports only the returned note, scrubbed', async () => {
    const getDetail = vi.fn((_id: string, _options?: RequestOptions) =>
      Promise.resolve(detail({ note: `Dentist\u202E ${OTHER_TOKEN}` })),
    );
    const h = harness({ client: clientDouble({ getDetail }) });
    const c = ctx();

    const result = asSuccess(await run(getOp(), h, c));

    expect(getDetail.mock.calls[0]?.[0]).toBe(ENTRY_ID);
    expect(getDetail.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 15_000 });
    expect(getDetail.mock.calls[0]?.[1]?.signal).toBe(c.controller.signal);
    expect(result).toEqual({
      schemaVersion: 1,
      ok: true,
      command: 'get',
      data: {
        id: ENTRY_ID,
        user: { id: OWNER_ID, name: 'Ada Lovelace', colorCode: '#3366ff' },
        startDate: '2026-12-01',
        endDate: '2026-12-01',
        dayPart: 'morning',
        note: 'Dentist [redacted]',
        version: 2,
      },
    });
    expectNoSecrets(result);
  });

  it('reports no note when the service returned none, never a fabricated one', async () => {
    const h = harness();

    const result = asSuccess(await run(getOp(), h, ctx()));

    expect(result.data).toMatchObject({ note: null });
  });

  it('keeps an empty note as the one the service returned', async () => {
    const h = harness({
      client: clientDouble({ getDetail: () => Promise.resolve(detail({ note: '' })) }),
    });

    const result = asSuccess(await run(getOp(), h, ctx()));

    expect(result.data).toMatchObject({ note: '' });
  });

  it('refuses a malformed identifier or expected origin before any store is opened', async () => {
    const resolve = vi.fn((_input: ResolveInput) => Promise.resolve(BUNDLE));
    const h = harness({ auth: authDouble({ resolve }) });

    const badId = asFailure(await run(getOp('not-a-uuid'), h, ctx()));
    const badOrigin = asFailure(
      await run(getOp(ENTRY_ID, { origin: 'http://example.com' }), h, ctx()),
    );

    expect(badId.error.code).toBe('USAGE');
    expect(badOrigin.error.code).toBe('USAGE');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('reports a missing entry as not found without any detail', async () => {
    const h = harness({
      client: clientDouble({
        getDetail: () => Promise.reject(new PtoApiError('NOT_FOUND', { status: 404 })),
      }),
    });

    const failed = asFailure(await run(getOp(), h, ctx()));

    expect(failed.error).toMatchObject({
      code: 'NOT_FOUND',
      message: 'No PTO entry matches this identifier, or this credential cannot see it.',
      status: 404,
    });
  });

  it('reports cancelled when the caller aborts after the detail answer', async () => {
    const c = ctx();
    const h = harness({
      client: clientDouble({
        getDetail: () => {
          c.controller.abort();
          return Promise.resolve(detail());
        },
      }),
    });

    const failed = asFailure(await run(getOp(), h, c));

    expect(failed.error.code).toBe('CANCELLED');
  });

  it('refuses to start when the caller has already cancelled', async () => {
    const resolve = vi.fn((_input: ResolveInput) => Promise.resolve(BUNDLE));
    const h = harness({ auth: authDouble({ resolve }) });
    const c = ctx();
    c.controller.abort();

    const failed = asFailure(await run(getOp(), h, c));

    expect(failed.error.code).toBe('CANCELLED');
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('the category of each store failure', () => {
  const expected: Record<AgentAuthErrorCode, string> = {
    INVALID_PROFILE: 'USAGE',
    INVALID_ORIGIN: 'USAGE',
    INVALID_TOKEN: 'AUTH',
    INVALID_OPTIONS: 'AUTH',
    AMBIGUOUS_CREDENTIALS: 'USAGE',
    ORIGIN_MISMATCH: 'USAGE',
    PROFILE_NOT_CONFIGURED: 'AUTH',
    PROFILE_CONFLICT: 'CONFLICT',
    PROFILE_CORRUPT: 'LOCAL',
    CREDENTIAL_MISSING: 'AUTH',
    FILE_UNSAFE: 'LOCAL',
    FILE_UNAVAILABLE: 'LOCAL',
    FILE_BUSY: 'LOCAL',
    KEYRING_UNSUPPORTED: 'LOCAL',
    KEYRING_UNAVAILABLE: 'AUTH',
    KEYRING_LOCKED: 'AUTH',
    KEYRING_AMBIGUOUS: 'AUTH',
    KEYRING_FAILED: 'AUTH',
    INPUT_REQUIRED: 'USAGE',
    INPUT_UNAVAILABLE: 'USAGE',
    INPUT_CANCELLED: 'CANCELLED',
  };

  it.each(Object.entries(expected))(
    'maps %s to %s with a fixed message',
    async (code, category) => {
      const auth = authDouble({
        resolve: () => Promise.reject(new AgentAuthError(code as AgentAuthErrorCode)),
      });

      const failed = asFailure(await run(statusOp(), harness({ auth }), ctx()));

      expect(failed.error.code).toBe(category);
      expect(failed.error.message.length).toBeGreaterThan(0);
      expect(failed.error.message).not.toContain(code);
      expect(failed.error.status).toBeNull();
      expect(failed.error.requestId).toBeNull();
    },
  );
});

describe('the category of each service and transport failure', () => {
  const expected: Array<[string, string]> = [
    ['UNAUTHENTICATED', 'AUTH'],
    ['FORBIDDEN', 'PERMISSION'],
    ['SESSION_REQUIRED', 'PERMISSION'],
    ['CSRF_REJECTED', 'PERMISSION'],
    ['NOT_FOUND', 'NOT_FOUND'],
    ['CONFLICT', 'CONFLICT'],
    ['IDEMPOTENCY_CONFLICT', 'CONFLICT'],
    ['STALE_WRITE', 'CONFLICT'],
    ['IDEMPOTENCY_EXPIRED', 'CONFLICT'],
    ['RATE_LIMITED', 'QUOTA'],
    ['TOKEN_LIMIT_REACHED', 'QUOTA'],
    ['VALIDATION_ERROR', 'USAGE'],
    ['NOT_READY', 'NETWORK'],
    ['INTERNAL_ERROR', 'NETWORK'],
    ['PRECONDITION_REQUIRED', 'LOCAL'],
    ['IDEMPOTENCY_KEY_REQUIRED', 'LOCAL'],
    ['INVALID_INPUT', 'USAGE'],
    ['INVALID_OPTIONS', 'LOCAL'],
    ['INVALID_RESPONSE', 'NETWORK'],
    ['ABORTED', 'CANCELLED'],
    ['TIMEOUT', 'NETWORK'],
    ['NETWORK_ERROR', 'NETWORK'],
    ['REDIRECT', 'NETWORK'],
    ['HTTP_ERROR', 'NETWORK'],
    ['SOMETHING_NEW', 'LOCAL'],
  ];

  it.each(expected)('maps %s to %s', async (code, category) => {
    const client = clientDouble({
      getIdentity: () => Promise.reject(new PtoApiError(code, { status: 500 })),
    });

    const failed = asFailure(await run(statusOp(), harness({ client }), ctx()));

    expect(failed.error.code).toBe(category);
    expect(failed.error.message.length).toBeGreaterThan(0);
  });
});

describe('the origin, profile and calendar input rules', () => {
  it.each([
    ['a bare https origin', 'https://pto.example.com', true],
    ['a trailing slash', 'https://pto.example.com/', true],
    ['an uppercase host with a port', 'https://PTO.example.com:8443', true],
    ['a port beyond the valid range', 'https://pto.example.com:99999', false],
    ['an empty IPv6 literal', 'https://[::::]', false],
    ['an IPv6 literal that normalizes elsewhere', 'https://[0:0::1]', false],
    ['a doubled dot in the host', 'https://a..b.com', false],
    ['a path', 'https://example.com/path', false],
    ['userinfo', 'https://user@example.com', false],
    ['another scheme', 'ftp://example.com', false],
    ['plain http to a remote host', 'http://pto.example.com', false],
    ['plain http to a private address', 'http://192.168.0.5:3000', false],
    ['an empty string', '', false],
    ['an overlong string', 'x'.repeat(513), false],
    ['a non-string value', 42, false],
  ])('admits %s: %s (through a status command)', async (_label, origin, admitted) => {
    const resolve = vi.fn((_input: ResolveInput) => Promise.resolve(BUNDLE));
    const h = harness({ auth: authDouble({ resolve }) });

    const result = await run(statusOp({ origin: origin as string }), h, ctx());

    if (admitted) {
      expect(result.ok).toBe(true);
      expect(resolve).toHaveBeenCalledTimes(1);
    } else {
      expect(asFailure(result).error.code).toBe('USAGE');
      expect(resolve).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['http://127.0.0.1:3000', true],
    ['http://localhost:3000', true],
    ['http://[::1]:3000', true],
    ['http://pto.example.com', false],
    ['http://192.168.0.5', false],
  ])(
    'admits the literal loopback expectation %s and leaves permission to the resolver: %s',
    async (origin, admitted) => {
      const resolve = vi.fn((_input: ResolveInput) => Promise.resolve(BUNDLE));
      const h = harness({ auth: authDouble({ resolve }) });

      const withOptIn = await run(
        statusOp({ origin: origin as string, allowLoopbackHttp: true }),
        h,
        ctx(),
      );
      const withoutOptIn = await run(statusOp({ origin: origin as string }), h, ctx());

      expect(withOptIn.ok).toBe(admitted);
      expect(withoutOptIn.ok).toBe(admitted);
      if (admitted) {
        expect(resolve.mock.calls[1]?.[0]).toMatchObject({ allowLoopbackHttp: false });
      }
    },
  );

  it.each([
    ['default', true],
    ['a', true],
    ['a'.repeat(32), true],
    ['a'.repeat(33), false],
    ['Work', false],
    ['_work', false],
    ['-work', false],
    ['work name', false],
    ['', false],
    [7, false],
  ])('admits the profile %s: %s', async (profile, admitted) => {
    const resolve = vi.fn((_input: ResolveInput) => Promise.resolve(BUNDLE));
    const h = harness({ auth: authDouble({ resolve }) });

    const result = await run(statusOp({ profile: profile as string }), h, ctx());

    expect(result.ok).toBe(admitted);
  });

  it.each([
    ['2026-12-01', true],
    ['2028-02-29', true],
    ['2026-02-29', false],
    ['2026-13-01', false],
    ['2026-12-1', false],
    [20261201, false],
  ])('admits the calendar day %s: %s', async (day, admitted) => {
    const h = harness();

    const result = await run(listOp({ from: day as string, to: day as string }), h, ctx());

    expect(result.ok).toBe(admitted);
  });

  it.each([
    ['0864a7d8-6de5-46f1-9b5e-9e7ef2ef22fa', true],
    ['0864A7D8-6DE5-46F1-9B5E-9E7EF2EF22FA', true],
    ['0864a7d8-6de5-46f1-9b5e-9e7ef2ef22f', false],
    ['not-a-uuid', false],
    [42, false],
  ])('admits the identifier %s: %s', async (id, admitted) => {
    const h = harness();

    const result = await run(getOp(id), h, ctx());

    expect(result.ok).toBe(admitted);
  });

  it.each([
    [1, true],
    [200, true],
    [0, false],
    [201, false],
    [1.5, false],
    ['5', false],
  ])('admits the page size %s: %s', async (size, admitted) => {
    const h = harness();

    const result = await run(listOp({ pageSize: size as number }), h, ctx());

    expect(result.ok).toBe(admitted);
  });

  it.each([
    [1, true],
    [30, true],
    [0, false],
    [31, false],
  ])('admits the page budget %s: %s', async (pages, admitted) => {
    const h = harness();

    const result = await run(listOp({ maxPages: pages }), h, ctx());

    expect(result.ok).toBe(admitted);
  });
});

/**
 * Whether the shared client admits this origin. Its constructor validates the origin
 * and sends nothing, so it is a safe oracle for the rule this module mirrors.
 */
function sharedClientAdmits(origin: string, allowLoopbackHttp: boolean): boolean {
  try {
    createPtoClient({ baseUrl: origin, credential: { origin, token: TOKEN }, allowLoopbackHttp });
    return true;
  } catch {
    return false;
  }
}

describe('read origin syntax agrees with the shared API client', () => {
  it.each([
    ['https://pto.example.com', false],
    ['https://pto.example.com/', false],
    ['https://PTO.example.com:8443', false],
    ['https://127.0.0.1:3000', false],
    ['https://pto.example.com:99999', false],
    ['https://[::::]', false],
    ['https://[0:0::1]', false],
    ['https://a..b.com', false],
    ['https://example.com/path', false],
    ['https://user@example.com', false],
    ['ftp://example.com', false],
    ['http://pto.example.com', false],
    ['http://pto.example.com', true],
    ['http://127.0.0.1:3000', false],
    ['http://127.0.0.1:3000', true],
    ['http://localhost:3000', true],
    ['http://[::1]:3000', true],
    ['http://[0:0::1]:3000', true],
    ['http://192.168.0.5', true],
    ['', false],
    ['x'.repeat(513), false],
  ])(
    'checks %s with flag %s without overriding the stored loopback policy',
    async (origin, optIn) => {
      const resolve = vi.fn((_input: ResolveInput) => Promise.resolve(BUNDLE));
      const h = harness({ auth: authDouble({ resolve }) });

      await run(statusOp({ origin, allowLoopbackHttp: optIn }), h, ctx());

      expect(resolve.mock.calls.length > 0).toBe(sharedClientAdmits(origin, true));
    },
  );
});

describe('the managed credential projection', () => {
  it('forwards only the two own fields, including an explicit undefined value', async () => {
    const env = Object.create({ PTO_API_TOKEN: TOKEN }) as NodeJS.ProcessEnv;
    env.PTO_API_ORIGIN = undefined;
    env.OTHER = 'not a credential';
    const resolve = vi.fn((_input: ResolveInput) =>
      Promise.reject(new AgentAuthError('INVALID_OPTIONS')),
    );
    const h = harness({ auth: authDouble({ resolve }) });
    const result = asFailure(await run(statusOp(), h, ctx({ env })));
    expect(result.error.code).toBe('AUTH');
    const pair = resolve.mock.calls[0]?.[0].env;
    expect(pair).toEqual({ PTO_API_ORIGIN: undefined });
    expect(Object.keys(pair!)).toEqual(['PTO_API_ORIGIN']);
    expect(h.clientOptions).toHaveLength(0);
  });

  it('reads the trusted pair from the environment record and never from a file', async () => {
    const resolve = vi.fn((_input: ResolveInput) =>
      Promise.resolve({ ...BUNDLE, profile: null, source: 'environment' as const }),
    );
    const h = harness({ auth: authDouble({ resolve }) });
    const c = ctx({ env: { PTO_API_ORIGIN: ORIGIN, PTO_API_TOKEN: TOKEN } });

    const result = asSuccess(await run(listOp({ ownerId: OTHER_OWNER_ID }), h, c));

    const sent = resolve.mock.calls[0]?.[0] as AgentAuthEnvironment | undefined;
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[0]).toMatchObject({
      env: { PTO_API_ORIGIN: ORIGIN, PTO_API_TOKEN: TOKEN },
    });
    expect(sent).toBeDefined();
    expect(result.command).toBe('list');
  });
});

describe('the injected seam', () => {
  it('builds a fresh facade for each operation and never touches the public factory', async () => {
    const createAuth = vi.fn(() => authDouble());
    const deps: ExecuteDependencies = {
      createAuth,
      createClient: () => clientDouble(),
      now: makeClock().now,
    };
    const context = ctx().context;

    await executeWithDependencies(deps, statusOp(), context);
    await executeWithDependencies(deps, statusOp(), context);

    expect(createAuth).toHaveBeenCalledTimes(2);
  });

  it('never gives the client a write method or a second origin', async () => {
    const h = harness();

    await run(statusOp(), h, ctx());

    expect(h.clientOptions[0]?.baseUrl).toBe(BUNDLE.baseUrl);
    expect(h.clientOptions[0]?.credential.origin).toBe(ORIGIN);
    expect(Object.keys(h.client)).toEqual(['getIdentity', 'listAll', 'getDetail']);
  });
});
