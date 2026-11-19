/**
 * The local profile facade.
 *
 * A profile is a non-secret name bound to exactly one trusted origin and to
 * the credential that belongs to that origin. The facade decides which
 * credential belongs to which origin and hands the caller one frozen bundle.
 *
 * The facade never sends a request, never opens a browser, never reads the
 * ambient environment and never asks for a secret. The secret has exactly one
 * entry point, `readSecretInput`, and only the setup command calls it, so a
 * tool call can never open a prompt.
 */

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { AgentAuthError } from './errors.js';
import {
  normalizeOrigin,
  requireProfileName,
  requireToken,
  validateStoredProfile,
  type StoredProfile,
} from './validation.js';

/** Where a credential came from. */
export type CredentialSource = 'environment' | 'file' | 'keyring';

/** Where a credential is kept between two runs. */
export type ProfileStorage = 'file' | 'keyring';

/** The profile used when the caller names none. */
const DEFAULT_PROFILE = 'default';

/** The directory the local store lives in when no other one is named. */
const DEFAULT_DIRECTORY = ['.config', 'pto-calendar', 'agent-auth'] as const;

/**
 * The fixed, safe guidance this package hands to an adapter.
 *
 * Every string is a constant: it never carries a token, an origin, a path, a
 * host name or an error. The guidance says what the caller may do next, and
 * it never asks for a secret inside a tool call.
 */
export const AGENT_AUTH_GUIDANCE = Object.freeze({
  ready:
    'A credential for this origin is stored locally. Local presence does not prove that the token is valid, unexpired or not revoked: if the service answers UNAUTHENTICATED, replace or revoke the token in the signed-in browser UI.',
  notConfigured:
    'No local credential is configured for this profile. Run the auth setup command to store one; setup reads the secret once and never asks for it inside a tool call.',
  credentialMissing:
    'The profile is configured but its credential is not present in the local store. Run the auth setup command again to store it.',
  credentialUnusable:
    'The stored credential is not a usable personal access token. Run the auth setup command again to store a valid one.',
  keyringLocked:
    'The operating system credential store is locked, so the credential was not read. Unlock the store and try again; nothing is downgraded to another store.',
  keyringUnavailable:
    'The operating system credential store is not available, so the credential was not read. Nothing is downgraded to another store.',
  keyringAmbiguous:
    'The operating system credential store holds more than one matching credential. Remove the extra entry in the store and try again.',
  keyringFailed:
    'The operating system credential store could not be used, so the credential was not read. Nothing is downgraded to another store.',
  keyringUnsupported:
    'This platform has no supported operating system credential store. Use a managed runtime that injects the credential, or run on a supported platform.',
  removed:
    'The credential was removed from this machine. Removing it locally does not revoke it on the server: revoke or replace the token in the signed-in browser UI.',
  removeUnconfirmed:
    'The local removal could not be confirmed. A local removal never revokes the token on the server: revoke or replace the token in the signed-in browser UI.',
  unauthenticated:
    'The service did not accept the credential. Verify that the request targets the intended origin, then replace or revoke the token in the signed-in browser UI. The local setup never asks for a token inside a tool call.',
} as const);

/**
 * The environment a managed runtime may inject.
 *
 * The record is only read when a caller passes it explicitly. The facade
 * never reads `process.env` and never reads a dotenv file, so a value that
 * happens to sit in the environment of a shell never becomes a credential.
 */
export interface AgentAuthEnvironment {
  readonly PTO_API_ORIGIN?: string;
  readonly PTO_API_TOKEN?: string;
  readonly [key: string]: string | undefined;
}

/** The record of one profile in the local store. */
export interface ProfileFilePort {
  read(): Promise<StoredProfile | null>;
  write(value: StoredProfile): Promise<void>;
  remove(): Promise<boolean>;
}

/** The locked local store of the profiles. */
export interface ProfileFilesPort {
  withProfile<T>(
    name: string,
    createDirectory: boolean,
    action: (file: ProfileFilePort) => Promise<T>,
  ): Promise<T>;
}

/** The operating system credential store. */
export interface KeyringPort {
  /**
   * The token stored for the profile at the origin, or null when there is none.
   *
   * The optional signal belongs to the trusted host: an aborted lookup stops
   * the credential store and fails with the fixed cancellation code.
   */
  get(profile: string, origin: string, signal?: AbortSignal): Promise<string | null>;
  set(profile: string, origin: string, token: string): Promise<void>;
  remove(profile: string, origin: string): Promise<boolean>;
}

