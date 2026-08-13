#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const origin = process.env.CLOUD_RUN_ORIGIN;
if (!origin) {
  throw new Error('CLOUD_RUN_ORIGIN is required');
}

const parsedOrigin = new URL(origin);
if (parsedOrigin.protocol !== 'https:' || parsedOrigin.pathname !== '/') {
  throw new Error('CLOUD_RUN_ORIGIN must be an HTTPS origin');
}

const config = JSON.parse(readFileSync('firebase.json', 'utf8'));
const cspHeader = config.hosting?.headers
  ?.flatMap((entry) => entry.headers ?? [])
  .find((header) => header.key === 'Content-Security-Policy');

if (!cspHeader || !cspHeader.value.includes('__CLOUD_RUN_API_ORIGIN__')) {
  throw new Error('firebase.json is missing the Cloud Run CSP placeholder');
}

cspHeader.value = cspHeader.value.replaceAll('__CLOUD_RUN_API_ORIGIN__', parsedOrigin.origin);
if (cspHeader.value.includes('*.a.run.app')) {
  throw new Error('rendered Firebase CSP must not contain a Cloud Run wildcard');
}

writeFileSync('firebase.deploy.json', `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
