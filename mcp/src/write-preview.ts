/**
 * The bounded, ephemeral preview store of the mutation tools.
 *
 * A preview is a short-lived, process-scoped reference to one exact intent. It
 * is not a file, not a durable journal, not an API argument and not evidence of
 * human approval. The store keeps only:
 *
 * - the operation, the live actor and owner, the live role, the normalized
 *   origin and the internal token identifier;
 * - a process-keyed HMAC fingerprint of the credential, never the token;
 * - a process-keyed HMAC digest of the canonical arguments, never a raw note or
 *   idempotency key;
 * - the exact target/version, the current effective range and the proposed one.
 *
 * `claim` removes an entry synchronously before the caller performs any await,
 * so two concurrent `apply` calls can never both dispatch from one preview. An
 * expired or claim-ed preview is refused; the same claim's expiry is checked
 * again on the store clock immediately before dispatch. A caller that lost one
 * prepares a new preview and asks for approval again. The store is bounded:
 * expired entries are pruned first, and a full store refuses a new preview
 * instead of growing.
 *
 * A separate bounded `CreateKeyRegistry` remembers the first exact observation
 * of each create key for the process lifetime, independent of preview IDs. It
 * never evicts an entry to admit another; at capacity a new key fails closed.
 *
 * The HMAC key is random per process and never leaves it, so a stored digest is
 * not a stable token fingerprint and not a crackable hash of a low-entropy note.
 */

import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import type { PtoRole } from '@pto-calendar/api-client';

import type {
  ChangedField,
  EffectiveRange,
  NoteIntent,
  TargetReference,
  WriteOperation,
} from './write-contract.js';

/** How long a preview stays valid. It is intentionally short. */
export const PREVIEW_TTL_MS = 300_000;

/** The most previews one process may hold for reconciliation. */
export const PREVIEW_LIMIT = 64;

/**
 * The most create keys one process observes.
 *
 * An observed key is never evicted early: at capacity a new create key is
 * refused (fail closed) instead of replacing a binding. The registry lives for
 * the process lifetime; a restart loses it and the caller must reconcile. The
 * backend clock remains authoritative on the key replay window.
 */
export const CREATE_KEY_LIMIT = 256;

/** Everything a preview binds. None of these values is a raw secret or note. */
export interface PreviewBinding {
  readonly operation: WriteOperation;
  readonly actorId: string;
  readonly ownerId: string;
  readonly origin: string;
  readonly tokenId: string;
  readonly credential: string;
  readonly digest: string;
  readonly role: PtoRole;
  readonly target: TargetReference | null;
  readonly before: EffectiveRange | null;
  readonly after: EffectiveRange | null;
  readonly changedFields: readonly ChangedField[];
  readonly noteIntent: NoteIntent;
}

/** One issued preview reference. It carries no binding data. */
export interface IssuedPreview {
  readonly id: string;
  readonly expiresAt: string;
}

/** The binding a claim released, plus its expiry for the answer. */
export interface ClaimedPreview {
  readonly binding: PreviewBinding;
  readonly expiresAt: string;
  /** The same expiry as the store clock; never sent to the protocol. */
  readonly expiresAtMs: number;
}

/** The result of taking one preview reference. */
export type PreviewClaim =
  | { readonly ok: true; readonly preview: ClaimedPreview; readonly release: () => void }
  | { readonly ok: false; readonly reason: 'invalid' | 'in-flight' };

/** The one preview entry of the bounded store. */
interface PreviewEntry {
  readonly binding: PreviewBinding;
  readonly expiresAtMs: number;
  inFlight: boolean;
}

/** The test and isolated-host seams of the store. */
export interface PreviewStoreOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly limit?: number;
  readonly newId?: () => string;
}

/** The one HMAC key of this process. It is never exported or logged. */
const PROCESS_KEY = randomBytes(32);

