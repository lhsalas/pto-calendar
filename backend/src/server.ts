import express from 'express';
import type { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import { createAuthRouter } from './routes/auth.js';
import { ptoRouter } from './routes/pto.js';
import { healthRouter } from './routes/health.js';
import { cookieSessionMiddleware } from './middleware/cookieSession.js';
import { errorHandler } from './middleware/errorHandler.js';
import { logger } from './lib/logger.js';
import { createGlobalLimiter, createLoginLimiter } from './lib/rateLimit.js';
import { loadEnv } from './config/env.js';

export function createApp(): Express {
  const env = loadEnv();
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const headerId = req.headers['x-request-id'];
        const id = typeof headerId === 'string' && headerId.length > 0 ? headerId : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: {
        ignore: (req) => req.url === '/health' || req.url === '/ready',
      },
    }),
  );
  app.use(cookieSessionMiddleware());
  app.use(createGlobalLimiter());

  app.use(healthRouter);

  app.use('/auth', createAuthRouter(createLoginLimiter()));
  app.use('/pto', ptoRouter);

  app.use((_req, res) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Resource not found.' },
    });
  });

  app.use(errorHandler);

  return app;
}

export { logger };
