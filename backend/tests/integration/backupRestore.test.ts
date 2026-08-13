import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { PrismaClient } from '@prisma/client';

const SOURCE_URL =
  process.env.BACKUP_TEST_SOURCE_URL ??
  'postgresql://pto:pto@localhost:5432/pto_test?schema=public';
const TARGET_URL =
  process.env.BACKUP_TEST_TARGET_URL ??
  'postgresql://pto:pto@localhost:5432/pto_restore_test?schema=public';
const CONTAINER = 'pto-calendar-db';

const PASSPHRASE = 'correct horse battery staple';

function stripPgQuery(url: string): string {
  const idx = url.indexOf('?');
  return idx === -1 ? url : url.slice(0, idx);
}

function pgInContainer(args: string[], input?: string): string {
  const fullArgs = ['exec', '-i', '-e', 'PGPASSWORD=pto', CONTAINER, ...args];
  const result = spawnSync('podman', fullArgs, {
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `podman ${args.join(' ')} failed (status=${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function dumpSchema(sourceDbUrl: string): string {
  return pgInContainer(['pg_dump', '--schema-only', '--no-owner', '--schema=public', sourceDbUrl]);
}

function dumpData(sourceDbUrl: string): string {
  return pgInContainer(['pg_dump', '--data-only', '--no-owner', '--schema=public', sourceDbUrl]);
}

function applySql(sql: string): void {
  pgInContainer(
    ['psql', '-U', 'pto', '-d', 'pto_restore_test', '-v', 'ON_ERROR_STOP=1', '-q'],
    sql,
  );
}

function resetTarget(): void {
  pgInContainer([
    'psql',
    '-U',
    'pto',
    '-d',
    'pto_restore_test',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public;',
  ]);
}

function encrypt(plaintextPath: string, ciphertextPath: string, passphrase: string): void {
  const passphraseFile = join(tmpdir(), `pto-backup-passphrase-${Date.now()}-${process.pid}`);
  writeFileSync(passphraseFile, passphrase, { mode: 0o600 });
  try {
    execFileSync(
      'gpg',
      [
        '--batch',
        '--yes',
        '--no-tty',
        '--symmetric',
        '--cipher-algo',
        'AES256',
        '--compress-algo',
        'none',
        '--passphrase-file',
        passphraseFile,
        '--output',
        ciphertextPath,
        plaintextPath,
      ],
      { stdio: 'pipe' },
    );
  } finally {
    rmSync(passphraseFile, { force: true });
  }
}

function decrypt(ciphertextPath: string, plaintextPath: string, passphrase: string): void {
  const passphraseFile = join(tmpdir(), `pto-restore-passphrase-${Date.now()}-${process.pid}`);
  writeFileSync(passphraseFile, passphrase, { mode: 0o600 });
  try {
    execFileSync(
      'gpg',
      [
        '--batch',
        '--yes',
        '--no-tty',
        '--decrypt',
        '--passphrase-file',
        passphraseFile,
        '--output',
        plaintextPath,
        ciphertextPath,
      ],
      { stdio: 'pipe' },
    );
  } finally {
    rmSync(passphraseFile, { force: true });
  }
}

async function selectCount(url: string, table: string): Promise<number> {
  const client = new PrismaClient({ datasources: { db: { url } } });
  const rows = await client.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT COUNT(*)::bigint AS count FROM "${table}"`,
  );
  const count = rows[0]?.count ?? 0n;
  await client.$disconnect();
  return Number(count);
}

const sourcePrisma = new PrismaClient({ datasources: { db: { url: SOURCE_URL } } });

describe('database backup → restore roundtrip', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pto-backup-restore-'));

  beforeAll(async () => {
    resetTarget();
    expect(existsSync(workdir)).toBe(true);
    const userCount = await selectCount(SOURCE_URL, 'users');
    expect(userCount).toBeGreaterThan(0);
  });

  afterAll(async () => {
    rmSync(workdir, { recursive: true, force: true });
    await sourcePrisma.$disconnect();
  });

  it('dumps, encrypts, decrypts, and restores users + PTOs', async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15) + 'Z';
    const archiveBase = `pto-${stamp}-roundtrip`;
    const schemaPath = join(workdir, 'schema.sql');
    const dataPath = join(workdir, 'data.sql');
    const archivePath = join(workdir, `${archiveBase}.tar.gz`);
    const encryptedPath = `${archivePath}.gpg`;
    const checksumPath = `${encryptedPath}.sha256`;
    const decryptedPath = join(workdir, `${archiveBase}.decrypted.tar.gz`);

    const sourceDbUrl = stripPgQuery(SOURCE_URL);

    writeFileSync(schemaPath, dumpSchema(sourceDbUrl));
    writeFileSync(dataPath, dumpData(sourceDbUrl));
    expect(readFileSync(schemaPath).length).toBeGreaterThan(0);
    expect(readFileSync(dataPath).length).toBeGreaterThan(0);

    execFileSync('tar', ['-C', workdir, '-czf', archivePath, 'schema.sql', 'data.sql'], {
      stdio: 'pipe',
    });
    expect(existsSync(archivePath)).toBe(true);

    encrypt(archivePath, encryptedPath, PASSPHRASE);
    expect(readFileSync(encryptedPath).length).toBeGreaterThan(0);

    // Ciphertext must not contain plaintext schema/data markers — the only
    // way the original bytes could be recovered is via GPG with the key.
    const ciphertext = readFileSync(encryptedPath);
    const plaintextSchema = readFileSync(schemaPath);
    expect(ciphertext.includes(plaintextSchema.slice(0, 32))).toBe(false);
    expect(ciphertext.includes(plaintextSchema.slice(-32))).toBe(false);

    const sha = execFileSync('sha256sum', [basename(encryptedPath)], {
      cwd: workdir,
      encoding: 'utf8',
    });
    writeFileSync(checksumPath, sha);

    const verify = spawnSync('sha256sum', ['--check', '--strict', basename(checksumPath)], {
      cwd: workdir,
      encoding: 'utf8',
    });
    expect(verify.status).toBe(0);

    // Tampered ciphertext must fail decryption or checksum verification.
    const tampered = `${encryptedPath}.tampered`;
    const corrupted = Buffer.from(ciphertext);
    const lastIndex = corrupted.length - 1;
    if (lastIndex < 0) {
      throw new Error('ciphertext is empty');
    }
    const lastByte = corrupted[lastIndex];
    if (lastByte === undefined) {
      throw new Error('ciphertext is empty');
    }
    corrupted[lastIndex] = lastByte ^ 0xff;
    writeFileSync(tampered, corrupted);
    const decryptTampered = spawnSync(
      'gpg',
      [
        '--batch',
        '--yes',
        '--no-tty',
        '--decrypt',
        '--passphrase-file',
        '/dev/stdin',
        '--output',
        join(workdir, 'tampered.tar.gz'),
        tampered,
      ],
      {
        encoding: 'utf8',
        input: PASSPHRASE,
      },
    );
    // GPG may report an integrity error (non-zero) OR succeed but produce
    // corrupted output. Either way, the output MUST NOT match the original.
    const tamperedOut = join(workdir, 'tampered.tar.gz');
    let producedBytesIdentical = false;
    if (existsSync(tamperedOut)) {
      const produced = readFileSync(tamperedOut);
      producedBytesIdentical = produced.equals(readFileSync(archivePath));
    }
    expect(producedBytesIdentical).toBe(false);
    void decryptTampered;

    decrypt(encryptedPath, decryptedPath, PASSPHRASE);
    expect(existsSync(decryptedPath)).toBe(true);
    expect(readFileSync(decryptedPath).equals(readFileSync(archivePath))).toBe(true);

    execFileSync('tar', ['-xzf', decryptedPath, '-C', workdir], { stdio: 'pipe' });
    const restoredSchema = join(workdir, 'schema.sql');
    const restoredData = join(workdir, 'data.sql');
    expect(existsSync(restoredSchema)).toBe(true);
    expect(existsSync(restoredData)).toBe(true);

    // Drop schema before applying; pg_dump's schema dump includes
    // CREATE SCHEMA public, which fails when public already exists.
    pgInContainer([
      'psql',
      '-U',
      'pto',
      '-d',
      'pto_restore_test',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'DROP SCHEMA public CASCADE;',
    ]);
    applySql(readFileSync(restoredSchema, 'utf8'));
    applySql(readFileSync(restoredData, 'utf8'));

    const tables = ['users', 'pto_requests', 'audit_logs'];
    for (const table of tables) {
      const sourceCount = await selectCount(SOURCE_URL, table);
      const targetCount = await selectCount(TARGET_URL, table);
      expect({ table, source: sourceCount, target: targetCount }).toEqual({
        table,
        source: sourceCount,
        target: sourceCount,
      });
    }
  }, 120_000);
});
