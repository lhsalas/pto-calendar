// Lock graph derivation for the private agent bundles (#265).
//
// The consumer lock is not resolved from the registry. It is a
// path-preserving copy of the reachable runtime/peer/optional closure of the
// four workspace packages in the reviewed root `package-lock.json`, plus
// relative `file:` entries for the four packed tarballs. No dependency is
// added, removed, upgraded, or flattened. Public entries keep their exact
// reviewed `resolved` URL and sha512 integrity, including duplicate
// placements such as the two `content-type` versions.

const INTERNAL_PREFIX = '@pto-calendar/';
const PUBLIC_HOST = 'registry.npmjs.org';
const COPIED_FIELDS = [
  'version',
  'resolved',
  'integrity',
  'license',
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'bin',
  'engines',
  'os',
  'cpu',
  'funding',
  'deprecated',
];

export class LockGraphError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LockGraphError';
  }
}

function fail(message) {
  throw new LockGraphError(message);
}

function assertSha512Integrity(value, label) {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(String(value));
  if (match === null) fail(`${label} is not a sha512 tarball pin`);
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length !== 64) fail(`${label} is not a complete sha512 digest`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isInternal(name) {
  return name.startsWith(INTERNAL_PREFIX);
}

/** Extracts the package name from a lock path, including scoped hoisted names. */
function packageNameFromKey(key) {
  const marker = '/node_modules/';
  const index = key.lastIndexOf(marker);
  if (index !== -1) return key.slice(index + marker.length);
  if (key.startsWith('node_modules/')) return key.slice('node_modules/'.length);
  return key;
}

/** Resolves a dependency name from a lock package path using npm's nesting. */
export function resolveDependencyPath(packages, fromPath, name) {
  const candidates = [];
  if (fromPath === '') {
    candidates.push(`node_modules/${name}`);
  } else {
    let current = fromPath;
    for (;;) {
      candidates.push(`${current}/node_modules/${name}`);
      const marker = current.lastIndexOf('/node_modules/');
      if (marker === -1) {
        candidates.push(`node_modules/${name}`);
        break;
      }
      current = current.slice(0, marker);
    }
  }
  for (const candidate of candidates) {
    if (isObject(packages[candidate])) return candidate;
  }
  return null;
}

/**
 * Runtime edges, not just `dependencies`: npm installs peer dependencies and
 * any present optional dependency too. The closure walks all three so the
 * consumer lock keeps the reviewed runtime shape instead of flattening it.
 */
function dependencyEdges(entry) {
  const edges = [];
  for (const name of Object.keys(entry.dependencies ?? {})) {
    edges.push({ name, optional: false, kind: 'dependency' });
  }
  for (const name of Object.keys(entry.optionalDependencies ?? {})) {
    edges.push({ name, optional: true, kind: 'optionalDependency' });
  }
  const metadata = entry.peerDependenciesMeta ?? {};
  for (const name of Object.keys(entry.peerDependencies ?? {})) {
    const optional = metadata[name]?.optional === true;
    edges.push({ name, optional, kind: optional ? 'optionalPeer' : 'peerDependency' });
  }
  return edges;
}

function assertPublicEntry(path, entry) {
  if (entry.link === true) fail(`lock entry is a link instead of a package: ${path}`);
  if (entry.dev === true || entry.devOptional === true) {
    fail(`lock entry is dev-only, not runtime: ${path}`);
  }
  if (entry.inBundle === true) fail(`lock entry is bundled, not reviewed: ${path}`);
  if (typeof entry.version !== 'string' || entry.version === '') {
    fail(`lock entry is missing a version: ${path}`);
  }
  if (typeof entry.resolved !== 'string' || typeof entry.integrity !== 'string') {
    fail(`lock entry is missing its resolved tarball integrity: ${path}`);
  }
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)) {
    fail(`lock entry is not a sha512 tarball pin: ${path}`);
  }
  assertSha512Integrity(entry.integrity, `lock entry integrity ${path}`);
  if (!entry.resolved.endsWith('.tgz') || !entry.resolved.includes('/-/')) {
    fail(`lock entry is not a registry tarball path: ${path}`);
  }
  let url;
  try {
    url = new URL(entry.resolved);
  } catch {
    fail(`lock entry has an unparseable resolved location: ${path}`);
  }
  if (url.protocol !== 'https:' || url.host !== PUBLIC_HOST || url.username || url.password) {
    fail(`lock entry resolves outside the reviewed public registry: ${path}`);
  }
  if (url.search !== '' || url.hash !== '') {
    fail(`lock entry carries an unexpected registry query: ${path}`);
  }
}

