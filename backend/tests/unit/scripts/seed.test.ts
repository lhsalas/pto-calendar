import { afterEach, describe, expect, it, vi } from 'vitest';
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
});
