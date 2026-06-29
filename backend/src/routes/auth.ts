import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { getCurrentUser, login } from '../services/auth/AuthService.js';
import { requireAuth } from '../middleware/requireAuth.js';

export function createAuthRouter(loginLimiter: RequestHandler): Router {
  const router: Router = Router();

  const LoginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
  });

  router.post('/login', loginLimiter, async (req, res, next) => {
    try {
      const { email, password } = LoginSchema.parse(req.body);
      const user = await login(email, password);
      req.session!.user = { id: user.id, role: user.role };
      res.json({ user });
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
      const user = await getCurrentUser(req.user!.id);
      res.json(user);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
