import { afterEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { runSeed } from '../../../prisma/seed.js';

describe('development seed guard', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it('refuses to run in production', async () => {
    process.env.NODE_ENV = 'production';
    const prisma = { user: { upsert: vi.fn() } };

    await expect(runSeed(prisma as never)).rejects.toThrow(
      'Development seed is disabled in production; use db:bootstrap instead.',
    );
    expect(prisma.user.upsert).not.toHaveBeenCalled();
  });

  it('invalidates credentials only when the seeded role or password changes', async () => {
    process.env.NODE_ENV = 'test';
    const lead = await bcrypt.hash('lead-dev-password', 4);
    const unchanged = await bcrypt.hash('dev1-dev-password', 4);
    const changed = await bcrypt.hash('other-password', 4);
    const upsert = vi
      .fn()
      .mockResolvedValueOnce({ id: 'lead', role: 'member', passwordHash: lead })
      .mockResolvedValueOnce({ id: 'one', role: 'member', passwordHash: unchanged })
      .mockResolvedValueOnce({ id: 'two', role: 'member', passwordHash: changed });
    const update = vi.fn().mockResolvedValue({});
    const tx = { user: { upsert, update } };
    const prisma = {
      $transaction: vi.fn((callback: (value: typeof tx) => unknown) => callback(tx)),
    };
    await runSeed(prisma as never);
    expect(update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({ sessionVersion: { increment: 1 } }),
      }),
    );
    expect(update.mock.calls[1]![0].data).not.toHaveProperty('sessionVersion');
    expect(update).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        data: expect.objectContaining({ sessionVersion: { increment: 1 } }),
      }),
    );
  });
});
