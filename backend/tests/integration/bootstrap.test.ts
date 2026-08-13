import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_PATH = path.resolve(here, '..', '..', 'prisma', 'bootstrap.ts');

function runBootstrap(
  env: Record<string, string>,
  args: string[] = [],
): {
  stdout: string;
  stderr: string;
  status: number;
} {
  try {
    const out = execSync(`npx tsx ${BOOTSTRAP_PATH} ${args.map((a) => `"${a}"`).join(' ')}`, {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { stdout: out, stderr: '', status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      status: e.status ?? 1,
    };
  }
}

const REQUIRED_DB = {
  DATABASE_URL:
    process.env.DATABASE_URL ?? 'postgresql://pto:pto@localhost:5432/pto_test?schema=public',
};

const SEED_EMAILS = ['lead@example.com', 'dev1@example.com', 'dev2@example.com'];

async function setLeadPassword(email: string, hash: string): Promise<void> {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    await prisma.user.update({
      where: { email },
      data: { passwordHash: hash },
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function deleteLead(email: string): Promise<void> {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    await prisma.user.deleteMany({ where: { email: { notIn: SEED_EMAILS } } });
    void email;
  } finally {
    await prisma.$disconnect();
  }
}

describe('db:bootstrap script', () => {
  beforeEach(() => {
    // No fake timers needed; the script uses real Date.now().
  });
  afterEach(async () => {
    await deleteLead('bootstrap@example.com');
  });

  it('exits non-zero when LEAD_EMAIL is missing', () => {
    const r = runBootstrap({ ...REQUIRED_DB, LEAD_EMAIL: '' });
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/LEAD_EMAIL/);
  });

  it('prints the setup link when creating a fresh lead', () => {
    const r = runBootstrap({
      ...REQUIRED_DB,
      LEAD_EMAIL: 'bootstrap@example.com',
      LEAD_NAME: 'Bootstrap Lead',
      APP_PUBLIC_BASE_URL: 'https://pto.example.com',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Created team lead bootstrap@example.com/);
    expect(r.stdout).toMatch(/https:\/\/pto\.example\.com\/setup-account#token=[a-f0-9]{64}/);
  });

  it('overrides the base URL with --base-url', () => {
    const r = runBootstrap(
      {
        ...REQUIRED_DB,
        LEAD_EMAIL: 'bootstrap@example.com',
        LEAD_NAME: 'Bootstrap Lead',
        APP_PUBLIC_BASE_URL: 'https://wrong.example.com',
      },
      ['--base-url', 'https://override.example.com'],
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/https:\/\/override\.example\.com\/setup-account/);
    expect(r.stdout).not.toMatch(/https:\/\/wrong\.example\.com/);
  });

  it('is a no-op when the lead already has a password (idempotent)', async () => {
    // First call creates the lead.
    const r1 = runBootstrap({
      ...REQUIRED_DB,
      LEAD_EMAIL: 'bootstrap@example.com',
      LEAD_NAME: 'Bootstrap Lead',
      APP_PUBLIC_BASE_URL: 'https://pto.example.com',
    });
    expect(r1.status).toBe(0);
    expect(r1.stdout).toMatch(/Created team lead/);

    // Mark the lead as set up.
    await setLeadPassword('bootstrap@example.com', 'placeholder-hash');

    // Second call should be a no-op.
    const r2 = runBootstrap({
      ...REQUIRED_DB,
      LEAD_EMAIL: 'bootstrap@example.com',
      LEAD_NAME: 'Bootstrap Lead',
    });
    expect(r2.status).toBe(0);
    expect(r2.stdout).toMatch(/already set up/);
    expect(r2.stdout).not.toMatch(/Created team lead/);
  });

  it('regenerates the token when the lead exists with no password', () => {
    // First call creates the lead with a fresh token.
    const r1 = runBootstrap({
      ...REQUIRED_DB,
      LEAD_EMAIL: 'bootstrap@example.com',
      LEAD_NAME: 'Bootstrap Lead',
      APP_PUBLIC_BASE_URL: 'https://pto.example.com',
    });
    expect(r1.status).toBe(0);
    const firstTokenMatch = r1.stdout.match(/token=([a-f0-9]{64})/);
    expect(firstTokenMatch).not.toBeNull();
    const firstToken = firstTokenMatch![1]!;

    // Second call (lead still has no password) should regenerate.
    const r2 = runBootstrap({
      ...REQUIRED_DB,
      LEAD_EMAIL: 'bootstrap@example.com',
      LEAD_NAME: 'Bootstrap Lead',
      APP_PUBLIC_BASE_URL: 'https://pto.example.com',
    });
    expect(r2.status).toBe(0);
    expect(r2.stdout).toMatch(/fresh setup token/);
    const secondTokenMatch = r2.stdout.match(/token=([a-f0-9]{64})/);
    expect(secondTokenMatch).not.toBeNull();
    const secondToken = secondTokenMatch![1]!;
    expect(secondToken).not.toBe(firstToken);
  });
});
