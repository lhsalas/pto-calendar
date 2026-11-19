/**
 * Owner-only local file storage for agent credential profiles (#260).
 *
 * This is the Linux file lane of the agent-auth package. It keeps one bounded
 * metadata record per profile inside a trusted absolute directory:
 *
 * - The store path is opened one component at a time. Every component is
 *   opened relative to the handle of the directory before it
 *   (`/proc/self/fd/<handle>/<name>`, `O_NOFOLLOW`), so nothing is resolved
 *   from the current working directory and nothing is created recursively by
 *   path. A symbolic link anywhere on the path is refused.
 * - Every opened directory is checked through its own handle. The root and
 *   every ancestor must be owned by root or by the current user, and must not
 *   be writable by others unless they are sticky. The store must be owned by
 *   the current user with mode 0700. A missing component is created owner-only
 *   and its mode is set through its own handle, never by path.
 * - A record is a regular file of mode 0600 owned by the current user with a
 *   single link. A symbolic link, a hard link, a foreign or wider file, a
 *   directory, a FIFO or a socket is refused rather than read, replaced or
 *   removed.
 * - A write admits the record it replaces first, so a symbolic link, a hard
 *   link, a foreign, nonregular or corrupt record is never overwritten even if
 *   the caller did not read it. The admitted record and the staged file keep
 *   their descriptors open through every identity check, so an inode number
 *   freed by another process cannot be recycled into a false match. The new
 *   content is staged in the same directory under an unpredictable name created
 *   with `O_EXCL`, flushed, then renamed over the target. The store is flushed
 *   after the rename. A failure after the rename is reported as unconfirmed:
 *   nothing is rolled back and no success is claimed.
 * - Each profile is serialized by an exclusive lock directory that is held for
 *   the whole callback. A held lock is reported as busy. It is never waited on,
 *   broken or removed by anybody but the process that created it, so a stale
 *   lock after a crash stays closed until a person clears it.
 * - The file access that the callback receives is revoked when the callback
 *   settles, before the lock is released and before the store handle is closed.
 *   A later use reports unavailable instead of touching a descriptor number
 *   that the system may have reused.
 * - Every failed system call is mapped to a fixed `AgentAuthError`. Nothing here
 *   logs, and no error carries a path, a record, a token or a raw cause.
 *
 * Limits: a process running as root or as the same user can replace entries
 * of the store between two of its own system calls. Identity checks narrow
 * those windows before each rename and unlink, but they do not eliminate them,
 * and a same-user process can read the stored token in any case. A record that
 * is replaced between its last check and the rename can still be overwritten;
 * the link count after the rename detects a record that was moved aside, but not
 * every such race. A target that was absent at its last check is not pinned, so
 * a file created there before the rename is overwritten as well. The guarantees
 * assume a local Linux filesystem with working `fsync`, and a store path whose
 * components are real directories rather than symbolic links.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';

import { AgentAuthError } from './errors.js';
import { requireProfileName, validateStoredProfile } from './validation.js';
import type { StoredProfile } from './validation.js';

/** The largest metadata record this adapter reads or writes. */
const MAX_METADATA_BYTES = 4096;
/** The exact mode of the store directory, of every directory it creates and of a lock. */
const DIRECTORY_MODE = 0o700;
/** The exact mode of a stored metadata record and of a stage file. */
const FILE_MODE = 0o600;
/** The procfs directory whose entries are the handles of this process. */
const PROC_FD = '/proc/self/fd';
/** The prefix of the per-profile lock directory inside the store directory. */
const LOCK_PREFIX = '.lock.';
/** The prefix of the per-write stage file inside the store directory. */
const STAGE_PREFIX = '.stage.';
/** The suffix of a stored metadata record inside the store directory. */
const RECORD_SUFFIX = '.json';
/**
 * The open errors that mean an entry is there but is not an object this
 * adapter may use: a symbolic link (ELOOP, or ENOTDIR for a directory open),
 * a path that is not a directory (ENOTDIR) and a socket (ENXIO).
 */
const UNSAFE_OPEN_CODES = new Set(['ELOOP', 'ENOTDIR', 'ENXIO']);

