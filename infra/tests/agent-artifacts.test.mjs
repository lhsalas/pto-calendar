#!/usr/bin/env node
// Focused checks for the private agent packaging engine (#265).
//
// These run after the workspace build as the first half of
// `npm run agent:pack:check`. They never modify the checkout: every positive
// or negative fixture is created in a private temporary directory. The
// positive case spawns the real pack entry; negatives exercise the inventory,
// path, npm-configuration, archive and cleanup boundaries directly.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PackError,
  assertAllowedArtifactPath,
  assertNoNpmrc,
  assertTrustedDirectoryChain,
  captureOwnedDirectory,
  collectRepositoryRoots,
  createScratchArea,
  isInside,
  parseChecksums,
  prepareOutputDirectory,
  readSourceArtifact,
  removeOwnedDirectory,
  runCommand,
  sha256Buffer,
  verifyArchive,
  verifyChecksums,
  walkTree,
} from '../agent-artifacts/bundle-safety.mjs';
import {
  REVIEWED_ARTIFACT_VERSION,
  assertCompiledInventory,
  assertSourceInventory,
  reviewedCompiledMembers,
  reviewedSourceMembers,
} from '../agent-artifacts/inventory.mjs';
import { buildConsumerLock } from '../agent-artifacts/lock-graph.mjs';
import { packBundle, stagePackageInputs } from '../agent-artifacts/pack.mjs';
import { compareSlotSnapshots, snapshotSlotTree } from '../agent-artifacts/slot-snapshot.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACK_ENTRY = join(ROOT, 'infra', 'agent-artifacts', 'pack.mjs');
const TAR = '/usr/bin/tar';
const WORKSPACES = [
  { dir: 'cli', name: '@pto-calendar/cli', declarations: false },
  { dir: 'mcp', name: '@pto-calendar/mcp', declarations: false },
  { dir: 'packages/api-client', name: '@pto-calendar/api-client', declarations: true },
  { dir: 'packages/agent-auth', name: '@pto-calendar/agent-auth', declarations: true },
];

const TOOL_ENV = {
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  TZ: 'UTC',
};

const temporaryOwners = new Map();

async function privateTemp(prefix = 'pto-agent-test-') {
  const base = await realpath(tmpdir());
  assert.ok(
    (await collectRepositoryRoots(ROOT)).every((root) => !isInside(root, base)),
    'the contract test temp directory must be outside the repository',
  );
  await assertTrustedDirectoryChain(base);
  const directory = await mkdtemp(join(base, prefix));
  temporaryOwners.set(directory, await captureOwnedDirectory(directory, base));
  return directory;
}

async function removePrivateTemp(directory) {
  const owner = temporaryOwners.get(directory);
  temporaryOwners.delete(directory);
  assert.equal(await removeOwnedDirectory(owner), true, 'refused to remove a replaced fixture');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function tarballName(name, version) {
  return `${name.replace(/^@/, '').replace(/\//g, '-')}-${version}.tgz`;
}

function member(content, mode = 0o644) {
  const buffer = Buffer.from(content);
  return { size: buffer.length, sha256: sha256Buffer(buffer), mode };
}

async function writePackageFile(root, relative, content, mode = 0o644) {
  const target = join(root, 'package', relative);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, content, { mode });
  await chmod(target, mode);
}

function makeTar(directory, name, members) {
  const archive = join(directory, name);
  execFileSync(TAR, ['-czf', archive, '-C', directory, ...members], {
    env: { ...TOOL_ENV, HOME: directory, TMPDIR: directory },
  });
  return archive;
}

async function extractionEntries(scratch) {
  return (await readdir(scratch)).filter((name) => name.startsWith('extract-'));
}

async function listAllFiles(root) {
  const files = [];
  const walk = async (directory, relative) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const next = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`unexpected link ${next}`);
      if (entry.isDirectory()) await walk(absolute, next);
      else if (entry.isFile()) files.push(next);
      else throw new Error(`unexpected special file ${next}`);
    }
  };
  await walk(root, '');
  return files;
}

