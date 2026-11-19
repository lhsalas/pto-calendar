import { describe, expect, it } from 'vitest';

import { AgentAuthError, type AgentAuthErrorCode } from '../src/errors.js';
import { createAgentAuth } from '../src/index.js';
import type { StoredProfile } from '../src/validation.js';
import {
  AGENT_AUTH_GUIDANCE,
  createProfileFacade,
  resolveDirectory,
  type AgentAuth,
  type AgentAuthEnvironment,
  type KeyringPort,
  type ProfileFilePort,
  type ProfileFilesPort,
  type SetProfileInput,
  type StatusInput,
} from '../src/profiles.js';

/** A fake credential. It is never a real token. */
const TOKEN = `pto_pat_11111111-1111-4111-8111-111111111111.${'a'.repeat(64)}`;
const OTHER_TOKEN = `pto_pat_22222222-2222-4222-8222-222222222222.${'b'.repeat(64)}`;
const ORIGIN = 'https://pto.example.com';
const OTHER_ORIGIN = 'https://other.example.com';
const LOOPBACK = 'http://localhost:3000';

/** A synthetic directory. It is never created and never read. */
const SYNTHETIC_DIRECTORY = '/tmp/opencode/pto-260/lane-c-synthetic-home/agent-auth';

function entryKey(profile: string, origin: string): string {
  return `${profile}|${origin}`;
}

/** The record of one profile, held in memory. */
class FakeFile implements ProfileFilePort {
  record: StoredProfile | null = null;
  writes = 0;
  removals = 0;
  /** What the store confirms when the record is removed. */
  removeResult = true;
  /** What the store does after it read the record. */
  afterRead: (() => void) | null = null;

  constructor(private readonly events: string[]) {}

  async read(): Promise<StoredProfile | null> {
    if (this.afterRead !== null) this.afterRead();
    return this.record;
  }

  async write(value: StoredProfile): Promise<void> {
    this.record = value;
    this.writes += 1;
    this.events.push('write:metadata');
  }

  async remove(): Promise<boolean> {
    this.record = null;
    this.removals += 1;
    this.events.push('remove:metadata');
    return this.removeResult;
  }
}

/** The locked profile store, held in memory. */
class FakeFiles implements ProfileFilesPort {
  readonly records = new Map<string, FakeFile>();
  /** What the store does after it read a record. */
  afterRead: (() => void) | null = null;

  constructor(private readonly events: string[]) {}

  async withProfile<T>(
    name: string,
    createDirectory: boolean,
    action: (file: ProfileFilePort) => Promise<T>,
  ): Promise<T> {
    this.events.push(`lock:${name}:${createDirectory}`);
    let file = this.records.get(name);
    if (file === undefined) {
      file = new FakeFile(this.events);
      this.records.set(name, file);
    }
    // The hook of the store is applied to the record of this call.
    file.afterRead = this.afterRead;
    // The lock of the profile is released even when the action fails, exactly
    // like the real store does.
    try {
      return await action(file);
    } finally {
      this.events.push(`unlock:${name}`);
    }
  }
}

/** The operating system credential store, held in memory. */
class FakeKeyring implements KeyringPort {
  readonly entries = new Map<string, string>();
  getFailure: Error | null = null;
  setFailure: Error | null = null;
  removeFailure: Error | null = null;
  /** The signals the credential store was asked with. */
  readonly signals: (AbortSignal | undefined)[] = [];
  /** What the credential store does after it was asked. */
  afterGet: (() => void) | null = null;

  constructor(private readonly events: string[]) {}

  async get(profile: string, origin: string, signal?: AbortSignal): Promise<string | null> {
    this.events.push('keyring:get');
    this.signals.push(signal);
    if (this.afterGet !== null) this.afterGet();
    if (this.getFailure !== null) throw this.getFailure;
    return this.entries.get(entryKey(profile, origin)) ?? null;
  }

  async set(profile: string, origin: string, token: string): Promise<void> {
    this.events.push('keyring:set');
    if (this.setFailure !== null) throw this.setFailure;
    this.entries.set(entryKey(profile, origin), token);
  }

  async remove(profile: string, origin: string): Promise<boolean> {
    this.events.push('keyring:remove');
    if (this.removeFailure !== null) throw this.removeFailure;
    return this.entries.delete(entryKey(profile, origin));
  }
}

interface Harness {
  readonly auth: AgentAuth;
  readonly files: FakeFiles;
  readonly keyring: FakeKeyring;
  readonly events: string[];
}

