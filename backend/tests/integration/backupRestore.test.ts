import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { PrismaClient } from '@prisma/client';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const SCHEMA_SANITIZER = join(repoRoot, 'infra/deploy/sql-sanitize-schema.sed');
const DATA_SANITIZER = join(repoRoot, 'infra/deploy/sql-sanitize-data.sed');

const SOURCE_URL =
  process.env.BACKUP_TEST_SOURCE_URL ??
  'postgresql://pto:pto@localhost:5432/pto_test?schema=public';
const TARGET_URL =
  process.env.BACKUP_TEST_TARGET_URL ??
  'postgresql://pto:pto@localhost:5432/pto_restore_test?schema=public';
const LOCAL_CONTAINER = 'pto-calendar-db';
const TARGET_DB = 'pto_restore_test';
const SOURCE_DB = 'pto_test';

const PASSPHRASE = 'correct horse battery staple';

type Runner = 'pg_dump' | 'podman-container' | 'none';

function detectRunner(): Runner {
  for (const candidate of ['pg_dump', '/usr/lib/postgresql/16/bin/pg_dump']) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (probe.status === 0) return 'pg_dump';
  }
  const containerProbe = spawnSync('podman', ['ps', '--format', '{{.Names}}'], {
    encoding: 'utf8',
  });
  if (containerProbe.status === 0 && containerProbe.stdout.split('\n').includes(LOCAL_CONTAINER)) {
    return 'podman-container';
  }
  return 'none';
}

function resolveTool(tool: string): string {
  if (tool !== 'pg_dump' && tool !== 'psql') return tool;
  const candidates =
    tool === 'pg_dump'
      ? ['pg_dump', '/usr/lib/postgresql/16/bin/pg_dump']
      : ['psql', '/usr/lib/postgresql/16/bin/psql'];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (probe.status === 0) return candidate;
  }
  return tool;
}