/** Copies only the pack inputs into a temp root with different safe modes. */
async function copyPackInputs(target) {
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const name of ['package.json', 'package-lock.json', '.nvmrc']) {
    await cp(join(ROOT, name), join(target, name));
  }
  for (const workspace of WORKSPACES) {
    const source = join(ROOT, workspace.dir);
    const destination = join(target, workspace.dir);
    await mkdir(destination, { recursive: true, mode: 0o700 });
    await cp(join(source, 'package.json'), join(destination, 'package.json'));
    await cp(join(source, 'README.md'), join(destination, 'README.md'));
    await cp(join(source, 'src'), join(destination, 'src'), { recursive: true });
    await cp(join(source, 'dist'), join(destination, 'dist'), { recursive: true });
    if (workspace.dir === 'cli' || workspace.dir === 'mcp') {
      await cp(join(source, 'bin'), join(destination, 'bin'), { recursive: true });
    }
    if (workspace.dir === 'packages/agent-auth') {
      await cp(join(source, 'libexec'), join(destination, 'libexec'), { recursive: true });
    }
  }
  const now = Date.now() / 1000;
  for (const relative of await listAllFiles(target)) {
    const absolute = join(target, relative);
    const isBin = /(^|\/)bin\/pto(-mcp)?\.mjs$/.test(relative);
    await chmod(absolute, isBin ? 0o755 : 0o640);
    const sourceFile = relative.split('/').includes('src');
    const timestamp = sourceFile ? now - 20 : now - 5;
    await utimes(absolute, timestamp, timestamp);
  }
}

async function makeSlotTree(parent, name = 'prior') {
  const root = join(parent, name);
  await mkdir(root, { mode: 0o700 });
  const owner = await captureOwnedDirectory(root, parent);
  const directories = [
    'node_modules/.bin',
    'node_modules/@pto-calendar/cli/bin',
    'node_modules/@pto-calendar/mcp/bin',
    'node_modules/@pto-calendar/mcp/dist',
    'node_modules/dep',
  ];
  for (const directory of directories) {
    await mkdir(join(root, directory), { recursive: true, mode: 0o755 });
  }
  const write = async (relative, content, mode = 0o644) => {
    const target = join(root, relative);
    await writeFile(target, content, { mode });
    await chmod(target, mode);
  };
  await write('package.json', '{"name":"synthetic-slot"}\n');
  await write('package-lock.json', '{"lockfileVersion":3}\n');
  await write('SHA256SUMS', `${'0'.repeat(64)}  package.json\n`);
  await write('node_modules/.package-lock.json', '{"lockfileVersion":3}\n');
  await write('node_modules/@pto-calendar/cli/bin/pto.mjs', '#!/usr/bin/env node\n', 0o755);
  await write('node_modules/@pto-calendar/mcp/bin/pto-mcp.mjs', '#!/usr/bin/env node\n', 0o755);
  await write('node_modules/@pto-calendar/mcp/dist/main.js', 'export const mcp = 1;\n');
  await write('node_modules/dep/index.js', 'module.exports = 1;\n');
  await symlink('../@pto-calendar/cli/bin/pto.mjs', join(root, 'node_modules/.bin/pto'));
  await symlink('../@pto-calendar/mcp/bin/pto-mcp.mjs', join(root, 'node_modules/.bin/pto-mcp'));
  return { root, owner };
}

async function snapshotSlotFixture(parent, name) {
  const fixture = await makeSlotTree(parent, name);
  const snapshot = await snapshotSlotTree(fixture.root, { expectedOwner: fixture.owner });
  return { ...fixture, snapshot };
}