function createHarness(): Harness {
  const events: string[] = [];
  const files = new FakeFiles(events);
  const keyring = new FakeKeyring(events);
  const auth = createProfileFacade(
    { createFiles: () => files, createKeyring: () => keyring },
    { directory: SYNTHETIC_DIRECTORY },
  );
  return { auth, files, keyring, events };
}

/** Asserts the fixed code of a failure. */
async function expectCode(promise: Promise<unknown>, code: AgentAuthErrorCode): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('storing a profile', () => {
  it('keeps the credential out of the file store by default', async () => {
    const { auth, files, keyring, events } = createHarness();

    const result = await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });

    expect(result).toEqual({
      profile: 'work',
      origin: ORIGIN,
      source: 'keyring',
      allowLoopbackHttp: false,
    });
    const record = files.records.get('work')?.record;
    expect(record).toEqual({
      version: 1,
      profile: 'work',
      origin: ORIGIN,
      allowLoopbackHttp: false,
      storage: 'keyring',
    });
    expect(JSON.stringify(record)).not.toContain(TOKEN);
    expect(keyring.entries.get(entryKey('work', ORIGIN))).toBe(TOKEN);
    // The policy is written before the credential is stored.
    expect(events.indexOf('write:metadata')).toBeLessThan(events.indexOf('keyring:set'));
  });

  it('writes a plaintext credential only when the file store is chosen', async () => {
    const { auth, files, keyring } = createHarness();

    const result = await auth.setProfile({
      profile: 'work',
      baseUrl: ORIGIN,
      token: TOKEN,
      storage: 'file',
    });

    expect(result.source).toBe('file');
    expect(files.records.get('work')?.record).toEqual({
      version: 1,
      profile: 'work',
      origin: ORIGIN,
      allowLoopbackHttp: false,
      storage: 'file',
      token: TOKEN,
    });
    expect(keyring.entries.size).toBe(0);
  });

  it('refuses to change the origin of a configured profile', async () => {
    const { auth } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });

    await expectCode(
      auth.setProfile({ profile: 'work', baseUrl: OTHER_ORIGIN, token: OTHER_TOKEN }),
      'PROFILE_CONFLICT',
    );
  });

  it('refuses to change the store of a configured profile', async () => {
    const { auth } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });

    await expectCode(
      auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN, storage: 'file' }),
      'PROFILE_CONFLICT',
    );
    const other = createHarness();
    await other.auth.setProfile({
      profile: 'work',
      baseUrl: ORIGIN,
      token: TOKEN,
      storage: 'file',
    });
    await expectCode(
      other.auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: OTHER_TOKEN }),
      'PROFILE_CONFLICT',
    );
  });

  it('replaces the credential of a profile that keeps its origin and store', async () => {
    const { auth, files, keyring } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });

    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: OTHER_TOKEN });

    expect(files.records.get('work')?.writes).toBe(2);
    expect(keyring.entries.get(entryKey('work', ORIGIN))).toBe(OTHER_TOKEN);
  });

  it('replaces a plaintext credential that keeps its origin and store', async () => {
    const { auth, files } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN, storage: 'file' });

    await auth.setProfile({
      profile: 'work',
      baseUrl: ORIGIN,
      token: OTHER_TOKEN,
      storage: 'file',
    });

    expect(files.records.get('work')?.writes).toBe(2);
    expect(files.records.get('work')?.record).toMatchObject({ token: OTHER_TOKEN });
  });

  it('keeps the policy when the credential store refuses the credential', async () => {
    const { auth, files, keyring } = createHarness();
    keyring.setFailure = new AgentAuthError('KEYRING_LOCKED');

    await expectCode(
      auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN }),
      'KEYRING_LOCKED',
    );

    // The outcome of the refused write is unknown, so the binding is kept.
    // No plaintext store and no second credential store is tried.
    expect(files.records.get('work')?.record).toEqual({
      version: 1,
      profile: 'work',
      origin: ORIGIN,
      allowLoopbackHttp: false,
      storage: 'keyring',
    });
    expect(files.records.get('work')?.removals).toBe(0);
    expect(keyring.entries.size).toBe(0);
    // The readiness check asks the credential store what is really there.
    const status = await auth.status({ profile: 'work' });
    expect(status.ready).toBe(false);
    expect(status.guidance).toBe(AGENT_AUTH_GUIDANCE.credentialMissing);
  });

  it('keeps the policy when the credential store refuses a replacement', async () => {
    const { auth, files, keyring } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });
    keyring.setFailure = new AgentAuthError('KEYRING_UNAVAILABLE');

    await expectCode(
      auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: OTHER_TOKEN }),
      'KEYRING_UNAVAILABLE',
    );

    expect(files.records.get('work')?.record).not.toBeNull();
  });

  it('refuses a name, a secret, a store and a flag it cannot use', async () => {
    const { auth } = createHarness();

    await expectCode(
      auth.setProfile({ profile: 'Not A Name', baseUrl: ORIGIN, token: TOKEN }),
      'INVALID_PROFILE',
    );
    await expectCode(
      auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: 'nope' }),
      'INVALID_TOKEN',
    );
    await expectCode(
      auth.setProfile({
        profile: 'work',
        baseUrl: ORIGIN,
        token: TOKEN,
        storage: 'vault' as 'file',
      }),
      'INVALID_OPTIONS',
    );
    await expectCode(
      auth.setProfile({
        profile: 'work',
        baseUrl: ORIGIN,
        token: TOKEN,
        allowLoopbackHttp: 'yes' as unknown as boolean,
      }),
      'INVALID_OPTIONS',
    );
    await expectCode(
      auth.setProfile({ profile: 'work', baseUrl: 'not an origin', token: TOKEN }),
      'INVALID_ORIGIN',
    );
    await expectCode(auth.setProfile(null as unknown as SetProfileInput), 'INVALID_OPTIONS');
  });

  it('normalizes the origin it stores', async () => {
    const { auth, files } = createHarness();

    const result = await auth.setProfile({
      profile: 'work',
      baseUrl: 'HTTPS://PTO.Example.com',
      token: TOKEN,
    });

    expect(result.origin).toBe(ORIGIN);
    expect(files.records.get('work')?.record?.origin).toBe(ORIGIN);
  });
});

