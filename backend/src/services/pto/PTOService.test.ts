import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../middleware/errorHandler.js';
import type { AttributedActor } from '../audit/auditContext.js';
import type { CreatePtoInput } from './schemas.js';
import {
  createPto,
  createPtoIdempotently,
  deletePto,
  findOverlapping,
  getPtoById,
  patchPto,
  toPublicPto,
  updatePto,
} from './PTOService.js';
import type { AuthContext } from '../auth/authContext.js';
import { payloadFingerprint, signingKeys } from './createReplay.js';
import type { ParsedPtoKey } from './idempotencyKey.js';
import type { PtoReplayCredential } from './replayCredential.js';

vi.mock('../../lib/prisma.js', () => {
  const pTORequest = {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  const auditLog = { create: vi.fn(), findMany: vi.fn() };
  const queryRaw = vi.fn();
  const executeRaw = vi.fn();
  const tx = { pTORequest, auditLog, $queryRaw: queryRaw, $executeRaw: executeRaw };
  const $transaction = vi.fn((fn: (txClient: typeof tx) => Promise<unknown>) => fn(tx));
  return {
    prisma: { pTORequest, auditLog, $queryRaw: queryRaw, $executeRaw: executeRaw, $transaction },
  };
});

import { prisma } from '../../lib/prisma.js';

const mockFindFirst = prisma.pTORequest.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockFindUnique = prisma.pTORequest.findUnique as unknown as ReturnType<typeof vi.fn>;
const mockCreate = prisma.pTORequest.create as unknown as ReturnType<typeof vi.fn>;
const mockUpdate = prisma.pTORequest.update as unknown as ReturnType<typeof vi.fn>;
const mockDelete = prisma.pTORequest.delete as unknown as ReturnType<typeof vi.fn>;
const mockAuditCreate = prisma.auditLog.create as unknown as ReturnType<typeof vi.fn>;
const mockQueryRaw = prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>;
const mockExecuteRaw = prisma.$executeRaw as unknown as ReturnType<typeof vi.fn>;
const mockTx = prisma.$transaction as unknown as ReturnType<typeof vi.fn>;

const USER_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ID = '33333333-3333-3333-3333-333333333333';
const PTO_ID = '22222222-2222-2222-2222-222222222222';
const TOKEN_ID = '55555555-5555-4555-8555-555555555555';
const LEAD_ID = '44444444-4444-4444-4444-444444444444';

function sessionActor(id: string, role: AttributedActor['role']): AttributedActor {
  return { id, role, credential: { type: 'session' }, requestId: 'req-pto-1' };
}

const ACTOR_MEMBER = sessionActor(USER_ID, 'member');
const ACTOR_OTHER_MEMBER = sessionActor(OTHER_ID, 'member');
const ACTOR_LEAD = sessionActor(LEAD_ID, 'team_lead');
const ACTOR_PAT_OWNER: AttributedActor = {
  id: USER_ID,
  role: 'member',
  credential: { type: 'personal_access_token', tokenId: TOKEN_ID },
  requestId: 'req-pat-pto-1',
};

const EXISTING_ROW = {
  id: PTO_ID,
  userId: USER_ID,
  version: 1,
  startDate: new Date('2026-05-11T00:00:00.000Z'),
  endDate: new Date('2026-05-11T00:00:00.000Z'),
  dayPart: 'morning' as const,
  note: 'Stored note',
};

const UPDATED_ROW = {
  id: PTO_ID,
  userId: USER_ID,
  version: 2,
  startDate: new Date('2026-05-12T00:00:00.000Z'),
  endDate: new Date('2026-05-12T00:00:00.000Z'),
  dayPart: 'morning' as const,
  note: 'Edited',
  createdAt: new Date('2026-05-01T10:00:00.000Z'),
  updatedAt: new Date('2026-05-02T10:00:00.000Z'),
};

const DELETED_ROW = {
  userId: USER_ID,
  startDate: new Date('2026-05-11T00:00:00.000Z'),
  endDate: new Date('2026-05-11T00:00:00.000Z'),
  dayPart: 'morning' as const,
};

/** The audit row's attribution columns, which must come from the verified caller only. */
function auditData(): Record<string, unknown> {
  const call = mockAuditCreate.mock.calls[0] as unknown as [{ data: Record<string, unknown> }];
  return call[0].data;
}

/**
 * The shape the pinned driver adapter reports when the database refuses an
 * overlapping range for one owner: a known request error whose driver adapter
 * cause keeps the SQLSTATE and the PostgreSQL message.
 */
function overlapViolationError(
  constraint = 'pto_requests_no_owner_overlap',
): Prisma.PrismaClientKnownRequestError {
  const message = `conflicting key value violates exclusion constraint "${constraint}"`;
  return new Prisma.PrismaClientKnownRequestError(
    `Database error. Code: \`23P01\`. Message: \`${message}\``,
    {
      code: 'P2039',
      clientVersion: '7.10.1',
      meta: {
        modelName: 'PTORequest',
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: {
            kind: 'postgres',
            originalCode: '23P01',
            code: '23P01',
            severity: 'ERROR',
            originalMessage: message,
            message,
            detail:
              "Key (user_id, daterange(start_date, end_date, '[]'::text))=(owner, [2026-05-11,2026-05-11]) conflicts with existing key (owner, [2026-05-11,2026-05-11]).",
          },
        },
      },
    },
  );
}

/** The driver error of a guarded write that found no row: a lost race. */
function missingRowError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('No PTO record was found for the update.', {
    code: 'P2025',
    clientVersion: '7.10.1',
  });
}

