import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { PrismaClient } from '@prisma/client';
import { installShutdown, shutdown } from './lifecycle.js';
import { resetEnvForTests } from '../config/env.js';

type MockServer = Pick<Server, 'close' | 'closeAllConnections' | 'closeIdleConnections'>;

function createMockServer(
  opts: { closeBehavior?: (cb: (err?: Error) => void) => void } = {},
): MockServer {
  const close = vi.fn((cb: (err?: Error) => void) => {
    if (opts.closeBehavior) {
      opts.closeBehavior(cb);
      return;
    }
    cb();
  });
  const closeAllConnections = vi.fn();
  const closeIdleConnections = vi.fn();
  return { close, closeAllConnections, closeIdleConnections } as unknown as MockServer;
}

function createMockPrisma(): PrismaClient {
  return {
    $disconnect: vi.fn().mockResolvedValue(undefined),
  } as unknown as PrismaClient;
}

const REQUIRED_ENV = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'aB1!cD2@eF3#gH4$iJ5%kL6&mN7*oP8+',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  SHUTDOWN_TIMEOUT_MS: '500',
};

function snapshotListeners(): {
  SIGTERM: NodeJS.SignalsListener[];
  SIGINT: NodeJS.SignalsListener[];
  uncaughtException: NodeJS.UncaughtExceptionListener[];
  unhandledRejection: NodeJS.UnhandledRejectionListener[];
} {
  return {
    SIGTERM: process.listeners('SIGTERM') as NodeJS.SignalsListener[],
    SIGINT: process.listeners('SIGINT') as NodeJS.SignalsListener[],
    uncaughtException: process.listeners('uncaughtException') as NodeJS.UncaughtExceptionListener[],
    unhandledRejection: process.listeners(
      'unhandledRejection',
    ) as NodeJS.UnhandledRejectionListener[],
  };
}

function restoreListeners(snapshot: ReturnType<typeof snapshotListeners>): void {
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('uncaughtException');
  process.removeAllListeners('unhandledRejection');
  snapshot.SIGTERM.forEach((l) => process.on('SIGTERM', l));
  snapshot.SIGINT.forEach((l) => process.on('SIGINT', l));
  snapshot.uncaughtException.forEach((l) => process.on('uncaughtException', l));
  snapshot.unhandledRejection.forEach((l) => process.on('unhandledRejection', l));
}

function setupExitSpy(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation(((..._args: unknown[]) => {
    return undefined as never;
  }) as never);
}

