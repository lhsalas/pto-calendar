import 'dotenv/config';
import { Role } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { createPrismaClient } from '../src/lib/prismaClient.js';

const SEED_USERS = [
  {
    name: 'Team Lead',
    email: 'lead@example.com',
    role: Role.team_lead,
    colorCode: '#3B82F6',
    password: 'lead-dev-password',
  },
  {
    name: 'Developer One',
    email: 'dev1@example.com',
    role: Role.member,
    colorCode: '#10B981',
    password: 'dev1-dev-password',
  },
  {
    name: 'Developer Two',
    email: 'dev2@example.com',
    role: Role.member,
    colorCode: '#F59E0B',
    password: 'dev2-dev-password',
  },
];

const DEFAULT_ROUNDS = 10;

export async function runSeed(prisma: PrismaClient): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Development seed is disabled in production; use db:bootstrap instead.');
  }
  const rounds = Number.parseInt(process.env.BCRYPT_ROUNDS ?? String(DEFAULT_ROUNDS), 10);
  for (const u of SEED_USERS) {
    const passwordHash = await bcrypt.hash(u.password, rounds);
    await prisma.user.upsert({
      where: { email: u.email },
      update: { name: u.name, role: u.role, colorCode: u.colorCode, passwordHash },
      create: {
        name: u.name,
        email: u.email,
        role: u.role,
        colorCode: u.colorCode,
        passwordHash,
      },
    });
  }
}

const isCli = process.argv[1]?.endsWith('seed.ts') ?? false;
if (isCli) {
  async function main(): Promise<void> {
    const prisma = createPrismaClient(process.env.DATABASE_URL ?? '');
    try {
      await runSeed(prisma);
      for (const u of SEED_USERS) {
        console.log(`Seeded ${u.role} ${u.email} (password: ${u.password})`);
      }
    } finally {
      await prisma.$disconnect();
    }
  }
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
