import express from 'express';
import type { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { createAuthRouter } from './routes/auth.js';
import { ptoRouter } from './routes/pto.js';
import { healthRouter } from './routes/health.js';
import { createUsersRouter } from './routes/users.js';
import { createHolidaysRouter } from './routes/holidays.js';
import { cookieSessionMiddleware } from './middleware/cookieSession.js';
import { csrfOriginMiddleware } from './middleware/csrf.js';
import { errorHandler } from './middleware/errorHandler.js';
import { logger } from './lib/logger.js';
import { createPinoHttpOptions } from './lib/logSanitizers.js';
import { createGlobalLimiter, createLoginLimiter } from './lib/rateLimit.js';
import { loadEnv } from './config/env.js';
import { createTokenRouter } from './routes/tokens.js';
import {
  tokenManagementBoundary,
  tokenManagementErrorHandler,
} from './middleware/tokenManagement.js';
import { createTokenRuntime } from './services/tokens/tokenRuntime.js';
import {
  createPatAuth,
  finishPreflight,
  patErrorHandler,
  patResponseBoundary,
  selectiveJsonParser,
} from './middleware/patAuth.js';

export type ManagedApp = Express & { closeResources(): Promise<void> };

export function createApp(): ManagedApp {
  const env = loadEnv();
  const app = express() as ManagedApp;
  const tokenRuntime = createTokenRuntime(env.DATABASE_URL);
  app.closeResources = () => tokenRuntime.close();

  app.disable('x-powered-by');
  if (env.TRUST_PROXY_HOPS > 0) {
    app.set('trust proxy', env.TRUST_PROXY_HOPS);
  }
  app.use(helmet());
  app.use(patResponseBoundary);
  app.use('/auth/tokens', tokenManagementBoundary);
  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      credentials: true,
      preflightContinue: true,
    }),
  );
  const jsonParser = express.json({ limit: '100kb' });
  app.use(selectiveJsonParser(jsonParser, false));
  app.use(pinoHttp(createPinoHttpOptions(logger)));
  app.use(cookieSessionMiddleware());
  app.use(createGlobalLimiter());
  app.use(createPatAuth(tokenRuntime));
  app.use(csrfOriginMiddleware());
  app.use(selectiveJsonParser(jsonParser, true));
  app.use(finishPreflight);

  app.use(healthRouter);

  const loginLimiter = createLoginLimiter();
  app.use('/auth/tokens', createTokenRouter(tokenRuntime, loginLimiter));
  app.use('/auth', createAuthRouter(loginLimiter));
  app.use('/pto', ptoRouter);
  app.use('/users', createUsersRouter());
  app.use('/holidays', createHolidaysRouter());

  app.use((_req, res) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Resource not found.' },
    });
  });

  app.use('/auth/tokens', tokenManagementErrorHandler);
  app.use(patErrorHandler);
  app.use(errorHandler);

  return app;
}

export { logger } from './lib/logger.js';
export {
  createPinoHttpOptions,
  safeRequestId,
  safeReqSerializer,
  safeResSerializer,
} from './lib/logSanitizers.js';
