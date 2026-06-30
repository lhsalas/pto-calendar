import { z } from 'zod';
import {
  isPlaceholderSessionSecret,
  parseSessionKeys,
  shannonEntropy,
  MIN_SESSION_SECRET_ENTROPY,
  MIN_SESSION_SECRET_LENGTH,
} from './sessionSecret.js';

const sessionSecretSchema = z
  .string()
  .min(1, 'SESSION_SECRET must not be empty')
  .transform((raw: string, ctx): string[] => {
    const keys = parseSessionKeys(raw);
    if (keys.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'SESSION_SECRET must contain at least one non-empty key',
      });
      return z.NEVER;
    }
    for (const [i, key] of keys.entries()) {
      if (key.length < MIN_SESSION_SECRET_LENGTH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `SESSION_SECRET[${i}] must be at least ${MIN_SESSION_SECRET_LENGTH} characters (got ${key.length})`,
        });
      } else if (isPlaceholderSessionSecret(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `SESSION_SECRET[${i}] matches a known placeholder string — generate a real secret with \`openssl rand -base64 32\``,
        });
      } else if (shannonEntropy(key) < MIN_SESSION_SECRET_ENTROPY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `SESSION_SECRET[${i}] has insufficient entropy (${shannonEntropy(key).toFixed(2)} bits/char, minimum ${MIN_SESSION_SECRET_ENTROPY}) — generate a real secret with \`openssl rand -base64 32\``,
        });
      }
    }
    return keys;
  });

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),

    SESSION_SECRET: sessionSecretSchema,
    COOKIE_SECURE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    COOKIE_DOMAIN: z.string().default(''),
    COOKIE_MAX_AGE_MS: z.coerce.number().int().positive().default(86_400_000),

    DATABASE_URL: z.string().url(),

    BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),

    CORS_ORIGIN: z.string().url().default('http://localhost:5173'),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),

    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

    READY_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

    AUTH_USER_CACHE_TTL_MS: z.coerce.number().int().positive().default(15_000),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (env.SESSION_SECRET.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SESSION_SECRET'],
        message: 'SESSION_SECRET is required in production',
      });
    }
    if (!env.COOKIE_SECURE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['COOKIE_SECURE'],
        message: 'COOKIE_SECURE must be true in production',
      });
    }
    if (env.BCRYPT_ROUNDS < 10) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BCRYPT_ROUNDS'],
        message: 'BCRYPT_ROUNDS must be at least 10 in production',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetEnvForTests(): void {
  cached = undefined;
}

// re-export so consumers/tests can import from one place
export {
  isPlaceholderSessionSecret,
  isStrongSessionSecret,
  shannonEntropy,
  parseSessionKeys,
} from './sessionSecret.js';
