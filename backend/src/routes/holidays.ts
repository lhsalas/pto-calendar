import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { HttpError } from '../middleware/errorHandler.js';
import {
  create as createHoliday,
  listAll,
  listInRange,
  remove as removeHoliday,
  seedDefaults,
} from '../services/holidays/HolidayService.js';
import { canManageUsers } from '../services/authorization/AuthorizationService.js';
import {
  CreateHolidaySchema,
  IdParamSchema,
  RangeQuerySchema,
  SeedHolidaySchema,
} from '../services/holidays/schemas.js';

function requireTeamLead(actor: { id: string; role: 'member' | 'team_lead' | 'admin' }): void {
  if (!canManageUsers(actor)) {
    throw new HttpError(403, 'FORBIDDEN', 'You do not have permission to manage holidays.');
  }
}

export function createHolidaysRouter(): Router {
  const router: Router = Router();

  router.get('/', requireAuth, async (req, res, next) => {
    try {
      const { start, end } = RangeQuerySchema.parse(req.query);
      const holidays = await listInRange(start, end);
      res.json(holidays);
    } catch (err) {
      next(err);
    }
  });

  router.get('/all', requireAuth, async (_req, res, next) => {
    try {
      const holidays = await listAll();
      res.json(holidays);
    } catch (err) {
      next(err);
    }
  });

  router.post('/', requireAuth, async (req, res, next) => {
    try {
      const actor = req.user!;
      requireTeamLead(actor);
      const input = CreateHolidaySchema.parse(req.body);
      const holiday = await createHoliday(input, actor);
      res.status(201).json(holiday);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', requireAuth, async (req, res, next) => {
    try {
      const actor = req.user!;
      requireTeamLead(actor);
      const id = IdParamSchema.parse(req.params.id);
      await removeHoliday(id, actor);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.post('/seed', requireAuth, async (req, res, next) => {
    try {
      const actor = req.user!;
      requireTeamLead(actor);
      const { countryCode } = SeedHolidaySchema.parse(req.body);
      const result = await seedDefaults(countryCode, actor);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
