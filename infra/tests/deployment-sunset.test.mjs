#!/usr/bin/env node
// Retirement guard: OCI is the only supported production deployment. This
// check does not access GitHub settings, cloud resources, or secret values.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const retired = [
  '.github/workflows/deploy.yml',
  '.github/workflows/deploy-backend.yml',
  '.github/workflows/deploy-frontend.yml',
  '.github/workflows/deploy-secrets.yml',
  '.github/workflows/database-backup.yml',
  'firebase.json',
  'bin/render-firebase-config.mjs',
  'bin/backup-db.mjs',
  'infra/gcp/backup-lifecycle.json',
  'docs/gcp-firebase-deploy.md',
  'docs/gcp-firebase-cutover-drill.md',
  'docs/gcp-firebase-custom-domain.md',
];
for (const path of retired) {
  assert.equal(existsSync(resolve(root, path)), false, `${path} must remain retired`);
}

const workflowDir = resolve(root, '.github/workflows');
for (const file of readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name))) {
  const workflow = readFileSync(resolve(workflowDir, file), 'utf8');
  assert.doesNotMatch(
    workflow,
    /\b(?:GCP_|FIREBASE_)[A-Z0-9_]+\b|\bBACKUP_BUCKET\b|\bgcloud\b|firebase-tools|google-github-actions\/|supabase\/setup-cli/,
    `${file} must not depend on retired deployment credentials or tools`,
  );
}

const restore = readFileSync(resolve(root, 'bin/restore-backup.mjs'), 'utf8');
assert.doesNotMatch(restore, /\bgcloud\b|\bBACKUP_BUCKET\b|--bucket/);
assert.match(restore, /--allow-disposable-target/);
for (const path of [
  '.github/workflows/ci.yml',
  '.github/workflows/deploy-oci.yml',
  '.github/workflows/opencode.yml',
  'infra/deploy/backup.sh',
  'infra/deploy/restore-oci.sh',
  'infra/deploy/sql-sanitize-schema.sed',
  'infra/deploy/sql-sanitize-data.sed',
  'infra/db/pto-calendar-backup.timer',
  'backend/tests/integration/backupRestore.test.ts',
  'docker-compose.app.yml',
]) {
  assert.equal(existsSync(resolve(root, path)), true, `${path} must remain supported`);
}
console.log('Deployment retirement and OCI recovery isolation checks passed.');
