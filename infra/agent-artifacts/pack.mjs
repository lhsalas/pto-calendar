#!/usr/bin/env node
// Core pack entry for the private CLI/MCP agent bundles (#265).
//
// `node infra/agent-artifacts/pack.mjs --output <new-external-directory>`
// produces four actual `npm pack` tarballs at the bundle root, a generated
// consumer `package.json` and v3 `package-lock.json` using relative
// `file:<tarball>` references, and a six-entry `SHA256SUMS`. The output
// directory must be new, private, outside every source worktree, and is
// never overwritten.
//
// The four packages stay private and UNLICENSED. No repository manifest,
// lockfile, dependency, publish setting, or source file is written. Packing
// runs `npm pack` with lifecycle scripts disabled and no ambient user
// configuration or credentials. The consumer lock is copied from the
// reviewed root lock's reachable runtime/peer/optional closure, preserving
// placement and duplicate versions; it is never re-resolved from a registry.

import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_ARCHIVE_BYTES,
  PackError,
  assertAllowedArtifactPath,
  assertExactFiles,
  assertNoNpmrc,
  assertRealDirectory,
  createScratchArea,
  fail,
  isInside,
  isObject,
  lstatOrNull,
  parseChecksums,
  prepareOutputDirectory,
  readJsonFile,
  readSourceArtifact,
  resolveNpmCli,
  resolveTar,
  runCommand,
  sha256Buffer,
  toolEnvironment,
  verifyArchive,
  verifyChecksums,
  walkTree,
  writeExclusive,
} from './bundle-safety.mjs';
import {
  REVIEWED_ARTIFACT_VERSION,
  assertCompiledInventory,
  assertSourceInventory,
  reviewedCompiledMembers,
  reviewedSourceMembers,
} from './inventory.mjs';
import { buildConsumerLock } from './lock-graph.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const PACKAGES = [
  {
    dir: 'cli',
    name: '@pto-calendar/cli',
    binRel: 'bin/pto.mjs',
    binName: 'pto',
    helperRel: null,
    declarations: false,
    files: ['bin', 'dist', 'README.md'],
    main: undefined,
    exports: undefined,
    dependencies: {
      '@pto-calendar/agent-auth': '0.1.0',
      '@pto-calendar/api-client': '0.1.0',
    },
  },
  {
    dir: 'mcp',
    name: '@pto-calendar/mcp',
    binRel: 'bin/pto-mcp.mjs',
    binName: 'pto-mcp',
    helperRel: null,
    declarations: false,
    files: ['bin', 'dist', 'README.md'],
    main: undefined,
    exports: undefined,
    dependencies: {
      '@modelcontextprotocol/sdk': '1.32.2',
      '@pto-calendar/agent-auth': '0.1.0',
      '@pto-calendar/api-client': '0.1.0',
    },
  },
  {
    dir: 'packages/api-client',
    name: '@pto-calendar/api-client',
    binRel: null,
    binName: null,
    helperRel: null,
    declarations: true,
    files: ['dist', 'README.md'],
    main: './dist/index.js',
    exports: {
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
        default: './dist/index.js',
      },
      './package.json': './package.json',
    },
    dependencies: {},
  },
  {
    dir: 'packages/agent-auth',
    name: '@pto-calendar/agent-auth',
    binRel: null,
    binName: null,
    helperRel: 'libexec/secret-service.py',
    declarations: true,
    files: ['dist', 'libexec/secret-service.py', 'README.md'],
    main: './dist/index.js',
    exports: {
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
        default: './dist/index.js',
      },
    },
    dependencies: {},
  },
];

const LIFECYCLE_SCRIPTS = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'prepublishOnly',
  'prepare',
  'prepack',
  'postpack',
]);

function usage() {
  return 'usage: node infra/agent-artifacts/pack.mjs --output <new-external-private-directory>';
}