/** A directory handle that never follows a symbolic link at its last component. */
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
/** A record is opened without blocking, so a FIFO is inspected and refused rather than waited on. */
const RECORD_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
/** A stage file is only ever created exclusively, never opened over an existing entry. */
const STAGE_FLAGS =
  fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;

/**
 * The access to the metadata record of one profile.
 *
 * An instance is only handed to the callback of `withProfile`. It stops
 * working when that callback settles.
 */
export interface ProfileFile {
  /** The stored record, or null when the profile has no record yet. */
  read(): Promise<StoredProfile | null>;
  /** Stores a record, replacing any previous one atomically. */
  write(value: StoredProfile): Promise<void>;
  /** Removes the record. True when a record was removed. */
  remove(): Promise<boolean>;
}

/** The owner-only local store of profile records. */
export interface ProfileFiles {
  /**
   * Runs `action` with the record of `name` while the exclusive lock of that
   * profile is held.
   *
   * When the store directory does not exist and `createDirectory` is false,
   * the directory is not created: the action receives an access that reads
   * null, removes nothing and refuses to write.
   */
  withProfile<T>(
    name: string,
    createDirectory: boolean,
    action: (file: ProfileFile) => Promise<T>,
  ): Promise<T>;
}

/** The callback of `withProfile`. */
type Action<T> = (file: ProfileFile) => Promise<T>;

/** The settled result of a callback or of a cleanup step. */
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** The identity of one filesystem object: its device and its inode number. */
interface Identity {
  readonly device: number;
  readonly inode: number;
}

/**
 * An acquired per-profile lock.
 *
 * `handle` pins the lock directory while the lock is held, so its inode number
 * cannot be recycled and the identity check on release is meaningful.
 */
interface ProfileLock {
  readonly store: number;
  readonly name: string;
  readonly handle: number;
  readonly identity: Identity;
}

/** A stage file that belongs to one write. `handle` is -1 once it is closed. */
interface Stage {
  readonly path: string;
  handle: number;
  readonly identity: Identity;
}

/**
 * An admitted record whose descriptor is still open.
 *
 * The open descriptor pins the object that was admitted: no other file can take
 * its inode number while its identity is still compared. The owner closes the
 * handle exactly once.
 */
interface Pinned {
  readonly handle: number;
  readonly identity: Identity;
  readonly record: StoredProfile;
}

/** The access of one callback, and the revocation that ends it. */
interface Access {
  readonly file: ProfileFile;
  revoke(): void;
}

/**
 * The local file store of one trusted absolute directory.
 *
 * The directory is never resolved against the current working directory and
 * is never read from an ambient dotenv file: the caller names it.
 */
class LocalProfileFiles implements ProfileFiles {
  readonly #components: readonly string[];

  constructor(directory: string) {
    assertSupportedPlatform();
    this.#components = splitStorePath(directory);
  }

  async withProfile<T>(
    name: string,
    createDirectory: boolean,
    action: (file: ProfileFile) => Promise<T>,
  ): Promise<T> {
    if (typeof action !== 'function') throw new AgentAuthError('INVALID_OPTIONS');
    if (typeof createDirectory !== 'boolean') throw new AgentAuthError('INVALID_OPTIONS');
    const profile = requireProfileName(name);
    const store = openStoreDirectory(this.#components, createDirectory);
    if (store === null) return runAbsent(action);
    return runWithStore(store, profile, action);
  }
}

/**
 * Creates the owner-only local store of one trusted absolute directory.
 *
 * The directory must be an absolute path without a dot segment, a parent
 * segment or an empty segment. It is not created here: a caller that wants
 * the store to exist asks for it with `withProfile`.
 */
export function createProfileFiles(directory: string): ProfileFiles {
  return new LocalProfileFiles(directory);
}

/**
 * Refuses the platforms this adapter is not written for.
 *
 * The file lane is a Linux v1 adapter. Everywhere else the store is
 * explicitly unavailable instead of silently falling back to weaker storage.
 * The procfs descriptor directory is required, because every path of this
 * adapter is anchored through it.
 */
function assertSupportedPlatform(): void {
  if (process.platform !== 'linux' || !existsSync(PROC_FD)) {
    throw new AgentAuthError('FILE_UNAVAILABLE');
  }
}

/**
 * Splits a trusted absolute directory into its exact path components.
 *
 * A relative path, a dot segment, a parent segment, an empty segment or a
 * NUL byte is refused: the caller must name one exact absolute location.
 */
function splitStorePath(directory: string): string[] {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new AgentAuthError('INVALID_OPTIONS');
  }
  if (directory.includes('\0')) throw new AgentAuthError('INVALID_OPTIONS');
  if (!directory.startsWith('/')) throw new AgentAuthError('INVALID_OPTIONS');
  const components = directory.split('/').slice(1);
  for (const component of components) {
    if (component.length === 0 || component === '.' || component === '..') {
      throw new AgentAuthError('INVALID_OPTIONS');
    }
  }
  return components;
}

