import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const script = join(import.meta.dirname, '../../../../bin/restore-backup.mjs');
const key = 'aB1!cD2@eF3#gH4$iJ5%kL6&mN7*oP8+nN9?xY0z';
const archiveName = 'pto-20261022T030000Z.tar.gz.gpg';
const root = mkdtempSync(join(tmpdir(), 'pto-restore-script-test-'));
const fixtures = join(root, 'fixtures');
const tools = join(root, 'tools');
const schema =
  'CREATE SCHEMA public;\nSET ROLE source_admin;\nCREATE TABLE public.probe (id integer);\n';
const data = 'SET transaction_timeout = 0;\nINSERT INTO public.probe VALUES (1);\n';
let workdir: string;

function runTool(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} fixture failed: ${result.stderr}`);
}

function writeTool(name: string, body: string) {
  writeFileSync(join(tools, name), `#!${process.execPath}\n${body}`, { mode: 0o700 });
}

function checksum() {
  const digest = createHash('sha256')
    .update(readFileSync(join(workdir, archiveName)))
    .digest('hex');
  writeFileSync(join(workdir, `${archiveName}.sha256`), `${digest}  ${archiveName}\n`);
}

function restore(args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    process.execPath,
    [script, '--archive', archiveName, '--allow-disposable-target', ...args],
    {
      cwd: workdir,
      encoding: 'utf8',
      env: {
        ...process.env,
        BACKUP_BUCKET: '',
        GOOGLE_APPLICATION_CREDENTIALS: '',
        TARGET_DATABASE_URL: 'postgresql://disposable.example.test/restore_test',
        ENCRYPTION_KEY: key,
        PATH: `${tools}:${process.env.PATH}`,
        PTO_TEST_SYSTEM_PATH: process.env.PATH,
        PTO_TEST_WORKDIR: workdir,
        GNUPGHOME: join(root, 'gnupg'),
        TMPDIR: join(workdir, 'tmp'),
        ...env,
      },
    },
  );
}

function expectRejectedBeforeSql(result: ReturnType<typeof restore>, message: string) {
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(message);
  expect(existsSync(join(workdir, 'psql.json'))).toBe(false);
  expect(readdirSync(join(workdir, 'tmp'))).toEqual([]);
  expect(existsSync(join(workdir, 'schema.sql'))).toBe(false);
  expect(existsSync(join(workdir, 'data.sql'))).toBe(false);
}

beforeAll(() => {
  for (const dir of [fixtures, tools, join(root, 'gnupg')]) mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(fixtures, 'schema.sql'), schema);
  writeFileSync(join(fixtures, 'data.sql'), data);
  writeFileSync(join(fixtures, 'extra.sql'), 'SELECT 1;');
  writeFileSync(join(fixtures, 'passphrase'), key, { mode: 0o600 });

  for (const [name, members] of [
    ['valid', ['schema.sql', 'data.sql']],
    ['extra', ['schema.sql', 'data.sql', 'extra.sql']],
  ] as const) {
    const archive = join(fixtures, `${name}.tar.gz`);
    runTool('tar', ['-C', fixtures, '-czf', archive, ...members]);
    runTool('gpg', [
      '--homedir',
      join(root, 'gnupg'),
      '--batch',
      '--yes',
      '--no-tty',
      '--symmetric',
      '--cipher-algo',
      'AES256',
      '--s2k-count',
      '1024',
      '--passphrase-file',
      join(fixtures, 'passphrase'),
      '--output',
      `${archive}.gpg`,
      archive,
    ]);
  }

  writeTool(
    'psql',
    `
    const fs = require('node:fs');
    const path = require('node:path');
    const args = process.argv.slice(2);
    if (args.includes('--version')) process.exit(0);
    const files = args.flatMap((arg, i) => arg === '--file' ? [fs.readFileSync(args[i + 1], 'utf8')] : []);
    fs.writeFileSync(path.join(process.env.PTO_TEST_WORKDIR, 'psql.json'), JSON.stringify({ args, files }));
    process.exit(Number(process.env.PTO_TEST_PSQL_EXIT || 0));
  `,
  );
  writeTool(
    'gpg',
    `
    const fs = require('node:fs');
    const path = require('node:path');
    const { spawnSync } = require('node:child_process');
    const args = process.argv.slice(2);
    if (args.includes('--decrypt')) fs.writeFileSync(path.join(process.env.PTO_TEST_WORKDIR, 'decrypted'), 'yes');
    const result = spawnSync('gpg', args, { stdio: 'inherit', env: { ...process.env, PATH: process.env.PTO_TEST_SYSTEM_PATH } });
    process.exit(result.status ?? 1);
  `,
  );
  writeTool(
    'gcloud',
    `
    require('node:fs').writeFileSync(require('node:path').join(process.env.PTO_TEST_WORKDIR, 'gcloud-called'), 'yes');
    process.exit(99);
  `,
  );
});

