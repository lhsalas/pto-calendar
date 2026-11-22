// Filesystem, process, and archive guards for the private agent bundles (#265).
//
// Everything here is built-in Node or an approved local npm/GNU tool. No
// registry client, npm plugin, package script, or ambient user configuration
// is used. The bundle output is a new private directory outside every
// registered worktree of this repository; archives are checked as actual tar
// files, not only as npm's pack report.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 16 * 1024 * 1024;
export const MAX_MEMBERS = 256;
export const MAX_PATH_LENGTH = 512;

const CHILD_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 16 * 1024 * 1024;

const SECRET_PATH_PATTERNS = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.npmrc$/i,
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)id_(rsa|ed25519|dsa)/i,
  /(^|\/)credentials\.json$/i,
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)(cookies|local storage|login data|web data|history)$/i,
  /(^|\/)(test|tests|__tests__|fixtures?)(\/|$)/i,
  /\.(test|spec)\.(js|mjs|cjs|ts|tsx)$/i,
];

const SECRET_CONTENT_PATTERNS = [
  { label: 'private key material', pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  {
    label: 'a PTO personal access token',
    pattern:
      /\bpto_pat_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-f]{64}\b/i,
  },
  { label: 'an npm authentication token', pattern: /_authToken\s*=/i },
  { label: 'an npm authentication token URL', pattern: /\/\/[^\s"']+:_authToken=/i },
  { label: 'a bearer credential', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{32,}\b/ },
];

export class PackError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PackError';
  }
}

