import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/server.js';
import { resetEnvForTests } from '../../src/config/env.js';
import { prisma as appPrisma } from '../../src/lib/prisma.js';
import { __resetAuthUserCacheForTests } from '../../src/middleware/requireAuth.js';
import { runSeed } from '../../prisma/seed.js';

const prisma = new PrismaClient();

const SEED = {
  lead: { email: 'lead@example.com', password: 'lead-dev-password' },
  dev1: { email: 'dev1@example.com', password: 'dev1-dev-password' },
};
const SEED_EMAILS = ['lead@example.com', 'dev1@example.com', 'dev2@example.com'];

const REQUIRED_ENV = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'aB1!cD2@eF3#gH4$iJ5%kL6&mN7*oP8+',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test',
  COOKIE_SECURE: 'false',
} as const;

let app: Express;

async function loginAs(agent: request.Agent, email: string, password: string): Promise<void> {
  const res = await agent.post('/auth/login').send({ email, password });
  if (res.status !== 200) {
    throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

describe('Holidays routes', () => {
  beforeAll(async () => {
    Object.assign(process.env, REQUIRED_ENV);
    resetEnvForTests();
    await runSeed(prisma);
    app = createApp();
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({});
    await prisma.holiday.deleteMany({});
    await prisma.user.deleteMany({ where: { email: { notIn: SEED_EMAILS } } });
    await prisma.$disconnect();
    await appPrisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.auditLog.deleteMany({});
    await prisma.holiday.deleteMany({});
    __resetAuthUserCacheForTests();
  });

  afterEach(async () => {
    await prisma.holiday.deleteMany({});
  });

  describe('GET /holidays', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await request(app).get('/holidays?start=2026-01-01&end=2026-12-31');
      expect(res.status).toBe(401);
    });

    it('returns 400 on bad query', async () => {
      const agent = request.agent(app);
      await loginAs(agent, SEED.lead.email, SEED.lead.password);
      const res = await agent.get('/holidays?start=bad&end=2026-12-31');
      expect(res.status).toBe(400);
    });

    it('returns holidays in the range for any authenticated user', async () => {
      await prisma.holiday.create({
        data: {
          date: new Date('2026-07-04Z'),
          name: 'Independence Day',
          createdById: (await prisma.user.findUniqueOrThrow({ where: { email: SEED.lead.email } }))
            .id,
        },
      });
      const agent = request.agent(app);
      await loginAs(agent, SEED.dev1.email, SEED.dev1.password);
      const res = await agent.get('/holidays?start=2026-07-01&end=2026-07-31');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        { id: expect.any(String), date: '2026-07-04', name: 'Independence Day', countryCode: null },
      ]);
    });
  });

  describe('POST /holidays', () => {
    it('returns 403 for non-team_lead', async () => {
      const agent = request.agent(app);
      await loginAs(agent, SEED.dev1.email, SEED.dev1.password);
      const res = await agent.post('/holidays').send({ date: '2026-07-04', name: 'X' });
      expect(res.status).toBe(403);
    });

    it('creates a holiday and writes an audit log', async () => {
      const agent = request.agent(app);
      await loginAs(agent, SEED.lead.email, SEED.lead.password);
      const res = await agent
        .post('/holidays')
        .send({ date: '2026-07-04', name: 'Independence Day', countryCode: 'US' });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: expect.any(String),
        date: '2026-07-04',
        name: 'Independence Day',
        countryCode: 'US',
      });
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'create_holiday', entityId: res.body.id },
      });
      expect(audit).not.toBeNull();
      expect(audit?.details).toEqual({
        date: '2026-07-04',
        name: 'Independence Day',
        countryCode: 'US',
      });
    });

    it('returns 409 on duplicate (date, country_code)', async () => {
      const lead = await prisma.user.findUniqueOrThrow({ where: { email: SEED.lead.email } });
      await prisma.holiday.create({
        data: { date: new Date('2026-07-04Z'), name: 'X', countryCode: 'US', createdById: lead.id },
      });
      const agent = request.agent(app);
      await loginAs(agent, SEED.lead.email, SEED.lead.password);
      const res = await agent
        .post('/holidays')
        .send({ date: '2026-07-04', name: 'Y', countryCode: 'US' });
      expect(res.status).toBe(409);
    });

    it('allows two holidays on the same date with different country codes', async () => {
      const lead = await prisma.user.findUniqueOrThrow({ where: { email: SEED.lead.email } });
      await prisma.holiday.create({
        data: {
          date: new Date('2026-07-04Z'),
          name: 'US',
          countryCode: 'US',
          createdById: lead.id,
        },
      });
      const agent = request.agent(app);
      await loginAs(agent, SEED.lead.email, SEED.lead.password);
      const res = await agent
        .post('/holidays')
        .send({ date: '2026-07-04', name: 'MX', countryCode: 'MX' });
      expect(res.status).toBe(201);
    });
  });

  describe('DELETE /holidays/:id', () => {
    it('returns 403 for non-team_lead', async () => {
      const lead = await prisma.user.findUniqueOrThrow({ where: { email: SEED.lead.email } });
      const h = await prisma.holiday.create({
        data: { date: new Date('2026-07-04Z'), name: 'X', createdById: lead.id },
      });
      const agent = request.agent(app);
      await loginAs(agent, SEED.dev1.email, SEED.dev1.password);
      const res = await agent.delete(`/holidays/${h.id}`);
      expect(res.status).toBe(403);
    });

    it('deletes a holiday and writes an audit log', async () => {
      const lead = await prisma.user.findUniqueOrThrow({ where: { email: SEED.lead.email } });
      const h = await prisma.holiday.create({
        data: { date: new Date('2026-07-04Z'), name: 'X', countryCode: 'US', createdById: lead.id },
      });
      const agent = request.agent(app);
      await loginAs(agent, SEED.lead.email, SEED.lead.password);
      const res = await agent.delete(`/holidays/${h.id}`);
      expect(res.status).toBe(204);
      const row = await prisma.holiday.findUnique({ where: { id: h.id } });
      expect(row).toBeNull();
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'delete_holiday', entityId: h.id },
      });
      expect(audit).not.toBeNull();
      expect(audit?.details).toEqual({
        date: '2026-07-04',
        name: 'X',
        countryCode: 'US',
      });
    });

    it('returns 404 for a non-existent id', async () => {
      const agent = request.agent(app);
      await loginAs(agent, SEED.lead.email, SEED.lead.password);
      const res = await agent.delete('/holidays/3fa85f64-5717-4562-b3fc-2c963f66afa6');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /holidays/seed', () => {
    it('returns 403 for non-team_lead', async () => {
      const agent = request.agent(app);
      await loginAs(agent, SEED.dev1.email, SEED.dev1.password);
      const res = await agent.post('/holidays/seed').send({ countryCode: 'US' });
      expect(res.status).toBe(403);
    });

    it('inserts US holidays and is idempotent on re-run', async () => {
      const agent = request.agent(app);
      await loginAs(agent, SEED.lead.email, SEED.lead.password);
      const first = await agent.post('/holidays/seed').send({ countryCode: 'US' });
      expect(first.status).toBe(200);
      expect(first.body.inserted).toBeGreaterThan(0);
      expect(first.body.skipped).toBe(0);
      const second = await agent.post('/holidays/seed').send({ countryCode: 'US' });
      expect(second.status).toBe(200);
      expect(second.body.inserted).toBe(0);
      expect(second.body.skipped).toBe(first.body.inserted);
    });

    it('rejects unsupported country codes', async () => {
      const agent = request.agent(app);
      await loginAs(agent, SEED.lead.email, SEED.lead.password);
      const res = await agent.post('/holidays/seed').send({ countryCode: 'CA' });
      expect(res.status).toBe(400);
    });
  });
});
