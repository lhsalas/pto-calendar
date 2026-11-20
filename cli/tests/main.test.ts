import { PassThrough, Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliSuccessFor } from '../src/contract.js';
import { executeCommand } from '../src/execute-command.js';
import { executeWrite } from '../src/execute-write.js';
import { runPto, type CliRuntime } from '../src/main.js';

vi.mock('../src/execute-command.js', () => ({ executeCommand: vi.fn() }));
vi.mock('../src/execute-write.js', () => ({ executeWrite: vi.fn() }));

function capture(
  isTTY = false,
  failure?: 'write' | 'throw',
): {
  readonly stream: Writable & { readonly isTTY: boolean };
  text(): string;
} {
  let buffer = '';
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      if (failure === 'throw') throw new Error('untrusted output exception');
      if (failure === 'write') {
        done(new Error('untrusted output error'));
        return;
      }
      buffer += chunk.toString('utf8');
      done();
    },
  });
  stream.on('error', () => undefined);
  return { stream: Object.assign(stream, { isTTY }), text: () => buffer };
}

function runtime(
  args: readonly string[],
  options?: { tty?: boolean; failure?: 'write' | 'throw' },
) {
  const stdout = capture(false, options?.failure);
  const stderr = capture(options?.tty);
  const input = Object.assign(new PassThrough(), { isTTY: options?.tty });
  const env = { PTO_API_ORIGIN: 'https://pto.example.invalid' };
  const control = new AbortController();
  const value: CliRuntime = {
    args,
    env,
    input,
    stdout: stdout.stream,
    stderr: stderr.stream,
    signal: control.signal,
    version: '0.1.0',
  };
  return { value, stdout, stderr, input, control };
}

describe('read-only CLI startup', () => {
  beforeEach(() => vi.resetAllMocks());

  it('renders help with no operation even when unsafe host configuration is present', async () => {
    const { value, stdout, stderr } = runtime(['--json', '--help']);
    await expect(runPto(value)).resolves.toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: 'help',
      data: { text: expect.any(String) },
    });
    expect(stderr.text()).toBe('');
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('renders the supplied workspace version without starting an operation', async () => {
    const { value, stdout } = runtime(['--version', '--json']);
    await expect(runPto(value)).resolves.toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: 'version',
      data: { version: '0.1.0' },
    });
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('returns a fixed usage error, not an untrusted argument', async () => {
    const untrusted = 'untrusted-option-value';
    const { value, stdout, stderr } = runtime(['--json', untrusted]);
    await expect(runPto(value)).resolves.toBe(2);
    expect(JSON.parse(stdout.text())).toMatchObject({
      schemaVersion: 1,
      ok: false,
      command: null,
      error: { code: 'USAGE' },
    });
    expect(stdout.text() + stderr.text()).not.toContain(untrusted);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('passes the trusted context and separates operation prompt from output', async () => {
    const { value, stdout, stderr, input, control } = runtime(
      ['auth', 'set', '--origin', 'https://pto.example.invalid', '--json'],
      { tty: true },
    );
    vi.mocked(executeCommand).mockImplementation(async (command, context) => {
      expect(command.kind).toBe('auth-set');
      expect(context.env).toBe(value.env);
      expect(context.input).toBe(input);
      expect(context.interactive).toBe(true);
      expect(context.signal).toBe(control.signal);
      context.prompt('Fixed test prompt');
      return {
        schemaVersion: 1,
        ok: true,
        command: 'auth-set',
        data: { profile: 'default', origin: 'https://pto.example.invalid', source: 'keyring' },
      };
    });
    await expect(runPto(value)).resolves.toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({ command: 'auth-set', ok: true });
    expect(stderr.text()).toBe('Fixed test prompt');
  });

  it('does not treat a missing diagnostic terminal as interactive', async () => {
    const { value, input } = runtime(['auth', 'set', '--origin', 'https://pto.example.invalid']);
    input.isTTY = true;
    vi.mocked(executeCommand).mockImplementation(async (_command, context) => {
      expect(context.interactive).toBe(false);
      return {
        schemaVersion: 1,
        ok: false,
        command: 'auth-set',
        error: {
          code: 'AUTH',
          message: 'Setup requires explicit input.',
          status: null,
          requestId: null,
          retryAfterMs: null,
        },
      };
    });
    await expect(runPto(value)).resolves.toBe(3);
  });

  it('adapts unexpected errors without forwarding the raw error', async () => {
    const { value, stdout, stderr } = runtime(['auth', 'status', '--json']);
    const message = 'untrusted-operation-error';
    vi.mocked(executeCommand).mockRejectedValue(new Error(message));
    await expect(runPto(value)).resolves.toBe(10);
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: false,
      command: 'auth-status',
      error: { code: 'LOCAL' },
    });
    expect(stdout.text() + stderr.text()).not.toContain(message);
  });

  it.each(['write', 'throw'] as const)(
    'handles stdout %s failure without leaking it',
    async (failure) => {
      const { value, stderr } = runtime(['--version'], { failure });
      await expect(runPto(value)).resolves.toBe(10);
      expect(stderr.text()).toBe('');
    },
  );
});