function parseArguments(argv) {
  let output = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true, output: null };
    if (argument === '--output') {
      if (output !== null) fail('--output may be supplied only once');
      const value = argv[index + 1];
      if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
        fail(`--output requires a directory path\n${usage()}`);
      }
      output = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('--output=')) {
      if (output !== null) fail('--output may be supplied only once');
      output = argument.slice('--output='.length);
      if (output === '') fail(`--output requires a directory path\n${usage()}`);
      continue;
    }
    fail(`unknown argument: ${argument}\n${usage()}`);
  }
  if (output === null) fail(`--output is required\n${usage()}`);
  return { help: false, output };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonical(value[key]);
    return result;
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function parseVersion(value, label) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value).trim());
  if (match === null) fail(`${label} is not a pinned semantic version`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left, right) {
  const a = parseVersion(left, 'version');
  const b = parseVersion(right, 'version');
  for (let index = 0; index < 3; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

function assertFloor(actual, floorSpec, label) {
  const match = /^>=(\d+\.\d+\.\d+)$/.exec(String(floorSpec));
  if (match === null) fail(`the ${label} engine floor is not a supported lower bound`);
  if (compareVersions(actual, match[1]) < 0) {
    fail(`${label} ${actual} is below the reviewed floor ${floorSpec}`);
  }
}

function tarballName(name, version) {
  return `${name.replace(/^@/, '').replace(/\//g, '-')}-${version}.tgz`;
}

function validateManifest(manifest, policy, rootEngines) {
  if (!isObject(manifest)) fail(`workspace manifest is unreadable: ${policy.dir}`);
  if (manifest.name !== policy.name) fail(`workspace name changed: ${policy.dir}`);
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    fail(`workspace version is not pinned: ${policy.name}`);
  }
  if (manifest.private !== true) fail(`workspace must stay private: ${policy.name}`);
  if (manifest.license !== 'UNLICENSED') fail(`workspace license changed: ${policy.name}`);
  if (manifest.type !== 'module') fail(`workspace is not ESM: ${policy.name}`);
  if (typeof manifest.description !== 'string' || manifest.description.trim() === '') {
    fail(`workspace description is missing: ${policy.name}`);
  }
  if (!isObject(manifest.engines)) fail(`workspace engines floor is missing: ${policy.name}`);
  if (
    manifest.engines.node !== rootEngines.node ||
    manifest.engines.npm !== rootEngines.npm ||
    Object.keys(manifest.engines).length !== 2
  ) {
    fail(`workspace engines floor differs from the root floor: ${policy.name}`);
  }
  if (!sameJson(manifest.files, policy.files)) {
    fail(`workspace files allowlist changed: ${policy.name}`);
  }
  if (policy.binRel === null) {
    if (manifest.bin !== undefined) fail(`unexpected bin entry: ${policy.name}`);
  } else if (!sameJson(manifest.bin, { [policy.binName]: `./${policy.binRel}` })) {
    fail(`workspace bin entry changed: ${policy.name}`);
  }
  if (policy.main === undefined) {
    if (manifest.main !== undefined) fail(`unexpected main entry: ${policy.name}`);
  } else if (manifest.main !== policy.main) {
    fail(`workspace main entry changed: ${policy.name}`);
  }
  if (policy.exports === undefined) {
    if (manifest.exports !== undefined) fail(`unexpected exports map: ${policy.name}`);
  } else if (!sameJson(manifest.exports, policy.exports)) {
    fail(`workspace exports map changed: ${policy.name}`);
  }
  const dependencies = manifest.dependencies ?? {};
  if (!sameJson(dependencies, policy.dependencies)) {
    fail(`workspace dependencies differ from the reviewed pins: ${policy.name}`);
  }
  for (const field of [
    'optionalDependencies',
    'peerDependencies',
    'bundledDependencies',
    'bundleDependencies',
    'workspaces',
  ]) {
    const value = manifest[field];
    if (value !== undefined && (!isObject(value) || Object.keys(value).length > 0)) {
      fail(`workspace carries an unsupported ${field} entry: ${policy.name}`);
    }
  }
  if (manifest.publishConfig !== undefined) {
    fail(`workspace carries publish configuration; no distribution channel is approved`);
  }
  for (const script of Object.keys(manifest.scripts ?? {})) {
    if (LIFECYCLE_SCRIPTS.has(script)) {
      fail(`workspace carries a lifecycle script; packing must not execute it: ${policy.name}`);
    }
  }
}

async function addExpected(expected, packageRoot, relative, { executable = false } = {}) {
  const artifact = await readSourceArtifact(join(packageRoot, relative), packageRoot, relative);
  if (executable && (artifact.mode & 0o111) === 0) {
    fail(`entry point is not executable: ${relative}`);
  }
  if (!executable && (artifact.mode & 0o111) !== 0) {
    fail(`non-entry artifact is executable: ${relative}`);
  }
  // Source permissions are checkout policy, not archive content. Verify the
  // original is a safe regular member above, then stage a canonical archive
  // mode so two checkouts with different safe source modes produce identical
  // bytes and checksums. The source file is never chmodded.
  expected.set(relative, { ...artifact, mode: executable ? 0o755 : 0o644 });
  return expected.get(relative);
}

async function collectExpectedMembers(policy, packageRoot) {
  await assertNoNpmrc([packageRoot], `workspace ${policy.name}`);
  const expected = new Map();
  await addExpected(expected, packageRoot, 'package.json');
  await addExpected(expected, packageRoot, 'README.md');

  if (policy.binRel !== null) {
    const bin = await addExpected(expected, packageRoot, policy.binRel, { executable: true });
    const firstLine = (await readFile(bin.sourcePath, 'utf8')).split('\n')[0];
    if (firstLine !== '#!/usr/bin/env node') {
      fail(`entry point lost its Node launcher line: ${policy.name}`);
    }
    const binDirectory = join(packageRoot, 'bin');
    const binTree = await walkTree(binDirectory);
    const wanted = policy.binRel.slice('bin/'.length);
    if (binTree.files.length !== 1 || binTree.files[0] !== wanted) {
      fail(`bin directory does not hold exactly its declared entry point: ${policy.name}`);
    }
  } else if ((await lstatOrNull(join(packageRoot, 'bin'))) !== null) {
    fail(`unexpected bin directory: ${policy.name}`);
  }

  if (policy.helperRel !== null) {
    const helper = await addExpected(expected, packageRoot, policy.helperRel);
    const firstLine = (await readFile(helper.sourcePath, 'utf8')).split('\n')[0];
    if (firstLine !== '#!/usr/bin/python3') {
      fail(`Secret Service helper lost its pinned interpreter: ${policy.name}`);
    }
    const helperTree = await walkTree(join(packageRoot, 'libexec'));
    if (helperTree.files.length !== 1 || helperTree.files[0] !== 'secret-service.py') {
      fail(`libexec does not hold exactly the pinned Secret Service helper: ${policy.name}`);
    }
  } else if ((await lstatOrNull(join(packageRoot, 'libexec'))) !== null) {
    fail(`unexpected libexec directory: ${policy.name}`);
  }

  const srcRoot = await assertRealDirectory(
    join(packageRoot, 'src'),
    packageRoot,
    `${policy.name} source directory`,
  );
  const srcTree = await walkTree(srcRoot);
  const sourceFiles = reviewedSourceMembers(policy.dir);
  assertSourceInventory(policy.dir, srcTree.files);
  for (const directory of srcTree.directories) {
    if (!sourceFiles.some((file) => file.startsWith(`${directory}/`))) {
      fail(`source holds an unexpected directory: ${policy.name}/${directory}`);
    }
  }

  const distExpected = reviewedCompiledMembers(policy.dir, policy.declarations);
  for (const relative of distExpected) {
    await addExpected(expected, packageRoot, relative);
  }

  const distRoot = await assertRealDirectory(
    join(packageRoot, 'dist'),
    packageRoot,
    `${policy.name} compiled directory`,
  );
  const distTree = await walkTree(distRoot);
  const actualDist = distTree.files.map((file) => `dist/${file}`).sort();
  assertCompiledInventory(policy.dir, actualDist, policy.declarations);
  for (const directory of distTree.directories) {
    if (!distExpected.some((file) => file.startsWith(`dist/${directory}/`))) {
      fail(`compiled output holds an unexpected directory: ${policy.name}/${directory}`);
    }
  }

  let latestSource = 0;
  for (const file of sourceFiles) {
    const info = await lstatOrNull(join(srcRoot, file));
    if (info === null) fail(`source file disappeared: ${policy.name}/${file}`);
    latestSource = Math.max(latestSource, info.mtimeMs);
  }
  for (const file of distExpected) {
    const relative = file.slice('dist/'.length);
    const info = await lstatOrNull(join(distRoot, relative));
    if (info === null) fail(`compiled output is missing: ${policy.name}/${file}`);
    if (info.mtimeMs < latestSource) {
      fail(`compiled output is stale; run the workspace build first: ${policy.name}/${file}`);
    }
  }

  return expected;
}

function expectedTarball(policy, artifactVersion) {
  return tarballName(policy.name, artifactVersion);
}

/**
 * Copies only the vetted members into an isolated staging package and runs
 * npm there. Archive modes are canonicalized to 0644/0755 after the original
 * path/type/link/special/write/executable checks; source permissions are not
 * changed. No checkout, workspace or user npmrc is in the cwd or any
 * ancestor, and npm never sees an unvetted source file.
 */
export async function stagePackageInputs({ policy, expected, scratch }) {
  const stagingParent = join(scratch.root, 'staging');
  await mkdir(stagingParent, { recursive: true, mode: 0o700 });
  const staging = join(stagingParent, policy.dir.replace(/[^a-z0-9]+/gi, '-'));
  await mkdir(staging, { recursive: false, mode: 0o700 });
  for (const [relative, artifact] of expected) {
    assertAllowedArtifactPath(relative);
    const destination = join(staging, relative);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, artifact.buffer, { flag: 'wx', mode: artifact.mode });
    await chmod(destination, artifact.mode);
  }
  await assertNoNpmrc([staging, stagingParent, scratch.root], 'npm staging');
  const tree = await walkTree(staging);
  const actual = tree.files.sort();
  const wanted = [...expected.keys()].sort();
  if (actual.length !== wanted.length || actual.some((file, index) => file !== wanted[index])) {
    fail(`npm staging does not hold exactly the vetted members: ${policy.name}`);
  }
  for (const directory of tree.directories) {
    if (!wanted.some((file) => file.startsWith(`${directory}/`))) {
      fail(`npm staging holds an unexpected directory: ${policy.name}/${directory}`);
    }
  }
  return staging;
}

