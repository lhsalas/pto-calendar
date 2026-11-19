/**
 * The tests of the Linux OS credential store lane.
 *
 * The suite is service-free: it never touches a keychain, a session bus or a
 * record of the host. Three layers are checked.
 *
 * - The TypeScript bridge is driven through a fake child process, so the
 *   spawn arguments, the environment, the request, the answer, the timing, the
 *   redaction and every failure disposition are checked.
 * - The bundled helper is run as a real Python process against fake `gi`
 *   bindings, so the search flags, the locking rules, the scope checks, the
 *   mutations and the fixed codes are checked.
 * - The real bridge runs the bundled helper through the real spawn with the
 *   same fake bindings, so the request and answer contract is checked end to end.
 */

import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type * as ChildProcessModule from 'node:child_process';
import type * as FsModule from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentAuthError } from '../src/errors.js';
import { createLinuxKeyring } from '../src/keyring.js';

const fsMock = vi.hoisted(() => ({
  existsSync: undefined as ((path: string) => boolean) | undefined,
}));

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return {
    ...actual,
    existsSync: (path: string) => (fsMock.existsSync ?? actual.existsSync)(path),
  };
});

/** The interpreter of the bundled helper. */
const PYTHON = '/usr/bin/python3';

/** The bundled helper. */
const HELPER = fileURLToPath(new URL('../libexec/secret-service.py', import.meta.url));

/** The deadline of one helper call, which the timing tests prove. */
const HELPER_TIMEOUT_MS = 10_000;

/** The bound of one answer, which the boundary tests prove. */
const MAX_RESPONSE_BYTES = 4 * 1024;

const DBUS_ADDRESS = 'unix:path=/run/pto-agent-auth-test/bus';
const PROFILE = 'default';
const ORIGIN = 'https://pto.example.com';
const TOKEN = `pto_pat_44444444-4444-4444-8444-444444444444.${'a'.repeat(64)}`;
const NAMESPACE = 'pto-calendar';
const SCHEMA = 'org.pto-calendar.agent-auth';

/** The search flags of the real Secret Service. */
const SEARCH_ALL = 2;
const SEARCH_UNLOCK = 4;
const SEARCH_LOAD_SECRETS = 8;

/** The item create flags of the real Secret Service. */
const ITEM_CREATE_NONE = 0;
const ITEM_CREATE_REPLACE = 2;

/** The proxy flags of the real GIO bindings. */
const DBUS_PROXY_DO_NOT_AUTO_START = 4;

/** The schema attribute type of a string, as the real binding has it. */
const SCHEMA_STRING = 0;

/** One recorded call of the spawn function. */
interface SpawnCall {
  command: string;
  args: string[];
  options: {
    cwd?: string;
    env?: Record<string, string>;
    stdio?: unknown;
    shell?: boolean;
  };
}

/**
 * The standard input of the fake child process.
 *
 * The buffers that the stream was given are kept, and so is a copy taken when
 * the bytes were written. The copy keeps the request readable after the call
 * has wiped the buffers that it handed over.
 */
class FakeStdin extends Writable {
  readonly chunks: Buffer[] = [];
  readonly copies: Buffer[] = [];

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk);
    this.copies.push(Buffer.from(chunk));
    callback();
  }

  /** The one request that was written to the helper. */
  get request(): unknown {
    return JSON.parse(Buffer.concat(this.copies).toString('utf8'));
  }
}

/** The fake child process of the helper. */
class FakeChild extends EventEmitter {
  readonly stdin = new FakeStdin();
  readonly stdout = new Readable({ read() {} });
  readonly stderr = new Readable({ read() {} });
  readonly kill = vi.fn((_signal?: NodeJS.Signals | number) => true);

  /** Answer with one protocol object and close. */
  respond(payload: unknown, exitCode = 0): void {
    this.respondRaw(JSON.stringify(payload), exitCode);
  }

  /** Answer with raw text and close. */
  respondRaw(text: string, exitCode = 0): void {
    this.stdout.push(text);
    this.stdout.push(null);
    setImmediate(() => {
      this.emit('close', exitCode, null);
    });
  }

  /** Close without a clean exit, as a signal does. */
  closeWith(signal: NodeJS.Signals | null): void {
    setImmediate(() => {
      this.emit('close', null, signal);
    });
  }

  /** Report a spawn failure. */
  fail(error: NodeJS.ErrnoException): void {
    setImmediate(() => {
      this.emit('error', error);
    });
  }
}

let child: FakeChild;

beforeEach(() => {
  child = new FakeChild();
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => child);
  vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', DBUS_ADDRESS);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  fsMock.existsSync = undefined;
});

/** The calls of the spawn function. */
function spawnCalls(): SpawnCall[] {
  const calls = spawnMock.mock.calls as unknown as Array<[string, string[], SpawnCall['options']]>;
  return calls.map(([command, args, options]) => ({ command, args, options }));
}

/** The rejection of a promise. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('the promise did not reject');
}

/** What a promise did, observed without changing it. */
interface Observed {
  settled: boolean;
  value?: unknown;
  error?: unknown;
}

/** Observe a promise. Its rejection is handled, so it is never reported as unhandled. */
function observe(promise: Promise<unknown>): Observed {
  const observed: Observed = { settled: false };
  promise.then(
    (value) => {
      observed.settled = true;
      observed.value = value;
    },
    (error: unknown) => {
      observed.settled = true;
      observed.error = error;
    },
  );
  return observed;
}

/** Let the events that are already pending run. */
function settleEvents(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Check one fixed agent auth error. */
function expectAgentAuthError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(AgentAuthError);
  expect((error as { code?: unknown }).code).toBe(code);
}

/** Replace the platform of the process. */
function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

/** The real platform of the process. */
const PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform');

/** Restore the platform of the process. */
function restorePlatform(): void {
  if (PLATFORM) Object.defineProperty(process, 'platform', PLATFORM);
}

/** An answer of exactly the given number of bytes, which the helper protocol can read. */
function boundedAnswer(bytes: number): string {
  const prefix = '{"status":"missing","padding":"';
  const suffix = '"}';
  return prefix + 'x'.repeat(bytes - prefix.length - suffix.length) + suffix;
}

