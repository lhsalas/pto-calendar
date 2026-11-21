import { describe, expect, it } from 'vitest';

import {
  CREATE_KEY_LIMIT,
  CreateKeyRegistry,
  MutationGuard,
  PREVIEW_LIMIT,
  PREVIEW_TTL_MS,
  PreviewStore,
  createKeyFingerprint,
  credentialFingerprint,
  payloadDigest,
  type CreateKeyBinding,
  type PreviewBinding,
} from '../src/write-preview.js';

const TOKEN = `pto_pat_11111111-1111-4111-8111-111111111111.${'a'.repeat(64)}`;
const TOKEN_TWO = `pto_pat_22222222-2222-4222-8222-222222222222.${'b'.repeat(64)}`;
const ID = '44444444-4444-4444-8444-444444444444';
const ACTOR = '55555555-5555-4555-8555-555555555555';

/** One complete binding that carries no raw secret or note. */
function binding(overrides: Partial<PreviewBinding> = {}): PreviewBinding {
  return {
    operation: 'create',
    actorId: ACTOR,
    ownerId: ACTOR,
    origin: 'https://pto.example.test',
    tokenId: '11111111-2222-4333-8444-555555555555',
    credential: credentialFingerprint(TOKEN),
    digest: payloadDigest({
      operation: 'create',
      key: 'v1.1700000000000.11111111-1111-4111-8111-111111111111',
    }),
    role: 'member',
    target: null,
    before: null,
    after: { startDate: '2026-12-07', endDate: '2026-12-09', dayPart: 'all_day' },
    changedFields: ['startDate', 'endDate', 'dayPart'],
    noteIntent: 'none',
    ...overrides,
  };
}

