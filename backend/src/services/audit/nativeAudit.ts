import { randomUUID } from 'node:crypto';
import { safeAuditRequestId, type AuditActor } from './auditContext.js';
import type { AuditAction, AuditDetails, AuditEntityType } from './AuditLogService.js';

/** Minimal shape of the native token transaction client; TokenConnection satisfies it. */
export interface NativeAuditConnection {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export interface NativeAuditEvent {
  action: AuditAction;
  entityType: AuditEntityType;
  /** Public identifiers, one audit row each. An empty batch writes nothing. */
  entityIds: readonly string[];
  targetOwnerId: string | null;
  details?: AuditDetails;
}

/**
 * Writes audit rows on the caller's native transaction. Personal-token mutations
 * use it so each change and its audit row commit or roll back together, and no
 * separate Prisma or global connection is involved after commit.
 */
export async function recordNativeAudit(
  connection: NativeAuditConnection,
  auditTable: string,
  actor: AuditActor,
  event: NativeAuditEvent,
): Promise<void> {
  if (event.entityIds.length === 0) return;
  const { credential } = actor;
  await connection.query(
    `INSERT INTO ${auditTable}
       (id, actor_user_id, action, entity_type, entity_id, details,
        credential_type, source_token_id, target_owner_id, request_id)
     SELECT audit.id, $1::uuid, $2::varchar, $3::varchar, audit.entity_id, $4::jsonb,
            $5::varchar, $6::uuid, $7::uuid, $8::varchar
     FROM unnest($9::uuid[], $10::uuid[]) AS audit(id, entity_id)`,
    [
      actor.id,
      event.action,
      event.entityType,
      event.details ? JSON.stringify(event.details) : null,
      credential.type,
      credential.type === 'personal_access_token' ? credential.tokenId : null,
      event.targetOwnerId,
      safeAuditRequestId(actor.requestId),
      event.entityIds.map(() => randomUUID()),
      [...event.entityIds],
    ],
  );
}