describe('the Linux OS credential store', () => {
  it('exposes an immutable store with the three operations', () => {
    const keyring = createLinuxKeyring();
    expect(Object.isFrozen(keyring)).toBe(true);
    expect(typeof keyring.get).toBe('function');
    expect(typeof keyring.set).toBe('function');
    expect(typeof keyring.remove).toBe('function');
  });

  it('refuses a host that is not Linux', () => {
    setPlatform('darwin');
    try {
      expect(() => createLinuxKeyring()).toThrowError(AgentAuthError);
    } finally {
      restorePlatform();
    }
  });

  it('refuses an operation on a host that is not Linux', async () => {
    const keyring = createLinuxKeyring();
    setPlatform('win32');
    try {
      const error = await rejectionOf(keyring.get(PROFILE, ORIGIN));
      expectAgentAuthError(error, 'KEYRING_UNSUPPORTED');
    } finally {
      restorePlatform();
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('starts the isolated helper with an absolute interpreter and the bundled script', async () => {
    const keyring = createLinuxKeyring();
    const promise = keyring.get(PROFILE, ORIGIN);
    child.respond({ status: 'missing' });
    await expect(promise).resolves.toBeNull();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const call = spawnCalls()[0]!;
    expect(call.command).toBe(PYTHON);
    expect(call.args).toEqual(['-I', '-B', HELPER]);
    expect(isAbsolute(call.args[2]!)).toBe(true);
    expect(call.options.shell).toBe(false);
    expect(call.options.cwd).toBe('/');
    expect(call.options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  it('forwards only the one explicit session bus', async () => {
    vi.stubEnv('XDG_RUNTIME_DIR', '/run/pto-agent-auth-test');
    vi.stubEnv('PTO_AGENT_AUTH_DEBUG', 'leaked');
    vi.stubEnv('PATH', '/leaked/bin');

    const keyring = createLinuxKeyring();
    const promise = keyring.get(PROFILE, ORIGIN);
    child.respond({ status: 'missing' });
    await promise;

    const call = spawnCalls()[0]!;
    expect(call.options.env).toEqual({ DBUS_SESSION_BUS_ADDRESS: DBUS_ADDRESS });
    expect(JSON.stringify(call.options.env)).not.toContain('leaked');
  });

  it('accepts a local abstract socket and a canonical guid', async () => {
    const address = `unix:abstract=pto-agent-auth,guid=${'a'.repeat(32)}`;
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', address);

    const keyring = createLinuxKeyring();
    const promise = keyring.get(PROFILE, ORIGIN);
    child.respond({ status: 'missing' });
    await promise;

    expect(spawnCalls()[0]!.options.env).toEqual({ DBUS_SESSION_BUS_ADDRESS: address });
  });

  it.each([
    ['a TCP address', 'tcp:host=127.0.0.1,port=1234'],
    [
      'a list of addresses',
      'unix:path=/run/pto-agent-auth-test/bus;unix:path=/run/pto-agent-auth-test/other',
    ],
    ['a relative path', 'unix:path=bus'],
    ['another transport', 'nonce-tcp:host=127.0.0.1,port=1234'],
    ['an autolaunch address', 'autolaunch:'],
    ['a runtime address', 'unix:runtime=yes'],
    ['a malformed guid', 'unix:path=/run/pto-agent-auth-test/bus,guid=abc'],
    ['an extra key', 'unix:path=/run/pto-agent-auth-test/bus,extra=1'],
    ['a trailing separator', 'unix:path=/run/pto-agent-auth-test/bus;'],
    ['an empty address', '   '],
    ['an address that is too long', `unix:path=/${'a'.repeat(4096)}`],
  ])('refuses %s', async (_name, address) => {
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', address);

    const keyring = createLinuxKeyring();
    const error = await rejectionOf(keyring.get(PROFILE, ORIGIN));
    expectAgentAuthError(error, 'KEYRING_UNAVAILABLE');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('refuses a host without an explicit session bus', async () => {
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', '');

    const keyring = createLinuxKeyring();
    const error = await rejectionOf(keyring.get(PROFILE, ORIGIN));
    expectAgentAuthError(error, 'KEYRING_UNAVAILABLE');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('refuses a host whose session bus variable is absent', async () => {
    const saved = process.env['DBUS_SESSION_BUS_ADDRESS'];
    delete process.env['DBUS_SESSION_BUS_ADDRESS'];
    try {
      const error = await rejectionOf(createLinuxKeyring().get(PROFILE, ORIGIN));
      expectAgentAuthError(error, 'KEYRING_UNAVAILABLE');
    } finally {
      if (saved !== undefined) process.env['DBUS_SESSION_BUS_ADDRESS'] = saved;
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('keeps the token out of the arguments and the environment', async () => {
    const keyring = createLinuxKeyring();
    const promise = keyring.set(PROFILE, ORIGIN, TOKEN);
    child.respond({ status: 'ok' });
    await expect(promise).resolves.toBeUndefined();

    const call = spawnCalls()[0]!;
    expect(JSON.stringify([call.command, call.args, call.options.env])).not.toContain(TOKEN);
    expect(child.stdin.request).toEqual({
      op: 'set',
      profile: PROFILE,
      origin: ORIGIN,
      token: TOKEN,
    });
  });

  it('sends the scope of a read on the standard input', async () => {
    const keyring = createLinuxKeyring();
    const promise = keyring.get(PROFILE, ORIGIN);
    child.respond({ status: 'ok', token: TOKEN });
    await expect(promise).resolves.toBe(TOKEN);

    expect(child.stdin.request).toEqual({ op: 'get', profile: PROFILE, origin: ORIGIN });
  });

  it('sends the scope of a removal on the standard input', async () => {
    const keyring = createLinuxKeyring();
    const promise = keyring.remove(PROFILE, ORIGIN);
    child.respond({ status: 'removed' });
    await expect(promise).resolves.toBe(true);

    expect(child.stdin.request).toEqual({ op: 'remove', profile: PROFILE, origin: ORIGIN });
  });

  it.each([
    ['https://pto.example.com', 'https://pto.example.com'],
    ['HTTPS://PTO.EXAMPLE.COM:443/', 'https://pto.example.com'],
    ['http://127.0.0.1:5173', 'http://127.0.0.1:5173'],
    ['http://localhost:3000', 'http://localhost:3000'],
    ['http://[::1]:5173', 'http://[::1]:5173'],
  ])('sends the normalized scope of %s', async (input, normalized) => {
    const keyring = createLinuxKeyring();
    const promise = keyring.get(PROFILE, input);
    child.respond({ status: 'missing' });
    await promise;

    expect(child.stdin.request).toEqual({ op: 'get', profile: PROFILE, origin: normalized });
  });

  it.each([
    'http://pto.example.com',
    'http://192.168.1.10:5173',
    'http://127.1:5173',
    'ftp://127.0.0.1:5173',
  ])('refuses %s before the helper is started', async (origin) => {
    const keyring = createLinuxKeyring();
    const error = await rejectionOf(keyring.get(PROFILE, origin));
    expectAgentAuthError(error, 'INVALID_ORIGIN');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('refuses an invalid profile before the helper is started', async () => {
    const keyring = createLinuxKeyring();
    const error = await rejectionOf(keyring.get('Not A Profile', ORIGIN));
    expect(error).toBeInstanceOf(AgentAuthError);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('refuses an invalid origin before the helper is started', async () => {
    const keyring = createLinuxKeyring();
    const error = await rejectionOf(keyring.remove(PROFILE, 'not-an-origin'));
    expect(error).toBeInstanceOf(AgentAuthError);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('refuses an invalid token before the helper is started', async () => {
    const keyring = createLinuxKeyring();
    const error = await rejectionOf(keyring.set(PROFILE, ORIGIN, 'not-a-token'));
    expect(error).toBeInstanceOf(AgentAuthError);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('reports a missing credential without an error', async () => {
    const keyring = createLinuxKeyring();
    const promise = keyring.get(PROFILE, ORIGIN);
    child.respond({ status: 'missing' });
    await expect(promise).resolves.toBeNull();
  });

  it('reports an answer that carries no token as a failure', async () => {
    const keyring = createLinuxKeyring();
    const promise = keyring.get(PROFILE, ORIGIN);
    child.respond({ status: 'ok' });
    expectAgentAuthError(await rejectionOf(promise), 'KEYRING_FAILED');
  });

  it.each([
    ['a token that is not a credential', 'not-a-credential'],
    ['a token that is not a string', 42],
    ['an empty token', ''],
  ])('reports an answer with %s as a failure', async (_name, token) => {
    const keyring = createLinuxKeyring();
    const promise = keyring.get(PROFILE, ORIGIN);
    child.respond({ status: 'ok', token });
    expectAgentAuthError(await rejectionOf(promise), 'KEYRING_FAILED');
  });

  it.each([
    ['an array', '[]'],
    ['a null', 'null'],
    ['a number', '1'],
    ['a string', '"ok"'],
  ])('reports an answer that is %s as a failure', async (_name, text) => {
    const keyring = createLinuxKeyring();
    const promise = keyring.get(PROFILE, ORIGIN);
    child.respondRaw(text);
    expectAgentAuthError(await rejectionOf(promise), 'KEYRING_FAILED');
  });

  it('reports an answer without a status as a failure', async () => {
    const keyring = createLinuxKeyring();
    const promise = keyring.get(PROFILE, ORIGIN);
    child.respondRaw('{"token":"secret"}');
    expectAgentAuthError(await rejectionOf(promise), 'KEYRING_FAILED');
  });

  it('reports an answer that is not JSON as a failure', async () => {
    const keyring = createLinuxKeyring();
    const promise = keyring.get(PROFILE, ORIGIN);
    child.respondRaw('not json at all');
    expectAgentAuthError(await rejectionOf(promise), 'KEYRING_FAILED');
  });

  it('reports an empty answer as a failure', async () => {
    const keyring = createLinuxKeyring();
    const promise = keyring.get(PROFILE, ORIGIN);
    child.respondRaw('');
    expectAgentAuthError(await rejectionOf(promise), 'KEYRING_FAILED');
  });

  it('reports an unknown status as a failure', async () => {
    const keyring = createLinuxKeyring();
    const promise = keyring.get(PROFILE, ORIGIN);
    child.respond({ status: 'something-else' });
    expectAgentAuthError(await rejectionOf(promise), 'KEYRING_FAILED');
  });

  it('accepts an answer of exactly the bound', async () => {
    const keyring = createLinuxKeyring();
    const promise = keyring.get(PROFILE, ORIGIN);
    child.respondRaw(boundedAnswer(MAX_RESPONSE_BYTES));
    await expect(promise).resolves.toBeNull();
  });

  it('accepts an answer that arrives in pieces within the bound', async () => {
    const keyring = createLinuxKeyring();
    const promise = keyring.get(PROFILE, ORIGIN);
    const answer = boundedAnswer(MAX_RESPONSE_BYTES);
    const half = Math.floor(answer.length / 2);
    child.stdout.push(answer.slice(0, half));
    child.stdout.push(answer.slice(half));
    child.stdout.push(null);
    setImmediate(() => child.emit('close', 0, null));
    await expect(promise).resolves.toBeNull();
  });

  it('refuses an answer one byte over the bound', async () => {
    const keyring = createLinuxKeyring();
    const promise = keyring.get(PROFILE, ORIGIN);
    child.respondRaw(boundedAnswer(MAX_RESPONSE_BYTES + 1));
    expectAgentAuthError(await rejectionOf(promise), 'KEYRING_FAILED');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('refuses pieces that together exceed the bound', async () => {
    const keyring = createLinuxKeyring();
    const promise = keyring.get(PROFILE, ORIGIN);
    child.stdout.push('x'.repeat(MAX_RESPONSE_BYTES - 10));
    child.stdout.push('x'.repeat(11));
    expectAgentAuthError(await rejectionOf(promise), 'KEYRING_FAILED');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('settles an oversize answer as a failure, and wipes it before the helper is stopped', async () => {
    const keyring = createLinuxKeyring();
    const promise = keyring.get(PROFILE, ORIGIN);
    const oversize = Buffer.alloc(MAX_RESPONSE_BYTES + 1, 0x41);
    let wipedAtStop = false;
    child.kill.mockImplementation(() => {
      wipedAtStop = oversize.every((byte) => byte === 0);
      return true;
    });

    child.stdout.push(oversize);
    expectAgentAuthError(await rejectionOf(promise), 'KEYRING_FAILED');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(wipedAtStop).toBe(true);
  });

  it('reports a helper that exits with a failure as a failure', async () => {
    const keyring = createLinuxKeyring();
    const promise = keyring.get(PROFILE, ORIGIN);
    child.respond({ status: 'ok', token: TOKEN }, 3);
    expectAgentAuthError(await rejectionOf(promise), 'KEYRING_FAILED');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('reports a helper that was stopped by a signal as unavailable, whatever it had written', async () => {
    const keyring = createLinuxKeyring();
    const promise = keyring.get(PROFILE, ORIGIN);
    const partial = TOKEN.slice(0, 40);
    child.stdout.push(`{"status":"ok","token":"${partial}`);
    child.closeWith('SIGKILL');

    const error = await rejectionOf(promise);
    expectAgentAuthError(error, 'KEYRING_UNAVAILABLE');
    expect(child.kill).not.toHaveBeenCalled();
    expect(JSON.stringify(error)).not.toContain(partial);
  });

  it('reports a helper that does not answer in time as unavailable at the deadline, without waiting for it to close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const keyring = createLinuxKeyring();
    const outcome = observe(keyring.get(PROFILE, ORIGIN));
    const partial = TOKEN.slice(0, 40);
    child.stdout.push(`{"status":"ok","token":"${partial}`);

    await vi.advanceTimersByTimeAsync(HELPER_TIMEOUT_MS - 1);
    expect(outcome.settled).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(outcome.settled).toBe(true);
    expectAgentAuthError(outcome.error, 'KEYRING_UNAVAILABLE');
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(JSON.stringify(outcome.error)).not.toContain(partial);
  });

  it('settles a timed-out call once, even when the helper answers late', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const keyring = createLinuxKeyring();
    const outcome = observe(keyring.get(PROFILE, ORIGIN));

    await vi.advanceTimersByTimeAsync(HELPER_TIMEOUT_MS);
    expectAgentAuthError(outcome.error, 'KEYRING_UNAVAILABLE');

    child.respond({ status: 'ok', token: TOKEN });
    await settleEvents();
    expectAgentAuthError(outcome.error, 'KEYRING_UNAVAILABLE');
    expect(outcome.value).toBeUndefined();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('ignores and wipes what a helper writes after its call was settled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const keyring = createLinuxKeyring();
    const outcome = observe(keyring.get(PROFILE, ORIGIN));
    await vi.advanceTimersByTimeAsync(HELPER_TIMEOUT_MS);

    const late = Buffer.from(`{"status":"ok","token":"${TOKEN}"}`, 'utf8');
    child.stdout.push(late);
    await settleEvents();

    expect(late.every((byte) => byte === 0)).toBe(true);
    expectAgentAuthError(outcome.error, 'KEYRING_UNAVAILABLE');
  });

  it('wipes the request before it stops a helper that does not answer in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const keyring = createLinuxKeyring();
    const outcome = observe(keyring.set(PROFILE, ORIGIN, TOKEN));
    const written = child.stdin.chunks;
    let wipedAtStop = false;
    child.kill.mockImplementation(() => {
      wipedAtStop =
        written.length === 1 && written.every((chunk) => chunk.every((byte) => byte === 0));
      return true;
    });

    await vi.advanceTimersByTimeAsync(HELPER_TIMEOUT_MS);
    expect(outcome.settled).toBe(true);
    expectAgentAuthError(outcome.error, 'KEYRING_UNAVAILABLE');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(wipedAtStop).toBe(true);
    expect(JSON.stringify(outcome.error)).not.toContain(TOKEN);
  });

  it('reports a missing interpreter as unsupported', async () => {
    const keyring = createLinuxKeyring();
    const promise = keyring.get(PROFILE, ORIGIN);
    const failure: NodeJS.ErrnoException = new Error('spawn failed');
    failure.code = 'ENOENT';
    child.fail(failure);
    expectAgentAuthError(await rejectionOf(promise), 'KEYRING_UNSUPPORTED');
  });

  it('reports a helper that cannot be started as unavailable', async () => {
    const keyring = createLinuxKeyring();
    const promise = keyring.get(PROFILE, ORIGIN);
    const failure: NodeJS.ErrnoException = new Error('spawn failed');
    failure.code = 'EACCES';
    child.fail(failure);
    expectAgentAuthError(await rejectionOf(promise), 'KEYRING_UNAVAILABLE');
  });

  it('reports a helper that cannot be started at all as unavailable', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('no child process');
    });
    const keyring = createLinuxKeyring();
    const error = await rejectionOf(keyring.get(PROFILE, ORIGIN));
    expectAgentAuthError(error, 'KEYRING_UNAVAILABLE');
  });

  it('reports a missing helper as unsupported before anything is started', async () => {
    fsMock.existsSync = (path) => path !== HELPER;
    const keyring = createLinuxKeyring();
    const error = await rejectionOf(keyring.get(PROFILE, ORIGIN));
    expectAgentAuthError(error, 'KEYRING_UNSUPPORTED');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('reports a closed input pipe without an error', async () => {
    const keyring = createLinuxKeyring();
    const promise = keyring.get(PROFILE, ORIGIN);
    child.stdin.emit('error', new Error('EPIPE'));
    child.respond({ status: 'missing' });
    await expect(promise).resolves.toBeNull();
  });

  it('ignores what the helper writes on its standard error', async () => {
    const keyring = createLinuxKeyring();
    const promise = keyring.get(PROFILE, ORIGIN);
    child.stderr.push('a diagnostic that must never reach the caller');
    child.respond({ status: 'missing' });
    await expect(promise).resolves.toBeNull();
  });

  it.each([
    ['unsupported', 'KEYRING_UNSUPPORTED'],
    ['unavailable', 'KEYRING_UNAVAILABLE'],
    ['locked', 'KEYRING_LOCKED'],
    ['ambiguous', 'KEYRING_AMBIGUOUS'],
    ['failed', 'KEYRING_FAILED'],
    ['unknown-code', 'KEYRING_FAILED'],
  ])('reports the %s code of the helper as %s', async (code, expected) => {
    const keyring = createLinuxKeyring();
    const promise = keyring.get(PROFILE, ORIGIN);
    child.respond({ status: 'error', code });
    expectAgentAuthError(await rejectionOf(promise), expected);
  });

  it('reports an error without a code as a failure', async () => {
    const keyring = createLinuxKeyring();
    const promise = keyring.get(PROFILE, ORIGIN);
    child.respond({ status: 'error' });
    expectAgentAuthError(await rejectionOf(promise), 'KEYRING_FAILED');
  });

  it('reports the codes of the helper for a write', async () => {
    const keyring = createLinuxKeyring();
    const promise = keyring.set(PROFILE, ORIGIN, TOKEN);
    child.respond({ status: 'error', code: 'locked' });
    expectAgentAuthError(await rejectionOf(promise), 'KEYRING_LOCKED');
  });

  it('reports an unknown answer of a write as a failure', async () => {
    const keyring = createLinuxKeyring();
    const promise = keyring.set(PROFILE, ORIGIN, TOKEN);
    child.respond({ status: 'missing' });
    expectAgentAuthError(await rejectionOf(promise), 'KEYRING_FAILED');
  });

  it('reports the codes of the helper for a removal', async () => {
    const keyring = createLinuxKeyring();
    const promise = keyring.remove(PROFILE, ORIGIN);
    child.respond({ status: 'error', code: 'ambiguous' });
    expectAgentAuthError(await rejectionOf(promise), 'KEYRING_AMBIGUOUS');
  });

  it('reports an unknown answer of a removal as a failure', async () => {
    const keyring = createLinuxKeyring();
    const promise = keyring.remove(PROFILE, ORIGIN);
    child.respond({ status: 'ok' });
    expectAgentAuthError(await rejectionOf(promise), 'KEYRING_FAILED');
  });

  it('reports an absent credential as removed nothing', async () => {
    const keyring = createLinuxKeyring();
    const promise = keyring.remove(PROFILE, ORIGIN);
    child.respond({ status: 'absent' });
    await expect(promise).resolves.toBe(false);
  });

  it('never starts a helper for a lookup that is already cancelled', async () => {
    const keyring = createLinuxKeyring();
    const controller = new AbortController();
    controller.abort();

    const error = await rejectionOf(keyring.get(PROFILE, ORIGIN, controller.signal));
    expectAgentAuthError(error, 'INPUT_CANCELLED');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('refuses a cancellation value that is not an actual signal', async () => {
    const keyring = createLinuxKeyring();

    const error = await rejectionOf(keyring.get(PROFILE, ORIGIN, {} as AbortSignal));
    expectAgentAuthError(error, 'INVALID_OPTIONS');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('stops the helper and the timer when a lookup is cancelled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const keyring = createLinuxKeyring();
    const controller = new AbortController();
    const outcome = observe(keyring.get(PROFILE, ORIGIN, controller.signal));
    await settleEvents();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(outcome.settled).toBe(false);

    controller.abort();
    await settleEvents();
    expect(outcome.settled).toBe(true);
    expectAgentAuthError(outcome.error, 'INPUT_CANCELLED');
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    // The timeout of the call is cancelled with it: the deadline never fires.
    await vi.advanceTimersByTimeAsync(HELPER_TIMEOUT_MS * 2);
    expect(outcome.settled).toBe(true);
    expectAgentAuthError(outcome.error, 'INPUT_CANCELLED');
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('wipes the request and the answer of a cancelled lookup', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const keyring = createLinuxKeyring();
    const controller = new AbortController();
    const outcome = observe(keyring.get(PROFILE, ORIGIN, controller.signal));
    await settleEvents();
    const written = child.stdin.chunks;
    child.stdout.push(Buffer.from(`{"status":"ok","token":"${TOKEN}`, 'utf8'));
    let wipedAtStop = false;
    child.kill.mockImplementation(() => {
      wipedAtStop =
        written.length === 1 && written.every((chunk) => chunk.every((byte) => byte === 0));
      return true;
    });

    controller.abort();
    await settleEvents();
    expect(outcome.settled).toBe(true);
    expectAgentAuthError(outcome.error, 'INPUT_CANCELLED');
    expect(wipedAtStop).toBe(true);
    expect(JSON.stringify(outcome.error)).not.toContain(TOKEN);
  });

  it('never carries the reason of the cancellation into the failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const keyring = createLinuxKeyring();
    const controller = new AbortController();
    const outcome = observe(keyring.get(PROFILE, ORIGIN, controller.signal));
    await settleEvents();

    controller.abort('a private reason that must not travel');
    await settleEvents();
    expectAgentAuthError(outcome.error, 'INPUT_CANCELLED');
    expect(JSON.stringify(outcome.error)).not.toContain('private reason');
  });

  it('settles a cancelled lookup once, even when the helper answers late', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const keyring = createLinuxKeyring();
    const controller = new AbortController();
    const outcome = observe(keyring.get(PROFILE, ORIGIN, controller.signal));
    await settleEvents();

    controller.abort();
    await settleEvents();
    expectAgentAuthError(outcome.error, 'INPUT_CANCELLED');

    child.respond({ status: 'ok', token: TOKEN });
    await settleEvents();
    expectAgentAuthError(outcome.error, 'INPUT_CANCELLED');
    expect(outcome.value).toBeUndefined();
  });

  it('keeps a write and a removal free of the cancellation signal', async () => {
    const keyring = createLinuxKeyring();
    const write = keyring.set(PROFILE, ORIGIN, TOKEN);
    child.respond({ status: 'ok' });
    await write;

    // A second helper answers the removal: every call owns its own child.
    const second = new FakeChild();
    spawnMock.mockImplementation(() => second);
    const removal = keyring.remove(PROFILE, ORIGIN);
    second.respond({ status: 'removed' });
    await expect(removal).resolves.toBe(true);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    for (const call of spawnCalls()) {
      expect(call.args).toEqual(['-I', '-B', HELPER]);
      expect(call.options.env).toEqual({ DBUS_SESSION_BUS_ADDRESS: DBUS_ADDRESS });
    }
  });
});

/** The fake configuration of the bundled helper. */
interface FakeConfig {
  items?: Array<{ attributes: Record<string, string>; secret?: string | null; locked?: boolean }>;
  collection_locked?: boolean;
  no_collection?: boolean;
  alias_error?: boolean;
  search_error?: boolean;
  load_error?: boolean;
  load_false?: boolean;
  service_none?: boolean;
  service_error?: boolean;
  gi_error?: boolean;
  gio_error?: boolean;
  no_owner?: boolean;
  foreign_search?: boolean;
  noise?: boolean;
  create_error?: boolean;
  create_none?: boolean;
  set_error?: boolean;
  set_false?: boolean;
  delete_error?: boolean;
  delete_false?: boolean;
}

/** The record that the fake bindings write when the helper exits. */
interface FakeRecord {
  alias: string[];
  created: Array<{
    attributes: Record<string, string>;
    label: string;
    flags: number;
    schema: string;
    secret: string;
  }>;
  deleted: Array<{ attributes: Record<string, string> }>;
  loaded: Array<{ attributes: Record<string, string> }>;
  owner_checks: Array<{ bus: number; flags: number; name: string }>;
  schema: Array<{ name: string; flags: number; types: Record<string, number> }>;
  search_attributes: Array<Record<string, string>>;
  search_flags: number[];
  service_opens: Array<{ owner: string; flags: number }>;
  updated: Array<{ attributes: Record<string, string>; secret: string }>;
}

/**
 * The fake `gi` bindings of the bundled helper.
 *
 * The bindings answer only what the helper uses, with the enumerations and the
 * value types of the real ones. A call that is not expected fails loudly, and
 * nothing here connects to a bus, a keychain or a record of the host.
 */
const FAKE_BINDINGS = `
import atexit
import json
import os
import sys
import types

CONFIG = json.loads(os.environ.get("PTO_AGENT_AUTH_FAKE", "{}"))
SCHEMA = "org.pto-calendar.agent-auth"
RECORD = {
    "alias": [],
    "created": [],
    "deleted": [],
    "loaded": [],
    "owner_checks": [],
    "schema": [],
    "search_attributes": [],
    "search_flags": [],
    "service_opens": [],
    "updated": [],
}


class FakeValue(object):
    def __init__(self, text):
        self.text = text

    def get_text(self):
        return self.text


class FakeItem(object):
    def __init__(self, attributes, secret, locked):
        self.attributes = dict(attributes)
        self.secret = secret
        self.locked = locked

    def get_attributes(self):
        return {"xdg:schema": SCHEMA, **self.attributes}

    def get_locked(self):
        return self.locked

    def get_secret(self):
        if self.secret is None:
            return None
        return FakeValue(self.secret)

    def set_secret_sync(self, value, cancellable=None):
        if CONFIG.get("set_error"):
            raise RuntimeError("the write was interrupted")
        RECORD["updated"].append({"attributes": dict(self.attributes), "secret": value.get_text()})
        self.secret = value.get_text()
        return not CONFIG.get("set_false")

    def delete_sync(self, cancellable=None):
        if CONFIG.get("delete_error"):
            raise RuntimeError("the delete was refused")
        RECORD["deleted"].append({"attributes": dict(self.attributes)})
        return not CONFIG.get("delete_false")


class FakeCollection(object):
    def __init__(self, locked):
        self.locked = locked

    def get_locked(self):
        return self.locked


class FakeService(object):
    def __init__(self, items, collection):
        self.items = items
        self.collection = collection

    def search_sync(self, schema, attributes, flags, cancellable=None):
        if CONFIG.get("search_error"):
            raise RuntimeError("the secret service was lost")
        RECORD["search_flags"].append(int(flags))
        RECORD["search_attributes"].append(dict(attributes))
        if CONFIG.get("noise"):
            print("noise on the standard output")
        if CONFIG.get("foreign_search"):
            return list(self.items)
        matched = []
        for item in self.items:
            if all(item.attributes.get(key) == value for key, value in attributes.items()):
                matched.append(item)
        return matched


class FakeSchema(object):
    def __init__(self, name):
        self.name = name


ITEMS = [
    FakeItem(entry.get("attributes", {}), entry.get("secret"), bool(entry.get("locked")))
    for entry in CONFIG.get("items", [])
]
COLLECTION = FakeCollection(bool(CONFIG.get("collection_locked")))


def build_secret_module():
    module = types.ModuleType("gi.repository.Secret")

    class SchemaAttributeType(object):
        STRING = 0
        INTEGER = 1
        BOOLEAN = 2

    class SchemaFlags(object):
        NONE = 0
        DONT_MATCH_NAME = 2

    class ServiceFlags(object):
        NONE = 0
        OPEN_SESSION = 2
        LOAD_COLLECTIONS = 4

    class SearchFlags(object):
        NONE = 0
        ALL = 2
        UNLOCK = 4
        LOAD_SECRETS = 8

    class ItemCreateFlags(object):
        NONE = 0
        REPLACE = 2

    class CollectionFlags(object):
        NONE = 0
        LOAD_ITEMS = 2

    class Schema(object):
        @staticmethod
        def new(name, flags, attribute_types):
            for value in attribute_types.values():
                if not isinstance(value, int) or value != SchemaAttributeType.STRING:
                    raise TypeError("enum values must be strings or ints")
            RECORD["schema"].append({
                "name": name,
                "flags": int(flags),
                "types": {key: int(value) for key, value in attribute_types.items()},
            })
            return FakeSchema(name)

    class Value(object):
        @staticmethod
        def new(secret, length, content_type):
            return FakeValue(secret)

    class Item(object):
        @staticmethod
        def load_secrets_sync(items, cancellable=None):
            if CONFIG.get("load_error"):
                raise RuntimeError("the secret service was lost")
            if CONFIG.get("load_false"):
                return False
            for item in items:
                if item.get_locked():
                    return False
            for item in items:
                RECORD["loaded"].append({"attributes": dict(item.attributes)})
            return True

        @staticmethod
        def create_sync(collection, schema, attributes, label, value, flags, cancellable=None):
            if CONFIG.get("create_error"):
                raise RuntimeError("the prompt was dismissed")
            RECORD["created"].append({
                "attributes": dict(attributes),
                "label": label,
                "flags": int(flags),
                "schema": schema.name,
                "secret": value.get_text(),
            })
            if CONFIG.get("create_none"):
                return None
            item = FakeItem(attributes, value.get_text(), False)
            ITEMS.append(item)
            return item

    class Collection(object):
        @staticmethod
        def for_alias_sync(service, alias, flags, cancellable=None):
            RECORD["alias"].append(alias)
            if CONFIG.get("alias_error"):
                raise RuntimeError("the default collection cannot be read")
            if CONFIG.get("no_collection"):
                return None
            return service.collection

    class Service(object):
        __gtype__ = object()

        @staticmethod
        def open_sync(gtype, owner, flags, cancellable=None):
            assert gtype is Service.__gtype__
            RECORD["service_opens"].append({"owner": owner, "flags": int(flags)})
            if CONFIG.get("service_error") or owner != ":1.42":
                raise RuntimeError("the secret service is not available")
            if CONFIG.get("service_none"):
                return None
            return FakeService(ITEMS, COLLECTION)

    module.SchemaAttributeType = SchemaAttributeType
    module.SchemaFlags = SchemaFlags
    module.ServiceFlags = ServiceFlags
    module.SearchFlags = SearchFlags
    module.ItemCreateFlags = ItemCreateFlags
    module.CollectionFlags = CollectionFlags
    module.Schema = Schema
    module.Value = Value
    module.Item = Item
    module.Collection = Collection
    module.Service = Service
    module.COLLECTION_DEFAULT = "default"
    return module


def build_gio_module():
    module = types.ModuleType("gi.repository.Gio")

    class BusType(object):
        SESSION = 2

    class DBusProxyFlags(object):
        NONE = 0
        DO_NOT_LOAD_PROPERTIES = 1
        DO_NOT_CONNECT_SIGNALS = 2
        DO_NOT_AUTO_START = 4
        GET_INVALIDATED_PROPERTIES = 8
        DO_NOT_AUTO_START_AT_CONSTRUCTION = 16
        NO_MATCH_RULE = 32

    class FakeProxy(object):
        def __init__(self, owner):
            self.owner = owner

        def get_name_owner(self):
            return self.owner

    class DBusProxy(object):
        @staticmethod
        def new_for_bus_sync(bus_type, flags, info, name, object_path, interface_name, cancellable=None):
            RECORD["owner_checks"].append({"bus": int(bus_type), "flags": int(flags), "name": name})
            if CONFIG.get("gio_error"):
                raise RuntimeError("the session bus is not reachable")
            return FakeProxy(None if CONFIG.get("no_owner") else ":1.42")

    module.BusType = BusType
    module.DBusProxyFlags = DBusProxyFlags
    module.DBusProxy = DBusProxy
    return module


def build_gi():
    gi = types.ModuleType("gi")

    def require_version(name, version):
        if CONFIG.get("gi_error"):
            raise ValueError("the typelib is not available")

    gi.require_version = require_version
    repository = types.ModuleType("gi.repository")
    secret_module = build_secret_module()
    gio_module = build_gio_module()
    repository.Secret = secret_module
    repository.Gio = gio_module
    gi.repository = repository
    sys.modules["gi"] = gi
    sys.modules["gi.repository"] = repository
    sys.modules["gi.repository.Secret"] = secret_module
    sys.modules["gi.repository.Gio"] = gio_module


def write_record():
    path = CONFIG.get("record_path")
    if path:
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(RECORD, handle)


atexit.register(write_record)
`;

/** The answer of the bundled helper, with what it wrote and what the fake bindings recorded. */
interface HelperAnswer {
  stdout: string;
  stderr: string;
  record: FakeRecord;
}

/** A record with nothing in it, for a run that wrote none. */
const EMPTY_RECORD: FakeRecord = {
  alias: [],
  created: [],
  deleted: [],
  loaded: [],
  owner_checks: [],
  schema: [],
  search_attributes: [],
  search_flags: [],
  service_opens: [],
  updated: [],
};

/** Read the record that the fake bindings wrote in a directory. */
function readRecord(directory: string): FakeRecord {
  try {
    return JSON.parse(readFileSync(join(directory, 'record.json'), 'utf8')) as FakeRecord;
  } catch {
    return EMPTY_RECORD;
  }
}

/**
 * The preamble that runs the bundled helper with the fake bindings.
 *
 * The bindings are installed first, and the helper then runs as `__main__`,
 * so the helper is exactly the file that the bridge starts.
 */
function bridgePreamble(script: string): string {
  return [
    FAKE_BINDINGS,
    'build_gi()',
    'import runpy',
    `runpy.run_path(${JSON.stringify(script)}, run_name="__main__")`,
  ].join('\n');
}

/** Run the bundled helper directly, with the fake bindings, outside the bridge. */
async function runBundledHelper(request: unknown, config: FakeConfig = {}): Promise<HelperAnswer> {
  const directory = mkdtempSync(join(tmpdir(), 'pto-agent-auth-helper-'));
  const { spawn } = await vi.importActual<typeof ChildProcessModule>('node:child_process');
  const helper = spawn(PYTHON, ['-I', '-B', '-c', bridgePreamble(HELPER)], {
    env: {
      PTO_AGENT_AUTH_FAKE: JSON.stringify({
        ...config,
        record_path: join(directory, 'record.json'),
      }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });

  let stdout = '';
  let stderr = '';
  helper.stdout.setEncoding('utf8');
  helper.stderr.setEncoding('utf8');
  helper.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  helper.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const body = typeof request === 'string' ? request : JSON.stringify(request);
  helper.stdin.end(body, 'utf8');
  await new Promise<void>((resolve, reject) => {
    helper.on('error', reject);
    helper.on('close', () => {
      resolve();
    });
  });

  const record = readRecord(directory);
  rmSync(directory, { recursive: true, force: true });
  return { stdout, stderr, record };
}

/** The attributes of one scoped record. */
function scopedAttributes(profile = PROFILE, origin = ORIGIN): Record<string, string> {
  return { namespace: NAMESPACE, profile, origin };
}

describe('the bundled Secret Service helper', () => {
  it('answers a read with the token of the one unlocked record', async () => {
    const { stdout, stderr, record } = await runBundledHelper(
      { op: 'get', profile: PROFILE, origin: ORIGIN },
      { items: [{ attributes: scopedAttributes(), secret: TOKEN }] },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'ok', token: TOKEN });
    expect(stderr).toBe('');
    expect(record.search_flags).toEqual([SEARCH_ALL]);
    expect(record.search_attributes).toEqual([scopedAttributes()]);
    expect(record.loaded).toHaveLength(1);
  });

  it('never unlocks and never loads the secrets of a search', async () => {
    const { record } = await runBundledHelper(
      { op: 'get', profile: PROFILE, origin: ORIGIN },
      { items: [{ attributes: scopedAttributes(), secret: TOKEN }] },
    );

    expect(record.search_flags).not.toContain(SEARCH_UNLOCK);
    expect(record.search_flags).not.toContain(SEARCH_LOAD_SECRETS);
    expect(record.created).toHaveLength(0);
    expect(record.updated).toHaveLength(0);
    expect(record.deleted).toHaveLength(0);
  });

  it('answers a read without a record as missing', async () => {
    const { stdout, record } = await runBundledHelper({
      op: 'get',
      profile: PROFILE,
      origin: ORIGIN,
    });

    expect(JSON.parse(stdout)).toEqual({ status: 'missing' });
    expect(record.loaded).toHaveLength(0);
  });

  it('refuses a read that matches more than one record', async () => {
    const { stdout, record } = await runBundledHelper(
      { op: 'get', profile: PROFILE, origin: ORIGIN },
      {
        items: [
          { attributes: scopedAttributes(), secret: TOKEN },
          { attributes: scopedAttributes(), secret: TOKEN },
        ],
      },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'ambiguous' });
    expect(record.loaded).toHaveLength(0);
  });

  it('refuses a read of a locked record without loading it', async () => {
    const { stdout, record } = await runBundledHelper(
      { op: 'get', profile: PROFILE, origin: ORIGIN },
      { items: [{ attributes: scopedAttributes(), secret: TOKEN, locked: true }] },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'locked' });
    expect(record.loaded).toHaveLength(0);
  });

  it('refuses a match of the search that is not in the scope of the request', async () => {
    const { stdout, record } = await runBundledHelper(
      { op: 'get', profile: PROFILE, origin: ORIGIN },
      {
        foreign_search: true,
        items: [{ attributes: scopedAttributes('other', ORIGIN), secret: TOKEN }],
      },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'failed' });
    expect(record.loaded).toHaveLength(0);
  });

  it('refuses a matching attribute tuple from another schema', async () => {
    const { stdout, record } = await runBundledHelper(
      { op: 'get', profile: PROFILE, origin: ORIGIN },
      {
        foreign_search: true,
        items: [
          {
            attributes: { ...scopedAttributes(), 'xdg:schema': 'org.example.other' },
            secret: TOKEN,
          },
        ],
      },
    );
    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'failed' });
    expect(record.loaded).toHaveLength(0);
  });

  it('refuses a stored secret that is not a credential', async () => {
    const { stdout } = await runBundledHelper(
      { op: 'get', profile: PROFILE, origin: ORIGIN },
      { items: [{ attributes: scopedAttributes(), secret: 'not-a-credential' }] },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'failed' });
  });

  it('ignores a record of another namespace', async () => {
    const { stdout } = await runBundledHelper(
      { op: 'get', profile: PROFILE, origin: ORIGIN },
      {
        items: [
          {
            attributes: { namespace: 'another-app', profile: PROFILE, origin: ORIGIN },
            secret: TOKEN,
          },
        ],
      },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'missing' });
  });

  it('ignores a record of another profile', async () => {
    const { stdout } = await runBundledHelper(
      { op: 'get', profile: PROFILE, origin: ORIGIN },
      { items: [{ attributes: scopedAttributes('other', ORIGIN), secret: TOKEN }] },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'missing' });
  });

  it('ignores a record of another origin', async () => {
    const { stdout } = await runBundledHelper(
      { op: 'get', profile: PROFILE, origin: ORIGIN },
      {
        items: [
          {
            attributes: scopedAttributes(PROFILE, 'https://other.example.com'),
            secret: TOKEN,
          },
        ],
      },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'missing' });
  });

  it('does not open the secret service when no service owns its bus name', async () => {
    const { stdout, record } = await runBundledHelper(
      { op: 'get', profile: PROFILE, origin: ORIGIN },
      { no_owner: true, items: [{ attributes: scopedAttributes(), secret: TOKEN }] },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'unavailable' });
    expect(record.service_opens).toEqual([]);
    expect(record.search_flags).toEqual([]);
    expect(record.owner_checks).toHaveLength(1);
    expect(record.owner_checks[0]!.name).toBe('org.freedesktop.secrets');
    expect(record.owner_checks[0]!.flags & DBUS_PROXY_DO_NOT_AUTO_START).toBe(
      DBUS_PROXY_DO_NOT_AUTO_START,
    );
  });

  it('reports a failed bus check as unavailable without opening the service', async () => {
    const { stdout, record } = await runBundledHelper(
      { op: 'get', profile: PROFILE, origin: ORIGIN },
      { gio_error: true },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'unavailable' });
    expect(record.service_opens).toEqual([]);
  });

  it('targets only the unique bus owner even if it disappears after the owner check', async () => {
    const { stdout, record } = await runBundledHelper(
      { op: 'get', profile: PROFILE, origin: ORIGIN },
      { service_error: true, items: [{ attributes: scopedAttributes(), secret: TOKEN }] },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'unavailable' });
    expect(record.service_opens).toEqual([{ owner: ':1.42', flags: 2 }]);
    expect(record.search_flags).toEqual([]);
  });

  it('creates a record when the scope has none', async () => {
    const { stdout, record } = await runBundledHelper({
      op: 'set',
      profile: PROFILE,
      origin: ORIGIN,
      token: TOKEN,
    });

    expect(JSON.parse(stdout)).toEqual({ status: 'ok' });
    expect(record.created).toHaveLength(1);
    expect(record.created[0]!.attributes).toEqual(scopedAttributes());
    expect(record.created[0]!.label).toBe('PTO Calendar agent credential default');
    expect(record.created[0]!.secret).toBe(TOKEN);
    expect(record.created[0]!.flags).toBe(ITEM_CREATE_NONE);
    expect(record.created[0]!.flags).not.toBe(ITEM_CREATE_REPLACE);
    expect(record.updated).toHaveLength(0);
  });

  it('updates the one record of the scope instead of replacing it', async () => {
    const { stdout, record } = await runBundledHelper(
      { op: 'set', profile: PROFILE, origin: ORIGIN, token: TOKEN },
      { items: [{ attributes: scopedAttributes(), secret: 'old-token' }] },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'ok' });
    expect(record.updated).toHaveLength(1);
    expect(record.updated[0]!.secret).toBe(TOKEN);
    expect(record.created).toHaveLength(0);
  });

  it('refuses a write that matches more than one record', async () => {
    const { stdout, record } = await runBundledHelper(
      { op: 'set', profile: PROFILE, origin: ORIGIN, token: TOKEN },
      {
        items: [
          { attributes: scopedAttributes(), secret: TOKEN },
          { attributes: scopedAttributes(), secret: TOKEN },
        ],
      },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'ambiguous' });
    expect(record.updated).toHaveLength(0);
    expect(record.created).toHaveLength(0);
  });

  it('refuses a write to a locked record', async () => {
    const { stdout, record } = await runBundledHelper(
      { op: 'set', profile: PROFILE, origin: ORIGIN, token: TOKEN },
      { items: [{ attributes: scopedAttributes(), secret: TOKEN, locked: true }] },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'locked' });
    expect(record.updated).toHaveLength(0);
    expect(record.created).toHaveLength(0);
  });

  it('refuses a write when the default collection is locked', async () => {
    const { stdout, record } = await runBundledHelper(
      { op: 'set', profile: PROFILE, origin: ORIGIN, token: TOKEN },
      { collection_locked: true },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'locked' });
    expect(record.created).toHaveLength(0);
  });

  it('refuses a write when the default collection is not initialized', async () => {
    const { stdout, record } = await runBundledHelper(
      { op: 'set', profile: PROFILE, origin: ORIGIN, token: TOKEN },
      { no_collection: true },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'unavailable' });
    expect(record.created).toHaveLength(0);
  });

  it('refuses a write that the service does not confirm', async () => {
    const { stdout } = await runBundledHelper(
      { op: 'set', profile: PROFILE, origin: ORIGIN, token: TOKEN },
      { items: [{ attributes: scopedAttributes(), secret: 'old-token' }], set_false: true },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'failed' });
  });

  it('refuses a new record that the service does not return', async () => {
    const { stdout, record } = await runBundledHelper(
      { op: 'set', profile: PROFILE, origin: ORIGIN, token: TOKEN },
      { create_none: true },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'failed' });
    expect(record.created).toHaveLength(1);
  });

  it('reports an interrupted write as a failure, not as a missing store', async () => {
    const { stdout } = await runBundledHelper(
      { op: 'set', profile: PROFILE, origin: ORIGIN, token: TOKEN },
      { items: [{ attributes: scopedAttributes(), secret: 'old-token' }], set_error: true },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'failed' });
  });

  it('reports a dismissed creation as a failure', async () => {
    const { stdout } = await runBundledHelper(
      { op: 'set', profile: PROFILE, origin: ORIGIN, token: TOKEN },
      { create_error: true },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'failed' });
  });

  it('removes the one record of the scope', async () => {
    const { stdout, record } = await runBundledHelper(
      { op: 'remove', profile: PROFILE, origin: ORIGIN },
      { items: [{ attributes: scopedAttributes(), secret: TOKEN }] },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'removed' });
    expect(record.deleted).toHaveLength(1);
    expect(record.deleted[0]!.attributes).toEqual(scopedAttributes());
  });

  it('answers a removal without a record as absent', async () => {
    const { stdout, record } = await runBundledHelper({
      op: 'remove',
      profile: PROFILE,
      origin: ORIGIN,
    });

    expect(JSON.parse(stdout)).toEqual({ status: 'absent' });
    expect(record.deleted).toHaveLength(0);
  });

  it('refuses a removal that matches more than one record', async () => {
    const { stdout, record } = await runBundledHelper(
      { op: 'remove', profile: PROFILE, origin: ORIGIN },
      {
        items: [
          { attributes: scopedAttributes(), secret: TOKEN },
          { attributes: scopedAttributes(), secret: TOKEN },
        ],
      },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'ambiguous' });
    expect(record.deleted).toHaveLength(0);
  });

  it('refuses a removal of a locked record', async () => {
    const { stdout, record } = await runBundledHelper(
      { op: 'remove', profile: PROFILE, origin: ORIGIN },
      { items: [{ attributes: scopedAttributes(), secret: TOKEN, locked: true }] },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'locked' });
    expect(record.deleted).toHaveLength(0);
  });

  it('refuses a removal when the default collection is locked', async () => {
    const { stdout, record } = await runBundledHelper(
      { op: 'remove', profile: PROFILE, origin: ORIGIN },
      { collection_locked: true, items: [{ attributes: scopedAttributes(), secret: TOKEN }] },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'locked' });
    expect(record.deleted).toHaveLength(0);
  });

  it('refuses a removal that the service does not confirm', async () => {
    const { stdout } = await runBundledHelper(
      { op: 'remove', profile: PROFILE, origin: ORIGIN },
      { items: [{ attributes: scopedAttributes(), secret: TOKEN }], delete_false: true },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'failed' });
  });

  it('reports a failed removal as a failure', async () => {
    const { stdout } = await runBundledHelper(
      { op: 'remove', profile: PROFILE, origin: ORIGIN },
      { items: [{ attributes: scopedAttributes(), secret: TOKEN }], delete_error: true },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'failed' });
  });

  it('reports a host without the secret service bindings as unsupported', async () => {
    const { stdout } = await runBundledHelper(
      { op: 'get', profile: PROFILE, origin: ORIGIN },
      { gi_error: true },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'unsupported' });
  });

  it('reports a secret service that cannot be reached as unavailable', async () => {
    const { stdout } = await runBundledHelper(
      { op: 'get', profile: PROFILE, origin: ORIGIN },
      { service_error: true },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'unavailable' });
  });

  it('reports a secret service that opens to nothing as unavailable', async () => {
    const { stdout, record } = await runBundledHelper(
      { op: 'set', profile: PROFILE, origin: ORIGIN, token: TOKEN },
      { service_none: true },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'unavailable' });
    expect(record.created).toHaveLength(0);
  });

  it('reports a service lost during a search as unavailable, without a write', async () => {
    const { stdout, record } = await runBundledHelper(
      { op: 'set', profile: PROFILE, origin: ORIGIN, token: TOKEN },
      { search_error: true },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'unavailable' });
    expect(record.created).toHaveLength(0);
    expect(record.updated).toHaveLength(0);
  });

  it('reports a service lost while a secret is loaded as unavailable', async () => {
    const { stdout, record } = await runBundledHelper(
      { op: 'get', profile: PROFILE, origin: ORIGIN },
      { load_error: true, items: [{ attributes: scopedAttributes(), secret: TOKEN }] },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'unavailable' });
    expect(record.loaded).toHaveLength(0);
  });

  it('refuses a secret that the service does not load', async () => {
    const { stdout } = await runBundledHelper(
      { op: 'get', profile: PROFILE, origin: ORIGIN },
      { load_false: true, items: [{ attributes: scopedAttributes(), secret: TOKEN }] },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'failed' });
  });

  it('reports a default collection that cannot be read as unavailable', async () => {
    const { stdout, record } = await runBundledHelper(
      { op: 'remove', profile: PROFILE, origin: ORIGIN },
      { alias_error: true, items: [{ attributes: scopedAttributes(), secret: TOKEN }] },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'unavailable' });
    expect(record.deleted).toHaveLength(0);
  });

  it('accepts the loopback origin of a development profile in its exact form', async () => {
    const origin = 'http://127.0.0.1:5173';
    const { stdout, record } = await runBundledHelper(
      { op: 'get', profile: PROFILE, origin },
      { items: [{ attributes: scopedAttributes(PROFILE, origin), secret: TOKEN }] },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'ok', token: TOKEN });
    expect(record.search_attributes).toEqual([scopedAttributes(PROFILE, origin)]);
  });

  it.each([
    ['an origin with a trailing slash', 'https://pto.example.com/'],
    ['an origin with the default port', 'https://pto.example.com:443'],
    ['an upper-case origin', 'https://PTO.example.com'],
    ['a plain HTTP origin that is not loopback', 'http://pto.example.com'],
    ['a port out of range', 'https://pto.example.com:99999'],
    ['a path', 'https://pto.example.com/api'],
    ['the default HTTP port', 'http://localhost:80'],
  ])('refuses %s', async (_name, origin) => {
    const { stdout, record } = await runBundledHelper({ op: 'get', profile: PROFILE, origin });

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'failed' });
    expect(record.search_flags).toEqual([]);
  });

  it.each([
    ['an empty profile', ''],
    ['a profile with upper-case letters', 'Default'],
    ['a profile with a slash', 'a/b'],
    ['a profile that is too long', 'a'.repeat(33)],
  ])('refuses %s', async (_name, profile) => {
    const { stdout } = await runBundledHelper({ op: 'get', profile, origin: ORIGIN });

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'failed' });
  });

  it('refuses a token of a write that is not a credential', async () => {
    const { stdout, record } = await runBundledHelper({
      op: 'set',
      profile: PROFILE,
      origin: ORIGIN,
      token: 'not-a-credential',
    });

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'failed' });
    expect(record.created).toHaveLength(0);
  });

  it('refuses a field that the operation does not carry', async () => {
    const { stdout, record } = await runBundledHelper({
      op: 'get',
      profile: PROFILE,
      origin: ORIGIN,
      token: TOKEN,
    });

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'failed' });
    expect(record.search_flags).toEqual([]);
  });

  it('refuses a write that does not carry its token', async () => {
    const { stdout } = await runBundledHelper({ op: 'set', profile: PROFILE, origin: ORIGIN });

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'failed' });
  });

  it('reports a request that is not JSON as a failure', async () => {
    const { stdout, stderr } = await runBundledHelper('not json at all');

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'failed' });
    expect(stderr).toBe('');
  });

  it('reports a request that is too large as a failure', async () => {
    const { stdout } = await runBundledHelper(
      JSON.stringify({ op: 'get', profile: PROFILE, origin: 'x'.repeat(5000) }),
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'failed' });
  });

  it('reports a request that is not an object as a failure', async () => {
    const { stdout } = await runBundledHelper('[]');

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'failed' });
  });

  it('reports an unknown operation as a failure', async () => {
    const { stdout } = await runBundledHelper({
      op: 'replace',
      profile: PROFILE,
      origin: ORIGIN,
    });

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'failed' });
  });

  it('reports a request without a scope as a failure', async () => {
    const { stdout } = await runBundledHelper({ op: 'get' });

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'failed' });
  });

  it('reports a scope that is too long as a failure', async () => {
    const { stdout } = await runBundledHelper({
      op: 'get',
      profile: PROFILE,
      origin: `https://${'x'.repeat(600)}.example.com`,
    });

    expect(JSON.parse(stdout)).toEqual({ status: 'error', code: 'failed' });
  });

  it('uses the namespace of this application and string attributes in the schema', async () => {
    const { record } = await runBundledHelper(
      { op: 'get', profile: PROFILE, origin: ORIGIN },
      { items: [{ attributes: scopedAttributes(), secret: TOKEN }] },
    );

    expect(record.schema).toHaveLength(1);
    expect(record.schema[0]!.name).toBe(SCHEMA);
    expect(record.schema[0]!.types).toEqual({
      namespace: SCHEMA_STRING,
      profile: SCHEMA_STRING,
      origin: SCHEMA_STRING,
    });
    expect(record.alias).toEqual([]);
  });

  it('asks for the default collection before a mutation', async () => {
    const { record } = await runBundledHelper(
      { op: 'remove', profile: PROFILE, origin: ORIGIN },
      { items: [{ attributes: scopedAttributes(), secret: TOKEN }] },
    );

    expect(record.alias).toEqual(['default']);
  });

  it('keeps stray output of the bindings off the one answer', async () => {
    const { stdout, stderr } = await runBundledHelper(
      { op: 'get', profile: PROFILE, origin: ORIGIN },
      { noise: true, items: [{ attributes: scopedAttributes(), secret: TOKEN }] },
    );

    expect(JSON.parse(stdout)).toEqual({ status: 'ok', token: TOKEN });
    expect(stderr).toContain('noise on the standard output');
  });

  it('never writes a traceback and never writes a diagnostic to the answer', async () => {
    const { stdout } = await runBundledHelper(
      { op: 'get', profile: PROFILE, origin: ORIGIN },
      { service_error: true },
    );

    expect(stdout).not.toContain('Traceback');
    expect(stdout).not.toContain('RuntimeError');
    expect(stdout).not.toContain('the secret service is not available');
  });

  it('keeps the token out of the source of the helper and of the fake bindings', () => {
    expect(FAKE_BINDINGS).not.toContain(TOKEN);
    expect(readFileSync(HELPER, 'utf8')).not.toContain(TOKEN);
  });
});