/**
 * Opens the store directory, creating its missing components when allowed.
 *
 * Every handle that is opened is closed on every path, including a failed
 * check and a failed close. A missing component is reported as null when it
 * may not be created; an existing but unsafe entry is never reported as
 * absent. The returned handle belongs to the caller.
 */
function openStoreDirectory(components: readonly string[], create: boolean): number | null {
  let current = -1;
  try {
    current = attempt(() => openSync('/', DIRECTORY_FLAGS));
    assertTrustedAncestor(statHandle(current));
    for (let index = 0; index < components.length; index += 1) {
      const isStore = index === components.length - 1;
      const child = openChildDirectory(current, components[index]!, create);
      const parent = current;
      if (child === null) {
        current = -1;
        closeHandle(parent);
        return null;
      }
      // The child is owned from here on. The parent is released next, and the
      // child is closed by the cleanup below if the parent release fails.
      current = child;
      closeHandle(parent);
      const stat = statHandle(child);
      if (isStore) assertOwnerOnlyDirectory(stat);
      else assertTrustedAncestor(stat);
    }
    const store = current;
    current = -1;
    return store;
  } finally {
    if (current >= 0) closeQuietly(current);
  }
}

/**
 * Opens one child of an anchored parent, creating it when allowed.
 *
 * A directory that another process creates first is adopted and then checked
 * by the caller. A directory created here is set owner-only through its own
 * handle, so a substituted name can never receive that change.
 */
function openChildDirectory(parent: number, name: string, create: boolean): number | null {
  const path = anchoredPath(parent, name);
  const existing = openOrNull(path, DIRECTORY_FLAGS);
  if (existing !== null || !create) return existing;
  const created = makeOwnerDirectory(path);
  const child = openOrNull(path, DIRECTORY_FLAGS);
  if (child === null) throw new AgentAuthError('FILE_UNAVAILABLE');
  if (created) {
    try {
      attempt(() => fchmodSync(child, DIRECTORY_MODE));
    } catch (error) {
      closeQuietly(child);
      throw error;
    }
  }
  return child;
}

/**
 * Creates one owner-only directory inside an already verified parent.
 *
 * Returns true when this call created the directory and false when an entry
 * of that name already exists. Any other failure is unavailable.
 */
function makeOwnerDirectory(path: string): boolean {
  try {
    mkdirSync(path, { mode: DIRECTORY_MODE });
    return true;
  } catch (error) {
    if (errnoCode(error) === 'EEXIST') return false;
    throw new AgentAuthError('FILE_UNAVAILABLE');
  }
}

/**
 * An ancestor, or the root, of the store directory may not let other users
 * replace its entries.
 *
 * It must belong to root or to the current user. A directory that other users
 * may write is only accepted when it is sticky, because then other users
 * cannot remove or rename the entries that the owner controls. A foreign owner
 * is never trusted, even for a sticky directory.
 */
function assertTrustedAncestor(stat: Stats): void {
  if (stat.uid !== 0 && stat.uid !== currentUserId()) throw new AgentAuthError('FILE_UNSAFE');
  const mode = stat.mode & 0o7777;
  const writableByOthers = (mode & 0o022) !== 0;
  const sticky = (mode & 0o1000) !== 0;
  if (writableByOthers && !sticky) throw new AgentAuthError('FILE_UNSAFE');
}