export function fail(message) {
  throw new PackError(message);
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True when target equals root or stays below it. */
export function isInside(root, target) {
  if (target === root) return true;
  return target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

export function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function sha512Integrity(buffer) {
  return `sha512-${createHash('sha512').update(buffer).digest('base64')}`;
}

export function sha1Hex(buffer) {
  return createHash('sha1').update(buffer).digest('hex');
}

export async function lstatOrNull(path) {
  return lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

export async function statOrNull(path) {
  return stat(path).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

export async function readJsonFile(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** Rejects any path that could escape a bundle or smuggle sensitive state. */
export function assertAllowedArtifactPath(relative) {
  if (typeof relative !== 'string' || relative === '') fail('an artifact member path is empty');
  if (relative.length > MAX_PATH_LENGTH) fail('an artifact member path is too long');
  if (isAbsolute(relative) || relative.includes('\\') || relative.includes('\0')) {
    fail(`an artifact member path is not a flat relative POSIX path: ${relative}`);
  }
  if (/[\u0000-\u001f\u007f]/.test(relative)) {
    fail(`an artifact member path carries control characters: ${relative}`);
  }
  const segments = relative.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      fail(`an artifact member path escapes its root: ${relative}`);
    }
    if (segment.startsWith('.')) fail(`an artifact member is hidden: ${relative}`);
  }
  for (const pattern of SECRET_PATH_PATTERNS) {
    if (pattern.test(relative)) fail(`an artifact member is secret-adjacent: ${relative}`);
  }
}

/** Rejects credential material in a source or archive member. */
export function scanArtifactContent(label, buffer) {
  if (buffer.includes(0)) fail(`${label} holds binary content`);
  const text = buffer.toString('utf8');
  for (const { label: kind, pattern } of SECRET_CONTENT_PATTERNS) {
    if (pattern.test(text)) fail(`${label} holds ${kind}`);
  }
}

/**
 * Rejects an ambient project npmrc before any npm child can read it. npm's
 * user/global config is already replaced with empty private files; this is
 * the checkout/workspace project-config boundary.
 */
export async function assertNoNpmrc(paths, label) {
  for (const path of paths) {
    if ((await lstatOrNull(join(path, '.npmrc'))) !== null) {
      fail(`${label} holds an npmrc; packing uses an isolated configuration`);
    }
  }
}

/** Rejects group/world write and non-current ownership on the trusted parent. */
async function assertTrustedParent(parentReal) {
  const info = await stat(parentReal);
  if (!info.isDirectory()) fail('the output parent is not a directory');
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    fail('the output parent is not owned by the current user');
  }
  if ((info.mode & 0o022) !== 0) fail('the output parent is group- or world-writable');
}

/** Permit a root/user-owned sticky temp directory, but not a writable non-sticky ancestor. */
export async function assertTrustedDirectoryChain(directory) {
  const uid = process.getuid();
  for (let current = directory; ; current = dirname(current)) {
    const info = await lstat(current);
    if (!info.isDirectory() || (info.uid !== 0 && info.uid !== uid)) {
      fail('the scratch or output ancestry is not trusted');
    }
    if ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0) {
      fail('the scratch or output ancestry is writable without the sticky bit');
    }
    if (dirname(current) === current) return;
  }
}

async function addWorktreeRoots(commonGitDir, add) {
  const adminRoot = join(commonGitDir, 'worktrees');
  let entries;
  try {
    entries = await readdir(adminRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let text;
    try {
      text = await readFile(join(adminRoot, entry.name, 'gitdir'), 'utf8');
    } catch {
      continue;
    }
    const value = text.trim();
    if (value === '') continue;
    const target = resolve(adminRoot, entry.name, value);
    await add(dirname(target));
  }
}

/**
 * Every registered worktree root of this repository, plus its git metadata.
 * This avoids invoking git and refuses a bundle written inside any checkout.
 */
export async function collectRepositoryRoots(sourceRoot) {
  const roots = new Set();
  const add = async (candidate) => {
    const info = await lstat(candidate).catch(() => null);
    if (info === null) return;
    const real = await realpath(candidate).catch(() => null);
    if (real !== null) roots.add(real);
  };
  await add(sourceRoot);
  let commonGitDir = null;
  const dotGit = join(sourceRoot, '.git');
  const info = await lstat(dotGit).catch(() => null);
  if (info !== null && info.isFile() && !info.isSymbolicLink()) {
    const text = await readFile(dotGit, 'utf8');
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
    if (match !== null) {
      const gitDir = resolve(sourceRoot, match[1]);
      const parent = dirname(gitDir);
      commonGitDir = basename(parent) === 'worktrees' ? dirname(parent) : gitDir;
    }
  } else if (info !== null && info.isDirectory() && !info.isSymbolicLink()) {
    commonGitDir = dotGit;
  }
  if (commonGitDir !== null) {
    await add(commonGitDir);
    const mainRoot = dirname(commonGitDir);
    if (mainRoot !== commonGitDir) await add(mainRoot);
    await addWorktreeRoots(commonGitDir, add);
  }
  return [...roots];
}

/**
 * Records the exact owned directory identity for a later fail-closed cleanup.
 * A replacement inode, a symlinked path, a foreign owner or a replaced
 * parent is never accepted as the directory this run created.
 */
export async function captureOwnedDirectory(path, parentRoot, { privateParent = false } = {}) {
  const parentInfo = await lstat(parentRoot).catch(() => null);
  if (parentInfo === null || !parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    fail('the owned directory parent is not a real directory');
  }
  const parentReal = await realpath(parentRoot);
  const info = await lstat(path).catch(() => null);
  if (info === null || !info.isDirectory() || info.isSymbolicLink()) {
    fail('the owned directory is not a real directory');
  }
  const real = await realpath(path).catch(() => null);
  if (real === null || real !== path || !isInside(parentReal, real) || real === parentReal) {
    fail('the owned directory is not inside its trusted parent');
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid !== null && info.uid !== uid) fail('the owned directory is not owned by this user');
  if ((info.mode & 0o077) !== 0) fail('the owned directory is not private');
  if (privateParent) {
    if (uid !== null && parentInfo.uid !== uid) {
      fail('the owned directory parent is not owned by this user');
    }
    if ((parentInfo.mode & 0o022) !== 0) {
      fail('the owned directory parent is group- or world-writable');
    }
  }
  const parentRealInfo = await lstat(parentReal);
  return {
    path: real,
    parent: parentReal,
    dev: info.dev,
    ino: info.ino,
    uid: info.uid,
    parentDev: parentRealInfo.dev,
    parentIno: parentRealInfo.ino,
    parentUid: parentRealInfo.uid,
  };
}

/** Removes only the exact owned directory, or leaves the replacement intact. */
export async function removeOwnedDirectory(owner) {
  if (owner === null || typeof owner !== 'object' || typeof owner.path !== 'string') return false;
  const info = await lstat(owner.path).catch(() => null);
  if (info === null || !info.isDirectory() || info.isSymbolicLink()) return false;
  if (`${info.dev}:${info.ino}` !== `${owner.dev}:${owner.ino}`) return false;
  if (typeof process.getuid === 'function' && info.uid !== owner.uid) return false;
  const real = await realpath(owner.path).catch(() => null);
  if (real === null || real !== owner.path || !isInside(owner.parent, real)) return false;
  if (real === owner.parent) return false;
  const parentInfo = await lstat(owner.parent).catch(() => null);
  if (parentInfo === null || !parentInfo.isDirectory() || parentInfo.isSymbolicLink()) return false;
  if (`${parentInfo.dev}:${parentInfo.ino}` !== `${owner.parentDev}:${owner.parentIno}`)
    return false;
  if (typeof process.getuid === 'function' && parentInfo.uid !== owner.parentUid) return false;
  // Identity alone is not enough if a shared non-sticky ancestor lets
  // another user replace the path between inspection and recursive removal.
  try {
    await assertTrustedDirectoryChain(owner.parent);
  } catch {
    return false;
  }
  await rm(owner.path, { recursive: true, force: true });
  return true;
}

/**
 * Validates and creates a brand-new private output directory.
 * The returned cleanup removes only this run's directory.
 */
export async function prepareOutputDirectory(outputArgument, sourceRoot) {
  if (typeof outputArgument !== 'string' || outputArgument.trim() === '') {
    fail('--output requires a non-empty path');
  }
  const lexical = resolve(outputArgument);
  const name = basename(lexical);
  if (name === '' || name === '.' || name === '..' || /[\u0000-\u001f\u007f]/.test(name)) {
    fail('the output path has an invalid final component');
  }
  const parentLexical = dirname(lexical);
  const parentReal = await realpath(parentLexical).catch(() => null);
  if (parentReal === null) fail('the output parent does not exist');
  await assertTrustedParent(parentReal);
  await assertTrustedDirectoryChain(parentReal);
  const roots = await collectRepositoryRoots(sourceRoot);
  for (const root of roots) {
    if (isInside(root, parentReal)) {
      fail('the output must be outside every source worktree and git metadata directory');
    }
  }
  const output = join(parentReal, name);
  if ((await lstatOrNull(output)) !== null) {
    fail('the output path already exists or is a symlink; never overwrite a bundle');
  }
  try {
    await mkdir(output, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') fail('the output path already exists; never overwrite a bundle');
    throw error;
  }
  const info = await lstat(output);
  const createdReal = await realpath(output).catch(() => null);
  if (!info.isDirectory() || info.isSymbolicLink() || createdReal !== output) {
    fail('the output directory was replaced while it was being created');
  }
  const owned = await captureOwnedDirectory(output, parentReal);
  await chmod(output, 0o700);
  return {
    output: owned.path,
    parent: parentReal,
    cleanup: () => removeOwnedDirectory(owned),
  };
}

/** Creates the isolated working tree used for npm configuration and extraction. */
export async function createScratchArea(sourceRoot) {
  const tmpRoot = await realpath(tmpdir());
  const roots = await collectRepositoryRoots(sourceRoot);
  for (const root of roots) {
    if (isInside(root, tmpRoot)) {
      fail('the temp root is inside a source worktree or git metadata directory');
    }
  }
  await assertTrustedDirectoryChain(tmpRoot);
  const scratch = await mkdtemp(join(tmpRoot, 'pto-agent-pack-'));
  const real = await realpath(scratch);
  if (!isInside(tmpRoot, real) || real === tmpRoot)
    fail('the scratch directory escaped the temp root');
  const info = await lstat(real);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail('the scratch directory was not created as a real directory');
  }
  const owned = await captureOwnedDirectory(real, tmpRoot);
  await chmod(real, 0o700);
  await assertNoNpmrc([real], 'scratch root');
  const home = join(real, 'home');
  const temp = join(real, 'tmp');
  const cache = join(real, 'npm-cache');
  const prefix = join(real, 'prefix');
  for (const directory of [home, temp, cache, prefix, join(home, 'config'), join(home, 'data')]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const userconfig = join(home, 'user.npmrc');
  const globalconfig = join(home, 'global.npmrc');
  for (const file of [userconfig, globalconfig, join(home, '.npmrc')]) {
    await writeFile(file, '', { flag: 'wx', mode: 0o600 });
  }
  const cleanup = async () => removeOwnedDirectory(owned);
  return { root: real, home, temp, cache, prefix, userconfig, globalconfig, cleanup };
}

/** A closed environment for npm, tar, and installed-tool probes. */
export function toolEnvironment(scratch) {
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: scratch.home,
    XDG_CONFIG_HOME: join(scratch.home, 'config'),
    XDG_DATA_HOME: join(scratch.home, 'data'),
    XDG_CACHE_HOME: join(scratch.temp, 'cache'),
    TMPDIR: scratch.temp,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    NO_COLOR: '1',
    npm_config_userconfig: scratch.userconfig,
    npm_config_globalconfig: scratch.globalconfig,
    npm_config_cache: scratch.cache,
    npm_config_prefix: scratch.prefix,
    npm_config_offline: 'true',
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_loglevel: 'error',
  };
}

function modeFromText(text) {
  let mode = 0;
  const bits = [
    [0o400, 0o200, 0o100],
    [0o040, 0o020, 0o010],
    [0o004, 0o002, 0o001],
  ];
  for (let index = 0; index < 3; index += 1) {
    const offset = index * 3;
    if (text[offset] === 'r') mode |= bits[index][0];
    if (text[offset + 1] === 'w') mode |= bits[index][1];
    if (text[offset + 2] === 'x') mode |= bits[index][2];
  }
  return mode;
}

function parseVerboseMember(line) {
  const match = /^([-dlhcbps])[rwxStTs-]{9}\s+\S+\s+(\d+)\s+/.exec(line);
  if (match === null) fail('an archive verbose listing is not the expected GNU tar shape');
  const options = line.slice(1, 10);
  if (/[sStT]/.test(options)) fail('an archive member carries a special mode');
  const size = Number(match[2]);
  if (!Number.isSafeInteger(size) || size < 0) fail('an archive member has an invalid size');
  return { type: match[1], mode: modeFromText(options), size };
}

export function runCommand(file, args, { cwd, env, label, timeout = CHILD_TIMEOUT_MS }) {
  const result = spawnSync(file, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    fail(`${label} could not run: ${result.error.code ?? 'unknown error'}`);
  }
  if (result.signal !== null) fail(`${label} was stopped by ${result.signal}`);
  if (result.status !== 0) fail(`${label} failed with status ${result.status}`);
  return result;
}

/** Resolves the npm CLI that belongs to the running Node toolchain. */
export async function resolveNpmCli() {
  const bin = dirname(process.execPath);
  const candidates = [
    join(bin, 'npm'),
    join(bin, 'npm-cli.js'),
    join(dirname(bin), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    const info = await statOrNull(candidate);
    if (info === null || !info.isFile()) continue;
    const real = await realpath(candidate);
    if (basename(real) === 'npm-cli.js' || real.endsWith('/npm/bin/npm-cli.js')) return real;
  }
  fail('the npm CLI belonging to the running Node toolchain is unavailable');
}

/** Requires the GNU tar already installed for the local build environment. */
export async function resolveTar() {
  for (const candidate of ['/usr/bin/tar', '/bin/tar']) {
    const info = await statOrNull(candidate);
    if (info === null || !info.isFile()) continue;
    const result = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' },
    });
    if (result.status === 0 && String(result.stdout).includes('GNU tar')) return candidate;
  }
  fail('GNU tar is unavailable; the approved archive tool is missing');
}

/** Recursively lists regular files and directories without following links. */
export async function walkTree(root) {
  const files = [];
  const directories = [];
  const recurse = async (directory, relative, depth) => {
    if (depth > 12) fail('a source tree is nested too deeply');
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) fail(`a source tree holds a hidden entry: ${entry.name}`);
      const absolute = join(directory, entry.name);
      const next = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) fail(`a source tree holds a symlink: ${next}`);
      if (entry.isDirectory()) {
        directories.push(next);
        await recurse(absolute, next, depth + 1);
      } else if (entry.isFile()) {
        files.push(next);
      } else {
        fail(`a source tree holds a non-regular entry: ${next}`);
      }
    }
  };
  await recurse(root, '', 0);
  return { files, directories };
}

