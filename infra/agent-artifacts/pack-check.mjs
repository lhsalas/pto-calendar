#!/usr/bin/env node
// Offline clean-install smoke for the versioned CLI/MCP agent bundles (#265).
//
// CI entry: `node infra/agent-artifacts/pack-check.mjs` (no arguments), run on
// a compiled checkout after `npm run build`. The script builds nothing in the
// checkout, writes nothing to the checkout, publishes nothing, uploads
// nothing, and mutates no Git state, database, live/user profile, setting, or
// CI configuration. The smoke creates only disposable scratch-local state,
// including an explicit plaintext file profile used to prove real reads.
// This smoke always requires the real pack on this checkout.
//
// Exact bundle layout (no fallbacks): `--output` holds exactly seven entries
// directly at its root: four versioned tarballs, `package.json`,
// `package-lock.json`, and `SHA256SUMS` covering exactly those six files.
// Every archive is hash-verified and member-vetted (types, paths, sizes,
// canonical 0644/0755 modes) before extraction; the consumer manifests may
// reference only relative `file:` archives plus public registry pins matching
// the reviewed root `package-lock.json`; private workspace names never
// resolve upstream. The install is `npm ci --offline --ignore-scripts` inside
// the scratch bundle with a fresh npm configuration, reusing the cache warmed
// by root `npm ci`. The installed prefix is proven by bins, exports, helper,
// and engines, and the installed tools serve synthetic loopback reads (raw
// JSON-RPC for the MCP server; no monorepo SDK). A bounded same-version slot
// reinstall, rollback, and removal exercises two installed copies through the
// shared disposable default file profile, not a version change or a live
// user profile.
//
// All diagnostics are fixed sentences: they name stages and expectations but
// never echo credentials, tokens, notes, request bodies, or ambient paths
// that could carry secrets.

import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertTrustedDirectoryChain,
  captureOwnedDirectory,
  collectRepositoryRoots,
  removeOwnedDirectory,
} from './bundle-safety.mjs';
import { compareSlotSnapshots, snapshotSlotTree } from './slot-snapshot.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACK_ENTRY = join(ROOT, 'infra', 'agent-artifacts', 'pack.mjs');
const TOOLCHAIN_PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
const CLASSIC_PROTOCOL = '2025-11-25';

// Synthetic credentials for the owned loopback fixture. These are generated
// for this smoke run only: they are never real secrets, never stored, and
// must appear in no tool output.
const TOKEN_ID = '33333333-3333-4333-8333-333333333333';
const TOKEN_SECRET = '7'.repeat(64);
const TOKEN = `pto_pat_${TOKEN_ID}.${TOKEN_SECRET}`;
const OWNER = '33333333-aaaa-4333-8333-000000000001';
const FIRST = '33333333-aaaa-4333-8333-000000000002';
const NOTE = 'synthetic pack-check fixture note';

const WORKSPACES = [
  { dir: 'cli', name: '@pto-calendar/cli', bin: { pto: './bin/pto.mjs' } },
  { dir: 'mcp', name: '@pto-calendar/mcp', bin: { 'pto-mcp': './bin/pto-mcp.mjs' } },
  { dir: join('packages', 'api-client'), name: '@pto-calendar/api-client' },
  { dir: join('packages', 'agent-auth'), name: '@pto-calendar/agent-auth' },
];

const NPM_CI_TIMEOUT_MS = 75_000;
const PACK_TIMEOUT_MS = 120_000;
const CHILD_TIMEOUT_MS = 30_000;
const MCP_REPLY_TIMEOUT_MS = 15_000;
const MAX_TOOL_OUTPUT_BYTES = 256 * 1024;

let failures = 0;
let ownedScratch = null;

function log(message) {
  console.log(`pack-check: ${message}`);
}

function fail(message) {
  failures += 1;
  process.exitCode = 1;
  console.error(`pack-check: FAIL: ${message}`);
}

function failClosed(message) {
  console.error(`pack-check: FAIL: ${message}`);
  process.exitCode = 1;
}

/** True when the real path stays inside the directory. */
function inside(root, target) {
  const normalized = `${root}${sep}`;
  return target === root || target.startsWith(normalized);
}

/** The npm tarball file name for a scoped package at a version. */
function tarballName(packageName, version) {
  return `${packageName.replace(/^@/, '').replace(/\//g, '-')}-${version}.tgz`;
}

function readJsonFile(path) {
  return readFile(path, 'utf8').then((text) => JSON.parse(text));
}

