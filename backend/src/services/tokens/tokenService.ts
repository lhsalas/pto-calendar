import type { AuditActor } from '../audit/auditContext.js';
import { recordNativeAudit } from '../audit/nativeAudit.js';
import type { TokenDatabase } from './tokenDatabase.js';
import { timestampParameter } from './pgTime.js';
import {
  createTokenMaterial,
  parseToken,
  tokenDigestMatches,
  tokenExpiry,
  validateTokenName,
  validateTokenScopes,
  type TokenOwnerRole,
  type TokenScope,
} from './tokenDomain.js';

export class TokenOperationError extends Error {
  constructor() {
    super('Token operation failed');
    this.name = 'TokenOperationError';
  }
}

export class TokenLimitError extends TokenOperationError {
  constructor() {
    super();
    this.name = 'TokenLimitError';
  }
}

/** The closed vocabulary of owner-visible token states. */
export const TOKEN_STATUSES = ['active', 'expired', 'revoked', 'invalidated'] as const;
export type TokenStatus = (typeof TOKEN_STATUSES)[number];

export interface TokenMetadata {
  id: string;
  name: string;
  displayPrefix: string;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  status: TokenStatus;
}

/** The safe columns every owner-visible read returns; never a credential. */
interface TokenMetadataRow {
  id: string;
  name: string;
  displayPrefix: string;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

// The schema stores UTC wall-clock timestamps without a time zone. Returning
// timestamptz makes pg parse an absolute instant, regardless of process.env.TZ.
const metadataColumns = `
  id::text AS id, name, display_prefix AS "displayPrefix", scopes,
  created_at AT TIME ZONE 'UTC' AS "createdAt",
  expires_at AT TIME ZONE 'UTC' AS "expiresAt",
  last_used_at AT TIME ZONE 'UTC' AS "lastUsedAt",
  revoked_at AT TIME ZONE 'UTC' AS "revokedAt"
`;

/**
 * The status is computed in the same read as the row it describes, so a client
 * never has to guess it from stale local state. Revoked wins, then expiry at
 * the database's UTC wall clock (the same clock the verifier uses), then
 * invalidation against the live owner: a session-version, account/password or
 * live team-scope mismatch. The owner is consulted through a correlated
 * subquery on the quoted users table, so no owner, session-version, password
 * or digest column is ever selected and no second query is issued.
 */
function statusColumn(tables: TokenDatabase['tables']): string {
  return `
    CASE
      WHEN revoked_at IS NOT NULL THEN 'revoked'
      WHEN expires_at <= (clock_timestamp() AT TIME ZONE 'UTC') THEN 'expired'
      WHEN EXISTS (
        SELECT 1 FROM ${tables.users} u
        WHERE u.id = owner_id
          AND (
            u.session_version IS DISTINCT FROM issued_session_version
            OR u.password_hash IS NULL
            OR (
              u.role::text NOT IN ('team_lead', 'admin')
              AND ('pto:update:team' = ANY(scopes) OR 'pto:delete:team' = ANY(scopes))
            )
          )
      ) THEN 'invalidated'
      ELSE 'active'
    END AS "status"
  `;
}

interface LockedOwner {
  id: string;
  role: TokenOwnerRole;
  passwordHash: string | null;
  sessionVersion: number;
}

/**
 * The authenticated actor is the owner. verifiedSessionVersion must come from the
 * credential verification that authorized this issuance, not a fresh version read
 * after verification. The token row and its audit row share one transaction.
 */
export async function issueToken(
  db: TokenDatabase,
  actor: AuditActor,
  verifiedSessionVersion: number,
  input: { name: unknown; scopes?: unknown; expiresInDays?: unknown },
): Promise<{ rawToken: string; token: TokenMetadata }> {
  const ownerId = actor.id;
  const name = validateTokenName(input.name);
  const material = createTokenMaterial();
  try {
    const token = await db.transaction(async (tx) => {
      const owners = await tx.query<LockedOwner>(
        `
        SELECT id::text AS id, role::text AS role, password_hash AS "passwordHash",
               session_version AS "sessionVersion"
        FROM ${db.tables.users} WHERE id = $1::uuid FOR UPDATE
        `,
        [ownerId],
      );
      const owner = owners.rows[0];
      if (!owner || !owner.passwordHash || owner.sessionVersion !== verifiedSessionVersion) {
        throw new TokenOperationError();
      }
      const scopes = validateTokenScopes(input.scopes, owner.role);
      const createdAt = new Date();
      const expiresAt = tokenExpiry(createdAt, input.expiresInDays);
      const active = await tx.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM ${db.tables.tokens}
         WHERE owner_id = $1::uuid AND issued_session_version = $2
           AND revoked_at IS NULL AND expires_at > $3::timestamp`,
        [ownerId, owner.sessionVersion, timestampParameter(createdAt)],
      );
      if (!active.rows[0]) throw new TokenOperationError();
      // Return a safe result through the driver boundary, not a sensitive cause.
      if (active.rows[0].count >= 10) return null;
      const created = await tx.query<TokenMetadataRow>(
        `INSERT INTO ${db.tables.tokens}
           (id, owner_id, name, display_prefix, secret_digest, scopes,
            issued_session_version, created_at, expires_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::varchar[], $7, $8::timestamp, $9::timestamp)
         RETURNING ${metadataColumns}`,
        [
          material.publicId,
          ownerId,
          name,
          material.displayPrefix,
          material.secretDigest,
          scopes,
          owner.sessionVersion,
          timestampParameter(createdAt),
          timestampParameter(expiresAt),
        ],
      );
      const row = created.rows[0];
      if (!row) throw new TokenOperationError();
      await recordNativeAudit(tx, db.tables.audit, actor, {
        action: 'create_personal_token',
        entityType: 'personal_access_token',
        entityIds: [row.id],
        targetOwnerId: ownerId,
        details: { scopes, expiresAt: expiresAt.toISOString() },
      });
      return row;
    });
    if (token === null) throw new TokenLimitError();
    // A just issued token is live by construction: the owner was locked and
    // verified, the lifetime is in the future and the scopes fit the live role.
    return { rawToken: material.rawToken, token: { ...token, status: 'active' } };
  } catch (error) {
    if (error instanceof TokenLimitError) throw error;
    throw new TokenOperationError();
  }
}

export async function listTokens(db: TokenDatabase, ownerId: string): Promise<TokenMetadata[]> {
  try {
    const result = await db.query<TokenMetadata>(
      `SELECT ${metadataColumns}, ${statusColumn(db.tables)} FROM ${db.tables.tokens}
       WHERE owner_id = $1::uuid ORDER BY created_at DESC, id DESC`,
      [ownerId],
    );
    return result.rows;
  } catch {
    throw new TokenOperationError();
  }
}

/**
 * Returns true for a newly revoked own token and for an already revoked own token.
 * Only a real state change writes an audit row, so a repeated request is a no-op.
 */
export async function revokeToken(
  db: TokenDatabase,
  actor: AuditActor,
  id: string,
): Promise<boolean> {
  try {
    return await db.transaction(async (tx) => {
      const result = await tx.query(
        `UPDATE ${db.tables.tokens} SET revoked_at = $3::timestamp
         WHERE id = $1::uuid AND owner_id = $2::uuid AND revoked_at IS NULL`,
        [id, actor.id, timestampParameter(new Date())],
      );
      if (result.rowCount === 1) {
        await recordNativeAudit(tx, db.tables.audit, actor, {
          action: 'revoke_personal_token',
          entityType: 'personal_access_token',
          entityIds: [id],
          targetOwnerId: actor.id,
          details: { bulk: false },
        });
        return true;
      }
      const own = await tx.query(
        `SELECT id FROM ${db.tables.tokens} WHERE id = $1::uuid AND owner_id = $2::uuid`,
        [id, actor.id],
      );
      return own.rows.length === 1;
    });
  } catch {
    throw new TokenOperationError();
  }
}

/**
 * Writes one audit row per token whose state actually changed, keyed by public
 * token ID. Tokens already revoked by a concurrent request are not matched by the
 * guarded UPDATE, so races cannot produce duplicate rows. Zero changes write none.
 */
export async function revokeAllTokens(db: TokenDatabase, actor: AuditActor): Promise<number> {
  try {
    return await db.transaction(async (tx) => {
      const result = await tx.query<{ id: string }>(
        `UPDATE ${db.tables.tokens} SET revoked_at = $2::timestamp
         WHERE owner_id = $1::uuid AND revoked_at IS NULL
         RETURNING id::text AS id`,
        [actor.id, timestampParameter(new Date())],
      );
      if (result.rowCount === null || result.rowCount !== result.rows.length) {
        throw new TokenOperationError();
      }
      if (result.rows.length > 0) {
        await recordNativeAudit(tx, db.tables.audit, actor, {
          action: 'revoke_personal_token',
          entityType: 'personal_access_token',
          entityIds: result.rows.map((row) => row.id),
          targetOwnerId: actor.id,
          details: { bulk: true },
        });
      }
      return result.rows.length;
    });
  } catch {
    throw new TokenOperationError();
  }
}

export async function verifyToken(
  db: TokenDatabase,
  rawToken: string,
): Promise<{
  tokenId: string;
  ownerId: string;
  role: TokenOwnerRole;
  scopes: TokenScope[];
  expiresAt: Date;
} | null> {
  const parsed = parseToken(rawToken);
  if (!parsed) return null;
  try {
    const found = await db.query<{
      id: string;
      ownerId: string;
      secretDigest: string;
      scopes: string[];
      expiresAt: Date;
      revokedAt: Date | null;
      passwordHash: string | null;
      sessionVersion: number;
      issuedSessionVersion: number;
      role: TokenOwnerRole;
    }>(
      `SELECT t.id::text AS id, t.owner_id::text AS "ownerId",
         t.secret_digest AS "secretDigest", t.scopes,
         t.expires_at AT TIME ZONE 'UTC' AS "expiresAt",
         t.revoked_at AT TIME ZONE 'UTC' AS "revokedAt",
         t.issued_session_version AS "issuedSessionVersion",
         u.role::text AS role, u.password_hash AS "passwordHash",
         u.session_version AS "sessionVersion"
       FROM ${db.tables.tokens} t JOIN ${db.tables.users} u ON u.id = t.owner_id
       WHERE t.id = $1::uuid`,
      [parsed.publicId],
    );
    const token = found.rows[0];
    if (!token || !tokenDigestMatches(parsed.secret, token.secretDigest)) return null;
    const checkedAt = new Date(Date.now());
    if (
      token.revokedAt ||
      token.expiresAt.getTime() <= checkedAt.getTime() ||
      !token.passwordHash ||
      token.sessionVersion !== token.issuedSessionVersion
    )
      return null;
    let scopes: TokenScope[];
    try {
      scopes = validateTokenScopes(token.scopes, token.role);
    } catch {
      return null;
    }
    // Recheck mutable validity conditions in the update to reject a concurrent
    // revocation or owner change instead of writing usage for a stale token.
    // Usage is operational metadata: it is deliberately not an audited event.
    const used = await db.query(
      `UPDATE ${db.tables.tokens} t SET last_used_at = $2::timestamp
       WHERE t.id = $1::uuid AND t.revoked_at IS NULL
         AND t.expires_at > (clock_timestamp() AT TIME ZONE 'UTC')
         AND t.issued_session_version = $3
         AND EXISTS (
           SELECT 1 FROM ${db.tables.users} u
           WHERE u.id = t.owner_id AND u.role::text = $4
             AND u.session_version = $3 AND u.password_hash IS NOT NULL
         )`,
      [token.id, timestampParameter(checkedAt), token.issuedSessionVersion, token.role],
    );
    // Even a live SQL predicate can be evaluated before a row-lock wait.
    // Never return authority based only on time captured before database I/O.
    if (used.rowCount !== 1 || token.expiresAt.getTime() <= Date.now()) return null;
    return {
      tokenId: token.id,
      ownerId: token.ownerId,
      role: token.role,
      scopes,
      expiresAt: token.expiresAt,
    };
  } catch {
    throw new TokenOperationError();
  }
}

/**
 * Role and credential version change in one transaction with its audit row, so
 * promotion cannot revive credentials and no invalidation goes unrecorded. The
 * operator is trusted maintenance attribution; no HTTP route can supply it.
 */
export async function changeRoleAndInvalidate(
  db: TokenDatabase,
  ownerId: string,
  role: TokenOwnerRole,
  operator: AuditActor,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const current = await tx.query<{ role: TokenOwnerRole }>(
        `SELECT role::text AS role FROM ${db.tables.users} WHERE id = $1::uuid FOR UPDATE`,
        [ownerId],
      );
      const previous = current.rows[0];
      if (!previous) throw new TokenOperationError();
      const updated = await tx.query<{ sessionVersion: number }>(
        `UPDATE ${db.tables.users} SET role = $2, session_version = session_version + 1
         WHERE id = $1::uuid
         RETURNING session_version AS "sessionVersion"`,
        [ownerId, role],
      );
      const version = updated.rows[0];
      if (updated.rowCount !== 1 || !version) throw new TokenOperationError();
      await recordNativeAudit(tx, db.tables.audit, operator, {
        action: 'change_user_role',
        entityType: 'user',
        entityIds: [ownerId],
        targetOwnerId: ownerId,
        details: {
          fromRole: previous.role,
          toRole: role,
          sessionVersion: version.sessionVersion,
        },
      });
    });
  } catch {
    throw new TokenOperationError();
  }
}
