import pino, { type LoggerOptions, type Logger as PinoLogger } from 'pino';
import { loadEnv } from '../config/env.js';
import {
  safeErrorSerializer,
  safeMessageSerializer,
  scrubLogLine,
  scrubLogMethodArguments,
  scrubLogObject,
} from './logRedaction.js';
import { safeReqSerializer, safeResSerializer } from './logSanitizers.js';

const env = loadEnv();

export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  'password',
  'passwordHash',
  'token',
  'secret',
  'rawToken',
  'secretDigest',
  'setupToken',
  'setupTokenHash',
  'authorization',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.secret',
  '*.rawToken',
  '*.secretDigest',
  '*.setupToken',
  '*.setupTokenHash',
  '*.authorization',
];

export const REDACT_CENSOR = '[REDACTED]';

/**
 * Shared configuration. Shallow path redaction is complemented by the instrumented
 * transforms in lib/logRedaction.ts, which cover arbitrarily nested payloads, error
 * objects, message text and the finished record. Capture tests build pino from
 * these same options, so every logger built from them is equally protected.
 *
 * Pino v10 serializes child-logger bindings outside `formatters.log` and resets a
 * custom `formatters.bindings` for every child, so the finished record is scrubbed
 * in `hooks.streamWrite` instead: that is the only boundary that sees the
 * bindings of every child, at every depth.
 */
export const LOGGER_OPTIONS: LoggerOptions = {
  level: env.LOG_LEVEL,
  redact: {
    paths: REDACT_PATHS,
    censor: REDACT_CENSOR,
  },
  // Raw request/response objects, including a bare request passed as the first
  // argument, reach only their allowlisting serializers.
  serializers: {
    err: safeErrorSerializer,
    req: safeReqSerializer,
    res: safeResSerializer,
    // The message is formatted after its arguments, so it is scrubbed last.
    msg: safeMessageSerializer,
  },
  formatters: { log: scrubLogObject },
  hooks: {
    logMethod: scrubLogMethodArguments,
    streamWrite: scrubLogLine,
  },
};

export const logger: PinoLogger = pino({
  ...LOGGER_OPTIONS,
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
