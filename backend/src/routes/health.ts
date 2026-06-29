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
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Database query timed out')), env.READY_TIMEOUT_MS);
      timer.unref();
    });
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
    res.json({
      status: 'ready',
      db: 'ok',
      uptime: process.uptime(),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, 'Readiness check failed');
    res.status(503).json({
      error: {
        code: 'NOT_READY',
        message: 'Database unavailable',
        details: { db: 'unreachable', reason },
      },
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
});