test('slot tree snapshots detect changed/missing runtime files, modes and link retargets', async () => {
  const parent = await privateTemp();
  try {
    const base = await snapshotSlotFixture(parent, 'base');
    assert.equal(compareSlotSnapshots(base.snapshot, base.snapshot).equal, true);
    const paths = new Set(base.snapshot.entries.map((entry) => entry.path));
    for (const required of [
      'node_modules/.bin/pto',
      'node_modules/.bin/pto-mcp',
      'node_modules/.package-lock.json',
      'node_modules/dep/index.js',
      'node_modules/@pto-calendar/mcp/dist/main.js',
    ]) {
      assert.equal(paths.has(required), true, `missing snapshot entry ${required}`);
    }

    const baseMtime = new Date(Date.now() - 10_000);
    await utimes(
      join(base.root, 'node_modules/@pto-calendar/mcp/dist/main.js'),
      baseMtime,
      baseMtime,
    );
    const touched = await snapshotSlotTree(base.root, { expectedOwner: base.owner });
    assert.equal(compareSlotSnapshots(base.snapshot, touched).equal, true);

    const changed = await snapshotSlotFixture(parent, 'changed');
    const mcpRuntime = join(changed.root, 'node_modules/@pto-calendar/mcp/dist/main.js');
    await writeFile(mcpRuntime, 'export const mcp = 2;\n');
    await chmod(mcpRuntime, 0o644);
    const changedSnapshot = await snapshotSlotTree(changed.root, {
      expectedOwner: changed.owner,
    });
    const changedDiff = compareSlotSnapshots(changed.snapshot, changedSnapshot);
    assert.equal(changedDiff.equal, false);
    assert.match(changedDiff.reason, /file digest changed/);
    const lockBefore = changed.snapshot.entries.find(
      (entry) => entry.path === 'node_modules/.package-lock.json',
    );
    const lockAfter = changedSnapshot.entries.find(
      (entry) => entry.path === 'node_modules/.package-lock.json',
    );
    assert.equal(lockAfter.sha256, lockBefore.sha256);

    const missing = await snapshotSlotFixture(parent, 'missing');
    await unlink(join(missing.root, 'node_modules/@pto-calendar/mcp/dist/main.js'));
    const missingSnapshot = await snapshotSlotTree(missing.root, {
      expectedOwner: missing.owner,
    });
    const missingDiff = compareSlotSnapshots(missing.snapshot, missingSnapshot);
    assert.equal(missingDiff.equal, false);
    assert.match(missingDiff.reason, /entry removed/);

    const mode = await snapshotSlotFixture(parent, 'mode');
    const modeFile = join(mode.root, 'node_modules/@pto-calendar/mcp/dist/main.js');
    await chmod(modeFile, 0o600);
    const modeSnapshot = await snapshotSlotTree(mode.root, { expectedOwner: mode.owner });
    const modeDiff = compareSlotSnapshots(mode.snapshot, modeSnapshot);
    assert.equal(modeDiff.equal, false);
    assert.match(modeDiff.reason, /mode changed/);

    const retarget = await snapshotSlotFixture(parent, 'retarget');
    const launcher = join(retarget.root, 'node_modules/.bin/pto-mcp');
    await unlink(launcher);
    await symlink('../@pto-calendar/cli/bin/pto.mjs', launcher);
    const retargetSnapshot = await snapshotSlotTree(retarget.root, {
      expectedOwner: retarget.owner,
    });
    const retargetDiff = compareSlotSnapshots(retarget.snapshot, retargetSnapshot);
    assert.equal(retargetDiff.equal, false);
    assert.match(retargetDiff.reason, /link target changed/);
  } finally {
    await removePrivateTemp(parent);
  }
});

test('slot snapshots do not follow symlinks and refuse hard links or nonregular members', async () => {
  const parent = await privateTemp();
  try {
    const fixture = await makeSlotTree(parent, 'external');
    const outside = join(parent, 'outside.txt');
    await writeFile(outside, 'outside canary\n', { mode: 0o600 });
    await chmod(outside, 0o600);
    const externalLink = join(fixture.root, 'node_modules/outside-link');
    await symlink(outside, externalLink);
    const before = await snapshotSlotTree(fixture.root, { expectedOwner: fixture.owner });
    const entry = before.entries.find((entry) => entry.path === 'node_modules/outside-link');
    assert.equal(entry.type, 'symlink');
    assert.equal(entry.target, outside);
    await writeFile(outside, 'outside changed\n');
    await chmod(outside, 0o600);
    const after = await snapshotSlotTree(fixture.root, { expectedOwner: fixture.owner });
    assert.equal(compareSlotSnapshots(before, after).equal, true);

    const hardlink = join(fixture.root, 'node_modules/hardlink');
    await link(outside, hardlink);
    await assert.rejects(
      () => snapshotSlotTree(fixture.root, { expectedOwner: fixture.owner }),
      /hard-linked/,
    );
    await unlink(hardlink);

    const fifo = join(fixture.root, 'node_modules/fifo');
    execFileSync('mkfifo', [fifo], { env: { PATH: '/usr/bin:/bin' } });
    await assert.rejects(
      () => snapshotSlotTree(fixture.root, { expectedOwner: fixture.owner }),
      /unsupported slot tree member type/,
    );
  } finally {
    await removePrivateTemp(parent);
  }
});

