import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
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
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CreateIntentError,
  withCreateIntent,
  type CreateIntent,
  type CreateIntentBinding,
  type CreateIntentOptions,
  type CreateIntentPayload,
} from '../src/create-intent.js';

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
    linkSync: hook('linkSync', actual.linkSync),
    lstatSync: hook('lstatSync', actual.lstatSync),
    mkdirSync: hook('mkdirSync', actual.mkdirSync),
    readSync: hook('readSync', actual.readSync),
    rmdirSync: hook('rmdirSync', actual.rmdirSync),
    unlinkSync: hook('unlinkSync', actual.unlinkSync),
    writeFileSync: hook('writeFileSync', actual.writeFileSync),
  };
});

/* ------------------------------------------------------------------------- */
/* Synthetic identities. None of them is a real credential.                   */
/* ------------------------------------------------------------------------- */

const ORIGIN = 'https://pto.example.test';
const ACTOR = '6f1d4c8e-2b3a-4d5e-8f70-112233445566';
const OTHER_ACTOR = '7a2e5d9f-3c4b-4e6f-9a81-223344556677';
const TOKEN_ID = '0f8a1b2c-3d4e-4f50-8a61-7b8c9d0e1f20';
const TOKEN_SECRET = 'ab'.repeat(32);
const TOKEN = `pto_pat_${TOKEN_ID}.${TOKEN_SECRET}`;
const ROTATED_TOKEN_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const ROTATED_TOKEN = `pto_pat_${ROTATED_TOKEN_ID}.${'cd'.repeat(32)}`;
const SAME_ID_OTHER_SECRET = `pto_pat_${TOKEN_ID}.${'ef'.repeat(32)}`;

/** 2026-11-19T12:00:00.000Z in milliseconds: a 13-digit UTC value. */
const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/** Monday 2026-12-07, a single day. */
const SINGLE: CreateIntentPayload = {
  startDate: '2026-12-07',
  endDate: '2026-12-07',
  dayPart: 'morning',
};
/** Monday to Friday 2026-12-07 to 2026-12-11, a multi-day range. */
const MULTI: CreateIntentPayload = { startDate: '2026-12-07', endDate: '2026-12-11' };

const RECORD_FIELDS = [
  'actorId',
  'digest',
  'expiresAt',
  'key',
  'operationId',
  'origin',
  'tokenId',
  'version',
];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The mutable clock of the current test. */
let clock = NOW;

/** The temporary bases of the current test. They are removed after every test. */
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

beforeEach(() => {
  clock = NOW;
});

/** A private base directory that only this user may enter. Short, so every name fits. */
function createBase(): string {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'j262-'));
  bases.push(base);
  return base;
}

/** The journal directory of a base, which does not exist yet. */
function journalOf(base: string): string {
  return join(base, 'journal');
}

/** A binding of the synthetic identity, with any field replaced. */
function bindingOf(overrides: Record<string, unknown> = {}): CreateIntentBinding {
  return {
    origin: ORIGIN,
    actorId: ACTOR,
    tokenId: TOKEN_ID,
    token: TOKEN,
    ...overrides,
  } as unknown as CreateIntentBinding;
}

/** A payload with any field replaced. */
function payloadOf(overrides: Record<string, unknown> = {}): CreateIntentPayload {
  return { ...SINGLE, ...overrides } as unknown as CreateIntentPayload;
}

/** The options of a test: an explicit directory and the mutable clock. */
function runOptions(dir: string, extra: CreateIntentOptions = {}): CreateIntentOptions {
  return { directory: dir, now: () => clock, ...extra };
}

/** Admits one create and leaves its record pending, without completing it. */
async function admitPending(
  dir: string,
  binding: CreateIntentBinding = bindingOf(),
  payload: CreateIntentPayload = SINGLE,
  operationId: string | null = null,
): Promise<CreateIntent> {
  let intent: CreateIntent | undefined;
  await withCreateIntent(
    binding,
    payload,
    operationId,
    async (lease) => {
      intent = lease.intent;
    },
    runOptions(dir),
  );
  if (intent === undefined) throw new Error('the callback did not run');
  return intent;
}

/** Admits one create and completes its lease, so the owner is idle again. */
async function completeCreate(
  dir: string,
  binding: CreateIntentBinding = bindingOf(),
  payload: CreateIntentPayload = SINGLE,
): Promise<CreateIntent> {
  let intent: CreateIntent | undefined;
  await withCreateIntent(
    binding,
    payload,
    null,
    async (lease) => {
      intent = lease.intent;
      lease.complete();
    },
    runOptions(dir),
  );
  if (intent === undefined) throw new Error('the callback did not run');
  return intent;
}

/** The name of every record file in a journal directory. */
function recordNames(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.startsWith('owner-') && name.endsWith('.json'))
    .sort();
}

/** The only record file of a journal directory. */
function onlyRecord(dir: string): string {
  const names = recordNames(dir);
  if (names.length !== 1) throw new Error(`expected one record, found ${names.length}`);
  return join(dir, names[0]!);
}

/** The lock directories of a journal directory. */
function lockNames(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith('.lock.'));
}

/** The stage files of a journal directory. */
function stageNames(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith('.stage.'));
}

