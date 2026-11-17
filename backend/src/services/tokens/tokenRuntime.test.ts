import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTokenDatabase } from './tokenDatabase.js';
import { createTokenRuntime } from './tokenRuntime.js';

vi.mock('./tokenDatabase.js', async () => ({
  ...(await vi.importActual('./tokenDatabase.js')),
  createTokenDatabase: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(createTokenDatabase).mockReset();
});

describe('application-scoped lazy token pool ownership', () => {
  it('does not allocate on construction or cold shutdown and closes its runtime permanently', async () => {
    const runtime = createTokenRuntime('explicit configured URL');
    expect(createTokenDatabase).not.toHaveBeenCalled();
    const closing = runtime.close();
    expect(runtime.close()).toBe(closing);
    await closing;
    expect(createTokenDatabase).not.toHaveBeenCalled();
    expect(() => runtime.get()).toThrow('Token database operation failed');
  });

  it('creates one owned resource across requests and closes it exactly once', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const database = { close } as unknown as ReturnType<typeof createTokenDatabase>;
    vi.mocked(createTokenDatabase).mockReturnValueOnce(database);
    const runtime = createTokenRuntime('configured socket URL');
    expect(runtime.get()).toBe(database);
    expect(runtime.get()).toBe(database);
    expect(createTokenDatabase).toHaveBeenCalledExactlyOnceWith('configured socket URL');
    const first = runtime.close();
    expect(runtime.close()).toBe(first);
    await first;
    expect(close).toHaveBeenCalledOnce();
    expect(() => runtime.get()).toThrow();
  });

  it('preserves safe failure and rejects reuse after a failed close', async () => {
    const close = vi.fn().mockRejectedValue(new Error('safe database failure'));
    vi.mocked(createTokenDatabase).mockReturnValueOnce({ close } as unknown as ReturnType<
      typeof createTokenDatabase
    >);
    const runtime = createTokenRuntime('configured URL');
    runtime.get();
    await expect(runtime.close()).rejects.toThrow('safe database failure');
    await expect(runtime.close()).rejects.toThrow('safe database failure');
    expect(close).toHaveBeenCalledOnce();
    expect(() => runtime.get()).toThrow();
  });
});