test('the reviewed source/member inventory rejects extra source and compiled members', async () => {
  for (const workspace of WORKSPACES) {
    const manifest = await readJson(join(ROOT, workspace.dir, 'package.json'));
    assert.equal(manifest.version, REVIEWED_ARTIFACT_VERSION);
    const sourceTree = await walkTree(join(ROOT, workspace.dir, 'src'));
    assert.doesNotThrow(() => assertSourceInventory(workspace.dir, sourceTree.files));
    const compiledTree = await walkTree(join(ROOT, workspace.dir, 'dist'));
    const compiled = compiledTree.files.map((file) => `dist/${file}`);
    assert.doesNotThrow(() =>
      assertCompiledInventory(workspace.dir, compiled, workspace.declarations),
    );

    assert.throws(
      () => assertSourceInventory(workspace.dir, [...sourceTree.files, 'extra.ts']),
      /extra member is not reviewed/,
    );
    assert.throws(
      () => assertSourceInventory(workspace.dir, sourceTree.files.slice(1)),
      /reviewed member is missing/,
    );
    assert.throws(
      () =>
        assertCompiledInventory(
          workspace.dir,
          [...compiled, 'dist/extra.js'],
          workspace.declarations,
        ),
      /extra member is not reviewed/,
    );
  }

  const reviewed = reviewedSourceMembers('cli');
  assert.deepEqual(reviewed, [...reviewed].sort());
  const compiled = reviewedCompiledMembers('cli', false);
  assert.equal(compiled.includes('dist/main.js'), true);
  assert.equal(compiled.includes('dist/main.d.ts'), false);
});

test('artifact member paths stay relative and reject hidden or escaping names', () => {
  assert.throws(() => assertAllowedArtifactPath('../evil.txt'), /escapes its root/);
  assert.throws(() => assertAllowedArtifactPath('/absolute.txt'), /not a flat/);
  assert.throws(() => assertAllowedArtifactPath('package/.env'), /hidden/);
  assert.throws(() => assertAllowedArtifactPath('package/credentials.json'), /secret-adjacent/);
});

