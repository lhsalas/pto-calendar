#!/usr/bin/env node
// Download an encrypted Supabase backup from Google Cloud Storage, verify
// its checksum, decrypt it, and apply the schema and data to a target
// PostgreSQL database. Use this for the restore drill or for restoring
// into a clean Supabase project.
//
// Required environment:
//   TARGET_DATABASE_URL  connection string of the disposable target DB
//   ENCRYPTION_KEY       passphrase used when the archive was encrypted
//
// Required tools on PATH:
//   gpg, tar, sha256sum
//   gcloud               authenticated against the source GCP project
//   psql                 to apply schema.sql and data.sql (psql handles
//                        pg_dump's `\restrict` and other meta-commands)
//
// Usage:
//   node bin/restore-backup.mjs --archive pto-20260810T030000Z.tar.gz.gpg \
//     --allow-disposable-target [--bucket <name>] [--keep-local]
//
// Exit codes:
//   0  success
//   1  user error (missing argument, missing env)
//   2  tool error (gpg/tar/psql/gcloud exit non-zero)
//   3  checksum mismatch

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  copyFileSync,
  existsSync,
  lstatSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { assertStrongEncryptionKey } from './backupSecurity.mjs';

process.umask(0o077);

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
  const args = { archive: null, bucket: null, keepLocal: false, allowDisposableTarget: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--archive' && i + 1 < argv.length) {
      args.archive = argv[++i];
    } else if (arg === '--bucket' && i + 1 < argv.length) {
      args.bucket = argv[++i];
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
  --archive <name>    Encrypted archive filename inside the bucket's pto/ prefix
  --bucket <name>     Override BACKUP_BUCKET env
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
  const result = spawnSync('sha256sum', ['--check', '--strict', basename(checksumPath)], {
    cwd: workdir,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.status !== 0) {
    fail(`checksum verification failed for ${basename(encryptedPath)}`, 3);
  }
}

function applySqlFile(sqlPath, targetUrl) {
  // psql reads from stdin or --file; --file avoids spawning a shell to pipe.
  run(
    'psql apply',
    'psql',
    ['--variable=ON_ERROR_STOP=1', '--quiet', '--dbname', targetUrl, '--file', sqlPath],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const bucket = args.bucket ?? requireEnv('BACKUP_BUCKET');
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

  requireTool('gpg', 'Install gnupg.');
  requireTool('tar', 'Install tar.');
  requireTool('sha256sum', 'Install coreutils.');
  requireTool('gcloud', 'Install the Google Cloud CLI and run `gcloud auth login`.');
  requireTool('psql', 'Install postgresql-client (provides psql).');

  const workdir = mkdtempSync(join(tmpdir(), 'pto-restore-'));
  activeWorkdir = workdir;
  const encryptedPath = join(workdir, args.archive);
  const checksumPath = `${encryptedPath}.sha256`;
  const archivePath = encryptedPath.replace(/\.gpg$/, '');
  const passphrasePath = join(workdir, 'passphrase');

  try {
    const objectPath = `pto/${args.archive}`;
    run(
      'gcloud storage cp (encrypted)',
      'gcloud',
      ['storage', 'cp', `gs://${bucket}/${objectPath}`, encryptedPath],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    run(
      'gcloud storage cp (checksum)',
      'gcloud',
      ['storage', 'cp', `gs://${bucket}/${objectPath}.sha256`, checksumPath],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );

    if (
      !existsSync(encryptedPath) ||
      !existsSync(checksumPath) ||
      statSync(encryptedPath).size === 0
    ) {
      fail('encrypted archive or checksum missing or empty', 2);
    }

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

    if (args.keepLocal) {
      const cwd = process.cwd();
      copyFileSync(schemaPath, join(cwd, 'schema.sql'));
      copyFileSync(dataPath, join(cwd, 'data.sql'));
      chmodSync(join(cwd, 'schema.sql'), 0o600);
      chmodSync(join(cwd, 'data.sql'), 0o600);
      console.warn('WARNING: --keep-local retains plaintext database dumps on disk.');
      console.log(`local copies: ${cwd}/schema.sql and ${cwd}/data.sql`);
    }

    applySqlFile(schemaPath, targetUrl);
    applySqlFile(dataPath, targetUrl);

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
