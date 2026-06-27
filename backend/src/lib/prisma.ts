import { PrismaClient } from '@prisma/client';
import { loadEnv } from '../config/env.js';

const env = loadEnv();

declare global {
  var __prisma: PrismaClient | undefined;
}

export const prisma =
  globalThis.__prisma ??
  new PrismaClient({
    datasources: { db: { url: env.DATABASE_URL } },
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (env.NODE_ENV !== 'production') {
  globalThis.__prisma = prisma;
}
