import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { AgentAuthError } from '../src/errors.js';
import { MAX_SECRET_BYTES, readSecretInput, type SecretInputSource } from '../src/secret-input.js';

/** A fake credential. It is never a real token. */
const TOKEN = `pto_pat_11111111-1111-4111-8111-111111111111.${'a'.repeat(64)}`;

/** A synthetic terminal. It never touches a real terminal. */
interface FakeTerminal extends PassThrough {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
  rawModeCalls: boolean[];
}

interface TerminalOptions {
  readonly isTTY: boolean;
  readonly withRawMode?: boolean;
  /** Which call of the raw mode fails. */
  readonly rawModeFailure?: 'enter' | 'restore' | 'always';
}

function createTerminal(options: TerminalOptions): FakeTerminal {
  const stream = new PassThrough() as FakeTerminal;
  stream.isTTY = options.isTTY;
  stream.rawModeCalls = [];
  if (options.withRawMode !== false) {
    stream.setRawMode = (mode: boolean): void => {
      stream.rawModeCalls.push(mode);
      if (options.rawModeFailure === 'always') throw new Error('raw mode refused');
      if (options.rawModeFailure === 'enter' && mode) throw new Error('raw mode refused');
      if (options.rawModeFailure === 'restore' && !mode) throw new Error('raw mode refused');
      stream.isRaw = mode;
    };
  }
  return stream;
}

