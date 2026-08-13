import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
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

describe('Users routes', () => {
  beforeAll(async () => {
    Object.assign(process.env, REQUIRED_ENV);
    resetEnvForTests();
    await runSeed(prisma);
    app = createApp();
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { notIn: SEED_EMAILS } } });
    await prisma.$disconnect();
    await appPrisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.user.deleteMany({ where: { email: { notIn: SEED_EMAILS } } });
    __resetAuthUserCacheForTests();
  });

  afterEach(async () => {
    await prisma.user.deleteMany({ where: { email: { notIn: SEED_EMAILS } } });
  });

  async function loginAs(email: string, password: string): Promise<string> {
    const res = await request(app).post('/auth/login').send({ email, password });
    if (res.status !== 200) {
      console.error('LOGIN FAILED for', email, 'status', res.status, 'body', res.body);
    }
    expect(res.status).toBe(200);
    const cookies = res.headers['set-cookie'] as unknown as string[] | undefined;
    expect(cookies).toBeDefined();
    // Return all session cookies (the body + the signature) joined with
    // '; ' so subsequent requests carry the full signed payload.
    const sessionCookies = cookies!.filter(
      (c) => c.startsWith('session=') || c.startsWith('session.'),
    );
    expect(sessionCookies.length).toBeGreaterThan(0);
    return sessionCookies.map((c) => c.split(';')[0]!).join('; ');
  }

  describe('POST /users', () => {
    it('requires authentication', async () => {
      const res = await request(app)
        .post('/users')
        .send({ email: 'new1@example.com', name: 'New One', password: 'good-password' });
      expect(res.status).toBe(401);
    });

    it('forbids non-team-lead members', async () => {
      const cookie = await loginAs(SEED.dev1.email, SEED.dev1.password);
      const res = await request(app)
        .post('/users')
        .set('Cookie', cookie)
        .send({ email: 'new1@example.com', name: 'New One', password: 'good-password' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('creates a member and returns a one-time setup token', async () => {
      const cookie = await loginAs(SEED.lead.email, SEED.lead.password);
      const res = await request(app)
        .post('/users')
        .set('Cookie', cookie)
        .send({ email: 'newmember@example.com', name: 'New Member' });
      expect(res.status).toBe(201);
      expect(res.body.user.email).toBe('newmember@example.com');
      expect(res.body.user.role).toBe('member');
      expect(res.body.setupToken).toMatch(/^[a-f0-9]{64}$/);
      expect(typeof res.body.expiresAt).toBe('string');
      const created = await prisma.user.findUnique({ where: { email: 'newmember@example.com' } });
      expect(created).not.toBeNull();
      expect(created!.passwordHash).toBeNull();
      expect(created!.setupTokenHash).not.toBeNull();
    });

    it('returns 409 on duplicate email (lowercased)', async () => {
      const cookie = await loginAs(SEED.lead.email, SEED.lead.password);
      // Seed includes lead@example.com; the route lowercases the
      // submitted email before the unique check.
      const res = await request(app)
        .post('/users')
        .set('Cookie', cookie)
        .send({ email: 'LEAD@example.com', name: 'Dup' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('returns 400 on validation error', async () => {
      const cookie = await loginAs(SEED.lead.email, SEED.lead.password);
      const res = await request(app)
        .post('/users')
        .set('Cookie', cookie)
        .send({ email: 'bad', name: '' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /auth/setup-account', () => {
    it('redeems a valid token, sets a password, and starts a session', async () => {
      const leadCookie = await loginAs(SEED.lead.email, SEED.lead.password);
      const createRes = await request(app)
        .post('/users')
        .set('Cookie', leadCookie)
        .send({ email: 'fresh@example.com', name: 'Fresh' });
      const token = createRes.body.setupToken as string;
      expect(typeof token).toBe('string');
      const res = await request(app)
        .post('/auth/setup-account')
        .send({ token, password: 'real-password-1' });
      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe('fresh@example.com');
      const cookies = res.headers['set-cookie'] as unknown as string[] | undefined;
      expect(cookies).toBeDefined();
      const sessionCookies = cookies!.filter(
        (c) => c.startsWith('session=') || c.startsWith('session.'),
      );
      expect(sessionCookies.length).toBeGreaterThan(0);
      const me = await request(app)
        .get('/auth/me')
        .set('Cookie', sessionCookies.map((c) => c.split(';')[0]!).join('; '));
      expect(me.status).toBe(200);
      expect(me.body.email).toBe('fresh@example.com');
      const after = await prisma.user.findUnique({ where: { email: 'fresh@example.com' } });
      expect(after!.setupTokenHash).toBeNull();
    });

    it('rejects a spent token (no enumeration leak)', async () => {
      const leadCookie = await loginAs(SEED.lead.email, SEED.lead.password);
      const createRes = await request(app)
        .post('/users')
        .set('Cookie', leadCookie)
        .send({ email: 'spent@example.com', name: 'Spent' });
      const token = createRes.body.setupToken as string;
      const r1 = await request(app)
        .post('/auth/setup-account')
        .send({ token, password: 'first-password' });
      expect(r1.status).toBe(200);
      const r2 = await request(app)
        .post('/auth/setup-account')
        .send({ token, password: 'second-password' });
      expect(r2.status).toBe(401);
      expect(r2.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('allows only one concurrent redemption of the same token', async () => {
      const leadCookie = await loginAs(SEED.lead.email, SEED.lead.password);
      const createRes = await request(app)
        .post('/users')
        .set('Cookie', leadCookie)
        .send({ email: 'race@example.com', name: 'Race' });
      const token = createRes.body.setupToken as string;

      const results = await Promise.all([
        request(app).post('/auth/setup-account').send({ token, password: 'first-password' }),
        request(app).post('/auth/setup-account').send({ token, password: 'second-password' }),
      ]);
      const statuses = results.map((result) => result.status).sort((a, b) => a - b);
      expect(statuses).toEqual([401, 200]);
    });

    it('rejects an unknown token (same 401 as spent)', async () => {
      const res = await request(app)
        .post('/auth/setup-account')
        .send({ token: 'a'.repeat(64), password: 'whatever-password' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('POST /users/:id/reset-password', () => {
    it('revokes existing sessions for the reset user', async () => {
      const leadCookie = await loginAs(SEED.lead.email, SEED.lead.password);
      const passwordHash = await bcrypt.hash('old-password', 4);
      const target = await prisma.user.create({
        data: {
          email: 'active-session@example.com',
          name: 'Active Session',
          role: 'member',
          colorCode: '#000000',
          passwordHash,
        },
      });
      const oldCookie = await loginAs('active-session@example.com', 'old-password');

      const res = await request(app)
        .post(`/users/${target.id}/reset-password`)
        .set('Cookie', leadCookie);
      expect(res.status).toBe(200);

      const staleSession = await request(app).get('/auth/me').set('Cookie', oldCookie);
      expect(staleSession.status).toBe(401);
      expect(staleSession.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('issues a fresh token for an existing member', async () => {
      const leadCookie = await loginAs(SEED.lead.email, SEED.lead.password);
      const created = await prisma.user.create({
        data: {
          email: 'resetme@example.com',
          name: 'Reset Me',
          role: 'member',
          colorCode: '#000000',
          passwordHash: 'something-old',
        },
      });
      const res = await request(app)
        .post(`/users/${created.id}/reset-password`)
        .set('Cookie', leadCookie);
      expect(res.status).toBe(200);
      expect(res.body.setupToken).toMatch(/^[a-f0-9]{64}$/);
      const after = await prisma.user.findUnique({ where: { id: created.id } });
      expect(after!.passwordHash).toBeNull();
      expect(after!.setupTokenHash).not.toBeNull();
    });

    it('blocks self-reset', async () => {
      const leadCookie = await loginAs(SEED.lead.email, SEED.lead.password);
      const me = await prisma.user.findUnique({ where: { email: SEED.lead.email } });
      const res = await request(app)
        .post(`/users/${me!.id}/reset-password`)
        .set('Cookie', leadCookie);
      expect(res.status).toBe(400);
    });

    it('blocks resetting the only team_lead in the system', async () => {
      const leadCookie = await loginAs(SEED.lead.email, SEED.lead.password);
      const me = await prisma.user.findUnique({ where: { email: SEED.lead.email } });
      const res = await request(app)
        .post(`/users/${me!.id}/reset-password`)
        .set('Cookie', leadCookie);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 404 for an unknown user', async () => {
      const leadCookie = await loginAs(SEED.lead.email, SEED.lead.password);
      const res = await request(app)
        .post('/users/00000000-0000-0000-0000-000000000000/reset-password')
        .set('Cookie', leadCookie);
      expect(res.status).toBe(404);
    });

    it('forbids non-team-lead', async () => {
      const memberCookie = await loginAs(SEED.dev1.email, SEED.dev1.password);
      const target = await prisma.user.create({
        data: {
          email: 'r2@example.com',
          name: 'R2',
          role: 'member',
          colorCode: '#000000',
          passwordHash: 'x',
        },
      });
      const res = await request(app)
        .post(`/users/${target.id}/reset-password`)
        .set('Cookie', memberCookie);
      expect(res.status).toBe(403);
    });
  });

  describe('GET /users', () => {
    it('returns the user list for a team lead', async () => {
      const cookie = await loginAs(SEED.lead.email, SEED.lead.password);
      const res = await request(app).get('/users').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const emails = (res.body as Array<{ email: string }>).map((u) => u.email);
      expect(emails).toContain(SEED.lead.email);
      expect(emails).toContain(SEED.dev1.email);
    });

    it('forbids non-team-lead', async () => {
      const cookie = await loginAs(SEED.dev1.email, SEED.dev1.password);
      const res = await request(app).get('/users').set('Cookie', cookie);
      expect(res.status).toBe(403);
    });
  });
});