function validatePackReport(report, expected, policy, artifactVersion) {
  if (!isObject(report)) fail(`npm pack did not report a package: ${policy.name}`);
  if (report.name !== policy.name) fail(`npm pack reported the wrong package name: ${policy.name}`);
  if (report.version !== artifactVersion) {
    fail(`npm pack reported the wrong package version: ${policy.name}`);
  }
  const wantedName = expectedTarball(policy, artifactVersion);
  if (report.filename !== wantedName) {
    fail(`npm pack reported an unexpected tarball name: ${policy.name}`);
  }
  if (typeof report.size !== 'number' || report.size <= 0 || report.size > MAX_ARCHIVE_BYTES) {
    fail(`npm pack reported an archive size outside the allowlist: ${policy.name}`);
  }
  if (report.unpackedSize !== [...expected.values()].reduce((sum, item) => sum + item.size, 0)) {
    fail(`npm pack reported an unexpected unpacked size: ${policy.name}`);
  }
  if (report.entryCount !== expected.size) {
    fail(`npm pack reported an unexpected member count: ${policy.name}`);
  }
  if (
    typeof report.integrity !== 'string' ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(report.integrity)
  ) {
    fail(`npm pack did not report a sha512 tarball integrity: ${policy.name}`);
  }
  if (Buffer.from(report.integrity.slice('sha512-'.length), 'base64').length !== 64) {
    fail(`npm pack reported an incomplete sha512 tarball integrity: ${policy.name}`);
  }
  if (typeof report.shasum !== 'string' || !/^[0-9a-f]{40}$/.test(report.shasum)) {
    fail(`npm pack did not report a SHA-1 tarball checksum: ${policy.name}`);
  }
  if (!Array.isArray(report.files) || report.files.length !== expected.size) {
    fail(`npm pack reported an unexpected file list: ${policy.name}`);
  }
  if (Array.isArray(report.bundled) && report.bundled.length > 0) {
    fail(`npm pack reported bundled dependencies: ${policy.name}`);
  }
  const actual = new Map();
  let unpacked = 0;
  for (const file of report.files) {
    if (!isObject(file) || typeof file.path !== 'string') {
      fail(`npm pack reported an invalid file entry: ${policy.name}`);
    }
    assertAllowedArtifactPath(file.path);
    if (actual.has(file.path)) fail(`npm pack repeated a file entry: ${policy.name}`);
    const wanted = expected.get(file.path);
    if (wanted === undefined) {
      fail(`npm pack included a file outside the allowlist: ${policy.name}/${file.path}`);
    }
    if (file.size !== wanted.size) {
      fail(`npm pack file size differs from source: ${policy.name}/${file.path}`);
    }
    if (typeof file.mode !== 'number' || (file.mode & 0o777) !== wanted.mode) {
      fail(`npm pack file mode differs from source: ${policy.name}/${file.path}`);
    }
    actual.set(file.path, file);
    unpacked += file.size;
  }
  if (unpacked !== report.unpackedSize) {
    fail(`npm pack file sizes do not add up to its unpacked size: ${policy.name}`);
  }
  for (const relative of expected.keys()) {
    if (!actual.has(relative)) {
      fail(`npm pack omitted an allowlisted file: ${policy.name}/${relative}`);
    }
  }
  return wantedName;
}

