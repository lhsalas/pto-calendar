import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type * as nodeFs from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentAuthError } from '../src/errors.js';
import { createProfileFiles, type ProfileFile } from '../src/profile-files.js';
import type { StoredProfile } from '../src/validation.js';

/*
 * Fault injection. Every `node:fs` call of the module under test goes through
 * this hook. A rule that is armed for a call is consumed by the first matching
 * call, and the test then observes the real behaviour of the real kernel around
 * the injected failure. No rule survives its test.
 */
const faults = vi.hoisted(() => {
  type Args = readonly unknown[];
  type Rule = {
    readonly call: string;
    readonly match: (args: Args) => boolean;
    readonly before?: (args: Args) => void;
    readonly error?: { readonly value: unknown; readonly afterCall: boolean };
    readonly after?: (result: unknown, args: Args) => unknown;
  };
  const rules: Rule[] = [];
  /*
   * The descriptors that the module opens and closes through the hooked calls.
   * A descriptor that is closed while it is already closed is a double close,
   * which the module must never do even when a close reports a failure.
   */
  const ledger = {
    open: new Set<number>(),
    closed: new Set<number>(),
    doubleClose: 0,
    opened(handle: number): void {
      this.closed.delete(handle);
      this.open.add(handle);
    },
    closing(handle: number): void {
      if (this.closed.has(handle)) this.doubleClose += 1;
      this.open.delete(handle);
      this.closed.add(handle);
    },
  };
  const take = (call: string, args: Args): Rule | undefined => {
    const index = rules.findIndex((rule) => rule.call === call && rule.match(args));
    return index < 0 ? undefined : rules.splice(index, 1)[0];
  };
  const hook =
    (call: string, original: (...args: unknown[]) => unknown) =>
    (...args: unknown[]): unknown => {
      const rule = take(call, args);
      if (rule === undefined) return original(...args);
      rule.before?.(args);
      // A close that fails still releases its descriptor, as on Linux.
      if (rule.error !== undefined && !rule.error.afterCall) throw rule.error.value;
      const result = original(...args);
      if (rule.error !== undefined) throw rule.error.value;
      return rule.after === undefined ? result : rule.after(result, args);
    };
  return { rules, hook, ledger };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFs>();
  const hook = <F>(name: string, original: F): F =>
    faults.hook(name, original as unknown as (...args: unknown[]) => unknown) as unknown as F;
  const openHooked = hook('openSync', actual.openSync) as unknown as (...args: unknown[]) => number;
  const closeHooked = hook('closeSync', actual.closeSync) as unknown as (handle: number) => void;
  return {
    ...actual,
    openSync: ((...args: unknown[]): number => {
      const handle = openHooked(...args);
      faults.ledger.opened(handle);
      return handle;
    }) as unknown as typeof actual.openSync,
    closeSync: ((handle: number): void => {
      faults.ledger.closing(handle);
      closeHooked(handle);
    }) as unknown as typeof actual.closeSync,
    existsSync: hook('existsSync', actual.existsSync),
    fchmodSync: hook('fchmodSync', actual.fchmodSync),
    fstatSync: hook('fstatSync', actual.fstatSync),
    fsyncSync: hook('fsyncSync', actual.fsyncSync),
    lstatSync: hook('lstatSync', actual.lstatSync),
    mkdirSync: hook('mkdirSync', actual.mkdirSync),
    readSync: hook('readSync', actual.readSync),
    renameSync: hook('renameSync', actual.renameSync),
    rmdirSync: hook('rmdirSync', actual.rmdirSync),
    unlinkSync: hook('unlinkSync', actual.unlinkSync),
    writeFileSync: hook('writeFileSync', actual.writeFileSync),
  };
});

/** A synthetic token that is never a real credential. */
const FAKE_TOKEN = `pto_pat_00000000-0000-4000-8000-000000000000.${'a'.repeat(64)}`;

/** A synthetic record that keeps its secret in the operating system store. */
const KEYRING_RECORD = {
  version: 1,
  profile: 'default',
  origin: 'https://api.example.com',
  allowLoopbackHttp: false,
  storage: 'keyring',
} as const;

/** A synthetic record that keeps its secret in the local file store. */
const FILE_RECORD = {
  version: 1,
  profile: 'default',
  origin: 'https://api.example.com',
  allowLoopbackHttp: false,
  storage: 'file',
  token: FAKE_TOKEN,
} as const;

/** A synthetic record of another profile. */
const OTHER_RECORD = { ...KEYRING_RECORD, profile: 'other' } as const;

/** The largest record that the adapter stores. */
const MAX_METADATA_BYTES = 4096;

const bases: string[] = [];

afterEach(() => {
  const unreached = faults.rules.length;
  const doubleClose = faults.ledger.doubleClose;
  const leaked = faults.ledger.open.size;
  faults.rules.length = 0;
  faults.ledger.open.clear();
  faults.ledger.closed.clear();
  faults.ledger.doubleClose = 0;
  vi.restoreAllMocks();
  while (bases.length > 0) {
    const base = bases.pop();
    if (base) rmSync(base, { recursive: true, force: true });
  }
  // Every test must close each descriptor it opened, exactly once.
  if (unreached > 0) throw new Error('an injected fault was never reached');
  if (doubleClose > 0) throw new Error('a descriptor was closed twice');
  if (leaked > 0) throw new Error(`${leaked} descriptor(s) were left open`);
});

/** A private base directory that only this user may enter. */
function createBase(): string {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'pto-260-files-'));
  bases.push(base);
  return base;
}

/** The store directory of a fresh base directory. */
function storePath(base: string): string {
  return join(base, 'store');
}

/** A store directory that already exists and is owner-only. */
function existingStore(base: string): string {
  const store = storePath(base);
  mkdirSync(store, { mode: 0o700 });
  chmodSync(store, 0o700);
  return store;
}

/** Writes a file of the store with the exact mode the store requires. */
function writeStoreFile(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** The error of a call that has to fail. */
function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('the call was expected to fail');
}

/** The error of a call that has to fail. */
async function captureAsyncError(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error('the call was expected to fail');
}

/** Asserts that a call fails with one fixed code and nothing else. */
function expectCode(run: () => unknown, code: string): void {
  const error = captureError(run);
  expect(error).toBeInstanceOf(AgentAuthError);
  expect((error as { code: string }).code).toBe(code);
}

/** Asserts that a call fails with one fixed code and nothing else. */
async function expectAsyncCode(run: Promise<unknown>, code: string): Promise<void> {
  const error = await captureAsyncError(run);
  expect(error).toBeInstanceOf(AgentAuthError);
  expect((error as { code: string }).code).toBe(code);
}

/** The number of descriptors that this process has open right now. */
function descriptorCount(): number {
  return readdirSync('/proc/self/fd').length;
}

/**
 * The path that each open descriptor refers to, as the kernel reports it. A
 * descriptor whose object was unlinked reads with the suffix " (deleted)": that
 * is the proof that the object is still pinned and its inode cannot be reused.
 */
function descriptorLinks(): string[] {
  const links: string[] = [];
  for (const entry of readdirSync('/proc/self/fd')) {
    try {
      links.push(readlinkSync(`/proc/self/fd/${entry}`));
    } catch {
      // The descriptor was closed after it was listed.
    }
  }
  return links;
}

/** The stage files that a store holds right now. A settled write leaves none, except where a test says so. */
function stagesIn(store: string): string[] {
  return readdirSync(store).filter((name) => name.startsWith('.stage.'));
}

/** The error that a failing system call reports, with its code. */
function systemError(code: string): Error {
  return Object.assign(new Error(`injected ${code}`), { code });
}

type Matcher = (args: readonly unknown[]) => boolean;

const anyCall: Matcher = () => true;

/** The path that a descriptor refers to, or an empty path when it cannot be read. */
function descriptorPath(handle: number): string {
  try {
    return readlinkSync(`/proc/self/fd/${handle}`);
  } catch {
    return '';
  }
}

/** Matches a call whose argument at `index` is a path that ends with the suffix. */
function pathEnds(suffix: string, index = 0): Matcher {
  return (args) => {
    const value = args[index];
    return typeof value === 'string' && value.endsWith(suffix);
  };
}

/** Matches a call whose first argument is a path that contains the text. */
function pathHas(text: string): Matcher {
  return (args) => {
    const value = args[0];
    return typeof value === 'string' && value.includes(text);
  };
}

