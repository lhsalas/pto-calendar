import { ApiError, apiRequest } from './client';
import type {
  IssueTokenRequest,
  IssueTokenResponse,
  TokenListResponse,
  TokenMetadata,
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

function unexpectedTokenResponse(): ApiError {
  return new ApiError(0, {
    code: 'BAD_RESPONSE',
    message: 'The server returned an invalid token response.',
  });
}

export async function listTokens(signal?: AbortSignal): Promise<TokenMetadata[]> {
  const response = await apiRequest<TokenListResponse>('/auth/tokens', {
    ...CREDENTIAL_REQUEST,
    signal,
  });
  // A missing list is not an authoritative empty list: it must never clear
  // the retry guard after an issuance whose outcome is unknown.
  if (!Array.isArray(response?.tokens)) throw unexpectedTokenResponse();
  return response.tokens;
}

export async function issueToken(
  payload: IssueTokenRequest,
  signal?: AbortSignal,
): Promise<IssueTokenResponse> {
  const response = await apiRequest<IssueTokenResponse>('/auth/tokens', {
    method: 'POST',
    body: payload,
    ...CREDENTIAL_REQUEST,
    // Issuance is the one credential call that gets a real deadline: the
    // request is aborted when the timeout fires and the deadline covers the
    // response body, so a stalled answer can never deliver a late secret.
    deadline: true,
    signal,
  });
  if (
    typeof response?.rawToken !== 'string' ||
    !REVEAL_SHAPE.test(response.rawToken) ||
    typeof response.token?.id !== 'string' ||
    !Array.isArray(response.token.scopes)
  ) {
    throw unexpectedTokenResponse();
  }
  return response;
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
