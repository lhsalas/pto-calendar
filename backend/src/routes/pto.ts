import { Router, type Request } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  createPto,
  createPtoIdempotently,
  deletePto,
  getPtoById,
  patchPto,
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
import {
  CreatePtoSchema,
  IdParamSchema,
  PatchPtoSchema,
  PtoListQuerySchema,
  ReplacePtoSchema,
} from '../services/pto/schemas.js';
import { parseExpectedVersion } from '../services/pto/preconditions.js';
import { parseIdempotencyKey } from '../services/pto/idempotencyKey.js';
import { preparePtoReplay } from '../services/pto/replayCredential.js';

export const ptoRouter: Router = Router();

/**
 * The raw occurrences of the `Idempotency-Key` header.
 *
 * The joined header value cannot tell a repeated header from a single one, so
 * the occurrences are counted from the raw header list: a repeated header is
 * refused even when both occurrences carry the same text.
 */
function rawIdempotencyKeys(req: Request): string[] | undefined {
  const values: string[] = [];
  const raw = req.rawHeaders;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    if (raw[index]?.toLowerCase() === 'idempotency-key') {
      values.push(raw[index + 1]!);
    }
  }
  return values.length > 0 ? values : undefined;
}

ptoRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    // The scope is checked before the key or any saved state is looked at, so
    // an unauthorized caller learns nothing about the key format.
    assertPtoScope(req.auth!, 'create');
    // A personal token must always name its create intent; a browser session
    // may still create without a key exactly as before.
    const key = parseIdempotencyKey(rawIdempotencyKeys(req), req.auth!.method === 'pat');
    const input = CreatePtoSchema.parse(req.body);
    if (!key) {
      const created = await createPto(attributedActorFromAuth(req.auth!), input);
      res.status(201).json(redactPtoNote(req.auth!, toPublicPto(created)));
      return;
    }
    const credential = preparePtoReplay(req.auth!, req.user);
    const result = await createPtoIdempotently(input, key, credential);
    // A keyed outcome carries the replay state and is never stored anywhere
    // a cache could keep it.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Idempotency-Replayed', result.replayed ? 'true' : 'false');
    res.setHeader('Idempotency-Key-Expires-At', result.expiresAt.toISOString());
    res.status(201).json(redactPtoNote(result.auth, toPublicPto(result.row)));
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
    // The write must name the revision it changes. A missing or unusable
    // precondition is refused before the record is read or the body parsed.
    const expectedVersion = parseExpectedVersion(req.headers['if-match']);
    const id = IdParamSchema.parse(req.params.id);
    const input = ReplacePtoSchema.parse(req.body);
    const existing = await getPtoById(id);
    if (!existing) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'PTO entry not found.' } });
      return;
    }
    assertPtoRecordAccess(req.auth!, 'update', existing);
    // The record this caller was just authorized for is the observation the
    // write is based on: if it disappears or changes owner before the write,
    // the write is stale rather than missing or forbidden.
    const updated = await updatePto(
      attributedActorFromAuth(req.auth!),
      id,
      input,
      expectedVersion,
      existing.userId,
    );
    res.json(redactPtoNote(req.auth!, toPublicPto(updated)));
  } catch (err) {
    next(err);
  }
});

/**
 * A partial write. The same authorization, the same precondition and the
 * same record access as the replacement write apply; only the named fields
 * change.
 */
ptoRouter.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const expectedVersion = parseExpectedVersion(req.headers['if-match']);
    const id = IdParamSchema.parse(req.params.id);
    const patch = PatchPtoSchema.parse(req.body);
    const existing = await getPtoById(id);
    if (!existing) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'PTO entry not found.' } });
      return;
    }
    assertPtoRecordAccess(req.auth!, 'update', existing);
    const patched = await patchPto(
      attributedActorFromAuth(req.auth!),
      id,
      patch,
      expectedVersion,
      existing.userId,
    );
    res.json(redactPtoNote(req.auth!, toPublicPto(patched)));
  } catch (err) {
    next(err);
  }
});

ptoRouter.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const expectedVersion = parseExpectedVersion(req.headers['if-match']);
    const id = IdParamSchema.parse(req.params.id);
    const existing = await getPtoById(id);
    if (!existing) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'PTO entry not found.' } });
      return;
    }
    assertPtoRecordAccess(req.auth!, 'delete', existing);
    await deletePto(attributedActorFromAuth(req.auth!), id, expectedVersion, existing.userId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
