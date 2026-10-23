#!/usr/bin/env node
// Verify and restore a locally downloaded encrypted PostgreSQL backup into
// an explicitly confirmed disposable database. Download the archive and its
// adjacent .sha256 file first; this script does not require cloud credentials.
//
// Required environment:
//   TARGET_DATABASE_URL  connection string of the disposable target DB
//   ENCRYPTION_KEY       passphrase used when the archive was encrypted
//
// Required tools on PATH:
//   gpg, tar, sha256sum
//   psql                 to apply schema.sql and data.sql (psql handles
//                        pg_dump's `\restrict` and other meta-commands)
//
// Usage:
//   node bin/restore-backup.mjs --archive pto-20260810T030000Z.tar.gz.gpg \
//     --allow-disposable-target [--keep-local]
//
// Exit codes:
//   0  success
//   1  user error (missing argument, missing env)
//   2  tool error (gpg/tar/psql exit non-zero) or invalid archive
//   3  checksum mismatch

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertStrongEncryptionKey } from './backupSecurity.mjs';

process.umask(0o077);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const SANITIZE_DIR = join(scriptDir, '..', 'infra', 'deploy');
const SCHEMA_SANITIZER = join(SANITIZE_DIR, 'sql-sanitize-schema.sed');
const DATA_SANITIZER = join(SANITIZE_DIR, 'sql-sanitize-data.sed');

class ScriptError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

let activeWorkdir;

function cleanupWorkdir() {
  if (!activeWorkdir) return;
  rmSync(activeWorkdir, { recursive: true, force: true });
  activeWorkdir = undefined;
}

function fail(message, code = 1) {
  throw new ScriptError(message, code);
}

process.once('SIGINT', () => {
  cleanupWorkdir();
  process.exit(130);
});
process.once('SIGTERM', () => {
  cleanupWorkdir();
  process.exit(143);
});