function exists(path) {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Runs a command synchronously with a fixed timeout and returns the result. */
function runSync(file, args, options) {
  return spawnSync(file, args, {
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
    env: { PATH: TOOLCHAIN_PATH, LANG: 'C', TZ: 'UTC' },
    ...options,
  });
}

/** Asserts a byte string carries no credential, cookie, or token identifier. */
function assertClean(label, text) {
  const findings = [];
  if (text.includes(TOKEN)) findings.push('credential');
  if (text.includes(TOKEN_SECRET)) findings.push('secret');
  if (text.includes(TOKEN_ID)) findings.push('token identifier');
  if (/cookie/i.test(text)) findings.push('cookie reference');
  if (findings.length > 0) {
    fail(`${label} leaked ${findings.join(', ')}`);
    return false;
  }
  return true;
}

async function preconditionCompiledOutputs() {
  const required = [
    join(ROOT, 'cli', 'dist', 'main.js'),
    join(ROOT, 'mcp', 'dist', 'main.js'),
    join(ROOT, 'packages', 'api-client', 'dist', 'index.js'),
    join(ROOT, 'packages', 'agent-auth', 'dist', 'index.js'),
  ];
  let ready = true;
  for (const file of required) {
    if (!(await exists(file))) {
      fail(`compiled output is missing: ${basename(file)} (build the workspaces first)`);
      ready = false;
    }
  }
  if (ready) log('ok: compiled workspace outputs are present (nothing was built)');
  return ready;
}

async function preconditionRootInstall() {
  const marker = join(ROOT, 'node_modules', '.package-lock.json');
  if (!(await exists(marker))) {
    fail('root install marker is missing: run the root npm ci first to warm the reviewed cache');
    return null;
  }
  const cachePath = process.env.npm_config_cache ?? join(homedir(), '.npm');
  const directory = await realpath(cachePath).catch(() => null);
  if (
    directory === null ||
    !cachePath.startsWith(sep) ||
    inside(await realpath(ROOT), directory) ||
    !(await stat(join(directory, '_cacache')).catch(() => null))?.isDirectory()
  ) {
    fail('a warmed npm cache with an absolute path outside the checkout is required');
    return null;
  }
  log('ok: root install marker and reviewed npm cache are present');
  return directory;
}

/** Creates the isolated scratch tree and returns its paths. */
async function createScratch() {
  const base = await realpath(tmpdir());
  for (const root of await collectRepositoryRoots(ROOT)) {
    if (inside(root, base)) throw new Error('scratch-in-worktree');
  }
  await assertTrustedDirectoryChain(base);
  for (let ancestor = base; ; ancestor = dirname(ancestor)) {
    const modules = await lstat(join(ancestor, 'node_modules')).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (modules !== null) throw new Error('ambient-node-modules');
    if (dirname(ancestor) === ancestor) break;
  }
  const scratch = await mkdtemp(join(base, 'pto-pack-check-'));
  ownedScratch = await captureOwnedDirectory(scratch, base);
  const home = join(scratch, 'home');
  const packParent = join(scratch, 'pack-parent');
  const output = join(packParent, 'bundle');
  const slots = join(scratch, 'slots');
  await mkdir(home, { mode: 0o700 });
  await mkdir(join(home, 'config'), { mode: 0o700 });
  await mkdir(join(home, 'data'), { mode: 0o700 });
  await mkdir(join(home, 'tmp'), { mode: 0o700 });
  await mkdir(packParent, { mode: 0o700 });
  await mkdir(slots, { mode: 0o700 });
  // A fresh npm configuration: empty user and global config so no user
  // setting can change the install, and the cache stays the reviewed one.
  await writeFile(join(home, 'user.npmrc'), '', { mode: 0o600 });
  await writeFile(join(home, 'global.npmrc'), '', { mode: 0o600 });
  return { scratch, home, output, slots };
}

/** Removes only the scratch directory this run created. */
async function removeScratch() {
  const owner = ownedScratch;
  ownedScratch = null;
  if (owner === null) return;
  if (!(await removeOwnedDirectory(owner))) {
    fail("refused to remove a directory that is not this run's owned inode");
  }
}

/** Removes only a slot directory owned by this run. */
async function removeOwnedSlot(owner) {
  if (!(await removeOwnedDirectory(owner))) {
    fail("refused to remove a slot that is not this run's owned inode");
    return false;
  }
  return true;
}

/** The base environment for every child: isolated, with no ambient secrets. */
function childEnv(home, extra) {
  return {
    PATH: TOOLCHAIN_PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CACHE_HOME: join(home, 'tmp'),
    TMPDIR: join(home, 'tmp'),
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/pto-pack-check-bus',
    npm_config_userconfig: join(home, 'user.npmrc'),
    npm_config_globalconfig: join(home, 'global.npmrc'),
    npm_config_registry: 'https://registry.npmjs.org/',
    ...extra,
  };
}

/**
 * Requires the exact bundle layout: `--output` holds exactly seven entries
 * directly at its root (four versioned tarballs, `package.json`,
 * `package-lock.json`, `SHA256SUMS`). No subdirectory fallbacks.
 */
async function locateBundle(output, expectedNames) {
  const wanted = new Set([...expectedNames, 'package.json', 'package-lock.json', 'SHA256SUMS']);
  let files = null;
  try {
    const info = await lstat(output);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (await realpath(output)) !== output) {
      fail('the pack output is not a canonical private scratch directory');
      return null;
    }
    files = await readdir(output);
  } catch {
    fail('the pack output is not a readable directory');
    return null;
  }
  if (files.length !== wanted.size || !files.every((file) => wanted.has(file))) {
    fail('the pack output does not hold exactly the bundle files at its root');
    return null;
  }
  for (const file of files) {
    const info = await lstat(join(output, file));
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_ARCHIVE_BYTES) {
      fail('the bundle holds a non-regular, linked or unbounded file');
      return null;
    }
  }
  return { root: output, sumsPath: join(output, 'SHA256SUMS') };
}

/** Parses a checksum list of relative basenames (`sha256sum` text or `*` form). */
function parseSums(text) {
  const entries = new Map();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const match = /^([0-9a-f]{64}) [ *](\S+)$/.exec(line);
    if (!match) return null;
    const [, digest, name] = match;
    if (name.includes('/') || entries.has(name)) return null;
    entries.set(name, digest);
  }
  return entries;
}

/**
 * Verifies SHA256SUMS covers exactly the six bundle files (four tarballs
 * plus both manifests) and every hash matches before any archive is listed
 * or extracted. The pack process in our private scratch area is the source
 * of trust; hashes alone do not authenticate a bundle.
 */
async function verifyChecksums(bundle, expectedNames) {
  const wanted = new Set([...expectedNames, 'package.json', 'package-lock.json']);
  const sums = parseSums(await readFile(bundle.sumsPath, 'utf8'));
  if (sums === null || sums.size !== wanted.size) {
    fail('SHA256SUMS does not cover exactly the six bundle files');
    return null;
  }
  for (const name of wanted) {
    if (!sums.has(name)) {
      fail('SHA256SUMS is missing an expected bundle file');
      return null;
    }
  }
  const digests = new Map();
  for (const name of wanted) {
    const data = await readFile(join(bundle.root, name));
    const actual = createHash('sha256').update(data).digest('hex');
    if (actual !== sums.get(name)) {
      fail('a bundle file does not match its SHA256SUMS entry');
      return null;
    }
    if (name.endsWith('.tgz')) {
      digests.set(name, `sha512-${createHash('sha512').update(data).digest('base64')}`);
    }
  }
  log('ok: SHA256SUMS matches the six bundle files');
  return digests;
}

/** Compressed-archive bound before anything is listed or extracted. */
const MAX_ARCHIVE_BYTES = 2_000_000;
const MAX_MEMBER_BYTES = 2_000_000;
const MAX_MEMBERS = 200;

/**
 * Vets every archive before extraction: compressed size, member names from
 * `tar -tzf`, and member types, modes, and sizes from `tar -tvzf`. Only
 * regular files and directories under `package/` pass; links, devices,
 * absolute paths, parent escapes, hidden names, nested archives, and
 * oversized members fail closed here, so extraction never meets them.
 */
