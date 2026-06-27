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

async function login(
  agent: ReturnType<typeof request.agent>,
  email: string,
  password: string,
): Promise<void> {
  await agent.post('/auth/login').send({ email, password }).expect(200);
}

describe('PTO routes', () => {
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
    await prisma.pTORequest.deleteMany();
    await prisma.$disconnect();
    await appPrisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.pTORequest.deleteMany();
  });

  describe('POST /pto', () => {
    it('creates a single-day PTO and returns 201 with the public shape', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.lead.email, SEED.lead.password);

      const res = await agent.post('/pto').send({
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'morning',
        note: 'Doctor',
      });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        userId: SEED.lead.id,
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'morning',
        note: 'Doctor',
      });
      expect(res.body).toHaveProperty('id');
      expect(res.body).toHaveProperty('createdAt');
      expect(res.body).toHaveProperty('updatedAt');
    });

    it('normalizes a multi-day PTO to all_day', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);

      const res = await agent
        .post('/pto')
        .send({ startDate: '2026-05-11', endDate: '2026-05-15', dayPart: 'morning' });

      expect(res.status).toBe(201);
      expect(res.body.dayPart).toBe('all_day');
      expect(res.body.note).toBeNull();
    });

    it('allows multi-day PTO that spans a weekend', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);

      const res = await agent.post('/pto').send({ startDate: '2026-05-08', endDate: '2026-05-12' });

      expect(res.status).toBe(201);
      expect(res.body.dayPart).toBe('all_day');
    });

    it('rejects a weekend start with 400', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.lead.email, SEED.lead.password);

      const res = await agent
        .post('/pto')
        .send({ startDate: '2026-05-09', endDate: '2026-05-11', dayPart: 'morning' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a weekend end with 400', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.lead.email, SEED.lead.password);

      const res = await agent.post('/pto').send({ startDate: '2026-05-11', endDate: '2026-05-16' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects single-day PTO missing dayPart with 400', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.lead.email, SEED.lead.password);

      const res = await agent.post('/pto').send({ startDate: '2026-05-11', endDate: '2026-05-11' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects endDate before startDate with 400', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.lead.email, SEED.lead.password);

      const res = await agent
        .post('/pto')
        .send({ startDate: '2026-05-12', endDate: '2026-05-11', dayPart: 'morning' });

      expect(res.status).toBe(400);
    });

    it('rejects note over 500 characters with 400', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.lead.email, SEED.lead.password);

      const res = await agent.post('/pto').send({
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'morning',
        note: 'x'.repeat(501),
      });

      expect(res.status).toBe(400);
    });

    it('returns 401 when not authenticated', async () => {
      const res = await request(app)
        .post('/pto')
        .send({ startDate: '2026-05-11', endDate: '2026-05-11', dayPart: 'morning' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('returns 409 CONFLICT on overlap with same user', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev2.email, SEED.dev2.password);

      await agent
        .post('/pto')
        .send({ startDate: '2026-05-11', endDate: '2026-05-13', dayPart: 'all_day' })
        .expect(201);

      const res = await agent
        .post('/pto')
        .send({ startDate: '2026-05-12', endDate: '2026-05-15', dayPart: 'all_day' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('does not associate the PTO with a userId from the body (uses session)', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.dev1.email, SEED.dev1.password);

      const res = await agent.post('/pto').send({
        userId: SEED.lead.id,
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'morning',
      });

      expect(res.status).toBe(201);
      expect(res.body.userId).toBe(SEED.dev1.id);
    });
  });

  describe('GET /pto?start=&end=', () => {
    it('returns the visible-range PTOs joined with user summary and never includes a note', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.lead.email, SEED.lead.password);

      await agent
        .post('/pto')
        .send({ startDate: '2026-05-11', endDate: '2026-05-15', note: 'Trip' })
        .expect(201);
      await prisma.pTORequest.updateMany({
        where: { userId: SEED.lead.id },
        data: { dayPart: 'all_day' },
      });

      const res = await agent.get('/pto').query({ start: '2026-05-01', end: '2026-05-31' });
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({
        user: { id: SEED.lead.id, name: 'Team Lead', colorCode: '#3B82F6' },
        startDate: '2026-05-11',
        endDate: '2026-05-15',
        dayPart: 'all_day',
      });
      expect(res.body[0].note).toBeNull();
    });

    it('returns multiple PTOs ordered by startDate', async () => {
      const agent1 = request.agent(app);
      const agent2 = request.agent(app);
      await login(agent1, SEED.lead.email, SEED.lead.password);
      await login(agent2, SEED.dev1.email, SEED.dev1.password);

      await agent2
        .post('/pto')
        .send({ startDate: '2026-05-11', endDate: '2026-05-11', dayPart: 'evening' })
        .expect(201);
      await agent1
        .post('/pto')
        .send({ startDate: '2026-05-13', endDate: '2026-05-13', dayPart: 'morning' })
        .expect(201);

      const res = await agent1.get('/pto').query({ start: '2026-05-01', end: '2026-05-31' });
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].startDate).toBe('2026-05-11');
      expect(res.body[1].startDate).toBe('2026-05-13');
    });

    it('omits PTOs that do not overlap the requested range', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.lead.email, SEED.lead.password);

      await agent
        .post('/pto')
        .send({ startDate: '2026-05-11', endDate: '2026-05-13', dayPart: 'all_day' })
        .expect(201);

      const res = await agent.get('/pto').query({ start: '2026-06-01', end: '2026-06-30' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns 400 on missing query params', async () => {
      const agent = request.agent(app);
      await login(agent, SEED.lead.email, SEED.lead.password);
      const res = await agent.get('/pto');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 401 when not authenticated', async () => {
      const res = await request(app).get('/pto').query({ start: '2026-05-01', end: '2026-05-31' });
      expect(res.status).toBe(401);
    });
  });
});