function parsePackReport(result, policy) {
  let report;
  try {
    report = JSON.parse(String(result.stdout).trim());
  } catch {
    fail(`npm pack did not emit parseable JSON: ${policy.name}`);
  }
  if (!Array.isArray(report) || report.length !== 1 || !isObject(report[0])) {
    fail(`npm pack did not report exactly one package: ${policy.name}`);
  }
  return report[0];
}

function runNpm(npmCli, argumentsList, { cwd, env, label }) {
  return runCommand(process.execPath, [npmCli, ...argumentsList], { cwd, env, label });
}

function packArguments(output, { dryRun }) {
  const args = [
    'pack',
    '--json',
    '--ignore-scripts',
    '--offline',
    '--no-audit',
    '--no-fund',
    '--no-update-notifier',
    '--pack-destination',
    output,
  ];
  if (dryRun) args.splice(1, 0, '--dry-run');
  return args;
}

async function packOne({
  policy,
  staging,
  expected,
  output,
  artifactVersion,
  npmCli,
  tarPath,
  env,
  scratch,
  packedNames,
}) {
  const tarball = expectedTarball(policy, artifactVersion);
  const dryResult = runNpm(npmCli, packArguments(output, { dryRun: true }), {
    cwd: staging,
    env,
    label: `${policy.name} npm pack dry run`,
  });
  const dryReport = parsePackReport(dryResult, policy);
  validatePackReport(dryReport, expected, policy, artifactVersion);
  const afterDry = await lstatOrNull(join(output, tarball));
  if (afterDry !== null) fail(`npm pack dry run wrote a tarball: ${policy.name}`);
  for (const entry of await readdir(output, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.tgz') || !packedNames.has(entry.name)) {
      fail(`npm pack left an unexpected file in the bundle root: ${entry.name}`);
    }
  }
  if (packedNames.has(tarball)) fail(`a tarball name would be overwritten: ${tarball}`);

  const result = runNpm(npmCli, packArguments(output, { dryRun: false }), {
    cwd: staging,
    env,
    label: `${policy.name} npm pack`,
  });
  const report = parsePackReport(result, policy);
  validatePackReport(report, expected, policy, artifactVersion);
  if (
    report.filename !== dryReport.filename ||
    report.integrity !== dryReport.integrity ||
    report.shasum !== dryReport.shasum ||
    report.size !== dryReport.size ||
    report.unpackedSize !== dryReport.unpackedSize ||
    report.entryCount !== dryReport.entryCount ||
    !sameJson(report.files, dryReport.files)
  ) {
    fail(`npm pack actual archive differs from its dry run: ${policy.name}`);
  }

  const archivePath = join(output, tarball);
  const archiveInfo = await lstatOrNull(archivePath);
  if (archiveInfo === null || !archiveInfo.isFile() || archiveInfo.isSymbolicLink()) {
    fail(`npm pack did not produce a regular tarball: ${policy.name}`);
  }
  if (archiveInfo.nlink !== 1) fail(`npm pack produced a hard-linked tarball: ${policy.name}`);
  if (archiveInfo.size !== report.size) fail(`npm pack tarball size changed: ${policy.name}`);

  const verified = await verifyArchive({
    archivePath,
    expected,
    tarPath,
    env,
    scratch: scratch.root,
    label: policy.dir.replace(/[^a-z0-9]+/gi, '-'),
  });
  if (verified.archive.integrity !== report.integrity) {
    fail(`npm pack reported an integrity that does not match the tarball: ${policy.name}`);
  }
  if (verified.archive.shasum !== report.shasum) {
    fail(`npm pack reported a checksum that does not match the tarball: ${policy.name}`);
  }
  if (
    verified.archive.size !== report.size ||
    verified.archive.unpackedSize !== report.unpackedSize
  ) {
    fail(`npm pack report sizes do not match the tarball: ${policy.name}`);
  }
  if (verified.manifestSha256 !== expected.get('package.json').sha256) {
    fail(`the packed manifest differs from the reviewed workspace manifest: ${policy.name}`);
  }
  if (verified.manifest.private !== true || verified.manifest.license !== 'UNLICENSED') {
    fail(`the packed manifest lost its private UNLICENSED metadata: ${policy.name}`);
  }
  await chmod(archivePath, 0o644);
  packedNames.add(tarball);
  return {
    name: policy.name,
    version: artifactVersion,
    tarball,
    integrity: verified.archive.integrity,
    sha256: verified.archive.sha256,
    manifest: verified.manifest,
  };
}

