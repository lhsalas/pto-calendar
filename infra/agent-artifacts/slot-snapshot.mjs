// Deterministic whole-tree snapshots for the owned prior install slot (#265).
//
// The rollback smoke must prove that the prior installed tree is unchanged,
// not just that one hidden lock and a CLI version probe still look plausible.
// This helper walks the slot without following symlinks, records entry type,
// permission bits, raw symlink targets and regular-file digests, and never
// reads path targets outside the owned root. It deliberately excludes
// timestamps and emits no file contents.

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { assertTrustedDirectoryChain, fail, isInside } from './bundle-safety.mjs';

export const MAX_SLOT_ENTRIES = 50_000;
export const MAX_SLOT_DEPTH = 32;
export const MAX_SLOT_PATH = 1_024;
export const MAX_SLOT_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_SLOT_TOTAL_BYTES = 256 * 1024 * 1024;
export const MAX_SLOT_LINK_TARGET = 4_096;

function assertPath(path) {
  if (path.length > MAX_SLOT_PATH) fail('a slot tree member path is too long');
  if (/[\u0000-\u001f\u007f\\]/.test(path)) {
    fail('a slot tree member path has an unsupported character');
  }
}

async function readRegularFile(path, expected) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    fail('a slot tree member could not be opened without following links');
  }
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.dev !== expected.dev ||
      info.ino !== expected.ino ||
      info.uid !== expected.uid ||
      info.mode !== expected.mode ||
      info.nlink !== 1 ||
      info.size !== expected.size
    ) {
      fail('a slot tree member changed while being inspected');
    }
    // A concurrent size change cannot cause an unbounded read.
    const bytes = Buffer.allocUnsafe(expected.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, null);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset !== expected.size) fail('a slot tree member changed while being read');
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

/**
 * Snapshots one slot tree. `expectedOwner` is the captureOwnedDirectory record
 * for the exact root and parent directory this run created.
 */
export async function snapshotSlotTree(root, { expectedOwner }) {
  const rootInfo = await lstat(root).catch(() => null);
  if (rootInfo === null || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    fail('the slot tree root is not a real directory');
  }
  const rootReal = await realpath(root);
  if (rootReal !== root) fail('the slot tree root is not its canonical path');
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid !== null && rootInfo.uid !== uid) fail('the slot tree root is not owned by this user');
  if ((rootInfo.mode & 0o077) !== 0) fail('the slot tree root is not private');
  if (
    expectedOwner?.path !== root ||
    expectedOwner.dev !== rootInfo.dev ||
    expectedOwner.ino !== rootInfo.ino ||
    expectedOwner.uid !== rootInfo.uid ||
    !isInside(expectedOwner.parent, root)
  ) {
    fail('the slot tree root is not the owned prior installation');
  }
  const parentInfo = await lstat(expectedOwner.parent).catch(() => null);
  if (
    parentInfo === null ||
    !parentInfo.isDirectory() ||
    parentInfo.isSymbolicLink() ||
    parentInfo.dev !== expectedOwner.parentDev ||
    parentInfo.ino !== expectedOwner.parentIno ||
    parentInfo.uid !== expectedOwner.parentUid
  ) {
    fail('the slot tree parent is not the owned prior installation parent');
  }
  await assertTrustedDirectoryChain(root);

  const entries = [{ path: '', type: 'dir', mode: rootInfo.mode & 0o7777 }];
  let totalBytes = 0;

  const visit = async (directory, relative, depth) => {
    if (depth > MAX_SLOT_DEPTH) fail('the slot tree exceeds the depth bound');
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (entries.length >= MAX_SLOT_ENTRIES) fail('the slot tree exceeds the entry bound');
      const path = relative === '' ? child.name : `${relative}/${child.name}`;
      assertPath(path);
      const absolute = join(directory, child.name);
      if (!isInside(root, absolute)) fail('a slot tree member escapes the owned root');
      const info = await lstat(absolute);
      if (info.uid !== rootInfo.uid) fail('a slot tree member is not owned by this user');
      if (info.isSymbolicLink()) {
        const target = await readlink(absolute);
        if (target.length > MAX_SLOT_LINK_TARGET) fail('a slot tree link target is too long');
        entries.push({
          path,
          type: 'symlink',
          mode: info.mode & 0o7777,
          target,
        });
        continue;
      }
      if (info.isDirectory()) {
        entries.push({ path, type: 'dir', mode: info.mode & 0o7777 });
        await visit(absolute, path, depth + 1);
        continue;
      }
      if (!info.isFile()) fail('unsupported slot tree member type');
      if (info.nlink !== 1) fail('a slot tree member is hard-linked');
      if (info.size > MAX_SLOT_FILE_BYTES || totalBytes + info.size > MAX_SLOT_TOTAL_BYTES) {
        fail('the slot tree exceeds the byte bound');
      }
      const bytes = await readRegularFile(absolute, info);
      totalBytes += info.size;
      entries.push({
        path,
        type: 'file',
        mode: info.mode & 0o7777,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  };
  await visit(root, '', 0);
  return { root, entries, totalBytes };
}

function metadataOf(entry) {
  return {
    type: entry.type,
    mode: entry.mode,
    size: entry.size,
    sha256: entry.sha256,
    target: entry.target,
  };
}

/**
 * Compares two snapshots without timestamps. Returns a fixed reason when a
 * path is added/removed or type, permission bits, file digest/size or raw
 * link target changes.
 */
export function compareSlotSnapshots(before, after) {
  if (before === null || after === null || before === undefined || after === undefined) {
    return { equal: false, reason: 'a slot tree snapshot is missing' };
  }
  if (before.root !== after.root) {
    return { equal: false, reason: 'the slot tree root changed' };
  }
  const prior = new Map(before.entries.map((entry) => [entry.path, entry]));
  const next = new Map(after.entries.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...prior.keys(), ...next.keys()])].sort();
  for (const path of paths) {
    const left = prior.get(path);
    const right = next.get(path);
    if (left === undefined) return { equal: false, reason: `slot tree entry added: ${path}` };
    if (right === undefined) return { equal: false, reason: `slot tree entry removed: ${path}` };
    const leftMetadata = metadataOf(left);
    const rightMetadata = metadataOf(right);
    if (leftMetadata.type !== rightMetadata.type) {
      return { equal: false, reason: `slot tree entry type changed: ${path}` };
    }
    if (leftMetadata.mode !== rightMetadata.mode) {
      return { equal: false, reason: `slot tree entry mode changed: ${path}` };
    }
    if (leftMetadata.size !== rightMetadata.size) {
      return { equal: false, reason: `slot tree file size changed: ${path}` };
    }
    if (leftMetadata.sha256 !== rightMetadata.sha256) {
      return { equal: false, reason: `slot tree file digest changed: ${path}` };
    }
    if (leftMetadata.target !== rightMetadata.target) {
      return { equal: false, reason: `slot tree link target changed: ${path}` };
    }
  }
  return { equal: true, reason: '' };
}