async function vetArchives(root, expectedNames) {
  for (const name of expectedNames) {
    const path = join(root, name);
    const info = await stat(path).catch(() => null);
    if (info === null || !info.isFile() || info.size > MAX_ARCHIVE_BYTES) {
      fail('a bundle archive is outside its size bound');
      return false;
    }
    const listed = runSync('tar', ['-tzf', path], { cwd: root });
    if (listed.status !== 0) {
      fail('a bundle archive could not be listed');
      return false;
    }
    const names = String(listed.stdout)
      .split('\n')
      .filter((line) => line !== '');
    if (names.length === 0 || names.length > MAX_MEMBERS) {
      fail('a bundle archive is outside its member bound');
      return false;
    }
    if (new Set(names).size !== names.length) {
      fail('a bundle archive holds a duplicate member');
      return false;
    }
    for (const member of names) {
      if (!/^package\/(?:[A-Za-z0-9_-][A-Za-z0-9_./-]*)?$/.test(member) || member.includes('//')) {
        fail('a bundle archive holds a member outside its package root');
        return false;
      }
      let rest = member.slice('package/'.length);
      if (rest.endsWith('/') && rest.length > 1) rest = rest.slice(0, -1);
      if (rest !== '') {
        if (
          rest.startsWith('/') ||
          rest.split('/').some((part) => part === '' || part === '..' || part.startsWith('.'))
        ) {
          fail('a bundle archive holds an unsafe member path');
          return false;
        }
        if (/\.tgz$/i.test(rest)) {
          fail('a bundle archive holds a nested archive');
          return false;
        }
      }
    }
    const verbose = runSync('tar', ['-tvzf', path], { cwd: root });
    if (verbose.status !== 0) {
      fail('a bundle archive could not be inspected');
      return false;
    }
    let total = 0;
    for (const line of String(verbose.stdout).split('\n')) {
      if (line === '') continue;
      const parts = line.split(/\s+/);
      if (parts.length < 6 || parts[0].length !== 10) {
        fail('a bundle archive holds an unparseable member');
        return false;
      }
      const type = parts[0][0];
      const size = Number(parts[2]);
      if ((type !== '-' && type !== 'd') || !Number.isSafeInteger(size) || size < 0) {
        fail('a bundle archive holds a member of an unsafe type');
        return false;
      }
      if (type === '-') {
        const name = parts.slice(5).join(' ');
        const expectedMode = /\/bin\/pto(-mcp)?\.mjs$/.test(name) ? 'rwxr-xr-x' : 'rw-r--r--';
        if (parts[0].slice(1) !== expectedMode) {
          fail('a bundle archive member does not use the canonical archive mode');
          return false;
        }
      }
      if (size > MAX_MEMBER_BYTES || total + size > MAX_MEMBER_BYTES * MAX_MEMBERS) {
        fail('a bundle archive is outside its size bound');
        return false;
      }
      total += size;
      if (type === '-' && /\/bin\/pto(-mcp)?\.mjs$/.test(parts.slice(5).join(' '))) {
        if (!parts[0].slice(1).includes('x')) {
          fail('a bundle entry point is not executable');
          return false;
        }
      }
    }
  }
  log('ok: archives vetted by type, path, and size before extraction');
  return true;
}

/** Extracts each vetted tarball into the scratch area and returns the package roots. */
async function extractTarballs(scratch, root, expectedNames) {
  const roots = new Map();
  for (const name of expectedNames) {
    const destination = join(scratch, 'extract', name.replace(/\.tgz$/, ''));
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const tar = runSync(
      'tar',
      ['-xzf', join(root, name), '-C', destination, '--no-same-owner', '--preserve-permissions'],
      { cwd: scratch },
    );
    if (tar.status !== 0) {
      fail('a bundle archive could not be extracted');
      return null;
    }
    roots.set(name, join(destination, 'package'));
  }
  return roots;
}

async function walkFiles(root) {
  const found = [];
  const stack = [root];
  for (;;) {
    const current = stack.pop();
    if (current === undefined) return found;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      found.push({ path: join(current, entry.name), entry });
      if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push(join(current, entry.name));
    }
  }
}

async function verifyTarballContent(roots, workspaceByName, rootEngines) {
  let good = true;
  for (const [name, root] of roots) {
    // The archives were vetted before extraction; the walk re-asserts the
    // extracted tree holds only regular files and directories, no links, and
    // the canonical archive modes.
    for (const { path, entry } of await walkFiles(root)) {
      const relative = path.slice(root.length + 1);
      if (entry.isSymbolicLink()) {
        fail('a bundle archive holds a link instead of a regular file');
        good = false;
      } else if (!entry.isFile() && !entry.isDirectory()) {
        fail('a bundle archive holds a special file');
        good = false;
      } else if (entry.isFile()) {
        const info = await lstat(path);
        const expectedMode = /(^|\/)bin\/pto(-mcp)?\.mjs$/.test(relative) ? 0o755 : 0o644;
        if ((info.mode & 0o777) !== expectedMode) {
          fail('a bundle archive member does not use the canonical archive mode');
          good = false;
        }
      }
    }
    const manifest = await readJsonFile(join(root, 'package.json')).catch(() => null);
    if (manifest === null) {
      fail('a bundle archive is missing its package manifest');
      good = false;
      continue;
    }
    const workspace = workspaceByName.get(manifest.name);
    if (workspace?.tarball !== name || manifest.version !== workspace.version) {
      fail('a bundle manifest does not match its reviewed workspace');
      good = false;
    }
    if (manifest.private !== true) {
      fail('a distributed bundle must stay private');
      good = false;
    }
    if (manifest.license !== 'UNLICENSED') {
      fail('a bundle manifest lost its existing license metadata');
      good = false;
    }
    if (manifest.engines?.node !== rootEngines.node || manifest.engines?.npm !== rootEngines.npm) {
      fail('a bundle manifest does not carry the reviewed engines floor');
      good = false;
    }
  }
  const required = [
    ['cli', 'bin/pto.mjs', true],
    ['cli', 'dist/main.js', false],
    ['mcp', 'bin/pto-mcp.mjs', true],
    ['mcp', 'dist/main.js', false],
    ['api-client', 'dist/index.js', false],
    ['agent-auth', 'dist/index.js', false],
    ['agent-auth', 'libexec/secret-service.py', false],
  ];
  for (const [kind, member, executable] of required) {
    const workspace = [...workspaceByName.values()].find((candidate) =>
      candidate.dir.endsWith(kind),
    );
    const root = roots.get(workspace.tarball);
    const target = join(root, member);
    const info = await stat(target).catch(() => null);
    if (info === null || !info.isFile()) {
      fail(`a bundle archive is missing its required member: ${member}`);
      good = false;
      continue;
    }
    if (executable && (info.mode & 0o111) === 0) {
      fail(`a bundle entry point is not executable: ${member}`);
      good = false;
    }
  }
  const helper = join(
    roots.get(
      tarballName(
        '@pto-calendar/agent-auth',
        workspaceByName.get('@pto-calendar/agent-auth').version,
      ),
    ),
    'libexec',
    'secret-service.py',
  );
  const firstLine = (await readFile(helper, 'utf8').catch(() => '')).split('\n')[0];
  if (firstLine !== '#!/usr/bin/python3') {
    fail('the bundled Secret Service helper is not the pinned helper');
    good = false;
  }
  if (good) log('ok: tarball members, entry points, helper, and manifests are exact');
  return good;
}

/**
 * Reviews the exact consumer manifests: dependencies are exactly the four
 * relative `file:` bundles, the lockfile root pins them, every bundle
 * integrity matches its verified archive, and every other entry is a public
 * registry pin at the exact reviewed root-lock placement.
 */
