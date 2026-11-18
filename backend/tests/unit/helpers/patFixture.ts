import { randomUUID } from 'node:crypto';
import express from 'express';
import { vi } from 'vitest';
import { resetEnvForTests } from '../../../src/config/env.js';
import {
  patResponseBoundary,
  createPatAuth,
  patErrorHandler,
  finishPreflight,
  selectiveJsonParser,
} from '../../../src/middleware/patAuth.js';
import { errorHandler } from '../../../src/middleware/errorHandler.js';
import { csrfOriginMiddleware } from '../../../src/middleware/csrf.js';
import { createTokenMaterial, type TokenScope } from '../../../src/services/tokens/tokenDomain.js';
import type { TokenDatabase } from '../../../src/services/tokens/tokenDatabase.js';
import type { SessionUser } from '../../../src/middleware/cookieSession.js';

/** Mock only external persistence/transport; real parsing, crypto and guards run. */
export function patFixture(
  options: {
    role?: SessionUser['role'];
    scopes?: TokenScope[];
    auth?: boolean;
    writes?: boolean;
  } = {},
) {
  vi.stubEnv('PAT_AUTH_ENABLED', String(options.auth ?? true));
  vi.stubEnv('PAT_WRITES_ENABLED', String(options.writes ?? true));
  vi.stubEnv('NODE_ENV', 'test');
  resetEnvForTests();
  const material = createTokenMaterial();
  const owner = {
    id: randomUUID(),
    role: options.role ?? 'member',
    passwordHash: 'non-null-password-hash' as string | null,
    sessionVersion: 0,
  };
  const token = {
    id: material.publicId,
    ownerId: owner.id,
    secretDigest: material.secretDigest,
    scopes: options.scopes ?? ['pto:read'],
    expiresAt: new Date(Date.now() + 86400000),
    revokedAt: null as Date | null,
    issuedSessionVersion: 0,
  };
  const query = vi.fn(async (sql: string) =>
    sql.includes(' JOIN ')
      ? { rows: [{ ...owner, ...token }], rowCount: 1 }
      : { rows: [], rowCount: 1 },
  );
  const db = { query, tables: { users: 'users', tokens: 'tokens' } } as unknown as TokenDatabase;
  const runtime = { get: vi.fn(() => db), close: vi.fn().mockResolvedValue(undefined) };
  const app = express();
  let session: SessionUser | undefined;
  app.use(patResponseBoundary);
  const jsonParser = express.json({ limit: '100kb' });
  app.use(selectiveJsonParser(jsonParser, false));
  app.use((req, _res, next) => {
    req.session = session ? ({ user: session } as typeof req.session) : null;
    next();
  });
  app.use(createPatAuth(runtime));
  app.use(csrfOriginMiddleware());
  app.use(selectiveJsonParser(jsonParser, true));
  app.use(finishPreflight);
  return {
    app,
    runtime,
    query,
    owner,
    token,
    material,
    setSession: (value: SessionUser | undefined) => {
      session = value;
    },
    finish: () => {
      app.use(patErrorHandler);
      app.use(errorHandler);
    },
  };
}
