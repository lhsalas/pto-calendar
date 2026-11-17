import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { validateTokenName, validateTokenScopes, type TokenOwnerRole } from './tokenDomain.js';

const IssueSchema = z.strictObject({
  name: z.string(),
  password: z.string().min(1).max(72),
  scopes: z.array(z.string()).max(7).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});
export const TokenIdSchema = z.uuid();
const EmptySchema = z.strictObject({});

export function parseTokenIssue(input: unknown) {
  const value = IssueSchema.parse(input);
  return {
    ...value,
    name: validateTokenName(value.name),
    // Validate vocabulary/dependencies before applying the freshly read role.
    scopes: validateTokenScopes(value.scopes, 'admin'),
  };
}

export function parseTokenQuery(input: unknown): void {
  EmptySchema.parse(input);
}

export function parseTokenEmptyBody(input: unknown): void {
  EmptySchema.optional().parse(input);
}

interface VerifiedTokenOwner {
  id: string;
  role: TokenOwnerRole;
  sessionVersion: number;
}

/** Passwords are verified by session-derived ID; never mint for a newer version. */
export async function verifyTokenIssuancePassword(
  ownerId: string,
  verifiedSessionVersion: number,
  password: string,
): Promise<VerifiedTokenOwner> {
  let owner;
  try {
    owner = await prisma.user.findUnique({
      where: { id: ownerId },
      select: { id: true, role: true, sessionVersion: true, passwordHash: true },
    });
  } catch {
    throw new HttpError(500, 'INTERNAL_ERROR', 'Unable to verify current credentials.');
  }
  if (!owner || !owner.passwordHash || owner.sessionVersion !== verifiedSessionVersion) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Current credentials are not valid.');
  }
  let matches: boolean;
  try {
    matches = await bcrypt.compare(password, owner.passwordHash);
  } catch {
    // bcrypt/driver errors must not carry submitted passwords or hashes outward.
    throw new HttpError(500, 'INTERNAL_ERROR', 'Unable to verify current credentials.');
  }
  if (!matches) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Current credentials are not valid.');
  }
  return { id: owner.id, role: owner.role, sessionVersion: owner.sessionVersion };
}
