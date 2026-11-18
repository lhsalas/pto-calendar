import { apiRequest } from './client';
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

export async function listTokens(signal?: AbortSignal): Promise<TokenMetadata[]> {
  const response = await apiRequest<TokenListResponse>('/auth/tokens', {
    ...CREDENTIAL_REQUEST,
    signal,
  });
  return Array.isArray(response.tokens) ? response.tokens : [];
}

export async function issueToken(
  payload: IssueTokenRequest,
  signal?: AbortSignal,
): Promise<IssueTokenResponse> {
  return apiRequest<IssueTokenResponse>('/auth/tokens', {
    method: 'POST',
    body: payload,
    ...CREDENTIAL_REQUEST,
    signal,
  });
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