async function verifyConsumerManifests(bundle, digests, rootLock, workspaceByName) {
  const manifest = await readJsonFile(join(bundle.root, 'package.json'));
  const lock = await readJsonFile(join(bundle.root, 'package-lock.json'));
  const fields = ['dependencies', 'engines', 'license', 'name', 'private', 'version'];
  if (
    manifest?.private !== true ||
    manifest.license !== 'UNLICENSED' ||
    Object.keys(manifest).sort().join(',') !== fields.join(',') ||
    lock?.lockfileVersion !== 3 ||
    lock.packages?.['']?.private !== true ||
    Object.keys(manifest.dependencies ?? {}).length !== workspaceByName.size ||
    Object.keys(lock.packages[''].dependencies ?? {}).length !== workspaceByName.size
  ) {
    fail('the consumer manifest or v3 lock has an unexpected shape');
    return false;
  }
  const local = new Set();
  for (const [name, workspace] of workspaceByName) {
    const location = `node_modules/${name}`;
    const entry = lock.packages[location];
    const spec = `file:${workspace.tarball}`;
    if (
      manifest.dependencies[name] !== spec ||
      lock.packages[''].dependencies[name] !== spec ||
      entry?.resolved !== spec ||
      entry.version !== workspace.version ||
      entry.integrity !== digests.get(workspace.tarball) ||
      entry.link === true
    ) {
      fail('a local dependency does not pin its verified archive');
      return false;
    }
    local.add(location);
  }
  const publicPin = /^https:\/\/registry\.npmjs\.org\/[\w@./%-]+\.tgz$/;
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '' || local.has(key)) continue;
    const reviewed = rootLock.packages?.[key];
    if (
      !key.startsWith('node_modules/') ||
      key.includes('/@pto-calendar/') ||
      entry?.link === true ||
      !publicPin.test(entry?.resolved ?? '') ||
      entry.resolved !== reviewed?.resolved ||
      entry.version !== reviewed.version ||
      !/^sha512-/.test(entry.integrity) ||
      entry.integrity !== reviewed.integrity
    ) {
      fail('a lockfile dependency differs from its reviewed public pin or placement');
      return false;
    }
  }
  for (const [key, reviewed] of Object.entries(rootLock.packages)) {
    if (
      key.startsWith('node_modules/') &&
      key.endsWith('/content-type') &&
      lock.packages[key]?.version !== reviewed.version
    ) {
      fail('the consumer lock dropped or flattened a reviewed content-type placement');
      return false;
    }
  }
  log('ok: consumer manifests reference only verified bundles and reviewed public pins');
  return true;
}

/** Use only the cache warmed by the repository's normal root npm ci. */
function npmCiOffline(consumerDir, home, realCache, label) {
  const result = spawnSync(
    'npm',
    ['ci', '--offline', '--ignore-scripts', '--omit=dev', '--no-fund'],
    {
      cwd: consumerDir,
      timeout: NPM_CI_TIMEOUT_MS,
      encoding: 'utf8',
      env: childEnv(home, { npm_config_cache: realCache }),
    },
  );
  if (result.status === 0) {
    log(`ok: ${label}`);
    return true;
  }
  fail(
    'the offline clean install failed: warm it with the root npm ci so the reviewed cache holds every pin',
  );
  return false;
}

async function assertExecutable(path) {
  const info = await stat(path).catch(() => null);
  if (info === null || !info.isFile()) return false;
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
}

async function verifyInstalledDuplicates(prefix, rootLock) {
  for (const [key, pin] of Object.entries(rootLock.packages)) {
    if (!key.startsWith('node_modules/') || !key.endsWith('/content-type')) continue;
    const manifest = await readJsonFile(join(prefix, key, 'package.json'));
    const manifestPath = await realpath(join(prefix, key, 'package.json'));
    if (
      !inside(prefix, manifestPath) ||
      manifest.name !== 'content-type' ||
      manifest.version !== pin.version
    ) {
      fail('the external install changed a reviewed content-type version or placement');
      return false;
    }
  }
  log('ok: installed package tree preserves the reviewed duplicate dependency placements');
  return true;
}

async function verifyPrefix(bundle, rootEngines, checkoutHelper) {
  const prefix = await realpath(bundle.root);
  const modules = join(prefix, 'node_modules');
  let good = true;
  for (const [binName, packageName] of [
    ['pto', '@pto-calendar/cli'],
    ['pto-mcp', '@pto-calendar/mcp'],
  ]) {
    const link = join(modules, '.bin', binName);
    const linkStat = await stat(link).catch(() => null);
    if (linkStat === null) {
      fail(`the installed prefix is missing its executable: ${binName}`);
      good = false;
      continue;
    }
    const resolved = await realpath(link).catch(() => null);
    if (resolved === null || !inside(prefix, resolved)) {
      fail(`the installed executable escapes its prefix: ${binName}`);
      good = false;
      continue;
    }
    if (!(await assertExecutable(resolved))) {
      fail(`the installed executable is not executable: ${binName}`);
      good = false;
    }
    const source = await readFile(resolved, 'utf8').catch(() => '');
    if (!source.startsWith('#!/usr/bin/env node')) {
      fail(`the installed executable lost its launcher line: ${binName}`);
      good = false;
    }
    const manifestPath = join(modules, ...packageName.split('/'), 'package.json');
    const manifest = await readJsonFile(manifestPath).catch(() => null);
    const declared = manifest?.bin?.[binName];
    if (typeof declared !== 'string') {
      fail(`the installed manifest does not declare its executable: ${binName}`);
      good = false;
      continue;
    }
    const declaredReal = await realpath(join(dirname(manifestPath), declared)).catch(() => null);
    if (declaredReal !== resolved) {
      fail(`the installed executable does not match its manifest: ${binName}`);
      good = false;
    }
    log(`ok: installed executable resolves inside the prefix: ${binName}`);
  }
  for (const packageName of WORKSPACES.map((workspace) => workspace.name)) {
    const directory = join(modules, ...packageName.split('/'));
    const manifest = await readJsonFile(join(directory, 'package.json')).catch(() => null);
    if (manifest === null) {
      fail(`the installed package is missing: ${packageName}`);
      good = false;
      continue;
    }
    if (manifest.engines?.node !== rootEngines.node || manifest.engines?.npm !== rootEngines.npm) {
      fail(`the installed package does not carry the reviewed engines floor: ${packageName}`);
      good = false;
    }
    const exportPath =
      manifest.exports?.['.']?.import ?? manifest.exports?.['.']?.default ?? manifest.main;
    if (typeof exportPath === 'string') {
      const entryReal = await realpath(join(directory, exportPath)).catch(() => null);
      if (entryReal === null || !inside(prefix, entryReal)) {
        fail(`the installed package entry escapes its prefix: ${packageName}`);
        good = false;
        continue;
      }
    } else {
      // Tool packages expose bins only; their compiled entry backs the bins.
      const entryReal = await realpath(join(directory, 'dist', 'main.js')).catch(() => null);
      if (entryReal === null || !inside(prefix, entryReal)) {
        fail(`the installed tool package lacks its compiled entry: ${packageName}`);
        good = false;
        continue;
      }
    }
    const directoryReal = await realpath(directory);
    if (!inside(prefix, directoryReal)) {
      fail(`the installed package is not the prefix copy: ${packageName}`);
      good = false;
    }
  }
  const helper = join(modules, '@pto-calendar', 'agent-auth', 'libexec', 'secret-service.py');
  const helperReal = await realpath(helper).catch(() => null);
  const checkoutReal = await realpath(checkoutHelper).catch(() => null);
  if (helperReal === null || !inside(prefix, helperReal)) {
    fail('the installed Secret Service helper is missing from the prefix');
    good = false;
  } else if (
    helperReal === checkoutReal ||
    !(await readFile(helperReal)).equals(await readFile(checkoutHelper))
  ) {
    fail('the installed Secret Service helper is not the packaged copy');
    good = false;
  } else {
    const keyring = await readFile(
      join(modules, '@pto-calendar', 'agent-auth', 'dist', 'keyring.js'),
      'utf8',
    ).catch(() => '');
    if (!keyring.includes('libexec/secret-service.py')) {
      fail('the installed credential package does not wire its bundled helper');
      good = false;
    } else {
      log('ok: Secret Service helper is the installed prefix copy');
    }
  }
  // The internal workspace links must resolve to hoisted prefix copies, never
  // back to the monorepo checkout.
  for (const packageName of ['@pto-calendar/agent-auth', '@pto-calendar/api-client']) {
    const directoryReal = await realpath(join(modules, ...packageName.split('/'))).catch(
      () => null,
    );
    if (directoryReal === null || !inside(prefix, directoryReal)) {
      fail(`a runtime dependency escapes the prefix: ${packageName}`);
      good = false;
    }
  }
  if (good) log('ok: bins, exports, helper, and engines resolve inside the prefix');
  return good ? prefix : null;
}