describe('PTOService extended', () => {
  beforeEach(() => {
    mockFindFirst.mockReset();
    mockFindUnique.mockReset();
    mockCreate.mockReset();
    mockUpdate.mockReset();
    mockDelete.mockReset();
    mockAuditCreate.mockReset();
    mockTx.mockClear();
  });
  afterEach(() => vi.clearAllMocks());

  describe('getPtoById', () => {
    it('returns null when not found', async () => {
      mockFindUnique.mockResolvedValueOnce(null);
      expect(await getPtoById('missing')).toBeNull();
    });

    it('maps the row to the public shape with date strings and ISO timestamps', async () => {
      mockFindUnique.mockResolvedValueOnce({
        id: PTO_ID,
        userId: USER_ID,
        startDate: new Date('2026-05-11T00:00:00.000Z'),
        endDate: new Date('2026-05-11T00:00:00.000Z'),
        dayPart: 'morning',
        note: 'Doctor',
        version: 3,
        createdAt: new Date('2026-05-01T10:00:00.000Z'),
        updatedAt: new Date('2026-05-01T10:00:00.000Z'),
        user: { id: USER_ID, name: 'Alice', colorCode: '#3B82F6' },
      });
      const result = await getPtoById(PTO_ID);
      expect(result).toEqual({
        id: PTO_ID,
        userId: USER_ID,
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'morning',
        note: 'Doctor',
        version: 3,
        createdAt: '2026-05-01T10:00:00.000Z',
        updatedAt: '2026-05-01T10:00:00.000Z',
        user: { id: USER_ID, name: 'Alice', colorCode: '#3B82F6' },
      });
    });
  });

  describe('createPto', () => {
    const CREATED_ROW = {
      id: PTO_ID,
      userId: USER_ID,
      version: 1,
      startDate: new Date('2026-05-11T00:00:00.000Z'),
      endDate: new Date('2026-05-11T00:00:00.000Z'),
      dayPart: 'morning' as const,
      note: 'Doctor',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('creates for the authenticated actor and audits the create in the same transaction', async () => {
      mockFindFirst.mockResolvedValueOnce(null);
      mockCreate.mockResolvedValueOnce(CREATED_ROW);

      const result = await createPto(ACTOR_MEMBER, {
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'morning',
        note: 'Doctor',
      });

      expect(result).toBe(CREATED_ROW);
      expect(mockTx).toHaveBeenCalledTimes(1);
      expect(mockCreate).toHaveBeenCalledTimes(1);
      const createArg = mockCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
      expect(createArg.data).toMatchObject({ userId: USER_ID, dayPart: 'morning', note: 'Doctor' });
      expect(mockAuditCreate).toHaveBeenCalledExactlyOnceWith({
        data: {
          actorUserId: USER_ID,
          action: 'create_pto',
          entityType: 'pto_request',
          entityId: PTO_ID,
          details: {
            startDate: '2026-05-11',
            endDate: '2026-05-11',
            dayPart: 'morning',
            noteWritten: true,
          },
          credentialType: 'session',
          sourceTokenId: null,
          targetOwnerId: USER_ID,
          requestId: 'req-pto-1',
        },
      });
    });

    it('attributes a personal-token create to the owner with the public token ID and no note text', async () => {
      mockFindFirst.mockResolvedValueOnce(null);
      mockCreate.mockResolvedValueOnce(CREATED_ROW);

      await createPto(ACTOR_PAT_OWNER, {
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'morning',
        note: 'Doctor',
      });

      expect(auditData()).toMatchObject({
        actorUserId: USER_ID,
        action: 'create_pto',
        credentialType: 'personal_access_token',
        sourceTokenId: TOKEN_ID,
        targetOwnerId: USER_ID,
        requestId: 'req-pat-pto-1',
      });
      expect(JSON.stringify(auditData())).not.toContain('Doctor');
    });

    it('records noteWritten false when no note is stored on create', async () => {
      mockFindFirst.mockResolvedValueOnce(null);
      mockCreate.mockResolvedValueOnce({ ...CREATED_ROW, note: null });

      await createPto(ACTOR_MEMBER, {
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'morning',
        note: '',
      });

      expect(auditData()).toMatchObject({
        details: expect.objectContaining({ noteWritten: false }),
      });
    });

    it('answers the database overlap guard with the same conflict as the preflight', async () => {
      mockFindFirst.mockResolvedValueOnce(null);
      mockCreate.mockRejectedValueOnce(overlapViolationError());

      await expect(
        createPto(ACTOR_MEMBER, {
          startDate: '2026-05-11',
          endDate: '2026-05-11',
          dayPart: 'morning',
        }),
      ).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('answers another exclusion constraint with the safe failure, not a conflict', async () => {
      mockFindFirst.mockResolvedValueOnce(null);
      mockCreate.mockRejectedValueOnce(overlapViolationError('another_constraint'));

      const error = await createPto(ACTOR_MEMBER, {
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'morning',
      }).catch((err: unknown) => err);
      expect(error).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
      expect(String(error)).not.toContain('another_constraint');
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('propagates an audit failure, so no create can commit without its audit row', async () => {
      mockFindFirst.mockResolvedValueOnce(null);
      mockCreate.mockResolvedValueOnce(CREATED_ROW);
      mockAuditCreate.mockRejectedValueOnce(new Error('audit insert failed'));

      await expect(
        createPto(ACTOR_MEMBER, {
          startDate: '2026-05-11',
          endDate: '2026-05-11',
          dayPart: 'morning',
        }),
      ).rejects.toThrow('audit insert failed');
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('throws 409 CONFLICT when an overlap is detected', async () => {
      mockFindFirst.mockResolvedValueOnce({ id: 'another-id' });

      await expect(
        createPto(ACTOR_MEMBER, {
          startDate: '2026-05-11',
          endDate: '2026-05-11',
          dayPart: 'morning',
        }),
      ).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
      expect(mockTx).not.toHaveBeenCalled();
    });

    it('propagates HttpError from validatePtoPayload and skips both findFirst and create', async () => {
      await expect(
        createPto(ACTOR_MEMBER, {
          startDate: '2026-05-09',
          endDate: '2026-05-09',
          dayPart: 'morning',
        }),
      ).rejects.toBeInstanceOf(HttpError);
      expect(mockFindFirst).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('normalizes the payload via validatePtoPayload before calling create', async () => {
      mockFindFirst.mockResolvedValueOnce(null);
      const createdRow = {
        id: PTO_ID,
        userId: USER_ID,
        version: 1,
        startDate: new Date('2026-05-11T00:00:00.000Z'),
        endDate: new Date('2026-05-15T00:00:00.000Z'),
        dayPart: 'all_day' as const,
        note: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockCreate.mockResolvedValueOnce(createdRow);

      await createPto(ACTOR_MEMBER, {
        startDate: '2026-05-11',
        endDate: '2026-05-15',
        dayPart: 'morning',
      });

      expect(mockCreate).toHaveBeenCalledTimes(1);
      const createArg = mockCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
      expect(createArg.data['dayPart']).toBe('all_day');
      expect(createArg.data['note']).toBeNull();
    });

    it('stores null note when note is empty string', async () => {
      mockFindFirst.mockResolvedValueOnce(null);
      mockCreate.mockResolvedValueOnce({ ...CREATED_ROW, note: null });

      await createPto(ACTOR_MEMBER, {
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'morning',
        note: '',
      });

      const createArg = mockCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
      expect(createArg.data['note']).toBeNull();
    });
  });

  describe('updatePto', () => {
    it('returns 404 when the PTO is missing', async () => {
      mockFindUnique.mockResolvedValueOnce(null);
      await expect(
        updatePto(
          ACTOR_MEMBER,
          PTO_ID,
          {
            startDate: '2026-05-12',
            endDate: '2026-05-12',
            dayPart: 'morning',
          },
          1,
        ),
      ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    });

    it('returns 403 when a non-owner non-lead attempts to edit', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      await expect(
        updatePto(
          ACTOR_OTHER_MEMBER,
          PTO_ID,
          {
            startDate: '2026-05-12',
            endDate: '2026-05-12',
            dayPart: 'morning',
          },
          1,
        ),
      ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('lets the owner update and writes an audit log inside a transaction', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      mockFindFirst.mockResolvedValueOnce(null);
      mockUpdate.mockResolvedValueOnce(UPDATED_ROW);

      const result = await updatePto(
        ACTOR_MEMBER,
        PTO_ID,
        {
          startDate: '2026-05-12',
          endDate: '2026-05-12',
          dayPart: 'morning',
          note: 'Edited',
        },
        1,
      );

      expect(result).toBe(UPDATED_ROW);
      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ note: 'Edited' }) }),
      );
      expect(mockAuditCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorUserId: USER_ID,
            action: 'update_pto',
            entityType: 'pto_request',
            entityId: PTO_ID,
            targetOwnerId: USER_ID,
            details: {
              startDate: '2026-05-12',
              endDate: '2026-05-12',
              dayPart: 'morning',
              noteWritten: true,
            },
          }),
        }),
      );
      expect(mockTx).toHaveBeenCalledTimes(1);
    });

    it.each(['Doctor', null])(
      'omits the note column and records noteWritten false (stored %s) when the key is absent',
      async (note) => {
        mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
        mockFindFirst.mockResolvedValueOnce(null);
        const persisted = { ...UPDATED_ROW, note };
        mockUpdate.mockResolvedValueOnce(persisted);

        const result = await updatePto(
          ACTOR_MEMBER,
          PTO_ID,
          {
            startDate: '2026-05-12',
            endDate: '2026-05-12',
            dayPart: 'morning',
          },
          1,
        );

        expect(result).toBe(persisted);
        expect(mockFindUnique).toHaveBeenCalledExactlyOnceWith({
          where: { id: PTO_ID },
          select: {
            id: true,
            userId: true,
            version: true,
            startDate: true,
            endDate: true,
            dayPart: true,
            note: true,
          },
        });
        const update = mockUpdate.mock.calls[0]![0] as { data: Record<string, unknown> };
        expect(update.data).not.toHaveProperty('note');
        expect(mockAuditCreate).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            data: expect.objectContaining({
              details: {
                startDate: '2026-05-12',
                endDate: '2026-05-12',
                dayPart: 'morning',
                noteWritten: false,
              },
            }),
          }),
        );
        expect(mockTx).toHaveBeenCalledTimes(1);
      },
    );

    it.each([
      { label: 'empty string', note: '', stored: null },
      { label: 'whitespace', note: '  ', stored: '  ' },
      { label: '500 characters', note: 'x'.repeat(500), stored: 'x'.repeat(500) },
    ])(
      'writes an explicit $label note and audits only that a note was written',
      async ({ note, stored }) => {
        mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
        mockFindFirst.mockResolvedValueOnce(null);
        mockUpdate.mockResolvedValueOnce({ ...UPDATED_ROW, note: stored });

        const result = await updatePto(
          ACTOR_MEMBER,
          PTO_ID,
          {
            startDate: '2026-05-12',
            endDate: '2026-05-12',
            dayPart: 'morning',
            note,
          },
          1,
        );

        expect(result.note).toBe(stored);
        expect(mockUpdate).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ data: expect.objectContaining({ note: stored }) }),
        );
        expect(mockAuditCreate).toHaveBeenCalledExactlyOnceWith({
          data: expect.objectContaining({
            details: {
              startDate: '2026-05-12',
              endDate: '2026-05-12',
              dayPart: 'morning',
              noteWritten: true,
            },
          }),
        });
        // The audit row must never contain the note text itself.
        if (note.length > 0) expect(JSON.stringify(auditData())).not.toContain(note);
        expect(auditData().details).not.toHaveProperty('note');
      },
    );

    it.each([
      { label: 'own undefined', note: undefined },
      { label: 'null', note: null },
      { label: 'number', note: 0 },
      { label: 'boolean', note: false },
      { label: 'array', note: [] },
      { label: 'object', note: {} },
      { label: '501 characters', note: 'x'.repeat(501) },
    ])('rejects an explicit $label note before mutation or audit', async ({ note }) => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      const input = {
        startDate: '2026-05-12',
        endDate: '2026-05-12',
        dayPart: 'morning',
        note,
      } as CreatePtoInput;
      expect(Object.hasOwn(input, 'note')).toBe(true);

      await expect(updatePto(ACTOR_MEMBER, PTO_ID, input, 1)).rejects.toMatchObject({
        status: 400,
        code: 'VALIDATION_ERROR',
      });
      expect(mockFindFirst).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('answers the database overlap guard with the same conflict as the preflight', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      mockFindFirst.mockResolvedValueOnce(null);
      mockUpdate.mockRejectedValueOnce(overlapViolationError());

      await expect(
        updatePto(
          ACTOR_MEMBER,
          PTO_ID,
          {
            startDate: '2026-05-12',
            endDate: '2026-05-12',
            dayPart: 'morning',
          },
          1,
        ),
      ).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('lets a team lead update another user PTO and audits the lead as actor with the owner as target', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      mockFindFirst.mockResolvedValueOnce(null);
      mockUpdate.mockResolvedValueOnce(UPDATED_ROW);

      await updatePto(
        ACTOR_LEAD,
        PTO_ID,
        {
          startDate: '2026-05-12',
          endDate: '2026-05-12',
          dayPart: 'morning',
        },
        1,
      );
      expect(mockAuditCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorUserId: LEAD_ID,
            action: 'update_pto',
            targetOwnerId: USER_ID,
            credentialType: 'session',
          }),
        }),
      );
    });

    it('audits a personal-token update with the source token ID and no note text', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      mockFindFirst.mockResolvedValueOnce(null);
      mockUpdate.mockResolvedValueOnce(UPDATED_ROW);

      await updatePto(
        ACTOR_PAT_OWNER,
        PTO_ID,
        {
          startDate: '2026-05-12',
          endDate: '2026-05-12',
          dayPart: 'morning',
          note: 'Edited',
        },
        1,
      );

      expect(auditData()).toMatchObject({
        credentialType: 'personal_access_token',
        sourceTokenId: TOKEN_ID,
        requestId: 'req-pat-pto-1',
      });
      expect(JSON.stringify(auditData())).not.toContain('Edited');
    });

    it('returns 409 on overlap with another PTO of the same user', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      mockFindFirst.mockResolvedValueOnce({ id: 'another-id' });
      await expect(
        updatePto(
          ACTOR_MEMBER,
          PTO_ID,
          {
            startDate: '2026-05-12',
            endDate: '2026-05-13',
            dayPart: 'all_day',
          },
          1,
        ),
      ).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('re-runs validation and rejects weekend edits', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      await expect(
        updatePto(
          ACTOR_MEMBER,
          PTO_ID,
          {
            startDate: '2026-05-09',
            endDate: '2026-05-09',
            dayPart: 'morning',
          },
          1,
        ),
      ).rejects.toBeInstanceOf(HttpError);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('propagates an audit failure after the update so the update cannot commit alone', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      mockFindFirst.mockResolvedValueOnce(null);
      mockUpdate.mockResolvedValueOnce(UPDATED_ROW);
      mockAuditCreate.mockRejectedValueOnce(new Error('audit insert failed'));

      await expect(
        updatePto(
          ACTOR_MEMBER,
          PTO_ID,
          {
            startDate: '2026-05-12',
            endDate: '2026-05-12',
            dayPart: 'morning',
          },
          1,
        ),
      ).rejects.toThrow('audit insert failed');
      expect(mockUpdate).toHaveBeenCalledTimes(1);
    });

    it('guards the write by the id, the owner and the expected version', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      mockFindFirst.mockResolvedValueOnce(null);
      mockUpdate.mockResolvedValueOnce(UPDATED_ROW);

      await updatePto(
        ACTOR_MEMBER,
        PTO_ID,
        {
          startDate: '2026-05-12',
          endDate: '2026-05-12',
          dayPart: 'morning',
        },
        1,
      );

      const update = mockUpdate.mock.calls[0]![0] as {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      };
      expect(update.where).toEqual({ id: PTO_ID, userId: USER_ID, version: 1 });
      expect(update.data['version']).toEqual({ increment: 1 });
    });

    it('refuses a stale snapshot before the payload or the overlap is reported', async () => {
      mockFindUnique.mockResolvedValueOnce({ ...EXISTING_ROW, version: 7 });

      await expect(
        updatePto(
          ACTOR_MEMBER,
          PTO_ID,
          {
            startDate: '2026-05-09',
            endDate: '2026-05-09',
            dayPart: 'morning',
          },
          1,
        ),
      ).rejects.toMatchObject({ status: 412, code: 'STALE_WRITE' });
      expect(mockFindFirst).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('reports a stale write when an authorized record disappears before the transaction', async () => {
      // The route read and authorized the record; the transaction no longer
      // finds it, so the write is stale and not a missing record.
      mockFindUnique.mockResolvedValueOnce(null);

      await expect(
        updatePto(
          ACTOR_MEMBER,
          PTO_ID,
          {
            startDate: '2026-05-12',
            endDate: '2026-05-12',
            dayPart: 'morning',
          },
          1,
          USER_ID,
        ),
      ).rejects.toMatchObject({ status: 412, code: 'STALE_WRITE' });
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('reports a stale write when an authorized record changed owner before the transaction', async () => {
      mockFindUnique.mockResolvedValueOnce({ ...EXISTING_ROW, userId: OTHER_ID });

      await expect(
        updatePto(
          ACTOR_MEMBER,
          PTO_ID,
          {
            startDate: '2026-05-12',
            endDate: '2026-05-12',
            dayPart: 'morning',
          },
          1,
          USER_ID,
        ),
      ).rejects.toMatchObject({ status: 412, code: 'STALE_WRITE' });
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('keeps a missing record missing without a prior authorized observation', async () => {
      mockFindUnique.mockResolvedValueOnce(null);

      await expect(
        updatePto(
          ACTOR_MEMBER,
          PTO_ID,
          {
            startDate: '2026-05-12',
            endDate: '2026-05-12',
            dayPart: 'morning',
          },
          1,
        ),
      ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('reports a lost race as a stale write and writes no audit row', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      mockFindFirst.mockResolvedValueOnce(null);
      mockUpdate.mockRejectedValueOnce(missingRowError());

      await expect(
        updatePto(
          ACTOR_MEMBER,
          PTO_ID,
          {
            startDate: '2026-05-12',
            endDate: '2026-05-12',
            dayPart: 'morning',
          },
          1,
        ),
      ).rejects.toMatchObject({ status: 412, code: 'STALE_WRITE' });
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('never lets a driver failure carry the note or the statement into the answer', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      mockFindFirst.mockResolvedValueOnce(null);
      mockUpdate.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('constraint failed on note "Doctor"', {
          code: 'P2004',
          clientVersion: '7.10.1',
        }),
      );

      const error = await updatePto(
        ACTOR_MEMBER,
        PTO_ID,
        {
          startDate: '2026-05-12',
          endDate: '2026-05-12',
          dayPart: 'morning',
          note: 'Doctor',
        },
        1,
      ).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
      expect(String(error)).not.toContain('Doctor');
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });
  });

  describe('patchPto', () => {
    it('changes only the named field and keeps the stored note and day part', async () => {
      mockFindUnique.mockResolvedValueOnce({ ...EXISTING_ROW, dayPart: 'all_day' });
      mockFindFirst.mockResolvedValueOnce(null);
      mockUpdate.mockResolvedValueOnce(UPDATED_ROW);

      const result = await patchPto(ACTOR_MEMBER, PTO_ID, { endDate: '2026-05-13' }, 1);

      expect(result).toBe(UPDATED_ROW);
      const update = mockUpdate.mock.calls[0]![0] as {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      };
      expect(update.where).toEqual({ id: PTO_ID, userId: USER_ID, version: 1 });
      expect(update.data['startDate']).toEqual(new Date('2026-05-11T00:00:00.000Z'));
      expect(update.data['endDate']).toEqual(new Date('2026-05-13T00:00:00.000Z'));
      expect(update.data['dayPart']).toBe('all_day');
      expect(update.data).not.toHaveProperty('note');
      expect(update.data['version']).toEqual({ increment: 1 });
      expect(mockAuditCreate).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'update_pto',
            details: {
              startDate: '2026-05-11',
              endDate: '2026-05-13',
              dayPart: 'all_day',
              noteWritten: false,
            },
          }),
        }),
      );
    });

    it.each([
      { label: 'null', note: null },
      { label: 'an empty string', note: '' },
    ])('clears the stored note when the patch carries $label', async ({ note }) => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      mockFindFirst.mockResolvedValueOnce(null);
      mockUpdate.mockResolvedValueOnce(UPDATED_ROW);

      await patchPto(ACTOR_MEMBER, PTO_ID, { note }, 1);

      const update = mockUpdate.mock.calls[0]![0] as { data: Record<string, unknown> };
      expect(update.data['note']).toBeNull();
      expect(mockAuditCreate).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          data: expect.objectContaining({
            details: expect.objectContaining({ noteWritten: true }),
          }),
        }),
      );
    });

    it('writes an explicit note text without putting it into the audit row', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      mockFindFirst.mockResolvedValueOnce(null);
      mockUpdate.mockResolvedValueOnce(UPDATED_ROW);

      await patchPto(ACTOR_MEMBER, PTO_ID, { note: 'Replacement' }, 1);

      const update = mockUpdate.mock.calls[0]![0] as { data: Record<string, unknown> };
      expect(update.data['note']).toBe('Replacement');
      expect(JSON.stringify(auditData())).not.toContain('Replacement');
      expect(auditData().details).not.toHaveProperty('note');
    });

    it('answers the database overlap guard with the same conflict as the preflight', async () => {
      mockFindUnique.mockResolvedValueOnce({ ...EXISTING_ROW, dayPart: 'all_day' });
      mockFindFirst.mockResolvedValueOnce(null);
      mockUpdate.mockRejectedValueOnce(overlapViolationError());

      await expect(
        patchPto(ACTOR_MEMBER, PTO_ID, { endDate: '2026-05-13' }, 1),
      ).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('refuses a stale snapshot and a foreign record without a write', async () => {
      mockFindUnique.mockResolvedValueOnce({ ...EXISTING_ROW, version: 9 });
      await expect(
        patchPto(ACTOR_MEMBER, PTO_ID, { endDate: '2026-05-13' }, 1),
      ).rejects.toMatchObject({ status: 412, code: 'STALE_WRITE' });
      mockFindUnique.mockResolvedValueOnce(null);
      await expect(
        patchPto(ACTOR_MEMBER, PTO_ID, { endDate: '2026-05-13' }, 1),
      ).rejects.toMatchObject({
        status: 404,
        code: 'NOT_FOUND',
      });
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      await expect(
        patchPto(ACTOR_OTHER_MEMBER, PTO_ID, { endDate: '2026-05-13' }, 1),
      ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('reports a stale write when an authorized record disappears before the transaction', async () => {
      mockFindUnique.mockResolvedValueOnce(null);

      await expect(
        patchPto(ACTOR_MEMBER, PTO_ID, { dayPart: 'evening' }, 1, USER_ID),
      ).rejects.toMatchObject({ status: 412, code: 'STALE_WRITE' });
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('keeps a missing record missing without a prior authorized observation', async () => {
      mockFindUnique.mockResolvedValueOnce(null);

      await expect(patchPto(ACTOR_MEMBER, PTO_ID, { dayPart: 'evening' }, 1)).rejects.toMatchObject(
        {
          status: 404,
          code: 'NOT_FOUND',
        },
      );
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('returns 409 when the merged record overlaps another PTO of the same user', async () => {
      mockFindUnique.mockResolvedValueOnce({ ...EXISTING_ROW, dayPart: 'all_day' });
      mockFindFirst.mockResolvedValueOnce({ id: 'another-id' });

      await expect(
        patchPto(ACTOR_MEMBER, PTO_ID, { endDate: '2026-05-13' }, 1),
      ).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('never lets a driver failure of the live read carry its cause', async () => {
      mockFindUnique.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('connection to the server was lost', {
          code: 'P1001',
          clientVersion: '7.10.1',
        }),
      );

      const error = await patchPto(ACTOR_MEMBER, PTO_ID, { dayPart: 'evening' }, 1).catch(
        (err: unknown) => err,
      );
      expect(error).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
      expect(String(error)).not.toContain('connection');
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('never lets a driver failure of a guarded delete carry its cause', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      mockDelete.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('deadlock detected', {
          code: 'P2034',
          clientVersion: '7.10.1',
        }),
      );

      const error = await deletePto(ACTOR_MEMBER, PTO_ID, 1).catch((err: unknown) => err);
      expect(error).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
      expect(String(error)).not.toContain('deadlock');
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('refuses a merged record whose retained half-day day part cannot describe the range', async () => {
      mockFindUnique.mockResolvedValueOnce({
        ...EXISTING_ROW,
        startDate: new Date('2026-05-11T00:00:00.000Z'),
        endDate: new Date('2026-05-11T00:00:00.000Z'),
        dayPart: 'morning',
      });

      await expect(
        patchPto(ACTOR_MEMBER, PTO_ID, { endDate: '2026-05-13' }, 1),
      ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });
  });

  describe('deletePto', () => {
    it('returns 404 when the PTO is missing', async () => {
      mockFindUnique.mockResolvedValueOnce(null);
      await expect(deletePto(ACTOR_MEMBER, PTO_ID, 1)).rejects.toMatchObject({
        status: 404,
        code: 'NOT_FOUND',
      });
    });

    it('returns 403 when a non-owner non-lead attempts to delete', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      await expect(deletePto(ACTOR_OTHER_MEMBER, PTO_ID, 1)).rejects.toMatchObject({
        status: 403,
        code: 'FORBIDDEN',
      });
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('lets the owner delete and writes an audit summary of the removed row inside a transaction', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      mockDelete.mockResolvedValueOnce(DELETED_ROW);
      await deletePto(ACTOR_MEMBER, PTO_ID, 1);
      expect(mockDelete).toHaveBeenCalledWith({
        where: { id: PTO_ID, userId: USER_ID, version: 1 },
        select: { userId: true, startDate: true, endDate: true, dayPart: true },
      });
      expect(mockTx).toHaveBeenCalledTimes(1);
      expect(mockAuditCreate).toHaveBeenCalledWith({
        data: {
          actorUserId: USER_ID,
          action: 'delete_pto',
          entityType: 'pto_request',
          entityId: PTO_ID,
          details: { startDate: '2026-05-11', endDate: '2026-05-11', dayPart: 'morning' },
          credentialType: 'session',
          sourceTokenId: null,
          targetOwnerId: USER_ID,
          requestId: 'req-pto-1',
        },
      });
    });

    it('lets a team lead delete another user PTO and audits the action', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      mockDelete.mockResolvedValueOnce(DELETED_ROW);
      await deletePto(ACTOR_LEAD, PTO_ID, 1);
      expect(mockAuditCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ actorUserId: LEAD_ID, action: 'delete_pto' }),
        }),
      );
    });

    it('audits a personal-token delete with the source token ID', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      mockDelete.mockResolvedValueOnce(DELETED_ROW);
      await deletePto(ACTOR_PAT_OWNER, PTO_ID, 1);
      expect(auditData()).toMatchObject({
        credentialType: 'personal_access_token',
        sourceTokenId: TOKEN_ID,
        requestId: 'req-pat-pto-1',
      });
    });

    it('propagates an audit failure after the delete so the removal cannot commit alone', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      mockDelete.mockResolvedValueOnce(DELETED_ROW);
      mockAuditCreate.mockRejectedValueOnce(new Error('audit insert failed'));
      await expect(deletePto(ACTOR_MEMBER, PTO_ID, 1)).rejects.toThrow('audit insert failed');
      expect(mockDelete).toHaveBeenCalledTimes(1);
    });

    it('reports a stale write when an authorized record disappears before the transaction', async () => {
      mockFindUnique.mockResolvedValueOnce(null);

      await expect(deletePto(ACTOR_MEMBER, PTO_ID, 1, USER_ID)).rejects.toMatchObject({
        status: 412,
        code: 'STALE_WRITE',
      });
      expect(mockDelete).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('reports a stale write when an authorized record changed owner before the transaction', async () => {
      mockFindUnique.mockResolvedValueOnce({ ...EXISTING_ROW, userId: OTHER_ID });

      await expect(deletePto(ACTOR_MEMBER, PTO_ID, 1, USER_ID)).rejects.toMatchObject({
        status: 412,
        code: 'STALE_WRITE',
      });
      expect(mockDelete).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('keeps a missing record missing without a prior authorized observation', async () => {
      mockFindUnique.mockResolvedValueOnce(null);

      await expect(deletePto(ACTOR_MEMBER, PTO_ID, 1)).rejects.toMatchObject({
        status: 404,
        code: 'NOT_FOUND',
      });
      expect(mockDelete).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('refuses a stale snapshot and a lost race without removing anything', async () => {
      mockFindUnique.mockResolvedValueOnce({ ...EXISTING_ROW, version: 5 });
      await expect(deletePto(ACTOR_MEMBER, PTO_ID, 1)).rejects.toMatchObject({
        status: 412,
        code: 'STALE_WRITE',
      });
      expect(mockDelete).not.toHaveBeenCalled();

      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      mockDelete.mockRejectedValueOnce(missingRowError());
      await expect(deletePto(ACTOR_MEMBER, PTO_ID, 1)).rejects.toMatchObject({
        status: 412,
        code: 'STALE_WRITE',
      });
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });
  });

  describe('createPtoIdempotently', () => {
    const KEY: ParsedPtoKey = {
      value: 'v1.1778284800000.11111111-1111-4111-8111-111111111111',
      issuedAtMs: Date.parse('2026-05-10T00:00:00.000Z'),
      expiresAt: new Date('2026-05-11T00:00:00.000Z'),
    };
    const INPUT = { startDate: '2026-05-11', endDate: '2026-05-11', dayPart: 'morning' as const };
    const AUTH: AuthContext = {
      method: 'session',
      actor: { id: USER_ID, role: 'member' },
      requestId: 'req-pto-1',
    };
    const PAT_WITHOUT_NOTES: AuthContext = {
      method: 'pat',
      actor: { id: USER_ID, role: 'member' },
      requestId: 'req-pto-1',
      tokenId: TOKEN_ID,
      scopes: ['pto:read', 'pto:create'],
      expiresAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    const CREATED = {
      id: PTO_ID,
      userId: USER_ID,
      version: 1,
      startDate: new Date('2026-05-11T00:00:00.000Z'),
      endDate: new Date('2026-05-11T00:00:00.000Z'),
      dayPart: 'morning' as const,
      note: 'Doctor',
      createdAt: new Date('2026-05-01T10:00:00.000Z'),
      updatedAt: new Date('2026-05-01T10:00:00.000Z'),
    };
    const SNAPSHOT = {
      id: PTO_ID,
      userId: USER_ID,
      startDate: '2026-05-11',
      endDate: '2026-05-11',
      dayPart: 'morning',
      version: 1,
      createdAt: '2026-05-01T10:00:00.000Z',
      updatedAt: '2026-05-01T10:00:00.000Z',
    };
    const BEFORE = new Date('2026-05-10T00:00:00.000Z');

    function credential(
      recheck: () => Promise<AuthContext> = async () => AUTH,
    ): PtoReplayCredential {
      return { ownerId: USER_ID, kind: 'pat', credentialId: TOKEN_ID, recheck: vi.fn(recheck) };
    }

    /** Answers the replay statements by their SQL text. */
    function replayQueries(options: {
      clock?: Date[];
      claim?: unknown[];
      stored?: unknown[];
    }): void {
      const clocks = options.clock ?? [BEFORE];
      let clockCalls = 0;
      mockQueryRaw.mockImplementation(async (sql: unknown) => {
        const text = (sql as { text: string }).text;
        if (text.includes('clock_timestamp() AS at')) {
          const at = clocks[Math.min(clockCalls++, clocks.length - 1)]!;
          return [{ at }];
        }
        if (text.includes('INSERT INTO')) return options.claim ?? [{ id: 'replay-id' }];
        if (text.includes('SELECT "payload_fingerprint"')) return options.stored ?? [];
        return [];
      });
    }

    beforeEach(() => {
      mockQueryRaw.mockReset();
      mockExecuteRaw.mockReset();
      mockExecuteRaw.mockResolvedValue(1);
    });

    it('claims the key, creates the entry and stores the note-free result', async () => {
      replayQueries({});
      mockFindFirst.mockResolvedValueOnce(null);
      mockCreate.mockResolvedValueOnce(CREATED);
      const recheck = vi.fn(async () => AUTH);

      const outcome = await createPtoIdempotently(INPUT, KEY, credential(recheck));

      expect(outcome.replayed).toBe(false);
      expect(outcome.auth).toBe(AUTH);
      expect(outcome.expiresAt).toEqual(KEY.expiresAt);
      expect(outcome.row.id).toBe(PTO_ID);
      expect(recheck).toHaveBeenCalledTimes(1);
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockAuditCreate).toHaveBeenCalledTimes(1);
      // The stored result carries the row metadata, never the note.
      expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
      const stored = mockExecuteRaw.mock.calls[0]![0] as { values: unknown[] };
      expect(JSON.stringify(stored.values)).not.toContain('Doctor');
    });

    it('replays the stored result without creating or auditing again', async () => {
      replayQueries({
        claim: [],
        stored: [{ payloadFingerprint: fingerprintOf(), result: SNAPSHOT }],
      });
      mockFindUnique.mockResolvedValueOnce({
        id: PTO_ID,
        userId: USER_ID,
        version: 1,
        note: 'Doctor',
      });

      const outcome = await createPtoIdempotently(INPUT, KEY, credential());

      expect(outcome.replayed).toBe(true);
      expect(outcome.row.id).toBe(PTO_ID);
      expect(outcome.row.note).toBe('Doctor');
      expect(outcome.row.version).toBe(1);
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('keeps the note of a replayed entry only for the caller that may read it', async () => {
      replayQueries({
        claim: [],
        stored: [{ payloadFingerprint: fingerprintOf(), result: SNAPSHOT }],
      });
      mockFindUnique.mockResolvedValueOnce({
        id: PTO_ID,
        userId: USER_ID,
        version: 1,
        note: 'Doctor',
      });
      const outcome = await createPtoIdempotently(
        INPUT,
        KEY,
        credential(async () => PAT_WITHOUT_NOTES),
      );

      expect(outcome.row.note).toBeNull();
    });

    it('keeps a changed or deleted entry without its note and with its stored metadata', async () => {
      replayQueries({
        claim: [],
        stored: [{ payloadFingerprint: fingerprintOf(), result: SNAPSHOT }],
      });
      mockFindUnique.mockResolvedValueOnce({
        id: PTO_ID,
        userId: USER_ID,
        version: 2,
        note: 'Changed note',
      });

      const changed = await createPtoIdempotently(INPUT, KEY, credential());
      expect(changed.row.note).toBeNull();
      expect(changed.row.version).toBe(1);
      expect(changed.row.startDate).toEqual(new Date('2026-05-11T00:00:00.000Z'));

      replayQueries({
        claim: [],
        stored: [{ payloadFingerprint: fingerprintOf(), result: SNAPSHOT }],
      });
      mockFindUnique.mockResolvedValueOnce(null);
      const deleted = await createPtoIdempotently(INPUT, KEY, credential());
      expect(deleted.row.note).toBeNull();
      expect(deleted.row.id).toBe(PTO_ID);
    });

    it('refuses a key that was used for a different payload', async () => {
      replayQueries({
        claim: [],
        stored: [{ payloadFingerprint: 'b'.repeat(64), result: SNAPSHOT }],
      });

      await expect(createPtoIdempotently(INPUT, KEY, credential())).rejects.toMatchObject({
        status: 409,
        code: 'IDEMPOTENCY_CONFLICT',
      });
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('refuses a key that cannot be verified any more', async () => {
      replayQueries({
        claim: [],
        stored: [{ payloadFingerprint: 'b'.repeat(64), result: SNAPSHOT }],
      });

      await expect(createPtoIdempotently(INPUT, KEY, credential())).rejects.toMatchObject({
        status: 409,
        code: 'IDEMPOTENCY_CONFLICT',
      });
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('refuses a stored result whose shape is unknown', async () => {
      replayQueries({
        claim: [],
        stored: [{ payloadFingerprint: fingerprintOf(), result: { id: 7 } }],
      });

      await expect(createPtoIdempotently(INPUT, KEY, credential())).rejects.toMatchObject({
        status: 409,
        code: 'IDEMPOTENCY_CONFLICT',
      });
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('refuses an expired key before it claims anything', async () => {
      replayQueries({ clock: [KEY.expiresAt] });

      await expect(createPtoIdempotently(INPUT, KEY, credential())).rejects.toMatchObject({
        status: 409,
        code: 'IDEMPOTENCY_EXPIRED',
      });
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('refuses an issuance timestamp too far ahead of database time', async () => {
      replayQueries({ clock: [new Date(KEY.issuedAtMs - 120_001)] });
      await expect(createPtoIdempotently(INPUT, KEY, credential())).rejects.toMatchObject({
        status: 400,
        code: 'VALIDATION_ERROR',
      });
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    });

    it('refuses a stored result naming a different owner', async () => {
      replayQueries({
        claim: [],
        stored: [{ payloadFingerprint: fingerprintOf(), result: { ...SNAPSHOT, userId: 'other' } }],
      });
      await expect(createPtoIdempotently(INPUT, KEY, credential())).rejects.toMatchObject({
        status: 409,
        code: 'IDEMPOTENCY_CONFLICT',
      });
      expect(mockFindUnique).not.toHaveBeenCalled();
    });

    it('does not return a replay if the rechecked PAT expires while recovering the note', async () => {
      const pat = { ...PAT_WITHOUT_NOTES, expiresAt: new Date(BEFORE.getTime() + 1000) };
      replayQueries({
        clock: [BEFORE, BEFORE, pat.expiresAt],
        claim: [],
        stored: [{ payloadFingerprint: fingerprintOf(), result: SNAPSHOT }],
      });
      mockFindUnique.mockResolvedValueOnce(null);
      await expect(
        createPtoIdempotently(
          INPUT,
          KEY,
          credential(async () => pat),
        ),
      ).rejects.toMatchObject({
        status: 401,
        code: 'UNAUTHENTICATED',
      });
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('refuses a key that expired while it waited for the other writer', async () => {
      replayQueries({ clock: [BEFORE, KEY.expiresAt] });

      await expect(createPtoIdempotently(INPUT, KEY, credential())).rejects.toMatchObject({
        status: 409,
        code: 'IDEMPOTENCY_EXPIRED',
      });
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('refuses a key whose stored row is gone', async () => {
      replayQueries({ claim: [], stored: [] });

      await expect(createPtoIdempotently(INPUT, KEY, credential())).rejects.toMatchObject({
        status: 409,
        code: 'IDEMPOTENCY_CONFLICT',
      });
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('keeps the overlap answer of the preflight and writes no audit row', async () => {
      replayQueries({});
      mockFindFirst.mockResolvedValueOnce({ id: 'another-id' });

      await expect(createPtoIdempotently(INPUT, KEY, credential())).rejects.toMatchObject({
        status: 409,
        code: 'CONFLICT',
      });
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('removes expired rows in a bounded selection', async () => {
      replayQueries({});
      mockFindFirst.mockResolvedValueOnce(null);
      mockCreate.mockResolvedValueOnce(CREATED);

      await createPtoIdempotently(INPUT, KEY, credential());

      const cleanup = mockQueryRaw.mock.calls.find((call) =>
        (call[0] as { text: string }).text.includes('DELETE FROM'),
      );
      expect(cleanup).toBeDefined();
      expect((cleanup![0] as { text: string }).text).toContain('SKIP LOCKED');
    });

    /** The fingerprint of the stored payload under the active signing key. */
    function fingerprintOf(): string {
      return payloadFingerprint(
        { startDate: '2026-05-11', endDate: '2026-05-11', dayPart: 'morning', note: null },
        signingKeys()[0]!,
      );
    }
  });

  describe('toPublicPto', () => {
    it('converts a Prisma row to the public API shape', () => {
      const publicRow = toPublicPto({
        id: PTO_ID,
        userId: USER_ID,
        startDate: new Date('2026-05-11T00:00:00.000Z'),
        endDate: new Date('2026-05-11T00:00:00.000Z'),
        dayPart: 'morning',
        note: null,
        version: 4,
        createdAt: new Date('2026-05-01T10:00:00.000Z'),
        updatedAt: new Date('2026-05-01T10:00:00.000Z'),
      });
      expect(publicRow).toEqual({
        id: PTO_ID,
        userId: USER_ID,
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'morning',
        note: null,
        version: 4,
        createdAt: '2026-05-01T10:00:00.000Z',
        updatedAt: '2026-05-01T10:00:00.000Z',
      });
    });
  });

  describe('findOverlapping', () => {
    it('returns the overlapping row when one exists', async () => {
      const overlapRow = {
        id: 'existing',
        userId: USER_ID,
        startDate: new Date('2026-05-11T00:00:00.000Z'),
        endDate: new Date('2026-05-11T00:00:00.000Z'),
        dayPart: 'morning' as const,
        note: null,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockFindFirst.mockResolvedValueOnce(overlapRow);
      const result = await findOverlapping(USER_ID, '2026-05-11', '2026-05-12');
      expect(result).toBe(overlapRow);
    });

    it('returns null when no overlap exists', async () => {
      mockFindFirst.mockResolvedValueOnce(null);
      const result = await findOverlapping(USER_ID, '2026-06-01', '2026-06-05');
      expect(result).toBeNull();
    });

    it('builds a where-clause filtering by userId and overlapping dates', async () => {
      mockFindFirst.mockResolvedValueOnce(null);
      await findOverlapping(USER_ID, '2026-05-11', '2026-05-13');

      const call = mockFindFirst.mock.calls[0]![0] as { where: Record<string, unknown> };
      expect(call.where).toMatchObject({ userId: USER_ID });
      const andClause = call.where['AND'] as Array<Record<string, unknown>>;
      expect(andClause).toHaveLength(2);
      expect(andClause[0]).toHaveProperty('startDate.lte');
      expect(andClause[1]).toHaveProperty('endDate.gte');
    });

    it('includes id NOT in the where-clause when excludeId is provided', async () => {
      mockFindFirst.mockResolvedValueOnce(null);
      await findOverlapping(USER_ID, '2026-05-11', '2026-05-13', PTO_ID);

      const call = mockFindFirst.mock.calls[0]![0] as { where: Record<string, unknown> };
      expect(call.where['id']).toEqual({ not: PTO_ID });
    });

    it('omits id from the where-clause when excludeId is not provided', async () => {
      mockFindFirst.mockResolvedValueOnce(null);
      await findOverlapping(USER_ID, '2026-05-11', '2026-05-13');

      const call = mockFindFirst.mock.calls[0]![0] as { where: Record<string, unknown> };
      expect(call.where).not.toHaveProperty('id');
    });
  });
});
