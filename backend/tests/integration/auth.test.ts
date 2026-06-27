import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/server.js';
import { resetEnvForTests } from '../../src/config/env.js';
import { prisma as appPrisma } from '../../src/lib/prisma.js';
import { runSeed } from '../../prisma/seed.js';

const prisma = new PrismaClient();

const SEED = {
  lead: { email: 'lead@example.com', password: 'lead-dev-password' },
  dev1: { email: 'dev1@example.com', password: 'dev1-dev-password' },
  dev2: { email: 'dev2@example.com', password: 'dev2-dev-password' },
};

const REQUIRED_ENV = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'a'.repeat(32),
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test',
} as const;

let app: Express;

describe('Auth routes', () => {
  beforeAll(async () => {
    Object.assign(process.env, REQUIRED_ENV);
    resetEnvForTests();
    await runSeed(prisma);
    app = createApp();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await appPrisma.$disconnect();
  });

  describe('POST /auth/login', () => {
    it('returns the user and sets a session cookie on valid credentials', async () => {
      const res = await request(app)
        .post('/auth/login')
        .send({ email: SEED.lead.email, password: SEED.lead.password });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        user: {
          email: SEED.lead.email,
          name: 'Team Lead',
          role: 'team_lead',
        },
      });
      expect(res.body.user).not.toHaveProperty('passwordHash');
      const cookies = res.headers['set-cookie'] as string[] | undefined;
      expect(cookies).toBeDefined();
      expect(cookies?.some((c: string) => c.startsWith('session='))).toBe(true);
    });

    it('returns 401 with a generic message on a wrong password (no email enumeration)', async () => {
      const res = await request(app)
        .post('/auth/login')
        .send({ email: SEED.lead.email, password: 'wrong-password' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
      expect(res.body.error.message).toBe('Invalid email or password.');
    });

    it('returns 401 on an unknown email with the same message', async () => {
      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'ghost@example.com', password: 'whatever' });

      expect(res.status).toBe(401);
      expect(res.body.error.message).toBe('Invalid email or password.');
    });

    it('returns 400 VALIDATION_ERROR on missing fields', async () => {
      const res = await request(app).post('/auth/login').send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 VALIDATION_ERROR on malformed email', async () => {
      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'not-an-email', password: 'whatever' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /auth/logout', () => {
    it('returns 204 and clears the session cookie', async () => {
      const agent = request.agent(app);
      await agent
        .post('/auth/login')
        .send({ email: SEED.dev1.email, password: SEED.dev1.password })
        .expect(200);

      const logout = await agent.post('/auth/logout');
      expect(logout.status).toBe(204);
      const cookies = logout.headers['set-cookie'] as string[] | undefined;
      expect(cookies?.some((c: string) => /session=;/.test(c) || /Max-Age=0/.test(c))).toBe(true);
    });

    it('returns 204 even without an active session', async () => {
      const res = await request(app).post('/auth/logout');
      expect(res.status).toBe(204);
    });
  });

  describe('GET /auth/me', () => {
    it('returns the current user when authenticated', async () => {
      const agent = request.agent(app);
      await agent
        .post('/auth/login')
        .send({ email: SEED.dev2.email, password: SEED.dev2.password })
        .expect(200);

      const res = await agent.get('/auth/me');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        email: SEED.dev2.email,
        name: 'Developer Two',
        role: 'member',
      });
      expect(res.body).not.toHaveProperty('passwordHash');
    });

    it('returns 401 when not authenticated', async () => {
      const res = await request(app).get('/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('returns 401 after logout', async () => {
      const agent = request.agent(app);
      await agent
        .post('/auth/login')
        .send({ email: SEED.dev1.email, password: SEED.dev1.password })
        .expect(200);

      await agent.post('/auth/logout').expect(204);
      const res = await agent.get('/auth/me');
      expect(res.status).toBe(401);
    });
  });

  describe('end-to-end session flow', () => {
    it('allows the same agent to log in, fetch /me, and log out', async () => {
      const agent = request.agent(app);

      const meBefore = await agent.get('/auth/me');
      expect(meBefore.status).toBe(401);

      await agent
        .post('/auth/login')
        .send({ email: SEED.lead.email, password: SEED.lead.password })
        .expect(200);

      const meDuring = await agent.get('/auth/me');
      expect(meDuring.status).toBe(200);
      expect(meDuring.body.role).toBe('team_lead');

      await agent.post('/auth/logout').expect(204);

      const meAfter = await agent.get('/auth/me');
      expect(meAfter.status).toBe(401);
    });
  });
});