function parseArgs(argv) {
  const args = { archive: null, keepLocal: false, allowDisposableTarget: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--archive' && i + 1 < argv.length) {
      args.archive = argv[++i];
    } else if (arg === '--keep-local') {
      args.keepLocal = true;
    } else if (arg === '--allow-disposable-target') {
      args.allowDisposableTarget = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  if (!args.archive) {
    fail('--archive <filename> is required');
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node bin/restore-backup.mjs [options]

Options:
  --archive <name>    Local encrypted archive basename (adjacent .sha256 required)
  --keep-local        Keep the decrypted files in CWD after applying them
  --allow-disposable-target  Confirm TARGET_DATABASE_URL is disposable
  -h, --help          Show this help
`);
}

function requireTool(name, hint) {
  const probe = spawnSync(name, ['--version'], { stdio: 'ignore' });
  if (probe.status !== 0) {
    fail(`${name} not found on PATH. ${hint ?? ''}`.trim(), 2);
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.length === 0) {
    fail(`environment variable ${name} is required`, 1);
  }
  return value;
}

function run(label, command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.error) {
    fail(`${label} failed to start`, 2);
  }
  if (result.status !== 0) {
    fail(`${label} exited with status ${result.status}`, 2);
  }
  return result;
}

function validateArchiveName(archive) {
  if (basename(archive) !== archive || !/^pto-[A-Za-z0-9._-]+\.tar\.gz\.gpg$/.test(archive)) {
    fail('archive name must be a generated .tar.gz.gpg basename', 1);
  }
}

function validateArchiveContents(archivePath) {
  const manifest = run('tar manifest', 'tar', ['--list', '--verbose', '--file', archivePath]);
  const entries = manifest.stdout
    .toString()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const expected = new Set(['schema.sql', 'data.sql']);
  const names = [];
  for (const entry of entries) {
    const type = entry[0];
    const name = entry.split(/\s+/).at(-1);
    if (type !== '-' || !name || !expected.has(name)) {
      fail('archive contains an unexpected path or non-regular file', 2);
    }
    names.push(name);
  }
  if (names.length !== expected.size || new Set(names).size !== expected.size) {
    fail('archive must contain exactly schema.sql and data.sql', 2);
  }
}

function assertRegularFile(path, label) {
  if (!existsSync(path) || !lstatSync(path).isFile() || statSync(path).size === 0) {
    fail(`${label} is missing, empty, or not a regular file`, 2);
  }
}

function verifyChecksum(workdir, encryptedPath, checksumPath) {
  const checksum = readFileSync(checksumPath, 'utf8');
  const expectedName = basename(encryptedPath);
  const match = /^([0-9a-fA-F]{64}) [ *]([^\r\n]+)\r?\n?$/.exec(checksum);
  if (!match || match[2] !== expectedName) {
    fail('checksum must contain exactly the supplied archive basename', 3);
  }
  const result = spawnSync('sha256sum', ['--check', '--strict', basename(checksumPath)], {
    cwd: workdir,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.status !== 0) {
    fail(`checksum verification failed for ${basename(encryptedPath)}`, 3);
  }
}

function restoreSql(schemaPath, dataPath, targetUrl) {
  // Reset only the explicitly confirmed disposable target. One transaction
  // rolls back the drop and both files if any SQL statement fails.
  run(
    'psql restore',
    'psql',
    [
      '--variable=ON_ERROR_STOP=1',
      '--quiet',
      '--dbname',
      targetUrl,
      '--single-transaction',
      '--command',
      'DROP SCHEMA IF EXISTS public CASCADE;',
      '--file',
      schemaPath,
      '--file',
      dataPath,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
}

// A dump taken from another database can reference roles and settings the
// target does not have. The rules are shared with the production OCI restore
// so the two cannot drift apart.
function sanitizeSql(sourcePath, sanitizerPath, targetPath) {
  if (!existsSync(sanitizerPath)) {
    fail(`SQL sanitizer file is missing: ${sanitizerPath}`, 1);
  }
  const result = spawnSync('sed', ['-E', '-f', sanitizerPath, sourcePath], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail(
      `sanitizing ${basename(sourcePath)} failed (status=${result.status}): ${result.stderr ?? result.error?.message ?? ''}`,
      2,
    );
  }
  if (result.stdout.length === 0) {
    fail(`sanitizing ${basename(sourcePath)} produced an empty file`, 2);
  }
  writeFileSync(targetPath, result.stdout, { mode: 0o600 });
  return targetPath;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetUrl = requireEnv('TARGET_DATABASE_URL');
  const encryptionKey = requireEnv('ENCRYPTION_KEY');
  if (!args.allowDisposableTarget) {
    fail('refusing restore without --allow-disposable-target confirmation', 1);
  }
  validateArchiveName(args.archive);
  try {
    assertStrongEncryptionKey(encryptionKey);
  } catch (error) {
    fail(error instanceof Error ? error.message : 'invalid encryption key', 1);
  }

  assertRegularFile(args.archive, 'encrypted archive');
  assertRegularFile(`${args.archive}.sha256`, 'checksum');

  requireTool('gpg', 'Install gnupg.');
  requireTool('tar', 'Install tar.');
  requireTool('sha256sum', 'Install coreutils.');
  requireTool('psql', 'Install postgresql-client (provides psql).');

  const workdir = mkdtempSync(join(tmpdir(), 'pto-restore-'));
  activeWorkdir = workdir;
  const encryptedPath = join(workdir, args.archive);
  const checksumPath = `${encryptedPath}.sha256`;
  const archivePath = encryptedPath.replace(/\.gpg$/, '');
  const passphrasePath = join(workdir, 'passphrase');

  try {
    copyFileSync(args.archive, encryptedPath);
    copyFileSync(`${args.archive}.sha256`, checksumPath);

    verifyChecksum(workdir, encryptedPath, checksumPath);

    writeFileSync(passphrasePath, encryptionKey, { mode: 0o600 });
    run(
      'gpg decrypt',
      'gpg',
      [
        '--batch',
        '--yes',
        '--no-tty',
        '--decrypt',
        '--passphrase-file',
        passphrasePath,
        '--output',
        archivePath,
        encryptedPath,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    rmSync(passphrasePath, { force: true });
    rmSync(encryptedPath, { force: true });
    rmSync(checksumPath, { force: true });

    assertRegularFile(archivePath, 'decrypted archive');

    validateArchiveContents(archivePath);
    run('tar extract', 'tar', [
      '--directory',
      workdir,
      '--extract',
      '--gzip',
      '--file',
      archivePath,
      '--no-same-owner',
      '--no-same-permissions',
      '--no-overwrite-dir',
    ]);
    rmSync(archivePath, { force: true });

    const schemaPath = join(workdir, 'schema.sql');
    const dataPath = join(workdir, 'data.sql');
    assertRegularFile(schemaPath, 'schema.sql');
    assertRegularFile(dataPath, 'data.sql');

    const targetSchemaPath = sanitizeSql(
      schemaPath,
      SCHEMA_SANITIZER,
      join(workdir, 'schema-target.sql'),
    );
    const targetDataPath = sanitizeSql(dataPath, DATA_SANITIZER, join(workdir, 'data-target.sql'));

    if (args.keepLocal) {
      const cwd = process.cwd();
      copyFileSync(schemaPath, join(cwd, 'schema.sql'));
      copyFileSync(dataPath, join(cwd, 'data.sql'));
      chmodSync(join(cwd, 'schema.sql'), 0o600);
      chmodSync(join(cwd, 'data.sql'), 0o600);
      console.warn('WARNING: --keep-local retains plaintext database dumps on disk.');
      console.log(`local copies: ${cwd}/schema.sql and ${cwd}/data.sql`);
    }

    restoreSql(targetSchemaPath, targetDataPath, targetUrl);

    console.log(`Restore complete: applied schema.sql and data.sql to target.`);
  } finally {
    cleanupWorkdir();
  }
}

try {
  main();
} catch (error) {
  const code = error instanceof ScriptError ? error.code : 2;
  const message = error instanceof Error ? error.message : 'Unknown restore failure';
  console.error(`error: ${message}`);
  process.exit(code);
}
