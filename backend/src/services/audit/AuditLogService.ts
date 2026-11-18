import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { safeAuditRequestId, type AuditActor, type AuditCredential } from './auditContext.js';

export type AuditAction =
  | 'create_pto'
  | 'update_pto'
  | 'delete_pto'
  | 'create_personal_token'
  | 'revoke_personal_token'
  | 'reset_user_password'
  | 'complete_account_setup'
  | 'change_user_role'
  | 'create_user'
  | 'create_holiday'
  | 'delete_holiday'
  | 'seed_holidays';
export type AuditEntityType = 'pto_request' | 'personal_access_token' | 'user' | 'holiday';

/**
 * Flat, bounded change summary. Raw notes, credentials, digests and passwords are
 * never valid here; the type excludes nested objects to keep summaries reviewable.
 */
export type AuditDetails = Readonly<
  Record<string, string | number | boolean | null | readonly string[]>
>;

export interface AuditLogEntry {
  actorUserId: string;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  /** Owner of the affected record or credential; null when no owner applies. */
  targetOwnerId?: string | null;
  /** Absent for legacy writers, which leave attribution columns NULL. */
  credential?: AuditCredential;
  requestId?: string | null;
  details?: AuditDetails;
}

export interface AuditLogRow {
  id: string;
  actorUserId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: unknown;
  createdAt: Date;
  credentialType: string | null;
  sourceTokenId: string | null;
  targetOwnerId: string | null;
  requestId: string | null;
}

// Internal reads only: no HTTP route exposes audit rows.
const INTERNAL_AUDIT_SELECT = {
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
} as const;

/** Builds an entry whose identity, credential and request ID all come from one verified actor. */
export function auditEntryFor(
  actor: AuditActor,
  fields: Omit<AuditLogEntry, 'actorUserId' | 'credential' | 'requestId'>,
): AuditLogEntry {
  return {
    ...fields,
    actorUserId: actor.id,
    credential: actor.credential,
    requestId: actor.requestId,
  };
}

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
      credentialType: entry.credential?.type ?? null,
      sourceTokenId:
        entry.credential?.type === 'personal_access_token' ? entry.credential.tokenId : null,
      targetOwnerId: entry.targetOwnerId ?? null,
      requestId: safeAuditRequestId(entry.requestId ?? null),
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
    select: INTERNAL_AUDIT_SELECT,
  });
}