describe('the process-scoped fingerprints', () => {
  it('are deterministic and distinguish a rotated credential', () => {
    expect(credentialFingerprint(TOKEN)).toBe(credentialFingerprint(TOKEN));
    expect(credentialFingerprint(TOKEN)).not.toBe(credentialFingerprint(TOKEN_TWO));
    expect(credentialFingerprint(TOKEN)).not.toBe(TOKEN);
    expect(credentialFingerprint(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('digest the canonical payload without keeping a raw note', () => {
    const withNote = { operation: 'create', note: 'private synthetic note' };
    const withoutNote = { operation: 'create', note: null };
    expect(payloadDigest(withNote)).toBe(payloadDigest({ ...withNote }));
    expect(payloadDigest(withNote)).not.toBe(payloadDigest(withoutNote));
    expect(payloadDigest(withNote)).not.toContain('private');
    expect(payloadDigest(withNote)).not.toContain(uuidOfToken(TOKEN));
  });
});

/** The secret component of a token, used only to prove it is absent. */
function uuidOfToken(token: string): string {
  return token.split('.')[1] ?? '';
}

describe('the preview store', () => {
  it('issues one bounded, expiring reference and claims it once', () => {
    const store = new PreviewStore({ now: () => 1_000, ttlMs: 100 });
    const issued = store.issue(binding());
    expect(issued).not.toBeNull();
    expect(issued?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(issued?.expiresAt).toBe(new Date(1_100).toISOString());
    const claimed = store.claim(issued?.id ?? '', true);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(claimed.preview.binding.operation).toBe('create');
    expect(claimed.preview.expiresAt).toBe(new Date(1_100).toISOString());
    expect(store.isLive(claimed.preview)).toBe(true);
    claimed.release();
    claimed.release();
  });

  it('rechecks the same claim against the same clock', () => {
    let now = 1_000;
    const store = new PreviewStore({ now: () => now, ttlMs: 100 });
    const id = store.issue(binding())?.id ?? '';
    const claimed = store.claim(id, true);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(store.isLive(claimed.preview)).toBe(true);
    now = 1_100;
    expect(store.isLive(claimed.preview)).toBe(false);
    now = 1_101;
    expect(store.isLive(claimed.preview)).toBe(false);
    claimed.release();
  });

  it('keeps a reusable create reference claimable after a release', () => {
    const store = new PreviewStore({ now: () => 1_000 });
    const id = store.issue(binding())?.id ?? '';
    const first = store.claim(id, true);
    expect(first.ok).toBe(true);
    expect(store.claim(id, true)).toEqual({ ok: false, reason: 'in-flight' });
    if (first.ok) first.release();
    const second = store.claim(id, true);
    expect(second.ok).toBe(true);
    if (second.ok) {
      second.release();
      second.release();
    }
  });

  it('removes an update or delete reference at its first claim', () => {
    const store = new PreviewStore({ now: () => 1_000 });
    const id = store.issue(binding({ operation: 'delete' }))?.id ?? '';
    const first = store.claim(id, false);
    expect(first.ok).toBe(true);
    if (first.ok) first.release();
    expect(store.claim(id, false)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses an unknown, expired or duplicate reference', () => {
    let now = 1_000;
    const store = new PreviewStore({ now: () => now, ttlMs: 100, newId: () => 'fixed' });
    expect(store.claim('missing', true)).toEqual({ ok: false, reason: 'invalid' });
    const issued = store.issue(binding());
    expect(issued?.id).toBe('fixed');
    now = 1_100;
    expect(store.claim('fixed', true)).toEqual({ ok: false, reason: 'invalid' });
    // The expired entry was removed, so the same fixed id can be issued again.
    expect(store.issue(binding())?.id).toBe('fixed');
    // A duplicate id is refused while the entry is present.
    expect(store.issue(binding())).toBeNull();
  });

  it('prunes expired entries and bounds the number of live previews', () => {
    let now = 1_000;
    const store = new PreviewStore({ now: () => now, ttlMs: 100, limit: 1 });
    expect(store.issue(binding())).not.toBeNull();
    expect(store.issue(binding())).toBeNull();
    now = 1_100;
    expect(store.issue(binding())).not.toBeNull();
    expect(PREVIEW_TTL_MS).toBe(300_000);
    expect(PREVIEW_LIMIT).toBe(64);
  });

  it('removes an expired entry under an in-flight claim without resurrecting it', () => {
    let now = 1_000;
    const store = new PreviewStore({ now: () => now, ttlMs: 100 });
    const id = store.issue(binding())?.id ?? '';
    const claim = store.claim(id, true);
    expect(claim.ok).toBe(true);
    now = 1_100;
    expect(store.claim(id, true)).toEqual({ ok: false, reason: 'invalid' });
    if (claim.ok) claim.release();
    expect(store.claim(id, true)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses an unusable lifetime or limit', () => {
    expect(() => new PreviewStore({ ttlMs: 0 })).toThrow(RangeError);
    expect(() => new PreviewStore({ ttlMs: 1.5 })).toThrow(RangeError);
    expect(() => new PreviewStore({ limit: 0 })).toThrow(RangeError);
    expect(() => new PreviewStore({ limit: 1.5 })).toThrow(RangeError);
  });

  it('stores no raw credential or key in a binding', () => {
    const text = JSON.stringify(binding());
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('pto_pat_');
    expect(text).not.toContain('v1.1700000000000');
    expect(text).not.toContain('"note":');
  });
});

describe('the one-dispatch mutation guard', () => {
  it('admits one holder per key and releases it exactly once', () => {
    const guard = new MutationGuard();
    const release = guard.acquire('create:one');
    expect(release).toBeTypeOf('function');
    expect(guard.acquire('create:one')).toBeUndefined();
    expect(guard.acquire('create:two')).toBeTypeOf('function');
    release?.();
    release?.();
    expect(guard.acquire('create:one')).toBeTypeOf('function');
  });
});

describe('the preview binding ids', () => {
  it('does not expose the raw actor or a display name', () => {
    const text = JSON.stringify(binding({ ownerId: ID }));
    expect(text).toContain(ID);
    expect(text).not.toContain('Ada');
  });
});

/** One immutable create-key observation. */
function keyBinding(overrides: Partial<CreateKeyBinding> = {}): CreateKeyBinding {
  return {
    origin: 'https://pto.example.test',
    actorId: ACTOR,
    tokenId: '11111111-2222-4333-8444-555555555555',
    credential: credentialFingerprint(TOKEN),
    intent: payloadDigest({ operation: 'create', key: 'one-intent' }),
    ...overrides,
  };
}

describe('the process-local create-key registry', () => {
  it('fingerprints a key with the process HMAC and never stores it raw', () => {
    const key = 'v1.1700000000000.11111111-1111-4111-8111-111111111111';
    expect(createKeyFingerprint(key)).toBe(createKeyFingerprint(key));
    expect(createKeyFingerprint(key)).not.toBe(createKeyFingerprint(`${key}x`));
    expect(createKeyFingerprint(key)).not.toBe(key);
    expect(createKeyFingerprint(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(CREATE_KEY_LIMIT).toBe(256);
  });

  it('observes one exact binding and refuses every changed value', () => {
    const registry = new CreateKeyRegistry();
    const fingerprint = createKeyFingerprint('key-one');
    const observed = keyBinding();
    expect(registry.observe(fingerprint, observed)).toBe('observed');
    expect(registry.observe(fingerprint, keyBinding())).toBe('duplicate');
    for (const changed of [
      { origin: 'https://other.example.test' },
      { actorId: '66666666-6666-4666-8666-666666666666' },
      { tokenId: '22222222-2222-4222-8222-222222222222' },
      { credential: credentialFingerprint(TOKEN_TWO) },
      { intent: payloadDigest({ operation: 'create', key: 'another-intent' }) },
    ] satisfies Array<Partial<CreateKeyBinding>>) {
      expect(registry.observe(fingerprint, keyBinding(changed))).toBe('conflict');
    }
    expect(registry.verify(fingerprint, observed)).toBe('verified');
    expect(registry.verify(fingerprint, keyBinding())).toBe('verified');
    expect(registry.verify(fingerprint, keyBinding({ intent: 'x' }))).toBe('conflict');
    expect(registry.verify(createKeyFingerprint('never-seen'), observed)).toBe('missing');
  });

  it('normalizes actor and token identifiers, never origin, credential or intent', () => {
    const registry = new CreateKeyRegistry();
    const fingerprint = createKeyFingerprint('key-two');
    expect(
      registry.observe(
        fingerprint,
        keyBinding({
          actorId: ACTOR.toUpperCase(),
          tokenId: '11111111-2222-4333-8444-555555555555'.toUpperCase(),
        }),
      ),
    ).toBe('observed');
    expect(registry.verify(fingerprint, keyBinding())).toBe('verified');
    expect(registry.verify(fingerprint, keyBinding({ origin: 'https://PTO.example.test' }))).toBe(
      'conflict',
    );
  });

  it('refuses a new key at capacity, never evicts, and retains every exact binding', () => {
    const registry = new CreateKeyRegistry(2);
    const first = createKeyFingerprint('first');
    const second = createKeyFingerprint('second');
    const third = createKeyFingerprint('third');
    expect(registry.observe(first, keyBinding())).toBe('observed');
    expect(registry.observe(second, keyBinding({ intent: 'second-intent' }))).toBe('observed');
    expect(registry.observe(third, keyBinding({ intent: 'third-intent' }))).toBe('full');
    // The existing entries are retained and still verify; no early eviction.
    expect(registry.verify(first, keyBinding())).toBe('verified');
    expect(registry.verify(second, keyBinding({ intent: 'second-intent' }))).toBe('verified');
    expect(registry.observe(first, keyBinding())).toBe('duplicate');
    expect(registry.observe(third, keyBinding({ intent: 'third-intent' }))).toBe('full');
  });

  it('refuses an unusable capacity', () => {
    expect(() => new CreateKeyRegistry(0)).toThrow(RangeError);
    expect(() => new CreateKeyRegistry(1.5)).toThrow(RangeError);
  });

  it('stores only HMACs and identifiers in an observation', () => {
    const text = JSON.stringify(keyBinding());
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('private synthetic note');
    expect(text).not.toContain('v1.1700000000000');
  });
});
