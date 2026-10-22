#!/usr/bin/env node
// Print the pinned production container images that the release pipeline
// scans, so the scan list cannot drift from what is actually deployed.
//
// The references are read from the Dockerfiles and the production compose
// file, and every one of them must be pinned by digest.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SOURCES = [
  'backend/Dockerfile',
  'frontend/Dockerfile',
  'docker-compose.prod.yml',
];

const IMAGE_PATTERN = /([a-z0-9][a-z0-9._/-]*:[a-z0-9][a-z0-9._-]*@sha256:[0-9a-f]{64})/g;

const images = new Set();
const unpinned = [];

for (const source of SOURCES) {
  const content = readFileSync(resolve(root, source), 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('image:') && !trimmed.startsWith('FROM ')) continue;
    const match = IMAGE_PATTERN.exec(trimmed);
    IMAGE_PATTERN.lastIndex = 0;
    if (match) {
      images.add(match[1]);
      continue;
    }
    // A line that names an image but is not digest-pinned is a finding of its own.
    const unpinnedRef = /image:\s*([^\s@]+)\s*$/.exec(trimmed) ?? /FROM\s+([^\s@]+)\s*$/.exec(trimmed);
    if (unpinnedRef && !unpinnedRef[1].includes('$')) {
      unpinned.push(`${source}: ${unpinnedRef[1]}`);
    }
  }
}

if (unpinned.length > 0) {
  console.error('error: production images must be pinned by digest:');
  for (const entry of unpinned) console.error(`  ${entry}`);
  process.exit(1);
}

if (images.size === 0) {
  console.error('error: no pinned production images were found');
  process.exit(1);
}

for (const image of [...images].sort()) {
  console.log(image);
}