describe('resolving a credential', () => {
  it('resolves a keyring profile into a frozen bundle', async () => {
    const { auth } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });

    const bundle = await auth.resolve({ profile: 'work' });

    expect(bundle).toEqual({
      baseUrl: ORIGIN,
      credential: { origin: ORIGIN, token: TOKEN },
      allowLoopbackHttp: false,
      profile: 'work',
      source: 'keyring',
    });
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.credential)).toBe(true);
  });

  it('resolves a file profile', async () => {
    const { auth } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN, storage: 'file' });

    const bundle = await auth.resolve({ profile: 'work' });

    expect(bundle.source).toBe('file');
    expect(bundle.credential.token).toBe(TOKEN);
  });

  it('reads the credential while the lock of the profile is held', async () => {
    const { auth, events } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });
    events.length = 0;

    await auth.resolve({ profile: 'work' });

    // The credential store is only asked while the profile is locked, so no
    // other writer can change the binding in between.
    expect(events).toEqual(['lock:work:false', 'keyring:get', 'unlock:work']);
  });

  it('reports the credential while the lock of the profile is held', async () => {
    const { auth, events } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });
    events.length = 0;

    await auth.status({ profile: 'work' });

    expect(events).toEqual(['lock:work:false', 'keyring:get', 'unlock:work']);
  });

  it('uses the default profile when none is named', async () => {
    const { auth } = createHarness();
    await auth.setProfile({ profile: 'default', baseUrl: ORIGIN, token: TOKEN });

    const bundle = await auth.resolve();

    expect(bundle.profile).toBe('default');
    expect(bundle.source).toBe('keyring');
  });

  it('reports a profile that is not configured', async () => {
    const { auth } = createHarness();

    await expectCode(auth.resolve({ profile: 'missing' }), 'PROFILE_NOT_CONFIGURED');
  });

  it('reports a credential that is not present', async () => {
    const { auth, keyring } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });
    keyring.entries.clear();

    await expectCode(auth.resolve({ profile: 'work' }), 'CREDENTIAL_MISSING');
  });

  it('never falls back to another store when the credential store refuses', async () => {
    const { auth, keyring } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });
    keyring.getFailure = new AgentAuthError('KEYRING_LOCKED');

    await expectCode(auth.resolve({ profile: 'work' }), 'KEYRING_LOCKED');

    keyring.getFailure = new AgentAuthError('KEYRING_UNAVAILABLE');
    await expectCode(auth.resolve({ profile: 'work' }), 'KEYRING_UNAVAILABLE');

    keyring.getFailure = new AgentAuthError('KEYRING_FAILED');
    await expectCode(auth.resolve({ profile: 'work' }), 'KEYRING_FAILED');

    keyring.getFailure = new AgentAuthError('KEYRING_AMBIGUOUS');
    await expectCode(auth.resolve({ profile: 'work' }), 'KEYRING_AMBIGUOUS');
  });

  it('refuses an explicit profile together with an environment record', async () => {
    const { auth } = createHarness();
    const env = { PTO_API_ORIGIN: ORIGIN, PTO_API_TOKEN: TOKEN };

    await expectCode(auth.resolve({ profile: 'work', env }), 'AMBIGUOUS_CREDENTIALS');
    await expectCode(
      auth.resolve({ profile: 'work', env: { PTO_API_ORIGIN: ORIGIN } }),
      'AMBIGUOUS_CREDENTIALS',
    );
    await expectCode(
      auth.resolve({ profile: 'work', env: { PTO_API_TOKEN: TOKEN } }),
      'AMBIGUOUS_CREDENTIALS',
    );
    // A field that was named at all is a field, even when it is empty.
    await expectCode(
      auth.resolve({ profile: 'work', env: { PTO_API_ORIGIN: '', PTO_API_TOKEN: '' } }),
      'AMBIGUOUS_CREDENTIALS',
    );
    await expectCode(
      auth.status({ profile: 'work', env: { PTO_API_ORIGIN: ORIGIN } }),
      'AMBIGUOUS_CREDENTIALS',
    );
  });

  it('resolves an environment pair as a runtime only credential', async () => {
    const { auth, events } = createHarness();

    const bundle = await auth.resolve({
      env: { PTO_API_ORIGIN: ORIGIN, PTO_API_TOKEN: TOKEN },
    });

    expect(bundle).toEqual({
      baseUrl: ORIGIN,
      credential: { origin: ORIGIN, token: TOKEN },
      allowLoopbackHttp: false,
      profile: null,
      source: 'environment',
    });
    // The local store is neither read nor written.
    expect(events).toEqual([]);
  });

  it('refuses an environment record that names only one field', async () => {
    const { auth } = createHarness();

    await expectCode(auth.resolve({ env: { PTO_API_ORIGIN: ORIGIN } }), 'INVALID_OPTIONS');
    await expectCode(auth.resolve({ env: { PTO_API_TOKEN: TOKEN } }), 'INVALID_OPTIONS');
  });

  it('ignores an environment record that names no field', async () => {
    const { auth } = createHarness();

    await expectCode(auth.resolve({ env: {} }), 'PROFILE_NOT_CONFIGURED');
    await expectCode(auth.resolve({ env: { OTHER: 'value' } }), 'PROFILE_NOT_CONFIGURED');
  });

  it('never falls back when a runtime record carries the field without a value', async () => {
    const { auth } = createHarness();

    // The field is named, so the record was provided: it is never read as an
    // absent one and it never falls back to the local store.
    await expectCode(
      auth.resolve({ env: { PTO_API_ORIGIN: undefined, PTO_API_TOKEN: undefined } }),
      'INVALID_OPTIONS',
    );
    await expectCode(auth.resolve({ env: { PTO_API_ORIGIN: undefined } }), 'INVALID_OPTIONS');
    await expectCode(auth.resolve({ env: { PTO_API_TOKEN: undefined } }), 'INVALID_OPTIONS');
    await expectCode(
      auth.status({ env: { PTO_API_ORIGIN: undefined, PTO_API_TOKEN: undefined } }),
      'INVALID_OPTIONS',
    );
  });

  it('refuses an environment field that was supplied but is empty', async () => {
    const { auth } = createHarness();

    // An empty field is a supplied field: it is never read as an absent one.
    await expectCode(
      auth.resolve({ env: { PTO_API_ORIGIN: '  ', PTO_API_TOKEN: TOKEN } }),
      'INVALID_ORIGIN',
    );
    await expectCode(
      auth.resolve({ env: { PTO_API_ORIGIN: ORIGIN, PTO_API_TOKEN: '  ' } }),
      'INVALID_TOKEN',
    );
    await expectCode(auth.resolve({ env: { PTO_API_ORIGIN: '' } }), 'INVALID_OPTIONS');
  });

  it('refuses an environment record that is not a record', async () => {
    const { auth } = createHarness();

    await expectCode(
      auth.resolve({ env: 'not a record' as unknown as AgentAuthEnvironment }),
      'INVALID_OPTIONS',
    );
    await expectCode(
      auth.resolve({
        env: {
          PTO_API_ORIGIN: 42 as unknown as string,
          PTO_API_TOKEN: TOKEN,
        },
      }),
      'INVALID_OPTIONS',
    );
    await expectCode(
      auth.resolve({
        env: {
          PTO_API_ORIGIN: ORIGIN,
          PTO_API_TOKEN: 42 as unknown as string,
        },
      }),
      'INVALID_OPTIONS',
    );
  });

  it('refuses an environment record that is not usable', async () => {
    const { auth } = createHarness();

    await expectCode(
      auth.resolve({ env: { PTO_API_ORIGIN: 'not an origin', PTO_API_TOKEN: TOKEN } }),
      'INVALID_ORIGIN',
    );
    await expectCode(
      auth.resolve({ env: { PTO_API_ORIGIN: ORIGIN, PTO_API_TOKEN: 'nope' } }),
      'INVALID_TOKEN',
    );
  });

  it('refuses a malformed environment record before any store is touched', async () => {
    const { auth, files, keyring, events } = createHarness();
    // The local default profile and its credential are really there, so a
    // fall back would have succeeded.
    await auth.setProfile({ profile: 'default', baseUrl: ORIGIN, token: TOKEN });
    expect(keyring.entries.get(entryKey('default', ORIGIN))).toBe(TOKEN);
    expect(files.records.get('default')?.record).not.toBeNull();

    const malformed: Array<[string, unknown]> = [
      ['null', null],
      ['an empty array', []],
      ['an array that carries a credential', [TOKEN]],
      ['a number', 42],
    ];
    for (const [name, value] of malformed) {
      events.length = 0;
      await expectCode(auth.resolve({ env: value as AgentAuthEnvironment }), 'INVALID_OPTIONS');
      // No file record and no credential store were asked.
      expect(events, name).toEqual([]);
      events.length = 0;
      await expectCode(auth.status({ env: value as AgentAuthEnvironment }), 'INVALID_OPTIONS');
      expect(events, name).toEqual([]);
    }
  });

  it('still selects the local profile for an absent or empty record', async () => {
    const { auth, events } = createHarness();
    await auth.setProfile({ profile: 'default', baseUrl: ORIGIN, token: TOKEN });

    events.length = 0;
    const absent = await auth.resolve({ env: undefined });
    expect(absent.profile).toBe('default');
    expect(absent.source).toBe('keyring');
    expect(absent.credential.token).toBe(TOKEN);

    events.length = 0;
    const empty = await auth.resolve({ env: {} });
    expect(empty.profile).toBe('default');
    expect(empty.source).toBe('keyring');
    expect(empty.credential.token).toBe(TOKEN);

    events.length = 0;
    const without = await auth.resolve();
    expect(without.profile).toBe('default');
    expect(without.source).toBe('keyring');

    const status = await auth.status({ env: {} });
    expect(status.ready).toBe(true);
    expect(status.source).toBe('keyring');
  });

  it('never reads the ambient environment on its own', async () => {
    const { auth } = createHarness();
    const previousOrigin = process.env.PTO_API_ORIGIN;
    const previousToken = process.env.PTO_API_TOKEN;
    process.env.PTO_API_ORIGIN = ORIGIN;
    process.env.PTO_API_TOKEN = TOKEN;
    try {
      await expectCode(auth.resolve(), 'PROFILE_NOT_CONFIGURED');
    } finally {
      if (previousOrigin === undefined) delete process.env.PTO_API_ORIGIN;
      else process.env.PTO_API_ORIGIN = previousOrigin;
      if (previousToken === undefined) delete process.env.PTO_API_TOKEN;
      else process.env.PTO_API_TOKEN = previousToken;
    }
  });

  it('refuses an origin the credential is not bound to', async () => {
    const { auth } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });

    await expectCode(auth.resolve({ profile: 'work', baseUrl: OTHER_ORIGIN }), 'ORIGIN_MISMATCH');
    await expectCode(
      auth.resolve({
        env: { PTO_API_ORIGIN: ORIGIN, PTO_API_TOKEN: TOKEN },
        baseUrl: OTHER_ORIGIN,
      }),
      'ORIGIN_MISMATCH',
    );
  });

  it('reads the origin override once, before the store is touched', async () => {
    const { auth } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });
    const input: { profile?: string; baseUrl?: string } = {
      profile: 'work',
      baseUrl: OTHER_ORIGIN,
    };

    const promise = auth.resolve(input);
    // The caller changes its own object while the read is running.
    input.baseUrl = ORIGIN;

    await expectCode(promise, 'ORIGIN_MISMATCH');
  });

  it('accepts an origin that is the same one written differently', async () => {
    const { auth } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });

    const bundle = await auth.resolve({ profile: 'work', baseUrl: 'https://PTO.example.com/' });

    expect(bundle.baseUrl).toBe(ORIGIN);
  });

  it('needs an explicit opt-in for plain HTTP on loopback', async () => {
    const { auth } = createHarness();

    await expectCode(
      auth.setProfile({ profile: 'work', baseUrl: LOOPBACK, token: TOKEN }),
      'INVALID_ORIGIN',
    );
    const result = await auth.setProfile({
      profile: 'work',
      baseUrl: LOOPBACK,
      token: TOKEN,
      allowLoopbackHttp: true,
    });
    expect(result.allowLoopbackHttp).toBe(true);
    // The opt-in of a stored profile persists.
    const bundle = await auth.resolve({ profile: 'work' });
    expect(bundle.allowLoopbackHttp).toBe(true);
    expect(bundle.baseUrl).toBe(LOOPBACK);
  });

  it('needs an explicit opt-in for a loopback environment origin', async () => {
    const { auth } = createHarness();
    const env = { PTO_API_ORIGIN: LOOPBACK, PTO_API_TOKEN: TOKEN };

    await expectCode(auth.resolve({ env }), 'INVALID_ORIGIN');
    const bundle = await auth.resolve({ env, allowLoopbackHttp: true });
    expect(bundle.allowLoopbackHttp).toBe(true);
    expect(bundle.baseUrl).toBe(LOOPBACK);
  });

  it('refuses input it cannot use', async () => {
    const { auth } = createHarness();

    await expectCode(auth.resolve(null as unknown as { profile?: string }), 'INVALID_OPTIONS');
    await expectCode(auth.resolve({ profile: 'Not A Name' }), 'INVALID_PROFILE');
    await expectCode(
      auth.resolve({ allowLoopbackHttp: 'yes' as unknown as boolean }),
      'INVALID_OPTIONS',
    );
  });
});

