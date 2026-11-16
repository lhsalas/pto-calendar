import type { PrismaClient } from '@prisma/client';
import { loadEnv } from '../config/env.js';
import { createPrismaClient } from './prismaClient.js';

const env = loadEnv();

declare global {
  var __prisma: PrismaClient | undefined;
}

export const prisma =
  globalThis.__prisma ??
  createPrismaClient(
    env.DATABASE_URL,
    env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  );

if (env.NODE_ENV !== 'production') {
  globalThis.__prisma = prisma;
}