/** Matches a call whose first argument is a descriptor that refers to a path ending with the suffix. */
function handleEnds(suffix: string): Matcher {
  return (args) => {
    const value = args[0];
    return typeof value === 'number' && descriptorPath(value).endsWith(suffix);
  };
}

/** Matches a call whose first argument is a descriptor that refers to a path containing the text. */
function handleHas(text: string): Matcher {
  return (args) => {
    const value = args[0];
    return typeof value === 'number' && descriptorPath(value).includes(text);
  };
}

/** Matches a call whose first argument is a descriptor that refers exactly to the path. */
function handleIs(path: string): Matcher {
  return (args) => {
    const value = args[0];
    return typeof value === 'number' && descriptorPath(value) === path;
  };
}

/** Makes the next matching call fail before it runs, with a system error code. */
function failNext(call: string, code: string, match: Matcher = anyCall): void {
  faults.rules.push({ call, match, error: { value: systemError(code), afterCall: false } });
}

/** Makes the next matching call fail without a system error code. */
function failNextWithoutCode(call: string, match: Matcher = anyCall): void {
  faults.rules.push({
    call,
    match,
    error: { value: new Error('no system code'), afterCall: false },
  });
}

/** Makes the next matching close run and then fail, as a failing close does on Linux. */
function failClosingNext(call: string, code: string, match: Matcher = anyCall): void {
  faults.rules.push({ call, match, error: { value: systemError(code), afterCall: true } });
}

/** Runs a hook right before the next matching call, which then runs normally. */
function beforeNext(
  call: string,
  before: (args: readonly unknown[]) => void,
  match: Matcher = anyCall,
): void {
  faults.rules.push({ call, match, before });
}

/** Changes the result of the next matching call. */
function afterNext(
  call: string,
  after: (result: unknown, args: readonly unknown[]) => unknown,
  match: Matcher = anyCall,
): void {
  faults.rules.push({ call, match, after });
}

/** A child process that takes the lock of a profile and holds it. */
const LOCK_HOLDER = [
  "const fs = require('node:fs');",
  'const store = process.argv[1];',
  "fs.mkdirSync(store + '/.lock.default', { mode: 0o700 });",
  "process.stdout.write('ready\\n');",
  "process.stdin.once('data', () => {",
  "  fs.rmdirSync(store + '/.lock.default');",
  '  process.exit(0);',
  '});',
].join('\n');

/** Waits until a child process writes one marker. */
function waitForMarker(child: ChildProcess, marker: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let seen = '';
    const cleanup = (): void => {
      child.stdout?.off('data', onData);
      child.off('error', onError);
    };
    const onData = (chunk: Buffer): void => {
      seen += chunk.toString('utf8');
      if (seen.includes(marker)) {
        cleanup();
        resolve();
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    child.stdout?.on('data', onData);
    child.on('error', onError);
  });
}

/** Waits until a child process is gone. */
function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
}

