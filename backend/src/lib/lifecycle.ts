import type { Server } from 'node:http';
import type { PrismaClient } from '@prisma/client';
import { logger } from './logger.js';
import { loadEnv } from '../config/env.js';

export type ShutdownFn = (signal: NodeJS.Signals) => Promise<void>;

export interface LifecycleOptions {
  graceMs?: number;
}

function forceExit(code: number, message: string, meta?: Record<string, unknown>): void {
  logger.fatal({ ...meta, exitCode: code }, message);
  process.exit(code);
}

export async function shutdown(
  signal: NodeJS.Signals,
  server: Server,
  prisma: PrismaClient,
  options: LifecycleOptions = {},
): Promise<void> {
  const env = loadEnv();
  const graceMs = options.graceMs ?? env.SHUTDOWN_TIMEOUT_MS;

  logger.info({ signal, graceMs }, 'Shutdown initiated');

  const timer = setTimeout(() => {
    forceExit(1, 'Shutdown timed out — forcing exit', { signal, graceMs });
  }, graceMs);
  timer.unref();

  let closeError: Error | undefined;
  const closePromise = new Promise<void>((resolve) => {
    server.close((err) => {
      closeError = err ?? undefined;
      resolve();
    });
  });

  // Close idle keep-alive peers immediately so the server.close() callback
  // can resolve without waiting for the keep-alive timeout. In-flight
  // requests still complete naturally; only idle sockets are terminated.
  if (typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections();
  }

  await closePromise;

  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }

  if (closeError) {
    logger.error({ err: closeError }, 'Error closing HTTP server');
  }

  try {
    await prisma.$disconnect();
    logger.info('Prisma disconnected');
  } catch (err) {
    logger.error({ err }, 'Error disconnecting Prisma');
  }

  clearTimeout(timer);

  process.exit(closeError ? 1 : 0);
}

export function installShutdown(
  server: Server,
  prisma: PrismaClient,
  options: LifecycleOptions = {},
): void {
  if (typeof (globalThis as { Deno?: unknown }).Deno !== 'undefined') {
    return;
  }

  const handler: ShutdownFn = (signal) => shutdown(signal, server, prisma, options);

  process.on('SIGTERM', () => {
    void handler('SIGTERM');
  });
  process.on('SIGINT', () => {
    void handler('SIGINT');
  });
  process.on('uncaughtException', (err, origin) => {
    forceExit(1, 'Uncaught exception', { err, origin });
  });
  process.on('unhandledRejection', (reason) => {
    forceExit(1, 'Unhandled rejection', { err: reason });
  });
}
