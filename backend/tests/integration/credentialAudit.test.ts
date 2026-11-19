import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaClient } from '../../src/lib/prismaClient.js';
import { prisma as appPrisma } from '../../src/lib/prisma.js';
import { createApp, type ManagedApp } from '../../src/server.js';
import { resetEnvForTests } from '../../src/config/env.js';
import { createTokenDatabase } from '../../src/services/tokens/tokenDatabase.js';
import {
  changeRoleAndInvalidate,
  issueToken,
  revokeAllTokens,
  revokeToken,
} from '../../src/services/tokens/tokenService.js';
import { resetUserPassword, setupAccount } from '../../src/services/users/UserService.js';
import { createPto, deletePto, updatePto } from '../../src/services/pto/PTOService.js';
import { HttpError } from '../../src/middleware/errorHandler.js';
import {
  attributedActorFromAuth,
  trustedOperatorActor,
  type AttributedActor,
} from '../../src/services/audit/auditContext.js';
import { clearFixtureCreateKeys, ptoCreateKey } from '../helpers/ptoCreateKey.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Explicit disposable PostgreSQL DATABASE_URL is required');
const url: string = databaseUrl;
const db = createPrismaClient(url);
const tokens = createTokenDatabase(url);

const OWNER = randomUUID();
const LEAD = randomUUID();
const OTHER = randomUUID();
const IDS = [OWNER, LEAD, OTHER];
const NOTE = 'integration-private-note-marker';
const PASSWORD = 'audit-integration-password';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

const USERS = [
  { id: OWNER, email: `audit-owner-${OWNER}@example.test`, name: 'Audit owner', role: 'member' },
  { id: LEAD, email: `audit-lead-${LEAD}@example.test`, name: 'Audit lead', role: 'team_lead' },
  { id: OTHER, email: `audit-other-${OTHER}@example.test`, name: 'Audit other', role: 'member' },
] as const;

const OWNER_EMAIL = USERS[0].email;
const LEAD_EMAIL = USERS[1].email;
const OTHER_EMAIL = USERS[2].email;

/** Attribution always comes from a verified request context, never from labels. */
function sessionActor(id: string, role: 'member' | 'team_lead' | 'admin'): AttributedActor {
  return attributedActorFromAuth({
    method: 'session',
    actor: { id, role },
    requestId: 'audit-integration-session',
  });
}

function patActor(
  id: string,
  role: 'member' | 'team_lead' | 'admin',
  tokenId: string,
): AttributedActor {
  return attributedActorFromAuth({
    method: 'pat',
    actor: { id, role },
    requestId: 'audit-integration-pat',
    tokenId,
    scopes: ['pto:read', 'pto:create', 'pto:update:self', 'pto:delete:self'],
    expiresAt: new Date(Date.now() + 86_400_000),
  });
}

function urlWithSchema(schema: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', schema);
  return parsed.toString();
}

async function auditRows(entityType: string, entityId: string) {
  return db.auditLog.findMany({
    where: { entityType, entityId },
    orderBy: { createdAt: 'asc' },
  });
}

