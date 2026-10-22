#!/usr/bin/env node
// Shared helpers for the Node.js runtime baseline checks.
//
// The repository pins one supported Node.js 24.x patch level in `.nvmrc`.
// `.nvmrc` is the single source of truth for:
//   - the local toolchain (nvm / fnm / asdf),
//   - the CI runtime (actions/setup-node `node-version-file`),
//   - the container base image tag (`node:<version>-alpine`),
//   - the documented `engines.node` floor.
//
// `MINIMUM_SUPPORTED_VERSION` is the last Node.js 24.x release that contains
// the October 2026 security fixes. Bump it (and `.nvmrc`) when a newer 24.x
// security release ships, so a rebuild can never silently fall back to an
// unpatched runtime.

export const MINIMUM_SUPPORTED_VERSION = '24.22.1';
export const SUPPORTED_MAJOR = 24;
export const VERSION_FILE = '.nvmrc';

/** Parse a `vX.Y.Z` / `X.Y.Z` string into a comparable tuple. */
export function parseVersion(value) {
  const match = /^\s*v?(\d+)\.(\d+)\.(\d+)\s*$/.exec(String(value ?? ''));
  if (!match) {
    throw new Error(`Unparseable Node.js version: ${JSON.stringify(value)}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** Return a negative number when `a` is older than `b`, 0 when equal, positive when newer. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) {
      return left[key] - right[key];
    }
  }
  return 0;
}

/** True when `actual` is at least `floor`. */
export function isAtLeast(actual, floor) {
  return compareVersions(actual, floor) >= 0;
}
