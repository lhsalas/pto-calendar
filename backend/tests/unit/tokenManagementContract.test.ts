import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { TOKEN_SCOPES } from '../../src/services/tokens/tokenDomain.js';

interface Operation {
  responses: Record<string, { headers?: Record<string, { $ref: string }> }>;
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
    expect(Object.keys(api.components.securitySchemes)).toEqual(['cookieAuth']);
    for (const [path, method, status] of [
      ['/auth/tokens', 'get', '200'],
      ['/auth/tokens', 'post', '201'],
      ['/auth/tokens/{id}', 'delete', '204'],
      ['/auth/tokens/revoke-all', 'post', '204'],
    ]) {
      const operation = api.paths[path!]![method!]!;
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
});
