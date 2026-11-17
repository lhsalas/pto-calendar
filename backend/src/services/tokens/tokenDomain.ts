import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const TOKEN_SCOPES = [
  'pto:read',
  'pto:notes:read',
  'pto:create',
  'pto:update:self',
  'pto:delete:self',
  'pto:update:team',
  'pto:delete:team',
] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
export type TokenOwnerRole = 'member' | 'team_lead' | 'admin';
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_PATTERN =
  /^pto_pat_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9a-f]{64})(?![\s\S])/;
const DIGEST_PATTERN = /^[0-9a-f]{64}(?![\s\S])/;

export class TokenInputError extends Error {
  constructor() {
    super('Invalid token input');
    this.name = 'TokenInputError';
  }
}

export function validateTokenName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0 ||
    [...value].length > 120
  ) {
    throw new TokenInputError();
  }
  return value;
}

export function validateTokenScopes(value: unknown, role: TokenOwnerRole): TokenScope[] {
  const scopes = value === undefined ? ['pto:read'] : value;
  if (!Array.isArray(scopes) || scopes.length === 0) throw new TokenInputError();
  if (
    scopes.some(
      (scope) => typeof scope !== 'string' || !(TOKEN_SCOPES as readonly string[]).includes(scope),
    )
  ) {
    throw new TokenInputError();
  }
  const selected = new Set(scopes as TokenScope[]);
  if (selected.size !== scopes.length) throw new TokenInputError();
  if (selected.has('pto:notes:read') && !selected.has('pto:read')) throw new TokenInputError();
  if (role === 'member' && (selected.has('pto:update:team') || selected.has('pto:delete:team'))) {
    throw new TokenInputError();
  }
  return TOKEN_SCOPES.filter((scope) => selected.has(scope));
}

export function tokenExpiry(now: Date, days: unknown = 90): Date {
  if (
    !Number.isInteger(days) ||
    typeof days !== 'number' ||
    days < 1 ||
    days > 365 ||
    !Number.isFinite(now.getTime())
  ) {
    throw new TokenInputError();
  }
  const expiresAt = new Date(now.getTime() + days * DAY_MS);
  if (!Number.isFinite(expiresAt.getTime())) throw new TokenInputError();
  return expiresAt;
}

export function createTokenMaterial(): {
  publicId: string;
  displayPrefix: string;
  secretDigest: string;
  rawToken: string;
} {
  const publicId = randomUUID();
  const secret = randomBytes(32).toString('hex');
  const displayPrefix = `pto_pat_${publicId}`;
  return {
    publicId,
    displayPrefix,
    secretDigest: createHash('sha256').update(secret, 'utf8').digest('hex'),
    rawToken: `${displayPrefix}.${secret}`,
  };
}

export function parseToken(raw: string): { publicId: string; secret: string } | null {
  const match = TOKEN_PATTERN.exec(raw);
  if (!match || !match[1] || !match[2]) return null;
  return { publicId: match[1], secret: match[2] };
}

export function tokenDigestMatches(secret: string, digest: string): boolean {
  if (!DIGEST_PATTERN.test(secret) || !DIGEST_PATTERN.test(digest)) return false;
  const computed = createHash('sha256').update(secret, 'utf8').digest();
  return timingSafeEqual(computed, Buffer.from(digest, 'hex'));
}
