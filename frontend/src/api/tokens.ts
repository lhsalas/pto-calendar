import { ApiError, apiRequest } from './client';
import { TOKEN_SCOPE_VALUES } from '../lib/tokens';
import type {
  IssueTokenRequest,
  IssueTokenResponse,
  TokenMetadata,
  TokenScope,
  TokenStatus,
} from '../types/api';

/**
 * Credential endpoints are session-only and must never be cached by the
 * browser or a proxy, and a redirect must never be followed with the session
 * cookie attached. `no-store` + `error` keeps a raw token out of the HTTP
 * cache and turns a redirect into a failure instead of a silent re-request.
 */
const CREDENTIAL_REQUEST = {
  cache: 'no-store',
  redirect: 'error',
} as const;

const REVEAL_SHAPE = /^pto_pat_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.[0-9a-f]{64}$/;

/** The public id of a token. It is an identifier, never a secret. */
const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An absolute instant: a date and a time with an explicit offset. A local
 * date without an offset is refused, because the browser time zone is not the
 * server's and the value would be read as a different moment.
 */
const ABSOLUTE_DATE_SHAPE =
  /^\d{4}-\d{2}-\d{2}[Tt](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:[Zz]|[+-]\d{2}:\d{2})$/;

/** The states the server can report for an owned token. */
const KNOWN_STATUSES: readonly string[] = ['active', 'expired', 'revoked', 'invalidated'];

/** The server rejects a name that is empty or longer than this. */
const MAX_NAME_CODE_POINTS = 120;

function unexpectedTokenResponse(): ApiError {
  return new ApiError(0, {
    code: 'BAD_RESPONSE',
    message: 'The server returned an invalid token response.',
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isAbsoluteDate(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !ABSOLUTE_DATE_SHAPE.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    return false;
  }
  // Date.parse can normalize an impossible day into the following month.
  // Validate the stated date separately so an offset cannot mask rollover.
  const day = value.slice(0, 10);
  const midnight = new Date(`${day}T00:00:00.000Z`);
  return midnight.toISOString().slice(0, 10) === day;
}

function isNullableDate(value: unknown): value is string | null {
  return value === null || isAbsoluteDate(value);
}

function isScope(value: unknown): value is TokenScope {
  return typeof value === 'string' && (TOKEN_SCOPE_VALUES as readonly string[]).includes(value);
}

/**
 * Decodes one safe token record. Every required field is checked before the
 * record is accepted, and the result is a projection of exactly the known
 * fields, so nothing else from a malformed answer is kept or shown.
 */
function decodeTokenMetadata(value: unknown): TokenMetadata | null {
  if (!isRecord(value)) return null;
  const { id, name, displayPrefix, scopes, createdAt, expiresAt, lastUsedAt, revokedAt, status } =
    value;
  if (typeof id !== 'string' || !ID_SHAPE.test(id)) return null;
  // The prefix is public: it is the marker plus the id and never a secret.
  if (typeof displayPrefix !== 'string' || displayPrefix !== `pto_pat_${id}`) return null;
  if (
    typeof name !== 'string' ||
    name.trim().length === 0 ||
    [...name].length > MAX_NAME_CODE_POINTS
  ) {
    return null;
  }
  if (!isUnknownArray(scopes) || scopes.length === 0) return null;
  if (!scopes.every(isScope)) return null;
  if (!isAbsoluteDate(createdAt) || !isAbsoluteDate(expiresAt)) return null;
  if (!isNullableDate(lastUsedAt) || !isNullableDate(revokedAt)) return null;
  if (typeof status !== 'string' || !KNOWN_STATUSES.includes(status)) return null;
  return {
    id,
    name,
    displayPrefix,
    scopes: [...scopes],
    createdAt,
    expiresAt,
    lastUsedAt,
    revokedAt,
    status: status as TokenStatus,
  };
}

export async function listTokens(signal?: AbortSignal): Promise<TokenMetadata[]> {
  const response = await apiRequest<unknown>('/auth/tokens', {
    ...CREDENTIAL_REQUEST,
    signal,
  });
  // A missing list is not an authoritative empty list: it must never clear
  // the retry guard after an issuance whose outcome is unknown.
  if (!isRecord(response) || !isUnknownArray(response.tokens)) throw unexpectedTokenResponse();
  const tokens: TokenMetadata[] = [];
  for (const member of response.tokens) {
    const token = decodeTokenMetadata(member);
    // A malformed member is not an authoritative list either: the whole
    // answer is refused rather than shown as a partial list.
    if (!token) throw unexpectedTokenResponse();
    tokens.push(token);
  }
  return tokens;
}

export async function issueToken(
  payload: IssueTokenRequest,
  signal?: AbortSignal,
): Promise<IssueTokenResponse> {
  const response = await apiRequest<unknown>('/auth/tokens', {
    method: 'POST',
    body: payload,
    ...CREDENTIAL_REQUEST,
    // Issuance is the one credential call that gets a real deadline: the
    // request is aborted when the timeout fires and the deadline covers the
    // response body, so a stalled answer can never deliver a late secret.
    deadline: true,
    signal,
  });
  if (!isRecord(response)) throw unexpectedTokenResponse();
  const rawToken = response.rawToken;
  if (typeof rawToken !== 'string' || !REVEAL_SHAPE.test(rawToken)) {
    throw unexpectedTokenResponse();
  }
  const token = decodeTokenMetadata(response.token);
  if (!token) throw unexpectedTokenResponse();
  // The revealed secret must belong to this public id; only rawToken (not
  // the projected metadata) may carry the one-time secret.
  if (!rawToken.startsWith(`${token.displayPrefix}.`)) throw unexpectedTokenResponse();
  return { rawToken, token };
}

export async function revokeToken(id: string): Promise<void> {
  await apiRequest<void>(`/auth/tokens/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    ...CREDENTIAL_REQUEST,
  });
}

export async function revokeAllTokens(): Promise<void> {
  await apiRequest<void>('/auth/tokens/revoke-all', {
    method: 'POST',
    ...CREDENTIAL_REQUEST,
  });
}
