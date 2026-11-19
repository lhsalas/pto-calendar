import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { patFixture } from '../../tests/unit/helpers/patFixture.js';
import { resetEnvForTests } from '../config/env.js';
import { HttpError } from '../middleware/errorHandler.js';
import { ptoRouter } from './pto.js';
import {
  createPto,
  deletePto,
  getPtoById,
  patchPto,
  updatePto,
} from '../services/pto/PTOService.js';
import { listVisiblePage, listVisibleRange } from '../services/calendar/CalendarQuery.js';
import type { TokenScope } from '../services/tokens/tokenDomain.js';

vi.mock('../services/pto/PTOService.js', async () => ({
  ...(await vi.importActual('../services/pto/PTOService.js')),
  createPto: vi.fn(),
  deletePto: vi.fn(),
  getPtoById: vi.fn(),
  patchPto: vi.fn(),
  updatePto: vi.fn(),
}));
vi.mock('../services/calendar/CalendarQuery.js', () => ({
  listVisibleRange: vi.fn(),
  listVisiblePage: vi.fn(),
}));

const id = '00000000-0000-4000-8000-000000000001';
const body = { startDate: '2026-12-01', endDate: '2026-12-01', dayPart: 'all_day' as const };
const raw = {
  id,
  userId: 'owner',
  startDate: new Date('2026-12-01'),
  endDate: new Date('2026-12-01'),
  dayPart: 'all_day' as const,
  note: 'stored private note',
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};

/** The precondition every write has to name. */
const IF_MATCH = 'If-Match';
const VERSION = '"1"';

function fixture(options: Parameters<typeof patFixture>[0] = {}) {
  const f = patFixture(options);
  f.app.use('/pto', ptoRouter);
  f.finish();
  const record = { ...raw, userId: f.owner.id };
  vi.mocked(getPtoById).mockResolvedValue({
    ...record,
    startDate: '2026-12-01',
    endDate: '2026-12-01',
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    user: { id: record.userId, name: 'Owner', colorCode: '#123456' },
  });
  vi.mocked(createPto).mockResolvedValue(record);
  vi.mocked(updatePto).mockResolvedValue(record);
  vi.mocked(patchPto).mockResolvedValue(record);
  vi.mocked(deletePto).mockResolvedValue(undefined);
  // A rogue note proves the route redacts independently of the service type.
  vi.mocked(listVisibleRange).mockResolvedValue([
    {
      id,
      ...body,
      user: { id: record.userId, name: 'Owner', colorCode: '#123456' },
      note: 'defensive list note',
    } as unknown as Awaited<ReturnType<typeof listVisibleRange>>[number],
  ]);
  vi.mocked(listVisiblePage).mockResolvedValue({
    items: [
      {
        id,
        ...body,
        version: 1,
        user: { id: record.userId, name: 'Owner', colorCode: '#123456' },
        note: 'defensive list note',
      } as unknown as Awaited<ReturnType<typeof listVisiblePage>>['items'][number],
    ],
    nextCursor: 'next-page-cursor',
    hasMore: true,
  });
  return { ...f, bearer: `Bearer ${f.material.rawToken}`, record };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SESSION_SECRET', 'aB1!cD2@eF3#gH4$iJ5%kL6&mN7*oP8+');
  vi.stubEnv('DATABASE_URL', 'postgresql://pto:pto@localhost:5432/pto_test?schema=public');
  resetEnvForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvForTests();
});