describe('the local profile store', () => {
  describe('the trusted directory', () => {
    it('refuses a directory that is not one exact absolute path', () => {
      for (const invalid of [
        '',
        'relative/path',
        'a/b',
        '/',
        '/a/../b',
        '/a/./b',
        '/a//b',
        '/a/b/',
        '/a/\0b',
      ]) {
        expectCode(() => createProfileFiles(invalid), 'INVALID_OPTIONS');
      }
      expectCode(() => createProfileFiles(undefined as unknown as string), 'INVALID_OPTIONS');
    });

    it('refuses a platform this adapter is not written for', () => {
      const original = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      try {
        expectCode(() => createProfileFiles('/tmp/pto-260-files'), 'FILE_UNAVAILABLE');
      } finally {
        if (original) Object.defineProperty(process, 'platform', original);
      }
    });

    it('refuses a host without the procfs descriptor directory', () => {
      afterNext('existsSync', () => false, pathEnds('/proc/self/fd'));

      expectCode(() => createProfileFiles('/tmp/pto-260-files'), 'FILE_UNAVAILABLE');
    });

    it('creates the store directory owner-only', async () => {
      const base = createBase();
      const store = storePath(base);
      const files = createProfileFiles(store);

      await expect(files.withProfile('default', true, async () => 'ready')).resolves.toBe('ready');

      const stat = statSync(store);
      expect(stat.isDirectory()).toBe(true);
      expect(stat.mode & 0o7777).toBe(0o700);
      expect(stat.uid).toBe(process.getuid!());
    });

    it('creates owner-only directories and files under a restrictive umask', async () => {
      const base = createBase();
      const store = join(base, 'store');
      const files = createProfileFiles(store);
      // With this umask a plain mkdir or open would drop the owner bits, so the modes
      // must be set through the handles that were just created.
      const previous = process.umask(0o277);
      try {
        await files.withProfile('default', true, async (file) => {
          await file.write(KEYRING_RECORD);
        });
      } finally {
        process.umask(previous);
      }

      expect(statSync(store).mode & 0o7777).toBe(0o700);
      expect(statSync(join(store, 'default.json')).mode & 0o7777).toBe(0o600);
    });

    it('creates missing ancestors owner-only, each through its own handle', async () => {
      const base = createBase();
      const store = join(base, 'one', 'two', 'store');
      const files = createProfileFiles(store);

      await files.withProfile('default', true, async () => 'ready');

      for (const path of [join(base, 'one'), join(base, 'one', 'two'), store]) {
        expect(statSync(path).mode & 0o7777).toBe(0o700);
      }
    });

    it('refuses a store directory that other users may enter', async () => {
      const base = createBase();
      const store = storePath(base);
      mkdirSync(store, { mode: 0o700 });
      chmodSync(store, 0o755);
      const files = createProfileFiles(store);

      await expectAsyncCode(
        files.withProfile('default', false, async () => 'ready'),
        'FILE_UNSAFE',
      );
    });

    it('refuses a store directory that belongs to another user', async () => {
      const base = createBase();
      const store = storePath(base);
      mkdirSync(store, { mode: 0o700 });
      const files = createProfileFiles(store);
      vi.spyOn(process, 'getuid').mockReturnValue(424242);

      await expectAsyncCode(
        files.withProfile('default', false, async () => 'ready'),
        'FILE_UNSAFE',
      );
    });

    it('refuses a store directory owned by another user while its ancestors are trusted', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const before = descriptorCount();
      afterNext(
        'fstatSync',
        (stat) => ({ ...(stat as nodeFs.Stats), uid: 424242 }),
        handleIs(store),
      );

      await expectAsyncCode(
        files.withProfile('default', false, async () => 'ready'),
        'FILE_UNSAFE',
      );
      expect(descriptorCount()).toBe(before);
    });

    it('refuses a store directory that is a symlink', async () => {
      const base = createBase();
      const target = join(base, 'real');
      mkdirSync(target, { mode: 0o700 });
      symlinkSync(target, storePath(base));
      const files = createProfileFiles(storePath(base));

      await expectAsyncCode(
        files.withProfile('default', false, async () => 'ready'),
        'FILE_UNSAFE',
      );
    });

    it('refuses an ancestor that is a symlink', async () => {
      const base = createBase();
      const target = join(base, 'real');
      mkdirSync(target, { mode: 0o700 });
      const link = join(base, 'link');
      symlinkSync(target, link);
      const files = createProfileFiles(join(link, 'store'));

      await expectAsyncCode(
        files.withProfile('default', false, async () => 'ready'),
        'FILE_UNSAFE',
      );
    });

    it('refuses an ancestor that other users may replace', async () => {
      const base = createBase();
      chmodSync(base, 0o777);
      const files = createProfileFiles(storePath(base));

      await expectAsyncCode(
        files.withProfile('default', false, async () => 'ready'),
        'FILE_UNSAFE',
      );
    });

    it('accepts a sticky ancestor that other users may write', async () => {
      const base = createBase();
      chmodSync(base, 0o1777);
      const files = createProfileFiles(storePath(base));

      await expect(files.withProfile('default', true, async () => 'ready')).resolves.toBe('ready');
    });

    it('refuses a sticky ancestor that belongs to another user', async () => {
      const base = createBase();
      chmodSync(base, 0o1777);
      const files = createProfileFiles(storePath(base));
      afterNext(
        'fstatSync',
        (stat) => ({ ...(stat as nodeFs.Stats), uid: 424242 }),
        handleIs(base),
      );

      await expectAsyncCode(
        files.withProfile('default', false, async () => 'ready'),
        'FILE_UNSAFE',
      );
    });

    it('accepts a root-owned sticky ancestor, like a shared temporary directory', async () => {
      const base = createBase();
      const files = createProfileFiles(storePath(base));
      afterNext(
        'fstatSync',
        (stat) => ({ ...(stat as nodeFs.Stats), uid: 0, mode: 0o41777 }),
        handleIs(base),
      );

      await expect(files.withProfile('default', true, async () => 'ready')).resolves.toBe('ready');
    });

    it('refuses an ancestor that other users may write without the sticky bit', async () => {
      const base = createBase();
      chmodSync(base, 0o770);
      const files = createProfileFiles(storePath(base));

      await expectAsyncCode(
        files.withProfile('default', false, async () => 'ready'),
        'FILE_UNSAFE',
      );
    });

    it('refuses an ancestor that cannot be read', async () => {
      const base = createBase();
      const locked = join(base, 'locked');
      mkdirSync(locked, { mode: 0o300 });
      const files = createProfileFiles(join(locked, 'store'));

      try {
        await expectAsyncCode(
          files.withProfile('default', false, async () => 'ready'),
          'FILE_UNAVAILABLE',
        );
      } finally {
        chmodSync(locked, 0o700);
      }
    });

    it('refuses a store that cannot be created', async () => {
      const base = createBase();
      const locked = join(base, 'locked');
      mkdirSync(locked, { mode: 0o500 });
      const files = createProfileFiles(join(locked, 'store'));

      try {
        await expectAsyncCode(
          files.withProfile('default', true, async () => 'ready'),
          'FILE_UNAVAILABLE',
        );
      } finally {
        chmodSync(locked, 0o700);
      }
    });

    it('refuses an ancestor that is a regular file', async () => {
      const base = createBase();
      writeStoreFile(join(base, 'plain'), 'not a directory');
      const files = createProfileFiles(join(base, 'plain', 'store'));

      await expectAsyncCode(
        files.withProfile('default', true, async () => 'ready'),
        'FILE_UNSAFE',
      );
    });

    it('refuses a store path that is a regular file', async () => {
      const base = createBase();
      writeStoreFile(storePath(base), 'not a directory');
      const files = createProfileFiles(storePath(base));

      await expectAsyncCode(
        files.withProfile('default', false, async () => 'ready'),
        'FILE_UNSAFE',
      );
      await expectAsyncCode(
        files.withProfile('default', true, async () => 'ready'),
        'FILE_UNSAFE',
      );
    });

    it('treats a missing store directory as absent', async () => {
      const base = createBase();
      const store = storePath(base);
      const files = createProfileFiles(store);

      await files.withProfile('default', false, async (file) => {
        await expect(file.read()).resolves.toBeNull();
        await expect(file.remove()).resolves.toBe(false);
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNAVAILABLE');
      });

      expect(existsSync(store)).toBe(false);
    });

    it('treats a missing ancestor as absent and creates nothing', async () => {
      const base = createBase();
      const files = createProfileFiles(join(base, 'missing', 'store'));

      await files.withProfile('default', false, async (file) => {
        await expect(file.read()).resolves.toBeNull();
      });

      expect(existsSync(join(base, 'missing'))).toBe(false);
    });

    it('adopts a store that another process creates first', async () => {
      const base = createBase();
      const store = storePath(base);
      const files = createProfileFiles(store);
      beforeNext(
        'mkdirSync',
        (args) => {
          mkdirSync(args[0] as string, { mode: 0o700 });
        },
        pathEnds('/store'),
      );

      await expect(files.withProfile('default', true, async () => 'ready')).resolves.toBe('ready');
      expect(statSync(store).mode & 0o7777).toBe(0o700);
    });

    it('refuses a store that another process creates with other permissions', async () => {
      const base = createBase();
      const files = createProfileFiles(storePath(base));
      beforeNext(
        'mkdirSync',
        (args) => {
          // The mode is set explicitly, so the process umask does not change the case.
          mkdirSync(args[0] as string, { mode: 0o755 });
          chmodSync(args[0] as string, 0o755);
        },
        pathEnds('/store'),
      );

      await expectAsyncCode(
        files.withProfile('default', true, async () => 'ready'),
        'FILE_UNSAFE',
      );
    });

    it('never changes the mode of a directory that a substituted name points to', async () => {
      const base = createBase();
      const victim = join(base, 'victim');
      mkdirSync(victim, { mode: 0o755 });
      chmodSync(victim, 0o755);
      const files = createProfileFiles(storePath(base));
      // A path-based chmod after mkdir would follow this link and change the victim.
      afterNext(
        'mkdirSync',
        (result, args) => {
          const created = args[0] as string;
          rmdirSync(created);
          symlinkSync(victim, created);
          return result;
        },
        pathEnds('/store'),
      );

      await expectAsyncCode(
        files.withProfile('default', true, async () => 'ready'),
        'FILE_UNSAFE',
      );
      expect(statSync(victim).mode & 0o7777).toBe(0o755);
    });

    it('refuses a store that vanishes right after it was created', async () => {
      const base = createBase();
      const files = createProfileFiles(storePath(base));
      const before = descriptorCount();
      afterNext(
        'mkdirSync',
        (result, args) => {
          rmdirSync(args[0] as string);
          return result;
        },
        pathEnds('/store'),
      );

      await expectAsyncCode(
        files.withProfile('default', true, async () => 'ready'),
        'FILE_UNAVAILABLE',
      );
      expect(descriptorCount()).toBe(before);
    });

    it('reports a store that cannot be created for another reason as unavailable', async () => {
      const base = createBase();
      const files = createProfileFiles(storePath(base));
      failNext('mkdirSync', 'EIO', pathEnds('/store'));

      await expectAsyncCode(
        files.withProfile('default', true, async () => 'ready'),
        'FILE_UNAVAILABLE',
      );
    });

    it('releases the handle of a created store that cannot be set owner-only', async () => {
      const base = createBase();
      const files = createProfileFiles(storePath(base));
      const before = descriptorCount();
      failNext('fchmodSync', 'EIO', handleEnds('/store'));

      await expectAsyncCode(
        files.withProfile('default', true, async () => 'ready'),
        'FILE_UNAVAILABLE',
      );
      expect(descriptorCount()).toBe(before);
    });

    it('maps a failure to open the root as unavailable', async () => {
      const base = createBase();
      const files = createProfileFiles(storePath(base));
      failNext('openSync', 'EIO', (args) => args[0] === '/');

      await expectAsyncCode(
        files.withProfile('default', false, async () => 'ready'),
        'FILE_UNAVAILABLE',
      );
    });

    it('maps a failure to inspect an ancestor as unavailable and releases every handle', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const before = descriptorCount();
      failNext('fstatSync', 'EIO', handleIs(base));

      await expectAsyncCode(
        files.withProfile('default', false, async () => 'ready'),
        'FILE_UNAVAILABLE',
      );
      expect(descriptorCount()).toBe(before);
    });

    it('maps a failure to close an ancestor as unavailable and releases the child', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const before = descriptorCount();
      failClosingNext('closeSync', 'EIO', handleIs('/'));

      await expectAsyncCode(
        files.withProfile('default', false, async () => 'ready'),
        'FILE_UNAVAILABLE',
      );
      expect(descriptorCount()).toBe(before);
    });

    it('releases the store handle when the store fails the owner check', async () => {
      const base = createBase();
      const store = existingStore(base);
      chmodSync(store, 0o755);
      const files = createProfileFiles(store);
      const before = descriptorCount();

      await expectAsyncCode(
        files.withProfile('default', false, async () => 'ready'),
        'FILE_UNSAFE',
      );
      expect(descriptorCount()).toBe(before);
    });

    it('releases the store handle when the store cannot be inspected', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const before = descriptorCount();
      failNext('fstatSync', 'EIO', handleIs(store));

      await expectAsyncCode(
        files.withProfile('default', false, async () => 'ready'),
        'FILE_UNAVAILABLE',
      );
      expect(descriptorCount()).toBe(before);
    });

    it('refuses a profile name that is not a safe name', async () => {
      const base = createBase();
      const files = createProfileFiles(storePath(base));

      for (const invalid of ['', 'Upper', 'a/b', '..', '-leading', 'x'.repeat(33)]) {
        await expectAsyncCode(
          files.withProfile(invalid, false, async () => 'ready'),
          'INVALID_PROFILE',
        );
      }
      expect(existsSync(storePath(base))).toBe(false);
    });

    it('refuses a callback or a create flag that is not usable', async () => {
      const base = createBase();
      const files = createProfileFiles(storePath(base));

      await expectAsyncCode(
        files.withProfile('default', false, undefined as unknown as () => Promise<void>),
        'INVALID_OPTIONS',
      );
      await expectAsyncCode(
        files.withProfile('default', 'yes' as unknown as boolean, async () => 'ready'),
        'INVALID_OPTIONS',
      );
    });
  });

  describe('the stored record', () => {
    it('stores and reads a record that keeps its secret elsewhere', async () => {
      const base = createBase();
      const store = storePath(base);
      const files = createProfileFiles(store);

      await files.withProfile('default', true, async (file) => {
        await file.write(KEYRING_RECORD);
        await expect(file.read()).resolves.toEqual(KEYRING_RECORD);
      });

      const stat = statSync(join(store, 'default.json'));
      expect(stat.mode & 0o7777).toBe(0o600);
      expect(stat.uid).toBe(process.getuid!());
      expect(readdirSync(store)).toEqual(['default.json']);
    });

    it('stores and reads a record that keeps its secret in the file', async () => {
      const base = createBase();
      const store = storePath(base);
      const files = createProfileFiles(store);

      await files.withProfile('default', true, async (file) => {
        await file.write(FILE_RECORD);
        await expect(file.read()).resolves.toEqual(FILE_RECORD);
      });

      const stored = JSON.parse(readFileSync(join(store, 'default.json'), 'utf8')) as unknown;
      expect(stored).toEqual(FILE_RECORD);
    });

    it('replaces a record without leaving a stage file behind', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);

      await files.withProfile('default', true, async (file) => {
        await file.write(KEYRING_RECORD);
        await file.write(FILE_RECORD);
        await expect(file.read()).resolves.toEqual(FILE_RECORD);
      });

      expect(readdirSync(store)).toEqual(['default.json']);
      const stored = JSON.parse(readFileSync(join(store, 'default.json'), 'utf8')) as unknown;
      expect(stored).toEqual(FILE_RECORD);
    });

    it('replaces one record and leaves a sibling record byte-identical', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const sibling = join(store, 'other.json');
      writeStoreFile(sibling, JSON.stringify(OTHER_RECORD));
      const content = readFileSync(sibling);
      const inode = lstatSync(sibling).ino;

      await files.withProfile('default', true, async (file) => {
        await file.write(FILE_RECORD);
      });

      expect(readFileSync(sibling).equals(content)).toBe(true);
      expect(lstatSync(sibling).ino).toBe(inode);
      expect(readdirSync(store).sort()).toEqual(['default.json', 'other.json']);
    });

    it('reads nothing when the profile has no record', async () => {
      const base = createBase();
      const files = createProfileFiles(storePath(base));

      await files.withProfile('default', true, async (file) => {
        await expect(file.read()).resolves.toBeNull();
      });
    });

    it('refuses a record that is not valid JSON', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), 'not a record');

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.read(), 'PROFILE_CORRUPT');
      });
    });

    it('refuses a record that is not a valid profile', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), JSON.stringify({ nope: true }));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.read(), 'PROFILE_CORRUPT');
      });
    });

    it('refuses a record that belongs to another profile', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(
        join(store, 'default.json'),
        JSON.stringify({ ...KEYRING_RECORD, profile: 'other' }),
      );

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.read(), 'PROFILE_CORRUPT');
      });
    });

    it('refuses a record that is larger than the bounded size', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), 'x'.repeat(5000));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.read(), 'PROFILE_CORRUPT');
      });
    });

    it('accepts a record of exactly the bounded size', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const record = JSON.stringify(KEYRING_RECORD);
      writeStoreFile(
        join(store, 'default.json'),
        `${record}${' '.repeat(MAX_METADATA_BYTES - record.length)}`,
      );

      await files.withProfile('default', true, async (file) => {
        await expect(file.read()).resolves.toEqual(KEYRING_RECORD);
      });
    });

    it('refuses a record one byte beyond the bounded size', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const record = JSON.stringify(KEYRING_RECORD);
      writeStoreFile(
        join(store, 'default.json'),
        `${record}${' '.repeat(MAX_METADATA_BYTES + 1 - record.length)}`,
      );

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.read(), 'PROFILE_CORRUPT');
      });
    });

    it('reads a record that the system returns in pieces', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), JSON.stringify(KEYRING_RECORD));
      afterNext('readSync', (count) => Math.min(count as number, 3), handleEnds('/default.json'));

      await files.withProfile('default', true, async (file) => {
        await expect(file.read()).resolves.toEqual(KEYRING_RECORD);
      });
    });

    it('never puts the content of a record into an error', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), `{"token":"${FAKE_TOKEN}"`);

      await files.withProfile('default', true, async (file) => {
        const error = await captureAsyncError(file.read());
        expect((error as { code: string }).code).toBe('PROFILE_CORRUPT');
        expect(String((error as Error).message)).not.toContain(FAKE_TOKEN);
        expect(JSON.stringify(error)).not.toContain(FAKE_TOKEN);
      });
    });

    it('refuses a record that other users may read', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), JSON.stringify(KEYRING_RECORD));
      chmodSync(join(store, 'default.json'), 0o644);

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.read(), 'FILE_UNSAFE');
      });
    });

    it('refuses a record that cannot be read', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), JSON.stringify(KEYRING_RECORD));
      chmodSync(join(store, 'default.json'), 0o200);

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.read(), 'FILE_UNAVAILABLE');
      });
    });

    it('refuses a record that belongs to another user', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), JSON.stringify(KEYRING_RECORD));

      await files.withProfile('default', true, async (file) => {
        vi.spyOn(process, 'getuid').mockReturnValue(424242);
        await expectAsyncCode(file.read(), 'FILE_UNSAFE');
      });
    });

    it('refuses a record with more than one link', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), JSON.stringify(KEYRING_RECORD));
      linkSync(join(store, 'default.json'), join(store, 'copy.json'));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.read(), 'FILE_UNSAFE');
      });
    });

    it('refuses a record that is not a regular file', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      mkdirSync(join(store, 'default.json'), { mode: 0o700 });

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.read(), 'FILE_UNSAFE');
      });
    });

    it('refuses a record that is a symlink', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      symlinkSync('/etc/hostname', join(store, 'default.json'));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.read(), 'FILE_UNSAFE');
      });
    });

    it('refuses a record that is a FIFO, and never waits for a writer', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const path = join(store, 'default.json');
      execFileSync('mkfifo', [path]);

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.read(), 'FILE_UNSAFE');
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNSAFE');
        await expectAsyncCode(file.remove(), 'FILE_UNSAFE');
      });

      expect(lstatSync(path).isFIFO()).toBe(true);
    });

    it('refuses a record that is a socket, and leaves it alone', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const path = join(store, 'default.json');
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, () => resolve());
      });

      try {
        await files.withProfile('default', true, async (file) => {
          await expectAsyncCode(file.read(), 'FILE_UNSAFE');
          await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNSAFE');
          await expectAsyncCode(file.remove(), 'FILE_UNSAFE');
        });
        expect(lstatSync(path).isSocket()).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('reports a record that cannot be opened for another reason as unavailable', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), JSON.stringify(KEYRING_RECORD));
      failNext('openSync', 'EIO', pathEnds('/default.json'));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.read(), 'FILE_UNAVAILABLE');
      });
    });

    it('reports a failure without a system code as unavailable, never as an absent record', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      failNextWithoutCode('openSync', pathEnds('/default.json'));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.read(), 'FILE_UNAVAILABLE');
      });
    });

    it('reports a record that cannot be inspected as unavailable and releases its handle', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), JSON.stringify(KEYRING_RECORD));
      const before = descriptorCount();
      failNext('fstatSync', 'EIO', handleEnds('/default.json'));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.read(), 'FILE_UNAVAILABLE');
      });
      expect(descriptorCount()).toBe(before);
    });

    it('reports a record that cannot be read as unavailable and releases its handle', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), JSON.stringify(KEYRING_RECORD));
      const before = descriptorCount();
      failNext('readSync', 'EIO', handleEnds('/default.json'));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.read(), 'FILE_UNAVAILABLE');
      });
      expect(descriptorCount()).toBe(before);
    });

    it('reports a record that cannot be closed after a valid read as unavailable', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), JSON.stringify(KEYRING_RECORD));
      const before = descriptorCount();
      failClosingNext('closeSync', 'EIO', handleEnds('/default.json'));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.read(), 'FILE_UNAVAILABLE');
      });
      expect(descriptorCount()).toBe(before);
    });

    it('keeps the corrupt verdict when a corrupt record cannot be closed', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), 'not a record');
      failClosingNext('closeSync', 'EIO', handleEnds('/default.json'));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.read(), 'PROFILE_CORRUPT');
      });
    });

    it('removes a record and leaves the other records alone', async () => {
      const base = createBase();
      const store = storePath(base);
      const files = createProfileFiles(store);

      await files.withProfile('default', true, async (file) => {
        await file.write(KEYRING_RECORD);
        await files.withProfile('other', false, async (other) => {
          await other.write({ ...KEYRING_RECORD, profile: 'other' });
        });
        await expect(file.remove()).resolves.toBe(true);
        await expect(file.read()).resolves.toBeNull();
      });

      expect(existsSync(join(store, 'other.json'))).toBe(true);
      expect(existsSync(join(store, 'default.json'))).toBe(false);
    });

    it('removes nothing when the profile has no record', async () => {
      const base = createBase();
      const files = createProfileFiles(storePath(base));

      await files.withProfile('default', true, async (file) => {
        await expect(file.remove()).resolves.toBe(false);
      });
    });

    it('refuses to remove a record that cannot be read', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), JSON.stringify(KEYRING_RECORD));
      chmodSync(join(store, 'default.json'), 0o200);

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.remove(), 'FILE_UNAVAILABLE');
      });

      expect(existsSync(join(store, 'default.json'))).toBe(true);
    });

    it('refuses to remove a record that is a symlink', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      symlinkSync('/etc/hostname', join(store, 'default.json'));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.remove(), 'FILE_UNSAFE');
      });

      expect(lstatSync(join(store, 'default.json')).isSymbolicLink()).toBe(true);
    });

    it('refuses to remove a record with more than one link and keeps every link', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), JSON.stringify(KEYRING_RECORD));
      linkSync(join(store, 'default.json'), join(store, 'copy.json'));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.remove(), 'FILE_UNSAFE');
      });

      expect(existsSync(join(store, 'default.json'))).toBe(true);
      expect(existsSync(join(store, 'copy.json'))).toBe(true);
    });

    it('refuses to remove a record that belongs to another user', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), JSON.stringify(KEYRING_RECORD));

      await files.withProfile('default', true, async (file) => {
        vi.spyOn(process, 'getuid').mockReturnValue(424242);
        await expectAsyncCode(file.remove(), 'FILE_UNSAFE');
      });

      expect(existsSync(join(store, 'default.json'))).toBe(true);
    });

    it('refuses to remove a record that other users may read', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), JSON.stringify(KEYRING_RECORD));
      chmodSync(join(store, 'default.json'), 0o644);

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.remove(), 'FILE_UNSAFE');
      });

      expect(existsSync(join(store, 'default.json'))).toBe(true);
    });

    it('refuses to remove a record that another process replaced after it was opened', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const path = join(store, 'default.json');
      writeStoreFile(path, JSON.stringify(KEYRING_RECORD));
      beforeNext(
        'lstatSync',
        () => {
          unlinkSync(path);
          writeStoreFile(path, JSON.stringify(FILE_RECORD));
        },
        pathEnds('/default.json'),
      );

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.remove(), 'FILE_UNSAFE');
      });

      expect(readFileSync(path, 'utf8')).toBe(JSON.stringify(FILE_RECORD));
    });

    it('reports a record that cannot be inspected for removal as unavailable', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), JSON.stringify(KEYRING_RECORD));
      const before = descriptorCount();
      failNext('fstatSync', 'EIO', handleEnds('/default.json'));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.remove(), 'FILE_UNAVAILABLE');
      });

      expect(existsSync(join(store, 'default.json'))).toBe(true);
      expect(descriptorCount()).toBe(before);
    });

    it('reports a record that cannot be unlinked as unavailable', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), JSON.stringify(KEYRING_RECORD));
      failNext('unlinkSync', 'EIO', pathEnds('/default.json'));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.remove(), 'FILE_UNAVAILABLE');
      });

      expect(existsSync(join(store, 'default.json'))).toBe(true);
    });

    it('reports a failed flush after a removal as unavailable, with the record gone', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), JSON.stringify(KEYRING_RECORD));
      failNext('fsyncSync', 'EIO', handleIs(store));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.remove(), 'FILE_UNAVAILABLE');
      });

      expect(existsSync(join(store, 'default.json'))).toBe(false);
    });

    it('cleans up its stage file when a write fails', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      mkdirSync(join(store, 'default.json'), { mode: 0o700 });

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNSAFE');
      });

      expect(stagesIn(store)).toEqual([]);
      expect(statSync(join(store, 'default.json')).isDirectory()).toBe(true);
    });

    it('refuses to store a value that is not a valid profile', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);

      await files.withProfile('default', true, async (file) => {
        const invalid = { ...KEYRING_RECORD, origin: 'http://example.com' } as StoredProfile;
        await expectAsyncCode(file.write(invalid), 'PROFILE_CORRUPT');
      });

      expect(readdirSync(store)).toEqual([]);
    });

    it('refuses to write when the store cannot hold a stage file', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);

      await files.withProfile('default', false, async (file) => {
        chmodSync(store, 0o500);
        try {
          await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNAVAILABLE');
        } finally {
          chmodSync(store, 0o700);
        }
      });

      expect(stagesIn(store)).toEqual([]);
      expect(existsSync(join(store, 'default.json'))).toBe(false);
    });

    it('refuses to remove a record when the store cannot be written', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), JSON.stringify(KEYRING_RECORD));

      await files.withProfile('default', false, async (file) => {
        chmodSync(store, 0o500);
        try {
          await expectAsyncCode(file.remove(), 'FILE_UNAVAILABLE');
        } finally {
          chmodSync(store, 0o700);
        }
      });

      expect(existsSync(join(store, 'default.json'))).toBe(true);
    });
  });

  describe('the replacement of a record', () => {
    it('refuses to replace a symbolic link and leaves its target alone', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const target = join(base, 'elsewhere.json');
      writeStoreFile(target, 'keep me');
      symlinkSync(target, join(store, 'default.json'));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNSAFE');
      });

      expect(readFileSync(target, 'utf8')).toBe('keep me');
      expect(lstatSync(join(store, 'default.json')).isSymbolicLink()).toBe(true);
      expect(stagesIn(store)).toEqual([]);
    });

    it('refuses to replace a hard link and leaves the other link intact', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const outside = join(base, 'outside.json');
      writeStoreFile(join(store, 'default.json'), JSON.stringify(FILE_RECORD));
      linkSync(join(store, 'default.json'), outside);

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNSAFE');
      });

      expect(readFileSync(outside, 'utf8')).toBe(JSON.stringify(FILE_RECORD));
      expect(stagesIn(store)).toEqual([]);
    });

    it('refuses to replace a record that belongs to another user', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), JSON.stringify(FILE_RECORD));

      await files.withProfile('default', true, async (file) => {
        vi.spyOn(process, 'getuid').mockReturnValue(424242);
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNSAFE');
      });

      expect(readFileSync(join(store, 'default.json'), 'utf8')).toBe(JSON.stringify(FILE_RECORD));
    });

    it('refuses to replace a record that other users may read', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), JSON.stringify(FILE_RECORD));
      chmodSync(join(store, 'default.json'), 0o644);

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNSAFE');
      });

      expect(readFileSync(join(store, 'default.json'), 'utf8')).toBe(JSON.stringify(FILE_RECORD));
    });

    it('refuses to replace a corrupt record and keeps its content', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), 'not a record');

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'PROFILE_CORRUPT');
      });

      expect(readFileSync(join(store, 'default.json'), 'utf8')).toBe('not a record');
      expect(stagesIn(store)).toEqual([]);
    });

    it('refuses to replace a record of another profile', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), JSON.stringify(OTHER_RECORD));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'PROFILE_CORRUPT');
      });

      expect(readFileSync(join(store, 'default.json'), 'utf8')).toBe(JSON.stringify(OTHER_RECORD));
    });

    it('refuses to replace a record that another process swapped in after it was admitted', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const path = join(store, 'default.json');
      writeStoreFile(path, JSON.stringify(FILE_RECORD));
      beforeNext(
        'writeFileSync',
        () => {
          unlinkSync(path);
          writeStoreFile(path, JSON.stringify(KEYRING_RECORD));
        },
        handleHas('.stage.'),
      );

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(FILE_RECORD), 'FILE_UNSAFE');
      });

      expect(readFileSync(path, 'utf8')).toBe(JSON.stringify(KEYRING_RECORD));
      expect(stagesIn(store)).toEqual([]);
    });

    it('refuses to create a record that appeared after it was admitted as absent', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const path = join(store, 'default.json');
      beforeNext(
        'writeFileSync',
        () => {
          writeStoreFile(path, JSON.stringify(FILE_RECORD));
        },
        handleHas('.stage.'),
      );

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNSAFE');
      });

      expect(readFileSync(path, 'utf8')).toBe(JSON.stringify(FILE_RECORD));
      expect(stagesIn(store)).toEqual([]);
    });

    it('refuses to replace a record that was removed after it was admitted', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const path = join(store, 'default.json');
      writeStoreFile(path, JSON.stringify(FILE_RECORD));
      beforeNext(
        'writeFileSync',
        () => {
          unlinkSync(path);
        },
        handleHas('.stage.'),
      );

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNSAFE');
      });

      expect(existsSync(path)).toBe(false);
      expect(stagesIn(store)).toEqual([]);
    });

    it('refuses to rename a stage that was swapped before the rename, and keeps the decoy', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      beforeNext(
        'fsyncSync',
        () => {
          const [stage] = stagesIn(store);
          renameSync(join(store, stage!), join(base, 'moved.tmp'));
          writeStoreFile(join(store, stage!), 'decoy');
        },
        handleHas('.stage.'),
      );

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNSAFE');
      });

      expect(existsSync(join(store, 'default.json'))).toBe(false);
      expect(stagesIn(store)).toHaveLength(1);
      expect(readFileSync(join(store, stagesIn(store)[0]!), 'utf8')).toBe('decoy');
    });

    it('refuses a record whose target is replaced after the rename', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      afterNext(
        'renameSync',
        (result, args) => {
          const target = args[1] as string;
          unlinkSync(target);
          writeStoreFile(target, 'decoy');
          return result;
        },
        pathEnds('/default.json', 1),
      );

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNSAFE');
      });

      expect(readFileSync(join(store, 'default.json'), 'utf8')).toBe('decoy');
      expect(stagesIn(store)).toEqual([]);
    });

    it('reports a failed rename as unavailable and removes its stage', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), JSON.stringify(FILE_RECORD));
      failNext('renameSync', 'EIO', pathEnds('/default.json', 1));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNAVAILABLE');
      });

      expect(readFileSync(join(store, 'default.json'), 'utf8')).toBe(JSON.stringify(FILE_RECORD));
      expect(stagesIn(store)).toEqual([]);
    });

    it('reports a stage whose identity cannot be checked as unavailable and removes it', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      failNext('lstatSync', 'EIO', pathHas('/.stage.'));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNAVAILABLE');
      });

      expect(stagesIn(store)).toEqual([]);
      expect(existsSync(join(store, 'default.json'))).toBe(false);
    });

    it('cleans up its stage when the stage cannot be flushed', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      failNext('fsyncSync', 'EIO', handleHas('.stage.'));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNAVAILABLE');
      });

      expect(stagesIn(store)).toEqual([]);
    });

    it('cleans up its stage when the stage cannot be written', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      failNext('writeFileSync', 'ENOSPC', handleHas('.stage.'));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNAVAILABLE');
      });

      expect(stagesIn(store)).toEqual([]);
    });

    it('reports a stage that cannot be closed after the commit, without closing it twice', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const target = join(store, 'default.json');
      const before = descriptorCount();
      // The stage is closed after the rename, when its descriptor reads as the target.
      failClosingNext('closeSync', 'EIO', handleIs(target));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNAVAILABLE');
      });

      expect(stagesIn(store)).toEqual([]);
      expect(descriptorCount()).toBe(before);
    });

    it('cleans up its stage when its mode cannot be set', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      failNext('fchmodSync', 'EIO', handleHas('.stage.'));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNAVAILABLE');
      });

      expect(stagesIn(store)).toEqual([]);
    });

    it('leaves a stage that cannot be inspected in place rather than removing it by name', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      failNext('fstatSync', 'EIO', handleHas('.stage.'));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNAVAILABLE');
      });

      expect(stagesIn(store)).toHaveLength(1);
      expect(existsSync(join(store, 'default.json'))).toBe(false);
    });

    it('never removes an existing entry that has the stage name', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      beforeNext(
        'openSync',
        (args) => {
          writeFileSync(args[0] as string, 'unrelated', { flag: 'wx', mode: 0o600 });
        },
        pathHas('/.stage.'),
      );

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNAVAILABLE');
      });

      expect(stagesIn(store)).toHaveLength(1);
      expect(readFileSync(join(store, stagesIn(store)[0]!), 'utf8')).toBe('unrelated');
    });

    it('reports a failed flush after the rename as unavailable, with the new record in place', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), JSON.stringify(FILE_RECORD));
      failNext('fsyncSync', 'EIO', handleIs(store));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNAVAILABLE');
      });

      expect(readFileSync(join(store, 'default.json'), 'utf8')).toBe(
        JSON.stringify(KEYRING_RECORD),
      );
      expect(stagesIn(store)).toEqual([]);
    });
  });

  describe('the descriptor lifetime of a replacement', () => {
    /*
     * These tests do not depend on how the kernel recycles inode numbers. Each one
     * asserts, at the exact point where another process would act, that the
     * descriptor which pins the admitted or the staged object is still open. The
     * kernel reports an unlinked object that is still open with " (deleted)".
     */

    it('keeps the admitted record pinned while another process replaces its name', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const path = join(store, 'default.json');
      writeStoreFile(path, JSON.stringify(FILE_RECORD));
      let pinnedBeforeReplace = false;
      let pinnedAfterUnlink = false;
      beforeNext(
        'writeFileSync',
        () => {
          pinnedBeforeReplace = descriptorLinks().includes(path);
          unlinkSync(path);
          pinnedAfterUnlink = descriptorLinks().includes(`${path} (deleted)`);
          writeStoreFile(path, JSON.stringify(KEYRING_RECORD));
        },
        handleHas('.stage.'),
      );

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(FILE_RECORD), 'FILE_UNSAFE');
      });

      expect(pinnedBeforeReplace).toBe(true);
      expect(pinnedAfterUnlink).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe(JSON.stringify(KEYRING_RECORD));
      expect(stagesIn(store)).toEqual([]);
    });

    it('checks the admitted record while its descriptor is still open, before the rename', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const target = join(store, 'default.json');
      writeStoreFile(target, JSON.stringify(FILE_RECORD));
      let pinnedAtRecheck = false;
      beforeNext(
        'lstatSync',
        () => {
          pinnedAtRecheck = descriptorLinks().includes(target);
        },
        pathEnds('/default.json'),
      );

      await files.withProfile('default', true, async (file) => {
        await file.write(KEYRING_RECORD);
      });

      expect(pinnedAtRecheck).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe(JSON.stringify(KEYRING_RECORD));
    });

    it('keeps the staged record pinned while it is renamed over the target', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const target = join(store, 'default.json');
      let pinnedAfterRename = false;
      let pinnedAfterUnlink = false;
      afterNext(
        'renameSync',
        (result) => {
          pinnedAfterRename = descriptorLinks().includes(target);
          unlinkSync(target);
          pinnedAfterUnlink = descriptorLinks().includes(`${target} (deleted)`);
          writeStoreFile(target, 'decoy');
          return result;
        },
        pathEnds('/default.json', 1),
      );

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNSAFE');
      });

      expect(pinnedAfterRename).toBe(true);
      expect(pinnedAfterUnlink).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('decoy');
    });

    it('refuses a replacement whose admitted record was moved aside before the rename', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const target = join(store, 'default.json');
      const moved = join(base, 'moved.json');
      writeStoreFile(target, JSON.stringify(FILE_RECORD));
      beforeNext(
        'renameSync',
        () => {
          // The admitted record leaves its name after the recheck; another file takes it.
          renameSync(target, moved);
          writeStoreFile(target, 'attacker');
        },
        pathEnds('/default.json', 1),
      );

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNSAFE');
      });

      // The rename committed the new record; the failure is reported, and the
      // admitted record is not claimed to have been replaced.
      expect(readFileSync(target, 'utf8')).toBe(JSON.stringify(KEYRING_RECORD));
      expect(readFileSync(moved, 'utf8')).toBe(JSON.stringify(FILE_RECORD));
      expect(stagesIn(store)).toEqual([]);
    });

    it('reports a stage close after the commit as unavailable, without restoring the previous record', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const target = join(store, 'default.json');
      writeStoreFile(target, JSON.stringify(FILE_RECORD));
      // After the rename the staged descriptor refers to the record at the target name.
      failClosingNext('closeSync', 'EIO', handleIs(target));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNAVAILABLE');
      });

      expect(readFileSync(target, 'utf8')).toBe(JSON.stringify(KEYRING_RECORD));
      expect(stagesIn(store)).toEqual([]);
    });

    it('reports a destination close after the commit as unavailable, with the new record in place', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const target = join(store, 'default.json');
      writeStoreFile(target, JSON.stringify(FILE_RECORD));
      // The rename unlinked the admitted record, so its descriptor reads as deleted.
      failClosingNext('closeSync', 'EIO', handleIs(`${target} (deleted)`));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNAVAILABLE');
      });

      expect(readFileSync(target, 'utf8')).toBe(JSON.stringify(KEYRING_RECORD));
      expect(stagesIn(store)).toEqual([]);
    });

    it('keeps the operation error when the admitted record cannot be closed', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const target = join(store, 'default.json');
      writeStoreFile(target, JSON.stringify(FILE_RECORD));
      beforeNext(
        'writeFileSync',
        () => {
          unlinkSync(target);
          writeStoreFile(target, JSON.stringify(KEYRING_RECORD));
        },
        handleHas('.stage.'),
      );
      failClosingNext('closeSync', 'EIO', handleIs(`${target} (deleted)`));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(FILE_RECORD), 'FILE_UNSAFE');
      });

      expect(readFileSync(target, 'utf8')).toBe(JSON.stringify(KEYRING_RECORD));
      expect(stagesIn(store)).toEqual([]);
    });

    it('checks the staged name while the stage is still pinned', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      let pinnedDuringCheck = false;
      failNext('fsyncSync', 'EIO', handleHas('.stage.'));
      beforeNext(
        'lstatSync',
        () => {
          const [stage] = stagesIn(store);
          pinnedDuringCheck = descriptorLinks().includes(join(store, stage!));
        },
        pathHas('/.stage.'),
      );

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNAVAILABLE');
      });

      expect(pinnedDuringCheck).toBe(true);
      expect(stagesIn(store)).toEqual([]);
    });

    it('keeps a replacement at the staged name instead of taking ownership of it', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      failNext('fsyncSync', 'EIO', handleHas('.stage.'));
      beforeNext(
        'lstatSync',
        () => {
          const [stage] = stagesIn(store);
          renameSync(join(store, stage!), join(base, 'moved.tmp'));
          writeStoreFile(join(store, stage!), 'decoy');
        },
        pathHas('/.stage.'),
      );

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNAVAILABLE');
      });

      expect(existsSync(join(store, 'default.json'))).toBe(false);
      expect(stagesIn(store)).toHaveLength(1);
      expect(readFileSync(join(store, stagesIn(store)[0]!), 'utf8')).toBe('decoy');
    });

    it('keeps the flush error when the stage cannot be closed afterwards', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const before = descriptorCount();
      failNext('fsyncSync', 'EIO', handleHas('.stage.'));
      failClosingNext('closeSync', 'EIO', handleHas('.stage.'));

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNAVAILABLE');
      });

      expect(stagesIn(store)).toEqual([]);
      expect(existsSync(join(store, 'default.json'))).toBe(false);
      expect(descriptorCount()).toBe(before);
    });
  });

  describe('the profile lock', () => {
    it('refuses a profile that another caller holds', async () => {
      const base = createBase();
      const store = storePath(base);
      const files = createProfileFiles(store);
      await files.withProfile('default', true, async () => 'ready');
      mkdirSync(join(store, '.lock.default'), { mode: 0o700 });

      await expectAsyncCode(
        files.withProfile('default', false, async () => 'ready'),
        'FILE_BUSY',
      );
    });

    it('holds the lock for the whole callback', async () => {
      const base = createBase();
      const files = createProfileFiles(storePath(base));

      await files.withProfile('default', true, async () => {
        await expectAsyncCode(
          files.withProfile('default', false, async () => 'nested'),
          'FILE_BUSY',
        );
        await expect(files.withProfile('other', false, async () => 'other')).resolves.toBe('other');
      });
    });

    it('releases the lock when the callback fails', async () => {
      const base = createBase();
      const store = storePath(base);
      const files = createProfileFiles(store);

      await expect(
        files.withProfile('default', true, async () => {
          throw new Error('the callback failed');
        }),
      ).rejects.toThrow('the callback failed');

      await expect(files.withProfile('default', false, async () => 'ready')).resolves.toBe('ready');
      expect(readdirSync(store)).toEqual([]);
    });

    it('never removes a lock that it does not own', async () => {
      const base = createBase();
      const store = storePath(base);
      const files = createProfileFiles(store);
      const lock = join(store, '.lock.default');

      await expectAsyncCode(
        files.withProfile('default', true, async () => {
          rmdirSync(lock);
          mkdirSync(lock, { mode: 0o700 });
        }),
        'FILE_UNAVAILABLE',
      );

      expect(existsSync(lock)).toBe(true);
    });

    it('accepts a lock that the callback released itself', async () => {
      const base = createBase();
      const store = storePath(base);
      const files = createProfileFiles(store);

      await expect(
        files.withProfile('default', true, async () => {
          rmdirSync(join(store, '.lock.default'));
          return 'ready';
        }),
      ).resolves.toBe('ready');
    });

    it('refuses a profile that another process holds', async () => {
      const base = createBase();
      const store = storePath(base);
      const files = createProfileFiles(store);
      await files.withProfile('default', true, async () => 'ready');

      const child = spawn(process.execPath, ['-e', LOCK_HOLDER, store], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const exited = waitForExit(child);
      try {
        await waitForMarker(child, 'ready');
        await expectAsyncCode(
          files.withProfile('default', false, async () => 'ready'),
          'FILE_BUSY',
        );
        child.stdin.write('release\n');
        await exited;
      } finally {
        child.kill('SIGKILL');
      }

      await expect(files.withProfile('default', false, async () => 'ready')).resolves.toBe('ready');
    });

    it('reports a lock that cannot be created as unavailable', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      failNext('mkdirSync', 'EIO', pathEnds('/.lock.default'));

      await expectAsyncCode(
        files.withProfile('default', false, async () => 'ready'),
        'FILE_UNAVAILABLE',
      );
      expect(existsSync(join(store, '.lock.default'))).toBe(false);
    });

    it('preserves the unidentified lock when it cannot be opened', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const before = descriptorCount();
      failNext('openSync', 'EIO', pathEnds('/.lock.default'));

      await expectAsyncCode(
        files.withProfile('default', false, async () => 'ready'),
        'FILE_UNAVAILABLE',
      );
      expect(existsSync(join(store, '.lock.default'))).toBe(true);
      expect(descriptorCount()).toBe(before);
    });

    it('removes the lock it created when the lock cannot be set owner-only', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const before = descriptorCount();
      failNext('fchmodSync', 'EIO', handleEnds('/.lock.default'));

      await expectAsyncCode(
        files.withProfile('default', false, async () => 'ready'),
        'FILE_UNAVAILABLE',
      );
      expect(existsSync(join(store, '.lock.default'))).toBe(false);
      expect(descriptorCount()).toBe(before);
    });

    it('preserves the unidentified lock when its descriptor cannot be inspected', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const before = descriptorCount();
      failNext('fstatSync', 'EIO', handleEnds('/.lock.default'));

      await expectAsyncCode(
        files.withProfile('default', false, async () => 'ready'),
        'FILE_UNAVAILABLE',
      );
      expect(existsSync(join(store, '.lock.default'))).toBe(true);
      expect(descriptorCount()).toBe(before);
    });

    it('does not chmod or remove an opened lock that fails the ownership check', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const lock = join(store, '.lock.default');
      const before = descriptorCount();
      afterNext(
        'fstatSync',
        (stat) => ({ ...(stat as nodeFs.Stats), uid: 424242 }),
        handleIs(lock),
      );
      const action = vi.fn(async () => 'ready');

      await expectAsyncCode(files.withProfile('default', false, action), 'FILE_UNSAFE');
      expect(action).not.toHaveBeenCalled();
      expect(existsSync(lock)).toBe(true);
      expect(descriptorCount()).toBe(before);
    });

    it('keeps a lock busy when a failed acquisition cannot remove it', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      failNext('fchmodSync', 'EIO', handleEnds('/.lock.default'));
      failNext('rmdirSync', 'EIO', pathEnds('/.lock.default'));

      await expectAsyncCode(
        files.withProfile('default', false, async () => 'ready'),
        'FILE_UNAVAILABLE',
      );
      expect(existsSync(join(store, '.lock.default'))).toBe(true);
      await expectAsyncCode(
        files.withProfile('default', false, async () => 'ready'),
        'FILE_BUSY',
      );
    });

    it('reports a lock that cannot be released as unavailable when the callback left entries in it', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const lock = join(store, '.lock.default');

      await expectAsyncCode(
        files.withProfile('default', true, async () => {
          writeFileSync(join(lock, 'inside'), 'left behind');
        }),
        'FILE_UNAVAILABLE',
      );
      expect(existsSync(join(lock, 'inside'))).toBe(true);
    });

    it('reports a lock whose identity cannot be checked on release as unavailable', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const lock = join(store, '.lock.default');
      failNext('lstatSync', 'EIO', pathEnds('/.lock.default'));

      await expectAsyncCode(
        files.withProfile('default', true, async () => 'ready'),
        'FILE_UNAVAILABLE',
      );
      expect(existsSync(lock)).toBe(true);
    });

    it('reports a lock whose descriptor cannot be closed as unavailable, after removing the lock', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      // The lock is removed before its descriptor is closed, so the path of the
      // descriptor reads as deleted: the match is on the name, not on the suffix.
      failClosingNext('closeSync', 'EIO', handleHas('.lock.default'));

      await expectAsyncCode(
        files.withProfile('default', true, async () => 'ready'),
        'FILE_UNAVAILABLE',
      );
      expect(existsSync(join(store, '.lock.default'))).toBe(false);
    });

    it('keeps the callback error when the lock cannot be released', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const lock = join(store, '.lock.default');

      await expect(
        files.withProfile('default', true, async () => {
          writeFileSync(join(lock, 'inside'), 'left behind');
          throw new Error('the callback failed');
        }),
      ).rejects.toThrow('the callback failed');
    });

    it('reports a store that cannot be closed as unavailable after a successful callback', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const before = descriptorCount();
      failClosingNext('closeSync', 'EIO', handleIs(store));

      await expectAsyncCode(
        files.withProfile('default', true, async () => 'ready'),
        'FILE_UNAVAILABLE',
      );
      expect(descriptorCount()).toBe(before);
      expect(existsSync(join(store, '.lock.default'))).toBe(false);
    });

    it('keeps the callback error when the store cannot be closed', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      failClosingNext('closeSync', 'EIO', handleIs(store));

      await expect(
        files.withProfile('default', true, async () => {
          throw new Error('the callback failed');
        }),
      ).rejects.toThrow('the callback failed');
    });
  });

  describe('the descriptors', () => {
    it('the descriptor ledger that every test checks reports a second close', () => {
      // A synthetic number: this test checks the ledger itself, not a real descriptor.
      faults.ledger.opened(999_999);
      faults.ledger.closing(999_999);
      faults.ledger.closing(999_999);

      expect(faults.ledger.doubleClose).toBe(1);
      // The deliberate double close is acknowledged here, so the global check stays clean.
      faults.ledger.doubleClose = 0;
    });

    it('leaves no descriptor open after a successful access', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      const before = descriptorCount();

      await files.withProfile('default', true, async (file) => {
        await file.write(KEYRING_RECORD);
        await file.read();
        await file.remove();
      });

      expect(descriptorCount()).toBe(before);
    });

    it('leaves no descriptor open after a failed access', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      writeStoreFile(join(store, 'default.json'), 'not a record');
      const before = descriptorCount();

      await expectAsyncCode(
        files.withProfile('default', true, async (file) => {
          await file.read();
        }),
        'PROFILE_CORRUPT',
      );
      expect(descriptorCount()).toBe(before);
    });

    it('leaves no descriptor open after a refused record', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      symlinkSync('/etc/hostname', join(store, 'default.json'));
      const before = descriptorCount();

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNSAFE');
        await expectAsyncCode(file.remove(), 'FILE_UNSAFE');
        await expectAsyncCode(file.read(), 'FILE_UNSAFE');
      });
      expect(descriptorCount()).toBe(before);
    });

    it('leaves no descriptor open after a failed write', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      failNext('fsyncSync', 'EIO', handleHas('.stage.'));
      const before = descriptorCount();

      await files.withProfile('default', true, async (file) => {
        await expectAsyncCode(file.write(KEYRING_RECORD), 'FILE_UNAVAILABLE');
      });
      expect(descriptorCount()).toBe(before);
    });
  });

  describe('the access of a callback', () => {
    it('refuses every operation after the callback has returned', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      let kept: ProfileFile | undefined;

      await files.withProfile('default', true, async (file) => {
        kept = file;
        await file.write(KEYRING_RECORD);
      });

      const late = kept as ProfileFile;
      await expectAsyncCode(late.read(), 'FILE_UNAVAILABLE');
      await expectAsyncCode(late.write(FILE_RECORD), 'FILE_UNAVAILABLE');
      await expectAsyncCode(late.remove(), 'FILE_UNAVAILABLE');
      await expect(
        files.withProfile('default', false, async (file) => file.read()),
      ).resolves.toEqual(KEYRING_RECORD);
    });

    it('refuses an operation that the callback started and that runs after the lock is released', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);

      let pending: Promise<unknown> | undefined;
      await files.withProfile('default', true, async (file) => {
        // The callback returns at once; the write is attempted after the lock is released.
        pending = new Promise<unknown>((resolve) => {
          setTimeout(() => {
            resolve(
              file.write(KEYRING_RECORD).then(
                () => 'written',
                (error: unknown) => error,
              ),
            );
          }, 5);
        });
      });

      const outcome = await (pending as Promise<unknown>);
      expect(outcome).toBeInstanceOf(AgentAuthError);
      expect((outcome as AgentAuthError).code).toBe('FILE_UNAVAILABLE');
      expect(existsSync(join(store, 'default.json'))).toBe(false);
      expect(existsSync(join(store, '.lock.default'))).toBe(false);
    });

    it('never uses a descriptor number that the system reused after the callback', async () => {
      const base = createBase();
      const store = existingStore(base);
      const files = createProfileFiles(store);
      let kept: ProfileFile | undefined;
      await files.withProfile('default', true, async (file) => {
        kept = file;
      });

      const other = openSync(base, 'r');
      try {
        await expectAsyncCode((kept as ProfileFile).read(), 'FILE_UNAVAILABLE');
      } finally {
        closeSync(other);
      }
    });

    it('refuses every operation on an absent store after the callback has returned', async () => {
      const base = createBase();
      const files = createProfileFiles(storePath(base));
      let kept: ProfileFile | undefined;

      await files.withProfile('default', false, async (file) => {
        kept = file;
      });

      const late = kept as ProfileFile;
      await expectAsyncCode(late.read(), 'FILE_UNAVAILABLE');
      await expectAsyncCode(late.write(KEYRING_RECORD), 'FILE_UNAVAILABLE');
      await expectAsyncCode(late.remove(), 'FILE_UNAVAILABLE');
    });
  });
});