/** Requires a real directory whose canonical path stays inside root. */
export async function assertRealDirectory(target, root, label) {
  const info = await lstat(target).catch(() => null);
  if (info === null || !info.isDirectory() || info.isSymbolicLink()) {
    fail(`${label} is not a real directory`);
  }
  const real = await realpath(target);
  const rootReal = await realpath(root);
  if (!isInside(rootReal, real)) fail(`${label} escapes the source workspace`);
  return real;
}

/** Requires a regular source file reached without any symlink component. */
export async function assertSourceFile(target, root, label) {
  const rootReal = await realpath(root);
  const info = await lstat(target).catch(() => null);
  if (info === null || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    fail(`${label} is not a single regular file`);
  }
  let cursor = dirname(target);
  while (cursor !== rootReal) {
    const parent = await lstat(cursor).catch(() => null);
    if (parent === null || !parent.isDirectory() || parent.isSymbolicLink()) {
      fail(`${label} passes through a link or missing directory`);
    }
    if (!isInside(rootReal, cursor)) fail(`${label} escapes the source workspace`);
    const next = dirname(cursor);
    if (next === cursor) fail(`${label} is outside the source workspace`);
    cursor = next;
  }
  const real = await realpath(target);
  if (real !== resolve(target)) fail(`${label} is a linked path, not a source file`);
  if (!isInside(rootReal, real)) fail(`${label} escapes the source workspace`);
  return real;
}