describe('PTO HTTP scopes and note serialization', () => {
  it('keeps list notes null and gates detail reads with scope plus canViewNote', async () => {
    const f = fixture({ scopes: ['pto:read', 'pto:notes:read'] });
    const list = await request(f.app)
      .get('/pto?start=2026-12-01&end=2026-12-31')
      .set('Authorization', f.bearer)
      .expect(200);
    expect(list.body[0].note).toBeNull();
    const detail = await request(f.app)
      .get(`/pto/${id}`)
      .set('Authorization', f.bearer)
      .expect(200);
    expect(detail.body.note).toBe('stored private note');
    vi.mocked(getPtoById).mockResolvedValueOnce({ ...detail.body, userId: 'other' });
    const foreign = await request(f.app)
      .get(`/pto/${id}`)
      .set('Authorization', f.bearer)
      .expect(200);
    expect(foreign.body.note).toBeNull();
    const metadata = fixture();
    const noNotes = await request(metadata.app)
      .get(`/pto/${id}`)
      .set('Authorization', metadata.bearer)
      .expect(200);
    expect(noNotes.body.note).toBeNull();
  });

  it('never leaks notes from write-only create or legacy PUT, including omitted notes', async () => {
    const f = fixture({ scopes: ['pto:create', 'pto:update:self'] });
    const created = await request(f.app)
      .post('/pto')
      .set('Authorization', f.bearer)
      .send({ ...body, note: 'submitted', userId: 'other' })
      .expect(201);
    expect(created.body.note).toBeNull();
    expect(createPto).toHaveBeenCalledWith(
      {
        id: f.owner.id,
        role: 'member',
        credential: { type: 'personal_access_token', tokenId: f.token.id },
        requestId: expect.any(String),
      },
      { ...body, note: 'submitted' },
    );
    const updated = await request(f.app)
      .put(`/pto/${id}`)
      .set('Authorization', f.bearer)
      .set(IF_MATCH, VERSION)
      .send(body)
      .expect(200);
    expect(updated.body.note).toBeNull();
    expect(updatePto).toHaveBeenCalledWith(
      {
        id: f.owner.id,
        role: 'member',
        credential: { type: 'personal_access_token', tokenId: f.token.id },
        requestId: expect.any(String),
      },
      id,
      body,
      1,
    );
    const notes = fixture({
      scopes: ['pto:create', 'pto:update:self', 'pto:read', 'pto:notes:read'],
    });
    expect(
      (
        await request(notes.app)
          .post('/pto')
          .set('Authorization', notes.bearer)
          .send(body)
          .expect(201)
      ).body.note,
    ).toBe('stored private note');
    expect(
      (
        await request(notes.app)
          .put(`/pto/${id}`)
          .set('Authorization', notes.bearer)
          .set(IF_MATCH, VERSION)
          .send(body)
          .expect(200)
      ).body.note,
    ).toBe('stored private note');
  });

  it('requires explicit team delegation even for a lead; member record authorization still applies', async () => {
    const f = fixture({ role: 'team_lead', scopes: ['pto:update:self', 'pto:delete:self'] });
    const other = { ...f.record, userId: 'other' };
    vi.mocked(getPtoById).mockResolvedValue(other as never);
    await request(f.app)
      .put(`/pto/${id}`)
      .set('Authorization', f.bearer)
      .set(IF_MATCH, VERSION)
      .send(body)
      .expect(403);
    await request(f.app)
      .delete(`/pto/${id}`)
      .set('Authorization', f.bearer)
      .set(IF_MATCH, VERSION)
      .expect(403);
    expect(updatePto).not.toHaveBeenCalled();
    expect(deletePto).not.toHaveBeenCalled();
    const team = fixture({ role: 'admin', scopes: ['pto:update:team', 'pto:delete:team'] });
    vi.mocked(getPtoById).mockResolvedValue(other as never);
    await request(team.app)
      .put(`/pto/${id}`)
      .set('Authorization', team.bearer)
      .set(IF_MATCH, VERSION)
      .send(body)
      .expect(200);
    await request(team.app)
      .delete(`/pto/${id}`)
      .set('Authorization', team.bearer)
      .set(IF_MATCH, VERSION)
      .expect(204);
  });

  it('returns consistent not-found results for missing read/update/delete records', async () => {
    const f = fixture({ scopes: ['pto:read', 'pto:update:self', 'pto:delete:self'] });
    vi.mocked(getPtoById).mockResolvedValue(null);
    await request(f.app).get(`/pto/${id}`).set('Authorization', f.bearer).expect(404);
    await request(f.app)
      .put(`/pto/${id}`)
      .set('Authorization', f.bearer)
      .set(IF_MATCH, VERSION)
      .send(body)
      .expect(404);
    await request(f.app)
      .delete(`/pto/${id}`)
      .set('Authorization', f.bearer)
      .set(IF_MATCH, VERSION)
      .expect(404);
  });

  it('propagates schema and service failures from every handler without exposing private causes', async () => {
    const scopes: TokenScope[] = ['pto:read', 'pto:create', 'pto:update:self', 'pto:delete:self'];
    const f = fixture({ scopes });
    await request(f.app).post('/pto').set('Authorization', f.bearer).send({}).expect(400);
    await request(f.app).get('/pto?start=bad').set('Authorization', f.bearer).expect(400);
    vi.mocked(getPtoById).mockRejectedValueOnce(new Error('private failure'));
    await request(f.app).get(`/pto/${id}`).set('Authorization', f.bearer).expect(500);
    await request(f.app)
      .put(`/pto/${id}`)
      .set('Authorization', f.bearer)
      .set(IF_MATCH, VERSION)
      .send({})
      .expect(400);
    vi.mocked(deletePto).mockRejectedValueOnce(new Error('private failure'));
    await request(f.app)
      .delete(`/pto/${id}`)
      .set('Authorization', f.bearer)
      .set(IF_MATCH, VERSION)
      .expect(500);
  });

  it('attributes every mutation to the verified token and ignores forged body identity or credentials', async () => {
    const f = fixture({ scopes: ['pto:create', 'pto:update:self', 'pto:delete:self'] });
    const forged = {
      ...body,
      actorUserId: 'forged-actor',
      userId: 'forged-owner',
      credential: { type: 'session' },
      requestId: 'forged-request',
    };
    const verified = {
      id: f.owner.id,
      role: 'member',
      credential: { type: 'personal_access_token', tokenId: f.token.id },
      requestId: expect.any(String),
    };
    await request(f.app).post('/pto').set('Authorization', f.bearer).send(forged).expect(201);
    await request(f.app)
      .put(`/pto/${id}`)
      .set('Authorization', f.bearer)
      .set(IF_MATCH, VERSION)
      .send(body)
      .expect(200);
    await request(f.app)
      .delete(`/pto/${id}`)
      .set('Authorization', f.bearer)
      .set(IF_MATCH, VERSION)
      .expect(204);
    expect(vi.mocked(createPto).mock.calls[0]![0]).toEqual(verified);
    expect(vi.mocked(updatePto).mock.calls[0]![0]).toEqual(verified);
    expect(vi.mocked(deletePto).mock.calls[0]![0]).toEqual(verified);
    expect(JSON.stringify(vi.mocked(createPto).mock.calls)).not.toContain('forged');
    expect(JSON.stringify(vi.mocked(updatePto).mock.calls)).not.toContain('forged');
    // A replacement write refuses the forged keys instead of ignoring them.
    const refused = await request(f.app)
      .put(`/pto/${id}`)
      .set('Authorization', f.bearer)
      .set(IF_MATCH, VERSION)
      .send(forged)
      .expect(400);
    expect(refused.body.error.code).toBe('VALIDATION_ERROR');
    expect(vi.mocked(updatePto)).toHaveBeenCalledTimes(1);
  });

  it('keeps the legacy array response for an unmodified caller', async () => {
    const f = fixture({ scopes: ['pto:read'] });
    const res = await request(f.app)
      .get('/pto?start=2026-12-01&end=2026-12-31')
      .set('Authorization', f.bearer)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].note).toBeNull();
    expect(vi.mocked(listVisibleRange)).toHaveBeenCalledWith({
      start: '2026-12-01',
      end: '2026-12-31',
      userId: null,
    });
    expect(vi.mocked(listVisiblePage)).not.toHaveBeenCalled();
  });

  it('applies a validated owner filter to the legacy query', async () => {
    const f = fixture({ scopes: ['pto:read'] });
    await request(f.app)
      .get('/pto?start=2026-12-01&end=2026-12-31&userId=11111111-1111-4111-8111-111111111111')
      .set('Authorization', f.bearer)
      .expect(200);
    expect(vi.mocked(listVisibleRange)).toHaveBeenCalledWith({
      start: '2026-12-01',
      end: '2026-12-31',
      userId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('returns the paged envelope with items, nextCursor and hasMore', async () => {
    const f = fixture({ scopes: ['pto:read'] });
    const res = await request(f.app)
      .get('/pto?start=2026-12-01&end=2026-12-31&format=page&limit=25')
      .set('Authorization', f.bearer)
      .expect(200);
    expect(res.body).toEqual({
      items: [
        {
          id,
          startDate: '2026-12-01',
          endDate: '2026-12-01',
          dayPart: 'all_day',
          version: 1,
          user: { id: f.record.userId, name: 'Owner', colorCode: '#123456' },
          note: null,
        },
      ],
      nextCursor: 'next-page-cursor',
      hasMore: true,
    });
    expect(vi.mocked(listVisiblePage)).toHaveBeenCalledWith(
      { start: '2026-12-01', end: '2026-12-31', userId: null },
      { limit: 25, cursor: null },
    );
    expect(vi.mocked(listVisibleRange)).not.toHaveBeenCalled();
  });

  it('reports a final page with a null cursor and no further rows', async () => {
    const f = fixture({ scopes: ['pto:read'] });
    vi.mocked(listVisiblePage).mockResolvedValue({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
    const res = await request(f.app)
      .get('/pto?start=2026-12-01&end=2026-12-31&format=page')
      .set('Authorization', f.bearer)
      .expect(200);
    expect(res.body).toEqual({ items: [], nextCursor: null, hasMore: false });
    expect(vi.mocked(listVisiblePage)).toHaveBeenCalledWith(
      { start: '2026-12-01', end: '2026-12-31', userId: null },
      { limit: undefined, cursor: null },
    );
  });

  it('rejects an unusable page argument or cursor with a generic validation error', async () => {
    const f = fixture({ scopes: ['pto:read'] });
    const limit = await request(f.app)
      .get('/pto?start=2026-12-01&end=2026-12-31&format=page&limit=0')
      .set('Authorization', f.bearer)
      .expect(400);
    expect(limit.body.error.code).toBe('VALIDATION_ERROR');
    const cursor = await request(f.app)
      .get('/pto?start=2026-12-01&end=2026-12-31&format=page&cursor=not-a-cursor')
      .set('Authorization', f.bearer)
      .expect(400);
    expect(cursor.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(cursor.body)).not.toContain('not-a-cursor');
    expect(vi.mocked(listVisiblePage)).not.toHaveBeenCalled();
  });

  it('requires the version precondition on every write', async () => {
    const f = fixture({ scopes: ['pto:update:self', 'pto:delete:self'] });
    for (const res of [
      await request(f.app).put(`/pto/${id}`).set('Authorization', f.bearer).send(body),
      await request(f.app)
        .patch(`/pto/${id}`)
        .set('Authorization', f.bearer)
        .send({ dayPart: 'morning' }),
      await request(f.app).delete(`/pto/${id}`).set('Authorization', f.bearer),
    ]) {
      expect(res.status).toBe(428);
      expect(res.body.error.code).toBe('PRECONDITION_REQUIRED');
    }
    expect(updatePto).not.toHaveBeenCalled();
    expect(patchPto).not.toHaveBeenCalled();
    expect(deletePto).not.toHaveBeenCalled();
  });

  it.each([
    ['a wildcard', '*'],
    ['a weak validator', 'W/"1"'],
    ['an unquoted number', '1'],
    ['a list of values', '"1", "2"'],
    ['a duplicate header', '"1", "1"'],
    ['text', 'nonsense'],
  ])('refuses %s as the precondition without echoing it', async (_label, header) => {
    const f = fixture({ scopes: ['pto:update:self', 'pto:delete:self'] });
    const res = await request(f.app)
      .put(`/pto/${id}`)
      .set('Authorization', f.bearer)
      .set(IF_MATCH, header)
      .send(body)
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.body)).not.toContain(header);
    expect(updatePto).not.toHaveBeenCalled();
  });

  it('reports a stale write without naming a version or a note', async () => {
    const f = fixture({ scopes: ['pto:update:self'] });
    vi.mocked(updatePto).mockRejectedValueOnce(
      new HttpError(
        412,
        'STALE_WRITE',
        'This PTO entry changed since it was loaded. Reload the entry and apply the change again.',
      ),
    );
    const res = await request(f.app)
      .put(`/pto/${id}`)
      .set('Authorization', f.bearer)
      .set(IF_MATCH, '"5"')
      .send(body)
      .expect(412);
    expect(res.body.error.code).toBe('STALE_WRITE');
    expect(JSON.stringify(res.body)).not.toContain('note');
    expect(JSON.stringify(res.body)).not.toContain('5');
  });

  it('applies a partial write with the same authorization and precondition', async () => {
    const f = fixture({ scopes: ['pto:update:self'] });
    const patched = await request(f.app)
      .patch(`/pto/${id}`)
      .set('Authorization', f.bearer)
      .set(IF_MATCH, VERSION)
      .send({ endDate: '2026-12-02' })
      .expect(200);
    expect(patched.body.version).toBe(1);
    expect(patchPto).toHaveBeenCalledWith(
      expect.objectContaining({ id: f.owner.id }),
      id,
      { endDate: '2026-12-02' },
      1,
    );
  });

  it('rejects an empty or unknown partial write before the record is read', async () => {
    const f = fixture({ scopes: ['pto:update:self'] });
    for (const payload of [
      {},
      { userId: 'other' },
      { dayPart: 'noon' },
      { startDate: '2026-12-01', extra: 1 },
    ]) {
      const res = await request(f.app)
        .patch(`/pto/${id}`)
        .set('Authorization', f.bearer)
        .set(IF_MATCH, VERSION)
        .send(payload)
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(patchPto).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown partial write', async () => {
    const f = fixture({ scopes: ['pto:update:self'] });
    vi.mocked(getPtoById).mockResolvedValue(null);
    const res = await request(f.app)
      .patch(`/pto/${id}`)
      .set('Authorization', f.bearer)
      .set(IF_MATCH, VERSION)
      .send({ dayPart: 'evening' })
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(patchPto).not.toHaveBeenCalled();
  });

  it('refuses a replacement write with an unknown key', async () => {
    const f = fixture({ scopes: ['pto:update:self'] });
    const res = await request(f.app)
      .put(`/pto/${id}`)
      .set('Authorization', f.bearer)
      .set(IF_MATCH, VERSION)
      .send({ ...body, userId: 'other' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(updatePto).not.toHaveBeenCalled();
  });
});
