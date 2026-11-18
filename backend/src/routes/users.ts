import { Router } from 'express';
import { HttpError } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { canManageUsers } from '../services/authorization/AuthorizationService.js';
import {
  createUser,
  CreateUserSchema,
  generateSetupToken,
  getUserById,
  resetUserPassword,
} from '../services/users/UserService.js';
import { auditEntryFor, record } from '../services/audit/AuditLogService.js';
import { attributedActorFromAuth } from '../services/audit/auditContext.js';
import { prisma } from '../lib/prisma.js';

const PUBLIC_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  colorCode: true,
} as const;

function requireTeamLead(actor: { id: string; role: 'member' | 'team_lead' | 'admin' }): void {
  if (!canManageUsers(actor)) {
    throw new HttpError(403, 'FORBIDDEN', 'You do not have permission to manage users.');
  }
}

export function createUsersRouter(): Router {
  const router: Router = Router();

  // List users — team_lead only.
  router.get('/', requireAuth, async (req, res, next) => {
    try {
      requireTeamLead(req.user!);
      const users = await prisma.user.findMany({
        select: PUBLIC_USER_SELECT,
        orderBy: [{ role: 'asc' }, { name: 'asc' }],
      });
      res.json(users);
    } catch (err) {
      next(err);
    }
  });

  // Create a user — team_lead only.
  router.post('/', requireAuth, async (req, res, next) => {
    try {
      const actor = req.user!;
      requireTeamLead(actor);
      const { email, name } = CreateUserSchema.parse(req.body);
      const setupToken = generateSetupToken();
      const created = await createUser({
        email,
        name,
        role: 'member',
        setupToken,
      });
      await record(
        auditEntryFor(attributedActorFromAuth(req.auth!), {
          action: 'create_user',
          entityType: 'user',
          entityId: created.id,
          targetOwnerId: created.id,
          details: { email: created.email, name: created.name },
        }),
      );
      res.status(201).json({
        user: {
          id: created.id,
          name: created.name,
          email: created.email,
          role: created.role,
          colorCode: created.colorCode,
        },
        setupToken: setupToken.plaintext,
        expiresAt: setupToken.expiresAt.toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  // Reset a user's password — team_lead only. Blocks self-reset and
  // resetting the only team_lead in the system.
  router.post('/:id/reset-password', requireAuth, async (req, res, next) => {
    try {
      const actor = req.user!;
      requireTeamLead(actor);
      const rawId = req.params.id;
      const id = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!id) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'User id is required.');
      }
      if (id === actor.id) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'You cannot reset your own password here.');
      }
      const target = await getUserById(id);
      if (!target) {
        throw new HttpError(404, 'NOT_FOUND', 'User not found.');
      }
      if (target.role === 'team_lead') {
        const leadCount = await prisma.user.count({ where: { role: 'team_lead' } });
        if (leadCount <= 1) {
          throw new HttpError(
            400,
            'VALIDATION_ERROR',
            'Cannot reset the only team lead; promote another user to team_lead first.',
          );
        }
      }
      // The service writes the credential-version audit row in the same transaction.
      const { setupToken } = await resetUserPassword(id, attributedActorFromAuth(req.auth!));
      res.json({
        setupToken: setupToken.plaintext,
        expiresAt: setupToken.expiresAt.toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
