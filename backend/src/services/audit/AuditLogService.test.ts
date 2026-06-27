import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listForEntity, record } from './AuditLogService.js';

vi.mock('../../lib/prisma.js', () => {
  const auditLog = {
    create: vi.fn(),
    findMany: vi.fn(),
  };
  return { prisma: { auditLog } };
});

import { prisma } from '../../lib/prisma.js';

const mockCreate = prisma.auditLog.create as unknown as ReturnType<typeof vi.fn>;
const mockFindMany = prisma.auditLog.findMany as unknown as ReturnType<typeof vi.fn>;

const ENTRY = {
  actorUserId: '11111111-1111-1111-1111-111111111111',
  action: 'update_pto' as const,
  entityType: 'pto_request' as const,
  entityId: '22222222-2222-2222-2222-222222222222',
  details: { note: 'before' },
};

describe('AuditLogService', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockFindMany.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  describe('record', () => {
    it('writes a row with the documented fields', async () => {
      mockCreate.mockResolvedValueOnce({});
      await record(ENTRY);
      expect(mockCreate).toHaveBeenCalledWith({
        data: {
          actorUserId: ENTRY.actorUserId,
          action: 'update_pto',
          entityType: 'pto_request',
          entityId: ENTRY.entityId,
          details: { note: 'before' },
        },
      });
    });

    it('serializes undefined details as null', async () => {
      mockCreate.mockResolvedValueOnce({});
      const { details: _ignored, ...rest } = ENTRY;
      await record(rest);
      expect(mockCreate).toHaveBeenCalledWith({
        data: {
          actorUserId: rest.actorUserId,
          action: 'update_pto',
          entityType: 'pto_request',
          entityId: rest.entityId,
          details: null,
        },
      });
    });

    it('accepts an explicit Prisma client (for transactions)', async () => {
      const tx = { auditLog: { create: vi.fn().mockResolvedValueOnce({}) } };
      await record(ENTRY, tx as unknown as Parameters<typeof record>[1]);
      expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('listForEntity', () => {
    it('queries by entityType + entityId ordered by createdAt desc', async () => {
      mockFindMany.mockResolvedValueOnce([]);
      await listForEntity('pto_request', ENTRY.entityId);
      expect(mockFindMany).toHaveBeenCalledWith({
        where: { entityType: 'pto_request', entityId: ENTRY.entityId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          actorUserId: true,
          action: true,
          entityType: true,
          entityId: true,
          details: true,
          createdAt: true,
        },
      });
    });
  });
});
