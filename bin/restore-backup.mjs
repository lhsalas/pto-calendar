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
//     [--bucket <name>] [--keep-local]
//
// Exit codes:
//   0  success
//   1  user error (missing argument, missing env)
//   2  tool error (gpg/tar/psql/gcloud exit non-zero)
//   3  checksum mismatch

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  copyFileSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

function fail(message, code = 1) {
  console.error(`error: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { archive: null, bucket: null, keepLocal: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--archive' && i + 1 < argv.length) {
      args.archive = argv[++i];
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
    fail(`${label} failed to start: ${result.error.message}`, 2);
  }
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString() : '';
    const stdout = result.stdout ? result.stdout.toString() : '';
    fail(`${label} exited with status ${result.status}\n${stderr}\n${stdout}`.trim(), 2);
  }
  return result;
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

  requireTool('gpg', 'Install gnupg.');
  requireTool('tar', 'Install tar.');
  requireTool('sha256sum', 'Install coreutils.');
  requireTool('gcloud', 'Install the Google Cloud CLI and run `gcloud auth login`.');
  requireTool('psql', 'Install postgresql-client (provides psql).');

  const workdir = mkdtempSync(join(tmpdir(), 'pto-restore-'));
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

    if (!existsSync(archivePath) || statSync(archivePath).size === 0) {
      fail('decrypted archive is missing or empty', 2);
    }

    run('tar extract', 'tar', ['-C', workdir, '-xzf', archivePath]);
    rmSync(archivePath, { force: true });

    const schemaPath = join(workdir, 'schema.sql');
    const dataPath = join(workdir, 'data.sql');
    if (!existsSync(schemaPath)) {
      fail(`schema.sql missing after extraction`, 2);
    }
    if (!existsSync(dataPath)) {
      fail(`data.sql missing after extraction`, 2);
    }

    if (args.keepLocal) {
      const cwd = process.cwd();
      copyFileSync(schemaPath, join(cwd, 'schema.sql'));
      copyFileSync(dataPath, join(cwd, 'data.sql'));
      console.log(`local copies: ${cwd}/schema.sql and ${cwd}/data.sql`);
    }

    applySqlFile(schemaPath, targetUrl);
    applySqlFile(dataPath, targetUrl);

    console.log(`Restore complete: applied schema.sql and data.sql to target.`);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

main();
