import 'express';
import type { NextFunction, Request, Response } from 'express';
import type { SessionUser } from './cookieSession.js';

declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const user = req.session?.user;
  if (!user) {
    res.status(401).json({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' },
    });
    return;
  }
  req.user = user;
  next();
}
