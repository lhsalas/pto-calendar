import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listen, info, installShutdown, prisma, server, closeResources } = vi.hoisted(() => ({
  listen: vi.fn(),
  info: vi.fn(),
  installShutdown: vi.fn(),
  prisma: {},
  server: {},
  closeResources: vi.fn(),
}));

vi.mock('./server.js', () => ({ createApp: () => ({ listen, closeResources }) }));
vi.mock('./config/env.js', () => ({ loadEnv: () => ({ PORT: 3000, NODE_ENV: 'test' }) }));
vi.mock('./lib/logger.js', () => ({ logger: { info } }));
vi.mock('./lib/lifecycle.js', () => ({ installShutdown }));
vi.mock('./lib/prisma.js', () => ({ prisma }));

describe('backend startup callback', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    listen.mockReturnValue(server);
  });

  async function start(): Promise<(error?: Error) => void> {
    await import('./index.js');
    expect(listen).toHaveBeenCalledExactlyOnceWith(3000, expect.any(Function));
    expect(installShutdown).toHaveBeenCalledExactlyOnceWith(server, prisma, {
      cleanup: closeResources,
    });
    expect(closeResources).not.toHaveBeenCalled();
    return listen.mock.calls[0]![1] as (error?: Error) => void;
  }

  it('logs readiness only after a successful listen callback', async () => {
    const onListen = await start();
    expect(info).not.toHaveBeenCalled();
    onListen();
    expect(info).toHaveBeenCalledExactlyOnceWith({ port: 3000, env: 'test' }, 'Backend listening');
  });

  it('rethrows an Express 5 listen error into the installed fatal lifecycle', async () => {
    const onListen = await start();
    const bindError = Object.assign(new Error('address already in use'), { code: 'EADDRINUSE' });
    expect(() => onListen(bindError)).toThrow(bindError);
    expect(info).not.toHaveBeenCalled();
    expect(installShutdown).toHaveBeenCalledTimes(1);
  });
});
