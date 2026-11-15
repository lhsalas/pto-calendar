import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MINIMUM_SUPPORTED_VERSION, compareVersions, parseVersion } from './node-version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pinned = readFileSync(resolve(root, '.nvmrc'), 'utf8').trim();
const { major, minor, patch } = parseVersion(pinned);
const newerPatch = `${major}.${minor}.${patch + 1}`;
const checker = resolve(root, 'infra/tests/node-runtime-check.mjs');
const run = (...args) => spawnSync(process.execPath, [checker, ...args], { encoding: 'utf8' });

test('the deliberate minimum rejects the superseded Node 24 security patches', () => {
  assert.equal(compareVersions(pinned, MINIMUM_SUPPORTED_VERSION) >= 0, true);
  for (const older of ['24.22.1', '24.22.2']) {
    assert.equal(compareVersions(older, MINIMUM_SUPPORTED_VERSION) < 0, true);
  }
});

test('version parsing accepts a runtime prefix and compares versions numerically', () => {
  assert.deepEqual(parseVersion(' v24.22.3\n'), { major: 24, minor: 22, patch: 3 });
  assert.equal(compareVersions('24.22.10', '24.22.3') > 0, true);
  for (const invalid of ['', '24', '24.22', '24.22.3-alpine', 'not-a-version']) {
    assert.throws(() => parseVersion(invalid), /Unparseable/);
  }
});

for (const actual of [pinned, `v${pinned}`]) {
  test(`runtime checker accepts the exact pin ${actual}`, () => {
    const result = run('--actual', actual);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /exact match/);
  });
}

test('runtime checker accepts an explicit floor only when it matches the pin', () => {
  const result = run('--actual', `v${pinned}`, '--floor', pinned);
  assert.equal(result.status, 0, result.stderr);
});

for (const actual of ['v24.22.1', 'v24.22.2', `v${newerPatch}`, 'v25.0.0', 'v26.0.0']) {
  test(`runtime checker rejects a stale, divergent, or other-major runtime: ${actual}`, () => {
    const result = run('--actual', actual);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must exactly match/);
  });
}

for (const floor of ['24.22.1', newerPatch, '26.0.0']) {
  test(`runtime checker cannot override the pin with --floor ${floor}`, () => {
    const result = run('--actual', `v${pinned}`, '--floor', floor);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must equal the .nvmrc baseline/);
  });
}

for (const args of [
  [],
  ['--actual'],
  ['--actual', 'not-a-version'],
  ['--actual', `v${pinned}`, '--floor'],
  ['--actual', `v${pinned}`, '--floor', 'not-a-version'],
  ['--unexpected'],
]) {
  test(`runtime checker fails closed on invalid arguments ${JSON.stringify(args)}`, () => {
    const result = run(...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /error:/);
  });
}

test('runtime checker documents its arguments', () => {
  const result = run('--help');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
});
