#!/usr/bin/env node
// Static-content assertions for the production nginx + Caddy config.
// Verifies the documented headers and topology without needing a live stack.
// Run with `node infra/tests/prod-headers.test.mjs` from the repo root.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

const nginx = readFileSync(resolve(root, 'frontend/nginx.conf'), 'utf8');
const caddyfile = readFileSync(resolve(root, 'Caddyfile'), 'utf8');
const compose = readFileSync(resolve(root, 'docker-compose.prod.yml'), 'utf8');
const indexHtml = readFileSync(resolve(root, 'frontend/index.html'), 'utf8');

const REQUIRED_NGINX_HEADERS = [
  /add_header\s+Content-Security-Policy\b/,
  /add_header\s+X-Content-Type-Options\s+"nosniff"/,
  /add_header\s+Referrer-Policy\s+"strict-origin-when-cross-origin"/,
  /add_header\s+Permissions-Policy\s+.*\bcamera=\(\)/,
  /add_header\s+X-Frame-Options\s+"DENY"/,
  /default-src\s+'self'/,
  /frame-ancestors\s+'none'/,
  /object-src\s+'none'/,
  /base-uri\s+'none'/,
  /script-src\s+'self'\s+'sha256-SHJBvKlfSMRvNsEa24Mn3AXIWJ9hqNP04VpSScxpKXU='/,
];

const PROXY_PASSES_WITH_FORWARDED_PROTO = [
  /location\s+~\s+\^?\/auth\([^)]*\)\s*\{[\s\S]*?proxy_set_header\s+X-Forwarded-Proto\s+\$scheme;/,
  /location\s+~\s+\^?\/pto\([^)]*\)\s*\{[\s\S]*?proxy_set_header\s+X-Forwarded-Proto\s+\$scheme;/,
  /location\s+=\s+\/health\s*\{[\s\S]*?proxy_set_header\s+X-Forwarded-Proto\s+\$scheme;/,
  /location\s+=\s+\/ready\s*\{[\s\S]*?proxy_set_header\s+X-Forwarded-Proto\s+\$scheme;/,
];

const NO_HSTS_IN_NGINX = /add_header\s+Strict-Transport-Security\b/;

const CADDY_REFS = [
  /Strict-Transport-Security\s+"max-age=31536000; includeSubDomains; preload"/,
  /reverse_proxy\s+nginx:80\b/,
  /header_up\s+X-Forwarded-For\b/,
  /header_up\s+X-Forwarded-Proto\b/,
  /header_up\s+X-Forwarded-Host\b/,
  /\{\$HOST:localhost\}/,
  /\{\$ACME_EMAIL:ops@example\.com\}/,
];

const COMPOSE_REFS = [
  /image:\s+caddy:2-alpine\b/,
  /-\s*['"]80:80['"]/,
  /-\s*['"]443:443['"]/,
  /\$\{HOST:\?HOST is required\}/,
  /\$\{ACME_EMAIL:\?ACME_EMAIL is required\}/,
  /\$\{SESSION_SECRET:\?SESSION_SECRET is required\}/,
  /\$\{CORS_ORIGIN:\?CORS_ORIGIN is required\}/,
  /\$\{DB_PASSWORD:\?DB_PASSWORD is required\}/,
  /TRUST_PROXY_HOPS:\s+['"]2['"]/,
  /COOKIE_SECURE:\s+['"]true['"]/,
];

const COMPOSE_MUST = [
  /^\s+migrate:\s*\n\s+build:\s*\n\s+context:\s+\.\s*\n\s+dockerfile:\s+backend\/Dockerfile/m,
  /^\s+nginx:\s*\n\s+build:\s*\n\s+context:\s+\.\s*\n\s+dockerfile:\s+frontend\/Dockerfile/m,
];

const COMPOSE_MUST_NOT = [
  /^migrate:\s*\n\s+image:\s+node:20-alpine/m,
  /pto:pto@/,
  /^\s+frontend-build:/m,
  /^volumes:\s*\n[\s\S]*?^\s+frontend_dist:/m,
  /^volumes:\s*\n[\s\S]*?^\s+backend_node_modules:/m,
];

let failed = 0;
function check(label, re, source) {
  if (re.test(source)) {
    console.log(`  ok    ${label}`);
  } else {
    console.error(`  FAIL  ${label}`);
    console.error(`        pattern: ${re}`);
    failed++;
  }
}

function checkAbsent(label, re, source) {
  if (!re.test(source)) {
    console.log(`  ok    ${label}`);
  } else {
    console.error(`  FAIL  ${label}`);
    console.error(`        pattern (must not match): ${re}`);
    failed++;
  }
}

console.log('nginx.conf headers and CSP:');
for (const re of REQUIRED_NGINX_HEADERS) check(`  ${re}`, re, nginx);
console.log('nginx.conf proxy_pass blocks forward X-Forwarded-Proto/Host:');
for (const re of PROXY_PASSES_WITH_FORWARDED_PROTO)
  check(`  ${re}`, re, nginx);
console.log('nginx.conf does NOT duplicate HSTS:');
checkAbsent('  no Strict-Transport-Security directive in nginx.conf', NO_HSTS_IN_NGINX, nginx);

console.log('Caddyfile:');
for (const re of CADDY_REFS) check(`  ${re}`, re, caddyfile);

console.log('docker-compose.prod.yml:');
for (const re of COMPOSE_REFS) check(`  ${re}`, re, compose);
console.log('docker-compose.prod.yml required service shapes:');
for (const re of COMPOSE_MUST) check(`  ${re}`, re, compose);
console.log('docker-compose.prod.yml forbidden patterns absent:');
for (const re of COMPOSE_MUST_NOT) checkAbsent(`  ${re}`, re, compose);

console.log('index.html inline script hash matches nginx.conf:');
const inlineScriptMatch = indexHtml.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(inlineScriptMatch, 'expected an inline <script> in index.html');
const inlineScript = inlineScriptMatch[1];
const { createHash } = await import('node:crypto');
const hash = createHash('sha256').update(inlineScript, 'utf8').digest('base64');
console.log(`  ok    inline script hash: ${hash}`);
if (!nginx.includes(hash)) {
  console.error(`  FAIL  nginx.conf does not contain inline script hash ${hash}`);
  failed++;
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll prod-config assertions passed.');