describe('cancelling a resolution', () => {
  it('passes the trusted signal to the credential store', async () => {
    const { auth, keyring } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });
    const controller = new AbortController();

    await auth.resolve({ profile: 'work', signal: controller.signal });

    expect(keyring.signals).toEqual([controller.signal]);
  });

  it('never opens the local store for a resolution that is already cancelled', async () => {
    const { auth, events } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });
    events.length = 0;
    const controller = new AbortController();
    controller.abort();

    await expectCode(
      auth.resolve({ profile: 'work', signal: controller.signal }),
      'INPUT_CANCELLED',
    );
    expect(events).toEqual([]);
  });

  it('refuses a cancellation value that is not an actual signal', async () => {
    const { auth, events } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });
    events.length = 0;

    await expectCode(
      auth.resolve({ profile: 'work', signal: {} as AbortSignal }),
      'INVALID_OPTIONS',
    );
    expect(events).toEqual([]);
  });

  it('never asks the credential store when the record was read after the cancellation', async () => {
    const { auth, events, files } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });
    events.length = 0;
    const controller = new AbortController();
    files.afterRead = () => controller.abort();

    await expectCode(
      auth.resolve({ profile: 'work', signal: controller.signal }),
      'INPUT_CANCELLED',
    );
    expect(events).toEqual(['lock:work:false', 'unlock:work']);
  });

  it('never uses a credential that arrived after the resolution was cancelled', async () => {
    const { auth, events, keyring } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });
    events.length = 0;
    const controller = new AbortController();
    keyring.afterGet = () => controller.abort();

    await expectCode(
      auth.resolve({ profile: 'work', signal: controller.signal }),
      'INPUT_CANCELLED',
    );
    // The lock of the profile is released even though the action failed.
    expect(events).toEqual(['lock:work:false', 'keyring:get', 'unlock:work']);
  });

  it('keeps a report and a removal free of the signal', async () => {
    const { auth, keyring, events } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });
    await auth.setProfile({ profile: 'other', baseUrl: OTHER_ORIGIN, token: OTHER_TOKEN });
    keyring.signals.length = 0;
    events.length = 0;

    await auth.status({ profile: 'work' });
    await auth.removeProfile('other');

    // The report reads the credential without a signal, and the removal never
    // reads a credential at all.
    expect(keyring.signals).toEqual([undefined]);
    expect(events).toEqual([
      'lock:work:false',
      'keyring:get',
      'unlock:work',
      'lock:other:false',
      'keyring:remove',
      'remove:metadata',
      'unlock:other',
    ]);
  });

  it('keeps the previous behavior when no signal is named', async () => {
    const { auth, keyring } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });

    const bundle = await auth.resolve({ profile: 'work' });

    expect(bundle.credential.token).toBe(TOKEN);
    expect(keyring.signals).toEqual([undefined]);
  });
});

