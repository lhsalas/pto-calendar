import { Router, type RequestHandler } from 'express';
import { getCurrentUser, login } from '../services/auth/AuthService.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { LoginSchema } from '../services/auth/schemas.js';
import { setupAccount, SetupAccountSchema } from '../services/users/UserService.js';
import { safeRequestId } from '../lib/logSanitizers.js';

export function createAuthRouter(loginLimiter: RequestHandler): Router {
  const router: Router = Router();

  router.post('/login', loginLimiter, async (req, res, next) => {
    try {
      const { email, password } = LoginSchema.parse(req.body);
      const authenticated = await login(email, password);
      const { sessionVersion, ...user } = authenticated;
      req.session = {
        user: { id: user.id, role: user.role, sessionVersion },
      } as typeof req.session;
      res.json({ user });
    } catch (err) {
      next(err);
    }
  });

  router.post('/setup-account', loginLimiter, async (req, res, next) => {
    try {
      const { token, password } = SetupAccountSchema.parse(req.body);
      // Public route: the audited actor is derived from the claimed setup row inside
      // the service. Only the verified server correlation ID is passed separately.
      const { user } = await setupAccount(
        { token, password },
        { requestId: safeRequestId(req, res) },
      );
      req.session = {
        user: { id: user.id, role: user.role, sessionVersion: user.sessionVersion },
      } as typeof req.session;
      res.json({
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          colorCode: user.colorCode,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', (req, res) => {
    req.session = null;
    res.status(204).end();
  });

  router.get('/me', requireAuth, async (req, res, next) => {
    try {
      if (req.auth!.method === 'pat') {
        const { actor, tokenId, scopes, expiresAt } = req.auth!;
        res.json({ ...actor, auth: { method: 'pat', tokenId, scopes, expiresAt } });
        return;
      }
      const user = await getCurrentUser(req.user!.id);
      res.json(user);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