/** A record as its JSON object. */
function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/** Replaces the content of a record in place, keeping it owner-only. */
function rewrite(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Asserts that a call is refused with a journal error, and returns that error. */
async function refusalOf(run: Promise<unknown>): Promise<CreateIntentError> {
  const error = await failureOf(run);
  expect(error).toBeInstanceOf(CreateIntentError);
  return error as CreateIntentError;
}

/** The error of a call that has to fail. */
async function failureOf(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error('the call was expected to fail');
}

/** Matches a call whose first argument is a path that ends with the suffix. */
type Matcher = (args: readonly unknown[]) => boolean;

const anyCall: Matcher = () => true;

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

/** The path that a descriptor refers to, or an empty path when it cannot be read. */
function descriptorPath(handle: number): string {
  try {
    return readlinkSync(`/proc/self/fd/${handle}`);
  } catch {
    return '';
  }
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

/** Matches only the nth call that the inner matcher accepts. */
function nthCall(count: number, inner: Matcher): Matcher {
  let seen = 0;
  return (args) => {
    if (!inner(args)) return false;
    seen += 1;
    return seen === count;
  };
}

/**
 * Matches the flush of a journal directory that follows the publication of its
 * record.
 *
 * A journal directory is flushed more than once: once when it is created, and
 * once after its record has been linked into it. Only the second flush proves
 * that the record itself and its name are durable.
 */
function leafFlush(dir: string): Matcher {
  return (args) => {
    const value = args[0];
    if (typeof value !== 'number' || descriptorPath(value) !== dir) return false;
    return recordNames(dir).length > 0;
  };
}

/** The flushes of one test, in the order they happened. */
interface Flushes {
  readonly order: string[];
  /** Removes the recording rule, so that no fault is left behind. */
  stop(): void;
}

/**
 * Records every flush of a test, in order.
 *
 * The path of the flushed descriptor is recorded. The flush of the staged record
 * is recorded as `record-bytes`, because the name of that stage is random.
 */
function recordFlushes(): Flushes {
  const order: string[] = [];
  const rule = {
    call: 'fsyncSync',
    match: () => true,
    after: (result: unknown, args: readonly unknown[]) => {
      const handle = args[0];
      const path = typeof handle === 'number' ? descriptorPath(handle) : '';
      order.push(path.includes('/.stage.') ? 'record-bytes' : path);
      faults.rules.push(rule);
      return result;
    },
  };
  faults.rules.push(rule);
  return {
    order,
    stop: (): void => {
      const index = faults.rules.indexOf(rule);
      if (index >= 0) faults.rules.splice(index, 1);
    },
  };
}

/** The components of an absolute path, from the first to the last. */
function componentsOf(path: string): string[] {
  const components: string[] = [];
  let walked = '';
  for (const part of path.split('/')) {
    if (part === '') continue;
    walked += `/${part}`;
    components.push(walked);
  }
  return components;
}

/**
 * The state of an object that belongs to another user.
 *
 * The result inherits every method of the real state, such as `isFile()`, so
 * only the owner is different.
 */
function foreignOwner(stat: unknown): nodeFs.Stats {
  return Object.assign(Object.create(stat as object) as nodeFs.Stats, { uid: 424242 });
}

/** The error that a failing system call reports, with its code. */
function systemError(code: string): Error {
  return Object.assign(new Error(`injected ${code}`), { code });
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
  match = anyCall,
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

/* ------------------------------------------------------------------------- */
/* The contract of a journal create.                                          */
/* ------------------------------------------------------------------------- */

describe('the create journal contract', () => {
  it('runs the callback once with a fresh intent and a durable pending record', async () => {
    const dir = journalOf(createBase());
    const act = vi.fn(async (lease: { intent: CreateIntent }) => ({ key: lease.intent.key }));

    const result = await withCreateIntent(
      bindingOf(),
      SINGLE,
      null,
      async (lease) => {
        const value = await act(lease);
        return value;
      },
      runOptions(dir),
    );

    expect(act).toHaveBeenCalledTimes(1);
    expect(result.key).toMatch(new RegExp(`^v1\\.${NOW}\\.`));
    expect(recordNames(dir)).toHaveLength(1);
  });

  it('publishes the record before the callback starts', async () => {
    const dir = journalOf(createBase());
    const order: string[] = [];
    beforeNext(
      'linkSync',
      () => {
        order.push('link');
      },
      pathEnds('.json', 1),
    );
    afterNext(
      'fsyncSync',
      (result) => {
        order.push('flush');
        return result;
      },
      leafFlush(dir),
    );

    await withCreateIntent(
      bindingOf(),
      SINGLE,
      null,
      async (lease) => {
        order.push('dispatch');
        expect(readJson(onlyRecord(dir)).operationId).toBe(lease.intent.operationId);
        lease.complete();
      },
      runOptions(dir),
    );

    expect(order).toEqual(['link', 'flush', 'dispatch']);
  });

  it('gives the callback an intent whose operation identifier, key and expiry have the canonical shapes', async () => {
    const dir = journalOf(createBase());
    let seen: CreateIntent | undefined;

    await withCreateIntent(
      bindingOf(),
      SINGLE,
      null,
      async (lease) => {
        seen = lease.intent;
        lease.complete();
      },
      runOptions(dir),
    );

    expect(seen).toBeDefined();
    expect(seen!.operationId).toMatch(UUID_V4);
    expect(seen!.key).toMatch(
      /^v1\.1795089600000\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(seen!.expiresAt).toBe(new Date(NOW + DAY_MS).toISOString());
    expect(Object.isFrozen(seen)).toBe(true);
  });

  it('keeps the operation identifier independent of the key nonce', async () => {
    const dir = journalOf(createBase());
    const intent = await admitPending(dir);
    const nonce = intent.key.split('.')[2];

    expect(nonce).toBeDefined();
    expect(intent.operationId).not.toBe(nonce);
    expect(intent.key).not.toContain(intent.operationId);
    expect(intent.operationId).not.toMatch(/^v1\./);
  });

  it('stores exactly the fixed fields, and neither the token, its secret, the note nor the payload', async () => {
    const dir = journalOf(createBase());
    const note = 'Dentist, 9am, bring the insurance card';
    await admitPending(dir, bindingOf(), payloadOf({ note }));
    const path = onlyRecord(dir);
    const raw = readFileSync(path, 'utf8');
    const record = readJson(path);

    expect(Object.keys(record).sort()).toEqual(RECORD_FIELDS);
    expect(statSync(path).mode & 0o7777).toBe(0o600);
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain(TOKEN_SECRET);
    expect(raw).not.toContain(note);
    expect(raw).not.toContain('2026-12-07');
    expect(raw).not.toContain(createHash('sha256').update(TOKEN).digest('hex'));
    expect(raw).not.toContain(createHash('sha256').update(TOKEN_SECRET).digest('hex'));
    expect(record['digest']).toMatch(/^[0-9a-f]{64}$/);
    expect(record['digest']).not.toBe(createHmac('sha256', TOKEN).update(note).digest('hex'));
    expect(record['origin']).toBe(ORIGIN);
    expect(record['actorId']).toBe(ACTOR);
    expect(record['tokenId']).toBe(TOKEN_ID);
    expect(record['version']).toBe(1);
  });

  it('keys the digest to the credential: the same payload under another token differs', async () => {
    const dir = journalOf(createBase());
    await admitPending(dir);
    const path = onlyRecord(dir);
    const first = readJson(path)['digest'];
    unlinkSync(path);
    await admitPending(dir, bindingOf({ tokenId: ROTATED_TOKEN_ID, token: ROTATED_TOKEN }));
    const second = readJson(onlyRecord(dir))['digest'];
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);

    // The same token and the same payload always produce the same digest.
    unlinkSync(onlyRecord(dir));
    await admitPending(dir);
    expect(readJson(onlyRecord(dir))['digest']).toBe(first);
  });

  it('keeps the pending record and never retries when the callback fails', async () => {
    const dir = journalOf(createBase());
    const boom = new Error('dispatch failed');
    const act = vi.fn(async () => {
      throw boom;
    });

    await expect(withCreateIntent(bindingOf(), SINGLE, null, act, runOptions(dir))).rejects.toBe(
      boom,
    );

    expect(act).toHaveBeenCalledTimes(1);
    expect(recordNames(dir)).toHaveLength(1);
  });

  it('keeps the pending record when the callback resolves without completing it', async () => {
    const dir = journalOf(createBase());
    await expect(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 'ambiguous', runOptions(dir)),
    ).resolves.toBe('ambiguous');

    expect(recordNames(dir)).toHaveLength(1);
    expect(lockNames(dir)).toEqual([]);
  });

  it('returns the callback value and releases the lock after a settled success', async () => {
    const dir = journalOf(createBase());
    const value = await withCreateIntent(
      bindingOf(),
      SINGLE,
      null,
      async (lease) => {
        lease.complete();
        return { done: true };
      },
      runOptions(dir),
    );

    expect(value).toEqual({ done: true });
    expect(lockNames(dir)).toEqual([]);
    expect(recordNames(dir)).toEqual([]);
  });

  it('keeps the lock held during the callback and removes it afterwards', async () => {
    const dir = journalOf(createBase());
    let heldDuring: string[] = [];

    await withCreateIntent(
      bindingOf(),
      SINGLE,
      null,
      async (lease) => {
        heldDuring = lockNames(dir);
        lease.complete();
      },
      runOptions(dir),
    );

    expect(heldDuring).toHaveLength(1);
    expect(lockNames(dir)).toEqual([]);
  });

  it('completes the lease exactly once, and a second completion is a no-op', async () => {
    const dir = journalOf(createBase());
    await withCreateIntent(
      bindingOf(),
      SINGLE,
      null,
      async (lease) => {
        lease.complete();
        expect(() => lease.complete()).not.toThrow();
      },
      runOptions(dir),
    );

    expect(recordNames(dir)).toEqual([]);
  });

  it('starts a new intent after completion, with a new operation identifier and key', async () => {
    const dir = journalOf(createBase());
    const first = await completeCreate(dir);
    const second = await completeCreate(dir);

    expect(second.operationId).not.toBe(first.operationId);
    expect(second.key).not.toBe(first.key);
  });

  it('lets a new module instance see the same pending state after a restart', async () => {
    const dir = journalOf(createBase());
    const pending = await admitPending(dir);
    vi.resetModules();
    const restarted = await import('../src/create-intent.js');

    await expect(
      restarted.withCreateIntent(
        bindingOf(),
        SINGLE,
        null,
        async () => 'dispatched',
        runOptions(dir),
      ),
    ).rejects.toMatchObject({ code: 'PENDING', operationId: pending.operationId });

    let resumed: CreateIntent | undefined;
    await restarted.withCreateIntent(
      bindingOf(),
      SINGLE,
      pending.operationId,
      async (lease) => {
        resumed = lease.intent;
        lease.complete();
      },
      runOptions(dir),
    );
    expect(resumed).toEqual(pending);
  });

  it('refuses a missing callback before the disk is touched', async () => {
    const dir = journalOf(createBase());
    await expect(
      withCreateIntent(
        bindingOf(),
        SINGLE,
        null,
        undefined as unknown as () => Promise<void>,
        runOptions(dir),
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(existsSync(dir)).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* The input contract. Every refusal happens before the disk is touched.      */
/* ------------------------------------------------------------------------- */

describe('the input contract', () => {
  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'binding'],
  ])('refuses a binding that is %s', async (_label, binding) => {
    const dir = journalOf(createBase());
    const error = await failureOf(
      withCreateIntent(
        binding as unknown as CreateIntentBinding,
        SINGLE,
        null,
        async () => 1,
        runOptions(dir),
      ),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(existsSync(dir)).toBe(false);
  });

  it.each([
    ['plain http for a remote host', 'http://pto.example.test'],
    ['a trailing slash', 'https://pto.example.test/'],
    ['an uppercase host', 'https://PTO.example.test'],
    ['a default port', 'https://pto.example.test:443'],
    ['a websocket scheme', 'ws://pto.example.test'],
    ['a path', 'https://pto.example.test/api'],
    ['userinfo', 'https://user@pto.example.test'],
    ['not a URL', 'not a url'],
    ['an overlong origin', `https://${'a'.repeat(510)}.test`],
    ['a number', 42],
  ])('refuses an origin with %s', async (_label, origin) => {
    const dir = journalOf(createBase());
    const error = await failureOf(
      withCreateIntent(bindingOf({ origin }), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(existsSync(dir)).toBe(false);
  });

  it.each([
    ['a loopback http origin on 127.0.0.1', 'http://127.0.0.1:3000'],
    ['a loopback http origin on localhost', 'http://localhost:3000'],
    ['a loopback http origin on IPv6', 'http://[::1]:3000'],
  ])('accepts %s', async (_label, origin) => {
    const dir = journalOf(createBase());
    const intent = await completeCreate(dir, bindingOf({ origin }));
    expect(intent.operationId).toMatch(UUID_V4);
  });

  it.each([
    ['an actor that is not a UUID', { actorId: 'not-a-uuid' }],
    ['an actor that is a number', { actorId: 7 }],
    ['a token identifier that is not a UUID', { tokenId: 'nope' }],
    ['a token that is not a personal access token', { token: 'pto_pat_nope' }],
    ['a token that is not a string', { token: 12 }],
    ['an uppercase token', { token: TOKEN.toUpperCase() }],
  ])('refuses %s', async (_label, overrides) => {
    const dir = journalOf(createBase());
    const error = await failureOf(
      withCreateIntent(bindingOf(overrides), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(existsSync(dir)).toBe(false);
    expect(String((error as Error).message)).not.toContain(TOKEN_SECRET);
  });

  it('refuses a token whose public identifier is not the bound token identifier, as a mismatch', async () => {
    const dir = journalOf(createBase());
    const refusal = await refusalOf(
      withCreateIntent(
        bindingOf({ tokenId: ROTATED_TOKEN_ID }),
        SINGLE,
        null,
        async () => 1,
        runOptions(dir),
      ),
    );
    expect(refusal.code).toBe('MISMATCH');
    expect(refusal.operationId).toBeUndefined();
    expect(refusal.expiresAt).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
  });

  it('accepts uppercase actor and token identifiers as their canonical form', async () => {
    const dir = journalOf(createBase());
    await admitPending(
      dir,
      bindingOf({ actorId: ACTOR.toUpperCase(), tokenId: TOKEN_ID.toUpperCase() }),
    );
    const record = readJson(onlyRecord(dir));

    expect(record['actorId']).toBe(ACTOR);
    expect(record['tokenId']).toBe(TOKEN_ID);
    await expect(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 'dispatched', runOptions(dir)),
    ).rejects.toMatchObject({ code: 'PENDING' });
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'dates'],
  ])('refuses a payload that is %s', async (_label, payload) => {
    const dir = journalOf(createBase());
    const error = await failureOf(
      withCreateIntent(
        bindingOf(),
        payload as unknown as CreateIntentPayload,
        null,
        async () => 1,
        runOptions(dir),
      ),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(existsSync(dir)).toBe(false);
  });

  it.each([
    ['an unknown field that could carry an owner', payloadOf({ owner: ACTOR })],
    ['a start date that is not ISO', payloadOf({ startDate: '2026-1-7' })],
    ['a start date that is not a real day', payloadOf({ startDate: '2026-02-30' })],
    ['a start date that is a number', payloadOf({ startDate: 20261207 })],
    ['a start date on a Saturday', payloadOf({ startDate: '2026-12-12' })],
    [
      'an end date on a Sunday',
      { startDate: '2026-12-07', endDate: '2026-12-13', dayPart: 'all_day' },
    ],
    ['an end date that is not a real month', payloadOf({ endDate: '2026-13-01' })],
    [
      'an end date before the start',
      { startDate: '2026-12-08', endDate: '2026-12-07', dayPart: 'morning' },
    ],
    ['a single day without a day part', { startDate: '2026-12-07', endDate: '2026-12-07' }],
    ['a day part that is not in the enumeration', payloadOf({ dayPart: 'afternoon' })],
    ['a day part that is null', payloadOf({ dayPart: null })],
    ['a note that is null', payloadOf({ note: null })],
    ['a note that is a number', payloadOf({ note: 12 })],
    ['a note longer than 500 UTF-16 units', payloadOf({ note: 'x'.repeat(501) })],
    ['a note whose emoji exceed 500 UTF-16 units', payloadOf({ note: '\u{1F600}'.repeat(251) })],
    ['a note with a lone high surrogate', payloadOf({ note: '\ud800' })],
    ['a note with a lone low surrogate', payloadOf({ note: 'a\udc00b' })],
  ])('refuses a payload with %s', async (_label, payload) => {
    const dir = journalOf(createBase());
    const error = await failureOf(
      withCreateIntent(
        bindingOf(),
        payload as unknown as CreateIntentPayload,
        null,
        async () => 1,
        runOptions(dir),
      ),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(existsSync(dir)).toBe(false);
  });

  it('accepts the bounds of a note, counted in UTF-16 units as the server counts them', async () => {
    const dir = journalOf(createBase());
    await admitPending(dir, bindingOf(), payloadOf({ note: 'x'.repeat(500) }));
    expect(recordNames(dir)).toHaveLength(1);
    rmSync(onlyRecord(dir));

    await admitPending(dir, bindingOf(), payloadOf({ note: '\u{1F600}'.repeat(250) }));
    expect(recordNames(dir)).toHaveLength(1);
  });

  it('treats an absent note and an empty note as the same approved payload', async () => {
    const dir = journalOf(createBase());
    const intent = await admitPending(dir, bindingOf(), payloadOf({ note: '' }));

    await expect(
      withCreateIntent(
        bindingOf(),
        SINGLE,
        intent.operationId,
        async (lease) => {
          expect(lease.intent).toEqual(intent);
          lease.complete();
        },
        runOptions(dir),
      ),
    ).resolves.toBeUndefined();
  });

  it('keeps a whitespace-only note distinct from an absent note, as the server does', async () => {
    const dir = journalOf(createBase());
    const intent = await admitPending(dir, bindingOf(), payloadOf({ note: '   ' }));

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, intent.operationId, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('MISMATCH');
  });

  it('normalizes a multi-day day part to all_day, as the server does', async () => {
    const dir = journalOf(createBase());
    const intent = await admitPending(
      dir,
      bindingOf(),
      payloadOf({ ...MULTI, dayPart: 'morning' }),
    );
    const equivalent = [
      MULTI,
      payloadOf({ ...MULTI, dayPart: 'evening' }),
      payloadOf({ ...MULTI, dayPart: 'all_day' }),
    ];

    // Each equivalent spelling resumes the same operation. None of them completes it.
    for (const variant of equivalent) {
      let resumed: CreateIntent | undefined;
      await withCreateIntent(
        bindingOf(),
        variant,
        intent.operationId,
        async (lease) => {
          resumed = lease.intent;
        },
        runOptions(dir),
      );
      expect(resumed).toEqual(intent);
    }
    expect(recordNames(dir)).toHaveLength(1);
  });

  it('refuses a single-day day part that differs, because a single day keeps its day part', async () => {
    const dir = journalOf(createBase());
    const intent = await admitPending(dir, bindingOf(), SINGLE);

    const refusal = await refusalOf(
      withCreateIntent(
        bindingOf(),
        payloadOf({ dayPart: 'evening' }),
        intent.operationId,
        async () => 1,
        runOptions(dir),
      ),
    );
    expect(refusal.code).toBe('MISMATCH');
  });

  it.each([
    ['a number', 1],
    ['an empty string', ''],
    ['a text that is not a UUID', 'not-a-uuid'],
    ['a version 1 UUID', '6f1d4c8e-2b3a-1d5e-8f70-112233445566'],
    ['an uppercase UUIDv4', '6F1D4C8E-2B3A-4D5E-8F70-112233445566'],
    ['a key shaped like a wire key', `v1.${NOW}.6f1d4c8e-2b3a-4d5e-8f70-112233445566`],
  ])('refuses an operation identifier that is %s', async (_label, operationId) => {
    const dir = journalOf(createBase());
    const error = await failureOf(
      withCreateIntent(
        bindingOf(),
        SINGLE,
        operationId as unknown as string,
        async () => 1,
        runOptions(dir),
      ),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(existsSync(dir)).toBe(false);
  });

  it('treats a null or an absent operation identifier as a new intent', async () => {
    const dir = journalOf(createBase());
    for (const operation of [null, undefined]) {
      let seen: CreateIntent | undefined;
      await withCreateIntent(
        bindingOf(),
        SINGLE,
        operation,
        async (lease) => {
          seen = lease.intent;
          lease.complete();
        },
        runOptions(dir),
      );
      expect(seen?.operationId).toMatch(UUID_V4);
    }
  });

  it.each([
    ['a non-object', 'options'],
    ['a relative directory', { directory: 'relative/dir' }],
    ['an empty directory', { directory: '' }],
    ['a parent segment', { directory: '/a/../b' }],
    ['a dot segment', { directory: '/a/./b' }],
    ['an empty segment', { directory: '/a//b' }],
    ['the root', { directory: '/' }],
    ['a NUL byte', { directory: '/a\0b' }],
    ['a number', { directory: 42 }],
    ['a path beyond the length bound', { directory: `/${'a'.repeat(4096)}` }],
    ['a path beyond the depth bound', { directory: `/${Array(33).fill('d').join('/')}` }],
    ['a clock that is not a function', { now: 'soon' }],
    ['a signal that is not a signal', { signal: {} }],
  ])('refuses options with %s', async (_label, options) => {
    const dir = journalOf(createBase());
    const error = await failureOf(
      withCreateIntent(
        bindingOf(),
        SINGLE,
        null,
        async () => 1,
        options as unknown as CreateIntentOptions,
      ),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(existsSync(dir)).toBe(false);
  });

  it('refuses options that are null', async () => {
    const error = await failureOf(
      withCreateIntent(
        bindingOf(),
        SINGLE,
        null,
        async () => 1,
        null as unknown as CreateIntentOptions,
      ),
    );
    expect(error).toBeInstanceOf(TypeError);
  });

  it.each([
    [
      'a clock that throws',
      () => {
        throw new Error('clock failed');
      },
    ],
    ['a clock that returns text', () => '1795089600000' as unknown as number],
    ['a clock that returns NaN', () => Number.NaN],
    ['a clock that returns a fraction', () => NOW + 0.5],
    ['a clock below 13 digits', () => 999_999_999_999],
    ['a clock above 13 digits', () => 10_000_000_000_000],
  ])('refuses %s as unavailable, before any record is written', async (_label, now) => {
    const dir = journalOf(createBase());
    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir, { now })),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(recordNames(dir)).toEqual([]);
  });

  it.each([
    ['the lowest 13-digit millisecond value', 1_000_000_000_000, /^v1\.1000000000000\./],
    ['the highest 13-digit millisecond value', 9_999_999_999_999, /^v1\.9999999999999\./],
  ])('accepts %s', async (_label, value, keyShape) => {
    const dir = journalOf(createBase());
    const intent = await withCreateIntent(
      bindingOf(),
      SINGLE,
      null,
      async (lease) => {
        lease.complete();
        return lease.intent;
      },
      runOptions(dir, { now: () => value }),
    );
    expect(intent.key).toMatch(keyShape);
    expect(intent.operationId).toMatch(UUID_V4);
  });

  it('uses the process clock when no clock is injected', async () => {
    const dir = journalOf(createBase());
    const before = Date.now();
    const intent = await withCreateIntent(
      bindingOf(),
      SINGLE,
      null,
      async (lease) => {
        lease.complete();
        return lease.intent;
      },
      { directory: dir },
    );
    const issued = Number(intent.key.split('.')[1]);
    expect(issued).toBeGreaterThanOrEqual(before);
    expect(issued).toBeLessThanOrEqual(Date.now());
  });

  it('refuses an aborted signal before any directory is created, and never calls the callback', async () => {
    const dir = journalOf(createBase());
    const controller = new AbortController();
    controller.abort();
    const act = vi.fn(async () => 1);

    const error = await failureOf(
      withCreateIntent(
        bindingOf(),
        SINGLE,
        null,
        act,
        runOptions(dir, { signal: controller.signal }),
      ),
    );

    expect((error as Error).name).toBe('AbortError');
    expect(act).not.toHaveBeenCalled();
    expect(existsSync(dir)).toBe(false);
  });

  it('stops before the callback when aborted after admission, and keeps the pending record', async () => {
    const dir = journalOf(createBase());
    const controller = new AbortController();
    beforeNext(
      'fsyncSync',
      () => {
        controller.abort();
      },
      handleHas('/.stage.'),
    );
    const act = vi.fn(async () => 1);

    const error = await failureOf(
      withCreateIntent(
        bindingOf(),
        SINGLE,
        null,
        act,
        runOptions(dir, { signal: controller.signal }),
      ),
    );

    expect((error as Error).name).toBe('AbortError');
    expect(act).not.toHaveBeenCalled();
    expect(recordNames(dir)).toHaveLength(1);
    expect(lockNames(dir)).toEqual([]);
  });

  it('accepts a signal that is not aborted', async () => {
    const dir = journalOf(createBase());
    const controller = new AbortController();
    await expect(
      withCreateIntent(
        bindingOf(),
        SINGLE,
        null,
        async (lease) => {
          lease.complete();
          return 'done';
        },
        runOptions(dir, { signal: controller.signal }),
      ),
    ).resolves.toBe('done');
  });

  it('refuses a platform that has no procfs descriptor directory, without touching the disk', async () => {
    const dir = journalOf(createBase());
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const refusal = await refusalOf(
        withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
      );
      expect(refusal.code).toBe('UNAVAILABLE');
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
    }
    expect(existsSync(dir)).toBe(false);
  });

  it('refuses a host whose procfs descriptor directory is missing', async () => {
    const dir = journalOf(createBase());
    afterNext('existsSync', () => false, pathEnds('/proc/self/fd'));

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(existsSync(dir)).toBe(false);
  });

  it('derives the default directory from HOME, owner-only, and never from the working directory', async () => {
    const base = createBase();
    const home = join(base, 'home');
    mkdirSync(home, { mode: 0o700 });
    chmodSync(home, 0o700);
    const previous = process.env['HOME'];
    process.env['HOME'] = home;
    try {
      const intent = await withCreateIntent(
        bindingOf(),
        SINGLE,
        null,
        async (lease) => {
          lease.complete();
          return lease.intent;
        },
        { now: () => clock },
      );
      expect(intent.operationId).toMatch(UUID_V4);
    } finally {
      if (previous === undefined) delete process.env['HOME'];
      else process.env['HOME'] = previous;
    }

    for (const part of [
      join(home, '.local'),
      join(home, '.local', 'state'),
      join(home, '.local', 'state', 'pto-calendar'),
      join(home, '.local', 'state', 'pto-calendar', 'create-intents'),
    ]) {
      expect(statSync(part).isDirectory()).toBe(true);
      expect(statSync(part).mode & 0o7777).toBe(0o700);
    }
  });

  it('refuses a relative HOME without creating anything under the working directory', async () => {
    const relative = `relative-home-${process.pid}`;
    const previous = process.env['HOME'];
    process.env['HOME'] = relative;
    try {
      const refusal = await refusalOf(
        withCreateIntent(bindingOf(), SINGLE, null, async () => 1, { now: () => clock }),
      );
      expect(refusal.code).toBe('UNAVAILABLE');
    } finally {
      if (previous === undefined) delete process.env['HOME'];
      else process.env['HOME'] = previous;
    }
    expect(existsSync(join(process.cwd(), relative))).toBe(false);
  });

  it('refuses an overlong or too deep HOME as unavailable', async () => {
    const previous = process.env['HOME'];
    for (const home of [`/${'a'.repeat(4100)}`, `/${Array(40).fill('d').join('/')}`]) {
      process.env['HOME'] = home;
      try {
        const refusal = await refusalOf(
          withCreateIntent(bindingOf(), SINGLE, null, async () => 1, { now: () => clock }),
        );
        expect(refusal.code).toBe('UNAVAILABLE');
      } finally {
        if (previous === undefined) delete process.env['HOME'];
        else process.env['HOME'] = previous;
      }
    }
  });
});

/* ------------------------------------------------------------------------- */
/* Pending decisions: what a second invocation may and may not do.            */
/* ------------------------------------------------------------------------- */

describe('pending decisions', () => {
  it('refuses a plain request while pending, reports the pending identifier and deadline, and never dispatches', async () => {
    const dir = journalOf(createBase());
    const pending = await admitPending(dir);
    const before = readFileSync(onlyRecord(dir));
    const act = vi.fn(async () => 'dispatched');

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, act, runOptions(dir)),
    );

    expect(refusal.code).toBe('PENDING');
    expect(refusal.operationId).toBe(pending.operationId);
    expect(refusal.expiresAt).toBe(pending.expiresAt);
    expect(act).not.toHaveBeenCalled();
    expect(readFileSync(onlyRecord(dir))).toEqual(before);
  });

  it('keeps a rotated token on the same owner, so a plain request is still pending', async () => {
    const dir = journalOf(createBase());
    const pending = await admitPending(dir);
    const act = vi.fn(async () => 'dispatched');

    const refusal = await refusalOf(
      withCreateIntent(
        bindingOf({ tokenId: ROTATED_TOKEN_ID, token: ROTATED_TOKEN }),
        SINGLE,
        null,
        act,
        runOptions(dir),
      ),
    );

    expect(refusal.code).toBe('PENDING');
    expect(refusal.operationId).toBe(pending.operationId);
    expect(act).not.toHaveBeenCalled();
  });

  it('resumes the same operation with the stored key when the approved state matches', async () => {
    const dir = journalOf(createBase());
    const pending = await admitPending(dir);
    let resumed: CreateIntent | undefined;

    await withCreateIntent(
      bindingOf(),
      SINGLE,
      pending.operationId,
      async (lease) => {
        resumed = lease.intent;
        lease.complete();
      },
      runOptions(dir),
    );

    expect(resumed).toEqual(pending);
    expect(recordNames(dir)).toEqual([]);
  });

  it('refuses a supplied identifier that differs from the pending one, and names the pending create', async () => {
    const dir = journalOf(createBase());
    const pending = await admitPending(dir);
    const act = vi.fn(async () => 'dispatched');

    const refusal = await refusalOf(
      withCreateIntent(
        bindingOf(),
        SINGLE,
        '9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
        act,
        runOptions(dir),
      ),
    );

    expect(refusal.code).toBe('PENDING');
    expect(refusal.operationId).toBe(pending.operationId);
    expect(act).not.toHaveBeenCalled();
  });

  it('refuses a resume whose approved note differs, as a mismatch that names the pending create', async () => {
    const dir = journalOf(createBase());
    const pending = await admitPending(dir, bindingOf(), payloadOf({ note: 'original' }));
    const act = vi.fn(async () => 'dispatched');

    const refusal = await refusalOf(
      withCreateIntent(
        bindingOf(),
        payloadOf({ note: 'changed' }),
        pending.operationId,
        act,
        runOptions(dir),
      ),
    );

    expect(refusal.code).toBe('MISMATCH');
    expect(refusal.operationId).toBe(pending.operationId);
    expect(refusal.expiresAt).toBe(pending.expiresAt);
    expect(act).not.toHaveBeenCalled();
    expect(recordNames(dir)).toHaveLength(1);
  });

  it('refuses a resume after a token rotation as a mismatch, and keeps the record', async () => {
    const dir = journalOf(createBase());
    const pending = await admitPending(dir);
    const act = vi.fn(async () => 'dispatched');

    const refusal = await refusalOf(
      withCreateIntent(
        bindingOf({ tokenId: ROTATED_TOKEN_ID, token: ROTATED_TOKEN }),
        SINGLE,
        pending.operationId,
        act,
        runOptions(dir),
      ),
    );

    expect(refusal.code).toBe('MISMATCH');
    expect(refusal.operationId).toBe(pending.operationId);
    expect(act).not.toHaveBeenCalled();
    expect(recordNames(dir)).toHaveLength(1);
  });

  it('refuses a resume with the same public identifier and another secret, as a mismatch', async () => {
    const dir = journalOf(createBase());
    const pending = await admitPending(dir);

    const refusal = await refusalOf(
      withCreateIntent(
        bindingOf({ token: SAME_ID_OTHER_SECRET }),
        SINGLE,
        pending.operationId,
        async () => 'dispatched',
        runOptions(dir),
      ),
    );

    expect(refusal.code).toBe('MISMATCH');
    expect(refusal.operationId).toBe(pending.operationId);
  });

  it('refuses a supplied identifier that matches no record, as a mismatch with nothing to report', async () => {
    const dir = journalOf(createBase());
    const refusal = await refusalOf(
      withCreateIntent(
        bindingOf(),
        SINGLE,
        '9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
        async () => 'dispatched',
        runOptions(dir),
      ),
    );
    expect(refusal.code).toBe('MISMATCH');
    expect(refusal.operationId).toBeUndefined();
    expect(refusal.expiresAt).toBeUndefined();
  });

  it('keeps owners separate by origin and by actor', async () => {
    const dir = journalOf(createBase());
    const pending = await admitPending(dir);

    const otherOrigin = await refusalOf(
      withCreateIntent(
        bindingOf({ origin: 'https://other.example.test' }),
        SINGLE,
        pending.operationId,
        async () => 'dispatched',
        runOptions(dir),
      ),
    );
    expect(otherOrigin.code).toBe('MISMATCH');
    expect(otherOrigin.operationId).toBeUndefined();

    const otherActor = await refusalOf(
      withCreateIntent(
        bindingOf({ actorId: OTHER_ACTOR }),
        SINGLE,
        pending.operationId,
        async () => 'dispatched',
        runOptions(dir),
      ),
    );
    expect(otherActor.code).toBe('MISMATCH');

    let fresh: CreateIntent | undefined;
    await withCreateIntent(
      bindingOf({ actorId: OTHER_ACTOR }),
      SINGLE,
      null,
      async (lease) => {
        fresh = lease.intent;
        lease.complete();
      },
      runOptions(dir),
    );
    expect(fresh?.operationId).not.toBe(pending.operationId);
    expect(recordNames(dir)).toHaveLength(1);
  });

  it('refuses a pending record past its deadline for a plain request, without a fresh fallback', async () => {
    const dir = journalOf(createBase());
    const pending = await admitPending(dir);
    clock = NOW + DAY_MS;
    const act = vi.fn(async () => 'dispatched');

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, act, runOptions(dir)),
    );

    expect(refusal.code).toBe('EXPIRED');
    expect(refusal.operationId).toBe(pending.operationId);
    expect(refusal.expiresAt).toBe(pending.expiresAt);
    expect(act).not.toHaveBeenCalled();
  });

  it('refuses an expired record for a resume and for a different supplied identifier alike', async () => {
    const dir = journalOf(createBase());
    const pending = await admitPending(dir);
    clock = NOW + DAY_MS + 1;

    const sameId = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, pending.operationId, async () => 1, runOptions(dir)),
    );
    expect(sameId.code).toBe('EXPIRED');
    expect(sameId.operationId).toBe(pending.operationId);

    const otherId = await refusalOf(
      withCreateIntent(
        bindingOf(),
        SINGLE,
        '9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
        async () => 1,
        runOptions(dir),
      ),
    );
    expect(otherId.code).toBe('EXPIRED');
    expect(otherId.operationId).toBe(pending.operationId);
  });

  it('expires at exactly the deadline, and not one millisecond before it', async () => {
    const dir = journalOf(createBase());
    await admitPending(dir);
    const deadline = Date.parse(readJson(onlyRecord(dir))['expiresAt'] as string);

    clock = deadline - 1;
    expect(
      (await refusalOf(withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir))))
        .code,
    ).toBe('PENDING');

    clock = deadline;
    expect(
      (await refusalOf(withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir))))
        .code,
    ).toBe('EXPIRED');
  });

  it('refuses a future-dated record as unavailable, and accepts the skew bound exactly', async () => {
    const dir = journalOf(createBase());
    clock = NOW + 600_000;
    await admitPending(dir);

    clock = NOW;
    expect(
      (await refusalOf(withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir))))
        .code,
    ).toBe('UNAVAILABLE');

    clock = NOW + 600_000 - 120_000;
    expect(
      (await refusalOf(withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir))))
        .code,
    ).toBe('PENDING');

    clock = NOW + 600_000 - 120_001;
    expect(
      (await refusalOf(withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir))))
        .code,
    ).toBe('UNAVAILABLE');
  });

  it('reports BUSY while another admission holds the owner lock, and does not block other owners', async () => {
    const dir = journalOf(createBase());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withCreateIntent(
      bindingOf(),
      SINGLE,
      null,
      async () => {
        await gate;
        return 'first';
      },
      runOptions(dir),
    );
    expect(lockNames(dir)).toHaveLength(1);

    const act = vi.fn(async () => 'second');
    const busy = await refusalOf(withCreateIntent(bindingOf(), SINGLE, null, act, runOptions(dir)));
    expect(busy.code).toBe('BUSY');
    expect(busy.operationId).toBeUndefined();
    expect(act).not.toHaveBeenCalled();

    await expect(
      withCreateIntent(
        bindingOf({ origin: 'https://other.example.test' }),
        SINGLE,
        null,
        async (lease) => {
          lease.complete();
          return 'other owner';
        },
        runOptions(dir),
      ),
    ).resolves.toBe('other owner');

    release();
    await expect(first).resolves.toBe('first');
    expect(lockNames(dir)).toEqual([]);
  });

  it('reports BUSY for a stale lock directory left behind, and never breaks it', async () => {
    const dir = journalOf(createBase());
    let lockName = '';
    await withCreateIntent(
      bindingOf(),
      SINGLE,
      null,
      async (lease) => {
        lockName = lockNames(dir)[0] ?? '';
        lease.complete();
      },
      runOptions(dir),
    );
    expect(lockName).toMatch(/^\.lock\.owner-[0-9a-f]{64}$/);

    mkdirSync(join(dir, lockName), { mode: 0o700 });
    const busy = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(busy.code).toBe('BUSY');
    expect(lockNames(dir)).toEqual([lockName]);
  });

  it('refuses an owner record that was copied under another owner name, as unavailable', async () => {
    const dir = journalOf(createBase());
    await admitPending(dir, bindingOf({ actorId: OTHER_ACTOR }));
    const otherOwnerRecord = onlyRecord(dir);
    unlinkSync(otherOwnerRecord);
    await admitPending(dir);
    const ownRecord = onlyRecord(dir);
    // The record of the first owner is written over the file that names the second owner.
    rewrite(otherOwnerRecord, readFileSync(ownRecord, 'utf8'));

    const refusal = await refusalOf(
      withCreateIntent(
        bindingOf({ actorId: OTHER_ACTOR }),
        SINGLE,
        null,
        async () => 1,
        runOptions(dir),
      ),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(refusal.operationId).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------- */
/* The lease: what completion may and may not do.                             */
/* ------------------------------------------------------------------------- */

describe('the lease', () => {
  it('refuses to complete after its callback settled, and touches nothing', async () => {
    const dir = journalOf(createBase());
    let late: { complete(): void } | undefined;
    await withCreateIntent(
      bindingOf(),
      SINGLE,
      null,
      async (lease) => {
        late = lease;
      },
      runOptions(dir),
    );
    const before = readFileSync(onlyRecord(dir));

    expect(() => late!.complete()).toThrow(CreateIntentError);
    expect(readFileSync(onlyRecord(dir))).toEqual(before);
  });

  it('reports UNAVAILABLE with the pending identifier when the record was removed externally', async () => {
    const dir = journalOf(createBase());
    let refusal: CreateIntentError | undefined;
    const intent = await withCreateIntent(
      bindingOf(),
      SINGLE,
      null,
      async (lease) => {
        unlinkSync(onlyRecord(dir));
        try {
          lease.complete();
        } catch (error) {
          refusal = error as CreateIntentError;
        }
        return lease.intent;
      },
      runOptions(dir),
    );

    expect(refusal).toBeInstanceOf(CreateIntentError);
    expect(refusal?.code).toBe('UNAVAILABLE');
    expect(refusal?.operationId).toBe(intent.operationId);
    expect(refusal?.expiresAt).toBe(intent.expiresAt);
  });

  it('refuses to complete a record that was replaced by another object, and keeps the other object', async () => {
    const dir = journalOf(createBase());
    let refused = false;
    await withCreateIntent(
      bindingOf(),
      SINGLE,
      null,
      async (lease) => {
        const path = onlyRecord(dir);
        unlinkSync(path);
        rewrite(path, 'someone else');
        try {
          lease.complete();
        } catch {
          refused = true;
        }
      },
      runOptions(dir),
    );

    expect(refused).toBe(true);
    expect(readFileSync(onlyRecord(dir), 'utf8')).toBe('someone else');
  });

  it('refuses to complete a record that has another link, and keeps every link', async () => {
    const dir = journalOf(createBase());
    const copy = join(createBase(), 'copy.json');
    let refused = false;
    await withCreateIntent(
      bindingOf(),
      SINGLE,
      null,
      async (lease) => {
        linkSync(onlyRecord(dir), copy);
        try {
          lease.complete();
        } catch {
          refused = true;
        }
      },
      runOptions(dir),
    );

    expect(refused).toBe(true);
    expect(recordNames(dir)).toHaveLength(1);
    expect(existsSync(copy)).toBe(true);
  });

  it('keeps the record when its removal fails, and a later completion removes it', async () => {
    const dir = journalOf(createBase());
    await withCreateIntent(
      bindingOf(),
      SINGLE,
      null,
      async (lease) => {
        failNext('unlinkSync', 'EIO', pathEnds('.json'));
        expect(() => lease.complete()).toThrow(CreateIntentError);
        expect(recordNames(dir)).toHaveLength(1);
        lease.complete();
      },
      runOptions(dir),
    );

    expect(recordNames(dir)).toEqual([]);
  });

  it('retries only the directory flush when the removal happened but the flush failed', async () => {
    const dir = journalOf(createBase());
    await withCreateIntent(
      bindingOf(),
      SINGLE,
      null,
      async (lease) => {
        failNext('fsyncSync', 'EIO', handleIs(dir));
        let first: CreateIntentError | undefined;
        try {
          lease.complete();
        } catch (error) {
          first = error as CreateIntentError;
        }
        expect(first?.code).toBe('UNAVAILABLE');
        expect(first?.operationId).toBe(lease.intent.operationId);
        expect(recordNames(dir)).toEqual([]);
        expect(() => lease.complete()).not.toThrow();
      },
      runOptions(dir),
    );

    expect(recordNames(dir)).toEqual([]);
  });

  it('returns the callback value when the lock cannot be released, and keeps the lock busy', async () => {
    const dir = journalOf(createBase());
    failNext('rmdirSync', 'EIO', pathHas('/.lock.'));

    const value = await withCreateIntent(
      bindingOf(),
      SINGLE,
      null,
      async (lease) => {
        lease.complete();
        return 'written';
      },
      runOptions(dir),
    );

    expect(value).toBe('written');
    expect(lockNames(dir)).toHaveLength(1);
    const busy = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(busy.code).toBe('BUSY');
  });

  it('keeps the callback error when the lock cannot be released', async () => {
    const dir = journalOf(createBase());
    const boom = new Error('callback failed');
    failNext('rmdirSync', 'EIO', pathHas('/.lock.'));

    await expect(
      withCreateIntent(
        bindingOf(),
        SINGLE,
        null,
        async () => {
          throw boom;
        },
        runOptions(dir),
      ),
    ).rejects.toBe(boom);
    expect(lockNames(dir)).toHaveLength(1);
  });

  it('keeps a lock that the owner replaced during the callback, and never removes it', async () => {
    const dir = journalOf(createBase());
    let lockName = '';
    await expect(
      withCreateIntent(
        bindingOf(),
        SINGLE,
        null,
        async (lease) => {
          lockName = lockNames(dir)[0] ?? '';
          rmdirSync(join(dir, lockName));
          mkdirSync(join(dir, lockName), { mode: 0o700 });
          lease.complete();
          return 'written';
        },
        runOptions(dir),
      ),
    ).resolves.toBe('written');

    expect(lockNames(dir)).toEqual([lockName]);
  });

  it('accepts a lock that the callback released by itself', async () => {
    const dir = journalOf(createBase());
    await expect(
      withCreateIntent(
        bindingOf(),
        SINGLE,
        null,
        async (lease) => {
          rmdirSync(join(dir, lockNames(dir)[0]!));
          lease.complete();
          return 'released';
        },
        runOptions(dir),
      ),
    ).resolves.toBe('released');
  });

  it('keeps the lock when its identity cannot be read on release, and still returns the value', async () => {
    const dir = journalOf(createBase());
    failNext('lstatSync', 'EIO', pathHas('/.lock.'));

    await expect(
      withCreateIntent(
        bindingOf(),
        SINGLE,
        null,
        async (lease) => {
          lease.complete();
          return 'written';
        },
        runOptions(dir),
      ),
    ).resolves.toBe('written');
    expect(lockNames(dir)).toHaveLength(1);
  });

  it('returns the callback value when the store cannot be closed', async () => {
    const dir = journalOf(createBase());
    failClosingNext('closeSync', 'EIO', handleIs(dir));

    await expect(
      withCreateIntent(
        bindingOf(),
        SINGLE,
        null,
        async (lease) => {
          lease.complete();
          return 'written';
        },
        runOptions(dir),
      ),
    ).resolves.toBe('written');
    expect(lockNames(dir)).toEqual([]);
  });
});

/* ------------------------------------------------------------------------- */
/* The store directory trust boundary.                                        */
/* ------------------------------------------------------------------------- */

describe('the store directory', () => {
  it('creates missing components owner-only, each through its own handle', async () => {
    const base = createBase();
    const dir = join(base, 'one', 'two', 'journal');
    await completeCreate(dir);

    for (const path of [join(base, 'one'), join(base, 'one', 'two'), dir]) {
      expect(statSync(path).mode & 0o7777).toBe(0o700);
    }
  });

  it('creates owner-only directories under a restrictive umask', async () => {
    const base = createBase();
    const dir = journalOf(base);
    const previous = process.umask(0o277);
    try {
      await completeCreate(dir);
    } finally {
      process.umask(previous);
    }
    expect(statSync(dir).mode & 0o7777).toBe(0o700);
  });

  it('refuses a store that is a symbolic link', async () => {
    const base = createBase();
    const target = join(base, 'elsewhere');
    mkdirSync(target, { mode: 0o700 });
    chmodSync(target, 0o700);
    symlinkSync(target, journalOf(base));

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(journalOf(base))),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(readdirSync(target)).toEqual([]);
  });

  it('refuses an ancestor that is a symbolic link, and never creates through it', async () => {
    const base = createBase();
    const target = join(base, 'real');
    mkdirSync(target, { mode: 0o700 });
    chmodSync(target, 0o700);
    const link = join(base, 'link');
    symlinkSync(target, link);

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(join(link, 'journal'))),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(readdirSync(target)).toEqual([]);
  });

  it('refuses an ancestor that other users may write without the sticky bit', async () => {
    const base = createBase();
    chmodSync(base, 0o777);

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(journalOf(base))),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
  });

  it('accepts a sticky ancestor that other users may write', async () => {
    const base = createBase();
    chmodSync(base, 0o1777);

    await expect(completeCreate(journalOf(base))).resolves.toMatchObject({
      operationId: expect.stringMatching(UUID_V4),
    });
  });

  it('refuses a store whose ancestor belongs to another user', async () => {
    const base = createBase();
    chmodSync(base, 0o1777);
    afterNext('fstatSync', (stat) => foreignOwner(stat), handleIs(base));

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(journalOf(base))),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
  });

  it('refuses a store that other users may enter', async () => {
    const base = createBase();
    const dir = journalOf(base);
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(recordNames(dir)).toEqual([]);
  });

  it('refuses a store owned by another user', async () => {
    const base = createBase();
    const dir = journalOf(base);
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    afterNext('fstatSync', (stat) => foreignOwner(stat), handleIs(dir));

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
  });

  it('refuses a store path that is a regular file', async () => {
    const base = createBase();
    writeFileSync(journalOf(base), 'not a directory', { mode: 0o600 });

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(journalOf(base))),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
  });

  it('adopts a store that another process creates owner-only', async () => {
    const base = createBase();
    const dir = journalOf(base);
    beforeNext(
      'mkdirSync',
      (args) => {
        mkdirSync(args[0] as string, { mode: 0o700 });
        chmodSync(args[0] as string, 0o700);
      },
      pathEnds('/journal'),
    );

    await expect(completeCreate(dir)).resolves.toMatchObject({
      operationId: expect.stringMatching(UUID_V4),
    });
  });

  it('refuses a store that another process creates with other permissions', async () => {
    const base = createBase();
    const dir = journalOf(base);
    beforeNext(
      'mkdirSync',
      (args) => {
        mkdirSync(args[0] as string, { mode: 0o755 });
        chmodSync(args[0] as string, 0o755);
      },
      pathEnds('/journal'),
    );

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
  });

  it('refuses a store that vanishes right after it was created', async () => {
    const base = createBase();
    afterNext(
      'mkdirSync',
      (result, args) => {
        rmdirSync(args[0] as string);
        return result;
      },
      pathEnds('/journal'),
    );

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(journalOf(base))),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
  });

  it('never changes the mode of a directory that a substituted name points to', async () => {
    const base = createBase();
    const victim = join(base, 'victim');
    mkdirSync(victim, { mode: 0o755 });
    chmodSync(victim, 0o755);
    afterNext(
      'mkdirSync',
      (result, args) => {
        rmdirSync(args[0] as string);
        symlinkSync(victim, args[0] as string);
        return result;
      },
      pathEnds('/journal'),
    );

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(journalOf(base))),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(statSync(victim).mode & 0o7777).toBe(0o755);
  });

  it('maps a failed directory creation to unavailable', async () => {
    const base = createBase();
    failNext('mkdirSync', 'EIO', pathEnds('/journal'));

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(journalOf(base))),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
  });

  it('maps a failed open of the root to unavailable', async () => {
    const base = createBase();
    failNext('openSync', 'EIO', (args) => args[0] === '/');

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(journalOf(base))),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
  });

  it('releases every handle when an ancestor cannot be inspected', async () => {
    const base = createBase();
    mkdirSync(journalOf(base), { mode: 0o700 });
    chmodSync(journalOf(base), 0o700);
    failNext('fstatSync', 'EIO', handleIs(base));

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(journalOf(base))),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
  });

  it('releases the child handle when the parent cannot be closed', async () => {
    const base = createBase();
    mkdirSync(journalOf(base), { mode: 0o700 });
    chmodSync(journalOf(base), 0o700);
    failClosingNext('closeSync', 'EIO', handleIs(base));

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(journalOf(base))),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
  });

  it('releases the created component when its mode cannot be set', async () => {
    const base = createBase();
    failNext('fchmodSync', 'EIO', handleEnds('/journal'));

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(journalOf(base))),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
  });

  it('refuses an ancestor that cannot be read, as unavailable', async () => {
    const base = createBase();
    const locked = join(base, 'locked');
    mkdirSync(locked, { mode: 0o300 });
    chmodSync(locked, 0o300);
    try {
      const refusal = await refusalOf(
        withCreateIntent(
          bindingOf(),
          SINGLE,
          null,
          async () => 1,
          runOptions(join(locked, 'journal')),
        ),
      );
      expect(refusal.code).toBe('UNAVAILABLE');
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});

/* ------------------------------------------------------------------------- */
/* The durability of the path: every name that leads to the record is flushed. */
/* ------------------------------------------------------------------------- */

describe('the durability of the path', () => {
  it('flushes every parent of the journal, from the root down, before it dispatches', async () => {
    const base = createBase();
    const dir = join(base, 'one', 'two', 'journal');
    const chain = componentsOf(base);
    const components = [...chain, join(base, 'one'), join(base, 'one', 'two'), dir];
    const parents = ['/', ...components.slice(0, -1)];
    const created = new Set(components.slice(chain.length));
    // Every component is flushed in its parent, and every component that this
    // run created is flushed in itself, so its owner-only mode is durable too.
    const expected: string[] = [];
    components.forEach((component, index) => {
      if (created.has(component)) expected.push(component);
      expected.push(parents[index]!);
    });
    expected.push('record-bytes', dir, 'dispatch');

    const flushes = recordFlushes();
    await withCreateIntent(
      bindingOf(),
      SINGLE,
      null,
      async () => {
        flushes.order.push('dispatch');
      },
      runOptions(dir),
    );
    flushes.stop();

    expect(flushes.order).toEqual(expected);
  });

  it('flushes the parent of a directory that another process created, and of every reuse of it', async () => {
    const base = createBase();
    const dir = journalOf(base);
    // Another process creates the journal directory before this one does.
    beforeNext(
      'mkdirSync',
      (args) => {
        mkdirSync(args[0] as string, { mode: 0o700 });
        chmodSync(args[0] as string, 0o700);
      },
      pathEnds('/journal'),
    );
    const flushes = recordFlushes();

    await withCreateIntent(
      bindingOf(),
      SINGLE,
      null,
      async (lease) => {
        lease.complete();
      },
      runOptions(dir),
    );
    expect(flushes.order.filter((path) => path === base)).toHaveLength(1);

    // The adopted directory is reused, and its parent is flushed again.
    await withCreateIntent(
      bindingOf(),
      SINGLE,
      null,
      async (lease) => {
        lease.complete();
      },
      runOptions(dir),
    );
    flushes.stop();

    expect(flushes.order.filter((path) => path === base)).toHaveLength(2);
  });

  it('flushes the journal before it dispatches a record that a prior publication linked but did not flush', async () => {
    const dir = journalOf(createBase());
    // The publication links the record, and then the flush of the journal fails.
    failNext('fsyncSync', 'EIO', leafFlush(dir));
    const act = vi.fn(async () => 1);

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, act, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(act).not.toHaveBeenCalled();
    expect(recordNames(dir)).toHaveLength(1);

    const pending = readJson(onlyRecord(dir));
    const flushes = recordFlushes();
    let resumed: CreateIntent | undefined;
    await withCreateIntent(
      bindingOf(),
      SINGLE,
      pending['operationId'] as string,
      async (lease) => {
        resumed = lease.intent;
        flushes.order.push('dispatch');
        lease.complete();
      },
      runOptions(dir),
    );
    flushes.stop();

    // The same operation and the same key are used, and the journal was flushed
    // before the dispatch.
    expect(resumed?.operationId).toBe(pending['operationId']);
    expect(resumed?.key).toBe(pending['key']);
    expect(flushes.order.indexOf(dir)).toBeGreaterThanOrEqual(0);
    expect(flushes.order.indexOf(dir)).toBeLessThan(flushes.order.indexOf('dispatch'));
  });

  it('refuses a resume whose journal cannot be flushed, and keeps the same operation for the next attempt', async () => {
    const dir = journalOf(createBase());
    const pending = await admitPending(dir);
    failNext('fsyncSync', 'EIO', leafFlush(dir));
    const act = vi.fn(async () => 1);

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, pending.operationId, act, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(refusal.operationId).toBe(pending.operationId);
    expect(refusal.expiresAt).toBe(pending.expiresAt);
    expect(act).not.toHaveBeenCalled();
    expect(recordNames(dir)).toHaveLength(1);
    expect(lockNames(dir)).toEqual([]);

    // The next attempt resumes the same operation with the same key.
    let resumed: CreateIntent | undefined;
    await withCreateIntent(
      bindingOf(),
      SINGLE,
      pending.operationId,
      async (lease) => {
        resumed = lease.intent;
        lease.complete();
      },
      runOptions(dir),
    );
    expect(resumed?.operationId).toBe(pending.operationId);
    expect(resumed?.key).toBe(pending.key);
  });

  it('fails closed when the flush of a parent of the journal fails, and publishes nothing', async () => {
    const base = createBase();
    const dir = journalOf(base);
    failNext('fsyncSync', 'EIO', handleIs(base));
    const act = vi.fn(async () => 1);

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, act, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(act).not.toHaveBeenCalled();
    expect(recordNames(dir)).toEqual([]);
    expect(lockNames(dir)).toEqual([]);
  });

  it('fails closed when the flush of a new journal directory fails, and publishes nothing', async () => {
    const dir = journalOf(createBase());
    failNext('fsyncSync', 'EIO', handleIs(dir));
    const act = vi.fn(async () => 1);

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, act, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(act).not.toHaveBeenCalled();
    expect(recordNames(dir)).toEqual([]);
    expect(lockNames(dir)).toEqual([]);
  });

  it('fails closed when the flush of any directory on the path fails', async () => {
    const depth = componentsOf(createBase()).length;
    // Every flush of a nested path: the parent of every component, and every
    // directory that this run creates. The first flush of a directory is its own
    // mode, and the second one is the name of the directory below it.
    const cases: Array<{ readonly at: number; readonly suffix: string; readonly nth: number }> = [
      { at: -1, suffix: '', nth: 1 },
    ];
    for (let index = 0; index < depth; index += 1) cases.push({ at: index, suffix: '', nth: 1 });
    cases.push({ at: depth - 1, suffix: '/one', nth: 1 });
    cases.push({ at: depth - 1, suffix: '/one', nth: 2 });
    cases.push({ at: depth - 1, suffix: '/one/two', nth: 1 });
    cases.push({ at: depth - 1, suffix: '/one/two', nth: 2 });
    cases.push({ at: depth - 1, suffix: '/one/two/journal', nth: 1 });

    for (const testCase of cases) {
      const base = createBase();
      const dir = join(base, 'one', 'two', 'journal');
      const chain = componentsOf(base);
      const descriptor = testCase.at < 0 ? '/' : `${chain[testCase.at]!}${testCase.suffix}`;
      failNext('fsyncSync', 'EIO', nthCall(testCase.nth, handleIs(descriptor)));
      const act = vi.fn(async () => 1);

      const refusal = await refusalOf(
        withCreateIntent(bindingOf(), SINGLE, null, act, runOptions(dir)),
      );
      expect(refusal.code).toBe('UNAVAILABLE');
      expect(act).not.toHaveBeenCalled();
      expect(existsSync(dir) ? lockNames(dir) : []).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------------- */
/* The record trust boundary.                                                 */
/* ------------------------------------------------------------------------- */

describe('the record', () => {
  it('refuses a record that is a symbolic link, and never follows it', async () => {
    const dir = journalOf(createBase());
    await admitPending(dir);
    const path = onlyRecord(dir);
    const content = readFileSync(path, 'utf8');
    const target = join(dir, '..', 'elsewhere.json');
    writeFileSync(target, content, { mode: 0o600 });
    unlinkSync(path);
    symlinkSync(target, path);

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(readFileSync(target, 'utf8')).toBe(content);
  });

  it('refuses a record that is a hard link', async () => {
    const dir = journalOf(createBase());
    await admitPending(dir);
    const path = onlyRecord(dir);
    const copy = join(dir, '..', 'copy.json');
    linkSync(path, copy);

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(existsSync(copy)).toBe(true);
  });

  it('refuses a record that is a directory', async () => {
    const dir = journalOf(createBase());
    await admitPending(dir);
    const path = onlyRecord(dir);
    unlinkSync(path);
    mkdirSync(path, { mode: 0o700 });

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(statSync(path).isDirectory()).toBe(true);
  });

  it('refuses a record that is a FIFO, without waiting for a writer', async () => {
    const dir = journalOf(createBase());
    await admitPending(dir);
    const path = onlyRecord(dir);
    unlinkSync(path);
    execFileSync('mkfifo', [path]);

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(lstatSync(path).isFIFO()).toBe(true);
  });

  it('refuses a record that other users may read', async () => {
    const dir = journalOf(createBase());
    await admitPending(dir);
    chmodSync(onlyRecord(dir), 0o644);

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
  });

  it('refuses a record that belongs to another user, through its descriptor', async () => {
    const dir = journalOf(createBase());
    await admitPending(dir);
    afterNext('fstatSync', (stat) => foreignOwner(stat), handleEnds('.json'));

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
  });

  it('refuses a record larger than its bound, and accepts one of exactly the bound', async () => {
    const dir = journalOf(createBase());
    await admitPending(dir);
    const path = onlyRecord(dir);
    const record = readFileSync(path, 'utf8');

    rewrite(path, `${record}${' '.repeat(2049 - record.length)}`);
    expect(
      (await refusalOf(withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir))))
        .code,
    ).toBe('UNAVAILABLE');

    rewrite(path, `${record}${' '.repeat(2048 - record.length)}`);
    expect(
      (await refusalOf(withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir))))
        .code,
    ).toBe('PENDING');
  });

  it('reads a record that the system returns in pieces', async () => {
    const dir = journalOf(createBase());
    const pending = await admitPending(dir);
    afterNext('readSync', (count) => Math.min(count as number, 7), handleEnds('.json'));

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('PENDING');
    expect(refusal.operationId).toBe(pending.operationId);
  });

  it('maps a record that cannot be opened to unavailable', async () => {
    const dir = journalOf(createBase());
    await admitPending(dir);
    failNext('openSync', 'EIO', pathEnds('.json'));

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
  });

  it('maps a record that cannot be inspected to unavailable, and releases its handle', async () => {
    const dir = journalOf(createBase());
    await admitPending(dir);
    failNext('fstatSync', 'EIO', handleEnds('.json'));

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
  });

  it('maps a record that cannot be read to unavailable, and releases its handle', async () => {
    const dir = journalOf(createBase());
    await admitPending(dir);
    failNext('readSync', 'EIO', handleEnds('.json'));

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
  });

  it('maps a failure without a system code to unavailable, never to an absent record', async () => {
    const dir = journalOf(createBase());
    await admitPending(dir);
    failNextWithoutCode('openSync', pathEnds('.json'));

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
  });

  it.each([
    ['is not JSON', () => '{"version":'],
    ['is a JSON array', () => '[]'],
    ['is a JSON string', () => '"record"'],
    ['carries an extra field', (r: Record<string, unknown>) => JSON.stringify({ ...r, extra: 1 })],
    [
      'lacks a field',
      (r: Record<string, unknown>) => {
        const { digest: _digest, ...rest } = r;
        return JSON.stringify(rest);
      },
    ],
    ['has another version', (r: Record<string, unknown>) => JSON.stringify({ ...r, version: 2 })],
    [
      'has a version 1 operation identifier',
      (r: Record<string, unknown>) =>
        JSON.stringify({ ...r, operationId: '6f1d4c8e-2b3a-1d5e-8f70-112233445566' }),
    ],
    [
      'has an uppercase operation identifier',
      (r: Record<string, unknown>) =>
        JSON.stringify({ ...r, operationId: String(r['operationId']).toUpperCase() }),
    ],
    [
      'has a key of another shape',
      (r: Record<string, unknown>) => JSON.stringify({ ...r, key: 'v1.short' }),
    ],
    [
      'has a key with a leading zero timestamp',
      (r: Record<string, unknown>) =>
        JSON.stringify({ ...r, key: String(r['key']).replace(/^v1\.\d/, 'v1.0') }),
    ],
    [
      'has an expiry that does not match its key',
      (r: Record<string, unknown>) =>
        JSON.stringify({ ...r, expiresAt: '2030-01-01T00:00:00.000Z' }),
    ],
    [
      'has an expiry in another form',
      (r: Record<string, unknown>) =>
        JSON.stringify({ ...r, expiresAt: String(r['expiresAt']).replace('.000Z', 'Z') }),
    ],
    [
      'names an origin that is not trusted',
      (r: Record<string, unknown>) => JSON.stringify({ ...r, origin: 'http://pto.example.test' }),
    ],
    [
      'names an origin with a trailing slash',
      (r: Record<string, unknown>) => JSON.stringify({ ...r, origin: `${String(r['origin'])}/` }),
    ],
    [
      'stores an uppercase actor identifier',
      (r: Record<string, unknown>) =>
        JSON.stringify({ ...r, actorId: String(r['actorId']).toUpperCase() }),
    ],
    [
      'stores an invalid token identifier',
      (r: Record<string, unknown>) => JSON.stringify({ ...r, tokenId: 'nope' }),
    ],
    [
      'stores a non-hexadecimal digest',
      (r: Record<string, unknown>) => JSON.stringify({ ...r, digest: 'z'.repeat(64) }),
    ],
    [
      'stores a short digest',
      (r: Record<string, unknown>) => JSON.stringify({ ...r, digest: 'a'.repeat(63) }),
    ],
    [
      'stores a digest that is not a string',
      (r: Record<string, unknown>) => JSON.stringify({ ...r, digest: 7 }),
    ],
    [
      'stores an expiry that is not a string',
      (r: Record<string, unknown>) => JSON.stringify({ ...r, expiresAt: 7 }),
    ],
    [
      'stores a key that is not text',
      (r: Record<string, unknown>) => JSON.stringify({ ...r, key: 7 }),
    ],
  ])('refuses a record that %s, as unavailable', async (_label, replace) => {
    const dir = journalOf(createBase());
    await admitPending(dir);
    const path = onlyRecord(dir);
    const record = readJson(path);
    rewrite(path, replace(record));

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(refusal.operationId).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------- */
/* Publication: a failed publish never dispatches and never overwrites.       */
/* ------------------------------------------------------------------------- */

describe('publication', () => {
  it('maps a failed stage creation to unavailable, without leaving a record', async () => {
    const dir = journalOf(createBase());
    failNext('openSync', 'EIO', pathHas('/.stage.'));
    const act = vi.fn(async () => 1);

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, act, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(act).not.toHaveBeenCalled();
    expect(recordNames(dir)).toEqual([]);
    expect(stageNames(dir)).toEqual([]);
    expect(lockNames(dir)).toEqual([]);
  });

  it('keeps an uninspectable stage in place rather than removing it by name', async () => {
    const dir = journalOf(createBase());
    failNext('fstatSync', 'EIO', handleHas('/.stage.'));

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(stageNames(dir)).toHaveLength(1);
    expect(recordNames(dir)).toEqual([]);
  });

  it.each([
    ['a failed mode change', 'fchmodSync', 'EIO'],
    ['a failed write', 'writeFileSync', 'ENOSPC'],
    ['a failed flush of the stage', 'fsyncSync', 'EIO'],
  ])('discards its stage after %s', async (_label, call, code) => {
    const dir = journalOf(createBase());
    failNext(call, code, handleHas('/.stage.'));

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(stageNames(dir)).toEqual([]);
    expect(recordNames(dir)).toEqual([]);
  });

  it('refuses a stage whose descriptor is not an owner-only single-link file', async () => {
    const dir = journalOf(createBase());
    afterNext('fstatSync', (stat) => foreignOwner(stat), nthCall(2, handleHas('/.stage.')));

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(stageNames(dir)).toEqual([]);
    expect(recordNames(dir)).toEqual([]);
  });

  it('discards its stage when the stage name changes before the link', async () => {
    const base = createBase();
    const dir = journalOf(base);
    beforeNext(
      'lstatSync',
      (args) => {
        const stagePath = args[0] as string;
        renameSync(stagePath, join(base, 'moved.tmp'));
        writeFileSync(stagePath, 'decoy', { mode: 0o600 });
      },
      nthCall(1, pathHas('/.stage.')),
    );

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(recordNames(dir)).toEqual([]);
    // The decoy is never taken over and is never removed.
    expect(stageNames(dir)).toHaveLength(1);
    expect(readFileSync(join(dir, stageNames(dir)[0]!), 'utf8')).toBe('decoy');
  });

  it('never overwrites a record that appears before the link', async () => {
    const dir = journalOf(createBase());
    await completeCreate(dir);
    beforeNext(
      'linkSync',
      (args) => {
        writeFileSync(args[1] as string, 'foreign', { mode: 0o600 });
      },
      pathEnds('.json', 1),
    );

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(recordNames(dir).map((name) => readFileSync(join(dir, name), 'utf8'))).toEqual([
      'foreign',
    ]);
    expect(stageNames(dir)).toEqual([]);
  });

  it('discards its stage after a failed link', async () => {
    const dir = journalOf(createBase());
    failNext('linkSync', 'EIO', pathEnds('.json', 1));

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(stageNames(dir)).toEqual([]);
    expect(recordNames(dir)).toEqual([]);
  });

  it('keeps the published record and refuses to dispatch when the stage name changes after the link', async () => {
    const base = createBase();
    const dir = journalOf(base);
    afterNext(
      'linkSync',
      (result, args) => {
        renameSync(args[0] as string, join(base, 'moved-stage.tmp'));
        writeFileSync(args[0] as string, 'decoy', { mode: 0o600 });
        return result;
      },
      pathEnds('.json', 1),
    );
    const act = vi.fn(async () => 1);

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, act, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(act).not.toHaveBeenCalled();
    // The published object has a second name, so it is never trusted again.
    const again = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(again.code).toBe('UNAVAILABLE');
  });

  it('keeps an unremovable stage in place when a failed link cannot be cleaned up by name', async () => {
    const dir = journalOf(createBase());
    failNext('linkSync', 'EIO', pathEnds('.json', 1));
    failNext('unlinkSync', 'EIO', pathHas('/.stage.'));

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(stageNames(dir)).toHaveLength(1);
    expect(recordNames(dir)).toEqual([]);
  });

  it('keeps a published record when the stage name cannot be removed after the link', async () => {
    const dir = journalOf(createBase());
    const act = vi.fn(async () => 1);
    failNext('unlinkSync', 'EIO', pathHas('/.stage.'));

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, act, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(act).not.toHaveBeenCalled();
    expect(stageNames(dir)).toEqual([]);
    expect(recordNames(dir)).toHaveLength(1);

    const pending = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, act, runOptions(dir)),
    );
    expect(pending.code).toBe('PENDING');
    expect(act).not.toHaveBeenCalled();
  });

  it('keeps a published record and refuses to dispatch when the directory flush fails', async () => {
    const dir = journalOf(createBase());
    failNext('fsyncSync', 'EIO', leafFlush(dir));
    const act = vi.fn(async () => 1);

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, act, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(act).not.toHaveBeenCalled();
    expect(recordNames(dir)).toHaveLength(1);
    expect(lockNames(dir)).toEqual([]);
  });

  it('refuses to dispatch when the published target changes after the unlink', async () => {
    const base = createBase();
    const dir = journalOf(base);
    afterNext(
      'unlinkSync',
      (result) => {
        const target = onlyRecordFromEntries(dir);
        renameSync(target, join(base, 'moved-record.tmp'));
        writeFileSync(target, 'decoy', { mode: 0o600 });
        return result;
      },
      pathHas('/.stage.'),
    );
    const act = vi.fn(async () => 1);

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, act, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(act).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, recordNames(dir)[0]!), 'utf8')).toBe('decoy');
    expect(readFileSync(join(base, 'moved-record.tmp'), 'utf8')).toContain('"version":1');
  });
});

/** The record path of a journal directory without asserting its count. */
function onlyRecordFromEntries(dir: string): string {
  return join(dir, recordNames(dir)[0] ?? '');
}

/* ------------------------------------------------------------------------- */
/* The owner lock.                                                            */
/* ------------------------------------------------------------------------- */

describe('the owner lock', () => {
  it('maps a failed lock creation to unavailable, without a record', async () => {
    const dir = journalOf(createBase());
    failNext('mkdirSync', 'EIO', pathHas('/.lock.'));

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(recordNames(dir)).toEqual([]);
  });

  it('keeps an unopenable lock in place and reports unavailable', async () => {
    const dir = journalOf(createBase());
    failNext('openSync', 'EIO', pathHas('/.lock.'));

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(lockNames(dir)).toHaveLength(1);
  });

  it('keeps an unidentified lock in place when its descriptor cannot be inspected', async () => {
    const dir = journalOf(createBase());
    failNext('fstatSync', 'EIO', handleHas('/.lock.'));

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(lockNames(dir)).toHaveLength(1);
  });

  it('keeps a lock owned by another user in place, and never runs the callback', async () => {
    const dir = journalOf(createBase());
    afterNext('fstatSync', (stat) => foreignOwner(stat), handleHas('/.lock.'));
    const act = vi.fn(async () => 1);

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, act, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(act).not.toHaveBeenCalled();
    expect(lockNames(dir)).toHaveLength(1);
  });

  it('removes a lock it created when its mode cannot be set', async () => {
    const dir = journalOf(createBase());
    failNext('fchmodSync', 'EIO', handleHas('/.lock.'));

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(lockNames(dir)).toEqual([]);
  });

  it('keeps a lock busy when a failed acquisition cannot remove it', async () => {
    const dir = journalOf(createBase());
    failNext('fchmodSync', 'EIO', handleHas('/.lock.'));
    failNext('rmdirSync', 'EIO', pathHas('/.lock.'));

    const refusal = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(lockNames(dir)).toHaveLength(1);
    const busy = await refusalOf(
      withCreateIntent(bindingOf(), SINGLE, null, async () => 1, runOptions(dir)),
    );
    expect(busy.code).toBe('BUSY');
  });

  it('keeps a lock whose identity cannot be read on a failed release, and never reports it as an outcome', async () => {
    const dir = journalOf(createBase());
    const boom = new Error('callback failed');
    failNext('lstatSync', 'EIO', pathHas('/.lock.'));

    await expect(
      withCreateIntent(
        bindingOf(),
        SINGLE,
        null,
        async () => {
          throw boom;
        },
        runOptions(dir),
      ),
    ).rejects.toBe(boom);
    expect(lockNames(dir)).toHaveLength(1);
  });
});
