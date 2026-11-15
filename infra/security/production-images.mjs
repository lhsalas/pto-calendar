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

const SOURCES = ['backend/Dockerfile', 'frontend/Dockerfile', 'docker-compose.prod.yml'];

export const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/-]*:[a-z0-9][a-z0-9._-]*@sha256:[0-9a-f]{64}$/;

function composeImage(line, source) {
  if (!line || line.startsWith('#')) return;
  // Deliberately support only the block mappings/scalar lists used here.
  // Reject flow/JSON, quoted or explicit keys, aliases, tags and imported
  // service definitions instead of silently missing an image inside them.
  const mapping = /^([a-zA-Z_][\w.-]*):(?:\s+(.*))?$/.exec(line);
  const sequence = /^-\s+(.+)$/.exec(line);
  const value = mapping?.[2] ?? sequence?.[1] ?? '';
  if (
    (!mapping && !sequence) ||
    /^(?:include|extends)$/.test(mapping?.[1] ?? '') ||
    /^[\[{&*!|>?]/.test(value) ||
    (sequence && /^[^'"]+:\s/.test(value))
  ) {
    throw new Error(`unsupported production Compose syntax: ${source}: ${line}`);
  }
  if (mapping?.[1] !== 'image') return;
  // Quotes must match; image references are literal and digest-pinned.
  const scalar = /^(?:'([^']+)'|"([^"]+)"|([^'"\s]+))\s*(?:#.*)?$/.exec(value);
  return scalar?.[1] ?? scalar?.[2] ?? scalar?.[3] ?? '';
}

export function productionImages(directory = root) {
  const images = new Set();
  for (const source of SOURCES) {
    const content = readFileSync(resolve(directory, source), 'utf8');
    let references = 0;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      let reference;
      if (source.endsWith('.yml')) {
        reference = composeImage(trimmed, source);
        if (reference === undefined) continue;
      } else {
        if (!/^FROM\b/i.test(trimmed)) continue;
        reference = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+\S+)?\s*(?:#.*)?$/i.exec(
          trimmed,
        )?.[1];
      }
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
