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

export interface TokenMetadata {
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

interface LockedOwner {
  id: string;
  role: TokenOwnerRole;
  passwordHash: string | null;
  sessionVersion: number;
}

/**
 * verifiedSessionVersion must come from the credential verification that
 * authorized this issuance, not a fresh version read after verification.
 */
export async function issueToken(
  db: TokenDatabase,
  ownerId: string,
  verifiedSessionVersion: number,
  input: { name: unknown; scopes?: unknown; expiresInDays?: unknown },
): Promise<{ rawToken: string; token: TokenMetadata }> {
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
      if (!active.rows[0] || active.rows[0].count >= 10) throw new TokenOperationError();
      const created = await tx.query<TokenMetadata>(
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
      if (!created.rows[0]) throw new TokenOperationError();
      return created.rows[0];
    });
    return { rawToken: material.rawToken, token };
  } catch {
    throw new TokenOperationError();
  }
}

export async function listTokens(db: TokenDatabase, ownerId: string): Promise<TokenMetadata[]> {
  try {
    const result = await db.query<TokenMetadata>(
      `SELECT ${metadataColumns} FROM ${db.tables.tokens}
       WHERE owner_id = $1::uuid ORDER BY created_at DESC, id DESC`,
      [ownerId],
    );
    return result.rows;
  } catch {
    throw new TokenOperationError();
  }
}

export async function revokeToken(
  db: TokenDatabase,
  ownerId: string,
  id: string,
): Promise<boolean> {
  try {
    const result = await db.query(
      `UPDATE ${db.tables.tokens} SET revoked_at = $3::timestamp
       WHERE id = $1::uuid AND owner_id = $2::uuid AND revoked_at IS NULL`,
      [id, ownerId, timestampParameter(new Date())],
    );
    if (result.rowCount === 1) return true;
    const own = await db.query(
      `SELECT id FROM ${db.tables.tokens} WHERE id = $1::uuid AND owner_id = $2::uuid`,
      [id, ownerId],
    );
    return own.rows.length === 1;
  } catch {
    throw new TokenOperationError();
  }
}

export async function revokeAllTokens(db: TokenDatabase, ownerId: string): Promise<number> {
  try {
    const result = await db.query(
      `UPDATE ${db.tables.tokens} SET revoked_at = $2::timestamp
       WHERE owner_id = $1::uuid AND revoked_at IS NULL`,
      [ownerId, timestampParameter(new Date())],
    );
    if (result.rowCount === null) throw new TokenOperationError();
    return result.rowCount;
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

/** Role and credential version change atomically, so promotion cannot revive PATs. */
export async function changeRoleAndInvalidate(
  db: TokenDatabase,
  ownerId: string,
  role: TokenOwnerRole,
): Promise<void> {
  try {
    const result = await db.query(
      `UPDATE ${db.tables.users} SET role = $2, session_version = session_version + 1
       WHERE id = $1::uuid`,
      [ownerId, role],
    );
    if (result.rowCount !== 1) throw new TokenOperationError();
  } catch {
    throw new TokenOperationError();
  }
}