/** The ways the local store can be built. */
export interface AgentAuthAdapters {
  /** Builds the locked profile store for one trusted directory. */
  readonly createFiles: (directory: string) => ProfileFilesPort;
  /** Builds the operating system credential store. */
  readonly createKeyring: () => KeyringPort;
}

/** The options of the facade. */
export interface AgentAuthOptions {
  /**
   * A trusted absolute directory for the local profile store.
   *
   * The default is the per-user configuration directory of this package. The
   * directory is never derived from the current working directory, so no
   * repository can point the store somewhere else.
   */
  readonly directory?: string;
}

/** The input of `setProfile`. */
export interface SetProfileInput {
  /** The non-secret name of the profile. */
  readonly profile: string;
  /** The trusted origin the credential belongs to. */
  readonly baseUrl: string;
  /** The credential itself. */
  readonly token: string;
  /** The explicit opt-in to plain HTTP for the exact loopback hosts. */
  readonly allowLoopbackHttp?: boolean;
  /** Where the credential is kept. The default keeps it out of a file. */
  readonly storage?: ProfileStorage;
}

/** The result of `setProfile`. It never carries the secret. */
export interface SetProfileResult {
  readonly profile: string;
  readonly origin: string;
  readonly source: CredentialSource;
  readonly allowLoopbackHttp: boolean;
}

/** The input of `resolve`. */
export interface ResolveInput {
  /** The profile to resolve. The default profile is used when none is named. */
  readonly profile?: string;
  /** The origin the caller expects, checked against the bound origin. */
  readonly baseUrl?: string;
  /** The explicit opt-in to plain HTTP for the exact loopback hosts. */
  readonly allowLoopbackHttp?: boolean;
  /** An explicit, trusted environment record. It is never read on its own. */
  readonly env?: AgentAuthEnvironment;
  /**
   * An optional trusted cancellation signal.
   *
   * The signal belongs to the trusted host, never to a tool argument. A
   * cancelled resolution stops the credential store and fails with the fixed
   * cancellation code; the reason of the signal is never read. Its absence
   * preserves the previous behavior of every caller.
   */
  readonly signal?: AbortSignal;
}

/**
 * The frozen credential bundle.
 *
 * The first three members are exactly the options of the shared API client,
 * so a bundle can be handed to it unchanged. The last two members say where
 * the credential came from and are safe to show.
 */
export interface AgentAuthCredential {
  readonly baseUrl: string;
  readonly credential: { readonly origin: string; readonly token: string };
  readonly allowLoopbackHttp: boolean;
  readonly profile: string | null;
  readonly source: CredentialSource;
}

/** The input of `status`. */
export interface StatusInput {
  /** The profile to report on. The default profile is used when none is named. */
  readonly profile?: string;
  /** The origin the caller expects, checked against the bound origin. */
  readonly baseUrl?: string;
  /** The explicit opt-in to plain HTTP for the exact loopback hosts. */
  readonly allowLoopbackHttp?: boolean;
  /** An explicit, trusted environment record. It is never read on its own. */
  readonly env?: AgentAuthEnvironment;
}

/**
 * The local state of a profile.
 *
 * The status says what is present on this machine. It is never a proof that
 * the token is valid, unexpired or not revoked, and it never carries a token,
 * a path or an error object.
 */
export interface AgentAuthStatus {
  readonly profile: string | null;
  readonly origin: string | null;
  readonly source: CredentialSource | null;
  readonly ready: boolean;
  readonly guidance: string | null;
}

/** The result of `removeProfile`. */
export interface RemoveProfileResult {
  readonly profile: string;
  readonly source: CredentialSource;
  readonly removed: boolean;
  readonly guidance: string;
}

/** The facade every adapter uses. */
export interface AgentAuth {
  setProfile(input: SetProfileInput): Promise<SetProfileResult>;
  resolve(input?: ResolveInput): Promise<AgentAuthCredential>;
  status(input?: StatusInput): Promise<AgentAuthStatus>;
  removeProfile(profile: string): Promise<RemoveProfileResult>;
}

/** A complete environment pair. */
interface EnvironmentPair {
  readonly origin: string;
  readonly token: string;
}

/**
 * The name of a profile.
 *
 * The shared validator owns the shape of a name: it refuses a name that is
 * not a plain, non-secret label and returns the name it accepted.
 */
function profileName(value: unknown): string {
  return requireProfileName(value);
}