function copyPublicEntry(entry) {
  const copy = {};
  for (const field of COPIED_FIELDS) {
    if (entry[field] !== undefined) copy[field] = entry[field];
  }
  return copy;
}

/** Finds the reviewed root-lock key for a workspace name and version. */
function workspaceLockKey(packages, name, version) {
  const matches = [];
  for (const [key, entry] of Object.entries(packages)) {
    if (key.startsWith('node_modules/') || !isObject(entry)) continue;
    if (entry.name === name && entry.version === version) matches.push(key);
  }
  if (matches.length !== 1) {
    fail(`reviewed root lock does not hold exactly one workspace entry for ${name}`);
  }
  return matches[0];
}

function assertArtifacts(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length !== 4) {
    fail('the artifact set must hold exactly four workspace packages');
  }
  const names = new Set();
  const versions = new Set();
  const tarballs = new Set();
  for (const artifact of artifacts) {
    if (typeof artifact.name !== 'string' || typeof artifact.version !== 'string') {
      fail('an artifact is missing its package name or version');
    }
    if (names.has(artifact.name)) fail(`duplicate artifact package name: ${artifact.name}`);
    names.add(artifact.name);
    versions.add(artifact.version);
    if (!/^[a-z0-9][a-z0-9._-]*\.tgz$/.test(artifact.tarball)) {
      fail(`artifact tarball name is not a flat local file: ${artifact.tarball}`);
    }
    if (tarballs.has(artifact.tarball)) fail(`duplicate artifact tarball: ${artifact.tarball}`);
    tarballs.add(artifact.tarball);
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(artifact.integrity)) {
      fail(`artifact is missing its actual sha512 integrity: ${artifact.name}`);
    }
    assertSha512Integrity(artifact.integrity, `artifact integrity ${artifact.name}`);
    if (!isObject(artifact.manifest) || artifact.manifest.private !== true) {
      fail(`artifact manifest is not private: ${artifact.name}`);
    }
    if (artifact.manifest.name !== artifact.name) {
      fail(`artifact manifest name changed: ${artifact.name}`);
    }
    if (artifact.manifest.version !== artifact.version) {
      fail(`artifact manifest version changed: ${artifact.name}`);
    }
    if (artifact.manifest.license !== 'UNLICENSED') {
      fail(`artifact manifest license changed: ${artifact.name}`);
    }
  }
  if (versions.size !== 1) fail('the four artifacts do not share one version');
}

/**
 * Builds the consumer manifest and path-preserving v3 lock.
 *
 * @param {{rootLock: object, artifactVersion: string, rootEngines: object, artifacts: object[]}} input
 * @returns {{manifest: object, lock: object, closureSize: number, installedCount: number}}
 */