/** Starts the owned loopback fixture answering only the documented reads. */
async function startFixture() {
  const seen = [];
  const row = {
    id: FIRST,
    startDate: '2026-12-07',
    endDate: '2026-12-07',
    dayPart: 'all_day',
    note: null,
    version: 1,
    user: { id: OWNER, name: 'Ada Lovelace', colorCode: '#336699' },
  };
  const identity = {
    id: OWNER,
    role: 'member',
    auth: {
      method: 'pat',
      tokenId: TOKEN_ID,
      scopes: ['pto:read'],
      expiresAt: '2030-01-01T00:00:00.000Z',
    },
  };
  const server = createServer((request, response) => {
    seen.push({
      method: request.method ?? '',
      path: request.url ?? '',
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
    });
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (
      request.headers.authorization !== `Bearer ${TOKEN}` ||
      request.headers.cookie !== undefined
    ) {
      send(401, { error: { code: 'UNAUTHENTICATED', message: 'Not valid.' } });
      return;
    }
    if (request.method !== 'GET') return void send(405, { error: { code: 'NOT_ALLOWED' } });
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/auth/me') return void send(200, identity);
    if (path === '/pto') return void send(200, { items: [row], nextCursor: null, hasMore: false });
    if (path === `/pto/${FIRST}`) return void send(200, row);
    return void send(404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close').catch(() => undefined);
    },
  };
}

function assertBearerOnly(seen, wanted) {
  if (seen.length !== wanted.length) {
    fail('the fixture saw an unexpected number of requests');
    return false;
  }
  for (const [i, request] of seen.entries()) {
    if (
      request.method !== 'GET' ||
      request.authorization !== `Bearer ${TOKEN}` ||
      request.cookie !== undefined
    ) {
      fail('a fixture request did not carry exactly the synthetic bearer credential');
      return false;
    }
    if (request.path.split('?')[0] !== wanted[i]) {
      fail('a fixture request left the documented read shapes');
      return false;
    }
  }
  return true;
}

/**
 * Runs one installed CLI command asynchronously: the loopback fixture lives
 * in this process, so a synchronous spawn would block it from answering.
 */
function runInstalledCli(prefix, home, cwd, args, token, input = null) {
  const bin = join(prefix, 'node_modules', '.bin', 'pto');
  const extra = token === null ? {} : { PTO_API_ORIGIN: token.origin, PTO_API_TOKEN: token.value };
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      env: childEnv(home, extra),
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS);
    let bytes = 0;
    const collect = (chunks) => (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_TOOL_OUTPUT_BYTES) child.kill('SIGKILL');
      else chunks.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    if (input !== null) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
    }
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ status: null, signal: null, stdout: '', stderr: '', error: true });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        status: code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function singleJsonOutput(result, label) {
  if (result.status !== 0) {
    if (result.error !== undefined && result.error !== null) {
      fail(`${label} failed to start`);
    } else if (result.signal !== undefined && result.signal !== null) {
      fail(`${label} was stopped before it answered`);
    } else {
      fail(`${label} exited with status ${result.status ?? 'unknown'}`);
    }
    return null;
  }
  if (!assertClean(`${label} output`, `${result.stdout ?? ''}${result.stderr ?? ''}`)) {
    return null;
  }
  if (result.stdout.includes(NOTE) || result.stderr.includes(NOTE)) {
    fail(`${label} leaked the synthetic note`);
    return null;
  }
  const lines = String(result.stdout).split('\n');
  if (lines.length !== 2 || lines[1] !== '' || !lines[0].endsWith('}')) {
    fail(`${label} did not write exactly one JSON object`);
    return null;
  }
  try {
    return JSON.parse(lines[0]);
  } catch {
    fail(`${label} did not write parseable JSON`);
    return null;
  }
}

