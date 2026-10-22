import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { loadEnv } from '../config/env.js';
import { logger } from '../lib/logger.js';

export const healthRouter: Router = Router();

healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

healthRouter.get('/ready', async (_req, res) => {
  const env = loadEnv();
  // The timer is always created, so it is cleared unconditionally below. The
  // promise is built first so the timeout can reject it later.
  let rejectTimeout: (reason: Error) => void = () => undefined;
  const timeout = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    rejectTimeout(new Error('Database query timed out'));
  }, env.READY_TIMEOUT_MS);
  timer.unref();
  try {
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
    res.json({
      status: 'ready',
      db: 'ok',
      uptime: process.uptime(),
    });
  } catch (err) {
    logger.warn({ err }, 'Readiness check failed');
    res.status(503).json({
      error: {
        code: 'NOT_READY',
        message: 'Database unavailable',
        details: { db: 'unreachable' },
      },
    });
  } finally {
    clearTimeout(timer);
  }
});