async function loadPolicies(root, rootManifest, rootEngines) {
  const policies = [];
  let artifactVersion = null;
  for (const policy of PACKAGES) {
    const packageRoot = await assertRealDirectory(
      join(root, policy.dir),
      root,
      `${policy.name} workspace`,
    );
    const manifestPath = join(packageRoot, 'package.json');
    const manifest = await readJsonFile(manifestPath);
    if (artifactVersion === null) {
      artifactVersion = manifest.version;
    } else if (manifest.version !== artifactVersion) {
      fail('the four workspaces do not share one artifact version');
    }
    if (manifest.version !== REVIEWED_ARTIFACT_VERSION) {
      fail(
        `the source inventory is reviewed only for ${REVIEWED_ARTIFACT_VERSION}; ` +
          `update it deliberately for ${manifest.version}`,
      );
    }
    validateManifest(manifest, policy, rootEngines);
    const expected = await collectExpectedMembers(policy, packageRoot);
    policies.push({ ...policy, packageRoot, manifest, expected });
  }
  if (artifactVersion === null) fail('no workspace version was found');
  if (!Array.isArray(rootManifest.workspaces)) fail('the root workspaces list is missing');
  for (const policy of policies) {
    if (!rootManifest.workspaces.includes(policy.dir)) {
      fail(`the root workspaces list does not include ${policy.name}`);
    }
  }
  return { policies, artifactVersion };
}

