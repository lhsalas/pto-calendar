import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createPrismaClient } from '../../src/lib/prismaClient.js';
import { createApp } from '../../src/server.js';
import { resetEnvForTests } from '../../src/config/env.js';
import { prisma as appPrisma } from '../../src/lib/prisma.js';
import { runSeed } from '../../prisma/seed.js';

const prisma = createPrismaClient(
  process.env.DATABASE_URL ?? 'postgresql://pto:pto@localhost:5432/pto_test?schema=public',
);

const SEED = {
  lead: { email: 'lead@example.com', password: 'lead-dev-password', id: '' },
  dev1: { email: 'dev1@example.com', password: 'dev1-dev-password', id: '' },
  dev2: { email: 'dev2@example.com', password: 'dev2-dev-password', id: '' },
};

const REQUIRED_ENV = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'aB1!cD2@eF3#gH4$iJ5%kL6&mN7*oP8+',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test',
} as const;

let app: Express;
let ownPtoId: string;

async function login(
  agent: ReturnType<typeof request.agent>,
  email: string,
  password: string,
): Promise<void> {
  await agent.post('/auth/login').send({ email, password }).expect(200);
}

/** The precondition every write has to name. */
function ifMatch(version: number): string {
  return `"${version}"`;
}

async function auditRowsFor(entityId: string, action?: string) {
  return prisma.auditLog.findMany({
    where: action ? { entityId, action } : { entityId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

/** Let both real requests read the same revision before either can mutate it. */
async function raceWrites(id: string, send: () => Promise<request.Response[]>) {
  let pending: Promise<request.Response[]> | undefined;
  try {
    await prisma.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM pto_requests WHERE id=${id}::uuid FOR UPDATE
      `;
        expect(locked).toEqual([{ id }]);
        pending = send();
        // The requests are awaited after the lock is released even when the
        // barrier assertion fails; keep early failures from escaping the test.
        void pending.catch(() => undefined);
        await vi.waitFor(
          async () => {
            const [row] = await prisma.$queryRaw<{ waiting: number }[]>`
          SELECT COUNT(*)::int AS waiting FROM pg_stat_activity
          WHERE datname=current_database() AND pid <> pg_backend_pid()
            AND state='active' AND wait_event_type='Lock'
            AND query LIKE '%pto_requests%' AND (query LIKE '%UPDATE%' OR query LIKE '%DELETE%')
        `;
            expect(row?.waiting).toBe(2);
          },
          { timeout: 2500, interval: 20 },
        );
      },
      { timeout: 5000 },
    );
  } catch (err) {
    await pending?.catch(() => undefined);
    throw err;
  }
  return await pending!;
}

/** A rejected or invalid change must leave the complete audit set untouched. */
async function expectOnlyCreateAudit(entityId: string, auditBefore: unknown[]): Promise<void> {
  const after = await auditRowsFor(entityId);
  expect(after).toEqual(auditBefore);
  expect(after).toHaveLength(1);
  expect(after[0]!.action).toBe('create_pto');
}

async function createOwnPto(agent: ReturnType<typeof request.agent>): Promise<string> {
  const res = await agent
    .post('/pto')
    .send({ startDate: '2026-05-11', endDate: '2026-05-11', dayPart: 'morning', note: 'Doctor' });
  expect(res.status).toBe(201);
  const id = (res.body as { id: string }).id;
  // The create is audited in the same transaction as the mutation, and the
  // summary records that a note was written without repeating its text.
  const creates = await auditRowsFor(id, 'create_pto');
  expect(creates).toHaveLength(1);
  expect(creates[0]).toMatchObject({
    actorUserId: SEED.dev1.id,
    action: 'create_pto',
    entityType: 'pto_request',
    entityId: id,
    credentialType: 'session',
    sourceTokenId: null,
    targetOwnerId: SEED.dev1.id,
    details: {
      startDate: '2026-05-11',
      endDate: '2026-05-11',
      dayPart: 'morning',
      noteWritten: true,
    },
  });
  expect(JSON.stringify(creates[0]!.details)).not.toContain('Doctor');
  return id;
}

describe('PTO edit / delete / detail / audit', () => {
  beforeAll(async () => {
    Object.assign(process.env, REQUIRED_ENV);
    resetEnvForTests();
    await runSeed(prisma);
    const [lead, dev1, dev2] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { email: SEED.lead.email } }),
      prisma.user.findUniqueOrThrow({ where: { email: SEED.dev1.email } }),
      prisma.user.findUniqueOrThrow({ where: { email: SEED.dev2.email } }),
    ]);
    SEED.lead.id = lead.id;
    SEED.dev1.id = dev1.id;
    SEED.dev2.id = dev2.id;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.pTORequest.deleteMany();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.pTORequest.deleteMany();
    // Each case gets an independent in-memory limiter, not the suite's shared quota.
    app = createApp();
  });

  describe('GET /pto/:id', () => {
    beforeEach(async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);
      ownPtoId = await createOwnPto(agent);
    });

    it('returns the detail for the owner with the note', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);
      const res = await agent.get(`/pto/${ownPtoId}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: ownPtoId,
        userId: SEED.dev1.id,
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'morning',
        note: 'Doctor',
        user: { id: SEED.dev1.id, name: 'Developer One' },
      });
    });

    it('returns the detail for a team lead with the note', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.lead.email, SEED.lead.password);
      const res = await agent.get(`/pto/${ownPtoId}`);
      expect(res.status).toBe(200);
      expect(res.body.note).toBe('Doctor');
    });

    it('returns the detail for another member with note forced to null', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev2.email, SEED.dev2.password);
      const res = await agent.get(`/pto/${ownPtoId}`);
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe(SEED.dev1.id);
      expect(res.body.note).toBeNull();
    });

    it('returns 404 for an unknown id', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);
      const res = await agent.get('/pto/00000000-0000-0000-0000-000000000000');
      expect(res.status).toBe(404);
    });

    it('returns 400 for a malformed id', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);
      const res = await agent.get('/pto/not-a-uuid');
      expect(res.status).toBe(400);
    });

    it('returns 401 when not authenticated', async () => {
      const res = await request(app).get(`/pto/${ownPtoId}`);
      expect(res.status).toBe(401);
    });
  });

  describe('PUT /pto/:id', () => {
    beforeEach(async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);
      ownPtoId = await createOwnPto(agent);
    });

    it('lets the owner update and writes an audit log entry', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);
      const res = await agent.put(`/pto/${ownPtoId}`).set('If-Match', ifMatch(1)).send({
        startDate: '2026-05-12',
        endDate: '2026-05-12',
        dayPart: 'evening',
        note: 'Edited',
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        startDate: '2026-05-12',
        endDate: '2026-05-12',
        dayPart: 'evening',
        note: 'Edited',
      });
      expect(await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } })).toMatchObject({
        startDate: new Date('2026-05-12T00:00:00.000Z'),
        endDate: new Date('2026-05-12T00:00:00.000Z'),
        dayPart: 'evening',
        note: 'Edited',
      });
      const logs = await auditRowsFor(ownPtoId);
      expect(logs).toHaveLength(2);
      const updates = logs.filter((row) => row.action === 'update_pto');
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        actorUserId: SEED.dev1.id,
        action: 'update_pto',
        entityType: 'pto_request',
        credentialType: 'session',
        sourceTokenId: null,
        targetOwnerId: SEED.dev1.id,
        details: {
          startDate: '2026-05-12',
          endDate: '2026-05-12',
          dayPart: 'evening',
          noteWritten: true,
        },
      });
      // The audit summary never carries the note text.
      expect(JSON.stringify(logs)).not.toContain('Edited');
    });

    it.each(['Doctor', null])(
      'preserves the stored note %s in the response and database and audits that no note was written',
      async (note) => {
        await prisma.pTORequest.update({ where: { id: ownPtoId }, data: { note } });
        const agent = request.agent(app);
        await login(agent, SEED.dev1.email, SEED.dev1.password);
        const res = await agent.put(`/pto/${ownPtoId}`).set('If-Match', ifMatch(1)).send({
          startDate: '2026-05-12',
          endDate: '2026-05-12',
          dayPart: 'evening',
        });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          startDate: '2026-05-12',
          endDate: '2026-05-12',
          dayPart: 'evening',
          note,
        });
        const stored = await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } });
        expect(stored).toMatchObject({
          startDate: new Date('2026-05-12T00:00:00.000Z'),
          endDate: new Date('2026-05-12T00:00:00.000Z'),
          dayPart: 'evening',
          note,
        });
        const logs = await auditRowsFor(ownPtoId);
        expect(logs).toHaveLength(2);
        const updates = logs.filter((row) => row.action === 'update_pto');
        expect(updates).toHaveLength(1);
        expect(updates[0]).toMatchObject({
          actorUserId: SEED.dev1.id,
          action: 'update_pto',
          entityType: 'pto_request',
          credentialType: 'session',
          sourceTokenId: null,
          targetOwnerId: SEED.dev1.id,
          details: {
            startDate: '2026-05-12',
            endDate: '2026-05-12',
            dayPart: 'evening',
            noteWritten: false,
          },
        });
        // Neither the stored note nor the omitted write appears in the audit.
        expect(JSON.stringify(logs)).not.toContain('Doctor');
        expect(updates[0]!.details).not.toHaveProperty('note');
      },
    );

    it('clears the stored note only when an empty string is explicitly sent', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);
      const res = await agent.put(`/pto/${ownPtoId}`).set('If-Match', ifMatch(1)).send({
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'morning',
        note: '',
      });
      expect(res.status).toBe(200);
      expect(res.body.note).toBeNull();
      const stored = await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } });
      expect(stored.note).toBeNull();
      const logs = await auditRowsFor(ownPtoId);
      expect(logs).toHaveLength(2);
      const updates = logs.filter((row) => row.action === 'update_pto');
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        actorUserId: SEED.dev1.id,
        action: 'update_pto',
        details: { noteWritten: true },
      });
      expect(updates[0]!.details).not.toHaveProperty('note');
    });

    it('lets a team lead update another user PTO and audits with their actor id', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.lead.email, SEED.lead.password);
      const res = await agent
        .put(`/pto/${ownPtoId}`)
        .set('If-Match', ifMatch(1))
        .send({ startDate: '2026-05-12', endDate: '2026-05-15', dayPart: 'morning' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ dayPart: 'all_day', note: 'Doctor' });
      expect(await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } })).toMatchObject({
        dayPart: 'all_day',
        note: 'Doctor',
      });
      const logs = await auditRowsFor(ownPtoId);
      expect(logs).toHaveLength(2);
      const updates = logs.filter((row) => row.action === 'update_pto');
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        actorUserId: SEED.lead.id,
        action: 'update_pto',
        credentialType: 'session',
        sourceTokenId: null,
        targetOwnerId: SEED.dev1.id,
        details: { dayPart: 'all_day', noteWritten: false },
      });
      expect(JSON.stringify(logs)).not.toContain('Doctor');
    });

    it('returns 403 for a member editing another user PTO', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev2.email, SEED.dev2.password);
      const before = await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } });
      const auditBefore = await auditRowsFor(ownPtoId);
      const res = await agent
        .put(`/pto/${ownPtoId}`)
        .set('If-Match', ifMatch(1))
        .send({ startDate: '2026-05-12', endDate: '2026-05-12', dayPart: 'morning', note: '' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } })).toEqual(
        before,
      );
      await expectOnlyCreateAudit(ownPtoId, auditBefore);
    });

    it('returns 404 for an unknown id', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);
      const res = await agent
        .put('/pto/00000000-0000-0000-0000-000000000000')
        .set('If-Match', ifMatch(1))
        .send({ startDate: '2026-05-12', endDate: '2026-05-12', dayPart: 'morning' });
      expect(res.status).toBe(404);
    });

    it.each([
      { label: 'null', note: null },
      { label: 'number', note: 0 },
      { label: 'boolean', note: false },
      { label: 'array', note: [] },
      { label: 'object', note: {} },
      { label: 'overlong string', note: 'x'.repeat(501) },
    ])('rejects a $label note without mutation or audit', async ({ note }) => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);
      const before = await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } });
      const auditBefore = await auditRowsFor(ownPtoId);
      const res = await agent.put(`/pto/${ownPtoId}`).set('If-Match', ifMatch(1)).send({
        startDate: '2026-05-12',
        endDate: '2026-05-12',
        dayPart: 'morning',
        note,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } })).toEqual(
        before,
      );
      await expectOnlyCreateAudit(ownPtoId, auditBefore);
    });

    it.each([
      { label: 'missing startDate', payload: { endDate: '2026-05-11', dayPart: 'morning' } },
      { label: 'missing endDate', payload: { startDate: '2026-05-11', dayPart: 'morning' } },
      {
        label: 'single-day missing dayPart',
        payload: { startDate: '2026-05-11', endDate: '2026-05-11' },
      },
      {
        label: 'invalid dayPart',
        payload: { startDate: '2026-05-11', endDate: '2026-05-11', dayPart: 'midday' },
      },
      {
        label: 'weekend start',
        payload: { startDate: '2026-05-09', endDate: '2026-05-11' },
      },
      {
        label: 'weekend end',
        payload: { startDate: '2026-05-11', endDate: '2026-05-16' },
      },
      {
        label: 'invalid date',
        payload: { startDate: '2026-02-30', endDate: '2026-05-11' },
      },
      {
        label: 'reversed dates',
        payload: { startDate: '2026-05-12', endDate: '2026-05-11' },
      },
    ])('still rejects $label without clearing the note or auditing', async ({ payload }) => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);
      const before = await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } });
      const auditBefore = await auditRowsFor(ownPtoId);
      const res = await agent
        .put(`/pto/${ownPtoId}`)
        .set('If-Match', ifMatch(1))
        .send({ ...payload, note: '' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } })).toEqual(
        before,
      );
      await expectOnlyCreateAudit(ownPtoId, auditBefore);
    });

    it('returns 409 on overlap with another PTO of the same user', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);
      await agent
        .post('/pto')
        .send({ startDate: '2026-05-13', endDate: '2026-05-13', dayPart: 'all_day' })
        .expect(201);
      const before = await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } });
      const auditBefore = await auditRowsFor(ownPtoId);
      const res = await agent
        .put(`/pto/${ownPtoId}`)
        .set('If-Match', ifMatch(1))
        .send({ startDate: '2026-05-13', endDate: '2026-05-13', dayPart: 'all_day', note: '' });
      expect(res.status).toBe(409);
      expect(await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } })).toEqual(
        before,
      );
      await expectOnlyCreateAudit(ownPtoId, auditBefore);
    });

    it('returns 401 when not authenticated', async () => {
      const before = await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } });
      const auditBefore = await auditRowsFor(ownPtoId);
      const res = await request(app)
        .put(`/pto/${ownPtoId}`)
        .set('If-Match', ifMatch(1))
        .send({ startDate: '2026-05-12', endDate: '2026-05-12', dayPart: 'morning', note: '' });
      expect(res.status).toBe(401);
      expect(await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } })).toEqual(
        before,
      );
      await expectOnlyCreateAudit(ownPtoId, auditBefore);
    });

    it('refuses a write without the version precondition and changes nothing', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);
      const before = await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } });
      const auditBefore = await auditRowsFor(ownPtoId);
      for (const res of [
        await agent
          .put(`/pto/${ownPtoId}`)
          .send({ startDate: '2026-05-12', endDate: '2026-05-12' }),
        await agent.patch(`/pto/${ownPtoId}`).send({ dayPart: 'evening' }),
      ]) {
        expect(res.status).toBe(428);
        expect(res.body.error.code).toBe('PRECONDITION_REQUIRED');
        expect(JSON.stringify(res.body)).not.toContain('Doctor');
      }
      expect(await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } })).toEqual(
        before,
      );
      await expectOnlyCreateAudit(ownPtoId, auditBefore);
    });

    it.each([
      ['a wildcard', '*'],
      ['a weak validator', 'W/"1"'],
      ['an unquoted number', '1'],
      ['a list of values', '"1", "2"'],
      ['text', 'not-a-version'],
    ])('refuses %s as the precondition without echoing it', async (_label, header) => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);
      const before = await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } });
      const auditBefore = await auditRowsFor(ownPtoId);
      const res = await agent
        .put(`/pto/${ownPtoId}`)
        .set('If-Match', header)
        .send({ startDate: '2026-05-12', endDate: '2026-05-12', dayPart: 'morning' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(res.body)).not.toContain(header);
      expect(await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } })).toEqual(
        before,
      );
      await expectOnlyCreateAudit(ownPtoId, auditBefore);
    });

    it('refuses an outdated version and leaves the newer record untouched', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);
      // A first write moves the record to its next version.
      const first = await agent
        .put(`/pto/${ownPtoId}`)
        .set('If-Match', ifMatch(1))
        .send({ startDate: '2026-05-12', endDate: '2026-05-12', dayPart: 'evening' });
      expect(first.status).toBe(200);
      expect(first.body.version).toBe(2);
      const stored = await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } });
      expect(stored.version).toBe(2);
      const auditBefore = await auditRowsFor(ownPtoId);
      const stale = await agent
        .put(`/pto/${ownPtoId}`)
        .set('If-Match', ifMatch(1))
        .send({ startDate: '2026-05-13', endDate: '2026-05-13', dayPart: 'morning' });
      expect(stale.status).toBe(412);
      expect(stale.body.error.code).toBe('STALE_WRITE');
      expect(JSON.stringify(stale.body)).not.toContain('Doctor');
      expect(await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } })).toEqual(
        stored,
      );
      expect(auditBefore).toHaveLength(2);
      expect(await auditRowsFor(ownPtoId)).toEqual(auditBefore);
    });

    it('lets exactly one of two independent sessions write the same version', async () => {
      const first = request.agent(app);
      const second = request.agent(app);
      await login(first, SEED.dev1.email, SEED.dev1.password);
      await login(second, SEED.dev1.email, SEED.dev1.password);
      const results = await raceWrites(ownPtoId, () =>
        Promise.all([
          first
            .put(`/pto/${ownPtoId}`)
            .set('If-Match', ifMatch(1))
            .send({ startDate: '2026-05-12', endDate: '2026-05-12', dayPart: 'evening' }),
          second
            .put(`/pto/${ownPtoId}`)
            .set('If-Match', ifMatch(1))
            .send({ startDate: '2026-05-13', endDate: '2026-05-13', dayPart: 'morning' }),
        ]),
      );
      expect(results.filter((res) => res.status === 200)).toHaveLength(1);
      expect(results.filter((res) => res.status === 412)).toHaveLength(1);
      const stored = await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } });
      expect(stored.version).toBe(2);
      const logs = await auditRowsFor(ownPtoId, 'update_pto');
      expect(logs).toHaveLength(1);
    });

    it('lets exactly one of a concurrent update and delete win', async () => {
      const first = request.agent(app);
      const second = request.agent(app);
      await login(first, SEED.dev1.email, SEED.dev1.password);
      await login(second, SEED.dev1.email, SEED.dev1.password);
      const results = await raceWrites(ownPtoId, () =>
        Promise.all([
          first
            .put(`/pto/${ownPtoId}`)
            .set('If-Match', ifMatch(1))
            .send({ startDate: '2026-05-12', endDate: '2026-05-12', dayPart: 'evening' }),
          second.delete(`/pto/${ownPtoId}`).set('If-Match', ifMatch(1)),
        ]),
      );
      expect(results.filter((res) => res.status === 200 || res.status === 204)).toHaveLength(1);
      expect(results.filter((res) => res.status === 412)).toHaveLength(1);
      const logs = await auditRowsFor(ownPtoId);
      const mutations = logs.filter((row) => row.action !== 'create_pto');
      expect(mutations).toHaveLength(1);
      const stored = await prisma.pTORequest.findUnique({ where: { id: ownPtoId } });
      if (results.some((res) => res.status === 204)) {
        expect(mutations[0]?.action).toBe('delete_pto');
        expect(stored).toBeNull();
      } else {
        expect(mutations[0]?.action).toBe('update_pto');
        expect(stored?.version).toBe(2);
      }
    });
  });

  describe('PATCH /pto/:id', () => {
    beforeEach(async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);
      ownPtoId = await createOwnPto(agent);
    });

    it('changes only the named field and keeps every other stored value', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);
      const res = await agent
        .patch(`/pto/${ownPtoId}`)
        .set('If-Match', ifMatch(1))
        .send({ dayPart: 'evening' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'evening',
        note: 'Doctor',
        version: 2,
      });
      const stored = await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } });
      expect(stored).toMatchObject({
        startDate: new Date('2026-05-11T00:00:00.000Z'),
        endDate: new Date('2026-05-11T00:00:00.000Z'),
        dayPart: 'evening',
        note: 'Doctor',
        version: 2,
      });
      const updates = await auditRowsFor(ownPtoId, 'update_pto');
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        actorUserId: SEED.dev1.id,
        action: 'update_pto',
        details: {
          startDate: '2026-05-11',
          endDate: '2026-05-11',
          dayPart: 'evening',
          noteWritten: false,
        },
      });
      expect(JSON.stringify(updates[0]!.details)).not.toContain('Doctor');
    });

    it.each([
      ['null', null],
      ['an empty string', ''],
    ])('clears the stored note when the patch carries %s', async (_label, note) => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);
      const res = await agent.patch(`/pto/${ownPtoId}`).set('If-Match', ifMatch(1)).send({ note });
      expect(res.status).toBe(200);
      expect(res.body.note).toBeNull();
      const stored = await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } });
      expect(stored.note).toBeNull();
      expect(stored.version).toBe(2);
    });

    it('lets a team lead patch a teammate entry without overwriting its note', async () => {
      const lead = request.agent(app);
      await login(lead, SEED.lead.email, SEED.lead.password);
      const res = await lead
        .patch(`/pto/${ownPtoId}`)
        .set('If-Match', ifMatch(1))
        .send({ dayPart: 'evening' });
      expect(res.status).toBe(200);
      expect(res.body.note).toBe('Doctor');
      const stored = await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } });
      expect(stored.note).toBe('Doctor');
    });

    it('rejects an empty body, an unknown key and an unusable merged record', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);
      const before = await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } });
      const auditBefore = await auditRowsFor(ownPtoId);
      for (const payload of [
        {},
        { userId: SEED.lead.id },
        { dayPart: 'midday' },
        { startDate: '2026-05-09' },
        { endDate: '2026-05-13' },
      ]) {
        const res = await agent.patch(`/pto/${ownPtoId}`).set('If-Match', ifMatch(1)).send(payload);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
      expect(await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } })).toEqual(
        before,
      );
      await expectOnlyCreateAudit(ownPtoId, auditBefore);
    });

    it('refuses a member editing another user PTO and an outdated version', async () => {
      const other = request.agent(app);
      await login(other, SEED.dev2.email, SEED.dev2.password);
      const forbidden = await other
        .patch(`/pto/${ownPtoId}`)
        .set('If-Match', ifMatch(1))
        .send({ dayPart: 'evening' });
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.error.code).toBe('FORBIDDEN');

      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);
      const stale = await agent
        .patch(`/pto/${ownPtoId}`)
        .set('If-Match', ifMatch(7))
        .send({ dayPart: 'evening' });
      expect(stale.status).toBe(412);
      expect(stale.body.error.code).toBe('STALE_WRITE');
    });
  });

  describe('DELETE /pto/:id', () => {
    beforeEach(async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);
      ownPtoId = await createOwnPto(agent);
    });

    it('lets the owner delete and writes an audit log entry', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);
      const res = await agent.delete(`/pto/${ownPtoId}`).set('If-Match', ifMatch(1));
      expect(res.status).toBe(204);
      const stillThere = await prisma.pTORequest.findUnique({ where: { id: ownPtoId } });
      expect(stillThere).toBeNull();
      const logs = await auditRowsFor(ownPtoId);
      expect(logs).toHaveLength(2);
      const deletions = logs.filter((row) => row.action === 'delete_pto');
      expect(deletions).toHaveLength(1);
      expect(deletions[0]).toMatchObject({
        actorUserId: SEED.dev1.id,
        action: 'delete_pto',
        entityType: 'pto_request',
        credentialType: 'session',
        sourceTokenId: null,
        targetOwnerId: SEED.dev1.id,
      });
    });

    it('lets a team lead delete another user PTO and audits with their actor id', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.lead.email, SEED.lead.password);
      const res = await agent.delete(`/pto/${ownPtoId}`).set('If-Match', ifMatch(1));
      expect(res.status).toBe(204);
      const logs = await auditRowsFor(ownPtoId);
      expect(logs).toHaveLength(2);
      const deletions = logs.filter((row) => row.action === 'delete_pto');
      expect(deletions).toHaveLength(1);
      expect(deletions[0]?.actorUserId).toBe(SEED.lead.id);
      expect(deletions[0]?.targetOwnerId).toBe(SEED.dev1.id);
    });

    it('returns 403 for a member deleting another user PTO', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev2.email, SEED.dev2.password);
      const res = await agent.delete(`/pto/${ownPtoId}`).set('If-Match', ifMatch(1));
      expect(res.status).toBe(403);
    });

    it('refuses an outdated version and keeps the newer record', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);
      const updated = await agent
        .put(`/pto/${ownPtoId}`)
        .set('If-Match', ifMatch(1))
        .send({ startDate: '2026-05-12', endDate: '2026-05-12', dayPart: 'evening' });
      expect(updated.status).toBe(200);
      const stored = await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } });
      expect(stored.version).toBe(2);
      const auditBefore = await auditRowsFor(ownPtoId);
      const stale = await agent.delete(`/pto/${ownPtoId}`).set('If-Match', ifMatch(1));
      expect(stale.status).toBe(412);
      expect(stale.body.error.code).toBe('STALE_WRITE');
      expect(await prisma.pTORequest.findUniqueOrThrow({ where: { id: ownPtoId } })).toEqual(
        stored,
      );
      expect(auditBefore).toHaveLength(2);
      expect(await auditRowsFor(ownPtoId)).toEqual(auditBefore);
    });

    it('returns 404 for an unknown id', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);
      const res = await agent
        .delete('/pto/00000000-0000-0000-0000-000000000000')
        .set('If-Match', ifMatch(1));
      expect(res.status).toBe(404);
    });

    it('returns 401 when not authenticated', async () => {
      const res = await request(app).delete(`/pto/${ownPtoId}`).set('If-Match', ifMatch(1));
      expect(res.status).toBe(401);
    });
  });
});
