import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const here = path.dirname(fileURLToPath(import.meta.url));
const SEED_HOLIDAYS_PATH = path.resolve(here, '..', '..', 'prisma', 'seedHolidays.ts');

function runSeedHolidays(
  env: Record<string, string>,
  args: string[] = [],
): { stdout: string; stderr: string; status: number } {
  try {
    const out = execSync(`npx tsx ${SEED_HOLIDAYS_PATH} ${args.map((a) => `"${a}"`).join(' ')}`, {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { stdout: out, stderr: '', status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 };
  }
}

const REQUIRED_DB = {
  DATABASE_URL:
    process.env.DATABASE_URL ?? 'postgresql://pto:pto@localhost:5432/pto_test?schema=public',
};

const prisma = new PrismaClient();

describe('db:seed-holidays script', () => {
  beforeEach(async () => {
    await prisma.holiday.deleteMany({});
  });
  afterEach(async () => {
    await prisma.holiday.deleteMany({});
    await prisma.$disconnect();
  });

  it('exits non-zero when --country is missing', () => {
    const r = runSeedHolidays(REQUIRED_DB);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/--country/);
  });

  it('exits non-zero on an unsupported country', () => {
    const r = runSeedHolidays(REQUIRED_DB, ['--country', 'CA']);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/Unsupported country/);
  });

  it('inserts US holidays', () => {
    const r = runSeedHolidays(REQUIRED_DB, ['--country', 'US']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/inserted=26/);
  });

  it('is idempotent on re-run', () => {
    const r1 = runSeedHolidays(REQUIRED_DB, ['--country', 'US']);
    expect(r1.status).toBe(0);
    const r2 = runSeedHolidays(REQUIRED_DB, ['--country', 'US']);
    expect(r2.status).toBe(0);
    expect(r2.stdout).toMatch(/inserted=0 skipped=26/);
  });

  it('inserts MX holidays', () => {
    const r = runSeedHolidays(REQUIRED_DB, ['--country', 'MX']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/inserted=14/);
  });

  it('inserts CO holidays', () => {
    const r = runSeedHolidays(REQUIRED_DB, ['--country', 'CO']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/inserted=42/);
  });

  it('inserts CL holidays', () => {
    const r = runSeedHolidays(REQUIRED_DB, ['--country', 'CL']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/inserted=37/);
  });

  it('rejects --all combined with --country', () => {
    const r = runSeedHolidays(REQUIRED_DB, ['--all', '--country', 'US']);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/mutually exclusive/);
  });

  it('inserts every supported country via --all', () => {
    const r = runSeedHolidays(REQUIRED_DB, ['--all']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/inserted=26/);
    expect(r.stdout).toMatch(/inserted=14/);
    expect(r.stdout).toMatch(/inserted=42/);
    expect(r.stdout).toMatch(/inserted=37/);
    expect(r.stdout).toMatch(/4 countries, inserted=119/);
  });

  it('--all is idempotent on re-run (skips existing rows)', () => {
    const r1 = runSeedHolidays(REQUIRED_DB, ['--all']);
    expect(r1.status).toBe(0);
    const r2 = runSeedHolidays(REQUIRED_DB, ['--all']);
    expect(r2.status).toBe(0);
    expect(r2.stdout).toMatch(/inserted=0/);
    expect(r2.stdout).toMatch(/skipped=119/);
  });
});
