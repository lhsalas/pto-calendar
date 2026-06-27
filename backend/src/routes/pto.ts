import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  createPto,
  deletePto,
  getPtoById,
  toPublicPto,
  updatePto,
} from '../services/pto/PTOService.js';
import { listVisibleRange } from '../services/calendar/CalendarQuery.js';
import type { DayPart } from '../services/pto/validation.js';

export const ptoRouter: Router = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const DayPartSchema = z.enum(['morning', 'evening', 'all_day']);

const CreatePtoSchema = z.object({
  startDate: z.string().regex(ISO_DATE),
  endDate: z.string().regex(ISO_DATE),
  dayPart: DayPartSchema.optional(),
  note: z.string().max(500).optional(),
});

const RangeQuerySchema = z.object({
  start: z.string().regex(ISO_DATE),
  end: z.string().regex(ISO_DATE),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IdParamSchema = z.string().regex(UUID);

function isOwnerOrLead(
  actor: { id: string; role: 'member' | 'team_lead' },
  ownerId: string,
): boolean {
  return actor.role === 'team_lead' || actor.id === ownerId;
}

ptoRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const input = CreatePtoSchema.parse(req.body);
    const created = await createPto(
      req.user!.id,
      input as { startDate: string; endDate: string; dayPart?: DayPart; note?: string },
    );
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
    const includeNote = isOwnerOrLead(req.user!, pto.userId);
    res.json({ ...pto, note: includeNote ? pto.note : null });
  } catch (err) {
    next(err);
  }
});

ptoRouter.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = IdParamSchema.parse(req.params.id);
    const input = CreatePtoSchema.parse(req.body);
    const updated = await updatePto(
      req.user!,
      id,
      input as { startDate: string; endDate: string; dayPart?: DayPart; note?: string },
    );
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