/** Hashes/modes of the real default profile store; never returns its bytes. */
async function snapshotProfile(directory) {
  const info = await lstat(directory).catch(() => null);
  if (info === null || !info.isDirectory() || info.isSymbolicLink()) {
    fail('the default profile store is not a real directory');
    return null;
  }
  if ((info.mode & 0o077) !== 0) {
    fail('the default profile store is not owner-only');
    return null;
  }
  if ((info.mode & 0o777) !== 0o700) {
    fail('the default profile store is not mode 0700');
    return null;
  }
  const real = await realpath(directory).catch(() => null);
  if (real !== directory) {
    fail('the default profile store is not the canonical directory');
    return null;
  }
  const files = [];
  for (const { path, entry } of await walkFiles(directory)) {
    if (entry.isSymbolicLink()) {
      fail('the default profile store holds a symlink');
      return null;
    }
    if (entry.isDirectory()) continue;
    if (!entry.isFile()) {
      fail('the default profile store holds a special file');
      return null;
    }
    const fileInfo = await lstat(path);
    if ((fileInfo.mode & 0o077) !== 0) {
      fail('a default profile file is not owner-only');
      return null;
    }
    const bytes = await readFile(path);
    files.push({
      path: path.slice(directory.length + 1),
      mode: fileInfo.mode & 0o777,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const defaultFile = files.find((file) => file.path === 'default.json');
  if (defaultFile === undefined) {
    fail('the default file profile is missing');
    return null;
  }
  if (defaultFile.mode !== 0o600) {
    fail('the default profile file is not mode 0600');
    return null;
  }
  return { directoryMode: info.mode & 0o777, files };
}

function sameProfileSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Stores the synthetic token through the installed CLI with an explicit
 * plaintext file opt-in and private stdin. The default profile directory is
 * the real HOME/.config path used by both slots, not XDG_CONFIG_HOME.
 */
async function setOriginProfile(prefix, home, cwd, fixture) {
  const requestsBefore = fixture.seen.length;
  const set = singleJsonOutput(
    await runInstalledCli(
      prefix,
      home,
      cwd,
      [
        'auth',
        'set',
        '--storage',
        'file',
        '--origin',
        fixture.origin,
        '--allow-loopback-http',
        '--token-stdin',
        '--json',
      ],
      null,
      `${TOKEN}\n`,
    ),
    'installed pto auth set',
  );
  if (set === null) return null;
  if (
    set.ok !== true ||
    set.command !== 'auth-set' ||
    set.data?.profile !== 'default' ||
    set.data?.origin !== fixture.origin ||
    set.data?.source !== 'file'
  ) {
    fail('installed pto auth set did not store the default origin-bound file profile');
    return null;
  }
  if (fixture.seen.length !== requestsBefore) {
    fail('installed pto auth set contacted the service');
    return null;
  }
  const xdgDirectory = join(home, 'config', 'pto-calendar', 'agent-auth');
  if (await exists(xdgDirectory)) {
    fail('the profile store used XDG_CONFIG_HOME instead of HOME');
    return null;
  }
  const directory = join(home, '.config', 'pto-calendar', 'agent-auth');
  const snapshot = await snapshotProfile(directory);
  if (snapshot === null) return null;
  log(
    'ok: installed pto auth set stored the default file profile under HOME/.config (not XDG_CONFIG_HOME)',
  );
  return { directory, snapshot };
}

/** Reads through the installed slot using the shared origin-bound profile. */
async function verifyProfileRead(prefix, home, cwd, fixture, label) {
  const requestsBefore = fixture.seen.length;
  const list = singleJsonOutput(
    await runInstalledCli(
      prefix,
      home,
      cwd,
      ['list', '--from', '2026-12-07', '--to', '2026-12-07', '--json'],
      null,
    ),
    `${label} installed pto profile list`,
  );
  if (list === null) return false;
  if (
    list.ok !== true ||
    list.command !== 'list' ||
    list.data?.complete !== true ||
    list.data?.reason !== 'complete' ||
    !Array.isArray(list.data?.items) ||
    list.data.items.length !== 1 ||
    list.data.items[0]?.id !== FIRST ||
    list.data.items[0]?.note !== null
  ) {
    fail(`${label} installed pto profile list did not return the synthetic read`);
    return false;
  }
  const get = singleJsonOutput(
    await runInstalledCli(prefix, home, cwd, ['get', FIRST, '--json'], null),
    `${label} installed pto profile get`,
  );
  if (get === null) return false;
  if (
    get.ok !== true ||
    get.command !== 'get' ||
    get.data?.id !== FIRST ||
    get.data?.note !== null
  ) {
    fail(`${label} installed pto profile get did not return the synthetic record`);
    return false;
  }
  if (!assertBearerOnly(fixture.seen.slice(requestsBefore), ['/pto', `/pto/${FIRST}`])) {
    return false;
  }
  log(`ok: ${label} installed slot served reads from the default file profile`);
  return true;
}

/** A raw JSON-RPC stdio client: the installed binary is the only MCP party. */
class RawMcpClient {
  constructor(binary, env, cwd) {
    this.process = spawn(binary, ['--allow-loopback-http'], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.lines = [];
    this.stderr = '';
    this.buffer = '';
    this.bytes = 0;
    this.done = false;
    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', (text) => {
      if (!this.accept(text)) return;
      this.buffer += text;
      let index = this.buffer.indexOf('\n');
      while (index !== -1) {
        this.lines.push(this.buffer.slice(0, index));
        this.buffer = this.buffer.slice(index + 1);
        index = this.buffer.indexOf('\n');
      }
    });
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', (text) => {
      if (this.accept(text)) this.stderr += text;
    });
    this.process.stdin.on('error', () => undefined);
    this.exit = new Promise((resolve) => {
      const finish = (code, signal) => {
        this.done = true;
        resolve({ code, signal });
      };
      this.process.once('close', finish);
      this.process.once('error', () => finish(null, null));
    });
  }

  accept(text) {
    this.bytes += Buffer.byteLength(text);
    if (this.bytes <= MAX_TOOL_OUTPUT_BYTES) return true;
    this.kill();
    return false;
  }

  send(value) {
    this.process.stdin.write(`${JSON.stringify(value)}\n`);
  }

  async reply(id) {
    const deadline = Date.now() + MCP_REPLY_TIMEOUT_MS;
    for (;;) {
      const found = this.lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .find((message) => message !== null && message.id === id);
      if (found !== undefined) return found;
      if (this.done || Date.now() > deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  end() {
    this.process.stdin.end();
  }

  async close() {
    this.end();
    const timer = setTimeout(() => this.kill(), CHILD_TIMEOUT_MS);
    try {
      return await this.exit;
    } finally {
      clearTimeout(timer);
    }
  }

  kill() {
    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill('SIGKILL');
    }
  }
}

async function verifyInstalledCli(prefix, scratch, home, fixture, artifactVersion) {
  const cwd = join(scratch, 'cli-cwd');
  await mkdir(cwd, { mode: 0o700 });
  // A decoy dotenv the tool must never read: only the managed pair answers.
  await writeFile(cwd + '/.env', 'PTO_API_ORIGIN=https://untrusted.example.invalid\n', {
    mode: 0o600,
  });
  const token = { origin: fixture.origin, value: TOKEN };
  if (!(await verifyCliVersion(prefix, home, cwd, artifactVersion))) return false;
  const requestsBefore = fixture.seen.length;
  const list = singleJsonOutput(
    await runInstalledCli(
      prefix,
      home,
      cwd,
      ['list', '--from', '2026-12-07', '--to', '2026-12-07', '--allow-loopback-http', '--json'],
      token,
    ),
    'installed pto list',
  );
  if (list === null) return false;
  if (
    list.ok !== true ||
    list.command !== 'list' ||
    list.data?.complete !== true ||
    list.data?.reason !== 'complete' ||
    !Array.isArray(list.data?.items) ||
    list.data.items.length !== 1 ||
    list.data.items[0]?.id !== FIRST ||
    list.data.items[0]?.note !== null
  ) {
    fail('installed pto list did not return the synthetic read without notes');
    return false;
  }
  const get = singleJsonOutput(
    await runInstalledCli(
      prefix,
      home,
      cwd,
      ['get', FIRST, '--allow-loopback-http', '--json'],
      token,
    ),
    'installed pto get',
  );
  if (get === null) return false;
  if (
    get.ok !== true ||
    get.command !== 'get' ||
    get.data?.id !== FIRST ||
    get.data?.note !== null
  ) {
    fail('installed pto get did not return the synthetic record');
    return false;
  }
  if (!assertBearerOnly(fixture.seen.slice(requestsBefore), ['/pto', `/pto/${FIRST}`]))
    return false;
  log('ok: installed CLI served list and get from the loopback fixture');
  return true;
}

async function verifyCliVersion(prefix, home, cwd, artifactVersion) {
  const version = singleJsonOutput(
    await runInstalledCli(prefix, home, cwd, ['--version', '--json'], null),
    'installed pto --version',
  );
  if (
    version?.ok === true &&
    version.command === 'version' &&
    version.data?.version === artifactVersion
  ) {
    return true;
  }
  fail('installed pto did not report the packed version');
  return false;
}

async function verifyInstalledMcp(prefix, scratch, home, fixture, artifactVersion) {
  const binary = join(prefix, 'node_modules', '.bin', 'pto-mcp');
  const requestsBefore = fixture.seen.length;
  const client = new RawMcpClient(
    binary,
    childEnv(home, { PTO_API_ORIGIN: fixture.origin, PTO_API_TOKEN: TOKEN }),
    scratch,
  );
  try {
    client.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: CLASSIC_PROTOCOL,
        capabilities: {},
        clientInfo: { name: 'pack-check', version: '0.1.0' },
      },
    });
    const hello = await client.reply(1);
    if (
      hello === null ||
      hello.result?.protocolVersion !== CLASSIC_PROTOCOL ||
      hello.result?.serverInfo?.name !== 'pto-mcp' ||
      hello.result?.serverInfo?.version !== artifactVersion ||
      hello.result?.capabilities?.tools === undefined
    ) {
      fail('installed pto-mcp did not negotiate the classic protocol');
      return false;
    }
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const listed = await client.reply(2);
    const tools = listed?.result?.tools;
    if (!Array.isArray(tools) || tools.map((tool) => tool?.name).join(',') !== 'pto_list,pto_get') {
      fail('installed pto-mcp did not discover exactly the two read-only tools');
      return false;
    }
    for (const tool of tools) {
      if (
        tool?.annotations?.readOnlyHint !== true ||
        tool?.inputSchema?.additionalProperties !== false
      ) {
        fail('installed pto-mcp discovery is not the read-only closed shape');
        return false;
      }
    }
    const call = (id, name, args) =>
      client.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    call(3, 'pto_list', { from: '2026-12-07', to: '2026-12-07' });
    const listMessage = await client.reply(3);
    const listResult = listMessage?.result;
    const structured = listResult?.structuredContent;
    if (
      listResult?.isError !== false ||
      structured?.ok !== true ||
      structured?.tool !== 'pto_list' ||
      !Array.isArray(structured?.data?.items) ||
      structured.data.items.length !== 1 ||
      structured.data.items[0]?.id !== FIRST ||
      structured.data.items[0]?.note !== null
    ) {
      fail('installed pto-mcp pto_list did not return the synthetic read');
      return false;
    }
    if (listResult.content?.[0]?.text !== JSON.stringify(structured)) {
      fail('installed pto-mcp pto_list text and structure disagree');
      return false;
    }
    call(4, 'pto_get', { id: FIRST });
    const defaultGet = (await client.reply(4))?.result?.structuredContent;
    if (defaultGet?.ok !== true || defaultGet.data?.id !== FIRST || defaultGet.data.note !== null) {
      fail('installed pto-mcp pto_get did not return the synthetic record without a note');
      return false;
    }
    call(5, 'pto_get', { id: FIRST, includeNote: true });
    const notedGet = (await client.reply(5))?.result?.structuredContent;
    if (notedGet?.ok !== true || notedGet?.data?.note !== null) {
      fail('installed pto-mcp returned a note for the read-only fixture');
      return false;
    }
    call(6, 'pto_write_probe_forbidden', {});
    const probe = await client.reply(6);
    if (probe?.error?.code !== -32602 || JSON.stringify(probe).includes('pto_write_probe')) {
      fail('installed pto-mcp echoed or mishandled an unknown tool');
      return false;
    }
    for (const line of client.lines) {
      let message = null;
      try {
        message = JSON.parse(line);
      } catch {
        fail('installed pto-mcp wrote a non-JSON-RPC line');
        return false;
      }
      if (message?.jsonrpc !== '2.0') {
        fail('installed pto-mcp wrote a malformed protocol line');
        return false;
      }
    }
    const exit = await client.close();
    if (exit.code !== 0 || client.buffer !== '') {
      fail('installed pto-mcp did not exit cleanly on stdin close');
      return false;
    }
    const output = `${client.lines.join('\n')}${client.stderr}`;
    if (!assertClean('installed pto-mcp streams', output)) return false;
    if (output.includes(NOTE)) {
      fail('installed pto-mcp streams leaked the synthetic note');
      return false;
    }
    if (
      !assertBearerOnly(fixture.seen.slice(requestsBefore), [
        '/pto',
        `/pto/${FIRST}`,
        `/pto/${FIRST}`,
      ])
    ) {
      return false;
    }
    log('ok: installed pto-mcp negotiated classic stdio and served pto_list/pto_get');
    return true;
  } finally {
    client.kill();
  }
}

