import { Router } from 'express';
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
import {
  chargeTokenIssuance,
  chargeTokenPassword,
  sendRateLimited,
} from '../middleware/agentQuota.js';

export function createTokenRouter(runtime: TokenRuntime): Router {
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

  router.post('/', async (req, res) => {
    // The payload is validated before any budget is charged, so a malformed
    // request never consumes the owner's issuance budget.
    const { password, ...input } = parseTokenIssue(req.body);
    const ownerId = req.user!.id;
    // The password comparison is the expensive step, so it is bounded before
    // it runs. The attempt is not given back: the budget bounds the expensive
    // comparisons themselves, not only the failed ones.
    const passwordCharge = await chargeTokenPassword(ownerId);
    if (!passwordCharge.allowed) {
      sendRateLimited(
        req,
        res,
        passwordCharge,
        'Too many password verification attempts. Try again later.',
      );
      return;
    }
    const owner = await verifyTokenIssuancePassword(ownerId, req.user!.sessionVersion, password);
    try {
      validateTokenScopes(input.scopes, owner.role);
    } catch {
      throw new HttpError(
        403,
        'FORBIDDEN',
        'Team scopes require a current team lead or administrator role.',
      );
    }
    // Token creation is bounded separately from ordinary reads, and the charge
    // happens before any material is generated or any row is written, so a
    // rejected issuance never produces an audit entry.
    const issuance = await chargeTokenIssuance(ownerId);
    if (!issuance.allowed) {
      sendRateLimited(req, res, issuance, 'Too many token issuance attempts. Try again later.');
      return;
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