/** The secret of a credential. The shared validator owns the shape of it. */
function secretValue(value: unknown): string {
  return requireToken(value);
}

/** The storage of a profile. The default keeps the credential out of a file. */
function profileStorage(value: unknown): ProfileStorage {
  if (value === undefined) return 'keyring';
  if (value === 'file' || value === 'keyring') return value;
  throw new AgentAuthError('INVALID_OPTIONS');
}

/**
 * The explicit opt-in to plain HTTP.
 *
 * Only the literal `true` opens plain HTTP, and a value that is not a
 * boolean at all is refused instead of being read as a false.
 */
function loopbackOptIn(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new AgentAuthError('INVALID_OPTIONS');
  return value;
}

/**
 * The optional trusted cancellation signal.
 *
 * Only an absent signal is no signal. A value that is not an actual signal is
 * refused before a single store is touched, so a malformed option can never
 * reach the credential store. The reason of the signal is never read.
 */
function optionalSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof AbortSignal)) throw new AgentAuthError('INVALID_OPTIONS');
  return value;
}

/**
 * Whether the trusted signal was aborted.
 *
 * The state is read through a function on purpose: a cancellation that happens
 * between two checks is still seen, so the second check of a resolution is
 * never narrowed away.
 */
function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * The environment pair of an explicit record.
 *
 * Only an absent record is no record. An explicit `null`, an array or any
 * other malformed value is refused before a single store is touched, so a
 * malformed record can never select an unintended local profile.
 *
 * The record is read by the keys it carries, never by the values it happens
 * to hold: a field that is supplied but empty or malformed is a supplied
 * field, and it is refused instead of being read as an absent one. A record
 * that carries no field at all is no record.
 *
 * A field that is named at all is a supplied field, even when its value is
 * undefined: a runtime record that carries the field never falls back to
 * another source. Only a record without any of the two fields may fall
 * back.
 *
 * A record that carries one field is incomplete, and a record that is
 * combined with an explicit profile is ambiguous: two sources would answer
 * the same question.
 */
function environmentPair(
  env: AgentAuthEnvironment | undefined,
  hasExplicitProfile: boolean,
): EnvironmentPair | null {
  // Only an absent record is no record. An explicit `null`, an array or any
  // other value is a malformed record, and it is refused before a single
  // store is touched: a malformed record must never select an unintended
  // local profile.
  if (env === undefined) return null;
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw new AgentAuthError('INVALID_OPTIONS');
  }
  const hasOriginField = Object.hasOwn(env, 'PTO_API_ORIGIN');
  const hasTokenField = Object.hasOwn(env, 'PTO_API_TOKEN');
  // The raw presence of a field is what makes the record ambiguous: a field
  // that was named at all cannot be combined with a named profile.
  if (hasExplicitProfile && (hasOriginField || hasTokenField)) {
    throw new AgentAuthError('AMBIGUOUS_CREDENTIALS');
  }
  // The whole pair may be absent, and then the caller asked for a profile.
  if (!hasOriginField && !hasTokenField) return null;
  if (hasOriginField !== hasTokenField) throw new AgentAuthError('INVALID_OPTIONS');
  const rawOrigin = env.PTO_API_ORIGIN;
  const rawToken = env.PTO_API_TOKEN;
  if (typeof rawOrigin !== 'string' || typeof rawToken !== 'string') {
    throw new AgentAuthError('INVALID_OPTIONS');
  }
  return { origin: rawOrigin, token: rawToken };
}

/**
 * The origin the caller expects.
 *
 * The override is normalized once and then compared with the bound origin: a
 * credential is never sent to an origin other than the one it belongs to.
 */
function normalizeOverride(baseUrl: string | undefined, allowLoopbackHttp: boolean): string | null {
  if (baseUrl === undefined) return null;
  return normalizeOrigin(baseUrl, allowLoopbackHttp);
}

/**
 * Whether a credential can be used at all.
 *
 * The value is checked and dropped: it is never kept, shown or reported.
 */
function isUsableSecret(value: string): boolean {
  try {
    requireToken(value);
    return true;
  } catch {
    return false;
  }
}

/** The frozen bundle an adapter consumes. */
function freezeBundle(bundle: AgentAuthCredential): AgentAuthCredential {
  return Object.freeze({
    ...bundle,
    credential: Object.freeze({ ...bundle.credential }),
  });
}

