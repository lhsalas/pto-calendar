import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../middleware/errorHandler.js';
import type { AttributedActor } from '../audit/auditContext.js';
import type { CreatePtoInput } from './schemas.js';
import {
  createPto,
  deletePto,
  findOverlapping,
  getPtoById,
  toPublicPto,
  updatePto,
} from './PTOService.js';

vi.mock('../../lib/prisma.js', () => {
  const pTORequest = {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  const auditLog = { create: vi.fn(), findMany: vi.fn() };
  const tx = { pTORequest, auditLog };
  const $transaction = vi.fn((fn: (txClient: typeof tx) => Promise<unknown>) => fn(tx));
  return { prisma: { pTORequest, auditLog, $transaction } };
});

import { prisma } from '../../lib/prisma.js';

const mockFindFirst = prisma.pTORequest.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockFindUnique = prisma.pTORequest.findUnique as unknown as ReturnType<typeof vi.fn>;
const mockCreate = prisma.pTORequest.create as unknown as ReturnType<typeof vi.fn>;
const mockUpdate = prisma.pTORequest.update as unknown as ReturnType<typeof vi.fn>;
const mockDelete = prisma.pTORequest.delete as unknown as ReturnType<typeof vi.fn>;
const mockAuditCreate = prisma.auditLog.create as unknown as ReturnType<typeof vi.fn>;
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
};

const UPDATED_ROW = {
  id: PTO_ID,
  userId: USER_ID,
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
        updatePto(ACTOR_MEMBER, PTO_ID, {
          startDate: '2026-05-12',
          endDate: '2026-05-12',
          dayPart: 'morning',
        }),
      ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    });

    it('returns 403 when a non-owner non-lead attempts to edit', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      await expect(
        updatePto(ACTOR_OTHER_MEMBER, PTO_ID, {
          startDate: '2026-05-12',
          endDate: '2026-05-12',
          dayPart: 'morning',
        }),
      ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('lets the owner update and writes an audit log inside a transaction', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      mockFindFirst.mockResolvedValueOnce(null);
      mockUpdate.mockResolvedValueOnce(UPDATED_ROW);

      const result = await updatePto(ACTOR_MEMBER, PTO_ID, {
        startDate: '2026-05-12',
        endDate: '2026-05-12',
        dayPart: 'morning',
        note: 'Edited',
      });

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

        const result = await updatePto(ACTOR_MEMBER, PTO_ID, {
          startDate: '2026-05-12',
          endDate: '2026-05-12',
          dayPart: 'morning',
        });

        expect(result).toBe(persisted);
        expect(mockFindUnique).toHaveBeenCalledExactlyOnceWith({
          where: { id: PTO_ID },
          select: { id: true, userId: true },
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

        const result = await updatePto(ACTOR_MEMBER, PTO_ID, {
          startDate: '2026-05-12',
          endDate: '2026-05-12',
          dayPart: 'morning',
          note,
        });

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

      await expect(updatePto(ACTOR_MEMBER, PTO_ID, input)).rejects.toMatchObject({
        status: 400,
        code: 'VALIDATION_ERROR',
      });
      expect(mockFindFirst).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
      expect(mockTx).not.toHaveBeenCalled();
    });

    it('lets a team lead update another user PTO and audits the lead as actor with the owner as target', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      mockFindFirst.mockResolvedValueOnce(null);
      mockUpdate.mockResolvedValueOnce(UPDATED_ROW);

      await updatePto(ACTOR_LEAD, PTO_ID, {
        startDate: '2026-05-12',
        endDate: '2026-05-12',
        dayPart: 'morning',
      });
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

      await updatePto(ACTOR_PAT_OWNER, PTO_ID, {
        startDate: '2026-05-12',
        endDate: '2026-05-12',
        dayPart: 'morning',
        note: 'Edited',
      });

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
        updatePto(ACTOR_MEMBER, PTO_ID, {
          startDate: '2026-05-12',
          endDate: '2026-05-13',
          dayPart: 'all_day',
        }),
      ).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockAuditCreate).not.toHaveBeenCalled();
      expect(mockTx).not.toHaveBeenCalled();
    });

    it('re-runs validation and rejects weekend edits', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      await expect(
        updatePto(ACTOR_MEMBER, PTO_ID, {
          startDate: '2026-05-09',
          endDate: '2026-05-09',
          dayPart: 'morning',
        }),
      ).rejects.toBeInstanceOf(HttpError);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('propagates an audit failure after the update so the update cannot commit alone', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      mockFindFirst.mockResolvedValueOnce(null);
      mockUpdate.mockResolvedValueOnce(UPDATED_ROW);
      mockAuditCreate.mockRejectedValueOnce(new Error('audit insert failed'));

      await expect(
        updatePto(ACTOR_MEMBER, PTO_ID, {
          startDate: '2026-05-12',
          endDate: '2026-05-12',
          dayPart: 'morning',
        }),
      ).rejects.toThrow('audit insert failed');
      expect(mockUpdate).toHaveBeenCalledTimes(1);
    });
  });

  describe('deletePto', () => {
    it('returns 404 when the PTO is missing', async () => {
      mockFindUnique.mockResolvedValueOnce(null);
      await expect(deletePto(ACTOR_MEMBER, PTO_ID)).rejects.toMatchObject({
        status: 404,
        code: 'NOT_FOUND',
      });
    });

    it('returns 403 when a non-owner non-lead attempts to delete', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      await expect(deletePto(ACTOR_OTHER_MEMBER, PTO_ID)).rejects.toMatchObject({
        status: 403,
        code: 'FORBIDDEN',
      });
      expect(mockAuditCreate).not.toHaveBeenCalled();
    });

    it('lets the owner delete and writes an audit summary of the removed row inside a transaction', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      mockDelete.mockResolvedValueOnce(DELETED_ROW);
      await deletePto(ACTOR_MEMBER, PTO_ID);
      expect(mockDelete).toHaveBeenCalledWith({
        where: { id: PTO_ID },
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
      await deletePto(ACTOR_LEAD, PTO_ID);
      expect(mockAuditCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ actorUserId: LEAD_ID, action: 'delete_pto' }),
        }),
      );
    });

    it('audits a personal-token delete with the source token ID', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      mockDelete.mockResolvedValueOnce(DELETED_ROW);
      await deletePto(ACTOR_PAT_OWNER, PTO_ID);
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
      await expect(deletePto(ACTOR_MEMBER, PTO_ID)).rejects.toThrow('audit insert failed');
      expect(mockDelete).toHaveBeenCalledTimes(1);
    });
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
