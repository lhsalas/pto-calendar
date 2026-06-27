import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { createPto, toPublicPto } from '../services/pto/PTOService.js';
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
