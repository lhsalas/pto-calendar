#!/usr/bin/env node
// Dump a Supabase/Postgres public schema and data, encrypt with GPG, and
// upload to a Google Cloud Storage bucket. Mirrors the GitHub Actions
// workflow so operators can run the same flow from a trusted machine.
//
// Required environment:
//   DATABASE_URL         direct or pooled Postgres connection string
//   BACKUP_BUCKET        GCS bucket name (without gs://)
//   ENCRYPTION_KEY       passphrase used for the AES-256 symmetric encryption
//
// Required tools on PATH:
//   supabase             (or the script falls back to pg_dump)
//   gpg, tar, sha256sum
//   gcloud               authenticated against the target GCP project
//
// Usage:
//   node bin/backup-db.mjs [--label <suffix>] [--bucket <name>] [--keep-local]
//
// Exit codes:
//   0  success
//   1  user error (missing argument, missing env)
//   2  tool error (gpg/tar/supabase/gcloud exit non-zero)

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  rmSync,
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
  const args = { label: null, bucket: null, keepLocal: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--label' && i + 1 < argv.length) {
      args.label = argv[++i];
    } else if (arg === '--bucket' && i + 1 < argv.length) {
      args.bucket = argv[++i];
    } else if (arg === '--keep-local') {
      args.keepLocal = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node bin/backup-db.mjs [options]

Options:
  --label <suffix>   Append a label to the archive filename
  --bucket <name>    Override BACKUP_BUCKET env
  --keep-local       Keep the encrypted archive in CWD after upload
  -h, --help         Show this help
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

function dumpTo(workdir, dbUrl) {
  const schemaFile = join(workdir, 'schema.sql');
  const dataFile = join(workdir, 'data.sql');
  const supabaseProbe = spawnSync('supabase', ['--version'], { stdio: 'ignore' });
  if (supabaseProbe.status === 0) {
    run(
      'supabase schema dump',
      'supabase',
      ['db', 'dump', '--db-url', dbUrl, '--schema', 'public', '--file', schemaFile],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    run(
      'supabase data dump',
      'supabase',
      [
        'db',
        'dump',
        '--db-url',
        dbUrl,
        '--schema',
        'public',
        '--data-only',
        '--use-copy',
        '--file',
        dataFile,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    return;
  }
  requireTool('pg_dump', 'Install postgresql-client or the Supabase CLI.');
  run('pg_dump schema', 'pg_dump', [
    '--dbname',
    dbUrl,
    '--schema-only',
    '--schema=public',
    '--no-owner',
    '--file',
    schemaFile,
  ]);
  run('pg_dump data', 'pg_dump', [
    '--dbname',
    dbUrl,
    '--schema=public',
    '--data-only',
    '--no-owner',
    '--file',
    dataFile,
  ]);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbUrl = requireEnv('DATABASE_URL');
  const bucket = args.bucket ?? requireEnv('BACKUP_BUCKET');
  const encryptionKey = requireEnv('ENCRYPTION_KEY');
  try {
    assertStrongEncryptionKey(encryptionKey);
  } catch (error) {
    fail(error instanceof Error ? error.message : 'invalid encryption key', 1);
  }

  requireTool('gpg', 'Install gnupg.');
  requireTool('tar', 'Install tar.');
  requireTool('sha256sum', 'Install coreutils.');
  requireTool('gcloud', 'Install the Google Cloud CLI and run `gcloud auth login`.');

  const workdir = mkdtempSync(join(tmpdir(), 'pto-backup-'));
  activeWorkdir = workdir;
  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace(/-/g, '').slice(0, 15) + 'Z';
  const labelPart = args.label ? `-${args.label.replace(/[^A-Za-z0-9._-]/g, '_')}` : '';
  const baseName = `pto-${stamp}${labelPart}`;
  const archive = join(workdir, `${baseName}.tar.gz`);
  const encrypted = `${archive}.gpg`;
  const checksum = `${encrypted}.sha256`;

  try {
    dumpTo(workdir, dbUrl);
    const schemaPath = join(workdir, 'schema.sql');
    const dataPath = join(workdir, 'data.sql');
    if (!existsSync(schemaPath) || statSync(schemaPath).size === 0) {
      fail('schema dump produced no output', 2);
    }
    if (!existsSync(dataPath) || statSync(dataPath).size === 0) {
      fail('data dump produced no output', 2);
    }
    run('tar archive', 'tar', ['-C', workdir, '-czf', archive, 'schema.sql', 'data.sql']);

    const passphrasePath = join(workdir, 'passphrase');
    const passphraseFd = openSync(passphrasePath, 'w', 0o600);
    writeFileSync(passphraseFd, encryptionKey);
    closeSync(passphraseFd);
    run(
      'gpg encrypt',
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
        passphrasePath,
        '--output',
        encrypted,
        archive,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    rmSync(passphrasePath, { force: true });

    const sha = run('sha256sum', 'sha256sum', [basename(encrypted)], {
      cwd: workdir,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    writeFileSync(checksum, sha.stdout, { mode: 0o600 });

    const objectName = `pto/${basename(encrypted)}`;
    run(
      'gcloud storage cp',
      'gcloud',
      ['storage', 'cp', encrypted, checksum, `gs://${bucket}/${objectName}`],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );

    if (args.keepLocal) {
      const localArchive = join(process.cwd(), basename(encrypted));
      const localChecksum = `${localArchive}.sha256`;
      copyFileSync(encrypted, localArchive);
      copyFileSync(checksum, localChecksum);
      chmodSync(localArchive, 0o600);
      chmodSync(localChecksum, 0o600);
      console.warn('WARNING: --keep-local retains a sensitive encrypted backup on disk.');
      console.log(`local copy: ${localArchive}`);
    }

    console.log(`Backup uploaded: gs://${bucket}/${objectName}`);
  } finally {
    cleanupWorkdir();
  }
}

try {
  main();
} catch (error) {
  const code = error instanceof ScriptError ? error.code : 2;
  const message = error instanceof Error ? error.message : 'Unknown backup failure';
  console.error(`error: ${message}`);
  process.exit(code);
}
