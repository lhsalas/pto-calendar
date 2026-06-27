import express from 'express';
import type { Express } from 'express';
import cors from 'cors';
import { authRouter } from './routes/auth.js';
import { cookieSessionMiddleware } from './middleware/cookieSession.js';
import { errorHandler } from './middleware/errorHandler.js';
import { logger } from './lib/logger.js';
import { loadEnv } from './config/env.js';

export function createApp(): Express {
  const env = loadEnv();
  const app = express();

  app.disable('x-powered-by');
  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieSessionMiddleware());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/auth', authRouter);

  app.use((_req, res) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Resource not found.' },
    });
  });

  app.use(errorHandler);

  return app;
}

export { logger };
