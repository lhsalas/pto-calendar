import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../../src/lib/prismaClient.js';
import { createApp, type ManagedApp } from '../../src/server.js';
import { resetEnvForTests } from '../../src/config/env.js';
import { prisma as appPrisma } from '../../src/lib/prisma.js';
import { __resetAuthUserCacheForTests } from '../../src/middleware/requireAuth.js';
import { __resetAgentQuotaForTests } from '../../src/middleware/agentQuota.js';
import { createTokenDatabase } from '../../src/services/tokens/tokenDatabase.js';
import { issueToken } from '../../src/services/tokens/tokenService.js';
import type { AuditActor } from '../../src/services/audit/auditContext.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('An explicit disposable PostgreSQL DATABASE_URL is required');
const fixture = new URL(url);
if (
  !['postgresql:', 'postgres:'].includes(fixture.protocol) ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(fixture.hostname) ||
  fixture.pathname !== '/pto_test'
) {
  throw new Error('Pagination integration tests require the disposable local pto_test database');
}
const db = createPrismaClient(url);
const tokens = createTokenDatabase(url);

const password = 'pto-pagination-integration-password';
const hash = bcrypt.hashSync(password, 4);

interface FixtureUser {
  id: string;
  role: 'member' | 'team_lead' | 'admin';
  email: string;
  name: string;
  colorCode: string;
  passwordHash: string;
}

function newUser(role: FixtureUser['role'], label: string): FixtureUser {
  const id = randomUUID();
  return {
    id,
    role,
    email: `pto-pagination-${label}-${id}@example.test`,
    name: `Pagination ${label}`,
    colorCode: '#123456',
    passwordHash: hash,
  };
}

/** Deterministic, sortable identifiers so the tie-break order is predictable. */
function sortedIds(count: number): string[] {
  return Array.from({ length: count }, () => randomUUID()).sort();
}

