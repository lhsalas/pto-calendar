import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../middleware/errorHandler.js';
import { deletePto, getPtoById, toPublicPto, updatePto } from './PTOService.js';

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

const ACTOR_MEMBER = { id: USER_ID, role: 'member' as const };
const ACTOR_OTHER_MEMBER = { id: OTHER_ID, role: 'member' as const };
const ACTOR_LEAD = { id: '44444444-4444-4444-4444-444444444444', role: 'team_lead' as const };

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
      expect(mockAuditCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorUserId: USER_ID,
            action: 'update_pto',
            entityType: 'pto_request',
            entityId: PTO_ID,
          }),
        }),
      );
      expect(mockTx).toHaveBeenCalledTimes(1);
    });

    it('lets a team lead update another user PTO and audits the action', async () => {
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
          data: expect.objectContaining({ actorUserId: ACTOR_LEAD.id, action: 'update_pto' }),
        }),
      );
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
    });

    it('lets the owner delete and writes an audit log inside a transaction', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      mockDelete.mockResolvedValueOnce({});
      await deletePto(ACTOR_MEMBER, PTO_ID);
      expect(mockDelete).toHaveBeenCalledWith({ where: { id: PTO_ID } });
      expect(mockAuditCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorUserId: USER_ID,
            action: 'delete_pto',
            entityType: 'pto_request',
            entityId: PTO_ID,
          }),
        }),
      );
    });

    it('lets a team lead delete another user PTO and audits the action', async () => {
      mockFindUnique.mockResolvedValueOnce(EXISTING_ROW);
      mockDelete.mockResolvedValueOnce({});
      await deletePto(ACTOR_LEAD, PTO_ID);
      expect(mockAuditCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ actorUserId: ACTOR_LEAD.id, action: 'delete_pto' }),
        }),
      );
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
});