function npmVersion(npmCli, env, cwd) {
  const result = runCommand(process.execPath, [npmCli, '--version'], {
    cwd,
    env,
    label: 'npm version probe',
  });
  const version = String(result.stdout)
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (version === undefined) fail('npm did not report its version');
  parseVersion(version, 'npm');
  return version;
}

async function assertRuntime(root, rootManifest) {
  const nvmrc = (await readFile(join(root, '.nvmrc'), 'utf8')).trim();
  if (
    typeof rootManifest.engines?.node !== 'string' ||
    typeof rootManifest.engines?.npm !== 'string'
  ) {
    fail('the root engines floor is missing');
  }
  if (rootManifest.engines.node !== `>=${nvmrc}`) {
    fail('the root Node engine floor does not equal the pinned runtime');
  }
  assertFloor(process.versions.node, rootManifest.engines.node, 'Node.js');
  return rootManifest.engines;
}

/** Produces one private bundle and returns its verified metadata. */
export async function packBundle({ output, root = ROOT }) {
  const rootManifest = await readJsonFile(join(root, 'package.json'));
  const rootLock = await readJsonFile(join(root, 'package-lock.json'));
  if (rootManifest.private !== true) fail('the repository manifest is not private');
  await assertNoNpmrc([root], 'repository');
  const rootEngines = await assertRuntime(root, rootManifest);
  const scratch = await createScratchArea(root);
  let prepared = null;
  let success = false;
  try {
    const env = toolEnvironment(scratch);
    const npmCli = await resolveNpmCli();
    const npm = npmVersion(npmCli, env, scratch.root);
    assertFloor(npm, rootEngines.npm, 'npm');
    const tarPath = await resolveTar();
    prepared = await prepareOutputDirectory(output, root);
    const { policies, artifactVersion } = await loadPolicies(root, rootManifest, rootEngines);
    const packedNames = new Set();
    const artifacts = [];
    for (const policy of policies) {
      const staging = await stagePackageInputs({
        policy,
        expected: policy.expected,
        scratch,
      });
      artifacts.push(
        await packOne({
          policy,
          staging,
          expected: policy.expected,
          output: prepared.output,
          artifactVersion,
          npmCli,
          tarPath,
          env,
          scratch,
          packedNames,
        }),
      );
    }
    await assertExactFiles(prepared.output, new Set(packedNames));
    const consumer = buildConsumerLock({
      rootLock,
      artifactVersion,
      rootEngines,
      artifacts,
    });
    await writeExclusive(
      join(prepared.output, 'package.json'),
      `${JSON.stringify(consumer.manifest, null, 2)}\n`,
    );
    await writeExclusive(
      join(prepared.output, 'package-lock.json'),
      `${JSON.stringify(consumer.lock, null, 2)}\n`,
    );
    const sumsNames = [
      ...artifacts.map((artifact) => artifact.tarball),
      'package.json',
      'package-lock.json',
    ];
    const sumEntries = [];
    for (const name of [...sumsNames].sort()) {
      const data = await readFile(join(prepared.output, name));
      sumEntries.push(`${sha256Buffer(data)}  ${name}`);
    }
    await writeExclusive(join(prepared.output, 'SHA256SUMS'), `${sumEntries.join('\n')}\n`);
    const expectedFiles = new Set([...sumsNames, 'SHA256SUMS']);
    await assertExactFiles(prepared.output, expectedFiles);
    const sums = await verifyChecksums(prepared.output, new Set(sumsNames));
    const parsed = parseChecksums(await readFile(join(prepared.output, 'SHA256SUMS'), 'utf8'));
    if (parsed.size !== sums.size) fail('SHA256SUMS verification changed its entry set');
    for (const artifact of artifacts) {
      const target = join(prepared.output, artifact.tarball);
      const targetReal = await realpath(target);
      if (targetReal !== target || !isInside(prepared.output, targetReal)) {
        fail(`a consumer tarball reference escapes the bundle: ${artifact.tarball}`);
      }
      const digest = createHash('sha512')
        .update(await readFile(target))
        .digest('base64');
      if (`sha512-${digest}` !== artifact.integrity) {
        fail(`a bundle tarball changed before the lock was written: ${artifact.tarball}`);
      }
    }
    success = true;
    return {
      output: prepared.output,
      artifactVersion,
      tarballs: artifacts.map((artifact) => artifact.tarball),
      installedCount: consumer.installedCount,
      closureSize: consumer.closureSize,
      npm,
      node: process.versions.node,
    };
  } finally {
    await scratch.cleanup();
    if (!success && prepared !== null) await prepared.cleanup();
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const result = await packBundle({ output: args.output });
  console.log(
    `pack: created ${result.artifactVersion} bundle at ${result.output} (private, four tarballs)`,
  );
  console.log(
    `pack: consumer lock holds ${result.installedCount} installed entries ` +
      `(${result.closureSize} reviewed public closure entries)`,
  );
  console.log('pack: SHA256SUMS covers four tarballs, package.json, and package-lock.json');
  console.log('pack: PASS');
}

const invoked = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof PackError ? error.message : String(error.message ?? error);
    console.error(`pack: FAIL: ${message}`);
    if (process.env.PTO_PACK_DEBUG === '1' && !(error instanceof PackError)) {
      console.error(error.stack ?? '');
    }
    process.exitCode = 1;
  });
}