/** The store directory belongs to the current user, and to nobody else, with exact mode 0700. */
function assertOwnerOnlyDirectory(stat: Stats): void {
  if (stat.uid !== currentUserId()) throw new AgentAuthError('FILE_UNSAFE');
  if ((stat.mode & 0o7777) !== DIRECTORY_MODE) throw new AgentAuthError('FILE_UNSAFE');
}

/**
 * Takes the exclusive lock of one profile.
 *
 * The lock is a directory of its own, so taking it is a single atomic step
 * that every process observes. A lock that already exists is busy: it is
 * never waited on and never adopted. The lock directory is pinned through a
 * handle that is kept until release. A failure that prevents establishing
 * lock identity leaves the lock in place rather than removing by name.
 */
function acquireProfileLock(store: number, profile: string): ProfileLock {
  const name = `${LOCK_PREFIX}${profile}`;
  const path = anchoredPath(store, name);
  try {
    mkdirSync(path, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (errnoCode(error) === 'EEXIST') throw new AgentAuthError('FILE_BUSY');
    throw new AgentAuthError('FILE_UNAVAILABLE');
  }
  let handle = -1;
  let lock: ProfileLock | undefined;
  try {
    handle = attempt(() => openSync(path, DIRECTORY_FLAGS));
    const stat = statHandle(handle);
    if (stat.uid !== currentUserId()) throw new AgentAuthError('FILE_UNSAFE');
    lock = { store, name, handle, identity: identityOf(stat) };
    attempt(() => fchmodSync(handle, DIRECTORY_MODE));
    return lock;
  } catch (error) {
    if (lock !== undefined) {
      try {
        removeOwnLock(lock);
      } catch {
        // An unverified or unremovable lock fails closed.
      }
    }
    if (handle >= 0) closeQuietly(handle);
    throw error;
  }
}

/**
 * Releases the exclusive lock of one profile.
 *
 * Only the lock that this process created is removed. A lock that was
 * replaced by another entry is left alone and reported as unavailable, so a
 * lock that nobody owns is never deleted. The pinned handle is closed on every
 * path.
 */
function releaseProfileLock(lock: ProfileLock): void {
  try {
    removeOwnLock(lock);
  } finally {
    closeHandle(lock.handle);
  }
}

/** Removes the lock directory when it is still the one this process created. */
function removeOwnLock(lock: ProfileLock): void {
  const path = anchoredPath(lock.store, lock.name);
  const current = statOrNull(path);
  if (current === null) return;
  if (!matchesIdentity(current, lock.identity)) throw new AgentAuthError('FILE_UNAVAILABLE');
  attempt(() => rmdirSync(path));
}

/** The access of one callback to a profile that lives in an open store. */
function createBoundProfile(store: number, profile: string): Access {
  const name = `${profile}${RECORD_SUFFIX}`;
  let open = true;
  const ensureOpen = (): void => {
    if (!open) throw new AgentAuthError('FILE_UNAVAILABLE');
  };
  return {
    file: {
      async read(): Promise<StoredProfile | null> {
        ensureOpen();
        return readRecord(store, name, profile);
      },
      async write(value: StoredProfile): Promise<void> {
        ensureOpen();
        writeRecord(store, name, profile, value);
      },
      async remove(): Promise<boolean> {
        ensureOpen();
        return removeRecord(store, name);
      },
    },
    revoke(): void {
      open = false;
    },
  };
}

/** The access of a callback to a store that does not exist. */
function createAbsentProfile(): Access {
  let open = true;
  const ensureOpen = (): void => {
    if (!open) throw new AgentAuthError('FILE_UNAVAILABLE');
  };
  return {
    file: {
      async read(): Promise<StoredProfile | null> {
        ensureOpen();
        return null;
      },
      async write(): Promise<void> {
        ensureOpen();
        throw new AgentAuthError('FILE_UNAVAILABLE');
      },
      async remove(): Promise<boolean> {
        ensureOpen();
        return false;
      },
    },
    revoke(): void {
      open = false;
    },
  };
}

/** Runs the action of a store that does not exist. Nothing is locked or written. */
async function runAbsent<T>(action: Action<T>): Promise<T> {
  const access = createAbsentProfile();
  try {
    return await action(access.file);
  } finally {
    access.revoke();
  }
}

/**
 * Runs the action of one profile in an open store and then closes the store.
 *
 * The callback error wins over a release or close failure. A release or close
 * failure is only reported when the callback itself succeeded.
 */
async function runWithStore<T>(store: number, profile: string, action: Action<T>): Promise<T> {
  const outcome = await settle(() => runLocked(store, profile, action));
  try {
    closeHandle(store);
  } catch (error) {
    if (outcome.ok) throw error;
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/**
 * Takes the lock of one profile, runs the action and releases the lock.
 *
 * The access is revoked before the release, so no operation can start after
 * the lock is released. The lock is released even when the action fails.
 */
async function runLocked<T>(store: number, profile: string, action: Action<T>): Promise<T> {
  const lock = acquireProfileLock(store, profile);
  const access = createBoundProfile(store, profile);
  const outcome = await settle(() => action(access.file));
  access.revoke();
  try {
    releaseProfileLock(lock);
  } catch (error) {
    if (outcome.ok) throw error;
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/** Settles a promise into an outcome without throwing. */
async function settle<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Reads the stored record of one profile, or null when there is none.
 *
 * The record is read through an anchored handle, so a substituted entry is
 * never opened. A record that is not a bounded, valid profile is reported as
 * corrupt and its content is never shown.
 */
function readRecord(store: number, name: string, profile: string): StoredProfile | null {
  const pinned = pinRecord(store, name, profile);
  if (pinned === null) return null;
  closeHandle(pinned.handle);
  return pinned.record;
}

/**
 * Admits the record at one name of the store and keeps its descriptor open.
 *
 * Returns null when there is no entry. Otherwise the entry must be an owner-only
 * regular file with a single link, and its content must be a valid profile of
 * this name. The open handle belongs to the caller, which closes it exactly once.
 * While the handle stays open the admitted object cannot be freed, so its inode
 * number cannot be reused by another file and an identity comparison against it
 * stays meaningful. A failed admission closes the handle and keeps its error.
 */
function pinRecord(store: number, name: string, profile: string): Pinned | null {
  const handle = openOrNull(anchoredPath(store, name), RECORD_FLAGS);
  if (handle === null) return null;
  try {
    const stat = statHandle(handle);
    assertOwnerOnlyRecord(stat);
    return { handle, identity: identityOf(stat), record: readContent(handle, profile) };
  } catch (error) {
    closeQuietly(handle);
    throw error;
  }
}

/**
 * Reads at most one byte more than the bound, then validates the content.
 *
 * Reads go through the handle and use an explicit position, so the content
 * always belongs to the file that was admitted.
 */
function readContent(handle: number, profile: string): StoredProfile {
  const buffer = Buffer.alloc(MAX_METADATA_BYTES + 1);
  let length = 0;
  while (length < buffer.byteLength) {
    const count = attempt(() =>
      readSync(handle, buffer, length, buffer.byteLength - length, length),
    );
    if (count === 0) break;
    length += count;
  }
  assertBoundedRecord(length);
  try {
    return validateStoredProfile(JSON.parse(buffer.toString('utf8', 0, length)), profile);
  } catch {
    throw new AgentAuthError('PROFILE_CORRUPT');
  }
}

/**
 * Writes the record of one profile.
 *
 * The record that is replaced is admitted first, even if the caller read it,
 * and its descriptor stays open until the write has settled. The new content is
 * staged in the same directory, flushed, and then renamed over the target after
 * the target has been checked again. A failure before the rename removes the
 * stage that this write created and leaves the target alone. The rename is the
 * commit point. A failure after it, including a failed close, is reported with
 * an unconfirmed outcome: the new record may already be in place, nothing here
 * restores the previous record, and no success is claimed.
 */
function writeRecord(store: number, name: string, profile: string, value: StoredProfile): void {
  const record = validateStoredProfile(value, profile);
  const bytes = Buffer.from(JSON.stringify(record), 'utf8');
  assertBoundedRecord(bytes.byteLength);
  const replaced = pinRecord(store, name, profile);
  try {
    publishRecord(store, name, profile, bytes, replaced);
  } catch (error) {
    if (replaced !== null) closeQuietly(replaced.handle);
    throw error;
  }
  if (replaced !== null) closeHandle(replaced.handle);
}

/**
 * Stages the new content and renames it over the admitted record.
 *
 * The stage and the admitted record stay pinned through every check that comes
 * before the rename and through the checks that come after it. The stage is only
 * closed once the commit has been checked, and its name is checked while it is
 * still pinned, so a recycled inode number can never make a check pass.
 */
function publishRecord(
  store: number,
  name: string,
  profile: string,
  bytes: Buffer,
  replaced: Pinned | null,
): void {
  const target = anchoredPath(store, name);
  const stage = createStage(store, profile);
  try {
    attempt(() => fchmodSync(stage.handle, FILE_MODE));
    attempt(() => writeFileSync(stage.handle, bytes));
    attempt(() => fsyncSync(stage.handle));
    assertIdentityAt(stage.path, stage.identity);
    assertIdentityAt(target, replaced === null ? null : replaced.identity);
    attempt(() => renameSync(stage.path, target));
    assertIdentityAt(target, stage.identity);
    assertReplacedUnlinked(replaced);
    attempt(() => fsyncSync(store));
  } catch (error) {
    discardStage(stage);
    throw error;
  }
  closeStage(stage);
}

/**
 * After the rename the admitted record must have lost its only name.
 *
 * Its descriptor keeps the object alive, so a link count that stays positive
 * means that the name which was replaced was not the admitted record: the record
 * was moved aside before the rename, for example. That is reported as unsafe.
 */
function assertReplacedUnlinked(replaced: Pinned | null): void {
  if (replaced === null) return;
  if (statHandle(replaced.handle).nlink !== 0) throw new AgentAuthError('FILE_UNSAFE');
}

/**
 * Creates a stage file exclusively and records its identity.
 *
 * The name is random and the file is created with `O_EXCL`, so an existing
 * entry is never opened or removed. A stage that cannot even be inspected has
 * no identity, so it is never removed by name and is left in place.
 */
function createStage(store: number, profile: string): Stage {
  const path = anchoredPath(store, `${STAGE_PREFIX}${profile}.${randomBytes(8).toString('hex')}`);
  const handle = attempt(() => openSync(path, STAGE_FLAGS, FILE_MODE));
  try {
    return { path, handle, identity: identityOf(statHandle(handle)) };
  } catch (error) {
    closeQuietly(handle);
    throw error;
  }
}

/**
 * Closes the stage once the commit has been checked. The handle is forgotten
 * before the close is attempted, so it is never closed twice, and a failed close
 * is reported: the write has already committed, so it must not claim success.
 */
function closeStage(stage: Stage): void {
  const handle = stage.handle;
  stage.handle = -1;
  closeHandle(handle);
}

/**
 * Removes the stage that this write created, and only that stage, then closes it.
 *
 * The stage name is checked while the stage descriptor still pins its object, so
 * an inode number cannot be recycled into a false match. The name is unlinked
 * only while it refers to that object. A name that now refers to anything else is
 * never taken over. The stage is closed after the check, exactly once, and a
 * failed close here does not replace the error of the write.
 */
function discardStage(stage: Stage): void {
  try {
    if (matchesIdentity(statOrNull(stage.path), stage.identity)) unlinkQuietly(stage.path);
  } catch {
    // The stage cannot be inspected, so it is left alone.
  }
  const handle = stage.handle;
  stage.handle = -1;
  closeQuietly(handle);
}

/** Removes a file that was already checked. A file that is gone is not an error. */
function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // The stage is already gone.
  }
}

/**
 * Removes the record of one profile.
 *
 * The record is verified through an anchored handle, and its name must still
 * refer to that file before it is unlinked. A symbolic link or a foreign file
 * is never removed.
 */
function removeRecord(store: number, name: string): boolean {
  const path = anchoredPath(store, name);
  const handle = openOrNull(path, RECORD_FLAGS);
  if (handle === null) return false;
  return withHandle(handle, () => {
    const stat = statHandle(handle);
    assertOwnerOnlyRecord(stat);
    assertIdentityAt(path, identityOf(stat));
    attempt(() => unlinkSync(path));
    attempt(() => fsyncSync(store));
    return true;
  });
}

/**
 * Runs an operation on a handle and closes the handle exactly once.
 *
 * A failure of the operation is reported as it is, and a close failure after
 * it is ignored. A close failure after a successful operation is reported.
 */
function withHandle<T>(handle: number, run: () => T): T {
  let result: T;
  try {
    result = run();
  } catch (error) {
    closeQuietly(handle);
    throw error;
  }
  closeHandle(handle);
  return result;
}

/** A record is a regular file of this user, owner-only and with a single link. */
function assertOwnerOnlyRecord(stat: Stats): void {
  if (!stat.isFile()) throw new AgentAuthError('FILE_UNSAFE');
  if (stat.uid !== currentUserId()) throw new AgentAuthError('FILE_UNSAFE');
  if ((stat.mode & 0o7777) !== FILE_MODE) throw new AgentAuthError('FILE_UNSAFE');
  if (stat.nlink !== 1) throw new AgentAuthError('FILE_UNSAFE');
}

/** A record never exceeds the bounded size of a metadata record. */
function assertBoundedRecord(size: number): void {
  if (size > MAX_METADATA_BYTES) throw new AgentAuthError('PROFILE_CORRUPT');
}

/** The identity of a filesystem object. */
function identityOf(stat: Stats): Identity {
  return { device: stat.dev, inode: stat.ino };
}

/**
 * Whether an entry is the object with the expected identity.
 *
 * An absent entry matches only an absent expectation. An expectation of null
 * means the name must not exist.
 */
function matchesIdentity(stat: Stats | null, expected: Identity | null): boolean {
  if (expected === null) return stat === null;
  return stat !== null && stat.dev === expected.device && stat.ino === expected.inode;
}

/** Fails closed when the entry at a path is not the object with the expected identity. */
function assertIdentityAt(path: string, expected: Identity | null): void {
  if (!matchesIdentity(statOrNull(path), expected)) throw new AgentAuthError('FILE_UNSAFE');
}

/**
 * The state of an entry without following a symbolic link.
 *
 * An absent entry is null. Any other failure is unavailable.
 */
function statOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null;
    throw new AgentAuthError('FILE_UNAVAILABLE');
  }
}

/**
 * Opens an entry without following a symbolic link.
 *
 * An absent entry is null. A symbolic link, a path that is not a directory
 * when one is required, or a socket is unsafe. Any other failure is
 * unavailable.
 */
function openOrNull(path: string, flags: number): number | null {
  try {
    return openSync(path, flags);
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT') return null;
    if (UNSAFE_OPEN_CODES.has(code)) throw new AgentAuthError('FILE_UNSAFE');
    throw new AgentAuthError('FILE_UNAVAILABLE');
  }
}

/** The path of an entry, anchored through the handle of its directory. */
function anchoredPath(handle: number, name: string): string {
  return `${PROC_FD}/${handle}/${name}`;
}

/** Runs one system call whose failure is a fixed unavailable error. */
function attempt<T>(run: () => T): T {
  try {
    return run();
  } catch {
    throw new AgentAuthError('FILE_UNAVAILABLE');
  }
}

/** The state of an open handle, or an unavailable error. */
function statHandle(handle: number): Stats {
  return attempt(() => fstatSync(handle));
}

/** Closes a handle. A failed close is unavailable, and the handle is never closed twice by this module. */
function closeHandle(handle: number): void {
  attempt(() => closeSync(handle));
}

/** Closes a handle on an error path, where the first error must be the one that is reported. */
function closeQuietly(handle: number): void {
  try {
    closeSync(handle);
  } catch {
    // The handle is already gone.
  }
}

/** The owner of the local store: the user that runs this process. */
function currentUserId(): number {
  return process.getuid!();
}

/** The system error code of a failed system call, or an empty code when there is none. */
function errnoCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}
