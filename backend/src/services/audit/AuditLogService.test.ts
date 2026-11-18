import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditEntryFor, listForEntity, record } from './AuditLogService.js';

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
  details: { startDate: '2026-05-12' },
};

const LEGACY_DATA = {
  actorUserId: ENTRY.actorUserId,
  action: 'update_pto',
  entityType: 'pto_request',
  entityId: ENTRY.entityId,
  details: { startDate: '2026-05-12' },
  credentialType: null,
  sourceTokenId: null,
  targetOwnerId: null,
  requestId: null,
};

describe('AuditLogService', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockFindMany.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  describe('record', () => {
    it('writes a legacy row with explicit NULL attribution when no credential is supplied', async () => {
      mockCreate.mockResolvedValueOnce({});
      await record(ENTRY);
      expect(mockCreate).toHaveBeenCalledWith({ data: LEGACY_DATA });
    });

    it('serializes undefined details as null', async () => {
      mockCreate.mockResolvedValueOnce({});
      const { details: _ignored, ...rest } = ENTRY;
      await record(rest);
      expect(mockCreate).toHaveBeenCalledWith({
        data: { ...LEGACY_DATA, details: null },
      });
    });

    it('stores a session credential without any source token', async () => {
      mockCreate.mockResolvedValueOnce({});
      await record({
        ...ENTRY,
        credential: { type: 'session' },
        targetOwnerId: ENTRY.actorUserId,
        requestId: 'req-session-1',
      });
      expect(mockCreate).toHaveBeenCalledWith({
        data: {
          ...LEGACY_DATA,
          credentialType: 'session',
          sourceTokenId: null,
          targetOwnerId: ENTRY.actorUserId,
          requestId: 'req-session-1',
        },
      });
    });

    it('stores the personal-token source ID only for personal-token credentials', async () => {
      mockCreate.mockResolvedValueOnce({});
      const tokenId = '33333333-3333-4333-8333-333333333333';
      await record({
        ...ENTRY,
        credential: { type: 'personal_access_token', tokenId },
        requestId: 'req-pat-1',
      });
      expect(mockCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          credentialType: 'personal_access_token',
          sourceTokenId: tokenId,
          requestId: 'req-pat-1',
        }),
      });
    });

    it('stores setup and operator credentials without a source token', async () => {
      mockCreate.mockResolvedValue({});
      await record({ ...ENTRY, credential: { type: 'setup_token' } });
      await record({ ...ENTRY, credential: { type: 'operator' } });
      expect(mockCreate.mock.calls[0]![0].data).toMatchObject({
        credentialType: 'setup_token',
        sourceTokenId: null,
      });
      expect(mockCreate.mock.calls[1]![0].data).toMatchObject({
        credentialType: 'operator',
        sourceTokenId: null,
      });
    });

    it('drops an unsafe request ID to NULL instead of persisting it', async () => {
      mockCreate.mockResolvedValueOnce({});
      await record({ ...ENTRY, requestId: 'pto_pat_0000.abc' });
      expect(mockCreate.mock.calls[0]![0].data).toMatchObject({ requestId: null });
    });

    it('accepts an explicit Prisma client (for transactions)', async () => {
      const tx = { auditLog: { create: vi.fn().mockResolvedValueOnce({}) } };
      await record(ENTRY, tx as unknown as Parameters<typeof record>[1]);
      expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('auditEntryFor', () => {
    it('takes identity, credential and request ID from one verified actor', () => {
      expect(
        auditEntryFor(
          {
            id: ENTRY.actorUserId,
            credential: { type: 'personal_access_token', tokenId: 'token-1' },
            requestId: 'req-1',
          },
          { action: 'create_pto', entityType: 'pto_request', entityId: ENTRY.entityId },
        ),
      ).toEqual({
        actorUserId: ENTRY.actorUserId,
        action: 'create_pto',
        entityType: 'pto_request',
        entityId: ENTRY.entityId,
        credential: { type: 'personal_access_token', tokenId: 'token-1' },
        requestId: 'req-1',
      });
    });
  });

  describe('listForEntity', () => {
    it('queries by entityType + entityId ordered by createdAt desc, with internal attribution fields', async () => {
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
          credentialType: true,
          sourceTokenId: true,
          targetOwnerId: true,
          requestId: true,
        },
      });
    });
  });
});