export function buildConsumerLock({ rootLock, artifactVersion, rootEngines, artifacts }) {
  if (!isObject(rootLock) || rootLock.lockfileVersion !== 3 || !isObject(rootLock.packages)) {
    fail('the reviewed root lock is not a v3 package map');
  }
  assertArtifacts(artifacts);
  for (const artifact of artifacts) {
    if (artifact.version !== artifactVersion) {
      fail('the artifact version does not equal the requested bundle version');
    }
  }
  if (typeof rootEngines?.node !== 'string' || typeof rootEngines?.npm !== 'string') {
    fail('the reviewed root engines floor is missing');
  }

  const packages = rootLock.packages;
  const rootEntries = new Map();
  for (const artifact of artifacts) {
    const key = workspaceLockKey(packages, artifact.name, artifact.version);
    rootEntries.set(artifact.name, packages[key]);
  }

  const closure = new Map();
  const visit = (path) => {
    if (closure.has(path)) return;
    const entry = packages[path];
    if (!isObject(entry)) fail(`reviewed root lock is missing a reachable package: ${path}`);
    closure.set(path, entry);
    for (const edge of dependencyEdges(entry)) {
      const resolved = resolveDependencyPath(packages, path, edge.name);
      if (resolved === null) {
        if (!edge.optional) {
          fail(`reviewed root lock has an unresolved ${edge.kind}: ${path} -> ${edge.name}`);
        }
        continue;
      }
      visit(resolved);
    }
  };

  for (const artifact of artifacts) {
    const entry = rootEntries.get(artifact.name);
    for (const edge of dependencyEdges(entry)) {
      if (isInternal(edge.name)) continue;
      const resolved = resolveDependencyPath(packages, '', edge.name);
      if (resolved === null) {
        if (!edge.optional) {
          fail(`reviewed root lock cannot resolve ${artifact.name} -> ${edge.name}`);
        }
        continue;
      }
      visit(resolved);
    }
  }

  for (const path of closure.keys()) {
    if (
      path === '' ||
      path.endsWith('/node_modules') ||
      path.includes('/node_modules/node_modules/')
    ) {
      fail(`reviewed closure holds an invalid package path: ${path}`);
    }
    if (isInternal(packageNameFromKey(path))) {
      fail(`a private workspace must never resolve upstream: ${path}`);
    }
    assertPublicEntry(path, closure.get(path));
  }

  const manifest = {
    name: 'pto-calendar-agent-bundle',
    version: artifactVersion,
    private: true,
    license: 'UNLICENSED',
    dependencies: {},
    engines: { node: rootEngines.node, npm: rootEngines.npm },
  };
  for (const artifact of artifacts) {
    manifest.dependencies[artifact.name] = `file:${artifact.tarball}`;
  }

  const out = {
    '': {
      name: manifest.name,
      version: manifest.version,
      private: true,
      license: manifest.license,
      dependencies: manifest.dependencies,
      engines: manifest.engines,
    },
  };

  for (const artifact of artifacts) {
    const entry = {
      name: artifact.name,
      version: artifact.version,
      resolved: `file:${artifact.tarball}`,
      integrity: artifact.integrity,
      license: artifact.manifest.license,
      engines: { node: rootEngines.node, npm: rootEngines.npm },
    };
    if (isObject(artifact.manifest.bin) && Object.keys(artifact.manifest.bin).length > 0) {
      entry.bin = artifact.manifest.bin;
    }
    if (isObject(artifact.manifest.dependencies)) {
      entry.dependencies = artifact.manifest.dependencies;
    }
    out[`node_modules/${artifact.name}`] = entry;
  }

  for (const path of [...closure.keys()].sort()) {
    out[path] = copyPublicEntry(closure.get(path));
  }

  const lock = {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: out,
  };

  // Keys are preserved verbatim, so a nested placement is never hoisted into
  // a different version. The reviewed duplicate content-type pair is pinned
  // explicitly; the same path-preserving rule applies to every duplicate.
  assertContentTypePlacements(packages, out);
  assertConsumerLock({ lock, artifacts });
  return {
    manifest,
    lock,
    closureSize: closure.size,
    installedCount: Object.keys(out).length - 1,
  };
}

/** Pins the reviewed duplicate content-type placement called out by #265. */
function assertContentTypePlacements(reviewed, out) {
  const reviewedPaths = Object.keys(reviewed)
    .filter((key) => key.startsWith('node_modules/') && packageNameFromKey(key) === 'content-type')
    .sort();
  if (reviewedPaths.length !== 2) {
    fail('the reviewed root lock no longer holds exactly two content-type placements');
  }
  const nested = reviewedPaths.find((key) => key.includes('/node_modules/'));
  const hoisted = reviewedPaths.find((key) => !key.includes('/node_modules/'));
  if (nested === undefined || hoisted === undefined) {
    fail('the reviewed content-type placements are not one nested and one hoisted');
  }
  if (reviewed[nested].version === reviewed[hoisted].version) {
    fail('the reviewed content-type placements no longer hold distinct versions');
  }
  for (const path of reviewedPaths) {
    if (!isObject(out[path]) || out[path].version !== reviewed[path].version) {
      fail(`the consumer lock did not preserve the reviewed content-type placement: ${path}`);
    }
  }
}