beforeEach(() => {
  workdir = mkdtempSync(join(root, 'case-'));
  mkdirSync(join(workdir, 'tmp'), { mode: 0o700 });
  copyFileSync(join(fixtures, 'valid.tar.gz.gpg'), join(workdir, archiveName));
  checksum();
});

afterEach(() => rmSync(workdir, { recursive: true, force: true }));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('local encrypted backup restore', () => {
  it('restores sanitized schema and data in one transaction without cloud credentials', () => {
    const result = restore();
    expect(result.status, result.stderr).toBe(0);
    const call = JSON.parse(readFileSync(join(workdir, 'psql.json'), 'utf8'));
    expect(call.args).toContain('--single-transaction');
    expect(call.args).toContain('DROP SCHEMA IF EXISTS public CASCADE;');
    expect(call.files).toEqual([
      schema.replace('SET ROLE source_admin;\n', ''),
      data.replace('SET transaction_timeout = 0;\n', ''),
    ]);
    expect(existsSync(join(workdir, archiveName))).toBe(true);
    expect(existsSync(join(workdir, `${archiveName}.sha256`))).toBe(true);
    expect(existsSync(join(workdir, 'gcloud-called'))).toBe(false);
    expect(existsSync(join(workdir, 'schema.sql'))).toBe(false);
    expect(readdirSync(join(workdir, 'tmp'))).toEqual([]);
  });

  it('retains plaintext only when explicitly requested, with restrictive permissions', () => {
    const result = restore(['--keep-local']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('WARNING: --keep-local');
    for (const name of ['schema.sql', 'data.sql']) {
      expect(statSync(join(workdir, name)).mode & 0o777).toBe(0o600);
    }
  });

  it('rejects missing archives and checksums before SQL', () => {
    rmSync(join(workdir, `${archiveName}.sha256`));
    expectRejectedBeforeSql(restore(), 'checksum is missing');
    rmSync(join(workdir, archiveName));
    expectRejectedBeforeSql(restore(), 'encrypted archive is missing');
  });

  it('rejects symlink archives and checksums', () => {
    rmSync(join(workdir, archiveName));
    symlinkSync(join(fixtures, 'valid.tar.gz.gpg'), join(workdir, archiveName));
    expectRejectedBeforeSql(restore(), 'not a regular file');
    rmSync(join(workdir, archiveName));
    copyFileSync(join(fixtures, 'valid.tar.gz.gpg'), join(workdir, archiveName));
    const checksumPath = join(workdir, `${archiveName}.sha256`);
    copyFileSync(checksumPath, join(workdir, 'checksum-copy'));
    rmSync(checksumPath);
    symlinkSync(join(workdir, 'checksum-copy'), checksumPath);
    expectRejectedBeforeSql(restore(), 'not a regular file');
  });

  it('rejects tampering before decryption and SQL', () => {
    writeFileSync(join(workdir, archiveName), 'tampered encrypted bytes');
    const result = restore();
    expect(result.status).toBe(3);
    expectRejectedBeforeSql(result, 'checksum verification failed');
    expect(existsSync(join(workdir, 'decrypted'))).toBe(false);
  });

  it('rejects checksums naming a different file before decryption', () => {
    writeFileSync(join(workdir, `${archiveName}.sha256`), `${'a'.repeat(64)}  ../../other\n`);
    expectRejectedBeforeSql(restore(), 'exactly the supplied archive basename');
    expect(existsSync(join(workdir, 'decrypted'))).toBe(false);
  });

  it('rejects incorrect decryption keys without SQL or leftover plaintext', () => {
    expectRejectedBeforeSql(restore([], { ENCRYPTION_KEY: `${key}-different` }), 'gpg decrypt');
  });

  it('rejects archives with unexpected members without SQL', () => {
    copyFileSync(join(fixtures, 'extra.tar.gz.gpg'), join(workdir, archiveName));
    checksum();
    expectRejectedBeforeSql(restore(), 'unexpected path');
  });

  it('rejects weak encryption keys before decryption', () => {
    expectRejectedBeforeSql(restore([], { ENCRYPTION_KEY: 'short' }), 'at least 32');
    expect(existsSync(join(workdir, 'decrypted'))).toBe(false);
  });

  it('cleans up after SQL failure without printing the target credentials', () => {
    const secretTarget = 'postgresql://sensitive-password@disposable.example.test/restore_test';
    const result = restore([], { PTO_TEST_PSQL_EXIT: '1', TARGET_DATABASE_URL: secretTarget });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('psql restore exited with status 1');
    expect(result.stderr).not.toContain(secretTarget);
    expect(readdirSync(join(workdir, 'tmp'))).toEqual([]);
    expect(existsSync(join(workdir, 'schema.sql'))).toBe(false);
  });
});