/** The code of a failure. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof AgentAuthError ? error.code : 'unknown';
  }
  return 'none';
}

describe('reading a secret from a pipe', () => {
  it('reads one line', async () => {
    const stream = createTerminal({ isTTY: false });

    const promise = readSecretInput({ mode: 'stdin', input: stream });
    stream.write(`${TOKEN}\n`);
    stream.end();

    await expect(promise).resolves.toBe(TOKEN);
  });

  it('reads a line that ends with a carriage return', async () => {
    const stream = createTerminal({ isTTY: false });

    const promise = readSecretInput({ mode: 'stdin', input: stream });
    stream.write(`${TOKEN}\r\n`);
    stream.end();

    await expect(promise).resolves.toBe(TOKEN);
  });

  it('reads a line that arrives in pieces', async () => {
    const stream = createTerminal({ isTTY: false });

    const promise = readSecretInput({ mode: 'stdin', input: stream });
    stream.write(TOKEN.slice(0, 10));
    stream.write(`${TOKEN.slice(10)}\n`);
    stream.end();

    await expect(promise).resolves.toBe(TOKEN);
  });

  it('reads a line that arrives as text', async () => {
    const stream = createTerminal({ isTTY: false });
    stream.setEncoding('utf8');

    const promise = readSecretInput({ mode: 'stdin', input: stream });
    stream.write(`${TOKEN}\n`);
    stream.end();

    await expect(promise).resolves.toBe(TOKEN);
  });

  it('refuses a terminal', async () => {
    const stream = createTerminal({ isTTY: true });

    await expect(readSecretInput({ mode: 'stdin', input: stream })).rejects.toMatchObject({
      code: 'INPUT_UNAVAILABLE',
    });
  });

  it('refuses an input that is too long', async () => {
    const stream = createTerminal({ isTTY: false });

    const promise = readSecretInput({ mode: 'stdin', input: stream });
    stream.write('x'.repeat(MAX_SECRET_BYTES + 1));

    await expect(promise).rejects.toMatchObject({ code: 'INPUT_UNAVAILABLE' });
  });

  it('counts every chunk toward the same input limit', async () => {
    const stream = createTerminal({ isTTY: false });
    const promise = readSecretInput({ mode: 'stdin', input: stream });
    stream.write('x'.repeat(MAX_SECRET_BYTES));
    stream.end('\n');
    await expect(promise).rejects.toMatchObject({ code: 'INPUT_UNAVAILABLE' });
  });

  it('refuses a line that is too long', async () => {
    const stream = createTerminal({ isTTY: false });

    const promise = readSecretInput({ mode: 'stdin', input: stream });
    stream.write(`${'x'.repeat(MAX_SECRET_BYTES + 1)}\n`);

    await expect(promise).rejects.toMatchObject({ code: 'INPUT_UNAVAILABLE' });
  });

  it('refuses a second line in the same chunk', async () => {
    const stream = createTerminal({ isTTY: false });

    const promise = readSecretInput({ mode: 'stdin', input: stream });
    stream.write(`${TOKEN}\n${TOKEN}\n`);
    stream.end();

    await expect(promise).rejects.toMatchObject({ code: 'INPUT_UNAVAILABLE' });
  });

  it('refuses a second line that arrives later', async () => {
    const stream = createTerminal({ isTTY: false });

    const promise = readSecretInput({ mode: 'stdin', input: stream });
    stream.write(`${TOKEN}\n`);
    stream.write(`${TOKEN}\n`);
    stream.end();

    await expect(promise).rejects.toMatchObject({ code: 'INPUT_UNAVAILABLE' });
  });

  it('refuses a second empty line', async () => {
    const stream = createTerminal({ isTTY: false });

    const promise = readSecretInput({ mode: 'stdin', input: stream });
    stream.write(`${TOKEN}\n\n`);
    stream.end();

    await expect(promise).rejects.toMatchObject({ code: 'INPUT_UNAVAILABLE' });
  });

  it('refuses anything after the line marker', async () => {
    const stream = createTerminal({ isTTY: false });

    const promise = readSecretInput({ mode: 'stdin', input: stream });
    stream.write(`${TOKEN}\n `);
    stream.end();

    await expect(promise).rejects.toMatchObject({ code: 'INPUT_UNAVAILABLE' });
  });

  it('refuses an input that ends before a line is complete', async () => {
    const stream = createTerminal({ isTTY: false });

    const promise = readSecretInput({ mode: 'stdin', input: stream });
    stream.write(TOKEN);
    stream.end();

    await expect(promise).rejects.toMatchObject({ code: 'INPUT_REQUIRED' });
  });

  it('refuses an empty line', async () => {
    const stream = createTerminal({ isTTY: false });

    const promise = readSecretInput({ mode: 'stdin', input: stream });
    stream.write('\n');
    stream.end();

    await expect(promise).rejects.toMatchObject({ code: 'INPUT_REQUIRED' });
  });

  it('refuses a line that is not a credential', async () => {
    const stream = createTerminal({ isTTY: false });

    const promise = readSecretInput({ mode: 'stdin', input: stream });
    stream.write('not a credential\n');
    stream.end();

    await expect(promise).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('stops when the read is cancelled', async () => {
    const stream = createTerminal({ isTTY: false });
    const controller = new AbortController();

    const promise = readSecretInput({ mode: 'stdin', input: stream, signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: 'INPUT_CANCELLED' });
  });

  it('refuses a read that was cancelled before it started', async () => {
    const stream = createTerminal({ isTTY: false });
    const controller = new AbortController();
    controller.abort();

    await expect(
      readSecretInput({ mode: 'stdin', input: stream, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'INPUT_CANCELLED' });
  });

  it('reports a source that fails', async () => {
    const stream = createTerminal({ isTTY: false });

    const promise = readSecretInput({ mode: 'stdin', input: stream });
    stream.emit('error', new Error('the source failed'));

    await expect(promise).rejects.toMatchObject({ code: 'INPUT_UNAVAILABLE' });
    // The listeners are gone and the stream is left as it was found.
    expect(stream.listenerCount('data')).toBe(0);
    expect(stream.listenerCount('end')).toBe(0);
  });

  it('does not let a later failure of the source escape', async () => {
    const stream = createTerminal({ isTTY: false });

    const promise = readSecretInput({ mode: 'stdin', input: stream });
    stream.write(`${TOKEN}\n`);
    stream.end();
    await expect(promise).resolves.toBe(TOKEN);

    expect(() => stream.emit('error', new Error('a late failure'))).not.toThrow();
  });

  it('reports a source that goes away', async () => {
    const stream = createTerminal({ isTTY: false });

    const promise = readSecretInput({ mode: 'stdin', input: stream });
    stream.destroy();

    await expect(promise).rejects.toMatchObject({ code: 'INPUT_REQUIRED' });
  });

  it('refuses a source that already ended', async () => {
    const stream = createTerminal({ isTTY: false });
    stream.end(`${TOKEN}\n`);
    await new Promise<void>((resolve) => {
      stream.on('end', () => resolve());
      stream.resume();
    });

    await expect(readSecretInput({ mode: 'stdin', input: stream })).rejects.toMatchObject({
      code: 'INPUT_REQUIRED',
    });
  });

  it('refuses a source that is already gone', async () => {
    const stream = createTerminal({ isTTY: false });
    stream.destroy();

    await expect(readSecretInput({ mode: 'stdin', input: stream })).rejects.toMatchObject({
      code: 'INPUT_UNAVAILABLE',
    });
  });

  it('refuses a source that another reader already consumes', async () => {
    const stream = createTerminal({ isTTY: false });
    stream.on('data', () => undefined);

    await expect(readSecretInput({ mode: 'stdin', input: stream })).rejects.toMatchObject({
      code: 'INPUT_UNAVAILABLE',
    });
  });

  it('refuses a concurrent readable consumer before consuming a secret', async () => {
    const stream = createTerminal({ isTTY: false });
    stream.on('readable', () => undefined);
    await expect(readSecretInput({ mode: 'stdin', input: stream })).rejects.toMatchObject({
      code: 'INPUT_UNAVAILABLE',
    });
    expect(stream.listenerCount('data')).toBe(0);
  });

  it('rejects object-mode chunks and oversized encoded text without reporting their contents', async () => {
    const objectMode = new PassThrough({ objectMode: true });
    const objectRead = readSecretInput({ mode: 'stdin', input: objectMode });
    objectMode.end({ synthetic: TOKEN });
    await expect(objectRead).rejects.toMatchObject({ code: 'INPUT_UNAVAILABLE' });

    const encoded = createTerminal({ isTTY: false });
    encoded.setEncoding('utf8');
    const textRead = readSecretInput({ mode: 'stdin', input: encoded });
    encoded.end('ø'.repeat(140));
    await expect(textRead).rejects.toMatchObject({ code: 'INPUT_UNAVAILABLE' });
  });

  it.each(['stdin', 'tty'] as const)(
    'cleans up if a %s stream fails to start flowing',
    async (mode) => {
      const stream = createTerminal({ isTTY: mode === 'tty' });
      const failure = new Error(TOKEN);
      stream.resume = () => {
        throw failure;
      };

      const result = await readSecretInput({ mode, input: stream }).catch(
        (error: unknown) => error,
      );
      expect(result).toMatchObject({ code: 'INPUT_UNAVAILABLE' });
      expect(result).not.toBe(failure);
      for (const name of ['data', 'end', 'close']) expect(stream.listenerCount(name)).toBe(0);
      if (mode === 'tty') expect(stream.rawModeCalls).toEqual([true, false]);
    },
  );

  it('uses the standard input when no stream is named', async () => {
    const stream = createTerminal({ isTTY: false });
    const previous = process.stdin;
    Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
    try {
      const promise = readSecretInput({ mode: 'stdin' });
      stream.write(`${TOKEN}\n`);
      stream.end();
      await expect(promise).resolves.toBe(TOKEN);
    } finally {
      Object.defineProperty(process, 'stdin', { value: previous, configurable: true });
    }
  });

  it('puts the stream back the way it was found', async () => {
    const paused = createTerminal({ isTTY: false });
    paused.pause();

    const first = readSecretInput({ mode: 'stdin', input: paused });
    paused.write(`${TOKEN}\n`);
    paused.end();

    await expect(first).resolves.toBe(TOKEN);
    expect(paused.readableFlowing).toBe(false);

    const flowing = createTerminal({ isTTY: false });
    flowing.resume();

    const second = readSecretInput({ mode: 'stdin', input: flowing });
    flowing.write(`${TOKEN}\n`);
    flowing.end();

    await expect(second).resolves.toBe(TOKEN);
    expect(flowing.readableFlowing).toBe(true);
  });

  it('never claims a read that the stream could not be put back from', async () => {
    const stream = createTerminal({ isTTY: false });
    stream.pause = (): never => {
      throw new Error('the stream cannot be paused');
    };

    const promise = readSecretInput({ mode: 'stdin', input: stream });
    stream.write(`${TOKEN}\n`);
    stream.end();

    await expect(promise).rejects.toMatchObject({ code: 'INPUT_UNAVAILABLE' });
  });
});

describe('reading a secret from a terminal', () => {
  it('retains only one late-error guard across multiple exclusive entries', async () => {
    const stream = createTerminal({ isTTY: true });
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const result = readSecretInput({ mode: 'tty', input: stream });
      stream.write(Buffer.from([0x03]));
      await expect(result).rejects.toMatchObject({ code: 'INPUT_CANCELLED' });
      expect(stream.listenerCount('error')).toBe(1);
    }
  });

  it('rejects an unexpected terminal chunk and restores raw mode', async () => {
    const stream = createTerminal({ isTTY: true });
    const result = readSecretInput({ mode: 'tty', input: stream });
    stream.emit('data', { synthetic: TOKEN });
    await expect(result).rejects.toMatchObject({ code: 'INPUT_UNAVAILABLE' });
    expect(stream.rawModeCalls).toEqual([true, false]);
  });

  it('bounds the assembled secret across terminal chunks', async () => {
    const stream = createTerminal({ isTTY: true });
    const result = readSecretInput({ mode: 'tty', input: stream });
    stream.write('x'.repeat(MAX_SECRET_BYTES));
    stream.write('y');
    await expect(result).rejects.toMatchObject({ code: 'INPUT_UNAVAILABLE' });
    expect(stream.rawModeCalls).toEqual([true, false]);
  });

  it('reads a hidden line and restores the terminal', async () => {
    const stream = createTerminal({ isTTY: true });

    const promise = readSecretInput({ mode: 'tty', input: stream });
    stream.write(TOKEN);
    stream.write('\r');

    await expect(promise).resolves.toBe(TOKEN);
    // The raw mode was entered and put back the way it was found.
    expect(stream.rawModeCalls).toEqual([true, false]);
    expect(stream.isRaw).toBe(false);
  });

  it('reads the line only after the raw mode is enabled', async () => {
    const stream = createTerminal({ isTTY: true });
    const seen: boolean[] = [];
    stream.on('newListener', (event: string) => {
      if (event === 'data') seen.push(stream.rawModeCalls.length > 0);
    });

    const promise = readSecretInput({ mode: 'tty', input: stream });
    stream.write(`${TOKEN}\r`);

    await expect(promise).resolves.toBe(TOKEN);
    expect(seen).toEqual([true]);
  });

  it('erases the last character', async () => {
    const stream = createTerminal({ isTTY: true });

    const promise = readSecretInput({ mode: 'tty', input: stream });
    stream.write(`${TOKEN}x`);
    stream.write('\x7f');
    stream.write('\r');

    await expect(promise).resolves.toBe(TOKEN);
  });

  it('erases the last character with the older key', async () => {
    const stream = createTerminal({ isTTY: true });

    const promise = readSecretInput({ mode: 'tty', input: stream });
    stream.write(`${TOKEN}x`);
    stream.write('\x08');
    stream.write('\r');

    await expect(promise).resolves.toBe(TOKEN);
  });

  it('cancels on the cancel key and restores the terminal', async () => {
    const stream = createTerminal({ isTTY: true });

    const promise = readSecretInput({ mode: 'tty', input: stream });
    stream.write('\x03');

    await expect(promise).rejects.toMatchObject({ code: 'INPUT_CANCELLED' });
    expect(stream.rawModeCalls).toEqual([true, false]);
  });

  it('refuses a control character or an escape sequence', async () => {
    const stream = createTerminal({ isTTY: true });

    const promise = readSecretInput({ mode: 'tty', input: stream });
    stream.write('\x1b');

    await expect(promise).rejects.toMatchObject({ code: 'INPUT_UNAVAILABLE' });
    expect(stream.rawModeCalls).toEqual([true, false]);
  });

  it('refuses a character that is not printable', async () => {
    const stream = createTerminal({ isTTY: true });

    const promise = readSecretInput({ mode: 'tty', input: stream });
    stream.write('\xff');

    await expect(promise).rejects.toMatchObject({ code: 'INPUT_UNAVAILABLE' });
  });

  it('refuses a secret that is too long', async () => {
    const stream = createTerminal({ isTTY: true });

    const promise = readSecretInput({ mode: 'tty', input: stream });
    stream.write('x'.repeat(MAX_SECRET_BYTES + 1));

    await expect(promise).rejects.toMatchObject({ code: 'INPUT_UNAVAILABLE' });
  });

  it('refuses a stream that is not a terminal', async () => {
    const stream = createTerminal({ isTTY: false });

    await expect(readSecretInput({ mode: 'tty', input: stream })).rejects.toMatchObject({
      code: 'INPUT_UNAVAILABLE',
    });
  });

  it('refuses a terminal that cannot hide its input', async () => {
    const stream = createTerminal({ isTTY: true, withRawMode: false });

    await expect(readSecretInput({ mode: 'tty', input: stream })).rejects.toMatchObject({
      code: 'INPUT_UNAVAILABLE',
    });
  });

  it('refuses a terminal that cannot enter its raw mode', async () => {
    const stream = createTerminal({ isTTY: true, rawModeFailure: 'enter' });

    await expect(readSecretInput({ mode: 'tty', input: stream })).rejects.toMatchObject({
      code: 'INPUT_UNAVAILABLE',
    });
  });

  it('never claims a read that the terminal could not be put back from', async () => {
    const stream = createTerminal({ isTTY: true, rawModeFailure: 'restore' });

    const promise = readSecretInput({ mode: 'tty', input: stream });
    stream.write(`${TOKEN}\r`);

    await expect(promise).rejects.toMatchObject({ code: 'INPUT_UNAVAILABLE' });
    expect(stream.rawModeCalls).toEqual([true, false]);
  });

  it('never claims a read that the terminal flow could not be put back from', async () => {
    const stream = createTerminal({ isTTY: true });
    stream.pause = (): never => {
      throw new Error('the terminal cannot be paused');
    };

    const promise = readSecretInput({ mode: 'tty', input: stream });
    stream.write(`${TOKEN}\r`);

    await expect(promise).rejects.toMatchObject({ code: 'INPUT_UNAVAILABLE' });
  });

  it('stops when the read is cancelled', async () => {
    const stream = createTerminal({ isTTY: true });
    const controller = new AbortController();

    const promise = readSecretInput({ mode: 'tty', input: stream, signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: 'INPUT_CANCELLED' });
    expect(stream.rawModeCalls).toEqual([true, false]);
  });

  it('refuses a read that was cancelled before it started', async () => {
    const stream = createTerminal({ isTTY: true });
    const controller = new AbortController();
    controller.abort();

    await expect(
      readSecretInput({ mode: 'tty', input: stream, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'INPUT_CANCELLED' });
    // The terminal was never put into its raw mode, so it is left alone.
    expect(stream.rawModeCalls).toEqual([]);
  });

  it('reports a terminal that fails', async () => {
    const stream = createTerminal({ isTTY: true });

    const promise = readSecretInput({ mode: 'tty', input: stream });
    stream.emit('error', new Error('the terminal failed'));

    await expect(promise).rejects.toMatchObject({ code: 'INPUT_UNAVAILABLE' });
    expect(stream.rawModeCalls).toEqual([true, false]);
  });

  it('reports a terminal that goes away', async () => {
    const stream = createTerminal({ isTTY: true });

    const promise = readSecretInput({ mode: 'tty', input: stream });
    stream.destroy();

    await expect(promise).rejects.toMatchObject({ code: 'INPUT_REQUIRED' });
    expect(stream.rawModeCalls).toEqual([true, false]);
  });

  it('reports a terminal that ends without a line', async () => {
    const stream = createTerminal({ isTTY: true });

    const promise = readSecretInput({ mode: 'tty', input: stream });
    stream.end();

    await expect(promise).rejects.toMatchObject({ code: 'INPUT_REQUIRED' });
    expect(stream.rawModeCalls).toEqual([true, false]);
    expect(stream.listenerCount('data')).toBe(0);
  });

  it('does not let a later failure of the terminal escape', async () => {
    const stream = createTerminal({ isTTY: true });

    const promise = readSecretInput({ mode: 'tty', input: stream });
    stream.write(`${TOKEN}\r`);
    await expect(promise).resolves.toBe(TOKEN);

    expect(() => stream.emit('error', new Error('a late failure'))).not.toThrow();
  });

  it('refuses a terminal that already ended', async () => {
    const stream = createTerminal({ isTTY: true });
    stream.end();
    await new Promise<void>((resolve) => {
      stream.on('end', () => resolve());
      stream.resume();
    });

    await expect(readSecretInput({ mode: 'tty', input: stream })).rejects.toMatchObject({
      code: 'INPUT_REQUIRED',
    });
  });

  it('refuses a terminal that is already gone', async () => {
    const stream = createTerminal({ isTTY: true });
    stream.destroy();

    await expect(readSecretInput({ mode: 'tty', input: stream })).rejects.toMatchObject({
      code: 'INPUT_UNAVAILABLE',
    });
  });

  it('refuses a terminal that another reader already consumes', async () => {
    const stream = createTerminal({ isTTY: true });
    stream.on('data', () => undefined);

    await expect(readSecretInput({ mode: 'tty', input: stream })).rejects.toMatchObject({
      code: 'INPUT_UNAVAILABLE',
    });
  });

  it('refuses a line that is not a credential', async () => {
    const stream = createTerminal({ isTTY: true });

    const promise = readSecretInput({ mode: 'tty', input: stream });
    stream.write('not a credential');
    stream.write('\r');

    await expect(promise).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });
});

describe('the reader it accepts', () => {
  it('refuses options it cannot use', async () => {
    const stream = createTerminal({ isTTY: false });

    expect(await codeOf(readSecretInput(null as unknown as { mode: 'stdin' }))).toBe(
      'INVALID_OPTIONS',
    );
    expect(
      await codeOf(readSecretInput({ mode: 'pipe' as unknown as 'stdin', input: stream })),
    ).toBe('INVALID_OPTIONS');
    expect(
      await codeOf(
        readSecretInput({
          mode: 'stdin',
          input: stream,
          signal: {} as unknown as AbortSignal,
        }),
      ),
    ).toBe('INVALID_OPTIONS');
    expect(
      await codeOf(
        readSecretInput({ mode: 'stdin', input: 'not a stream' as unknown as SecretInputSource }),
      ),
    ).toBe('INPUT_UNAVAILABLE');
    expect(
      await codeOf(readSecretInput({ mode: 'stdin', input: null as unknown as SecretInputSource })),
    ).toBe('INPUT_UNAVAILABLE');
    expect(
      await codeOf(
        readSecretInput({
          mode: 'stdin',
          input: { isTTY: false } as unknown as SecretInputSource,
        }),
      ),
    ).toBe('INPUT_UNAVAILABLE');
  });

  it('never writes to the output', async () => {
    const stream = createTerminal({ isTTY: false });
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const promise = readSecretInput({ mode: 'stdin', input: stream });
      stream.write(`${TOKEN}\n`);
      stream.end();
      await expect(promise).resolves.toBe(TOKEN);
      expect(out).not.toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