/** Reads and hashes one allowed source member. */
export async function readSourceArtifact(target, root, relative) {
  assertAllowedArtifactPath(relative);
  await assertSourceFile(target, root, `source member ${relative}`);
  const info = await lstat(target);
  if (info.mode & 0o7000) fail(`source member has a special mode: ${relative}`);
  if (info.mode & 0o022) fail(`source member is group- or world-writable: ${relative}`);
  const buffer = await readFile(target);
  if (buffer.length === 0) fail(`source member is empty: ${relative}`);
  if (buffer.length > MAX_FILE_BYTES) fail(`source member is too large: ${relative}`);
  scanArtifactContent(`source member ${relative}`, buffer);
  return {
    relative,
    sourcePath: target,
    size: buffer.length,
    sha256: sha256Buffer(buffer),
    mode: info.mode & 0o777,
    buffer,
  };
}

function memberModeName(mode) {
  return (mode & 0o777).toString(8).padStart(4, '0');
}

function allowedDirectoriesFor(expected) {
  const allowed = new Set();
  for (const relative of expected.keys()) {
    let cursor = relative;
    for (;;) {
      const parent = cursor.includes('/') ? cursor.slice(0, cursor.lastIndexOf('/')) : '';
      if (parent === '') break;
      allowed.add(parent);
      cursor = parent;
    }
  }
  return allowed;
}

