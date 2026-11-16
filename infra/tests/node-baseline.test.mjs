#!/usr/bin/env node
// Static checks for the supported Node.js runtime baseline.
//
// These assertions fail the build when a Node runtime can silently fall back
// to an unpatched 24.x patch level. They complement the executable runtime
// assertion in `node-runtime-check.mjs`, which runs against the real image.

import { readFileSync, readdirSync } from 'node:fs';
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

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    console.error(`  FAIL  ${label}`);
    failures += 1;
  }
}

const read = (relativePath) => readFileSync(resolve(root, relativePath), 'utf8');

console.log('Node.js runtime baseline:');
const pinned = read(VERSION_FILE).trim();
let pinnedVersion;
try {
  pinnedVersion = parseVersion(pinned);
  check(`.nvmrc parses as a semantic version (${pinned})`, true);
} catch (error) {
  check(`.nvmrc parses as a semantic version (${pinned})`, false);
  console.error(`         ${error instanceof Error ? error.message : error}`);
}

if (pinnedVersion) {
  check(
    `.nvmrc pins the supported major (${SUPPORTED_MAJOR})`,
    pinnedVersion.major === SUPPORTED_MAJOR,
  );
  check(
    `.nvmrc pins at least the minimum supported version (${MINIMUM_SUPPORTED_VERSION})`,
    compareVersions(pinned, MINIMUM_SUPPORTED_VERSION) >= 0,
  );
}

const digestPattern = /@sha256:[0-9a-f]{64}/;
const nodeImages = new Set();
const nodeTargets = new Set();
for (const dockerfile of ['backend/Dockerfile', 'frontend/Dockerfile']) {
  const content = read(dockerfile);
  const fromLines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('FROM node:'));
  check(`${dockerfile} declares at least one Node base image`, fromLines.length > 0);
  for (const line of fromLines) {
    nodeImages.add(line.split(/\s+/)[1]);
    const stage = /\sAS\s+(\S+)$/i.exec(line)?.[1];
    check(`${dockerfile} names its Node stage for executable CI checks`, Boolean(stage));
    if (stage) nodeTargets.add(`${dockerfile.split('/')[0]}:${stage}`);
    check(
      `${dockerfile} pins an immutable digest (${line.split(' ')[1] ?? line})`,
      digestPattern.test(line),
    );
    check(
      `${dockerfile} uses the .nvmrc Node version (${line.split(' ')[1] ?? line})`,
      line.includes(`node:${pinned}-alpine@`),
    );
  }
}
check('all Node stages use the same immutable image', nodeImages.size === 1);
const checkedTargets = new Set(
  (/for target in ([^\n;]+); do/.exec(read('.github/workflows/ci.yml'))?.[1] ?? '')
    .split(/\s+/)
    .filter(Boolean),
);
for (const target of nodeTargets) {
  check(`Docker smoke executes the actual ${target} Node stage`, checkedTargets.has(target));
}

const rootPackage = JSON.parse(read('package.json'));
const enginesFloor = String(rootPackage.engines?.node ?? '');
const floorMatch = /^>=\s*(\d+\.\d+\.\d+)$/.exec(enginesFloor);
check(`root package.json declares an engines.node floor (${enginesFloor})`, Boolean(floorMatch));
if (floorMatch) {
  check(
    `engines.node floor is at least ${MINIMUM_SUPPORTED_VERSION}`,
    compareVersions(floorMatch[1], MINIMUM_SUPPORTED_VERSION) >= 0,
  );
  check(
    `engines.node floor equals the .nvmrc version (${pinned})`,
    compareVersions(floorMatch[1], pinned) === 0,
  );
}
const lockfile = JSON.parse(read('package-lock.json'));
check(
  'package-lock.json root Node engine matches package.json',
  lockfile.packages?.['']?.engines?.node === enginesFloor,
);

const workflowDir = resolve(root, '.github/workflows');
const workflows = readdirSync(workflowDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => `.github/workflows/${name}`);
for (const workflow of workflows) {
  const content = read(workflow);
  // Workflows that provision a Node runtime must resolve it from `.nvmrc`, so
  // a cached runner can never silently fall back to an older 24.x patch level.
  if (content.includes('actions/setup-node')) {
    check(
      `${workflow} resolves the Node version from ${VERSION_FILE}`,
      content.includes(`node-version-file: '${VERSION_FILE}'`),
    );
  }
  check(
    `${workflow} does not pin a bare Node major version`,
    !/node-version:\s*\$\{\{\s*env\.NODE_VERSION\s*\}\}/.test(content) &&
      !/node-version:\s*'?24'?\s*$/m.test(content),
  );
  check(
    `${workflow} does not declare an unused NODE_VERSION variable`,
    !/^\s*NODE_VERSION:\s*'24'\s*$/m.test(content),
  );
}

// An empty `env:` mapping makes GitHub reject the whole workflow file before
// any job runs, which is reported only as a generic workflow error. The
// deployment-config CI job does not install dependencies, so this is detected
// with a text scan rather than a YAML parser.
function hasEmptyTopLevelEnv(content) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] !== 'env:') continue;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === '') continue;
      // A key at column 0 means the `env:` mapping had no entries.
      if (!/^\s/.test(line)) return true;
      break;
    }
  }
  return false;
}

for (const file of readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name))) {
  const path = `${workflowDir}/${file}`;
  check(
    `.github/workflows/${file} does not declare an empty env mapping`,
    !hasEmptyTopLevelEnv(readFileSync(path, 'utf8')),
  );
}

if (failures > 0) {
  console.error(`\n${failures} Node.js baseline assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll Node.js baseline assertions passed.');