test('the temp root is refused inside a registered worktree before mkdtemp', async () => {
  const before = new Set(await readdir(ROOT));
  const oldTemp = process.env.TMPDIR;
  process.env.TMPDIR = ROOT;
  try {
    await assert.rejects(() => createScratchArea(ROOT), /temp root is inside/);
  } finally {
    if (oldTemp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = oldTemp;
  }
  const after = new Set(await readdir(ROOT));
  assert.equal(
    [...after].some((name) => name.startsWith('pto-agent-pack-')),
    false,
  );
  assert.deepEqual([...after].sort(), [...before].sort());
});

test('the output guard refuses worktree, existing and symlink paths', async () => {
  const parent = await privateTemp();
  try {
    const inside = join(ROOT, '.agent-pack-test-output');
    await assert.rejects(
      () => prepareOutputDirectory(inside, ROOT),
      /outside every source worktree/,
    );
    await assert.rejects(() => readFile(inside), /ENOENT/);

    const existing = join(parent, 'existing');
    await mkdir(existing, { mode: 0o700 });
    await assert.rejects(() => prepareOutputDirectory(existing, ROOT), /already exists/);

    const target = join(parent, 'target');
    const link = join(parent, 'link');
    await mkdir(target, { mode: 0o700 });
    await symlink(target, link);
    await assert.rejects(
      () => prepareOutputDirectory(link, ROOT),
      /already exists or is a symlink/,
    );
    assert.deepEqual(await readdir(target), []);
  } finally {
    await removePrivateTemp(parent);
  }
});

test('cleanup refuses a replaced output inode and leaves the replacement intact', async () => {
  const parent = await privateTemp();
  try {
    const prepared = await prepareOutputDirectory(join(parent, 'bundle'), ROOT);
    const original = join(parent, 'original');
    await rename(prepared.output, original);
    await mkdir(prepared.output, { mode: 0o700 });
    await writeFile(join(prepared.output, 'replacement.txt'), 'replacement\n');
    assert.equal(await prepared.cleanup(), false);
    assert.equal(await readFile(join(prepared.output, 'replacement.txt'), 'utf8'), 'replacement\n');
    assert.equal(await readFile(join(original, 'replacement.txt'), 'utf8').catch(() => null), null);
  } finally {
    await removePrivateTemp(parent);
  }
});

test('owned-directory cleanup refuses replaced targets and untrusted parents', async () => {
  const parent = await privateTemp();
  try {
    const owned = join(parent, 'owned');
    await mkdir(owned, { mode: 0o700 });
    const owner = await captureOwnedDirectory(owned, parent);

    const moved = join(parent, 'original');
    await rename(owned, moved);
    await mkdir(owned, { mode: 0o700 });
    await writeFile(join(owned, 'target-replacement.txt'), 'target replacement\n');
    assert.equal(await removeOwnedDirectory(owner), false);
    assert.equal(
      await readFile(join(owned, 'target-replacement.txt'), 'utf8'),
      'target replacement\n',
    );

    const wideParent = join(parent, 'wide');
    const wideChild = join(wideParent, 'child');
    await mkdir(wideParent, { mode: 0o700 });
    await chmod(wideParent, 0o777);
    await mkdir(wideChild, { mode: 0o700 });
    await assert.rejects(
      () => captureOwnedDirectory(wideChild, wideParent, { privateParent: true }),
      /group- or world-writable/,
    );
    await assert.rejects(() => assertTrustedDirectoryChain(wideChild), /without the sticky bit/);

    const parentOwner = join(parent, 'parent-owned');
    await mkdir(parentOwner, { mode: 0o700 });
    const child = join(parentOwner, 'child');
    await mkdir(child, { mode: 0o700 });
    const parentCapture = await captureOwnedDirectory(child, parentOwner);
    const movedParent = join(parent, 'parent-moved');
    await rename(parentOwner, movedParent);
    await mkdir(parentOwner, { mode: 0o700 });
    await mkdir(child, { mode: 0o700 });
    await writeFile(join(child, 'parent-replacement.txt'), 'parent replacement\n');
    assert.equal(await removeOwnedDirectory(parentCapture), false);
    assert.equal(
      await readFile(join(child, 'parent-replacement.txt'), 'utf8'),
      'parent replacement\n',
    );
  } finally {
    await removePrivateTemp(parent);
  }
});

test('ambient project npmrc files are rejected before any npm child', async () => {
  const parent = await privateTemp();
  try {
    const dirty = join(parent, 'dirty');
    const clean = join(parent, 'clean');
    await mkdir(dirty, { mode: 0o700 });
    await mkdir(clean, { mode: 0o700 });
    await writeFile(join(dirty, '.npmrc'), 'registry=https://untrusted.example.invalid/\n', {
      mode: 0o600,
    });
    await assert.rejects(() => assertNoNpmrc([dirty], 'workspace'), /holds an npmrc/);
    await assert.doesNotReject(() => assertNoNpmrc([clean], 'workspace'));
  } finally {
    await removePrivateTemp(parent);
  }
});

test('direct inert credential canaries are rejected in an otherwise allowed member', async () => {
  const parent = await privateTemp();
  const token = `pto_pat_12345678-1234-4234-8234-123456789abc.${'0'.repeat(64)}`;
  try {
    const directory = join(parent, 'dist');
    await mkdir(directory, { mode: 0o700 });
    const memberPath = join(directory, 'allowed.js');
    const cases = [
      {
        content: `export const canary = '${token}';\n`,
        pattern: /PTO personal access token/,
      },
      {
        content: '-----BEGIN PRIVATE KEY-----\n',
        pattern: /private key material/,
      },
    ];
    for (const testCase of cases) {
      await writeFile(memberPath, testCase.content, { mode: 0o600 });
      await chmod(memberPath, 0o600);
      await assert.rejects(
        () => readSourceArtifact(memberPath, parent, 'dist/allowed.js'),
        (error) => {
          assert.equal(error instanceof PackError, true);
          assert.match(error.message, testCase.pattern);
          assert.equal(error.message.includes(testCase.content), false);
          assert.equal(error.message.includes(token), false);
          return true;
        },
      );
    }
  } finally {
    await removePrivateTemp(parent);
  }
});

test('npm staging copies only vetted inputs and carries no project npmrc', async () => {
  const parent = await privateTemp();
  const oldTemp = process.env.TMPDIR;
  process.env.TMPDIR = join(parent, 'tmp');
  await mkdir(process.env.TMPDIR, { mode: 0o700 });
  try {
    const scratch = await createScratchArea(ROOT);
    try {
      const buffer = Buffer.from('{"name":"staging-fixture"}\n');
      const expected = new Map([
        [
          'package.json',
          {
            relative: 'package.json',
            size: buffer.length,
            sha256: sha256Buffer(buffer),
            mode: 0o644,
            buffer,
          },
        ],
      ]);
      const staging = await stagePackageInputs({
        policy: { dir: 'cli', name: '@pto-calendar/cli' },
        expected,
        scratch,
      });
      assert.deepEqual((await readdir(staging)).sort(), ['package.json']);
      await assert.rejects(() => readFile(join(staging, '.npmrc')), /ENOENT/);
      assert.equal(await readFile(join(staging, 'package.json'), 'utf8'), buffer.toString());
    } finally {
      await scratch.cleanup();
    }
  } finally {
    if (oldTemp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = oldTemp;
    await removePrivateTemp(parent);
  }
});

test('child stderr and configuration material are not copied into diagnostics', async () => {
  const parent = await privateTemp();
  try {
    assert.throws(
      () =>
        runCommand(
          process.execPath,
          ['-e', 'process.stderr.write("CANARY_SECRET_VALUE"); process.exit(7)'],
          {
            cwd: parent,
            env: { ...TOOL_ENV, HOME: parent, TMPDIR: parent },
            label: 'diagnostic probe',
          },
        ),
      (error) => {
        assert.equal(error instanceof PackError, true);
        assert.match(error.message, /diagnostic probe failed with status 7/);
        assert.doesNotMatch(error.message, /CANARY_SECRET_VALUE/);
        return true;
      },
    );
  } finally {
    await removePrivateTemp(parent);
  }
});

test('tar validation rejects type, mode, size, hidden and duplicate members before extraction', async () => {
  const parent = await privateTemp();
  try {
    const positive = join(parent, 'positive');
    await mkdir(positive, { mode: 0o700 });
    await writePackageFile(positive, 'package.json', '{"name":"fixture"}\n');
    await writePackageFile(positive, 'ok.txt', 'ok\n');
    const positiveArchive = makeTar(positive, 'positive.tgz', [
      'package/package.json',
      'package/ok.txt',
    ]);
    const positiveExpected = new Map([
      ['package.json', member('{"name":"fixture"}\n')],
      ['ok.txt', member('ok\n')],
    ]);
    const positiveScratch = join(parent, 'positive-scratch');
    await mkdir(positiveScratch, { mode: 0o700 });
    const verified = await verifyArchive({
      archivePath: positiveArchive,
      expected: positiveExpected,
      tarPath: TAR,
      env: { ...TOOL_ENV, HOME: parent, TMPDIR: parent },
      scratch: positiveScratch,
      label: 'positive',
    });
    assert.equal(verified.manifest.name, 'fixture');

    const cases = [];
    const modeDir = join(parent, 'mode');
    await mkdir(modeDir, { mode: 0o700 });
    await writePackageFile(modeDir, 'package.json', '{"name":"fixture"}\n');
    await writePackageFile(modeDir, 'ok.txt', 'ok\n');
    cases.push({
      label: 'mode',
      archive: makeTar(modeDir, 'mode.tgz', ['package/package.json', 'package/ok.txt']),
      expected: new Map([
        ['package.json', member('{"name":"fixture"}\n')],
        ['ok.txt', { ...member('ok\n'), mode: 0o600 }],
      ]),
      pattern: /mode 0644 does not match 0600 before extraction/,
    });

    const sizeDir = join(parent, 'size');
    await mkdir(sizeDir, { mode: 0o700 });
    await writePackageFile(sizeDir, 'package.json', '{"name":"fixture"}\n');
    await writePackageFile(sizeDir, 'ok.txt', 'ok\n');
    cases.push({
      label: 'size',
      archive: makeTar(sizeDir, 'size.tgz', ['package/package.json', 'package/ok.txt']),
      expected: new Map([
        ['package.json', member('{"name":"fixture"}\n')],
        ['ok.txt', { ...member('ok\n'), size: 4 }],
      ]),
      pattern: /size does not match its source before extraction/,
    });

    const typeDir = join(parent, 'type');
    await mkdir(typeDir, { mode: 0o700 });
    await writePackageFile(typeDir, 'package.json', '{"name":"fixture"}\n');
    await writePackageFile(typeDir, 'ok.txt', 'ok\n');
    await symlink('ok.txt', join(typeDir, 'package', 'link.txt'));
    cases.push({
      label: 'type',
      archive: makeTar(typeDir, 'type.tgz', [
        'package/package.json',
        'package/ok.txt',
        'package/link.txt',
      ]),
      expected: new Map([
        ['package.json', member('{"name":"fixture"}\n')],
        ['ok.txt', member('ok\n')],
        ['link.txt', { size: 0, sha256: '0'.repeat(64), mode: 0o777 }],
      ]),
      pattern: /non-regular member before extraction/,
    });

    const hiddenDir = join(parent, 'hidden');
    await mkdir(hiddenDir, { mode: 0o700 });
    await writePackageFile(hiddenDir, 'package.json', '{"name":"fixture"}\n');
    await writePackageFile(hiddenDir, 'ok.txt', 'ok\n');
    await writePackageFile(hiddenDir, '.env', 'CANARY=1\n');
    cases.push({
      label: 'hidden',
      archive: makeTar(hiddenDir, 'hidden.tgz', [
        'package/package.json',
        'package/ok.txt',
        'package/.env',
      ]),
      expected: new Map([
        ['package.json', member('{"name":"fixture"}\n')],
        ['ok.txt', member('ok\n')],
        ['.env', member('CANARY=1\n')],
      ]),
      pattern: /hidden|expected members/,
    });

    const duplicateDir = join(parent, 'duplicate');
    await mkdir(duplicateDir, { mode: 0o700 });
    await writePackageFile(duplicateDir, 'package.json', '{"name":"fixture"}\n');
    await writePackageFile(duplicateDir, 'ok.txt', 'ok\n');
    cases.push({
      label: 'duplicate',
      archive: makeTar(duplicateDir, 'duplicate.tgz', [
        'package/package.json',
        'package/ok.txt',
        'package/ok.txt',
      ]),
      expected: new Map([
        ['package.json', member('{"name":"fixture"}\n')],
        ['ok.txt', member('ok\n')],
      ]),
      pattern: /expected members|repeats a member/,
    });

    for (const testCase of cases) {
      const scratch = join(parent, `${testCase.label}-scratch`);
      await mkdir(scratch, { mode: 0o700 });
      let message = null;
      try {
        await verifyArchive({
          archivePath: testCase.archive,
          expected: testCase.expected,
          tarPath: TAR,
          env: { ...TOOL_ENV, HOME: parent, TMPDIR: parent },
          scratch,
          label: testCase.label,
        });
      } catch (error) {
        message = error.message;
      }
      assert.notEqual(message, null, `${testCase.label} passed unexpectedly`);
      assert.match(message, testCase.pattern);
      assert.deepEqual(await extractionEntries(scratch), []);
    }
  } finally {
    await removePrivateTemp(parent);
  }
});

test('the consumer lock preserves the peer closure and both content-type placements', async () => {
  const rootLock = await readJson(join(ROOT, 'package-lock.json'));
  const rootManifest = await readJson(join(ROOT, 'package.json'));
  const artifacts = [];
  for (const workspace of WORKSPACES) {
    const manifest = await readJson(join(ROOT, workspace.dir, 'package.json'));
    artifacts.push({
      name: manifest.name,
      version: manifest.version,
      tarball: tarballName(manifest.name, manifest.version),
      // The lock graph does not read tarball bytes; a complete sha512-shaped
      // value is enough for this pure graph check.
      integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
      manifest,
    });
  }
  const result = buildConsumerLock({
    rootLock,
    artifactVersion: REVIEWED_ARTIFACT_VERSION,
    rootEngines: rootManifest.engines,
    artifacts,
  });
  assert.equal(result.closureSize, 100);
  assert.equal(result.installedCount, 104);
  assert.equal(Object.keys(result.lock.packages).length, 105);

  for (const name of ['hono', 'zod', 'ajv', 'express', 'zod-to-json-schema']) {
    assert.equal(
      Object.keys(result.lock.packages).some((key) => key.endsWith(`/${name}`)),
      true,
      `peer dependency ${name} is missing`,
    );
  }
  assert.equal(
    result.lock.packages['node_modules/@modelcontextprotocol/sdk/node_modules/content-type']
      .version,
    '1.0.5',
  );
  assert.equal(result.lock.packages['node_modules/content-type'].version, '2.1.0');
  for (const workspace of WORKSPACES) {
    const entry = result.lock.packages[`node_modules/${workspace.name}`];
    assert.equal(entry.resolved, `file:${tarballName(workspace.name, REVIEWED_ARTIFACT_VERSION)}`);
    assert.equal(entry.license, 'UNLICENSED');
  }
});

test('the real pack produces seven files, six checksums and the reviewed 104-entry lock', async () => {
  const parent = await privateTemp();
  const temp = join(parent, 'tmp');
  const output = join(parent, 'bundle');
  await mkdir(temp, { mode: 0o700 });
  try {
    const result = spawnSync(process.execPath, [PACK_ENTRY, '--output', output], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: temp,
        LANG: 'C.UTF-8',
        TZ: 'UTC',
      },
      encoding: 'utf8',
      timeout: 180_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const files = (await readdir(output)).sort();
    const tarballs = WORKSPACES.map((workspace) =>
      tarballName(workspace.name, REVIEWED_ARTIFACT_VERSION),
    ).sort();
    assert.deepEqual(
      files,
      [...tarballs, 'SHA256SUMS', 'package-lock.json', 'package.json'].sort(),
    );
    const sums = parseChecksums(await readFile(join(output, 'SHA256SUMS'), 'utf8'));
    assert.equal(sums.size, 6);
    await verifyChecksums(output, new Set([...tarballs, 'package.json', 'package-lock.json']));
    const lock = await readJson(join(output, 'package-lock.json'));
    assert.equal(Object.keys(lock.packages).length, 105);
    assert.equal(
      lock.packages['node_modules/@modelcontextprotocol/sdk/node_modules/content-type'].version,
      '1.0.5',
    );
    assert.equal(lock.packages['node_modules/content-type'].version, '2.1.0');
    assert.equal(lock.packages[''].private, true);
  } finally {
    await removePrivateTemp(parent);
  }
});

test('canonical staging yields identical bundle bytes from different safe source modes', async () => {
  const parent = await privateTemp();
  const temp = join(parent, 'tmp');
  const oldTemp = process.env.TMPDIR;
  process.env.TMPDIR = temp;
  await mkdir(temp, { mode: 0o700 });
  try {
    const sourceManifest = join(ROOT, 'cli', 'package.json');
    const sourceMode = (await lstat(sourceManifest)).mode & 0o777;
    const reference = await packBundle({ output: join(parent, 'reference') });
    assert.equal((await lstat(sourceManifest)).mode & 0o777, sourceMode);

    const copyRoot = join(parent, 'copy-root');
    await copyPackInputs(copyRoot);
    assert.equal((await lstat(join(copyRoot, 'cli', 'package.json'))).mode & 0o777, 0o640);
    assert.equal((await lstat(join(copyRoot, 'cli', 'bin', 'pto.mjs'))).mode & 0o777, 0o755);
    const variant = await packBundle({ output: join(parent, 'variant'), root: copyRoot });

    const names = [...reference.tarballs, 'package.json', 'package-lock.json', 'SHA256SUMS'];
    for (const name of names) {
      assert.deepEqual(
        await readFile(join(parent, 'reference', name)),
        await readFile(join(parent, 'variant', name)),
        `${name} differs across safe source modes`,
      );
    }
    assert.equal(reference.closureSize, variant.closureSize);
  } finally {
    if (oldTemp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = oldTemp;
    await removePrivateTemp(parent);
  }
});
