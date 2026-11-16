import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * The adapter creates and owns its pg pool. Prisma's $disconnect disposes it;
 * callers must not separately end a borrowed pool.
 */
export function createPrismaClient(
  connectionString: string,
  log: ('warn' | 'error')[] = ['error'],
): PrismaClient {
  const schema = new URL(connectionString).searchParams.get('schema') ?? 'public';
  const adapter = new PrismaPg({ connectionString }, { schema });
  return new PrismaClient({ adapter, log });
}
