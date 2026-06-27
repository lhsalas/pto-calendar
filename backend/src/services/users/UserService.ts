import type { User as PrismaUser } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

const PUBLIC_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  colorCode: true,
} as const;

export type ApiUser = Pick<PrismaUser, 'id' | 'name' | 'email' | 'role' | 'colorCode'>;

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