describe('write command entry', () => {
  const id = '11111111-aaaa-4111-8111-000000000002';

  beforeEach(() => vi.resetAllMocks());

  it.each([
    { mode: 'normal', failure: undefined },
    { mode: 'writer failed', failure: 'write' as const },
    { mode: 'caller abandoned', failure: undefined },
  ])('flushes a successful create at most once ($mode)', async ({ mode, failure }) => {
    const { value, stdout, control } = runtime(
      ['create', '--from', '2026-11-24', '--to', '2026-11-25', '--day-part', 'all_day', '--json'],
      failure === undefined ? undefined : { failure },
    );
    const result: CliSuccessFor<'create'> = {
      schemaVersion: 1,
      ok: true,
      command: 'create',
      data: {
        operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        replayed: false,
        expiresAt: '2099-01-01T00:00:00.000Z',
        record: {
          id,
          ownerId: '11111111-aaaa-4111-8111-000000000001',
          version: 1,
          startDate: '2026-11-24',
          endDate: '2026-11-25',
          dayPart: 'all_day',
        },
      },
    };
    vi.mocked(executeWrite).mockImplementation(async (_command, host) => {
      const offered = host.publishCreateResult?.(result);
      if (mode === 'caller abandoned') {
        control.abort();
        // Like the executor's abort path, return while output is still
        // pending. A duplicate handoff must also reuse the first promise.
        void host.publishCreateResult?.(result);
      } else {
        expect(await offered).toBe(failure === undefined);
      }
      return result;
    });
    await expect(runPto(value)).resolves.toBe(failure === undefined ? 0 : 10);
    if (failure === undefined) expect(stdout.text().split('\n')).toHaveLength(2);
    else expect(stdout.text()).toBe('');
  });

  it.each([
    ['create', '--from', '2026-11-24', '--to', '2026-11-25', '--day-part', 'all_day'],
    ['update', id, '--version', '1', '--clear-note'],
    ['delete', id, '--version', '1'],
  ])('routes %s only to the write executor', async (...args) => {
    const { value, stdout } = runtime([...args, '--json']);
    vi.mocked(executeWrite).mockImplementation(async ({ kind }, host) => {
      expect(kind).toBe(args[0]);
      expect(host.interactive).toBe(false);
      expect(await host.confirm('Never ask on a pipe')).toBe(false);
      return {
        schemaVersion: 1,
        ok: false,
        command: kind,
        error: {
          code: 'PERMISSION',
          message: 'Writes are off in this invocation.',
          requestId: null,
          retryAfterMs: null,
          status: null,
        },
      };
    });
    await expect(runPto(value)).resolves.toBe(4);
    expect(executeCommand).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.text())).toMatchObject({ ok: false, command: args[0] });
  });

  it('presents the given preview on stderr and consumes only an affirmative response', async () => {
    const { value, stdout, stderr, input } = runtime(
      ['delete', id, '--version', '1', '--yes', '--json'],
      { tty: true },
    );
    vi.mocked(executeWrite).mockImplementation(async (_command, host) => {
      expect(host.interactive).toBe(true);
      const consent = host.confirm('Fixture preview');
      expect(stderr.text()).toContain('Fixture preview\nType yes and press Enter to confirm: ');
      input.write('yes\n');
      expect(await consent).toBe(true);
      return {
        schemaVersion: 1,
        ok: true,
        command: 'delete',
        data: { id, ownerId: '11111111-aaaa-4111-8111-000000000001', version: 1 },
      };
    });
    await expect(runPto(value)).resolves.toBe(0);
    expect(stdout.text().split('\n')).toHaveLength(2);
    expect(JSON.parse(stdout.text())).toMatchObject({ ok: true, command: 'delete' });
    expect(stdout.text()).not.toContain('Fixture preview');
    input.destroy();
  });
});