/** The credential of a keyring profile. The store is never worked around. */
async function readKeyringToken(
  keyring: KeyringPort,
  profile: string,
  origin: string,
  signal?: AbortSignal,
): Promise<string> {
  const token = await keyring.get(profile, origin, signal);
  if (token === null || token === undefined) throw new AgentAuthError('CREDENTIAL_MISSING');
  return secretValue(token);
}

/** The guidance of a credential store that refused to answer. */
function guidanceForKeyring(error: unknown): string {
  const code = error instanceof AgentAuthError ? error.code : null;
  if (code === 'KEYRING_LOCKED') return AGENT_AUTH_GUIDANCE.keyringLocked;
  if (code === 'KEYRING_UNAVAILABLE') return AGENT_AUTH_GUIDANCE.keyringUnavailable;
  if (code === 'KEYRING_AMBIGUOUS') return AGENT_AUTH_GUIDANCE.keyringAmbiguous;
  if (code === 'KEYRING_UNSUPPORTED') return AGENT_AUTH_GUIDANCE.keyringUnsupported;
  return AGENT_AUTH_GUIDANCE.keyringFailed;
}

/** Stores one profile. */
async function setProfile(
  files: ProfileFilesPort,
  keyring: KeyringPort,
  input: SetProfileInput,
): Promise<SetProfileResult> {
  if (typeof input !== 'object' || input === null) throw new AgentAuthError('INVALID_OPTIONS');
  const profile = profileName(input.profile);
  const storage = profileStorage(input.storage);
  const allowLoopbackHttp = loopbackOptIn(input.allowLoopbackHttp);
  const origin = normalizeOrigin(input.baseUrl, allowLoopbackHttp);
  const token = secretValue(input.token);

  if (storage === 'file') {
    // A plaintext credential is only ever written when it was chosen on
    // purpose, and only into the owner-only file store.
    const record: StoredProfile = {
      version: 1,
      profile,
      origin,
      allowLoopbackHttp,
      storage: 'file',
      token,
    };
    await files.withProfile(profile, true, async (file) => {
      const existing = await file.read();
      if (existing !== null && existing !== undefined) {
        const stored = validateStoredProfile(existing, profile);
        if (stored.origin !== origin || stored.storage !== 'file') {
          throw new AgentAuthError('PROFILE_CONFLICT');
        }
      }
      await file.write(record);
    });
    return { profile, origin, source: 'file', allowLoopbackHttp };
  }

  const record: StoredProfile = {
    version: 1,
    profile,
    origin,
    allowLoopbackHttp,
    storage: 'keyring',
  };
  await files.withProfile(profile, true, async (file) => {
    const existing = await file.read();
    if (existing !== null && existing !== undefined) {
      const stored = validateStoredProfile(existing, profile);
      if (stored.origin !== origin || stored.storage !== 'keyring') {
        throw new AgentAuthError('PROFILE_CONFLICT');
      }
    }
    // The policy is written before the credential, so a store that refuses
    // the credential never leaves a credential without its policy.
    await file.write(record);
    // The policy stays when the store refuses the credential: the outcome of
    // that write is unknown, so the binding is kept and the readiness check
    // reports what the credential store really holds. No plaintext store and
    // no second credential store is tried.
    await keyring.set(profile, origin, token);
  });
  return { profile, origin, source: 'keyring', allowLoopbackHttp };
}