/** Switch explicit launch paths, roll back to the prior intact install, then remove the new slot. */
async function verifySlots({
  scratch,
  prior,
  priorOwner,
  next,
  nextOwner,
  home,
  realCache,
  artifactVersion,
  fixture,
  profileCwd,
  profileDir,
}) {
  const profileBefore = await snapshotProfile(profileDir);
  if (profileBefore === null) return false;
  let priorBefore;
  try {
    priorBefore = await snapshotSlotTree(prior, { expectedOwner: priorOwner });
  } catch {
    fail('the owned prior installation tree could not be read safely');
    return false;
  }
  if (!npmCiOffline(next, home, realCache, 'same-version side-by-side install succeeded'))
    return false;
  if (!(await verifyCliVersion(next, home, scratch, artifactVersion))) return false;
  if (!(await verifyCliVersion(prior, home, scratch, artifactVersion))) return false;
  if (!(await verifyProfileRead(next, home, profileCwd, fixture, 'candidate'))) return false;
  if (!(await verifyProfileRead(prior, home, profileCwd, fixture, 'prior rollback'))) return false;
  if (!(await removeOwnedSlot(nextOwner))) return false;
  let priorAfter;
  try {
    priorAfter = await snapshotSlotTree(prior, { expectedOwner: priorOwner });
  } catch {
    fail('the owned prior installation tree could not be read safely after candidate removal');
    return false;
  }
  const afterDiff = compareSlotSnapshots(priorBefore, priorAfter);
  if (!afterDiff.equal) {
    fail('the owned prior installation tree changed during the slot rollback exercise');
    return false;
  }
  const profileAfter = await snapshotProfile(profileDir);
  if (
    (await exists(next)) ||
    !sameProfileSnapshot(profileBefore, profileAfter) ||
    !(await verifyCliVersion(prior, home, scratch, artifactVersion))
  ) {
    fail('slot rollback or removal changed the prior installation or shared profile');
    return false;
  }
  if (!(await verifyProfileRead(prior, home, profileCwd, fixture, 'prior after removal')))
    return false;
  let priorFinal;
  try {
    priorFinal = await snapshotSlotTree(prior, { expectedOwner: priorOwner });
  } catch {
    fail('the owned prior installation tree could not be read safely after the final read');
    return false;
  }
  if (!compareSlotSnapshots(priorBefore, priorFinal).equal) {
    fail('the owned prior installation tree changed after the final rollback read');
    return false;
  }
  const profileFinal = await snapshotProfile(profileDir);
  if (!sameProfileSnapshot(profileBefore, profileFinal)) {
    fail('the final profile read changed the shared origin-bound profile');
    return false;
  }
  log(
    `ok: owned prior installation tree retained ${priorBefore.entries.length} entries / ${priorBefore.totalBytes} bytes and raw link targets across slots`,
  );
  log('ok: default profile files retained their hashes and 0700/0600 modes across slots');
  log('ok: switched launch paths, rolled back, and removed only the second installed slot');
  return true;
}