describe('reporting the local state', () => {
  it('reports a profile that is not configured', async () => {
    const { auth } = createHarness();

    const status = await auth.status({ profile: 'missing' });

    expect(status).toEqual({
      profile: 'missing',
      origin: null,
      source: null,
      ready: false,
      guidance: AGENT_AUTH_GUIDANCE.notConfigured,
    });
  });

  it('reports a stored keyring profile without a secret', async () => {
    const { auth } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });

    const status = await auth.status({ profile: 'work' });

    expect(status).toEqual({
      profile: 'work',
      origin: ORIGIN,
      source: 'keyring',
      ready: true,
      guidance: AGENT_AUTH_GUIDANCE.ready,
    });
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(Object.keys(status)).not.toContain('token');
    expect(Object.keys(status)).not.toContain('credential');
  });

  it('reports a stored file profile', async () => {
    const { auth } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN, storage: 'file' });

    const status = await auth.status({ profile: 'work' });

    expect(status.source).toBe('file');
    expect(status.ready).toBe(true);
    expect(JSON.stringify(status)).not.toContain(TOKEN);
  });

  it('reports a credential that is not present', async () => {
    const { auth, keyring } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });
    keyring.entries.clear();

    const status = await auth.status({ profile: 'work' });

    expect(status.ready).toBe(false);
    expect(status.guidance).toBe(AGENT_AUTH_GUIDANCE.credentialMissing);
  });

  it('reports a credential store that cannot answer', async () => {
    const { auth, keyring } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });

    const cases: Array<[AgentAuthErrorCode, string]> = [
      ['KEYRING_LOCKED', AGENT_AUTH_GUIDANCE.keyringLocked],
      ['KEYRING_UNAVAILABLE', AGENT_AUTH_GUIDANCE.keyringUnavailable],
      ['KEYRING_AMBIGUOUS', AGENT_AUTH_GUIDANCE.keyringAmbiguous],
      ['KEYRING_UNSUPPORTED', AGENT_AUTH_GUIDANCE.keyringUnsupported],
      ['KEYRING_FAILED', AGENT_AUTH_GUIDANCE.keyringFailed],
    ];
    for (const [code, guidance] of cases) {
      keyring.getFailure = new AgentAuthError(code);
      const status = await auth.status({ profile: 'work' });
      expect(status.ready).toBe(false);
      expect(status.guidance).toBe(guidance);
    }
  });

  it('reports a credential store that fails in an unknown way', async () => {
    const { auth, keyring } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });
    keyring.getFailure = new Error('raw failure');

    const status = await auth.status({ profile: 'work' });

    expect(status.ready).toBe(false);
    expect(status.guidance).toBe(AGENT_AUTH_GUIDANCE.keyringFailed);
    expect(JSON.stringify(status)).not.toContain('raw failure');
  });

  it('reports an environment record', async () => {
    const { auth } = createHarness();

    const status = await auth.status({
      env: { PTO_API_ORIGIN: ORIGIN, PTO_API_TOKEN: TOKEN },
    });

    expect(status).toEqual({
      profile: null,
      origin: ORIGIN,
      source: 'environment',
      ready: true,
      guidance: AGENT_AUTH_GUIDANCE.ready,
    });
  });

  it('never reports an environment credential that cannot be used', async () => {
    const { auth } = createHarness();

    const status = await auth.status({
      env: { PTO_API_ORIGIN: ORIGIN, PTO_API_TOKEN: 'not a credential' },
    });

    expect(status.ready).toBe(false);
    expect(status.guidance).toBe(AGENT_AUTH_GUIDANCE.credentialUnusable);
    expect(JSON.stringify(status)).not.toContain('not a credential');
  });

  it('never reports a credential that cannot be used', async () => {
    const { auth, keyring } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });
    keyring.entries.set(entryKey('work', ORIGIN), 'not a credential');

    const status = await auth.status({ profile: 'work' });

    expect(status.ready).toBe(false);
    expect(status.guidance).toBe(AGENT_AUTH_GUIDANCE.credentialUnusable);
    expect(JSON.stringify(status)).not.toContain('not a credential');
  });

  it('refuses an origin the credential is not bound to', async () => {
    const { auth } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });

    await expectCode(auth.status({ profile: 'work', baseUrl: OTHER_ORIGIN }), 'ORIGIN_MISMATCH');
    await expectCode(
      auth.status({
        env: { PTO_API_ORIGIN: ORIGIN, PTO_API_TOKEN: TOKEN },
        baseUrl: OTHER_ORIGIN,
      }),
      'ORIGIN_MISMATCH',
    );
  });

  it('reports the default profile when none is named', async () => {
    const { auth } = createHarness();

    const status = await auth.status();

    expect(status.profile).toBe('default');
    expect(status.ready).toBe(false);
    expect(status.guidance).toBe(AGENT_AUTH_GUIDANCE.notConfigured);
  });

  it('reads the origin override once, before the store is touched', async () => {
    const { auth } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });
    const input: { profile?: string; baseUrl?: string } = {
      profile: 'work',
      baseUrl: OTHER_ORIGIN,
    };

    const promise = auth.status(input);
    // The caller changes its own object while the read is running.
    input.baseUrl = ORIGIN;

    await expectCode(promise, 'ORIGIN_MISMATCH');
  });

  it('refuses input it cannot use', async () => {
    const { auth } = createHarness();

    await expectCode(auth.status(null as unknown as StatusInput), 'INVALID_OPTIONS');
    await expectCode(auth.status({ profile: 'Not A Name' }), 'INVALID_PROFILE');
  });
});

