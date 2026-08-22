#!/usr/bin/env node
// Static checks for the OCI deployment scripts, systemd units, and production
// Compose contract. These checks intentionally require no Docker daemon.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const files = {
  setup: resolve(root, 'infra/deploy/setup.sh'),
  deploy: resolve(root, 'infra/deploy/deploy.sh'),
  backup: resolve(root, 'infra/deploy/backup.sh'),
  restore: resolve(root, 'infra/deploy/restore-oci.sh'),
  service: resolve(root, 'infra/db/pto-calendar-backup.service'),
  timer: resolve(root, 'infra/db/pto-calendar-backup.timer'),
  compose: resolve(root, 'docker-compose.prod.yml'),
  caddy: resolve(root, 'Caddyfile'),
  deployDocs: resolve(root, 'docs/deploy.md'),
};

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    console.error(`  FAIL  ${label}`);
    failures += 1;
  }
}

const scripts = [files.setup, files.deploy, files.backup, files.restore];
console.log('OCI scripts:');
for (const file of scripts) {
  const label = file.replace(`${root}/`, '');
  check(`${label} exists`, existsSync(file));
  if (!existsSync(file)) continue;
  check(`${label} parses`, (() => {
    try {
      execFileSync('bash', ['-n', file], { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  })());
  const body = readFileSync(file, 'utf8');
  check(`${label} uses strict mode`, /^set -Eeuo pipefail$/m.test(body));
  check(`${label} is executable`, (statSync(file).mode & 0o111) !== 0);
}

const setup = readFileSync(files.setup, 'utf8');
const deploy = readFileSync(files.deploy, 'utf8');
const backup = readFileSync(files.backup, 'utf8');
const restore = readFileSync(files.restore, 'utf8');
const compose = readFileSync(files.compose, 'utf8');
const caddy = readFileSync(files.caddy, 'utf8');

console.log('\nOCI runtime contract:');
check('Compose uses PostgreSQL 16 digest', /postgres:16-alpine@sha256:[0-9a-f]{64}/.test(compose));
check('Compose uses Caddy digest', /caddy:2-alpine@sha256:[0-9a-f]{64}/.test(compose));
check('Compose trusts exactly two proxy hops', /TRUST_PROXY_HOPS:\s+['"]2['"]/.test(compose));
check('Compose requires Upstash Redis URL', /RATE_LIMIT_REDIS_URL:\s+\$\{RATE_LIMIT_REDIS_URL:\?/.test(compose));
check('Compose uses secure lax cookies', /COOKIE_SECURE:\s+['"]true['"][\s\S]*?COOKIE_SAME_SITE:\s+lax/.test(compose));
check('Compose does not publish database ports', !/['"](?:127\.0\.0\.1:)?5432:5432['"]/.test(compose));
check('Compose does not publish Redis ports', !/['"](?:127\.0\.0\.1:)?6379:6379['"]/.test(compose));
check('Compose has a separate bootstrap profile', /profiles:\s*\n\s+- bootstrap/.test(compose));
check('bootstrap targets the full build image', /bootstrap:[\s\S]*?target: build/.test(compose));
check('Caddy owns HSTS', /Strict-Transport-Security/.test(caddy));
check('Caddy forwards the original proxy metadata',
  /header_up X-Forwarded-For[\s\S]*?header_up X-Forwarded-Proto[\s\S]*?header_up X-Forwarded-Host/.test(caddy));

console.log('\nRestore and secret-safety contract:');
check('OCI restore requires explicit production confirmation',
  /--confirm-production-target/.test(restore));
check('OCI restore rejects disposable-target bypass terminology',
  !/allow-disposable-target/.test(restore));
check('OCI restore validates archive basename', /basename.*ARCHIVE|ARCHIVE.*basename/.test(restore));
check('OCI restore verifies a strict checksum', /sha256sum --check --strict/.test(restore));
check('OCI restore limits archive members', /archive must contain exactly schema\.sql and data\.sql/.test(restore));
check('OCI restore cleans a temporary working directory', /trap cleanup EXIT INT TERM/.test(restore));
check('OCI backup encrypts with AES-256', /--cipher-algo AES256/.test(backup));
check('OCI backup uses instance-principal Object Storage auth', /--auth instance_principal/.test(backup));
check('OCI backup cleans its temporary working directory', /trap cleanup EXIT INT TERM/.test(backup));
check('deployment requires an exact ref', /usage: \$0 <release-ref>/.test(deploy));
check('deployment can verify an expected commit SHA', /EXPECTED_SHA/.test(deploy));
check('setup requires a release ref', /require_env RELEASE_REF/.test(setup));
check('setup never enables insecure production cookies', /COOKIE_SECURE=true/.test(setup) && !/INSECURE_COOKIES_ALLOWED=true/.test(setup));
check('runtime scripts do not sudo back into deploy', !/sudo -u deploy/.test(`${deploy}\n${backup}`));

console.log('\nSystemd units:');
for (const [name, file] of [['service', files.service], ['timer', files.timer]]) {
  check(`${name} unit exists`, existsSync(file));
  if (!existsSync(file)) continue;
  const body = readFileSync(file, 'utf8');
  check(`${name} has [Unit]`, /^\[Unit\]$/m.test(body));
  check(`${name} has [Install]`, /^\[Install\]$/m.test(body));
  if (name === 'service') {
    check('service runs as deploy', /^User=deploy$/m.test(body));
    check('service runs backup.sh', /ExecStart=\/opt\/pto-calendar\/infra\/deploy\/backup\.sh/.test(body));
  } else {
    check('timer runs daily in UTC', /OnCalendar=\*-\*-\* 03:00:00 UTC/.test(body));
    check('timer catches up after downtime', /^Persistent=true$/m.test(body));
  }
}

check('OCI deployment docs exist', existsSync(files.deployDocs));
if (existsSync(files.deployDocs)) {
  const docs = readFileSync(files.deployDocs, 'utf8');
  for (const section of [
    /^## 1\. Provision the OCI VM/m,
    /^## 2\. First-time setup/m,
    /^## 3\. Deploying releases/m,
    /^## 4\. Supabase to OCI database migration/m,
    /^## 5\. Backups and restore/m,
    /^## 6\. Disaster recovery and rollback/m,
  ]) {
    check(`docs section ${section}`, section.test(docs));
  }
}

if (failures > 0) {
  console.error(`\n${failures} deployment assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll OCI deployment assertions passed.');
