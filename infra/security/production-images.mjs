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

export const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/-]*:[a-z0-9][a-z0-9._-]*@sha256:[0-9a-f]{64}$/;

export function productionImages(directory = root) {
  const images = new Set();
  for (const source of SOURCES) {
    const content = readFileSync(resolve(directory, source), 'utf8');
    let references = 0;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!/^image:|^FROM\b/i.test(trimmed)) continue;
      const reference =
        /^image:\s*['"]?([^'"\s]+)['"]?\s*(?:#.*)?$/.exec(trimmed)?.[1] ??
        /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+\S+)?\s*(?:#.*)?$/i.exec(trimmed)?.[1];
      if (!reference || !IMAGE_PATTERN.test(reference)) {
        throw new Error(`production image must be explicitly digest-pinned: ${source}: ${trimmed}`);
      }
      images.add(reference);
      references += 1;
    }
    if (references === 0) throw new Error(`no production image references in ${source}`);
  }
  if (images.size === 0) throw new Error('no pinned production images were found');
  return [...images].sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    for (const image of productionImages()) console.log(image);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