describe('removing a profile', () => {
  it('removes the credential before the policy', async () => {
    const { auth, files, keyring, events } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });
    events.length = 0;

    const result = await auth.removeProfile('work');

    expect(result).toEqual({
      profile: 'work',
      source: 'keyring',
      removed: true,
      guidance: AGENT_AUTH_GUIDANCE.removed,
    });
    expect(events.indexOf('keyring:remove')).toBeLessThan(events.indexOf('remove:metadata'));
    expect(keyring.entries.size).toBe(0);
    expect(files.records.get('work')?.record).toBeNull();
  });

  it('explains that a local removal is not a remote revocation', async () => {
    const { auth } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });

    const result = await auth.removeProfile('work');

    expect(result.guidance).toContain('does not revoke');
    expect(result.guidance).toContain('signed-in browser');
  });

  it('never claims a removal the store did not confirm', async () => {
    const { auth, files } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });
    files.records.get('work')!.removeResult = false;

    const result = await auth.removeProfile('work');

    expect(result.removed).toBe(false);
    expect(result.guidance).toBe(AGENT_AUTH_GUIDANCE.removeUnconfirmed);
    expect(result.guidance).toContain('never revokes');
  });

  it('keeps the policy when the credential store cannot be emptied', async () => {
    const { auth, files, keyring } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN });
    keyring.removeFailure = new AgentAuthError('KEYRING_LOCKED');

    await expectCode(auth.removeProfile('work'), 'KEYRING_LOCKED');

    expect(files.records.get('work')?.record).not.toBeNull();
    expect(keyring.entries.get(entryKey('work', ORIGIN))).toBe(TOKEN);
  });

  it('removes a file profile', async () => {
    const { auth, files, keyring } = createHarness();
    await auth.setProfile({ profile: 'work', baseUrl: ORIGIN, token: TOKEN, storage: 'file' });

    const result = await auth.removeProfile('work');

    expect(result.source).toBe('file');
    expect(files.records.get('work')?.record).toBeNull();
    expect(keyring.entries.size).toBe(0);
  });

  it('refuses a profile that is not configured and a name it cannot use', async () => {
    const { auth } = createHarness();

    await expectCode(auth.removeProfile('missing'), 'PROFILE_NOT_CONFIGURED');
    await expectCode(auth.removeProfile('Not A Name'), 'INVALID_PROFILE');
    await expectCode(auth.removeProfile(null as unknown as string), 'INVALID_PROFILE');
  });
});