function day(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

const users: FixtureUser[] = [
  newUser('member', 'owner'),
  newUser('member', 'foreign'),
  newUser('team_lead', 'lead'),
  newUser('admin', 'admin'),
  newUser('member', 'pat'),
];
const [owner, foreign, lead, admin, patOwner] = users as [
  FixtureUser,
  FixtureUser,
  FixtureUser,
  FixtureUser,
  FixtureUser,
];
const userIds = users.map((user) => user.id);

const tailOwner = owner.id;

const BULK_COUNT = 1050;
const BULK_FOREIGN_COUNT = 1010;
const bulkIds = sortedIds(BULK_COUNT);
const bulkForeignIds = sortedIds(BULK_FOREIGN_COUNT);

/**
 * The non-overlap invariant forbids two rows of one owner on the same day,
 * so the bulk pages are built from one row per distinct owner. The owners
 * are synthetic and own a single row each.
 */
const bulkOwners: FixtureUser[] = Array.from({ length: BULK_COUNT }, (_unused, index) =>
  newUser('member', `bulk-june-${index}`),
);
const tiedOtherOwner: FixtureUser = newUser('member', 'tied-other');
const allFixtureUserIds = [...userIds, ...bulkOwners.map((user) => user.id), tiedOtherOwner.id];

interface RowSpec {
  id: string;
  userId: string;
  startDate: string;
  endDate: string;
  note?: string | null;
}

/** June: many owners share one start date, more rows than the legacy cap. */
const bulkRows: RowSpec[] = bulkIds.map((id, index) => ({
  id,
  userId: bulkOwners[index]!.id,
  startDate: '2026-06-01',
  endDate: '2026-06-01',
}));

/** July: unrelated owners fill the page before the filtered owner's rows. */
const bulkForeignRows: RowSpec[] = bulkForeignIds.map((id, index) => ({
  id,
  userId: bulkOwners[index]!.id,
  startDate: '2026-07-01',
  endDate: '2026-07-01',
}));
/** The filtered owner uses three different days, because one day holds one row. */
const tailRows: RowSpec[] = ['2026-07-02', '2026-07-03', '2026-07-06'].map((date) => ({
  id: randomUUID(),
  userId: tailOwner,
  startDate: date,
  endDate: date,
}));

/** August: an earlier range, a foreign owner and two rows tied across owners. */
const earlierOverlap: RowSpec = {
  id: randomUUID(),
  userId: owner.id,
  startDate: '2026-08-05',
  endDate: '2026-08-12',
};
const foreignTie: RowSpec = {
  id: randomUUID(),
  userId: foreign.id,
  startDate: '2026-08-15',
  endDate: '2026-08-15',
};
/**
 * Two rows that share a start date. One owner cannot hold two rows on the
 * same day any more, so the tie is exercised across owners and the owner
 * comparison stays the tie-break.
 */
const tiedOwnerRows: RowSpec[] = [
  {
    id: randomUUID(),
    userId: owner.id,
    startDate: '2026-08-15',
    endDate: '2026-08-15',
    note: 'private owner note',
  },
  {
    id: randomUUID(),
    userId: tiedOtherOwner.id,
    startDate: '2026-08-15',
    endDate: '2026-08-15',
    note: null,
  },
];

/** One dedicated range per mutation scenario so the scenarios stay isolated. */
const exactRows: RowSpec[] = ['1', '2', '3', '4', '5'].map((suffix) => ({
  id: randomUUID(),
  userId: owner.id,
  startDate: `2026-09-0${suffix}`,
  endDate: `2026-09-0${suffix}`,
}));
const anchorRows: RowSpec[] = ['1', '2', '3', '4', '5'].map((suffix) => ({
  id: randomUUID(),
  userId: owner.id,
  startDate: `2026-10-0${suffix}`,
  endDate: `2026-10-0${suffix}`,
}));
const movementRows: RowSpec[] = ['1', '2', '3', '4', '5'].map((suffix) => ({
  id: randomUUID(),
  userId: owner.id,
  startDate: `2026-11-0${suffix}`,
  endDate: `2026-11-0${suffix}`,
}));
const cursorRows: RowSpec[] = ['1', '2', '3', '4', '5'].map((suffix) => ({
  id: randomUUID(),
  userId: owner.id,
  startDate: `2026-12-0${suffix}`,
  endDate: `2026-12-0${suffix}`,
}));

const allRows: RowSpec[] = [
  ...bulkRows,
  ...bulkForeignRows,
  ...tailRows,
  earlierOverlap,
  foreignTie,
  ...tiedOwnerRows,
  ...exactRows,
  ...anchorRows,
  ...movementRows,
  ...cursorRows,
];

let app: ManagedApp;

function sessionActor(id: string): AuditActor {
  return { id, credential: { type: 'session' }, requestId: 'pto-pagination-integration' };
}

async function login(user: FixtureUser): Promise<string> {
  const res = await request(app)
    .post('/auth/login')
    .send({ email: user.email, password })
    .expect(200);
  const cookies = res.headers['set-cookie'] as unknown as string[];
  return cookies.map((entry) => entry.split(';')[0]).join('; ');
}

async function mint(user: FixtureUser, scopes: string[]): Promise<string> {
  const issued = await issueToken(tokens, sessionActor(user.id), 0, {
    name: 'Pagination integration',
    scopes,
  });
  return `Bearer ${issued.rawToken}`;
}

const AUGUST = { start: '2026-08-10', end: '2026-08-31' };

/** The order the API returns: start date, then owner, then id. */
function expectedOrder(rows: RowSpec[]): string[] {
  return [...rows]
    .sort((left, right) => {
      if (left.startDate !== right.startDate) return left.startDate < right.startDate ? -1 : 1;
      if (left.userId !== right.userId) return left.userId < right.userId ? -1 : 1;
      return left.id < right.id ? -1 : 1;
    })
    .map((row) => row.id);
}

function query(overrides: Record<string, string> = {}): string {
  return new URLSearchParams({ ...AUGUST, ...overrides }).toString();
}

describe('GET /pto paging, owner filtering and cursor validation', () => {
  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: url,
      SESSION_SECRET: 'aB1!cD2@eF3#gH4$iJ5%kL6&mN7*oP8+',
      COOKIE_SECURE: 'false',
      CORS_ORIGIN: 'http://localhost:5173',
      PAT_AUTH_ENABLED: 'true',
      PAT_WRITES_ENABLED: 'false',
      AUTH_RATE_LIMIT_MAX: '1000',
      RATE_LIMIT_MAX: '10000',
      RATE_LIMIT_BEARER_FAILURE_MAX: '1000',
      RATE_LIMIT_USER_QUOTA_MAX: '100000',
      RATE_LIMIT_TOKEN_QUOTA_MAX: '100000',
      RATE_LIMIT_TOKEN_ISSUANCE_MAX: '1000',
      RATE_LIMIT_TOKEN_PASSWORD_MAX: '1000',
    });
    delete process.env.RATE_LIMIT_REDIS_URL;
    resetEnvForTests();
    __resetAuthUserCacheForTests();
    __resetAgentQuotaForTests();
    await db.user.createMany({ data: [...users, ...bulkOwners, tiedOtherOwner] });
    await db.pTORequest.createMany({
      data: allRows.map((row) => ({
        id: row.id,
        userId: row.userId,
        startDate: day(row.startDate),
        endDate: day(row.endDate),
        dayPart: 'all_day' as const,
        note: row.note ?? null,
      })),
    });
    app = createApp();
  });

  afterAll(async () => {
    try {
      await db.auditLog.deleteMany({ where: { actorUserId: { in: allFixtureUserIds } } });
      await db.pTORequest.deleteMany({ where: { userId: { in: allFixtureUserIds } } });
      await db.personalAccessToken.deleteMany({ where: { ownerId: { in: allFixtureUserIds } } });
      await db.user.deleteMany({ where: { id: { in: allFixtureUserIds } } });
    } finally {
      await Promise.all([
        app?.closeResources(),
        tokens.close(),
        db.$disconnect(),
        appPrisma.$disconnect(),
      ]);
    }
  });

  describe('complete traversal', () => {
    it('traverses more than 1,000 matching records without silent truncation', async () => {
      const cookie = await login(owner);
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      let lastHasMore = true;
      do {
        const params = new URLSearchParams({
          start: '2026-06-01',
          end: '2026-06-30',
          format: 'page',
          limit: '200',
        });
        if (cursor) params.set('cursor', cursor);
        const res = await request(app)
          .get(`/pto?${params.toString()}`)
          .set('Cookie', cookie)
          .expect(200);
        expect(res.body.items.length).toBeLessThanOrEqual(200);
        expect(res.body.hasMore).toBe(pages < 5);
        if (res.body.hasMore) expect(typeof res.body.nextCursor).toBe('string');
        else expect(res.body.nextCursor).toBeNull();
        seen.push(...res.body.items.map((item: { id: string }) => item.id));
        cursor = res.body.nextCursor;
        pages += 1;
        lastHasMore = res.body.hasMore;
      } while (cursor && pages < 12);

      expect(lastHasMore).toBe(false);
      expect(pages).toBe(6);
      expect(seen).toHaveLength(BULK_COUNT);
      expect(seen).toEqual(expectedOrder(bulkRows));
    });

    it('keeps the legacy array cap but never loses a filtered owner to it', async () => {
      const cookie = await login(owner);
      const unfiltered = await request(app)
        .get('/pto?start=2026-07-01&end=2026-07-31')
        .set('Cookie', cookie)
        .expect(200);
      expect(unfiltered.body).toHaveLength(1000);
      expect(unfiltered.body.map((item: { id: string }) => item.id)).toEqual(
        expectedOrder(bulkForeignRows).slice(0, 1000),
      );
      expect(
        unfiltered.body.every((item: { user: { id: string } }) => item.user.id !== tailOwner),
      ).toBe(true);

      const filtered = await request(app)
        .get(`/pto?start=2026-07-01&end=2026-07-31&userId=${tailOwner}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(filtered.body).toHaveLength(3);
      expect(
        filtered.body.every((item: { user: { id: string } }) => item.user.id === tailOwner),
      ).toBe(true);

      const paged = await request(app)
        .get(`/pto?start=2026-07-01&end=2026-07-31&userId=${tailOwner}&format=page&limit=2`)
        .set('Cookie', cookie)
        .expect(200);
      expect(paged.body.items).toHaveLength(2);
      expect(paged.body.hasMore).toBe(true);
      const last = await request(app)
        .get(
          `/pto?start=2026-07-01&end=2026-07-31&userId=${tailOwner}&format=page&limit=2&cursor=${encodeURIComponent(paged.body.nextCursor)}`,
        )
        .set('Cookie', cookie)
        .expect(200);
      expect(last.body.items).toHaveLength(1);
      expect(last.body.hasMore).toBe(false);
      expect(last.body.nextCursor).toBeNull();
      expect([...paged.body.items, ...last.body.items].map((i: { id: string }) => i.id)).toEqual(
        expectedOrder(tailRows),
      );
    });
  });

  describe('deterministic ordering', () => {
    it('orders by startDate, then owner, then id and keeps an earlier overlap first', async () => {
      const cookie = await login(owner);
      const res = await request(app).get(`/pto?${query()}`).set('Cookie', cookie).expect(200);
      const ids = res.body.map((item: { id: string }) => item.id);
      const expected = expectedOrder([earlierOverlap, foreignTie, ...tiedOwnerRows]);
      expect(ids).toEqual(expected);

      // A same-owner/date tie cannot exist now. Cross-owner ties and a
      // cursor whose anchor starts before the requested range still page.
      let cursor: string | null = null;
      for (const [index, id] of expected.entries()) {
        const page = await request(app)
          .get(`/pto?${query({ format: 'page', limit: '1', ...(cursor ? { cursor } : {}) })}`)
          .set('Cookie', cookie)
          .expect(200);
        expect(page.body.items.map((item: { id: string }) => item.id)).toEqual([id]);
        expect(page.body.hasMore).toBe(index < expected.length - 1);
        cursor = page.body.nextCursor as string | null;
        if (index < expected.length - 1) expect(typeof cursor).toBe('string');
        else expect(cursor).toBeNull();
      }
    });

    it('returns an empty page for a range without rows', async () => {
      const cookie = await login(owner);
      const res = await request(app)
        .get('/pto?start=2027-03-01&end=2027-03-31&format=page')
        .set('Cookie', cookie)
        .expect(200);
      expect(res.body).toEqual({ items: [], nextCursor: null, hasMore: false });
    });

    it('reports the last page exactly when the result count matches the page size', async () => {
      const cookie = await login(owner);
      const exact = await request(app)
        .get('/pto?start=2026-09-01&end=2026-09-30&format=page&limit=5')
        .set('Cookie', cookie)
        .expect(200);
      expect(exact.body.items).toHaveLength(5);
      expect(exact.body.hasMore).toBe(false);
      expect(exact.body.nextCursor).toBeNull();
    });
  });

  describe('continuation behaviour', () => {
    it('continues after a deleted anchor without looking the anchor up again', async () => {
      const cookie = await login(owner);
      const first = await request(app)
        .get('/pto?start=2026-10-01&end=2026-10-31&format=page&limit=2')
        .set('Cookie', cookie)
        .expect(200);
      expect(first.body.items).toHaveLength(2);
      const anchorId = first.body.items[1].id as string;
      await db.pTORequest.delete({ where: { id: anchorId } });

      const second = await request(app)
        .get(
          `/pto?start=2026-10-01&end=2026-10-31&format=page&limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
        )
        .set('Cookie', cookie)
        .expect(200);
      expect(second.body.items.map((item: { id: string }) => item.id)).toEqual(
        anchorRows.slice(2, 4).map((row) => row.id),
      );
      expect(second.body.hasMore).toBe(true);
    });

    it('reports a row again after it moved behind the cursor so clients can deduplicate', async () => {
      const cookie = await login(owner);
      const first = await request(app)
        .get('/pto?start=2026-11-01&end=2026-11-30&format=page&limit=2')
        .set('Cookie', cookie)
        .expect(200);
      const movedId = first.body.items[0].id as string;
      await db.pTORequest.update({
        where: { id: movedId },
        data: { startDate: day('2026-11-30'), endDate: day('2026-11-30') },
      });

      const second = await request(app)
        .get(
          `/pto?start=2026-11-01&end=2026-11-30&format=page&limit=10&cursor=${encodeURIComponent(first.body.nextCursor)}`,
        )
        .set('Cookie', cookie)
        .expect(200);
      const ids = second.body.items.map((item: { id: string }) => item.id);
      expect(ids).toContain(movedId);
      expect(ids).toEqual(expect.arrayContaining(movementRows.slice(2).map((row) => row.id)));
    });
  });

  describe('cursor and range validation', () => {
    it('rejects malformed, tampered, duplicated and oversized cursors generically', async () => {
      const cookie = await login(owner);
      const page = await request(app)
        .get('/pto?start=2026-12-01&end=2026-12-31&format=page&limit=2')
        .set('Cookie', cookie)
        .expect(200);
      const valid = page.body.nextCursor as string;
      const tampered = `${valid.slice(0, 20)}${valid[20] === 'A' ? 'B' : 'A'}${valid.slice(21)}`;

      for (const cursor of ['not-a-cursor', tampered, 'a'.repeat(513)]) {
        const res = await request(app)
          .get(
            `/pto?start=2026-12-01&end=2026-12-31&format=page&cursor=${encodeURIComponent(cursor)}`,
          )
          .set('Cookie', cookie)
          .expect(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.headers['x-request-id']).toMatch(/^[A-Za-z0-9._-]{1,200}$/);
        expect(JSON.stringify(res.body)).not.toContain(cursor);
      }

      const duplicated = await request(app)
        .get(`/pto?start=2026-12-01&end=2026-12-31&format=page&cursor=${valid}&cursor=${valid}`)
        .set('Cookie', cookie)
        .expect(400);
      expect(duplicated.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a cursor that belongs to another owner filter or another range', async () => {
      const cookie = await login(owner);
      const filtered = await request(app)
        .get(`/pto?start=2026-12-01&end=2026-12-31&userId=${owner.id}&format=page&limit=2`)
        .set('Cookie', cookie)
        .expect(200);
      const cursor = filtered.body.nextCursor as string;

      const otherOwner = await request(app)
        .get(
          `/pto?start=2026-12-01&end=2026-12-31&userId=${foreign.id}&format=page&limit=2&cursor=${encodeURIComponent(cursor)}`,
        )
        .set('Cookie', cookie)
        .expect(400);
      expect(otherOwner.body.error.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(otherOwner.body)).not.toContain(cursor);

      const otherRange = await request(app)
        .get(
          `/pto?start=2026-11-01&end=2026-11-30&userId=${owner.id}&format=page&limit=2&cursor=${encodeURIComponent(cursor)}`,
        )
        .set('Cookie', cookie)
        .expect(400);
      expect(otherRange.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects page-only arguments in the legacy representation', async () => {
      const cookie = await login(owner);
      const cursor = await request(app)
        .get('/pto?start=2026-12-01&end=2026-12-31&cursor=not-a-cursor')
        .set('Cookie', cookie)
        .expect(400);
      expect(cursor.body.error.code).toBe('VALIDATION_ERROR');
      const limit = await request(app)
        .get('/pto?start=2026-12-01&end=2026-12-31&limit=10')
        .set('Cookie', cookie)
        .expect(400);
      expect(limit.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('enforces the inclusive 366-day range and rejects impossible dates in both modes', async () => {
      const cookie = await login(owner);
      await request(app)
        .get('/pto?start=2026-01-01&end=2027-01-01')
        .set('Cookie', cookie)
        .expect(200);
      await request(app)
        .get('/pto?start=2026-01-01&end=2027-01-02')
        .set('Cookie', cookie)
        .expect(400);
      await request(app)
        .get('/pto?start=2026-02-30&end=2026-03-01')
        .set('Cookie', cookie)
        .expect(400);
      await request(app)
        .get('/pto?start=2026-01-01&end=2027-01-01&format=page')
        .set('Cookie', cookie)
        .expect(200);
      await request(app)
        .get('/pto?start=2026-01-01&end=2027-01-02&format=page')
        .set('Cookie', cookie)
        .expect(400);
      await request(app)
        .get('/pto?start=2026-02-30&end=2026-03-01&format=page')
        .set('Cookie', cookie)
        .expect(400);
    });

    it('rejects a page size outside the documented bounds', async () => {
      const cookie = await login(owner);
      for (const limit of ['0', '201', '1e2', ' 10']) {
        await request(app)
          .get(
            `/pto?start=2026-12-01&end=2026-12-31&format=page&limit=${encodeURIComponent(limit)}`,
          )
          .set('Cookie', cookie)
          .expect(400);
      }
    });

    it('echoes a safe correlation identifier and never a submitted cursor', async () => {
      const cookie = await login(owner);
      const res = await request(app)
        .get('/pto?start=2026-12-01&end=2026-12-31&format=page&cursor=not-a-cursor')
        .set('Cookie', cookie)
        .set('X-Request-Id', 'correlation-under-test')
        .expect(400);
      expect(res.headers['x-request-id']).toBe('correlation-under-test');
      expect(JSON.stringify(res.body)).not.toContain('not-a-cursor');
    });
  });

  describe('note privacy and read scope', () => {
    it('keeps list notes null for every session role in both representations', async () => {
      for (const user of [owner, lead, admin]) {
        const cookie = await login(user);
        const legacy = await request(app).get(`/pto?${query()}`).set('Cookie', cookie).expect(200);
        expect(legacy.body.length).toBeGreaterThan(0);
        expect(legacy.body.every((item: { note: unknown }) => item.note === null)).toBe(true);
        const paged = await request(app)
          .get(`/pto?${query({ format: 'page' })}`)
          .set('Cookie', cookie)
          .expect(200);
        expect(paged.body.items.length).toBeGreaterThan(0);
        expect(paged.body.items.every((item: { note: unknown }) => item.note === null)).toBe(true);
        // The paged rows carry the version a write has to name; the legacy
        // array keeps its historical fields and has none.
        expect(
          paged.body.items.every((item: { version: number }) => Number.isInteger(item.version)),
        ).toBe(true);
        expect(legacy.body.every((item: { version?: number }) => item.version === undefined)).toBe(
          true,
        );
      }
    });

    it('keeps list notes null for a note-bearing scoped personal token', async () => {
      const bearer = await mint(owner, ['pto:read', 'pto:notes:read']);
      const detail = await request(app)
        .get(`/pto/${tiedOwnerRows[0]!.id}`)
        .set('Authorization', bearer)
        .expect(200);
      expect(detail.body.note).toBe('private owner note');
      const res = await request(app)
        .get(`/pto?${query({ format: 'page' })}`)
        .set('Authorization', bearer)
        .expect(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      expect(res.body.items.every((item: { note: unknown }) => item.note === null)).toBe(true);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('refuses a personal token without read scope in the paged representation', async () => {
      const bearer = await mint(patOwner, ['pto:create']);
      const res = await request(app)
        .get(`/pto?${query({ format: 'page' })}`)
        .set('Authorization', bearer)
        .expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });
});