async function main() {
  if (process.argv.length > 2) {
    failClosed('this smoke takes no arguments');
    return;
  }
  const rootManifest = await readJsonFile(join(ROOT, 'package.json')).catch(() => null);
  const rootLock = await readJsonFile(join(ROOT, 'package-lock.json')).catch(() => null);
  if (rootManifest === null || rootLock === null) {
    failClosed('the repository manifests are unreadable');
    return;
  }
  const rootEngines = rootManifest.engines ?? {};
  if (typeof rootEngines.node !== 'string' || typeof rootEngines.npm !== 'string') {
    failClosed('the root engines floor is missing');
    return;
  }
  const pinned = (await readFile(join(ROOT, '.nvmrc'), 'utf8').catch(() => '')).trim();
  if (rootEngines.node !== `>=${pinned}`) {
    failClosed('the root engines floor does not equal the pinned runtime');
    return;
  }
  log(`runtime floor ${rootEngines.node}; runner ${process.version} (toolchain pin stays covered)`);
  const workspaceByName = new Map();
  for (const workspace of WORKSPACES) {
    const manifest = await readJsonFile(join(ROOT, workspace.dir, 'package.json')).catch(
      () => null,
    );
    if (manifest?.name !== workspace.name || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
      failClosed('a reviewed workspace manifest is unreadable');
      return;
    }
    workspaceByName.set(workspace.name, {
      ...workspace,
      version: manifest.version,
      tarball: tarballName(manifest.name, manifest.version),
    });
  }
  const versions = new Set([...workspaceByName.values()].map((workspace) => workspace.version));
  if (versions.size !== 1) {
    failClosed('the four bundles do not share one artifact version');
    return;
  }
  const [artifactVersion] = versions;
  const expectedNames = new Set(
    [...workspaceByName.values()].map((workspace) => workspace.tarball),
  );

  if (!(await preconditionCompiledOutputs())) return;
  const realCache = await preconditionRootInstall();
  if (realCache === null) return;
  const checkoutHelper = join(ROOT, 'packages', 'agent-auth', 'libexec', 'secret-service.py');
  if (!(await exists(checkoutHelper))) {
    failClosed('the checkout Secret Service helper is missing');
    return;
  }

  const { scratch, home, output, slots } = await createScratch();
  let fixture = null;
  try {
    const pack = spawnSync(process.execPath, [PACK_ENTRY, '--output', output], {
      cwd: ROOT,
      timeout: PACK_TIMEOUT_MS,
      encoding: 'utf8',
      env: childEnv(home),
    });
    if (pack.status !== 0) {
      fail('the real pack did not produce its bundle; run agent:pack separately for diagnostics');
      return;
    }
    const bundle = await locateBundle(output, expectedNames);
    if (bundle === null) return;
    log('ok: core pack produced its bundle in the isolated scratch area');
    const digests = await verifyChecksums(bundle, expectedNames);
    if (digests === null) return;
    if (!(await vetArchives(bundle.root, expectedNames))) return;
    const roots = await extractTarballs(scratch, bundle.root, expectedNames);
    if (roots === null) return;
    if (!(await verifyTarballContent(roots, workspaceByName, rootEngines))) return;
    if (!(await verifyConsumerManifests(bundle, digests, rootLock, workspaceByName))) return;

    const prior = join(slots, 'prior');
    const next = join(slots, 'candidate');
    const slotOwners = new Map();
    for (const slot of [prior, next]) {
      await mkdir(slot, { mode: 0o700 });
      slotOwners.set(slot, await captureOwnedDirectory(slot, slots, { privateParent: true }));
      for (const name of [...expectedNames, 'package.json', 'package-lock.json', 'SHA256SUMS']) {
        await copyFile(join(bundle.root, name), join(slot, name), constants.COPYFILE_EXCL);
      }
    }
    if (!npmCiOffline(prior, home, realCache, 'npm ci --offline installed the reviewed bundle'))
      return;
    const prefix = await verifyPrefix({ root: prior }, rootEngines, checkoutHelper);
    if (prefix === null) return;
    if (!(await verifyInstalledDuplicates(prefix, rootLock))) return;

    const profileCwd = join(scratch, 'profile-cwd');
    await mkdir(profileCwd, { mode: 0o700 });
    fixture = await startFixture();
    try {
      // One fixture serves both tools in sequence; the request log must show
      // only bearer reads when both are done.
      if (!(await verifyInstalledCli(prefix, scratch, home, fixture, artifactVersion))) return;
      if (!(await verifyInstalledMcp(prefix, scratch, home, fixture, artifactVersion))) return;
      log('ok: environment-token CLI and MCP reads were bearer-only and note-free');
      const profile = await setOriginProfile(prefix, home, profileCwd, fixture);
      if (profile === null) return;
      if (!(await verifyProfileRead(prefix, home, profileCwd, fixture, 'prior'))) return;
      if (
        !(await verifySlots({
          scratch,
          prior,
          priorOwner: slotOwners.get(prior),
          next,
          nextOwner: slotOwners.get(next),
          home,
          realCache,
          artifactVersion,
          fixture,
          profileCwd,
          profileDir: profile.directory,
        }))
      )
        return;
    } finally {
      await fixture.close();
      fixture = null;
    }

    if (failures > 0) return;
    log(`PASS: offline bundle smoke held for ${artifactVersion} (same-version slot exercise)`);
  } finally {
    if (fixture !== null) await fixture.close().catch(() => undefined);
    await removeScratch();
  }
}

await main().catch(async () => {
  failClosed('an isolated pack or validation step could not finish');
  await removeScratch().catch(() => failClosed('could not remove the owned scratch area'));
});