describe('the real bridge to the bundled helper, with fake bindings', () => {
  let directory: string;
  let config: FakeConfig;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pto-agent-auth-bridge-'));
    config = {};
    const { spawn } = await vi.importActual<typeof ChildProcessModule>('node:child_process');
    // The real spawn starts the process. Only its argument list is replaced, so the
    // bundled file runs with the fake bindings installed first. The arguments the
    // bridge actually chose are asserted by the first test of this block.
    spawnMock.mockImplementation((command: string, args: string[], options: SpawnCall['options']) =>
      spawn(command, ['-I', '-B', '-c', bridgePreamble(args[2] ?? '')], {
        cwd: options.cwd,
        env: {
          ...options.env,
          PTO_AGENT_AUTH_FAKE: JSON.stringify({
            ...config,
            record_path: join(directory, 'record.json'),
          }),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      }),
    );
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('reads the one unlocked record through the real helper', async () => {
    config = { items: [{ attributes: scopedAttributes(), secret: TOKEN }] };

    await expect(createLinuxKeyring().get(PROFILE, ORIGIN)).resolves.toBe(TOKEN);

    const call = spawnCalls()[0]!;
    expect(call.command).toBe(PYTHON);
    expect(call.args).toEqual(['-I', '-B', HELPER]);
    const record = readRecord(directory);
    expect(record.search_flags).toEqual([SEARCH_ALL]);
    expect(record.loaded).toHaveLength(1);
    expect(record.schema[0]!.types).toEqual({
      namespace: SCHEMA_STRING,
      profile: SCHEMA_STRING,
      origin: SCHEMA_STRING,
    });
  });

  it('reports a missing record through the real helper as absent', async () => {
    await expect(createLinuxKeyring().get(PROFILE, ORIGIN)).resolves.toBeNull();
    expect(readRecord(directory).loaded).toHaveLength(0);
  });

  it('creates the record through the real helper without the token on the command line', async () => {
    await expect(createLinuxKeyring().set(PROFILE, ORIGIN, TOKEN)).resolves.toBeUndefined();

    const record = readRecord(directory);
    expect(record.created).toHaveLength(1);
    expect(record.created[0]!.attributes).toEqual(scopedAttributes());
    expect(record.created[0]!.secret).toBe(TOKEN);
    expect(JSON.stringify(spawnCalls().map((call) => [call.args, call.options.env]))).not.toContain(
      TOKEN,
    );
  });

  it('removes the one record through the real helper', async () => {
    config = { items: [{ attributes: scopedAttributes(), secret: TOKEN }] };

    await expect(createLinuxKeyring().remove(PROFILE, ORIGIN)).resolves.toBe(true);
    expect(readRecord(directory).deleted).toHaveLength(1);
  });

  it('reports an absent record through the real helper as removed nothing', async () => {
    await expect(createLinuxKeyring().remove(PROFILE, ORIGIN)).resolves.toBe(false);
  });

  it('reports an ambiguous match through the real helper as ambiguous', async () => {
    config = {
      items: [
        { attributes: scopedAttributes(), secret: TOKEN },
        { attributes: scopedAttributes(), secret: TOKEN },
      ],
    };

    expectAgentAuthError(
      await rejectionOf(createLinuxKeyring().get(PROFILE, ORIGIN)),
      'KEYRING_AMBIGUOUS',
    );
  });

  it('reports a locked match through the real helper as locked', async () => {
    config = { items: [{ attributes: scopedAttributes(), secret: TOKEN, locked: true }] };

    expectAgentAuthError(
      await rejectionOf(createLinuxKeyring().get(PROFILE, ORIGIN)),
      'KEYRING_LOCKED',
    );
  });

  it('reports a locked default collection through the real helper as locked', async () => {
    config = { collection_locked: true };

    expectAgentAuthError(
      await rejectionOf(createLinuxKeyring().set(PROFILE, ORIGIN, TOKEN)),
      'KEYRING_LOCKED',
    );
    expect(readRecord(directory).created).toHaveLength(0);
  });

  it('never starts a service that owns no bus name', async () => {
    config = { no_owner: true, items: [{ attributes: scopedAttributes(), secret: TOKEN }] };

    expectAgentAuthError(
      await rejectionOf(createLinuxKeyring().get(PROFILE, ORIGIN)),
      'KEYRING_UNAVAILABLE',
    );
    const record = readRecord(directory);
    expect(record.service_opens).toEqual([]);
    expect(record.owner_checks[0]!.flags & DBUS_PROXY_DO_NOT_AUTO_START).toBe(
      DBUS_PROXY_DO_NOT_AUTO_START,
    );
  });

  it('reports missing bindings through the real helper as unsupported', async () => {
    config = { gi_error: true };

    expectAgentAuthError(
      await rejectionOf(createLinuxKeyring().get(PROFILE, ORIGIN)),
      'KEYRING_UNSUPPORTED',
    );
  });

  it('reports a service that cannot be reached through the real helper as unavailable', async () => {
    config = { service_error: true };

    expectAgentAuthError(
      await rejectionOf(createLinuxKeyring().get(PROFILE, ORIGIN)),
      'KEYRING_UNAVAILABLE',
    );
  });

  it('returns the token even when the bindings print to standard output', async () => {
    config = { noise: true, items: [{ attributes: scopedAttributes(), secret: TOKEN }] };

    await expect(createLinuxKeyring().get(PROFILE, ORIGIN)).resolves.toBe(TOKEN);
  });

  it('reads a loopback development origin through the real helper', async () => {
    const origin = 'http://127.0.0.1:5173';
    config = { items: [{ attributes: scopedAttributes(PROFILE, origin), secret: TOKEN }] };

    await expect(createLinuxKeyring().get(PROFILE, origin)).resolves.toBe(TOKEN);
  });

  it('reports a stored secret that is not a credential through the real helper as a failure', async () => {
    config = { items: [{ attributes: scopedAttributes(), secret: 'not-a-credential' }] };

    expectAgentAuthError(
      await rejectionOf(createLinuxKeyring().get(PROFILE, ORIGIN)),
      'KEYRING_FAILED',
    );
  });

  it('reports a write the service does not confirm through the real helper as a failure', async () => {
    config = { set_false: true, items: [{ attributes: scopedAttributes(), secret: 'old' }] };

    expectAgentAuthError(
      await rejectionOf(createLinuxKeyring().set(PROFILE, ORIGIN, TOKEN)),
      'KEYRING_FAILED',
    );
  });
});
