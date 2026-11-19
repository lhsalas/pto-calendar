import type { Prisma } from '@prisma/client';
import { HttpError } from '../../middleware/errorHandler.js';
import type { SessionUser } from '../../middleware/cookieSession.js';
import type { AuthContext } from '../auth/authContext.js';
import { assertPtoScope } from '../authorization/patPolicy.js';
import {
  validateTokenScopes,
  type TokenOwnerRole,
  type TokenScope,
} from '../tokens/tokenDomain.js';

/**
 * The credential a keyed create is bound to.
 *
 * It carries no raw bearer token, no cookie and no key: only the trusted
 * owner, the kind of credential, its public identifier and a closure that
 * re-checks the live credential inside the service transaction. The closure
 * is frozen, so a caller cannot swap it after the credential was prepared.
 */
export interface PtoReplayCredential {
  ownerId: string;
  kind: 'pat' | 'session';
  credentialId: string;
  recheck(tx: Prisma.TransactionClient): Promise<AuthContext>;
}

interface LockedUser {
  id: string;
  role: TokenOwnerRole;
  sessionVersion: number;
  passwordEstablished: boolean;
}

interface LockedToken {
  id: string;
  ownerId: string;
  scopes: string[];
  expiresAt: Date;
  revokedAt: Date | null;
  issuedSessionVersion: number;
}

const SESSION_NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function unauthorized(): never {
  throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required.');
}

function isRole(value: string): value is TokenOwnerRole {
  return value === 'member' || value === 'team_lead' || value === 'admin';
}

/**
 * The live user row, locked for share so the role and the credential version
 * cannot change between this read and the commit.
 */
async function lockUser(tx: Prisma.TransactionClient, ownerId: string): Promise<LockedUser> {
  const rows = await tx.$queryRaw<LockedUser[]>`
    SELECT id::text AS id, role::text AS role,
           session_version AS "sessionVersion",
           COALESCE(length(password_hash) > 0, false) AS "passwordEstablished"
    FROM "users" WHERE id = ${ownerId}::uuid FOR SHARE
  `;
  const user = rows[0];
  if (!user || !user.passwordEstablished || !isRole(user.role)) unauthorized();
  return user;
}

/** The live token row, locked for share so a concurrent revoke cannot slip in. */
async function lockToken(tx: Prisma.TransactionClient, tokenId: string): Promise<LockedToken> {
  const rows = await tx.$queryRaw<LockedToken[]>`
    SELECT id::text AS id, owner_id::text AS "ownerId", scopes,
           expires_at AT TIME ZONE 'UTC' AS "expiresAt",
           revoked_at AT TIME ZONE 'UTC' AS "revokedAt",
           issued_session_version AS "issuedSessionVersion"
    FROM "personal_access_tokens" WHERE id = ${tokenId}::uuid FOR SHARE
  `;
  const token = rows[0];
  if (!token) unauthorized();
  return token;
}

/** The database clock, read after the rows are locked. */
async function databaseClock(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT pg_catalog.clock_timestamp() AS "now"
  `;
  const clock = rows[0]?.now;
  if (!clock) unauthorized();
  return clock;
}

/**
 * The personal token must still be live: owned by the same account, not
 * revoked, not expired, issued for the current credential version and still
 * holding the create scope. The scope set is validated with the same helper
 * the issuance path uses, so a stored scope set that no longer fits the
 * role is refused instead of trusted.
 */
async function recheckPat(
  tx: Prisma.TransactionClient,
  auth: Extract<AuthContext, { method: 'pat' }>,
): Promise<AuthContext> {
  // The live user first, then the token: the same order the token service
  // uses, so the two cannot deadlock against each other.
  const user = await lockUser(tx, auth.actor.id);
  const token = await lockToken(tx, auth.tokenId);
  const clock = await databaseClock(tx);

  if (token.ownerId !== user.id) unauthorized();
  if (token.revokedAt !== null) unauthorized();
  if (clock.getTime() >= token.expiresAt.getTime()) unauthorized();
  if (user.sessionVersion !== token.issuedSessionVersion) unauthorized();

  let scopes: TokenScope[];
  try {
    scopes = validateTokenScopes(token.scopes, user.role);
  } catch {
    unauthorized();
  }

  const live: AuthContext = {
    method: 'pat',
    actor: { id: user.id, role: user.role },
    requestId: auth.requestId,
    tokenId: token.id,
    scopes,
    expiresAt: token.expiresAt,
  };
  assertPtoScope(live, 'create');
  return live;
}

/**
 * The browser session must still be the same one: the live role is read
 * again and the credential version in the signed session must still match
 * the account. A session that was invalidated in the meantime cannot replay.
 */
async function recheckSession(
  tx: Prisma.TransactionClient,
  auth: Extract<AuthContext, { method: 'session' }>,
  session: SessionUser,
): Promise<AuthContext> {
  const user = await lockUser(tx, auth.actor.id);
  if (user.sessionVersion !== session.sessionVersion) unauthorized();
  return {
    method: 'session',
    actor: { id: user.id, role: user.role },
    requestId: auth.requestId,
  };
}

/**
 * Freezes the credential a keyed create is bound to.
 *
 * A personal token is bound to its public token id. A browser session is
 * bound to the random per-login replay nonce and the verified credential
 * version. A session without the nonce is an older cookie: it may still
 * create without a key, but a keyed request is refused until the user signs
 * in again, because the nonce is what makes the key scope verifiable.
 */
export function preparePtoReplay(
  auth: AuthContext,
  session: SessionUser | undefined,
): PtoReplayCredential {
  if (auth.method === 'pat') {
    const pat = auth;
    return Object.freeze({
      ownerId: pat.actor.id,
      kind: 'pat' as const,
      credentialId: pat.tokenId,
      recheck: (tx: Prisma.TransactionClient) => recheckPat(tx, pat),
    });
  }
  const nonce = session?.replayNonce;
  if (!nonce || !SESSION_NONCE.test(nonce) || session.id !== auth.actor.id) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in again to use an Idempotency-Key.');
  }
  const current = auth;
  const currentSession = session;
  return Object.freeze({
    ownerId: current.actor.id,
    kind: 'session' as const,
    credentialId: nonce,
    recheck: (tx: Prisma.TransactionClient) => recheckSession(tx, current, currentSession),
  });
}