describe('write from a terminal input', () => {
  const id = '11111111-aaaa-4111-8111-000000000002';
  const refusal = 'needs a terminal diagnostic stream to show its preview';

  beforeEach(() => vi.resetAllMocks());

  it.each([
    {
      kind: 'create',
      args: ['create', '--from', '2026-11-24', '--to', '2026-11-25', '--day-part', 'all_day'],
    },
    { kind: 'update', args: ['update', id, '--version', '1', '--clear-note'] },
    { kind: 'delete', args: ['delete', id, '--version', '1'] },
  ])(
    'refuses $kind before the executor and any request, even with --yes',
    async ({ kind, args }) => {
      const { value, stdout, stderr, input } = runtime([...args, '--yes', '--json']);
      input.isTTY = true;
      await expect(runPto(value)).resolves.toBe(2);
      expect(executeWrite).not.toHaveBeenCalled();
      expect(executeCommand).not.toHaveBeenCalled();
      expect(JSON.parse(stdout.text())).toEqual({
        schemaVersion: 1,
        ok: false,
        command: kind,
        error: {
          code: 'USAGE',
          message: expect.stringContaining(refusal),
          status: null,
          requestId: null,
          retryAfterMs: null,
        },
      });
      expect(stdout.text().split('\n')).toHaveLength(2);
      expect(stderr.text()).toMatch(new RegExp(`${refusal}.*\\n$`));
      expect(stdout.text() + stderr.text()).not.toContain('Type yes');
    },
  );

  it('refuses the same write without --yes, and never offers a prompt', async () => {
    const { value, stdout, stderr, input } = runtime(['delete', id, '--version', '1', '--json']);
    input.isTTY = true;
    await expect(runPto(value)).resolves.toBe(2);
    expect(executeWrite).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.text())).toMatchObject({
      ok: false,
      command: 'delete',
      error: { code: 'USAGE' },
    });
    expect(stdout.text() + stderr.text()).not.toContain('Type yes');
  });

  it('reports the refusal in human output on stderr alone', async () => {
    const { value, stdout, stderr, input } = runtime(['delete', id, '--version', '1', '--yes']);
    input.isTTY = true;
    await expect(runPto(value)).resolves.toBe(2);
    expect(executeWrite).not.toHaveBeenCalled();
    expect(stdout.text()).toBe('');
    expect(stderr.text()).toContain(refusal);
  });

  it('hands a non-terminal input to the executor, which decides from --yes alone', async () => {
    const { value, input } = runtime(['delete', id, '--version', '1', '--yes', '--json'], {
      tty: true,
    });
    input.isTTY = false;
    vi.mocked(executeWrite).mockImplementation(async (_command, host) => {
      expect(host.interactive).toBe(false);
      return {
        schemaVersion: 1,
        ok: false,
        command: 'delete',
        error: {
          code: 'PERMISSION',
          message: 'Writes are off in this invocation.',
          requestId: null,
          retryAfterMs: null,
          status: null,
        },
      };
    });
    await expect(runPto(value)).resolves.toBe(4);
    expect(executeWrite).toHaveBeenCalledTimes(1);
  });

  it('keeps reads and auth commands on a terminal input with a piped diagnostic stream', async () => {
    const { value, input } = runtime(['auth', 'status', '--json']);
    input.isTTY = true;
    vi.mocked(executeCommand).mockImplementation(async (_command, context) => {
      expect(context.interactive).toBe(false);
      return {
        schemaVersion: 1,
        ok: false,
        command: 'auth-status',
        error: {
          code: 'AUTH',
          message: 'Set up a profile first.',
          status: null,
          requestId: null,
          retryAfterMs: null,
        },
      };
    });
    await expect(runPto(value)).resolves.toBe(3);
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeWrite).not.toHaveBeenCalled();
  });
});
