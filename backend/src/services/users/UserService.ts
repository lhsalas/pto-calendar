import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { User as PrismaUser } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { loadEnv } from '../../config/env.js';
import { HttpError } from '../../middleware/errorHandler.js';
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

export interface SetupAccountResult {
  user: PrismaUser;
}

export async function setupAccount(input: SetupAccountInput): Promise<SetupAccountResult> {
  const env = loadEnv();
  const tokenHash = hashSetupToken(input.token);
  // Look up by hash. Reject users without a setup token (already set up).
  const user = await prisma.user.findFirst({
    where: { setupTokenHash: tokenHash },
  });
  if (!user || !user.setupTokenExpiresAt) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Setup link is invalid or has already been used.');
  }
  if (user.setupTokenExpiresAt.getTime() < Date.now()) {
    // Clean up expired tokens.
    await prisma.user.update({
      where: { id: user.id },
      data: { setupTokenHash: null, setupTokenExpiresAt: null },
    });
    throw new HttpError(401, 'UNAUTHENTICATED', 'Setup link has expired.');
  }
  const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_ROUNDS);
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      setupTokenHash: null,
      setupTokenExpiresAt: null,
    },
  });
  return { user: updated };
}

export async function resetUserPassword(userId: string): Promise<{
  user: PrismaUser;
  setupToken: { plaintext: string; hash: string; expiresAt: Date };
}> {
  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target) {
    throw new HttpError(404, 'NOT_FOUND', 'User not found.');
  }
  const setupToken = generateSetupToken();
  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash: null,
      setupTokenHash: setupToken.hash,
      setupTokenExpiresAt: setupToken.expiresAt,
    },
  });
  return { user: updated, setupToken };
}

async function pickAvailableColor(): Promise<string> {
  const used = new Set(
    (await prisma.user.findMany({ select: { colorCode: true } })).map((u) => u.colorCode),
  );
  return pickColorCode(used);
}
