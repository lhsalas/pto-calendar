#!/usr/bin/env node
// Executable runtime-version assertion.
//
// The static checks in `node-baseline.test.mjs` only prove that the
// Dockerfiles reference the expected image. This command compares a runtime
// that actually reports its version (for example `node -p process.version`
// inside a running container) against the required floor, so a stale or
// mismatched image fails the build.
//
// Usage:
//   node infra/tests/node-runtime-check.mjs --actual v24.22.1 --floor 24.22.1
//
// Exit codes:
//   0  the actual runtime is at least the floor
//   1  the actual runtime is older than the floor, or the arguments are invalid

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MINIMUM_SUPPORTED_VERSION,
  VERSION_FILE,
  compareVersions,
  isAtLeast,
} from './node-version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '--actual' || arg === '--floor') && i + 1 < argv.length) {
      args[arg.slice(2)] = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node infra/tests/node-runtime-check.mjs --actual <version> [--floor <version>]');
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

if (!isAtLeast(actual, floor)) {
  console.error(
    `error: Node.js runtime ${actual} is older than the required floor ${floor}` +
      ` (minimum supported: ${MINIMUM_SUPPORTED_VERSION})`,
  );
  process.exit(1);
}

const comparison = compareVersions(actual, floor);
console.log(
  `Node.js runtime ${actual} satisfies the required floor ${floor}` +
    (comparison === 0 ? ' (exact match)' : ' (newer)'),
);