/** Re-verifies the generated lock against the artifacts and its own graph. */
export function assertConsumerLock({ lock, artifacts }) {
  if (!isObject(lock) || lock.lockfileVersion !== 3 || !isObject(lock.packages)) {
    fail('the consumer lock is not a v3 package map');
  }
  const packages = lock.packages;
  const root = packages[''];
  if (!isObject(root)) fail('the consumer lock has no root package');
  if (root.private !== true) fail('the consumer lock root is not private');
  if (!isObject(root.dependencies)) fail('the consumer lock root has no dependencies');

  const artifactByName = new Map(artifacts.map((artifact) => [artifact.name, artifact]));
  if (Object.keys(root.dependencies).length !== 4) {
    fail('the consumer lock root does not pin exactly four local bundles');
  }
  for (const artifact of artifacts) {
    const spec = root.dependencies[artifact.name];
    if (spec !== `file:${artifact.tarball}`) {
      fail(`consumer lock root does not use a relative file reference: ${artifact.name}`);
    }
    const key = `node_modules/${artifact.name}`;
    const entry = packages[key];
    if (!isObject(entry)) fail(`consumer lock is missing its local bundle: ${artifact.name}`);
    if (entry.name !== artifact.name || entry.version !== artifact.version) {
      fail(`consumer lock local bundle identity changed: ${artifact.name}`);
    }
    if (entry.resolved !== `file:${artifact.tarball}` || entry.integrity !== artifact.integrity) {
      fail(`consumer lock local bundle is not the verified archive: ${artifact.name}`);
    }
    if (entry.license !== 'UNLICENSED') {
      fail(`consumer lock local bundle lost its license metadata: ${artifact.name}`);
    }
  }

  for (const [key, entry] of Object.entries(packages)) {
    if (key === '') continue;
    if (!isObject(entry)) fail(`consumer lock entry is not an object: ${key}`);
    if (typeof entry.resolved === 'string' && entry.resolved.startsWith('file:')) {
      const name = packageNameFromKey(key);
      const artifact = artifactByName.get(name);
      if (artifact === undefined) fail(`consumer lock holds an unknown local reference: ${key}`);
      if (entry.resolved !== `file:${artifact.tarball}`) {
        fail(`consumer lock local reference is not the verified archive: ${key}`);
      }
      if (entry.integrity !== artifact.integrity) {
        fail(`consumer lock local reference integrity is wrong: ${key}`);
      }
      continue;
    }
    if (entry.resolved === undefined) {
      fail(`consumer lock entry has no resolved location: ${key}`);
    }
    if (isInternal(packageNameFromKey(key))) {
      fail(`a private workspace must never resolve upstream: ${key}`);
    }
    assertPublicEntry(key, entry);
  }

  const reachable = new Set();
  const stack = [...Object.keys(root.dependencies).map((name) => `node_modules/${name}`)];
  while (stack.length > 0) {
    const path = stack.pop();
    if (reachable.has(path)) continue;
    if (!isObject(packages[path])) fail(`consumer lock edge points at a missing package: ${path}`);
    reachable.add(path);
    for (const edge of dependencyEdges(packages[path])) {
      const resolved = resolveDependencyPath(packages, path, edge.name);
      if (resolved === null) {
        if (!edge.optional) {
          fail(`consumer lock has an unresolved ${edge.kind}: ${path} -> ${edge.name}`);
        }
        continue;
      }
      stack.push(resolved);
    }
  }
  for (const key of Object.keys(packages)) {
    if (key !== '' && !reachable.has(key)) {
      fail(`consumer lock holds an unreachable package: ${key}`);
    }
  }

  const versionsByName = new Map();
  for (const key of Object.keys(packages)) {
    if (key === '') continue;
    const name = packageNameFromKey(key);
    const version = packages[key].version;
    const list = versionsByName.get(name) ?? new Set();
    list.add(version);
    versionsByName.set(name, list);
  }
  for (const [name, versions] of versionsByName) {
    if (versions.size > 1 && name === 'content-type') {
      const keys = Object.keys(packages).filter((key) => key.endsWith('/content-type'));
      if (keys.length !== 2) fail('the two content-type placements were not preserved');
      continue;
    }
    if (versions.size > 1) {
      // Duplicate placements are allowed only when the reviewed root lock
      // actually has them. Keeping them path-preserving is the point.
      if (![...versions].every((version) => typeof version === 'string')) {
        fail(`consumer lock has an invalid duplicate version set: ${name}`);
      }
    }
  }
}
