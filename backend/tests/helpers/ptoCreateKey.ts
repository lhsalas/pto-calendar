import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';

/** A new synthetic key; retries in a test must reuse the original value. */
export function ptoCreateKey(issuedAt = Date.now()): string {
  return `v1.${issuedAt}.${randomUUID()}`;
}

export async function clearFixtureCreateKeys(
  db: Prisma.TransactionClient,
  ownerIds: readonly string[],
) {
  for (const ownerId of ownerIds) {
    await db.$executeRaw`DELETE FROM public.pto_create_replays WHERE owner_id=${ownerId}::uuid`;
  }
}
