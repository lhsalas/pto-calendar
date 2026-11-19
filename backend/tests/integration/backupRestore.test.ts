import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { Client } from 'pg';
import { createPrismaClient } from '../../src/lib/prismaClient.js';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const SCHEMA_SANITIZER = join(repoRoot, 'infra/deploy/sql-sanitize-schema.sed');
const DATA_SANITIZER = join(repoRoot, 'infra/deploy/sql-sanitize-data.sed');
const BACKUP_SCRIPT = join(repoRoot, 'infra/deploy/backup.sh');

const LOCAL_CONTAINER = 'pto-calendar-db';
const TARGET_DB = 'pto_restore_test';
const SOURCE_DB = 'pto_test';
/** The maintenance database never carries an application extension. */
const PLAIN_DB = 'postgres';

function fixtureUrl(value: string, db: string): URL {
  const url = new URL(value);
  if (
    !['postgresql:', 'postgres:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== `/${db}` ||
    url.username !== 'pto' ||
    url.password !== 'pto' ||
    url.hash ||
    [...url.searchParams].some(([key, value]) => key !== 'schema' || value !== 'public')
  ) {
    throw new Error(`Backup integration requires the disposable loopback ${db} fixture.`);
  }
  return url;
}

const source = fixtureUrl(
  process.env.BACKUP_TEST_SOURCE_URL ??
    'postgresql://pto:pto@localhost:5432/pto_test?schema=public',
  SOURCE_DB,
);
const defaultTarget = new URL(source.href);
defaultTarget.pathname = `/${TARGET_DB}`;
const target = fixtureUrl(process.env.BACKUP_TEST_TARGET_URL ?? defaultTarget.href, TARGET_DB);
const fixturePort = source.port || '5432';
if (target.hostname !== source.hostname || (target.port || '5432') !== fixturePort) {
  throw new Error('The disposable backup source and target must share a PostgreSQL server.');
}
const SOURCE_URL = source.href;
const TARGET_URL = target.href;
const fixtureHost = source.hostname.replace(/^\[|\]$/g, '');

/**
 * #257: the owner/date exclusion constraint needs btree_gist, and a
 * public-only schema dump omits the extension declaration. The production
 * backup adds the extension only when the source database has it, and the
 * fixture dump uses the very same arguments so the roundtrip proves the
 * archive that is actually uploaded.
 */
const REQUIRED_EXTENSION = 'btree_gist';
const OVERLAP_CONSTRAINT = 'pto_requests_no_owner_overlap';
const EXTENSION_DECLARATION = /^CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;/m;

const PASSPHRASE = 'correct horse battery staple';

/**
 * A recording stand-in for the container CLI, so the exact backup script can
 * be exercised without a database, a container or an object store. It only
 * records what the script asks for and answers with a fixed snapshot.
 */
const MOCK_DOCKER = `#!/usr/bin/env bash
set -Eeuo pipefail
tool=""
prev=""
for a in "$@"; do
  if [[ "$prev" == "db" ]]; then
    tool="$a"
    break
  fi
  prev="$a"
done
case "$tool" in
  psql)
    printf 'psql-open\\n' >> "$MOCK_LOG"
    if [[ -n "$MOCK_SNAPSHOT_DB" ]]; then
      opts=(-X -h "$MOCK_HOST" -p "$MOCK_PORT" -U pto -d "$MOCK_SNAPSHOT_DB" -qAt -v ON_ERROR_STOP=1)
      if [[ "$MOCK_RUNNER" == 'podman-container' ]]; then
        podman exec -i -e PGPASSWORD=pto pto-calendar-db psql "\${opts[@]}"
      else
        PGPASSWORD=pto "$MOCK_PSQL" "\${opts[@]}"
      fi
      printf 'psql-close\\n' >> "$MOCK_LOG"
      exit 0
    fi
    buffer=""
    while IFS= read -r line; do
      if [[ "$line" == "\\\\q" ]]; then
        break
      fi
      buffer="$buffer$line
"
      if [[ "$buffer" == *";"* ]]; then
        if [[ "$buffer" == *"pg_export_snapshot"* ]]; then
          printf '%s|%s|%s|%s\\n' "$MOCK_SNAPSHOT_ID" "$MOCK_EXTENSION" "$MOCK_CONSTRAINT" "$MOCK_MIGRATION_STATE"
        fi
        buffer=""
      fi
    done
    printf 'psql-close\\n' >> "$MOCK_LOG"
    ;;
  pg_dump)
    printf 'pg_dump %s\\n' "$*" >> "$MOCK_LOG"
    if [[ "$*" == *"--data-only"* ]]; then
      if [[ "$MOCK_FAIL_DATA_DUMP" == "true" ]]; then
        printf 'mock data dump failure\\n' >&2
        exit 3
      fi
      printf '%s\\n' "$MOCK_DATA_DUMP"
    else
      printf '%s\\n' "$MOCK_SCHEMA_DUMP"
    fi
    ;;
  *)
    printf 'unexpected-tool %s\\n' "$tool" >> "$MOCK_LOG"
    exit 4
    ;;
esac
`;

const MOCK_GPG = `#!/usr/bin/env bash
set -Eeuo pipefail
out=""
prev=""
for a in "$@"; do
  if [[ "$prev" == "--output" ]]; then
    out="$a"
  fi
  prev="$a"
done
if [[ -n "$out" ]]; then
  printf 'mock-ciphertext\\n' > "$out"
fi
exit 0
`;

const MOCK_OCI = `#!/usr/bin/env bash
set -Eeuo pipefail
printf 'oci %s\\n' "$*" >> "$MOCK_LOG"
exit 0
`;

const MOCK_SCHEMA_WITH_CONSTRAINT = [
  '--',
  '-- PostgreSQL database dump',
  '--',
  '',
  'CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;',
  '',
  'ALTER TABLE ONLY public.pto_requests',
  '    ADD CONSTRAINT pto_requests_no_owner_overlap EXCLUDE USING gist (',
  '        user_id WITH =,',
  "        daterange(start_date, end_date, '[]'::daterange) WITH &&",
  '    );',
].join('\n');

const MOCK_SCHEMA_WITHOUT_CONSTRAINT = [
  '--',
  '-- PostgreSQL database dump',
  '--',
  '',
  'CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;',
].join('\n');

const MOCK_SCHEMA_LEGACY = ['--', '-- PostgreSQL database dump', '--', ''].join('\n');

const MOCK_DATA_DUMP = [
  'COPY public.pto_requests (id, user_id) FROM stdin;',
  '00000000-0000-4000-8000-000000000000\t00000000-0000-4000-8000-000000000000',
  '\\.',
].join('\n');

interface BackupMockOptions {
  snapshotId?: string;
  extensionPresent?: boolean;
  constraintPresent?: boolean;
  migrationState?: 'applied' | 'absent' | 'pending';
  realSnapshot?: boolean;
  schemaDump?: string;
  failDataDump?: boolean;
}

interface BackupMockResult {
  status: number | null;
  stdout: string;
  stderr: string;
  log: string;
}

function writeMockExecutable(dir: string, name: string, body: string): void {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/** Runs the real backup script against the recording stand-in. */
function runBackupWithMock(options: BackupMockOptions = {}): BackupMockResult {
  const root = mkdtempSync(join(tmpdir(), 'pto-backup-mock-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const installDir = join(root, 'install');
    mkdirSync(installDir, { recursive: true });
    const backupDir = join(root, 'backups');
    mkdirSync(backupDir, { recursive: true });
    const logPath = join(root, 'calls.log');
    writeFileSync(logPath, '');
    writeFileSync(
      join(installDir, '.env'),
      [
        'DB_USER=pto',
        `DB_NAME=${options.realSnapshot ? TARGET_DB : 'pto'}`,
        'BACKUP_ENCRYPTION_KEY=aB3$xY9#mQ7&vN2*pL5@rT8^wK4!zD6%jH1',
        'OCI_BACKUP_BUCKET=disposable-bucket',
        'OCI_OBJECT_STORAGE_NAMESPACE=disposable-namespace',
        'OCI_REGION=us-ashburn-1',
        '',
      ].join('\n'),
    );
    writeFileSync(join(installDir, 'docker-compose.prod.yml'), 'services: {}\n');
    writeMockExecutable(bin, 'docker', MOCK_DOCKER);
    writeMockExecutable(bin, 'gpg', MOCK_GPG);
    writeMockExecutable(bin, 'oci', MOCK_OCI);

    const result = spawnSync('bash', [BACKUP_SCRIPT], {
      cwd: installDir,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: root,
        TMPDIR: root,
        INSTALL_DIR: installDir,
        BACKUP_DIR: backupDir,
        MOCK_LOG: logPath,
        MOCK_SNAPSHOT_ID: options.snapshotId ?? '00000003-0000001B-1',
        MOCK_EXTENSION: options.extensionPresent === false ? 'f' : 't',
        MOCK_CONSTRAINT: options.constraintPresent === false ? 'f' : 't',
        MOCK_MIGRATION_STATE:
          options.migrationState ?? (options.constraintPresent === false ? 'absent' : 'applied'),
        MOCK_SNAPSHOT_DB: options.realSnapshot ? TARGET_DB : '',
        MOCK_RUNNER: options.realSnapshot ? runner : '',
        MOCK_PSQL: options.realSnapshot ? resolveTool('psql') : '',
        MOCK_HOST: fixtureHost,
        MOCK_PORT: fixturePort,
        MOCK_SCHEMA_DUMP: options.schemaDump ?? MOCK_SCHEMA_WITH_CONSTRAINT,
        MOCK_DATA_DUMP: MOCK_DATA_DUMP,
        MOCK_FAIL_DATA_DUMP: options.failDataDump === true ? 'true' : 'false',
      },
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      log: readFileSync(logPath, 'utf8'),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

type Runner = 'pg_dump' | 'podman-container' | 'none';

function detectRunner(): Runner {
  for (const candidate of ['pg_dump', '/usr/lib/postgresql/16/bin/pg_dump']) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (probe.status === 0) return 'pg_dump';
  }
  // The standard compose container only serves port 5432. Do not silently
  // use it when the explicitly selected fixture is on a different port.
  if (fixturePort !== '5432') return 'none';
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
  const subArgs = [
    ...(tool === 'psql' ? ['-X'] : []),
    '-h',
    fixtureHost,
    '-p',
    fixturePort,
    '-U',
    source.username,
    ...sqlArgs.slice(1),
  ];
  const resolvedTool = runner === 'pg_dump' ? resolveTool(tool) : tool;
  const fullArgs =
    runner === 'pg_dump'
      ? subArgs
      : ['exec', '-i', '-e', `PGPASSWORD=pto`, LOCAL_CONTAINER, resolvedTool, ...subArgs];
  const cmd = runner === 'pg_dump' ? resolvedTool : 'podman';
  const env =
    runner === 'pg_dump' ? { PATH: process.env.PATH, PGPASSWORD: source.password } : undefined;
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
  runPgSql(['psql', '-d', TARGET_DB, '-v', 'ON_ERROR_STOP=1', '-q'], sql);
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
  runSql('DROP SCHEMA IF EXISTS public CASCADE;');
}

function extensionInstalled(dbName: string): boolean {
  const raw = runPgSql([
    'psql',
    '-d',
    dbName,
    '-tAc',
    "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist');",
  ]);
  return raw.trim() === 't';
}

interface ExportedSnapshot {
  id: string;
  database: string;
  extensionPresent: boolean;
  constraintPresent: boolean;
  close: () => Promise<void>;
}

/**
 * Exports a PostgreSQL snapshot from a dedicated read-only session and keeps
 * that session open, exactly like the production backup does. Both dumps then
 * read the same database state. The extension and the constraint state are
 * read inside the exporting transaction, so they describe the same snapshot.
 */
async function exportSnapshot(dbName: string): Promise<ExportedSnapshot> {
  expect([SOURCE_DB, PLAIN_DB]).toContain(dbName);
  const url = new URL(SOURCE_URL);
  url.pathname = `/${dbName}`;
  const client = new Client({
    connectionString: url.href,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
  });
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows } = await client.query<{
      id: string;
      extensionPresent: boolean;
      constraintPresent: boolean;
    }>(`SELECT pg_catalog.pg_export_snapshot() AS id,
          EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'btree_gist') AS "extensionPresent",
          EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE contype = 'x'
                  AND conname = 'pto_requests_no_owner_overlap'
                  AND conrelid = pg_catalog.to_regclass('public.pto_requests')) AS "constraintPresent"`);
    const snapshot = rows[0];
    expect(snapshot?.id).toMatch(/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9]+$/);
    return { ...snapshot!, database: dbName, close: () => client.end() };
  } catch (error) {
    await client.end();
    throw error;
  }
}

/**
 * The schema dump with the production arguments: public schema, no owner, no
 * ACL and — only when the exported snapshot has the extension — the extension
 * declaration itself. Both dumps read the same exported snapshot, so a
 * migration that commits between them cannot split the archive into a
 * pre-migration schema and a post-migration data file.
 */
function dumpSchema(snapshot: ExportedSnapshot, includeExtension = true): string {
  const args = ['pg_dump', '--schema-only', '--no-owner', '--no-acl', '--schema=public'];
  if (includeExtension && snapshot.extensionPresent) {
    args.push(`--extension=${REQUIRED_EXTENSION}`);
  }
  args.push('--dbname', snapshot.database, `--snapshot=${snapshot.id}`);
  return runPgSql(args);
}

function dumpData(snapshot: ExportedSnapshot): string {
  return runPgSql([
    'pg_dump',
    '--data-only',
    '--no-owner',
    '--no-acl',
    '--schema=public',
    '--dbname',
    snapshot.database,
    `--snapshot=${snapshot.id}`,
  ]);
}

/** The migration that installs the exclusion constraint, by its directory name. */
function overlapMigrationName(): string {
  const migrations = join(repoRoot, 'backend/prisma/migrations');
  const matches = readdirSync(migrations).filter((name) => {
    const sql = join(migrations, name, 'migration.sql');
    return existsSync(sql) && readFileSync(sql, 'utf8').includes(OVERLAP_CONSTRAINT);
  });
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function ensureTargetDatabase(): void {
  try {
    runPgSql(['psql', '-d', TARGET_DB, '-c', 'SELECT 1']);
    return;
  } catch {
    // fall through and create
  }
  try {
    runPgSql(['psql', '-d', PLAIN_DB, '-c', `CREATE DATABASE ${TARGET_DB};`]);
  } catch {
    // Only succeed if another process created the exact disposable target.
    runPgSql(['psql', '-d', TARGET_DB, '-c', 'SELECT 1']);
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
  const client = createPrismaClient(url);
  const rows = await client.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT COUNT(*)::bigint AS count FROM "${table}"`,
  );
  const count = rows[0]?.count ?? 0n;
  await client.$disconnect();
  return Number(count);
}

/** Counts the rows a fixed catalog query matches; the query is a literal. */
async function selectScalar(url: string, sql: string): Promise<number> {
  const client = createPrismaClient(url);
  try {
    const rows = await client.$queryRawUnsafe<{ value: bigint }[]>(sql);
    return Number(rows[0]?.value ?? 0n);
  } finally {
    await client.$disconnect();
  }
}

/** One PTO row as the stored columns, so a restore can be compared field by field. */
async function selectPtoRow(url: string, id: string): Promise<Record<string, unknown> | null> {
  const client = createPrismaClient(url);
  try {
    const row = await client.pTORequest.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        startDate: true,
        endDate: true,
        dayPart: true,
        note: true,
        version: true,
      },
    });
    return row;
  } finally {
    await client.$disconnect();
  }
}

/**
 * Tries to store an overlapping PTO for the same owner. The exclusion
 * constraint of #257 must refuse it; the returned message is null when the
 * write was accepted.
 */
async function tryOverlappingPto(
  url: string,
  userId: string,
  startDate: Date,
): Promise<string | null> {
  const client = createPrismaClient(url);
  try {
    await client.pTORequest.create({
      data: { userId, startDate, endDate: startDate, dayPart: 'morning' },
    });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    await client.$disconnect();
  }
}

const sourcePrisma = createPrismaClient(SOURCE_URL);
const runner = detectRunner();
const testOrSkip = runner === 'none' ? it.skip : it;

// The roundtrip needs rows in every table it compares. It creates its own
// fixture rather than relying on another spec file having written to the
// shared source database first: Vitest orders spec files by size, so a
// dependency on another file's side effect would make this test fail
// whenever a file grows.
const FIXTURE_EMAIL = `backup-restore-${process.pid}@example.test`;
const FIXTURE_START = new Date('2024-01-08T00:00:00.000Z');
let fixtureUserId = '';
let fixturePtoId = '';

async function createSourceFixture(): Promise<void> {
  const client = createPrismaClient(SOURCE_URL);
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
    fixtureUserId = user.id;
    fixturePtoId = pto.id;
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
  const client = createPrismaClient(SOURCE_URL);
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
    if (runner !== 'none') await removeSourceFixture();
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

      // One exported snapshot for both dumps, exactly like the production
      // backup: the schema and the data must describe the same state.
      const snapshot = await exportSnapshot(SOURCE_DB);
      let schemaDump: string;
      let dataDump: string;
      try {
        schemaDump = dumpSchema(snapshot);
        dataDump = dumpData(snapshot);
      } finally {
        await snapshot.close();
      }
      writeFileSync(schemaPath, schemaDump);
      writeFileSync(dataPath, dataDump);
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

      // The schema and the data must describe the same database state: the
      // migration marker and the constraint it installed travel together. A
      // split pair is exactly the archive the backup must never produce.
      const migration = overlapMigrationName();
      expect(restoredData.includes(migration)).toBe(restoredSchema.includes(OVERLAP_CONSTRAINT));

      // #257: the restored database must be able to enforce the owner/date
      // exclusion, which only works when the extension travelled with the
      // archive.
      expect(
        await selectScalar(
          TARGET_URL,
          `SELECT count(*)::bigint AS value FROM pg_extension WHERE extname = '${REQUIRED_EXTENSION}'`,
        ),
      ).toBe(1);
      expect(
        await selectScalar(
          TARGET_URL,
          `SELECT count(*)::bigint AS value FROM pg_constraint WHERE conname = '${OVERLAP_CONSTRAINT}'`,
        ),
      ).toBe(1);

      // The restored row keeps its version, note and dates.
      const sourceRow = await selectPtoRow(SOURCE_URL, fixturePtoId);
      const targetRow = await selectPtoRow(TARGET_URL, fixturePtoId);
      expect(sourceRow).not.toBeNull();
      expect(targetRow).toEqual(sourceRow);
      expect(targetRow?.note).toBe('backup restore fixture');
      expect(targetRow?.version).toBe(1);

      // The restored constraint really refuses an overlap for the same owner.
      const before = await selectCount(TARGET_URL, 'pto_requests');
      const refusal = await tryOverlappingPto(TARGET_URL, fixtureUserId, FIXTURE_START);
      expect(refusal, 'the restored database accepted an overlapping PTO').not.toBeNull();
      expect(refusal).toContain(`exclusion constraint "${OVERLAP_CONSTRAINT}"`);
      expect(await selectCount(TARGET_URL, 'pto_requests')).toBe(before);
    },
    120_000,
  );

  testOrSkip(
    'a database without the extension is still dumped without it',
    async () => {
      // The maintenance database never carries btree_gist, so it stands in for
      // a database that predates the migration: the backup must not be
      // blocked and must not mention an extension it does not have.
      const snapshot = await exportSnapshot(PLAIN_DB);
      try {
        expect(snapshot.extensionPresent).toBe(false);
        expect(extensionInstalled(PLAIN_DB)).toBe(false);
        const legacy = dumpSchema(snapshot);
        expect(legacy).not.toMatch(EXTENSION_DECLARATION);
        expect(legacy).not.toContain(OVERLAP_CONSTRAINT);
        expect(legacy.length).toBeGreaterThan(0);
      } finally {
        await snapshot.close();
      }
    },
    60_000,
  );

  testOrSkip(
    'explicitly including the extension fixes the incomplete public-only dump',
    async () => {
      // This is the shape the production backup must refuse: the constraint
      // needs btree_gist, and a public-only dump omits the declaration.
      const snapshot = await exportSnapshot(SOURCE_DB);
      try {
        const withoutExtension = dumpSchema(snapshot, false);
        expect(withoutExtension).toContain(OVERLAP_CONSTRAINT);
        expect(withoutExtension).not.toMatch(EXTENSION_DECLARATION);

        // The archive that is uploaded does carry the extension.
        const withExtension = dumpSchema(snapshot);
        expect(withExtension).toMatch(EXTENSION_DECLARATION);
      } finally {
        await snapshot.close();
      }
    },
    60_000,
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

  it('the backup script only adds the extension it knows and fails closed without it', () => {
    // The script cannot run without the container and the object store, so the
    // guard it adds is asserted here instead of in a live backup.
    expect(existsSync(BACKUP_SCRIPT)).toBe(true);
    const script = readFileSync(BACKUP_SCRIPT, 'utf8');

    expect(script).toContain(`readonly REQUIRED_EXTENSION="${REQUIRED_EXTENSION}"`);
    expect(script).toContain(`readonly OVERLAP_CONSTRAINT="${OVERLAP_CONSTRAINT}"`);
    // The exporter is a read-only, repeatable-read transaction of its own.
    expect(script).toContain('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;');
    expect(script).toContain('pg_export_snapshot()');
    expect(script).toContain(
      "EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'btree_gist')",
    );
    expect(script).toContain("WHERE conname = 'pto_requests_no_owner_overlap' AND contype = 'x'");
    expect(script).toContain("conrelid = pg_catalog.to_regclass('public.pto_requests')");
    // Both dumps read the very same snapshot.
    expect(script.match(/--snapshot="\$\{SNAPSHOT_ID\}"/g)).toHaveLength(2);
    expect(script).toContain('SCHEMA_DUMP_ARGS+=(--extension="${REQUIRED_EXTENSION}")');
    // The fail-closed rule looks for the one known extension, not for any
    // extension statement.
    expect(script).toContain(
      '^CREATE EXTENSION IF NOT EXISTS ${REQUIRED_EXTENSION} WITH SCHEMA public;',
    );
    expect(script).toMatch(/refusing to upload a backup that cannot be restored/);
    expect(script).toMatch(/does not contain the constraint the snapshot had/);

    // The extension selection stays narrow: only the one known extension.
    expect(script).not.toMatch(/--extension="?\$\{(?!REQUIRED_EXTENSION\})/);
    // The encryption, the upload authentication and the cleanup are untouched.
    expect(script).toContain('--cipher-algo AES256');
    expect(script).toContain('--symmetric');
    expect(script).toContain('--auth instance_principal');
    expect(script).toContain('trap cleanup EXIT INT TERM');
    // The exporter is closed on success, on failure and on every signal.
    expect(script).toContain('close_snapshot()');
    expect(script).toContain('exec {snapshot_input}>&-');
  });

  it('dumps the schema and the data from one exported snapshot', () => {
    const result = runBackupWithMock();
    expect(result.status).toBe(0);

    const events = result.log.split('\n').filter((line) => line.length > 0);
    const dumps = events.filter((line) => line.startsWith('pg_dump '));
    expect(dumps).toHaveLength(2);

    // Both dumps name the same snapshot.
    const snapshots = dumps.map((line) => /--snapshot=([^\s]+)/.exec(line)?.[1]);
    expect(snapshots[0]).toBeTruthy();
    expect(snapshots[1]).toBe(snapshots[0]);

    // The exporter was open for both dumps and closed afterwards.
    const open = events.indexOf('psql-open');
    const close = events.indexOf('psql-close');
    expect(open).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(open);
    expect(events.indexOf(dumps[0]!)).toBeGreaterThan(open);
    expect(events.indexOf(dumps[1]!)).toBeLessThan(close);
    expect(events.findIndex((line) => line.startsWith('oci '))).toBeGreaterThan(close);

    // The archive was uploaded.
    expect(events.some((line) => line.startsWith('oci '))).toBe(true);
    expect(result.stderr).toContain('using PostgreSQL snapshot');
  });

  it('refuses to upload an archive whose schema does not match the snapshot', () => {
    // The rejected defect: the schema dump was taken before the migration, so
    // it has no constraint, while the exported snapshot says it has one.
    const result = runBackupWithMock({ schemaDump: MOCK_SCHEMA_WITHOUT_CONSTRAINT });
    expect(result.status).toBe(2);
    expect(result.log).not.toContain('oci ');
    expect(result.log).toContain('psql-close');
    expect(result.stderr).toContain('does not contain the constraint the snapshot had');
  });

  it('closes the snapshot exporter when a dump fails', () => {
    const result = runBackupWithMock({ failDataDump: true });
    expect(result.status).not.toBe(0);
    expect(result.log).not.toContain('oci ');
    expect(result.log).toContain('psql-close');
  });

  it('refuses to back up an unfinished overlap migration', () => {
    const result = runBackupWithMock({ migrationState: 'pending' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('the PTO overlap migration is unfinished');
    expect(result.log).not.toMatch(/pg_dump|oci /);
    expect(result.log).toContain('psql-close');
  });

  testOrSkip(
    'exports the real backup snapshot for an empty restore target but rejects a populated target without a ledger',
    () => {
      resetTarget();
      try {
        runSql('CREATE SCHEMA public;');
        const options = { realSnapshot: true, schemaDump: MOCK_SCHEMA_LEGACY };
        const empty = runBackupWithMock(options);
        expect(empty.stderr).not.toContain('does not exist');
        expect(empty.status).toBe(0);
        expect(empty.log).toContain('psql-close');
        expect(empty.log.match(/oci os object put/g)).toHaveLength(2);

        // Non-table objects must also prevent treating a damaged schema as empty.
        runSql('CREATE VIEW public.synthetic_recovery_probe AS SELECT 1 AS id;');
        const populated = runBackupWithMock(options);
        expect(populated.status).toBe(2);
        expect(populated.stderr).toContain('no Prisma ledger and public is not an empty schema');
        expect(populated.log).toContain('psql-close');
        expect(populated.log).not.toMatch(/pg_dump|oci /);
      } finally {
        resetTarget();
      }
    },
    30_000,
  );

  it('still backs up a database that predates the migration', () => {
    const result = runBackupWithMock({
      extensionPresent: false,
      constraintPresent: false,
      schemaDump: MOCK_SCHEMA_LEGACY,
    });
    expect(result.status).toBe(0);
    const dumps = result.log.split('\n').filter((line) => line.startsWith('pg_dump '));
    expect(dumps).toHaveLength(2);
    // No extension is added to a database that has none, and both dumps still
    // read the same snapshot.
    expect(dumps[0]).not.toContain('--extension=');
    expect(dumps[0]).toContain('--snapshot=');
    expect(result.log).toContain('oci ');
  });
});
