import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { TOKEN_SCOPES } from '../../src/services/tokens/tokenDomain.js';
import { TOKEN_STATUSES } from '../../src/services/tokens/tokenService.js';

interface MediaType {
  schema?: Record<string, unknown>;
}
interface Operation {
  security?: Record<string, unknown[]>[];
  responses: Record<
    string,
    { headers?: Record<string, { $ref: string }>; content?: Record<string, MediaType> }
  >;
}
const api = parse(readFileSync(new URL('../../../docs/openapi.yaml', import.meta.url), 'utf8')) as {
  security: { cookieAuth: unknown[] }[];
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<
      string,
      {
        additionalProperties?: boolean;
        required?: string[];
        properties: Record<
          string,
          { maximum?: number; maxLength?: number; default?: unknown; enum?: unknown[] }
        >;
        enum?: string[];
      }
    >;
    responses: Record<string, { headers: Record<string, { $ref: string }> }>;
    securitySchemes: Record<string, unknown>;
  };
};

describe('personal token OpenAPI contract', () => {
  it('documents every session-only operation and no-store/correlation success and error headers', () => {
    expect(api.security).toEqual([{ cookieAuth: [] }]);
    expect(Object.keys(api.components.securitySchemes)).toEqual(['cookieAuth', 'personalToken']);
    for (const [path, method, status] of [
      ['/auth/tokens', 'get', '200'],
      ['/auth/tokens', 'post', '201'],
      ['/auth/tokens/{id}', 'delete', '204'],
      ['/auth/tokens/revoke-all', 'post', '204'],
    ]) {
      const operation = api.paths[path!]![method!]!;
      expect(operation.security).toBeUndefined(); // inherits session-only, not global PAT access
      expect(operation.responses[status!]!.headers?.['Cache-Control']?.$ref).toBe(
        '#/components/headers/TokenNoStore',
      );
      expect(operation.responses[status!]!.headers?.['X-Request-Id']?.$ref).toBe(
        '#/components/headers/TokenRequestId',
      );
      expect(operation.responses['401']).toBeDefined();
      expect(operation.responses['429']).toBeDefined();
    }
    expect(api.components.responses.TokenManagementError!.headers['Cache-Control']?.$ref).toBe(
      '#/components/headers/TokenNoStore',
    );
  });

  it('adds bearer alternatives only on the six deliberately scoped operations', () => {
    const eligible = new Set([
      'GET /auth/me',
      'GET /pto',
      'POST /pto',
      'GET /pto/{id}',
      'PUT /pto/{id}',
      'DELETE /pto/{id}',
    ]);
    const actual: string[] = [];
    for (const [path, operations] of Object.entries(api.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (operation.security?.some((entry) => 'personalToken' in entry)) {
          const key = `${method.toUpperCase()} ${path}`;
          expect(eligible.has(key)).toBe(true);
          expect(operation.security).toEqual([{ cookieAuth: [] }, { personalToken: [] }]);
          actual.push(key);
        }
      }
    }
    expect(actual.sort()).toEqual([...eligible].sort());
    const identity = api.components.schemas.PersonalTokenIdentity!;
    expect(identity.additionalProperties).toBe(false);
    expect(Object.keys(identity.properties).sort()).toEqual(['auth', 'id', 'role']);
    expect(identity.required).toEqual(['id', 'role', 'auth']);
  });

  it('bounds issuance and declares the exact vocabulary with no owner/role or recovery fields', () => {
    const issue = api.components.schemas.IssuePersonalTokenRequest!;
    expect(issue.additionalProperties).toBe(false);
    expect(issue.required).toEqual(['name', 'password']);
    expect(Object.keys(issue.properties).sort()).toEqual([
      'expiresInDays',
      'name',
      'password',
      'scopes',
    ]);
    expect(issue.properties.password?.maxLength).toBe(72);
    expect(issue.properties.expiresInDays?.maximum).toBe(365);
    expect(issue.properties.expiresInDays?.default).toBe(90);
    expect(issue.properties.scopes?.default).toEqual(['pto:read']);
    expect(api.components.schemas.PersonalTokenScope!.enum).toEqual(TOKEN_SCOPES);
    expect(api.components.schemas.PersonalTokenMetadata!.additionalProperties).toBe(false);
    for (const key of ['secretDigest', 'rawToken', 'password', 'issuedSessionVersion', 'ownerId']) {
      expect(api.components.schemas.PersonalTokenMetadata!.properties).not.toHaveProperty(key);
    }
  });

  it('publishes the server-computed token status on the list and issuance responses', () => {
    const metadata = api.components.schemas.PersonalTokenMetadata!;
    expect(metadata.required).toEqual([
      'id',
      'name',
      'displayPrefix',
      'scopes',
      'createdAt',
      'expiresAt',
      'lastUsedAt',
      'revokedAt',
      'status',
    ]);
    expect(Object.keys(metadata.properties).sort()).toEqual([
      'createdAt',
      'displayPrefix',
      'expiresAt',
      'id',
      'lastUsedAt',
      'name',
      'revokedAt',
      'scopes',
      'status',
    ]);
    expect(metadata.properties.status?.enum).toEqual([...TOKEN_STATUSES]);
    expect(metadata.properties.status?.enum).toEqual([
      'active',
      'expired',
      'revoked',
      'invalidated',
    ]);
    // The status is required, so every response that returns metadata carries it.
    const list = api.paths['/auth/tokens']!.get!.responses['200']!.content!['application/json']!
      .schema! as { properties: { tokens: { items: { $ref: string } } } };
    expect(list.properties.tokens.items.$ref).toBe('#/components/schemas/PersonalTokenMetadata');
    const issued = api.paths['/auth/tokens']!.post!.responses['201']!.content!['application/json']!
      .schema! as { properties: { token: { $ref: string } } };
    expect(issued.properties.token.$ref).toBe('#/components/schemas/PersonalTokenMetadata');
  });
});
