import { PassThrough, Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Runtime } from '../src/contract.js';
import { parseLaunch, runMcp } from '../src/main.js';
import { serve } from '../src/server.js';

vi.mock('../src/server.js', () => ({ serve: vi.fn() }));

function runtime(args: string[] = [], fail = false) {
  let output = '';
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new Writable({
    write(text: Buffer, _encoding, done) {
      if (fail) throw new Error('private output cause');
      output += text.toString();
      done();
    },
  });
  const supplied: Runtime = {
    args,
    stdin,
    stdout,
    stderr,
    env: {},
    signal: new AbortController().signal,
    version: '0.1.0',
  };
  return { supplied, diagnostic: () => output };
}

describe('MCP launch options', () => {
  it.each([
    { args: [], expected: { allowLoopbackHttp: false } },
    { args: ['--profile', 'work'], expected: { profile: 'work', allowLoopbackHttp: false } },
    {
      args: ['--allow-loopback-http', '--profile=test-0'],
      expected: { profile: 'test-0', allowLoopbackHttp: true },
    },
  ])('admits only the exact local launch options ($args)', ({ args, expected }) => {
    expect(parseLaunch(args)).toEqual(expected);
  });

  it.each([
    { args: ['--profile', '../invalid'] },
    { args: ['--profile', 'a', '--profile', 'a'] },
    { args: ['--profile', 'a'.repeat(33)] },
    { args: ['--allow-loopback-http', '--allow-loopback-http'] },
    { args: ['--allow-loopback-http=true'] },
    { args: ['--profile'] },
    { args: ['--'] },
    { args: ['secret-value'] },
    { args: ['--url=https://api.example.invalid'] },
  ])('rejects invalid or excess input ($args)', ({ args }) => {
    expect(parseLaunch(args)).toBe(null);
  });
});

describe('MCP startup', () => {
  beforeEach(() => vi.resetAllMocks());

  it('diagnoses bad configuration without its values or stdout', async () => {
    const { supplied, diagnostic } = runtime(['--credential=secret-value']);
    await expect(runMcp(supplied)).resolves.toBe(2);
    expect(diagnostic()).toContain('local stdio');
    expect(diagnostic()).not.toContain('secret-value');
    expect(supplied.stdout).toMatchObject({ readableLength: 0 });
    expect(serve).not.toHaveBeenCalled();
  });

  it('passes only the parsed launch options and preserves the server exit', async () => {
    const { supplied, diagnostic } = runtime(['--profile', 'test']);
    vi.mocked(serve).mockResolvedValue(0);
    await expect(runMcp(supplied)).resolves.toBe(0);
    expect(serve).toHaveBeenCalledExactlyOnceWith(supplied, {
      profile: 'test',
      allowLoopbackHttp: false,
    });
    expect(diagnostic()).toBe('');
  });

  it.each([true, false])('never sends a startup exception to stdout (%s)', async (fail) => {
    const { supplied, diagnostic } = runtime([], fail);
    vi.mocked(serve).mockRejectedValue(new Error('private startup cause'));
    await expect(runMcp(supplied)).resolves.toBe(10);
    expect(supplied.stdout).toMatchObject({ readableLength: 0 });
    expect(diagnostic()).toBe(
      fail ? '' : 'The local PTO tool server could not start. Verify the local setup.\n',
    );
  });
});
