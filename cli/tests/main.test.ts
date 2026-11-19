import { PassThrough, Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { executeCommand } from '../src/execute-command.js';
import { runPto, type CliRuntime } from '../src/main.js';

vi.mock('../src/execute-command.js', () => ({ executeCommand: vi.fn() }));

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