/** A domain-separated HMAC of one value under the process key. */
function processDigest(domain: string, value: string): string {
  return createHmac('sha256', PROCESS_KEY)
    .update(domain, 'utf8')
    .update('\0', 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

/** The process-scoped fingerprint of one resolved credential. */
export function credentialFingerprint(token: string): string {
  return processDigest('pto-mcp-credential', token);
}

/**
 * The process-scoped digest of one canonical intent.
 *
 * The caller builds the canonical object from validated values only, so two
 * calls with the same exact business payload always produce the same digest and
 * a changed note, key, target or version always produces another one.
 */
export function payloadDigest(payload: Record<string, unknown>): string {
  return processDigest('pto-mcp-payload', JSON.stringify(payload));
}

/** The process-scoped fingerprint of one create idempotency key. */
export function createKeyFingerprint(key: string): string {
  return processDigest('pto-mcp-create-key', key);
}

/**
 * The immutable process-local observation of one create key.
 *
 * The values are normalized identifiers and HMACs only: no raw key, token or
 * note is stored. The intent digest covers the whole canonical create payload.
 */
export interface CreateKeyBinding {
  readonly origin: string;
  readonly actorId: string;
  readonly tokenId: string;
  readonly credential: string;
  readonly intent: string;
}

/** The result of observing a create key at preview time. */
export type CreateKeyObservation = 'observed' | 'duplicate' | 'conflict' | 'full';

/** The result of verifying a create key immediately before dispatch. */
export type CreateKeyVerification = 'verified' | 'missing' | 'conflict';

/** The case-normalized form of one observation. */
function normalizedCreateBinding(binding: CreateKeyBinding): CreateKeyBinding {
  return {
    origin: binding.origin,
    actorId: binding.actorId.toLowerCase(),
    tokenId: binding.tokenId.toLowerCase(),
    credential: binding.credential,
    intent: binding.intent,
  };
}

/** Whether two observations describe the exact same create intent. */
function sameCreateBinding(left: CreateKeyBinding, right: CreateKeyBinding): boolean {
  return (
    left.origin === right.origin &&
    left.actorId === right.actorId &&
    left.tokenId === right.tokenId &&
    left.credential === right.credential &&
    left.intent === right.intent
  );
}

/**
 * The bounded registry of observed create keys.
 *
 * It is independent of preview IDs and of preview expiry. A key observed once
 * keeps its exact origin, actor, token ID, credential fingerprint and canonical
 * intent for the process lifetime. A later preview with the same key but any
 * different value is refused instead of silently rebinding; a dispatch whose
 * observation is missing is refused instead of guessing. At capacity a new key
 * is refused; no entry is evicted early. A process restart loses the whole
 * registry, so the caller must reconcile rather than assume a key was unused.
 */
export class CreateKeyRegistry {
  readonly #limit: number;
  readonly #entries = new Map<string, CreateKeyBinding>();

  constructor(limit: number = CREATE_KEY_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError('The create-key registry limit must be a positive integer.');
    }
    this.#limit = limit;
  }

  /** Observes one key at preview time, without ever replacing an earlier one. */
  observe(fingerprint: string, binding: CreateKeyBinding): CreateKeyObservation {
    const normalized = normalizedCreateBinding(binding);
    const existing = this.#entries.get(fingerprint);
    if (existing !== undefined) {
      return sameCreateBinding(existing, normalized) ? 'duplicate' : 'conflict';
    }
    if (this.#entries.size >= this.#limit) return 'full';
    this.#entries.set(fingerprint, normalized);
    return 'observed';
  }

  /** Verifies the exact same observation immediately before a dispatch. */
  verify(fingerprint: string, binding: CreateKeyBinding): CreateKeyVerification {
    const existing = this.#entries.get(fingerprint);
    if (existing === undefined) return 'missing';
    return sameCreateBinding(existing, normalizedCreateBinding(binding)) ? 'verified' : 'conflict';
  }
}

/**
 * The preview store.
 *
 * Both `issue` and `claim` are synchronous, so the claim of one preview is
 * atomic with respect to every other call in the process. A create preview can
 * be claimed again after a failed or ambiguous dispatch only while it is
 * unexpired and not in flight; an update or delete preview is removed by its
 * first claim. A concurrent duplicate always finds the entry in flight.
 */
export class PreviewStore {
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #limit: number;
  readonly #newId: () => string;
  readonly #entries = new Map<string, PreviewEntry>();

  constructor(options: PreviewStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? PREVIEW_TTL_MS;
    this.#limit = options.limit ?? PREVIEW_LIMIT;
    this.#newId = options.newId ?? randomUUID;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1) {
      throw new RangeError('The preview lifetime must be a positive integer.');
    }
    if (!Number.isSafeInteger(this.#limit) || this.#limit < 1) {
      throw new RangeError('The preview limit must be a positive integer.');
    }
  }

  /** Issues one reference, or null when the bounded store cannot admit it. */
  issue(binding: PreviewBinding): IssuedPreview | null {
    this.#prune();
    if (this.#entries.size >= this.#limit) return null;
    const id = this.#newId();
    if (this.#entries.has(id)) return null;
    const expiresAtMs = this.#now() + this.#ttlMs;
    this.#entries.set(id, { binding, expiresAtMs, inFlight: false });
    return { id, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  /**
   * Takes one reference for one dispatch.
   *
   * A missing or expired reference is `invalid`. A reference whose apply is
   * still running is `in-flight`, so no second call can dispatch from it at the
   * same time. A reusable create reference stays stored and can only be taken
   * again after the first apply released it; an update or delete reference is
   * removed by the claim, so a stale or ambiguous change is never retried from
   * the same preview. The release of a removed reference does nothing.
   */
  claim(id: string, reusable: boolean): PreviewClaim {
    const entry = this.#entries.get(id);
    if (entry === undefined) return { ok: false, reason: 'invalid' };
    if (this.#now() >= entry.expiresAtMs) {
      this.#entries.delete(id);
      return { ok: false, reason: 'invalid' };
    }
    if (entry.inFlight) return { ok: false, reason: 'in-flight' };
    const preview: ClaimedPreview = {
      binding: entry.binding,
      expiresAt: new Date(entry.expiresAtMs).toISOString(),
      expiresAtMs: entry.expiresAtMs,
    };
    if (!reusable) {
      this.#entries.delete(id);
      return { ok: true, preview, release: () => undefined };
    }
    entry.inFlight = true;
    let held = true;
    return {
      ok: true,
      preview,
      release: () => {
        if (!held) return;
        held = false;
        if (this.#entries.get(id) === entry) entry.inFlight = false;
      },
    };
  }

  /** Whether the claimed preview is still unexpired on this store's clock. */
  isLive(preview: ClaimedPreview): boolean {
    return this.#now() < preview.expiresAtMs;
  }

  /** Removes every entry that is already expired. */
  #prune(): void {
    const now = this.#now();
    for (const [id, entry] of this.#entries) {
      if (now >= entry.expiresAtMs) this.#entries.delete(id);
    }
  }
}

/**
 * The one-dispatch guard of a mutation target.
 *
 * A second concurrent mutation for the same create key, or for the same entry
 * and expected version, is refused with a busy result instead of racing the
 * first. The guard is process-local and released in a `finally`; it never
 * replaces the version and never retries anything.
 */
export class MutationGuard {
  readonly #active = new Set<string>();

  /** Takes the key, or returns undefined when another dispatch holds it. */
  acquire(key: string): (() => void) | undefined {
    if (this.#active.has(key)) return undefined;
    this.#active.add(key);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.#active.delete(key);
    };
  }
}
