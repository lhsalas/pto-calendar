import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { User as PrismaUser } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { loadEnv } from '../../config/env.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { auditEntryFor, record as recordAudit } from '../audit/AuditLogService.js';
import { setupTokenActor, type AuditActor } from '../audit/auditContext.js';
import { pickColorCode } from './palette.js';

const PUBLIC_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  colorCode: true,
} as const;

export type ApiUser = Pick<PrismaUser, 'id' | 'name' | 'email' | 'role' | 'colorCode'>;

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;

export const PasswordSchema = z
  .string()
  .min(PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters`)
  .max(PASSWORD_MAX, `Password must be at most ${PASSWORD_MAX} characters`);

export const CreateUserSchema = z.object({
  email: z.string().email().max(254),
  name: z.string().min(1).max(120),
});

export const SetupAccountSchema = z.object({
  token: z.string().min(32).max(128),
  password: PasswordSchema,
});

export const ResetPasswordSchema = z.object({
  // Empty schema — the route only needs the user id from the URL.
});

/**
 * One-time setup token for password setup. Returns the plaintext token
 * (to share with the user) and the sha256 hash + expiry (to persist).
 * Token format: 32 random bytes hex-encoded = 64 chars.
 */
export function generateSetupToken(): {
  plaintext: string;
  hash: string;
  expiresAt: Date;
} {
  const env = loadEnv();
  const plaintext = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(plaintext).digest('hex');
  const expiresAt = new Date(Date.now() + env.SETUP_TOKEN_TTL_MS);
  return { plaintext, hash, expiresAt };
}

export function hashSetupToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export async function getUserById(id: string): Promise<ApiUser | null> {
  return prisma.user.findUnique({
    where: { id },
    select: PUBLIC_USER_SELECT,
  });
}

export async function getUserByEmail(email: string): Promise<ApiUser | null> {
  return prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: PUBLIC_USER_SELECT,
  });
}

export async function getUserWithCredentialsByEmail(email: string): Promise<PrismaUser | null> {
  return prisma.user.findUnique({ where: { email: email.toLowerCase() } });
}

export interface CreateUserInput {
  email: string;
  name: string;
  password?: string;
  role: 'member' | 'team_lead' | 'admin';
  colorCode?: string;
  setupToken?: { hash: string; expiresAt: Date };
}

export async function createUser(input: CreateUserInput): Promise<PrismaUser> {
  const email = input.email.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new HttpError(409, 'CONFLICT', 'A user with that email already exists.');
  }

  const colorCode = input.colorCode ?? (await pickAvailableColor());
  const passwordHash = input.password ? await bcrypt.hash(input.password, 10) : null;

  return prisma.user.create({
    data: {
      email,
      name: input.name,
      role: input.role,
      colorCode,
      passwordHash,
      ...(input.setupToken
        ? { setupTokenHash: input.setupToken.hash, setupTokenExpiresAt: input.setupToken.expiresAt }
        : {}),
    },
  });
}

export interface SetupAccountInput {
  token: string;
  password: string;
}

export interface SetupAccountContext {
  /** Correlation ID from the verified request pipeline; the caller is not authenticated. */
  requestId: string | null;
}

export interface SetupAccountResult {
  user: PrismaUser;
}

/**
 * The setup claim, the credential-version increment and its audit row share one
 * transaction. The audited actor is the user row claimed from the database, not
 * anything the public caller supplied; expired and rejected claims record nothing.
 */
export async function setupAccount(
  input: SetupAccountInput,
  context: SetupAccountContext,
): Promise<SetupAccountResult> {
  const env = loadEnv();
  const tokenHash = hashSetupToken(input.token);
  const claim = await prisma.$transaction(async (tx) => {
    // Read the candidate inside the transaction, then claim it with a
    // conditional update so concurrent redemptions cannot both succeed.
    const user = await tx.user.findFirst({ where: { setupTokenHash: tokenHash } });
    if (!user || !user.setupTokenExpiresAt) {
      throw new HttpError(
        401,
        'UNAUTHENTICATED',
        'Setup link is invalid or has already been used.',
      );
    }
    const now = new Date();
    if (user.setupTokenExpiresAt.getTime() < now.getTime()) {
      await tx.user.updateMany({
        where: { id: user.id, setupTokenHash: tokenHash },
        data: { setupTokenHash: null, setupTokenExpiresAt: null },
      });
      return { status: 'expired' as const };
    }
    const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_ROUNDS);
    const claimed = await tx.user.updateMany({
      where: {
        id: user.id,
        setupTokenHash: tokenHash,
        setupTokenExpiresAt: { gt: now },
      },
      data: {
        passwordHash,
        setupTokenHash: null,
        setupTokenExpiresAt: null,
        sessionVersion: { increment: 1 },
      },
    });
    if (claimed.count !== 1) {
      throw new HttpError(
        401,
        'UNAUTHENTICATED',
        'Setup link is invalid or has already been used.',
      );
    }
    const updated = await tx.user.findUnique({ where: { id: user.id } });
    if (!updated) {
      // Roll back the claim: a success must never be committed without a response.
      throw new HttpError(
        401,
        'UNAUTHENTICATED',
        'Setup link is invalid or has already been used.',
      );
    }
    await recordAudit(
      auditEntryFor(setupTokenActor(user.id, context.requestId), {
        action: 'complete_account_setup',
        entityType: 'user',
        entityId: user.id,
        targetOwnerId: user.id,
        details: { sessionVersion: updated.sessionVersion },
      }),
      tx,
    );
    return { status: 'claimed' as const, user: updated };
  });
  if (claim.status === 'expired') {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Setup link has expired.');
  }
  return { user: claim.user };
}

/**
 * Clears the password, issues a fresh setup token and increments the credential
 * version. The target check, mutation and audit row run in one transaction.
 */
export async function resetUserPassword(
  userId: string,
  actor: AuditActor,
): Promise<{
  user: PrismaUser;
  setupToken: { plaintext: string; hash: string; expiresAt: Date };
}> {
  return prisma.$transaction(async (tx) => {
    const target = await tx.user.findUnique({ where: { id: userId } });
    if (!target) {
      throw new HttpError(404, 'NOT_FOUND', 'User not found.');
    }
    const setupToken = generateSetupToken();
    const updated = await tx.user.update({
      where: { id: userId },
      data: {
        passwordHash: null,
        setupTokenHash: setupToken.hash,
        setupTokenExpiresAt: setupToken.expiresAt,
        sessionVersion: { increment: 1 },
      },
    });
    await recordAudit(
      auditEntryFor(actor, {
        action: 'reset_user_password',
        entityType: 'user',
        entityId: userId,
        targetOwnerId: userId,
        details: { email: target.email, sessionVersion: updated.sessionVersion },
      }),
      tx,
    );
    return { user: updated, setupToken };
  });
}

async function pickAvailableColor(): Promise<string> {
  const used = new Set(
    (await prisma.user.findMany({ select: { colorCode: true } })).map((u) => u.colorCode),
  );
  return pickColorCode(used);
}
