import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  createPto,
  deletePto,
  getPtoById,
  toPublicPto,
  updatePto,
} from '../services/pto/PTOService.js';
import { listVisiblePage, listVisibleRange } from '../services/calendar/CalendarQuery.js';
import {
  assertPtoRecordAccess,
  assertPtoScope,
  redactPtoNote,
} from '../services/authorization/patPolicy.js';
import { attributedActorFromAuth } from '../services/audit/auditContext.js';
import { CreatePtoSchema, IdParamSchema, PtoListQuerySchema } from '../services/pto/schemas.js';

export const ptoRouter: Router = Router();

ptoRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    assertPtoScope(req.auth!, 'create');
    const input = CreatePtoSchema.parse(req.body);
    const created = await createPto(attributedActorFromAuth(req.auth!), input);
    res.status(201).json(redactPtoNote(req.auth!, toPublicPto(created)));
  } catch (err) {
    next(err);
  }
});

ptoRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    assertPtoScope(req.auth!, 'read');
    const query = PtoListQuerySchema.parse(req.query);
    const filters = { start: query.start, end: query.end, userId: query.userId };
    if (query.format === 'page') {
      const page = await listVisiblePage(filters, { limit: query.limit, cursor: query.cursor });
      res.json({
        items: page.items.map((pto) => ({ ...pto, note: null })),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      });
      return;
    }
    const list = await listVisibleRange(filters);
    res.json(list.map((pto) => ({ ...pto, note: null })));
  } catch (err) {
    next(err);
  }
});

ptoRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    assertPtoScope(req.auth!, 'read');
    const id = IdParamSchema.parse(req.params.id);
    const pto = await getPtoById(id);
    if (!pto) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'PTO entry not found.' } });
      return;
    }
    res.json(redactPtoNote(req.auth!, pto));
  } catch (err) {
    next(err);
  }
});

ptoRouter.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = IdParamSchema.parse(req.params.id);
    const input = CreatePtoSchema.parse(req.body);
    const existing = await getPtoById(id);
    if (!existing) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'PTO entry not found.' } });
      return;
    }
    assertPtoRecordAccess(req.auth!, 'update', existing);
    const updated = await updatePto(attributedActorFromAuth(req.auth!), id, input);
    res.json(redactPtoNote(req.auth!, toPublicPto(updated)));
  } catch (err) {
    next(err);
  }
});

ptoRouter.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = IdParamSchema.parse(req.params.id);
    const existing = await getPtoById(id);
    if (!existing) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'PTO entry not found.' } });
      return;
    }
    assertPtoRecordAccess(req.auth!, 'delete', existing);
    await deletePto(attributedActorFromAuth(req.auth!), id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
