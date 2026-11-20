import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { confirmWrite } from '../src/confirmation.js';

const PREVIEW = 'Actor (live): fixture; target: an exact record';

function terminal(isTTY = true) {
  const input = Object.assign(new PassThrough(), { isTTY });
  const aborter = new AbortController();
  const present = vi.fn(async (_text: string): Promise<void> => undefined);
  return {
    input,
    aborter,
    present,
    run: (stderr = true) => confirmWrite(input, stderr, aborter.signal, present, PREVIEW),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('write consent on an existing terminal', () => {
  it.each([
    { answer: ['yes\n'], approves: true },
    { answer: ['y', 'e', 's', '\r', '\n'], approves: true },
    { answer: ['y\n'], approves: false },
    { answer: ['no\n'], approves: false },
    { answer: ['yes\nno\n'], approves: false },
    { answer: [' yes\n'], approves: false },
    { answer: ['yes', ' '], approves: false },
    { answer: ['yes\r', '\n'], approves: true },
  ])('only accepts an exact yes line ($answer)', async ({ answer, approves }) => {
    const { input, present, run } = terminal();
    const confirmation = run();
    expect(input.listenerCount('data')).toBe(0);
    await Promise.resolve();
    expect(present).toHaveBeenCalledWith(`${PREVIEW}\nType yes and press Enter to confirm: `);
    for (const value of answer) input.write(Buffer.from(value, 'ascii'));
    await expect(confirmation).resolves.toBe(approves);
    expect(input.listenerCount('data')).toBe(0);
    expect(input.isPaused()).toBe(true);
    input.destroy();
  });

  it('also refuses cancelled or partial text from a pre-encoded terminal', async () => {
    const { input, run } = terminal();
    input.setEncoding('utf8');
    const result = run();
    await Promise.resolve();
    input.end('yes');
    await expect(result).resolves.toBe(false);
    expect(input.listenerCount('data')).toBe(0);
  });

  it.each(['not-input-tty', 'not-diagnostic-tty', 'closed', 'ended', 'data', 'readable', 'abort'])(
    'refuses to consume %s before showing the question',
    async (mode) => {
      const { input, aborter, present, run } = terminal(mode !== 'not-input-tty');
      if (mode === 'closed') input.destroy();
      if (mode === 'ended') {
        input.end();
        for await (const _chunk of input) {
          // No input is expected; drain to observe EOF.
        }
      }
      if (mode === 'data') input.on('data', () => undefined);
      if (mode === 'readable') input.on('readable', () => undefined);
      if (mode === 'abort') aborter.abort();
      await expect(run(mode !== 'not-diagnostic-tty')).resolves.toBe(false);
      expect(present).not.toHaveBeenCalled();
      input.destroy();
    },
  );

  it('stops for an abort while presenting the preview', async () => {
    const { input, aborter, present, run } = terminal();
    present.mockImplementation(async () => aborter.abort());
    await expect(run()).resolves.toBe(false);
    expect(input.listenerCount('data')).toBe(0);
    input.destroy();
  });

  it.each(['close', 'end', 'error', 'abort', 'deadline'] as const)(
    'refuses after %s while awaiting input',
    async (mode) => {
      const deadline = new AbortController();
      const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
      const { input, aborter, run } = terminal();
      const decision = run();
      await Promise.resolve();
      if (mode === 'close') input.destroy();
      if (mode === 'end') input.end();
      if (mode === 'error') input.emit('error', new Error('opaque fixture'));
      if (mode === 'abort') aborter.abort();
      if (mode === 'deadline') deadline.abort();
      await expect(decision).resolves.toBe(false);
      expect(timeout).toHaveBeenCalledWith(120_000);
      expect(input.listenerCount('close')).toBe(0);
      expect(input.listenerCount('error')).toBe(0);
      input.destroy();
    },
  );

  it('does not read any input when the diagnostic stream failed', async () => {
    const { input, present, run } = terminal();
    present.mockRejectedValue(new Error('diagnostic write failed'));
    await expect(run()).rejects.toThrow('diagnostic write failed');
    expect(input.listenerCount('data')).toBe(0);
    input.destroy();
  });
});
