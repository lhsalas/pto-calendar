import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

export type AuditAction =
  | 'update_pto'
  | 'delete_pto'
  | 'create_user'
  | 'reset_user_password'
  | 'create_holiday'
  | 'delete_holiday'
  | 'seed_holidays';
export type AuditEntityType = 'pto_request' | 'user' | 'holiday';

export interface AuditLogEntry {
  actorUserId: string;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  details?: Record<string, unknown>;
}

export interface AuditLogRow {
  id: string;
  actorUserId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: unknown;
  createdAt: Date;
}

const PUBLIC_AUDIT_SELECT = {
  id: true,
  actorUserId: true,
  action: true,
  entityType: true,
  entityId: true,
  details: true,
  createdAt: true,
} as const;

export async function record(
  entry: AuditLogEntry,
  client: Prisma.TransactionClient | PrismaClient = prisma,
): Promise<void> {
  await client.auditLog.create({
    data: {
      actorUserId: entry.actorUserId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      details: (entry.details ?? null) as Prisma.InputJsonValue,
    },
  });
}

export async function listForEntity(
  entityType: AuditEntityType,
  entityId: string,
): Promise<AuditLogRow[]> {
  return prisma.auditLog.findMany({
    where: { entityType, entityId },
    orderBy: { createdAt: 'desc' },
    select: PUBLIC_AUDIT_SELECT,
  });
}