function runPgSql(sqlArgs: string[], input?: string): string {
  const runner = detectRunner();
  if (runner === 'none') {
    throw new Error('no pg_dump / podman runner available');
  }
  const tool = sqlArgs[0];
  if (!tool) {
    throw new Error('sqlArgs must include a tool name');
  }
  const subArgs = sqlArgs.slice(1);
  const resolvedTool = runner === 'pg_dump' ? resolveTool(tool) : tool;
  const fullArgs =
    runner === 'pg_dump'
      ? subArgs
      : ['exec', '-i', '-e', `PGPASSWORD=pto`, LOCAL_CONTAINER, resolvedTool, ...subArgs];
  const cmd = runner === 'pg_dump' ? resolvedTool : 'podman';
  const env = runner === 'pg_dump' ? { PGPASSWORD: 'pto' } : undefined;
  const result = spawnSync(cmd, fullArgs, {
    encoding: 'utf8',
    input,
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${resolvedTool} failed (status=${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function runSql(sql: string): void {
  runPgSql(
    [
      'psql',
      '-h',
      'localhost',
      '-p',
      '5432',
      '-U',
      'pto',
      '-d',
      TARGET_DB,
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
    ],
    sql,
  );
}

// A dump taken from another database can reference roles and settings the
// target does not have. The rules are shared with the production OCI restore
// (infra/deploy/restore-oci.sh) so the two cannot drift apart.
function sanitizeSql(sourcePath: string, sanitizerPath: string): string {
  expect(existsSync(sanitizerPath)).toBe(true);
  const result = spawnSync('sed', ['-E', '-f', sanitizerPath, sourcePath], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `sed -E -f ${sanitizerPath} failed (status=${result.status}): ${result.stderr}`,
    );
  }
  expect(result.stdout.length).toBeGreaterThan(0);
  return result.stdout;
}

function resetTarget(): void {
  try {
    runPgSql([
      'psql',
      '-h',
      'localhost',
      '-p',
      '5432',
      '-U',
      'pto',
      '-d',
      TARGET_DB,
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'DROP SCHEMA public CASCADE;',
    ]);
  } catch {
    // ignore — the schema didn't exist, which is exactly what we wanted
  }
}

function dumpSchema(): string {
  return runPgSql([
    'pg_dump',
    '-h',
    'localhost',
    '-p',
    '5432',
    '-U',
    'pto',
    '--schema-only',
    '--no-owner',
    '--schema=public',
    '--dbname',
    SOURCE_DB,
  ]);
}

function dumpData(): string {
  return runPgSql([
    'pg_dump',
    '-h',
    'localhost',
    '-p',
    '5432',
    '-U',
    'pto',
    '--data-only',
    '--no-owner',
    '--schema=public',
    '--dbname',
    SOURCE_DB,
  ]);
}

function ensureTargetDatabase(): void {
  try {
    runPgSql([
      'psql',
      '-h',
      'localhost',
      '-p',
      '5432',
      '-U',
      'pto',
      '-d',
      TARGET_DB,
      '-c',
      'SELECT 1',
    ]);
    return;
  } catch {
    // fall through and create
  }
  try {
    runPgSql([
      'psql',
      '-h',
      'localhost',
      '-p',
      '5432',
      '-U',
      'pto',
      '-d',
      'postgres',
      '-c',
      `CREATE DATABASE ${TARGET_DB};`,
    ]);
  } catch {
    // race-safe: ignore "database already exists" if another process raced us.
  }
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
const runner = detectRunner();
const testOrSkip = runner === 'none' ? it.skip : it;

// The roundtrip needs rows in every table it compares. It creates its own
// fixture rather than relying on another spec file having written to the
// shared source database first: Vitest orders spec files by size, so a
// dependency on another file's side effect would make this test fail
// whenever a file grows.
const FIXTURE_EMAIL = `backup-restore-${process.pid}@example.test`;

async function createSourceFixture(): Promise<void> {
  const client = new PrismaClient({ datasources: { db: { url: SOURCE_URL } } });
  try {
    const user = await client.user.create({
      data: {
        name: 'Backup Restore Fixture',
        email: FIXTURE_EMAIL,
        role: 'member',
        colorCode: '#123456',
        passwordHash: null,
      },
    });
    const pto = await client.pTORequest.create({
      data: {
        userId: user.id,
        startDate: new Date('2024-01-08T00:00:00.000Z'),
        endDate: new Date('2024-01-08T00:00:00.000Z'),
        dayPart: 'all_day',
        note: 'backup restore fixture',
      },
    });
    await client.auditLog.create({
      data: {
        actorUserId: user.id,
        action: 'create_pto',
        entityType: 'pto_request',
        entityId: pto.id,
        details: { fixture: true },
      },
    });
  } finally {
    await client.$disconnect();
  }
}

async function removeSourceFixture(): Promise<void> {
  const client = new PrismaClient({ datasources: { db: { url: SOURCE_URL } } });
  try {
    await client.auditLog.deleteMany({ where: { actor: { email: FIXTURE_EMAIL } } });
    await client.user.deleteMany({ where: { email: FIXTURE_EMAIL } });
  } finally {
    await client.$disconnect();
  }
}

describe('database backup → restore roundtrip', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pto-backup-restore-'));

  beforeAll(async () => {
    if (runner === 'none') return;
    ensureTargetDatabase();
    resetTarget();
    expect(existsSync(workdir)).toBe(true);
    await createSourceFixture();
    const userCount = await selectCount(SOURCE_URL, 'users');
    expect(userCount).toBeGreaterThan(0);
  });

  afterAll(async () => {
    rmSync(workdir, { recursive: true, force: true });
    await removeSourceFixture();
    await sourcePrisma.$disconnect();
  });

  testOrSkip(
    'dumps, encrypts, decrypts, and restores users + PTOs',
    async () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15) + 'Z';
      const archiveBase = `pto-${stamp}-roundtrip`;
      const schemaPath = join(workdir, 'schema.sql');
      const dataPath = join(workdir, 'data.sql');
      const archivePath = join(workdir, `${archiveBase}.tar.gz`);
      const encryptedPath = `${archivePath}.gpg`;
      const checksumPath = `${encryptedPath}.sha256`;
      const decryptedPath = join(workdir, `${archiveBase}.decrypted.tar.gz`);

      writeFileSync(schemaPath, dumpSchema());
      writeFileSync(dataPath, dumpData());
      expect(readFileSync(schemaPath).length).toBeGreaterThan(0);
      expect(readFileSync(dataPath).length).toBeGreaterThan(0);

      execFileSync('tar', ['-C', workdir, '-czf', archivePath, 'schema.sql', 'data.sql'], {
        stdio: 'pipe',
      });
      expect(existsSync(archivePath)).toBe(true);

      encrypt(archivePath, encryptedPath, PASSPHRASE);
      expect(readFileSync(encryptedPath).length).toBeGreaterThan(0);

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
      // The dumps are sanitized with the same rules the production OCI
      // restore uses, so a dump taken by a newer pg_dump client (which emits
      // PostgreSQL 17-only settings) still applies to a PostgreSQL 16 target.
      resetTarget();
      runSql(sanitizeSql(restoredSchema, SCHEMA_SANITIZER));
      runSql(sanitizeSql(restoredData, DATA_SANITIZER));

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
    },
    120_000,
  );

  it('strips target-incompatible statements from a dump taken by a newer client', () => {
    const source = [
      'SET transaction_timeout = 0;',
      'SET ROLE source_admin;',
      'ALTER TABLE public.users OWNER TO source_admin;',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO source_admin;',
      'GRANT ALL ON TABLE public.users TO source_admin;',
      'REVOKE ALL ON TABLE public.users FROM source_admin;',
      'CREATE TABLE public.sanitizer_probe (id integer);',
    ].join('\n');

    const schemaPath = join(tmpdir(), `pto-sanitize-schema-${process.pid}.sql`);
    writeFileSync(schemaPath, source);
    const sanitized = sanitizeSql(schemaPath, SCHEMA_SANITIZER);
    rmSync(schemaPath, { force: true });

    expect(sanitized).not.toContain('transaction_timeout');
    expect(sanitized).not.toContain('SET ROLE');
    expect(sanitized).not.toContain('OWNER TO');
    expect(sanitized).not.toContain('ALTER DEFAULT PRIVILEGES');
    expect(sanitized).not.toContain('GRANT');
    expect(sanitized).not.toContain('REVOKE');
    expect(sanitized).toContain('CREATE TABLE public.sanitizer_probe');

    const dataSource = ['SET transaction_timeout = 0;', 'SELECT 1;'].join('\n');
    const dataPath = join(tmpdir(), `pto-sanitize-data-${process.pid}.sql`);
    writeFileSync(dataPath, dataSource);
    const sanitizedData = sanitizeSql(dataPath, DATA_SANITIZER);
    rmSync(dataPath, { force: true });

    expect(sanitizedData).not.toContain('transaction_timeout');
    expect(sanitizedData).toContain('SELECT 1;');
  });
});
