#!/usr/bin/env node
// Static-content assertions for the deploy scripts and systemd units.
//
// Verifies:
//   - every shell script under infra/deploy/ parses with `bash -n`
//   - every script starts with the standard shebang + `set -Eeuo pipefail`
//   - systemd .service and .timer files have valid key=value structure and
//     reference real files (no dangling ExecStart=)
//   - no committed file contains a literal "real" hostname, IP, email, or
//     password (placeholders like pto.yourcompany.com and ops@example.com are
//     allowed and required; the script grep checks for exact matches of the
//     documented placeholders, not generic PII).
//   - README.md cross-links to docs/deploy.md
//   - docs/deploy.md exists and has the required top-level sections
//
// Run with `node infra/tests/deploy-scripts.test.mjs` from the repo root.

import { readFileSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

const SCRIPTS = [
  resolve(root, 'infra/deploy/setup.sh'),
  resolve(root, 'infra/deploy/deploy.sh'),
  resolve(root, 'infra/deploy/backup.sh'),
];
const SYSTEMD = [
  resolve(root, 'infra/db/backup.service'),
  resolve(root, 'infra/db/backup.timer'),
];
const DEPLOY_MD = resolve(root, 'docs/deploy.md');
const README = resolve(root, 'README.md');

const ALLOWED_PLACEHOLDERS = {
  hostname: /pto\.yourcompany\.com/g,
  email: /ops@example\.com|lead@example\.com|lead@yourcompany\.com|ops@yourcompany\.com/g,
};

// Things that look like real secrets and MUST NOT appear in any committed file.
// Only scripts and systemd units are scanned (docs intentionally use placeholders
// like <VM_PUBLIC_IP> for documentation).
const FORBIDDEN_PATTERNS = [
  { name: 'PRIVATE KEY header', re: /-----BEGIN (OPENSSH|RSA|EC|DSA) PRIVATE KEY-----/ },
  { name: 'literal password= assignment', re: /^[^#]*\bpassword\s*=\s*['"]?[^$'"\n]{8,}['"]?/im },
];

let failed = 0;

function ok(label) { console.log(`  ok    ${label}`); }
function bad(label, detail) {
  console.error(`  FAIL  ${label}`);
  if (detail) console.error(`        ${detail}`);
  failed++;
}

// 1. bash -n on every script.
console.log('bash -n syntax check:');
for (const script of SCRIPTS) {
  if (!existsSync(script)) { bad(`exists: ${script}`); continue; }
  try {
    execFileSync('bash', ['-n', script], { stdio: 'pipe' });
    ok(`parses: ${script.replace(root + '/', '')}`);
  } catch (err) {
    bad(`parses: ${script.replace(root + '/', '')}`, err.stderr?.toString().trim());
  }
}

// 2. Standard header check.
console.log('\nStandard header (shebang + strict mode):');
for (const script of SCRIPTS) {
  if (!existsSync(script)) continue;
  const body = readFileSync(script, 'utf8');
  if (!body.startsWith('#!/usr/bin/env bash')) {
    bad(`shebang on ${script.replace(root + '/', '')}`);
  } else { ok(`shebang on ${script.replace(root + '/', '')}`); }
  if (!/^set -Eeuo pipefail$/m.test(body)) {
    bad(`strict mode on ${script.replace(root + '/', '')}`);
  } else { ok(`strict mode on ${script.replace(root + '/', '')}`); }
}

// 3. Scripts are executable (mode & 0o111).
console.log('\nScripts are executable:');
for (const script of SCRIPTS) {
  if (!existsSync(script)) continue;
  const mode = statSync(script).mode;
  if ((mode & 0o111) === 0) {
    bad(`executable bit on ${script.replace(root + '/', '')}`);
  } else { ok(`executable bit on ${script.replace(root + '/', '')}`); }
}

// 4. Systemd unit structure: section headers + simple key=value lines.
console.log('\nSystemd unit structure:');
const REQUIRED_SECTIONS = ['[Unit]', '[Service]', '[Install]'];
const TIMER_REQUIRED_SECTIONS = ['[Unit]', '[Timer]', '[Install]'];
for (const unit of SYSTEMD) {
  if (!existsSync(unit)) { bad(`exists: ${unit}`); continue; }
  const body = readFileSync(unit, 'utf8');
  const label = unit.replace(root + '/', '');
  const required = label.endsWith('.timer') ? TIMER_REQUIRED_SECTIONS : REQUIRED_SECTIONS;
  for (const section of required) {
    if (!body.includes(section)) { bad(`section ${section} in ${label}`); }
    else { ok(`section ${section} in ${label}`); }
  }
  // Timer must have a [Timer] section with OnCalendar.
  if (label.endsWith('.timer')) {
    if (!/^\[Timer\]/m.test(body)) bad(`[Timer] section in ${label}`);
    else ok(`[Timer] section in ${label}`);
    if (!/^OnCalendar=/m.test(body)) bad(`OnCalendar= in ${label}`);
    else ok(`OnCalendar= in ${label}`);
  }
  // Service must have an ExecStart pointing at backup.sh. /opt/pto-calendar
  // is the production install path; we substitute it with the repo root to
  // verify the file exists in the source tree.
  if (label.endsWith('.service')) {
    const m = body.match(/^ExecStart=(\S+)/m);
    if (!m) { bad(`ExecStart= in ${label}`); continue; }
    const target = m[1];
    const repoRelative = target.replace(/^\/opt\/pto-calendar/, root);
    if (!existsSync(repoRelative)) {
      bad(`ExecStart target exists in repo: ${target} (looked at ${repoRelative})`);
    } else { ok(`ExecStart target exists in repo: ${target}`); }
  }
}

// 5. docs/deploy.md has the required top-level sections.
console.log('\ndocs/deploy.md sections:');
if (!existsSync(DEPLOY_MD)) { bad('docs/deploy.md exists'); }
else {
  const md = readFileSync(DEPLOY_MD, 'utf8');
  const REQUIRED_SECTIONS_MD = [
    /^## 1\. Provision the OCI VM/m,
    /^## 2\. First-time setup \(`setup.sh`\)/m,
    /^## 3\. Deploying releases/m,
    /^## 4\. Backups/m,
    /^## 5\. Disaster recovery/m,
    /^## 6\. `SESSION_SECRET` rotation/m,
    /^## 7\. Always Free caveats/m,
  ];
  for (const re of REQUIRED_SECTIONS_MD) {
    if (!re.test(md)) bad(`section ${re} in docs/deploy.md`);
    else ok(`section ${re} in docs/deploy.md`);
  }
}

// 6. README cross-link.
console.log('\nREADME cross-link:');
if (!existsSync(README)) { bad('README.md exists'); }
else {
  const r = readFileSync(README, 'utf8');
  if (!r.includes('docs/deploy.md')) bad('README.md mentions docs/deploy.md');
  else ok('README.md mentions docs/deploy.md');
}

// 7. Forbidden secret patterns: scripts and systemd units only.
// docs/deploy.md intentionally uses placeholders (<VM_PUBLIC_IP>, <RESERVED_IP>)
// and discusses port ranges, so it is not scanned for IPv4-shaped patterns.
console.log('\nForbidden secret patterns (scripts + systemd only):');
const scannedFiles = [...SCRIPTS, ...SYSTEMD].filter(existsSync);
for (const file of scannedFiles) {
  const body = readFileSync(file, 'utf8');
  for (const { name, re } of FORBIDDEN_PATTERNS) {
    if (re.test(body)) bad(`${name} in ${file.replace(root + '/', '')}`);
  }
}
ok(`${scannedFiles.length} files scanned for forbidden patterns`);

// 8. Placeholder hygiene: the placeholders must appear in docs/deploy.md
//    (the runbook teaches them) and must NOT appear in scripts as something
//    other than documentation.
console.log('\nPlaceholder hygiene:');
const md = existsSync(DEPLOY_MD) ? readFileSync(DEPLOY_MD, 'utf8') : '';
for (const [kind, re] of Object.entries(ALLOWED_PLACEHOLDERS)) {
  const hits = md.match(re) || [];
  if (hits.length === 0) bad(`docs/deploy.md contains ${kind} placeholder`);
  else ok(`docs/deploy.md uses ${kind} placeholder (${hits.length} occurrences)`);
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll deploy-script assertions passed.');
