import { Router } from 'express';
import { z } from 'zod';
import { getCurrentUser, login } from '../services/auth/AuthService.js';
import { requireAuth } from '../middleware/requireAuth.js';

export const authRouter: Router = Router();

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const { email, password } = LoginSchema.parse(req.body);
    const user = await login(email, password);
    req.session!.user = { id: user.id, role: user.role };
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', (req, res) => {
  req.session = null;
  res.status(204).end();
});

authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await getCurrentUser(req.user!.id);
    res.json(user);
  } catch (err) {
    next(err);
  }
});