function validateTarMember(raw, expected) {
  if (raw.length === 0 || raw.length > MAX_PATH_LENGTH + 'package/'.length) {
    fail('an archive member has an invalid path length');
  }
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) fail('an archive member path has escaped characters');
  if (raw.startsWith('/') || raw.startsWith('./'))
    fail('an archive member path is absolute or dot-relative');
  if (!raw.startsWith('package/')) fail('an archive member is outside the package root');
  const relative = raw.slice('package/'.length);
  if (relative === '' || relative.endsWith('/')) fail('an archive member is a bare directory');
  assertAllowedArtifactPath(relative);
  if (!expected.has(relative)) fail(`an archive holds a member outside the allowlist: ${relative}`);
  return relative;
}

async function walkExtraction(packageRoot) {
  const found = [];
  const recurse = async (directory, relative, depth) => {
    if (depth > 12) fail('an archive extraction is nested too deeply');
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const next = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) fail(`an archive extraction holds a symlink: ${next}`);
      if (info.isDirectory()) {
        found.push({ relative: next, absolute, info, kind: 'directory' });
        await recurse(absolute, next, depth + 1);
      } else if (info.isFile()) {
        found.push({ relative: next, absolute, info, kind: 'file' });
      } else {
        fail(`an archive extraction holds a non-regular entry: ${next}`);
      }
    }
  };
  await recurse(packageRoot, '', 0);
  return found;
}