/** Resolves one credential. */
async function resolveCredential(
  files: ProfileFilesPort,
  keyring: KeyringPort,
  input: ResolveInput,
): Promise<AgentAuthCredential> {
  if (typeof input !== 'object' || input === null) throw new AgentAuthError('INVALID_OPTIONS');
  // Everything the caller controls is read once, before the first await: a
  // caller that changes its own object while the read is running cannot
  // change the binding that is being resolved.
  const explicitProfile = input.profile === undefined ? null : profileName(input.profile);
  const requested = loopbackOptIn(input.allowLoopbackHttp);
  const baseUrl = input.baseUrl;
  const pair = environmentPair(input.env, explicitProfile !== null);
  const signal = optionalSignal(input.signal);
  // A cancelled resolution never opens the local store and never asks the
  // credential store for anything.
  if (isCancelled(signal)) throw new AgentAuthError('INPUT_CANCELLED');

  if (pair !== null) {
    // A managed runtime injects the credential for this run only. Nothing is
    // read from the local store and nothing is written to it.
    const origin = normalizeOrigin(pair.origin, requested);
    const token = secretValue(pair.token);
    const override = normalizeOverride(baseUrl, requested);
    if (override !== null && override !== origin) throw new AgentAuthError('ORIGIN_MISMATCH');
    return freezeBundle({
      baseUrl: origin,
      credential: { origin, token },
      allowLoopbackHttp: requested,
      profile: null,
      source: 'environment',
    });
  }

  const profile = explicitProfile ?? DEFAULT_PROFILE;
  // The policy and the credential are read while the lock of the profile is
  // held, so no other writer can change the binding in between.
  return files.withProfile(profile, false, async (file) => {
    const raw = await file.read();
    // The cancellation is checked again after the read, so a call that was
    // cancelled while the record was read never reaches the credential store.
    if (isCancelled(signal)) throw new AgentAuthError('INPUT_CANCELLED');
    if (raw === null || raw === undefined) throw new AgentAuthError('PROFILE_NOT_CONFIGURED');
    const stored = validateStoredProfile(raw, profile);
    // The opt-in of a stored profile persists: it was given on purpose when
    // the profile was configured.
    const allowLoopbackHttp = requested || stored.allowLoopbackHttp;
    // The bound origin is checked again before the credential store is
    // touched, so the store is only ever asked for one known origin.
    const origin = normalizeOrigin(stored.origin, allowLoopbackHttp);
    const override = normalizeOverride(baseUrl, allowLoopbackHttp);
    if (override !== null && override !== origin) throw new AgentAuthError('ORIGIN_MISMATCH');
    const token =
      stored.storage === 'file'
        ? secretValue(stored.token)
        : await readKeyringToken(keyring, profile, origin, signal);
    // The cancellation is checked again after the credential was read: a
    // credential that arrived after the call was cancelled is never used.
    if (isCancelled(signal)) throw new AgentAuthError('INPUT_CANCELLED');
    return freezeBundle({
      baseUrl: origin,
      credential: { origin, token },
      allowLoopbackHttp,
      profile,
      source: stored.storage,
    });
  });
}

/** Reports the local state of one profile. */
async function statusOf(
  files: ProfileFilesPort,
  keyring: KeyringPort,
  input: StatusInput,
): Promise<AgentAuthStatus> {
  if (typeof input !== 'object' || input === null) throw new AgentAuthError('INVALID_OPTIONS');
  // Everything the caller controls is read once, before the first await: a
  // caller that changes its own object while the read is running cannot
  // change the binding that is being reported.
  const explicitProfile = input.profile === undefined ? null : profileName(input.profile);
  const requested = loopbackOptIn(input.allowLoopbackHttp);
  const baseUrl = input.baseUrl;
  const pair = environmentPair(input.env, explicitProfile !== null);

  if (pair !== null) {
    const origin = normalizeOrigin(pair.origin, requested);
    const override = normalizeOverride(baseUrl, requested);
    if (override !== null && override !== origin) throw new AgentAuthError('ORIGIN_MISMATCH');
    // The credential is checked and dropped: a credential that cannot be used
    // is never reported as ready, and its value is never kept or shown.
    if (!isUsableSecret(pair.token)) {
      return {
        profile: null,
        origin,
        source: 'environment',
        ready: false,
        guidance: AGENT_AUTH_GUIDANCE.credentialUnusable,
      };
    }
    return {
      profile: null,
      origin,
      source: 'environment',
      ready: true,
      guidance: AGENT_AUTH_GUIDANCE.ready,
    };
  }

  const profile = explicitProfile ?? DEFAULT_PROFILE;
  // The policy and the credential are read while the lock of the profile is
  // held, so the report and the credential belong to the same binding.
  return files.withProfile(profile, false, async (file) => {
    const raw = await file.read();
    if (raw === null || raw === undefined) {
      return {
        profile,
        origin: null,
        source: null,
        ready: false,
        guidance: AGENT_AUTH_GUIDANCE.notConfigured,
      };
    }
    const stored = validateStoredProfile(raw, profile);
    const allowLoopbackHttp = requested || stored.allowLoopbackHttp;
    const origin = normalizeOrigin(stored.origin, allowLoopbackHttp);
    const override = normalizeOverride(baseUrl, allowLoopbackHttp);
    if (override !== null && override !== origin) throw new AgentAuthError('ORIGIN_MISMATCH');
    if (stored.storage === 'file') {
      return {
        profile,
        origin,
        source: 'file',
        ready: true,
        guidance: AGENT_AUTH_GUIDANCE.ready,
      };
    }
    try {
      const token = await keyring.get(profile, origin);
      if (token === null || token === undefined || token.trim() === '') {
        return {
          profile,
          origin,
          source: 'keyring',
          ready: false,
          guidance: AGENT_AUTH_GUIDANCE.credentialMissing,
        };
      }
      if (!isUsableSecret(token)) {
        return {
          profile,
          origin,
          source: 'keyring',
          ready: false,
          guidance: AGENT_AUTH_GUIDANCE.credentialUnusable,
        };
      }
      return {
        profile,
        origin,
        source: 'keyring',
        ready: true,
        guidance: AGENT_AUTH_GUIDANCE.ready,
      };
    } catch (error) {
      // The status never fails because a credential store is unhappy: it says
      // what is known and gives the fixed guidance for the situation.
      return {
        profile,
        origin,
        source: 'keyring',
        ready: false,
        guidance: guidanceForKeyring(error),
      };
    }
  });
}

