import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/server.js';
import { resetEnvForTests } from '../../src/config/env.js';
import { prisma as appPrisma } from '../../src/lib/prisma.js';
import { runSeed } from '../../prisma/seed.js';

const prisma = new PrismaClient();

const SEED = {
  lead: { email: 'lead@example.com', password: 'lead-dev-password', id: '' },
  dev1: { email: 'dev1@example.com', password: 'dev1-dev-password', id: '' },
  dev2: { email: 'dev2@example.com', password: 'dev2-dev-password', id: '' },
};

const REQUIRED_ENV = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'a'.repeat(32),
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

async function createOwnPto(agent: ReturnType<typeof request.agent>): Promise<string> {
  const res = await agent
    .post('/pto')
    .send({ startDate: '2026-05-11', endDate: '2026-05-11', dayPart: 'morning', note: 'Doctor' });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
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
    app = createApp();
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
      const res = await agent.put(`/pto/${ownPtoId}`).send({
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
      const logs = await prisma.auditLog.findMany({ where: { entityId: ownPtoId } });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        actorUserId: SEED.dev1.id,
        action: 'update_pto',
        entityType: 'pto_request',
      });
    });

    it('lets a team lead update another user PTO and audits with their actor id', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.lead.email, SEED.lead.password);
      const res = await agent
        .put(`/pto/${ownPtoId}`)
        .send({ startDate: '2026-05-12', endDate: '2026-05-15', dayPart: 'all_day' });
      expect(res.status).toBe(200);
      const logs = await prisma.auditLog.findMany({ where: { entityId: ownPtoId } });
      expect(logs[0]?.actorUserId).toBe(SEED.lead.id);
    });

    it('returns 403 for a member editing another user PTO', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev2.email, SEED.dev2.password);
      const res = await agent
        .put(`/pto/${ownPtoId}`)
        .send({ startDate: '2026-05-12', endDate: '2026-05-12', dayPart: 'morning' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('returns 404 for an unknown id', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);
      const res = await agent
        .put('/pto/00000000-0000-0000-0000-000000000000')
        .send({ startDate: '2026-05-12', endDate: '2026-05-12', dayPart: 'morning' });
      expect(res.status).toBe(404);
    });

    it('returns 400 on validation error (weekend start)', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);
      const res = await agent
        .put(`/pto/${ownPtoId}`)
        .send({ startDate: '2026-05-09', endDate: '2026-05-11', dayPart: 'all_day' });
      expect(res.status).toBe(400);
    });

    it('returns 409 on overlap with another PTO of the same user', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);
      await agent
        .post('/pto')
        .send({ startDate: '2026-05-13', endDate: '2026-05-13', dayPart: 'all_day' })
        .expect(201);
      const res = await agent
        .put(`/pto/${ownPtoId}`)
        .send({ startDate: '2026-05-13', endDate: '2026-05-13', dayPart: 'all_day' });
      expect(res.status).toBe(409);
    });

    it('returns 401 when not authenticated', async () => {
      const res = await request(app)
        .put(`/pto/${ownPtoId}`)
        .send({ startDate: '2026-05-12', endDate: '2026-05-12', dayPart: 'morning' });
      expect(res.status).toBe(401);
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
      const res = await agent.delete(`/pto/${ownPtoId}`);
      expect(res.status).toBe(204);
      const stillThere = await prisma.pTORequest.findUnique({ where: { id: ownPtoId } });
      expect(stillThere).toBeNull();
      const logs = await prisma.auditLog.findMany({ where: { entityId: ownPtoId } });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        actorUserId: SEED.dev1.id,
        action: 'delete_pto',
      });
    });

    it('lets a team lead delete another user PTO and audits with their actor id', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.lead.email, SEED.lead.password);
      const res = await agent.delete(`/pto/${ownPtoId}`);
      expect(res.status).toBe(204);
      const logs = await prisma.auditLog.findMany({ where: { entityId: ownPtoId } });
      expect(logs[0]?.actorUserId).toBe(SEED.lead.id);
    });

    it('returns 403 for a member deleting another user PTO', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev2.email, SEED.dev2.password);
      const res = await agent.delete(`/pto/${ownPtoId}`);
      expect(res.status).toBe(403);
    });

    it('returns 404 for an unknown id', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);
      const res = await agent.delete('/pto/00000000-0000-0000-0000-000000000000');
      expect(res.status).toBe(404);
    });

    it('returns 401 when not authenticated', async () => {
      const res = await request(app).delete(`/pto/${ownPtoId}`);
      expect(res.status).toBe(401);
    });
  });
});
