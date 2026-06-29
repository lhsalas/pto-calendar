import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  createPto,
  deletePto,
  getPtoById,
  toPublicPto,
  updatePto,
} from '../services/pto/PTOService.js';
import { listVisibleRange } from '../services/calendar/CalendarQuery.js';
import { canViewNote } from '../services/authorization/AuthorizationService.js';
import { CreatePtoSchema, IdParamSchema, RangeQuerySchema } from '../services/pto/schemas.js';

export const ptoRouter: Router = Router();

ptoRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const input = CreatePtoSchema.parse(req.body);
    const created = await createPto(req.user!.id, input);
    res.status(201).json(toPublicPto(created));
  } catch (err) {
    next(err);
  }
});

ptoRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const { start, end } = RangeQuerySchema.parse(req.query);
    const list = await listVisibleRange(start, end);
    res.json(list);
  } catch (err) {
    next(err);
  }
});

ptoRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = IdParamSchema.parse(req.params.id);
    const pto = await getPtoById(id);
    if (!pto) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'PTO entry not found.' } });
      return;
    }
    const includeNote = canViewNote(req.user!, pto);
    res.json({ ...pto, note: includeNote ? pto.note : null });
  } catch (err) {
    next(err);
  }
});

ptoRouter.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = IdParamSchema.parse(req.params.id);
    const input = CreatePtoSchema.parse(req.body);
    const updated = await updatePto(req.user!, id, input);
    res.json(toPublicPto(updated));
  } catch (err) {
    next(err);
  }
});

ptoRouter.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = IdParamSchema.parse(req.params.id);
    await deletePto(req.user!, id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