describe('shutdown', () => {
  let exitSpy: ReturnType<typeof setupExitSpy>;

  beforeEach(() => {
    Object.assign(process.env, REQUIRED_ENV);
    resetEnvForTests();
    exitSpy = setupExitSpy();
  });

  afterEach(() => {
    exitSpy.mockRestore();
    delete process.env.SHUTDOWN_TIMEOUT_MS;
    resetEnvForTests();
  });

  it('calls server.close then prisma.$disconnect and exits 0 on success', async () => {
    const server = createMockServer();
    const prisma = createMockPrisma();

    await shutdown('SIGTERM', server as unknown as Server, prisma);

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('proceeds to disconnect and exits 1 when server.close errors', async () => {
    const server = createMockServer({
      closeBehavior: (cb) => cb(new Error('boom')),
    });
    const prisma = createMockPrisma();

    await shutdown('SIGINT', server as unknown as Server, prisma);

    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('calls closeAllConnections when available', async () => {
    const server = createMockServer();
    const prisma = createMockPrisma();

    await shutdown('SIGTERM', server as unknown as Server, prisma);

    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
  });

  it('calls closeIdleConnections BEFORE awaiting the server.close callback', async () => {
    const calls: string[] = [];
    let pendingCb: ((err?: Error) => void) | undefined;
    const server = {
      close: vi.fn((cb: (err?: Error) => void) => {
        calls.push('close-called');
        pendingCb = cb;
      }),
      closeIdleConnections: vi.fn(() => {
        calls.push('closeIdleConnections');
      }),
      closeAllConnections: vi.fn(() => {
        calls.push('closeAllConnections');
      }),
    } as unknown as MockServer;
    const prisma = createMockPrisma();

    const promise = shutdown('SIGTERM', server as unknown as Server, prisma);
    promise.catch(() => undefined);

    // give the microtask queue a chance to run so closeIdleConnections is observed
    await new Promise((r) => setImmediate(r));

    expect(calls).toEqual(['close-called', 'closeIdleConnections']);
    expect(server.closeAllConnections).not.toHaveBeenCalled();

    pendingCb!();
    await promise;

    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
  });

  it('does not call closeIdleConnections if the server does not implement it', async () => {
    const server = {
      close: vi.fn((cb: (err?: Error) => void) => cb()),
      closeAllConnections: vi.fn(),
    } as unknown as MockServer;
    const prisma = createMockPrisma();

    await shutdown('SIGTERM', server as unknown as Server, prisma);

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
  });

  it('still exits 0 when prisma.$disconnect rejects', async () => {
    const server = createMockServer();
    const prisma = {
      $disconnect: vi.fn().mockRejectedValue(new Error('db disconnect failed')),
    } as unknown as PrismaClient;

    await shutdown('SIGTERM', server as unknown as Server, prisma);

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('forces exit 1 when server.close never drains within the grace period', async () => {
    vi.useFakeTimers();
    let pendingCb: ((err?: Error) => void) | undefined;
    const server = {
      close: vi.fn((cb: (err?: Error) => void) => {
        pendingCb = cb;
      }),
      closeAllConnections: vi.fn(),
    } as unknown as MockServer;
    const prisma = createMockPrisma();

    const promise = shutdown('SIGTERM', server as unknown as Server, prisma);
    promise.catch(() => {});

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(600);

    expect(exitSpy).toHaveBeenCalledWith(1);

    vi.useRealTimers();

    if (pendingCb) pendingCb();
    await promise.catch(() => {});
  });
});

describe('installShutdown', () => {
  let exitSpy: ReturnType<typeof setupExitSpy>;
  let server: MockServer;
  let prisma: PrismaClient;
  let snapshot: ReturnType<typeof snapshotListeners>;

  beforeEach(() => {
    Object.assign(process.env, REQUIRED_ENV);
    resetEnvForTests();
    server = createMockServer();
    prisma = createMockPrisma();
    exitSpy = setupExitSpy();
    snapshot = snapshotListeners();
  });

  afterEach(() => {
    exitSpy.mockRestore();
    restoreListeners(snapshot);
    delete process.env.SHUTDOWN_TIMEOUT_MS;
    resetEnvForTests();
  });

  it('registers SIGTERM, SIGINT, uncaughtException, and unhandledRejection listeners', () => {
    installShutdown(server as unknown as Server, prisma);

    expect(process.listenerCount('SIGTERM')).toBeGreaterThan(0);
    expect(process.listenerCount('SIGINT')).toBeGreaterThan(0);
    expect(process.listenerCount('uncaughtException')).toBeGreaterThan(0);
    expect(process.listenerCount('unhandledRejection')).toBeGreaterThan(0);
  });

  it('triggers shutdown with SIGTERM signal', async () => {
    installShutdown(server as unknown as Server, prisma);

    process.emit('SIGTERM');

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('triggers shutdown with SIGINT signal', async () => {
    installShutdown(server as unknown as Server, prisma);

    process.emit('SIGINT');

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('calls exit(1) on uncaughtException', () => {
    installShutdown(server as unknown as Server, prisma);

    (process.emit as (event: string, ...args: unknown[]) => boolean)(
      'uncaughtException',
      new Error('boom'),
      'uncaughtException',
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('calls exit(1) on unhandledRejection', () => {
    installShutdown(server as unknown as Server, prisma);

    (process.emit as (event: string, ...args: unknown[]) => boolean)(
      'unhandledRejection',
      new Error('rejected'),
      Promise.resolve(),
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