describe('credential-attributed audit trail', () => {
  beforeAll(async () => {
    await db.user.createMany({
      data: USERS.map((user) => ({
        ...user,
        colorCode: '#123456',
        passwordHash: PASSWORD_HASH,
        sessionVersion: 0,
      })),
    });
  });

  beforeEach(async () => {
    // Audit rows reference their actor, so they are cleared before the users.
    await db.auditLog.deleteMany({ where: { actorUserId: { in: IDS } } });
    await db.personalAccessToken.deleteMany({ where: { ownerId: { in: IDS } } });
    await db.pTORequest.deleteMany({ where: { userId: { in: IDS } } });
    await db.user.updateMany({
      where: { id: { in: IDS } },
      data: {
        role: 'member',
        passwordHash: PASSWORD_HASH,
        sessionVersion: 0,
        setupTokenHash: null,
        setupTokenExpiresAt: null,
      },
    });
    // The lead keeps its fixture role, so the lead routes are exercised truthfully.
    await db.user.update({ where: { id: LEAD }, data: { role: 'team_lead' } });
  });

  afterAll(async () => {
    try {
      await clearFixtureCreateKeys(db, IDS);
      await db.auditLog.deleteMany({ where: { actorUserId: { in: IDS } } });
      await db.personalAccessToken.deleteMany({ where: { ownerId: { in: IDS } } });
      await db.pTORequest.deleteMany({ where: { userId: { in: IDS } } });
      await db.user.deleteMany({ where: { id: { in: IDS } } });
    } finally {
      await Promise.all([tokens.close(), db.$disconnect(), appPrisma.$disconnect()]);
    }
  });

  describe('PTO mutations', () => {
    it('records create, update and delete with the verified attribution and no note text', async () => {
      const created = await createPto(sessionActor(OWNER, 'member'), {
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'morning',
        note: NOTE,
      });
      const afterCreate = await auditRows('pto_request', created.id);
      expect(afterCreate).toHaveLength(1);
      expect(afterCreate[0]).toMatchObject({
        actorUserId: OWNER,
        action: 'create_pto',
        entityType: 'pto_request',
        entityId: created.id,
        credentialType: 'session',
        sourceTokenId: null,
        targetOwnerId: OWNER,
        requestId: 'audit-integration-session',
      });
      expect(afterCreate[0]!.createdAt).toBeInstanceOf(Date);
      expect(JSON.stringify(afterCreate[0]!.details)).not.toContain(NOTE);
      expect(afterCreate[0]!.details).not.toHaveProperty('note');

      expect(created.version).toBe(1);
      const updated = await updatePto(
        sessionActor(OWNER, 'member'),
        created.id,
        {
          startDate: '2026-05-12',
          endDate: '2026-05-12',
          dayPart: 'morning',
          note: `${NOTE}-edited`,
        },
        created.version,
      );
      expect(updated.version).toBe(2);
      const afterUpdate = await auditRows('pto_request', created.id);
      expect(afterUpdate).toHaveLength(2);
      expect(afterUpdate[1]).toMatchObject({
        action: 'update_pto',
        actorUserId: OWNER,
        credentialType: 'session',
        targetOwnerId: OWNER,
      });
      expect(JSON.stringify(afterUpdate[1]!.details)).not.toContain(NOTE);

      await deletePto(sessionActor(OWNER, 'member'), created.id, updated.version);
      const afterDelete = await auditRows('pto_request', created.id);
      expect(afterDelete).toHaveLength(3);
      expect(afterDelete[2]).toMatchObject({
        action: 'delete_pto',
        actorUserId: OWNER,
        credentialType: 'session',
        targetOwnerId: OWNER,
      });
      expect(JSON.stringify(afterDelete[2]!.details)).not.toContain(NOTE);
    });

    it('attributes a personal-token mutation to the owner and the public token ID', async () => {
      const issued = await issueToken(tokens, sessionActor(OWNER, 'member'), 0, {
        name: 'Audit token',
      });
      const created = await createPto(patActor(OWNER, 'member', issued.token.id), {
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'morning',
      });
      const rows = await auditRows('pto_request', created.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorUserId: OWNER,
        credentialType: 'personal_access_token',
        sourceTokenId: issued.token.id,
        targetOwnerId: OWNER,
        requestId: 'audit-integration-pat',
      });
      expect(JSON.stringify(rows[0])).not.toContain(issued.rawToken);
    });

    it('keeps the lead attribution and the owner as the target', async () => {
      const created = await createPto(sessionActor(OWNER, 'member'), {
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'morning',
      });
      await updatePto(
        sessionActor(LEAD, 'team_lead'),
        created.id,
        {
          startDate: '2026-05-12',
          endDate: '2026-05-12',
          dayPart: 'morning',
        },
        1,
      );
      const rows = await auditRows('pto_request', created.id);
      expect(rows[1]).toMatchObject({
        actorUserId: LEAD,
        action: 'update_pto',
        targetOwnerId: OWNER,
        credentialType: 'session',
      });
    });

    it('writes no audit row for a denied or invalid mutation', async () => {
      const created = await createPto(sessionActor(OWNER, 'member'), {
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'morning',
      });
      await expect(
        updatePto(
          sessionActor(OTHER, 'member'),
          created.id,
          {
            startDate: '2026-05-12',
            endDate: '2026-05-12',
            dayPart: 'morning',
          },
          1,
        ),
      ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
      await expect(deletePto(sessionActor(OTHER, 'member'), created.id, 1)).rejects.toMatchObject({
        status: 403,
        code: 'FORBIDDEN',
      });
      await expect(
        createPto(sessionActor(OWNER, 'member'), {
          startDate: '2026-05-09',
          endDate: '2026-05-09',
          dayPart: 'morning',
        }),
      ).rejects.toBeInstanceOf(HttpError);
      const rows = await auditRows('pto_request', created.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe('create_pto');
      // The rejected create adds no row for this fixture's actors, and the
      // rows of other users are outside this assertion.
      const fixtureCreates = await db.auditLog.count({
        where: { action: 'create_pto', actorUserId: { in: IDS } },
      });
      expect(fixtureCreates).toBe(1);
      const rejected = await db.auditLog.count({
        where: { action: 'create_pto', actorUserId: { in: IDS }, entityId: { not: created.id } },
      });
      expect(rejected).toBe(0);
    });

    it('rolls the mutation back when its audit row cannot be written', async () => {
      // The trigger rejects only this fixture's own create rows, so unrelated
      // audit rows of other users are never affected.
      await db.$executeRawUnsafe(
        `CREATE OR REPLACE FUNCTION audit_reject_pto() RETURNS trigger AS $$
         BEGIN
           IF NEW.action = 'create_pto' AND NEW.actor_user_id = '${OWNER}'::uuid THEN
             RAISE EXCEPTION 'audit rejected by the credential audit test';
           END IF;
           RETURN NEW;
         END;
         $$ LANGUAGE plpgsql`,
      );
      await db.$executeRawUnsafe(
        'CREATE TRIGGER audit_reject_pto_trigger BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_reject_pto()',
      );
      try {
        await expect(
          createPto(sessionActor(OWNER, 'member'), {
            startDate: '2026-06-01',
            endDate: '2026-06-01',
            dayPart: 'morning',
          }),
        ).rejects.toThrow();
        expect(await db.pTORequest.count({ where: { userId: OWNER } })).toBe(0);
        expect(
          await db.auditLog.count({ where: { action: 'create_pto', actorUserId: { in: IDS } } }),
        ).toBe(0);
      } finally {
        await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS audit_reject_pto_trigger ON audit_logs');
        await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS audit_reject_pto()');
      }
    });
  });

  describe('token lifecycle', () => {
    it('records issuance and a single revocation row per public token ID', async () => {
      const issued = await issueToken(tokens, sessionActor(OWNER, 'member'), 0, {
        name: 'Lifecycle',
      });
      const issuedRows = await auditRows('personal_access_token', issued.token.id);
      expect(issuedRows).toHaveLength(1);
      expect(issuedRows[0]).toMatchObject({
        actorUserId: OWNER,
        action: 'create_personal_token',
        entityType: 'personal_access_token',
        entityId: issued.token.id,
        credentialType: 'session',
        sourceTokenId: null,
        targetOwnerId: OWNER,
        requestId: 'audit-integration-session',
      });
      expect(JSON.stringify(issuedRows[0]!.details)).not.toContain(issued.rawToken);

      await expect(
        revokeToken(tokens, sessionActor(OWNER, 'member'), issued.token.id),
      ).resolves.toBe(true);
      const revoked = await auditRows('personal_access_token', issued.token.id);
      expect(revoked.filter((row) => row.action === 'revoke_personal_token')).toHaveLength(1);
      expect(revoked.at(-1)).toMatchObject({
        actorUserId: OWNER,
        credentialType: 'session',
        targetOwnerId: OWNER,
      });

      // A repeated revocation changes nothing and must not write a second row.
      await expect(
        revokeToken(tokens, sessionActor(OWNER, 'member'), issued.token.id),
      ).resolves.toBe(true);
      const afterRepeat = await auditRows('personal_access_token', issued.token.id);
      expect(afterRepeat.filter((row) => row.action === 'revoke_personal_token')).toHaveLength(1);
    });

    it('writes one revocation row per changed token for a bulk revocation', async () => {
      const first = await issueToken(tokens, sessionActor(OWNER, 'member'), 0, { name: 'First' });
      const second = await issueToken(tokens, sessionActor(OWNER, 'member'), 0, { name: 'Second' });
      await expect(revokeAllTokens(tokens, sessionActor(OWNER, 'member'))).resolves.toBe(2);
      const rows = await db.auditLog.findMany({
        where: {
          action: 'revoke_personal_token',
          entityType: 'personal_access_token',
          entityId: { in: [first.token.id, second.token.id] },
        },
      });
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.entityId).sort()).toEqual(
        [first.token.id, second.token.id].sort(),
      );
      for (const row of rows) {
        expect((row.details as { bulk?: boolean } | null)?.bulk).toBe(true);
        expect(row.actorUserId).toBe(OWNER);
        expect(row.targetOwnerId).toBe(OWNER);
      }
    });

    it('keeps the audit history when the personal token row is deleted', async () => {
      const issued = await issueToken(tokens, sessionActor(OWNER, 'member'), 0, {
        name: 'Survivor',
      });
      const created = await createPto(patActor(OWNER, 'member', issued.token.id), {
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'morning',
      });
      await revokeToken(tokens, patActor(OWNER, 'member', issued.token.id), issued.token.id);
      // Deleting the credential metadata must not cascade into the audit trail.
      await db.personalAccessToken.delete({ where: { id: issued.token.id } });
      const rows = await auditRows('pto_request', created.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.sourceTokenId).toBe(issued.token.id);
      const tokenRows = await auditRows('personal_access_token', issued.token.id);
      expect(tokenRows.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('credential-version invalidation', () => {
    it('records a password reset with the acting session credential', async () => {
      const reset = await resetUserPassword(OWNER, sessionActor(LEAD, 'team_lead'));
      const rows = await auditRows('user', OWNER);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorUserId: LEAD,
        action: 'reset_user_password',
        entityType: 'user',
        entityId: OWNER,
        credentialType: 'session',
        sourceTokenId: null,
        targetOwnerId: OWNER,
        requestId: 'audit-integration-session',
      });
      expect(JSON.stringify(rows[0]!)).not.toContain(reset.setupToken.plaintext);
      expect(JSON.stringify(rows[0]!)).not.toContain(reset.setupToken.hash);
    });

    it('records a setup claim with the claimed owner and a setup-token credential', async () => {
      const reset = await resetUserPassword(OWNER, sessionActor(LEAD, 'team_lead'));
      await setupAccount(
        { token: reset.setupToken.plaintext, password: 'integration-setup-password' },
        { requestId: 'audit-integration-setup' },
      );
      const rows = await auditRows('user', OWNER);
      const setup = rows.find((row) => row.action === 'complete_account_setup');
      expect(setup).toBeDefined();
      expect(setup).toMatchObject({
        actorUserId: OWNER,
        entityType: 'user',
        entityId: OWNER,
        credentialType: 'setup_token',
        sourceTokenId: null,
        targetOwnerId: OWNER,
        requestId: 'audit-integration-setup',
      });
      expect(JSON.stringify(setup)).not.toContain(reset.setupToken.plaintext);
    });

    it('records a trusted role change with an operator credential', async () => {
      await changeRoleAndInvalidate(tokens, OWNER, 'team_lead', trustedOperatorActor(LEAD));
      const rows = await auditRows('user', OWNER);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorUserId: LEAD,
        action: 'change_user_role',
        entityType: 'user',
        entityId: OWNER,
        credentialType: 'operator',
        sourceTokenId: null,
        targetOwnerId: OWNER,
        requestId: null,
      });
    });
  });

  describe('storage guarantees', () => {
    it('rejects an unknown credential type, a mismatched source token and an unsafe request ID', async () => {
      const base = {
        actorUserId: OWNER,
        action: 'update_pto',
        entityType: 'pto_request',
        entityId: randomUUID(),
      };
      await expect(
        db.auditLog.create({ data: { ...base, credentialType: 'unknown_credential' } }),
      ).rejects.toThrow();
      await expect(
        db.auditLog.create({
          data: { ...base, credentialType: 'session', sourceTokenId: randomUUID() },
        }),
      ).rejects.toThrow();
      await expect(
        db.auditLog.create({
          data: { ...base, credentialType: 'session', requestId: 'pto_pat_leak' },
        }),
      ).rejects.toThrow();
      await expect(
        db.auditLog.create({
          data: { ...base, credentialType: 'session', requestId: 'has space' },
        }),
      ).rejects.toThrow();
    });

    it('drops an unsafe request ID to NULL instead of failing the change', async () => {
      const unsafeActor: AttributedActor = {
        id: OWNER,
        role: 'member',
        credential: { type: 'session' },
        requestId: 'pto_pat_leak',
      };
      const created = await createPto(unsafeActor, {
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'morning',
      });
      const rows = await auditRows('pto_request', created.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.requestId).toBeNull();
      expect(rows[0]!.credentialType).toBe('session');
    });

    it('never backfills or rewrites a historical row', async () => {
      const legacy = await db.auditLog.create({
        data: {
          actorUserId: OWNER,
          action: 'update_pto',
          entityType: 'pto_request',
          entityId: randomUUID(),
          details: { legacy: true },
        },
      });
      await createPto(sessionActor(OWNER, 'member'), {
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'morning',
      });
      const after = await db.auditLog.findUniqueOrThrow({ where: { id: legacy.id } });
      expect(after.credentialType).toBeNull();
      expect(after.sourceTokenId).toBeNull();
      expect(after.targetOwnerId).toBeNull();
      expect(after.requestId).toBeNull();
      expect(after.details).toEqual({ legacy: true });
    });
  });

  describe('real HTTP attribution', () => {
    let app: ManagedApp;

    beforeAll(async () => {
      // The bearer flags are test-only here; production keeps them disabled.
      vi.stubEnv('PAT_AUTH_ENABLED', 'true');
      vi.stubEnv('PAT_WRITES_ENABLED', 'true');
      resetEnvForTests();
      app = createApp();
    });

    afterAll(async () => {
      vi.unstubAllEnvs();
      resetEnvForTests();
      await app.closeResources();
    });

    async function loginAs(email: string): Promise<ReturnType<typeof request.agent>> {
      const agent = request.agent(app);
      const res = await agent.post('/auth/login').send({ email, password: PASSWORD });
      expect(res.status).toBe(200);
      return agent;
    }

    it('records a cookie session mutation with the session credential and the request correlation ID', async () => {
      const agent = await loginAs(OWNER_EMAIL);
      const requestId = 'audit-http-request-1';
      const created = await agent
        .post('/pto')
        .set('X-Request-Id', requestId)
        .send({ startDate: '2026-05-11', endDate: '2026-05-11', dayPart: 'morning', note: NOTE });
      expect(created.status).toBe(201);
      expect(created.headers['x-request-id']).toBe(requestId);
      const rows = await auditRows('pto_request', created.body.id as string);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorUserId: OWNER,
        action: 'create_pto',
        entityType: 'pto_request',
        entityId: created.body.id,
        credentialType: 'session',
        sourceTokenId: null,
        targetOwnerId: OWNER,
        requestId: requestId,
      });
      expect(JSON.stringify(rows[0]!.details)).not.toContain(NOTE);
    });

    it('records a personal-token mutation with the public token ID of the credential', async () => {
      const issued = await issueToken(tokens, sessionActor(OWNER, 'member'), 0, {
        name: 'HTTP token',
        scopes: ['pto:read', 'pto:create'],
      });
      const created = await request(app)
        .post('/pto')
        .set('Authorization', `Bearer ${issued.rawToken}`)
        .set('Idempotency-Key', ptoCreateKey())
        .send({ startDate: '2026-05-12', endDate: '2026-05-12', dayPart: 'morning' });
      expect(created.status).toBe(201);
      const rows = await auditRows('pto_request', created.body.id as string);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorUserId: OWNER,
        credentialType: 'personal_access_token',
        sourceTokenId: issued.token.id,
        targetOwnerId: OWNER,
      });
      expect(JSON.stringify(rows[0])).not.toContain(issued.rawToken);
    });

    it('attributes a lead mutation to the lead and keeps the owner as the target', async () => {
      const owner = await loginAs(OWNER_EMAIL);
      const created = await owner
        .post('/pto')
        .send({ startDate: '2026-05-11', endDate: '2026-05-11', dayPart: 'morning' });
      expect(created.status).toBe(201);
      const lead = await loginAs(LEAD_EMAIL);
      const updated = await lead
        .put(`/pto/${created.body.id}`)
        .set('If-Match', '"1"')
        .send({ startDate: '2026-05-12', endDate: '2026-05-12', dayPart: 'morning' });
      expect(updated.status).toBe(200);
      const rows = await auditRows('pto_request', created.body.id as string);
      const update = rows.find((row) => row.action === 'update_pto');
      expect(update).toMatchObject({
        actorUserId: LEAD,
        action: 'update_pto',
        credentialType: 'session',
        sourceTokenId: null,
        targetOwnerId: OWNER,
      });
    });

    it('writes no success audit row for a denied request', async () => {
      const owner = await loginAs(OWNER_EMAIL);
      const created = await owner
        .post('/pto')
        .send({ startDate: '2026-05-11', endDate: '2026-05-11', dayPart: 'morning' });
      expect(created.status).toBe(201);
      const other = await loginAs(OTHER_EMAIL);
      const before = await db.auditLog.count({ where: { actorUserId: { in: IDS } } });
      const denied = await other
        .put(`/pto/${created.body.id}`)
        .set('If-Match', '"1"')
        .send({ startDate: '2026-05-12', endDate: '2026-05-12', dayPart: 'morning' });
      expect(denied.status).toBe(403);
      expect(await db.auditLog.count({ where: { actorUserId: { in: IDS } } })).toBe(before);
    });
  });

  describe('audit-failure rollback', () => {
    const REJECT_FUNCTION = 'audit_reject_fixture';
    const REJECT_TRIGGER = 'audit_reject_fixture_trigger';

    /** Rejects one audit action of one fixture actor, and always cleans up. */
    async function withRejectedAudit(
      action: string,
      actorUserId: string,
      run: () => Promise<void>,
    ): Promise<void> {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${REJECT_TRIGGER} ON audit_logs`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${REJECT_FUNCTION}()`);
      await db.$executeRawUnsafe(
        `CREATE FUNCTION ${REJECT_FUNCTION}() RETURNS trigger AS $$
         BEGIN
           IF NEW.action = '${action}' AND NEW.actor_user_id = '${actorUserId}'::uuid THEN
             RAISE EXCEPTION 'audit rejected by the credential audit test';
           END IF;
           RETURN NEW;
         END;
         $$ LANGUAGE plpgsql`,
      );
      await db.$executeRawUnsafe(
        `CREATE TRIGGER ${REJECT_TRIGGER} BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION ${REJECT_FUNCTION}()`,
      );
      try {
        await run();
      } finally {
        await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${REJECT_TRIGGER} ON audit_logs`);
        await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${REJECT_FUNCTION}()`);
      }
    }

    it('rolls back a token issuance when its audit row cannot be written', async () => {
      await withRejectedAudit('create_personal_token', OWNER, async () => {
        await expect(
          issueToken(tokens, sessionActor(OWNER, 'member'), 0, { name: 'Rolled back' }),
        ).rejects.toThrow();
        expect(await db.personalAccessToken.count({ where: { ownerId: OWNER } })).toBe(0);
        expect(
          await db.auditLog.count({
            where: { action: 'create_personal_token', actorUserId: { in: IDS } },
          }),
        ).toBe(0);
      });
    });

    it('rolls back a token revocation when its audit row cannot be written', async () => {
      const issued = await issueToken(tokens, sessionActor(OWNER, 'member'), 0, {
        name: 'Revoke rollback',
      });
      await withRejectedAudit('revoke_personal_token', OWNER, async () => {
        await expect(
          revokeToken(tokens, sessionActor(OWNER, 'member'), issued.token.id),
        ).rejects.toThrow();
        const stored = await db.personalAccessToken.findUniqueOrThrow({
          where: { id: issued.token.id },
        });
        expect(stored.revokedAt).toBeNull();
        expect(
          await db.auditLog.count({
            where: { action: 'revoke_personal_token', actorUserId: { in: IDS } },
          }),
        ).toBe(0);
      });
    });

    it('rolls back a role change when its audit row cannot be written', async () => {
      await withRejectedAudit('change_user_role', LEAD, async () => {
        await expect(
          changeRoleAndInvalidate(tokens, OWNER, 'team_lead', trustedOperatorActor(LEAD)),
        ).rejects.toThrow();
        const stored = await db.user.findUniqueOrThrow({ where: { id: OWNER } });
        expect(stored.role).toBe('member');
        expect(
          await db.auditLog.count({
            where: { action: 'change_user_role', actorUserId: { in: IDS } },
          }),
        ).toBe(0);
      });
    });

    it('rolls back a password reset when its audit row cannot be written', async () => {
      await withRejectedAudit('reset_user_password', LEAD, async () => {
        await expect(resetUserPassword(OWNER, sessionActor(LEAD, 'team_lead'))).rejects.toThrow();
        const stored = await db.user.findUniqueOrThrow({ where: { id: OWNER } });
        expect(stored.passwordHash).toBe(PASSWORD_HASH);
        expect(stored.setupTokenHash).toBeNull();
        expect(stored.sessionVersion).toBe(0);
        expect(
          await db.auditLog.count({
            where: { action: 'reset_user_password', actorUserId: { in: IDS } },
          }),
        ).toBe(0);
      });
    });

    it('rolls back an account setup when its audit row cannot be written', async () => {
      const reset = await resetUserPassword(OWNER, sessionActor(LEAD, 'team_lead'));
      await withRejectedAudit('complete_account_setup', OWNER, async () => {
        await expect(
          setupAccount(
            { token: reset.setupToken.plaintext, password: 'audit-integration-new-password' },
            { requestId: 'audit-integration-setup' },
          ),
        ).rejects.toThrow();
        const stored = await db.user.findUniqueOrThrow({ where: { id: OWNER } });
        expect(stored.setupTokenHash).toBe(reset.setupToken.hash);
        expect(stored.sessionVersion).toBe(1);
        expect(
          await db.auditLog.count({
            where: { action: 'complete_account_setup', actorUserId: { in: IDS } },
          }),
        ).toBe(0);
      });
    });

    it('rolls back a PTO update when its audit row cannot be written', async () => {
      const created = await createPto(sessionActor(OWNER, 'member'), {
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'morning',
      });
      await withRejectedAudit('update_pto', OWNER, async () => {
        await expect(
          updatePto(
            sessionActor(OWNER, 'member'),
            created.id,
            {
              startDate: '2026-05-12',
              endDate: '2026-05-12',
              dayPart: 'morning',
            },
            1,
          ),
        ).rejects.toThrow();
        const stored = await db.pTORequest.findUniqueOrThrow({ where: { id: created.id } });
        expect(stored.startDate).toEqual(new Date('2026-05-11T00:00:00.000Z'));
        expect(
          await db.auditLog.count({ where: { action: 'update_pto', actorUserId: { in: IDS } } }),
        ).toBe(0);
      });
    });

    it('rolls back a PTO delete when its audit row cannot be written', async () => {
      const created = await createPto(sessionActor(OWNER, 'member'), {
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'morning',
      });
      await withRejectedAudit('delete_pto', OWNER, async () => {
        await expect(deletePto(sessionActor(OWNER, 'member'), created.id, 1)).rejects.toThrow();
        expect(await db.pTORequest.count({ where: { id: created.id } })).toBe(1);
        expect(
          await db.auditLog.count({ where: { action: 'delete_pto', actorUserId: { in: IDS } } }),
        ).toBe(0);
      });
    });
  });

  describe('concurrent revocation', () => {
    it('writes exactly one revocation row when two connections revoke the same token', async () => {
      const issued = await issueToken(tokens, sessionActor(OWNER, 'member'), 0, {
        name: 'Concurrent revoke',
      });
      const other = createTokenDatabase(url);
      try {
        const outcomes = await Promise.all([
          revokeToken(tokens, sessionActor(OWNER, 'member'), issued.token.id),
          revokeToken(other, sessionActor(OWNER, 'member'), issued.token.id),
        ]);
        expect(outcomes).toEqual([true, true]);
        const rows = await auditRows('personal_access_token', issued.token.id);
        expect(rows.filter((row) => row.action === 'revoke_personal_token')).toHaveLength(1);
        const stored = await db.personalAccessToken.findUniqueOrThrow({
          where: { id: issued.token.id },
        });
        expect(stored.revokedAt).not.toBeNull();
      } finally {
        await other.close();
      }
    });

    it('writes one row per changed token when two connections revoke all at once', async () => {
      const first = await issueToken(tokens, sessionActor(OWNER, 'member'), 0, {
        name: 'Bulk one',
      });
      const second = await issueToken(tokens, sessionActor(OWNER, 'member'), 0, {
        name: 'Bulk two',
      });
      const other = createTokenDatabase(url);
      try {
        const outcomes = await Promise.all([
          revokeAllTokens(tokens, sessionActor(OWNER, 'member')),
          revokeAllTokens(other, sessionActor(OWNER, 'member')),
        ]);
        expect(outcomes.reduce((total, count) => total + count, 0)).toBe(2);
        const rows = await db.auditLog.findMany({
          where: {
            action: 'revoke_personal_token',
            entityType: 'personal_access_token',
            entityId: { in: [first.token.id, second.token.id] },
          },
        });
        expect(rows).toHaveLength(2);
        expect(new Set(rows.map((row) => row.entityId)).size).toBe(2);
      } finally {
        await other.close();
      }
    });
  });

  describe('custom schema persistence', () => {
    it('writes the token and its audit row in the configured schema, in one transaction', async () => {
      const schema = `audit_schema_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      try {
        await db.$executeRawUnsafe(`CREATE TABLE "${schema}"."users" (
          id uuid PRIMARY KEY,
          role varchar(20) NOT NULL,
          password_hash text NULL,
          session_version integer NOT NULL DEFAULT 0
        )`);
        await db.$executeRawUnsafe(`CREATE TABLE "${schema}"."personal_access_tokens" (
          id uuid PRIMARY KEY,
          owner_id uuid NOT NULL,
          name varchar(120) NOT NULL,
          display_prefix varchar(44) NOT NULL,
          secret_digest char(64) NOT NULL,
          scopes varchar(32)[] NOT NULL,
          issued_session_version integer NOT NULL,
          created_at timestamp NOT NULL,
          expires_at timestamp NOT NULL,
          last_used_at timestamp NULL,
          revoked_at timestamp NULL
        )`);
        await db.$executeRawUnsafe(`CREATE TABLE "${schema}"."audit_logs" (
          id uuid PRIMARY KEY,
          actor_user_id uuid NOT NULL,
          action varchar(50) NOT NULL,
          entity_type varchar(50) NOT NULL,
          entity_id uuid NOT NULL,
          details jsonb NULL,
          created_at timestamp NOT NULL DEFAULT now(),
          credential_type varchar(32) NULL,
          source_token_id uuid NULL,
          target_owner_id uuid NULL,
          request_id varchar(200) NULL
        )`);
        const owner = randomUUID();
        await db.$executeRawUnsafe(
          `INSERT INTO "${schema}"."users" (id, role, password_hash, session_version) VALUES ('${owner}'::uuid, 'member', 'custom-schema-hash', 0)`,
        );
        const custom = createTokenDatabase(urlWithSchema(schema));
        try {
          const issued = await issueToken(custom, sessionActor(owner, 'member'), 0, {
            name: 'Custom schema',
          });
          const tokenRows = await db.$queryRawUnsafe<{ id: string }[]>(
            `SELECT id::text AS id FROM "${schema}"."personal_access_tokens"`,
          );
          expect(tokenRows).toHaveLength(1);
          expect(tokenRows[0]!.id).toBe(issued.token.id);
          const audits = await db.$queryRawUnsafe<
            { action: string; entity_id: string; credential_type: string }[]
          >(
            `SELECT action, entity_id::text AS entity_id, credential_type FROM "${schema}"."audit_logs"`,
          );
          expect(audits).toHaveLength(1);
          expect(audits[0]).toMatchObject({
            action: 'create_personal_token',
            entity_id: issued.token.id,
            credential_type: 'session',
          });
          // The public schema is untouched by the custom-schema run.
          expect(await db.personalAccessToken.count({ where: { id: issued.token.id } })).toBe(0);
        } finally {
          await custom.close();
        }
      } finally {
        await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
    });
  });
});
