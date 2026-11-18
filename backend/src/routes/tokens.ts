import { Router, type RequestHandler } from 'express';
import { requireTokenSession } from '../middleware/tokenManagement.js';
import { HttpError } from '../middleware/errorHandler.js';
import {
  parseTokenEmptyBody,
  parseTokenIssue,
  parseTokenQuery,
  TokenIdSchema,
  verifyTokenIssuancePassword,
} from '../services/tokens/tokenManagement.js';
import { validateTokenScopes } from '../services/tokens/tokenDomain.js';
import {
  issueToken,
  listTokens,
  revokeAllTokens,
  revokeToken,
} from '../services/tokens/tokenService.js';
import type { TokenRuntime } from '../services/tokens/tokenRuntime.js';
import { attributedActorFromAuth } from '../services/audit/auditContext.js';

export function createTokenRouter(runtime: TokenRuntime, issuanceLimiter: RequestHandler): Router {
  const router = Router();
  router.use(requireTokenSession);
  router.use((req, _res, next) => {
    parseTokenQuery(req.query);
    next();
  });

  router.get('/', async (req, res) => {
    const tokens = await listTokens(runtime.get(), req.user!.id);
    res.json({ tokens });
  });

  router.post('/', issuanceLimiter, async (req, res) => {
    const { password, ...input } = parseTokenIssue(req.body);
    const owner = await verifyTokenIssuancePassword(
      req.user!.id,
      req.user!.sessionVersion,
      password,
    );
    try {
      validateTokenScopes(input.scopes, owner.role);
    } catch {
      throw new HttpError(
        403,
        'FORBIDDEN',
        'Team scopes require a current team lead or administrator role.',
      );
    }
    // The verified session is the only actor source; the body cannot name an owner.
    const actor = attributedActorFromAuth(req.auth!);
    res.status(201).json(await issueToken(runtime.get(), actor, owner.sessionVersion, input));
  });

  router.delete('/:id', async (req, res) => {
    parseTokenEmptyBody(req.body);
    const id = TokenIdSchema.parse(req.params.id);
    const found = await revokeToken(runtime.get(), attributedActorFromAuth(req.auth!), id);
    if (!found) throw new HttpError(404, 'NOT_FOUND', 'Token not found.');
    res.status(204).end();
  });

  router.post('/revoke-all', async (req, res) => {
    parseTokenEmptyBody(req.body);
    await revokeAllTokens(runtime.get(), attributedActorFromAuth(req.auth!));
    res.status(204).end();
  });

  router.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found.' } });
  });
  return router;
}