/**
 * Verifies one actual npm tarball: filename list, member allowlist, type,
 * mode, size, digest, and content. Returns the extracted package manifest.
 */
export async function verifyArchive({ archivePath, expected, tarPath, env, scratch, label }) {
  const archiveInfo = await lstat(archivePath).catch(() => null);
  if (archiveInfo === null || !archiveInfo.isFile() || archiveInfo.isSymbolicLink()) {
    fail(`${label} tarball is not a regular file`);
  }
  if (archiveInfo.nlink !== 1) fail(`${label} tarball is hard-linked`);
  if (archiveInfo.size === 0 || archiveInfo.size > MAX_ARCHIVE_BYTES) {
    fail(`${label} tarball size is outside the allowlist`);
  }
  const buffer = await readFile(archivePath);
  if (buffer.length !== archiveInfo.size) fail(`${label} tarball changed while being read`);

  const listed = runCommand(tarPath, ['--quoting-style=literal', '-tzf', archivePath], {
    cwd: scratch,
    env,
    label: `${label} tar listing`,
  });
  if (String(listed.stderr).trim() !== '') fail(`${label} tarball listing emitted a warning`);
  const rawMembers = String(listed.stdout).split('\n');
  if (rawMembers.length > 0 && rawMembers[rawMembers.length - 1] === '') rawMembers.pop();
  if (rawMembers.length > MAX_MEMBERS) fail(`${label} tarball exceeds the member allowlist`);
  if (rawMembers.length === 0 || rawMembers.length !== expected.size) {
    fail(`${label} tarball does not hold exactly its expected members`);
  }
  const verbose = runCommand(
    tarPath,
    ['--quoting-style=literal', '--numeric-owner', '-tvzf', archivePath],
    {
      cwd: scratch,
      env,
      label: `${label} tar verbose listing`,
    },
  );
  if (String(verbose.stderr).trim() !== '') fail(`${label} tarball listing emitted a warning`);
  const verboseMembers = String(verbose.stdout).split('\n');
  if (verboseMembers.length > 0 && verboseMembers[verboseMembers.length - 1] === '') {
    verboseMembers.pop();
  }
  if (verboseMembers.length !== rawMembers.length) {
    fail(`${label} tarball verbose listing does not match its member list`);
  }
  const seen = new Set();
  let precheckSize = 0;
  for (let index = 0; index < rawMembers.length; index += 1) {
    const relative = validateTarMember(rawMembers[index], expected);
    if (seen.has(relative)) fail(`${label} tarball repeats a member: ${relative}`);
    seen.add(relative);
    const wanted = expected.get(relative);
    const metadata = parseVerboseMember(verboseMembers[index]);
    if (metadata.type !== '-') {
      fail(`${label} tarball holds a non-regular member before extraction: ${relative}`);
    }
    if (metadata.mode !== wanted.mode) {
      fail(
        `${label} tarball member mode ${memberModeName(metadata.mode)} does not match ${memberModeName(wanted.mode)} before extraction: ${relative}`,
      );
    }
    if (metadata.size !== wanted.size) {
      fail(`${label} tarball member size does not match its source before extraction: ${relative}`);
    }
    if (metadata.size > MAX_FILE_BYTES) fail(`${label} tarball member exceeds the size allowlist`);
    precheckSize += metadata.size;
    if (precheckSize > MAX_UNPACKED_BYTES) {
      fail(`${label} tarball expands beyond the size allowlist before extraction`);
    }
  }

  const destination = join(scratch, `extract-${label}`);
  await mkdir(destination, { recursive: false, mode: 0o700 });
  runCommand(
    tarPath,
    ['-xzf', archivePath, '-C', destination, '--no-same-owner', '--preserve-permissions'],
    {
      cwd: scratch,
      env,
      label: `${label} tar extraction`,
    },
  );
  const packageRoot = join(destination, 'package');
  await assertRealDirectory(packageRoot, destination, `${label} extracted package root`);
  const allowedDirectories = allowedDirectoriesFor(expected);
  let unpackedSize = 0;
  const extracted = await walkExtraction(packageRoot);
  for (const entry of extracted) {
    if (entry.kind === 'directory') {
      if (!allowedDirectories.has(entry.relative)) {
        fail(`${label} tarball holds an unexpected directory: ${entry.relative}`);
      }
      continue;
    }
    assertAllowedArtifactPath(entry.relative);
    const wanted = expected.get(entry.relative);
    if (wanted === undefined) {
      fail(`${label} tarball holds an unexpected member: ${entry.relative}`);
    }
    if (entry.info.nlink !== 1) fail(`${label} tarball holds a hard link: ${entry.relative}`);
    if (entry.info.mode & 0o7000) fail(`${label} tarball holds a special mode: ${entry.relative}`);
    if ((entry.info.mode & 0o777) !== wanted.mode) {
      fail(
        `${label} tarball member mode ${memberModeName(entry.info.mode)} does not match ${memberModeName(wanted.mode)}: ${entry.relative}`,
      );
    }
    if (entry.info.size !== wanted.size) {
      fail(`${label} tarball member size does not match its source: ${entry.relative}`);
    }
    const member = await readFile(entry.absolute);
    if (member.length !== wanted.size) fail(`${label} tarball member changed while reading`);
    if (sha256Buffer(member) !== wanted.sha256) {
      fail(`${label} tarball member content does not match its source: ${entry.relative}`);
    }
    scanArtifactContent(`${label} tarball member ${entry.relative}`, member);
    unpackedSize += member.length;
    if (unpackedSize > MAX_UNPACKED_BYTES)
      fail(`${label} tarball expands beyond the size allowlist`);
  }
  for (const relative of expected.keys()) {
    if (!seen.has(relative)) fail(`${label} tarball is missing an expected member: ${relative}`);
  }

  const manifestPath = join(packageRoot, 'package.json');
  const manifestBuffer = await readFile(manifestPath);
  return {
    packageRoot,
    manifest: JSON.parse(manifestBuffer.toString('utf8')),
    manifestSha256: sha256Buffer(manifestBuffer),
    archive: {
      size: buffer.length,
      sha256: sha256Buffer(buffer),
      integrity: sha512Integrity(buffer),
      shasum: sha1Hex(buffer),
      unpackedSize,
      memberCount: rawMembers.length,
    },
  };
}

