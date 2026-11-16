#!/usr/bin/env node
// Executable runtime-version assertion.
//
// The static checks in `node-baseline.test.mjs` only prove that the
// Dockerfiles reference the expected image. This command compares a runtime
// that actually reports its version (for example `node -p process.version`
// inside a running container) against the exact pinned baseline, so a stale or
// mismatched image fails the build.
//
// Usage:
//   node infra/tests/node-runtime-check.mjs --actual v24.22.3 --floor 24.22.3
//
// Exit codes:
//   0  the actual runtime exactly matches the supported pin
//   1  the runtime or requested floor differs from the pin, or arguments are invalid

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MINIMUM_SUPPORTED_VERSION,
  SUPPORTED_MAJOR,
  VERSION_FILE,
  compareVersions,
  parseVersion,
} from './node-version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '--actual' || arg === '--floor') && i + 1 < argv.length) {
      args[arg.slice(2)] = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node infra/tests/node-runtime-check.mjs --actual <version> [--floor <version>]',
      );
      process.exit(0);
    } else {
      console.error(`error: unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const actual = (args.actual ?? '').trim();
if (!actual) {
  console.error('error: --actual <version> is required');
  process.exit(1);
}

const pinnedFloor = readFileSync(resolve(root, VERSION_FILE), 'utf8').trim();
const floor = (args.floor ?? pinnedFloor).trim();

try {
  if (
    parseVersion(pinnedFloor).major !== SUPPORTED_MAJOR ||
    compareVersions(pinnedFloor, MINIMUM_SUPPORTED_VERSION) < 0
  ) {
    throw new Error(`unsupported .nvmrc baseline: ${pinnedFloor}`);
  }
  if (compareVersions(floor, pinnedFloor) !== 0) {
    throw new Error(`requested floor ${floor} must equal the .nvmrc baseline ${pinnedFloor}`);
  }
  if (compareVersions(actual, pinnedFloor) !== 0) {
    throw new Error(
      `Node.js runtime ${actual} must exactly match the .nvmrc baseline ${pinnedFloor}`,
    );
  }
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

console.log(
  `Node.js runtime ${actual} matches the supported baseline ${pinnedFloor} (exact match)`,
);
