// Reviewed source/member inventory for the private agent bundles (#265).
//
// The inventory is versioned with the artifact version. It is deliberately
// independent of `.git` and of whatever happens to be lying in a developer's
// `src` directory: a `git archive` snapshot, a clean checkout, and the real
// worktree all use the same closed list. Adding or renaming a source member
// requires a deliberate update here, so an untracked `src` file plus a
// matching compiled file cannot silently enter the tarball.

import { PackError } from './bundle-safety.mjs';

export const REVIEWED_ARTIFACT_VERSION = '0.1.0';

export const SOURCE_MEMBERS = Object.freeze({
  cli: Object.freeze([
    'args.ts',
    'confirmation.ts',
    'contract.ts',
    'create-intent.ts',
    'execute-command.ts',
    'execute-write.ts',
    'help.ts',
    'main.ts',
    'output.ts',
    'write-contract.ts',
  ]),
  mcp: Object.freeze([
    'contract.ts',
    'framing.ts',
    'main.ts',
    'schema.ts',
    'server.ts',
    'tools.ts',
    'write-contract.ts',
    'write-preview.ts',
    'write-schema.ts',
    'write-tools.ts',
  ]),
  'packages/api-client': Object.freeze([
    'client.ts',
    'errors.ts',
    'index.ts',
    'origin.ts',
    'pagination.ts',
    'transport.ts',
    'wire.ts',
  ]),
  'packages/agent-auth': Object.freeze([
    'errors.ts',
    'index.ts',
    'keyring.ts',
    'profile-files.ts',
    'profiles.ts',
    'secret-input.ts',
    'validation.ts',
  ]),
});

function fail(message) {
  throw new PackError(message);
}

export function reviewedSourceMembers(directory) {
  const members = SOURCE_MEMBERS[directory];
  if (members === undefined) fail(`no reviewed source inventory for workspace: ${directory}`);
  return members;
}

/** The exact compiled members expected for a reviewed source inventory. */
export function reviewedCompiledMembers(directory, declarations) {
  const compiled = [];
  for (const member of reviewedSourceMembers(directory)) {
    if (!member.endsWith('.ts')) continue;
    const stem = member.slice(0, -'.ts'.length);
    compiled.push(`dist/${stem}.js`, `dist/${stem}.js.map`);
    if (declarations) compiled.push(`dist/${stem}.d.ts`, `dist/${stem}.d.ts.map`);
  }
  return compiled.sort();
}

function assertExactInventory(kind, directory, wanted, actual) {
  if (!Array.isArray(actual)) fail(`${kind} inventory is not a file list: ${directory}`);
  if (actual.some((member) => typeof member !== 'string' || member === '')) {
    fail(`${kind} inventory holds an invalid member: ${directory}`);
  }
  if (new Set(actual).size !== actual.length) {
    fail(`${kind} inventory holds a duplicate member: ${directory}`);
  }
  const expected = new Set(wanted);
  const seen = new Set(actual);
  for (const member of actual) {
    if (!expected.has(member)) {
      fail(`${kind} inventory changed; extra member is not reviewed: ${directory}/${member}`);
    }
  }
  for (const member of wanted) {
    if (!seen.has(member)) {
      fail(`${kind} inventory changed; reviewed member is missing: ${directory}/${member}`);
    }
  }
}

/** Fails closed when the real source tree differs from the reviewed inventory. */
export function assertSourceInventory(directory, actual) {
  assertExactInventory('source', directory, reviewedSourceMembers(directory), actual);
}

/** Fails closed when compiled output differs from the reviewed source mapping. */
export function assertCompiledInventory(directory, actual, declarations) {
  assertExactInventory(
    'compiled',
    directory,
    reviewedCompiledMembers(directory, declarations),
    actual,
  );
}