/** Writes a bundle file only if it does not already exist. */
export async function writeExclusive(path, data, mode = 0o644) {
  await writeFile(path, data, { flag: 'wx', mode });
  await chmod(path, mode);
}

/** Requires the bundle root to contain exactly the expected regular files. */
export async function assertExactFiles(directory, expectedNames) {
  const entries = await readdir(directory, { withFileTypes: true });
  const actual = entries.map((entry) => entry.name).sort();
  const wanted = [...expectedNames].sort();
  if (actual.length !== wanted.length || actual.some((name, index) => name !== wanted[index])) {
    fail('the bundle root does not hold exactly the expected files');
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      fail(`the bundle root holds a non-regular entry: ${entry.name}`);
    }
    const info = await lstat(join(directory, entry.name));
    if (info.nlink !== 1 || info.size === 0) {
      fail(`the bundle root file is not a single non-empty file: ${entry.name}`);
    }
  }
}

/** Parses the standard two-space sha256sum format. */
export function parseChecksums(text) {
  const entries = new Map();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const match = /^([0-9a-f]{64})  ([^/\s][^\s]*)$/.exec(line);
    if (match === null) fail('SHA256SUMS is not a relative two-space checksum list');
    if (entries.has(match[2])) fail('SHA256SUMS repeats a file name');
    entries.set(match[2], match[1]);
  }
  if (entries.size === 0) fail('SHA256SUMS is empty');
  return entries;
}

/** Recomputes every checksum entry against the actual bundle bytes. */
export async function verifyChecksums(directory, expectedNames) {
  const text = await readFile(join(directory, 'SHA256SUMS'), 'utf8');
  const entries = parseChecksums(text);
  if (entries.size !== expectedNames.size)
    fail('SHA256SUMS does not cover exactly the bundle files');
  for (const name of expectedNames) {
    if (!entries.has(name)) fail(`SHA256SUMS is missing a bundle file: ${name}`);
    const buffer = await readFile(join(directory, name));
    if (sha256Buffer(buffer) !== entries.get(name)) {
      fail(`a bundle file does not match SHA256SUMS: ${name}`);
    }
  }
  return entries;
}
