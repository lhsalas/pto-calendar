import type { ErrorRequestHandler, Request, RequestHandler } from 'express';
import { loadEnv } from '../config/env.js';
import { safeRequestId } from '../lib/logSanitizers.js';
import { parseToken } from '../services/tokens/tokenDomain.js';
import { verifyToken } from '../services/tokens/tokenService.js';
import type { TokenRuntime } from '../services/tokens/tokenRuntime.js';
import { assertPatRoute, classifyPatRoute } from '../services/authorization/patPolicy.js';
import type { AuthContext } from '../services/auth/authContext.js';
import { HttpError } from './errorHandler.js';
import { tokenManagementErrorHandler } from './tokenManagement.js';
import { chargeAuthenticatedTraffic, chargeBearerFailure, sendRateLimited } from './agentQuota.js';

function authorizationCount(req: Request): number {
  return req.rawHeaders.filter(
    (_, index) => index % 2 === 0 && req.rawHeaders[index]!.toLowerCase() === 'authorization',
  ).length;
}

export function hasAuthorization(req: Request): boolean {
  return req.headers.authorization !== undefined || authorizationCount(req) > 0;
}

/** Run one shared parser in its legacy slot for browsers and later for PATs. */
export function selectiveJsonParser(
  parser: RequestHandler,
  authorization: boolean,
): RequestHandler {
  return (req, res, next) => {
    if (hasAuthorization(req) === authorization) {
      return parser(req, res, next);
    }
    next();
  };
}

/** Establish correlation before parsing, even for invalid/duplicate credentials. */
export const patResponseBoundary: RequestHandler = (req, res, next) => {
  if (hasAuthorization(req)) {
    req.id = safeRequestId(req, res);
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
};

function unauthenticated(): never {
  throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required.');
}

/** Global selector: never interpret a failed bearer as a browser session. */
export function createPatAuth(runtime: TokenRuntime): RequestHandler {
  const env = loadEnv();
  return async (req, res, next) => {
    if (!hasAuthorization(req)) {
      next();
      return;
    }
    const header = req.headers.authorization;
    if (
      authorizationCount(req) > 1 ||
      typeof header !== 'string' ||
      req.headers.cookie !== undefined ||
      req.session?.user ||
      !env.PAT_AUTH_ENABLED
    )
      unauthenticated();
    const match = /^Bearer (pto_pat_\S+)$/i.exec(header);
    if (!match || !parseToken(match[1]!)) unauthenticated();
    const route = classifyPatRoute(req.method, req.path);
    // Ineligible paths cannot use PATs to authenticate, including auth/tokens.
    if (!route) unauthenticated();
    // Bound failed credential verification before the expensive database
    // lookup. The charge is keyed by the client address, never by the
    // unverified header, and a verified secret refunds it below.
    const failure = await chargeBearerFailure(req);
    if (!failure.allowed) {
      sendRateLimited(req, res, failure, 'Too many failed credential attempts. Try again later.');
      return;
    }
    let verified;
    try {
      verified = await verifyToken(runtime.get(), match[1]!);
    } catch {
      // Neither driver causes, credential inputs nor account status are public.
      unauthenticated();
    }
    if (!verified) unauthenticated();
    // A verified secret is not a failed attempt, whatever the route decides
    // next, so the pre-verification charge is compensated here.
    await failure.refund();
    const auth: Extract<AuthContext, { method: 'pat' }> = {
      method: 'pat',
      actor: { id: verified.ownerId, role: verified.role },
      requestId: safeRequestId(req, res),
      tokenId: verified.tokenId,
      scopes: verified.scopes,
      expiresAt: verified.expiresAt,
    };
    // Only a verified identity is charged, and only once per request.
    const traffic = await chargeAuthenticatedTraffic(auth);
    if (traffic) {
      sendRateLimited(req, res, traffic, 'Too many requests. Try again later.');
      return;
    }
    assertPatRoute(auth, route, env.PAT_WRITES_ENABLED);
    req.auth = auth;
    next();
  };
}

/** Reuse the credential-safe parser/error envelope without leaking raw causes. */
export const patErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (!hasAuthorization(req)) {
    next(err);
    return;
  }
  tokenManagementErrorHandler(err, req, res, next);
};

// CORS still supplies the same origin/credentials policy. Preflight must pass
// the global selector too; otherwise Authorization + OPTIONS bypasses denial.
export const finishPreflight: RequestHandler = (req, res, next) => {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
};
