#!/usr/bin/env node
// Static checks for the Caddy -> nginx -> backend OCI production topology.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const nginx = readFileSync(resolve(root, 'frontend/nginx.conf'), 'utf8');
const caddy = readFileSync(resolve(root, 'Caddyfile'), 'utf8');
const compose = readFileSync(resolve(root, 'docker-compose.prod.yml'), 'utf8');
const indexHtml = readFileSync(resolve(root, 'frontend/index.html'), 'utf8');

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    console.error(`  FAIL  ${label}`);
    failures += 1;
  }
}

console.log('nginx security headers:');
check('Content-Security-Policy exists', /add_header\s+Content-Security-Policy\b/.test(nginx));
const cspHeader = nginx.match(/add_header\s+Content-Security-Policy\s+"([^"]+)"/)?.[1] ?? '';
check('CSP has no unsafe-inline scripts', !/script-src[^;]*unsafe-inline/.test(cspHeader));
check('CSP has the theme-init hash', /sha256-SHJBvKlfSMRvNsEa24Mn3AXIWJ9hqNP04VpSScxpKXU=/.test(nginx));
check('X-Content-Type-Options is nosniff', /X-Content-Type-Options\s+"nosniff"/.test(nginx));
check('Referrer-Policy is no-referrer', /Referrer-Policy\s+"no-referrer"/.test(nginx));
check('Permissions-Policy disables sensitive features', /Permissions-Policy\s+.*camera=\(\)/.test(nginx));
check('X-Frame-Options is DENY', /X-Frame-Options\s+"DENY"/.test(nginx));
check('nginx does not duplicate HSTS', !/add_header\s+Strict-Transport-Security/.test(nginx));

for (const route of ['auth', 'pto', 'holidays']) {
  const block = new RegExp(`location \\~ \\^/${route}[^\\{]*\\{[\\s\\S]*?\\n  \\}`);
  check(`${route} proxy forwards X-Forwarded-Proto`, block.test(nginx) && /X-Forwarded-Proto/.test(nginx.match(block)?.[0] ?? ''));
  check(`${route} proxy forwards X-Forwarded-Host`, block.test(nginx) && /X-Forwarded-Host/.test(nginx.match(block)?.[0] ?? ''));
}

console.log('\nCaddy topology:');
check('Caddy terminates HSTS', /Strict-Transport-Security\s+"max-age=31536000; includeSubDomains; preload"/.test(caddy));
check('Caddy proxies to nginx', /reverse_proxy\s+nginx:80/.test(caddy));
check('Caddy forwards X-Forwarded-For', /header_up X-Forwarded-For/.test(caddy));
check('Caddy forwards X-Forwarded-Proto', /header_up X-Forwarded-Proto/.test(caddy));
check('Caddy forwards X-Forwarded-Host', /header_up X-Forwarded-Host/.test(caddy));

console.log('\nCompose production contract:');
check('only Caddy publishes ports', (compose.match(/ports:/g) ?? []).length === 1);
check('Caddy publishes HTTP and HTTPS', /['"]80:80['"][\s\S]*?['"]443:443['"]/.test(compose));
check('database has a persistent volume', /pto_pgdata_prod:/.test(compose));
check('Caddy has persistent certificate volumes', /caddy_data:/.test(compose) && /caddy_config:/.test(compose));
check('backend uses exact HTTPS CORS origin', /CORS_ORIGIN: \$\{CORS_ORIGIN:\?/.test(compose));
check('backend uses secure lax host cookies', /COOKIE_SECURE: 'true'[\s\S]*?COOKIE_SAME_SITE: lax[\s\S]*?COOKIE_DOMAIN: ''/.test(compose));
check('backend uses the Upstash URL', /RATE_LIMIT_REDIS_URL: \$\{RATE_LIMIT_REDIS_URL:\?/.test(compose));
check('backend trusts Caddy and nginx', /TRUST_PROXY_HOPS: '2'/.test(compose));
check('production image bases are digest-pinned',
  /postgres:16-alpine@sha256:[0-9a-f]{64}/.test(compose) && /caddy:2-alpine@sha256:[0-9a-f]{64}/.test(compose));

const inlineScript = indexHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (inlineScript !== undefined) {
  const hash = createHash('sha256').update(inlineScript, 'utf8').digest('base64');
  check(`nginx contains index inline-script hash ${hash}`, nginx.includes(hash));
}

if (failures > 0) {
  console.error(`\n${failures} production configuration assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll production configuration assertions passed.');
