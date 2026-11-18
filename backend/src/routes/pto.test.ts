import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { patFixture } from '../../tests/unit/helpers/patFixture.js';
import { resetEnvForTests } from '../config/env.js';
import { ptoRouter } from './pto.js';
import { createPto, deletePto, getPtoById, updatePto } from '../services/pto/PTOService.js';
import { listVisiblePage, listVisibleRange } from '../services/calendar/CalendarQuery.js';
import type { TokenScope } from '../services/tokens/tokenDomain.js';

vi.mock('../services/pto/PTOService.js', async () => ({
  ...(await vi.importActual('../services/pto/PTOService.js')),
  createPto: vi.fn(),
  deletePto: vi.fn(),
  getPtoById: vi.fn(),
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
  createdAt: new Date(),
  updatedAt: new Date(),
};

function fixture(options: Parameters<typeof patFixture>[0] = {}) {
  const f = patFixture(options);
  f.app.use('/pto', ptoRouter);
  f.finish();
  const record = { ...raw, userId: f.owner.id };
  vi.mocked(getPtoById).mockResolvedValue({
    ...record,
    startDate: '2026-12-01',
    endDate: '2026-12-01',
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    user: { id: record.userId, name: 'Owner', colorCode: '#123456' },
  });
  vi.mocked(createPto).mockResolvedValue(record);
  vi.mocked(updatePto).mockResolvedValue(record);
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
          .send(body)
          .expect(200)
      ).body.note,
    ).toBe('stored private note');
  });

  it('requires explicit team delegation even for a lead; member record authorization still applies', async () => {
    const f = fixture({ role: 'team_lead', scopes: ['pto:update:self', 'pto:delete:self'] });
    const other = { ...f.record, userId: 'other' };
    vi.mocked(getPtoById).mockResolvedValue(other as never);
    await request(f.app).put(`/pto/${id}`).set('Authorization', f.bearer).send(body).expect(403);
    await request(f.app).delete(`/pto/${id}`).set('Authorization', f.bearer).expect(403);
    expect(updatePto).not.toHaveBeenCalled();
    expect(deletePto).not.toHaveBeenCalled();
    const team = fixture({ role: 'admin', scopes: ['pto:update:team', 'pto:delete:team'] });
    vi.mocked(getPtoById).mockResolvedValue(other as never);
    await request(team.app)
      .put(`/pto/${id}`)
      .set('Authorization', team.bearer)
      .send(body)
      .expect(200);
    await request(team.app).delete(`/pto/${id}`).set('Authorization', team.bearer).expect(204);
  });

  it('returns consistent not-found results for missing read/update/delete records', async () => {
    const f = fixture({ scopes: ['pto:read', 'pto:update:self', 'pto:delete:self'] });
    vi.mocked(getPtoById).mockResolvedValue(null);
    await request(f.app).get(`/pto/${id}`).set('Authorization', f.bearer).expect(404);
    await request(f.app).put(`/pto/${id}`).set('Authorization', f.bearer).send(body).expect(404);
    await request(f.app).delete(`/pto/${id}`).set('Authorization', f.bearer).expect(404);
  });

  it('propagates schema and service failures from every handler without exposing private causes', async () => {
    const scopes: TokenScope[] = ['pto:read', 'pto:create', 'pto:update:self', 'pto:delete:self'];
    const f = fixture({ scopes });
    await request(f.app).post('/pto').set('Authorization', f.bearer).send({}).expect(400);
    await request(f.app).get('/pto?start=bad').set('Authorization', f.bearer).expect(400);
    vi.mocked(getPtoById).mockRejectedValueOnce(new Error('private failure'));
    await request(f.app).get(`/pto/${id}`).set('Authorization', f.bearer).expect(500);
    await request(f.app).put(`/pto/${id}`).set('Authorization', f.bearer).send({}).expect(400);
    vi.mocked(deletePto).mockRejectedValueOnce(new Error('private failure'));
    await request(f.app).delete(`/pto/${id}`).set('Authorization', f.bearer).expect(500);
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
    await request(f.app).put(`/pto/${id}`).set('Authorization', f.bearer).send(forged).expect(200);
    await request(f.app).delete(`/pto/${id}`).set('Authorization', f.bearer).expect(204);
    expect(vi.mocked(createPto).mock.calls[0]![0]).toEqual(verified);
    expect(vi.mocked(updatePto).mock.calls[0]![0]).toEqual(verified);
    expect(vi.mocked(deletePto).mock.calls[0]![0]).toEqual(verified);
    expect(JSON.stringify(vi.mocked(createPto).mock.calls)).not.toContain('forged');
    expect(JSON.stringify(vi.mocked(updatePto).mock.calls)).not.toContain('forged');
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
});