/** Removes one profile from this machine. */
async function removeProfile(
  files: ProfileFilesPort,
  keyring: KeyringPort,
  profileInput: string,
): Promise<RemoveProfileResult> {
  const profile = profileName(profileInput);
  return files.withProfile(profile, false, async (file) => {
    const existing = await file.read();
    if (existing === null || existing === undefined) {
      throw new AgentAuthError('PROFILE_NOT_CONFIGURED');
    }
    const stored = validateStoredProfile(existing, profile);
    if (stored.storage === 'keyring') {
      // The credential leaves the credential store first. A store that is
      // locked, unavailable or uncertain leaves the profile alone, so the
      // profile is never half-removed.
      await keyring.remove(profile, stored.origin);
    }
    // The result says what the store confirmed: a removal that was not
    // confirmed is never reported as a removal.
    const removed = await file.remove();
    return {
      profile,
      source: stored.storage,
      removed,
      guidance: removed ? AGENT_AUTH_GUIDANCE.removed : AGENT_AUTH_GUIDANCE.removeUnconfirmed,
    };
  });
}

/**
 * The directory of the local store.
 *
 * The directory is either named by the caller as an absolute path or the
 * per-user configuration directory of this package. It is never derived from
 * the current working directory.
 */
export function resolveDirectory(options: AgentAuthOptions): string {
  const value = options?.directory;
  if (value === undefined) return join(homedir(), ...DEFAULT_DIRECTORY);
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new AgentAuthError('INVALID_OPTIONS');
  }
  if (value.includes('\0')) throw new AgentAuthError('INVALID_OPTIONS');
  if (!isAbsolute(value)) throw new AgentAuthError('INVALID_OPTIONS');
  return value;
}

/**
 * The local store, built the first time it is used.
 *
 * A platform without a supported store still creates the facade: the failure
 * is reported when the store is used, not when the facade is made.
 */
export function lazyProfileFiles(create: () => ProfileFilesPort): ProfileFilesPort {
  let instance: ProfileFilesPort | null = null;
  const resolve = (): ProfileFilesPort => {
    if (instance === null) instance = create();
    return instance;
  };
  return {
    withProfile: (name, createDirectory, action) =>
      resolve().withProfile(name, createDirectory, action),
  };
}

/** The credential store, built the first time it is used. */
export function lazyKeyring(create: () => KeyringPort): KeyringPort {
  let instance: KeyringPort | null = null;
  const resolve = (): KeyringPort => {
    if (instance === null) instance = create();
    return instance;
  };
  return {
    get: (profile, origin, signal) => resolve().get(profile, origin, signal),
    set: (profile, origin, token) => resolve().set(profile, origin, token),
    remove: (profile, origin) => resolve().remove(profile, origin),
  };
}

/**
 * Builds the facade on top of a set of stores.
 *
 * This is the internal seam the tests use. The public factory of the package
 * builds the same facade on top of the real stores and accepts no store of
 * its own, so a caller can never point the facade at a store of its choice.
 */
export function createProfileFacade(
  adapters: AgentAuthAdapters,
  options: AgentAuthOptions = {},
): AgentAuth {
  const directory = resolveDirectory(options);
  const files = lazyProfileFiles(() => adapters.createFiles(directory));
  const keyring = lazyKeyring(() => adapters.createKeyring());
  return {
    setProfile: (input) => setProfile(files, keyring, input),
    resolve: (input = {}) => resolveCredential(files, keyring, input),
    status: (input = {}) => statusOf(files, keyring, input),
    removeProfile: (profile) => removeProfile(files, keyring, profile),
  };
}
