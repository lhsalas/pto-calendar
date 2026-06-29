import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/server.js';
import { resetEnvForTests } from '../../src/config/env.js';
import { prisma as appPrisma } from '../../src/lib/prisma.js';
import { runSeed } from '../../prisma/seed.js';

const prisma = new PrismaClient();

const REQUIRED_ENV = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'a'.repeat(32),
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test',
} as const;

let app: Express;

describe('Health routes', () => {
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /health', () => {
    it('returns 200 with { status: "ok" } and never touches the database', async () => {
      const querySpy = vi.spyOn(appPrisma, '$queryRaw');
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
      expect(querySpy).not.toHaveBeenCalled();
    });
  });

  describe('GET /ready', () => {
    it('returns 200 with { status, db, uptime } when the database is reachable', async () => {
      const res = await request(app).get('/ready');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'ready', db: 'ok' });
      expect(typeof res.body.uptime).toBe('number');
      expect(res.body.uptime).toBeGreaterThanOrEqual(0);
    });

    it('returns 503 NOT_READY with a reason when the database query fails', async () => {
      vi.spyOn(appPrisma, '$queryRaw').mockRejectedValueOnce(new Error('boom'));
      const res = await request(app).get('/ready');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        error: {
          code: 'NOT_READY',
          message: 'Database unavailable',
          details: { db: 'unreachable', reason: 'boom' },
        },
      });
    });
  });
});
