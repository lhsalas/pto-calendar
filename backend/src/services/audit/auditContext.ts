import type { AuthContext } from '../auth/authContext.js';
import type { ActorContext } from '../authorization/AuthorizationService.js';
import { isSafeCorrelationId } from '../../lib/requestCorrelation.js';

/**
 * Credential that authorized an audited operation. The vocabulary is closed and
 * mirrored by a database CHECK constraint on audit_logs.credential_type.
 */
export type AuditCredential =
  | { readonly type: 'session' }
  | { readonly type: 'personal_access_token'; readonly tokenId: string }
  | { readonly type: 'setup_token' }
  | { readonly type: 'operator' };

/**
 * Trusted attribution for one operation. It is built only from verified server
 * state: req.auth, a setup row claimed in the same transaction, or explicit
 * trusted operator code. Request bodies, queries, headers and client labels never
 * supply any field here.
 */
export interface AuditActor {
  readonly id: string;
  readonly credential: AuditCredential;
  readonly requestId: string | null;
}

/** Authenticated caller of a protected domain operation: authorization plus attribution. */
export type AttributedActor = ActorContext & AuditActor;

/**
 * Mirrors the correlation-ID rule in lib/requestCorrelation and the database
 * CHECK. An unsafe value is dropped to null instead of failing an otherwise
 * valid change: a personal token, a canonical create key and anything that
 * embeds one are never stored as a correlation ID.
 */
export function safeAuditRequestId(value: string | null): string | null {
  return value !== null && isSafeCorrelationId(value) ? value : null;
}

/** Maps a verified request context to the attribution every protected operation needs. */
export function attributedActorFromAuth(auth: AuthContext): AttributedActor {
  return {
    id: auth.actor.id,
    role: auth.actor.role,
    credential:
      auth.method === 'pat'
        ? { type: 'personal_access_token', tokenId: auth.tokenId }
        : { type: 'session' },
    requestId: safeAuditRequestId(auth.requestId),
  };
}

/**
 * Explicit attribution for trusted server-side maintenance code. No HTTP route
 * accepts or constructs an operator actor, so this adds no admin surface.
 */
export function trustedOperatorActor(operatorUserId: string): AuditActor {
  return { id: operatorUserId, credential: { type: 'operator' }, requestId: null };
}

/**
 * Attribution for a one-time setup claim. The identity is the user row that the
 * server claimed inside the transaction, never a caller-supplied value, so the
 * credential is only ever a setup token and never a session or personal token.
 */
export function setupTokenActor(userId: string, requestId: string | null): AuditActor {
  return {
    id: userId,
    credential: { type: 'setup_token' },
    requestId: safeAuditRequestId(requestId),
  };
}