describe('the local store directory', () => {
  it('uses the per user directory when no directory is named', () => {
    const previous = process.env.HOME;
    process.env.HOME = '/tmp/opencode/pto-260/lane-c-synthetic-home';
    try {
      expect(resolveDirectory({})).toBe(
        '/tmp/opencode/pto-260/lane-c-synthetic-home/.config/pto-calendar/agent-auth',
      );
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
    }
  });

  it('accepts a trusted absolute directory', () => {
    expect(resolveDirectory({ directory: SYNTHETIC_DIRECTORY })).toBe(SYNTHETIC_DIRECTORY);
  });

  it('refuses a directory it cannot use', () => {
    expect(() => resolveDirectory({ directory: 'relative/path' })).toThrowError();
    expect(() => resolveDirectory({ directory: '' })).toThrowError();
    expect(() => resolveDirectory({ directory: 'a\0b' })).toThrowError();
    expect(() => resolveDirectory({ directory: 'x'.repeat(5000) })).toThrowError();
    expect(() => resolveDirectory({ directory: 42 as unknown as string })).toThrowError();
  });
});

describe('the public factory', () => {
  it('exposes exactly the four methods of the facade', () => {
    const auth = createAgentAuth({ directory: SYNTHETIC_DIRECTORY });

    expect(Object.keys(auth).sort()).toEqual(['removeProfile', 'resolve', 'setProfile', 'status']);
  });
});
