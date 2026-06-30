import pino, { type Logger as PinoLogger } from 'pino';
import { loadEnv } from '../config/env.js';

const env = loadEnv();

export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  'password',
  'passwordHash',
  'token',
  'secret',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.secret',
];

export const REDACT_CENSOR = '[REDACTED]';

export const logger: PinoLogger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: REDACT_PATHS,
    censor: REDACT_CENSOR,
  },
  ...(env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l' },
        },
      }
    : {}),
});

export type Logger = PinoLogger;
