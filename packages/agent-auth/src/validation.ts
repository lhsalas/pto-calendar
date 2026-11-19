import { AgentAuthError } from './errors.js';

export type StoredProfile = {
  version: 1;
  profile: string;
  origin: string;
  allowLoopbackHttp: boolean;
} & ({ storage: 'keyring' } | { storage: 'file'; token: string });

const PROFILE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const TOKEN =
  /^pto_pat_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[0-9a-f]{64}$/;
const ORIGIN =
  /^https?:\/\/(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[1-9][0-9]{0,4})?\/?$/i;
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);
const METADATA_FIELDS = ['version', 'profile', 'origin', 'allowLoopbackHttp', 'storage'];

export function requireProfileName(name: unknown): string {
  if (typeof name !== 'string' || !PROFILE.test(name)) throw new AgentAuthError('INVALID_PROFILE');
  return name;
}

export function requireToken(token: unknown): string {
  if (typeof token !== 'string' || !TOKEN.test(token)) throw new AgentAuthError('INVALID_TOKEN');
  return token;
}

/** Match the reviewed API client's admission rule before choosing any credential. */
export function normalizeOrigin(input: unknown, allowLoopbackHttp = false): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 512) {
    throw new AgentAuthError('INVALID_ORIGIN');
  }
  const matched = ORIGIN.exec(input);
  if (!matched) throw new AgentAuthError('INVALID_ORIGIN');
  const host = matched[1]!.toLowerCase();
  if (host.includes('..')) throw new AgentAuthError('INVALID_ORIGIN');
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AgentAuthError('INVALID_ORIGIN');
  }
  if (url.hostname !== host) throw new AgentAuthError('INVALID_ORIGIN');
  if (url.protocol === 'http:' && !(allowLoopbackHttp === true && LOOPBACK.has(host))) {
    throw new AgentAuthError('INVALID_ORIGIN');
  }
  return url.origin;
}

/** Never accept additional keys, values from accessors, or plain secrets on the keyring path. */
export function validateStoredProfile(value: unknown, profile: string): StoredProfile {
  const corrupt = () => new AgentAuthError('PROFILE_CORRUPT');
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw corrupt();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  const property = (key: string): unknown => descriptors[key]?.value;
  const storage = property('storage');
  if (storage !== 'keyring' && storage !== 'file') throw corrupt();
  const fields = storage === 'file' ? [...METADATA_FIELDS, 'token'] : METADATA_FIELDS;
  if (
    keys.length !== fields.length ||
    keys.some(
      (key) =>
        !fields.includes(key) ||
        !descriptors[key]!.enumerable ||
        !Object.hasOwn(descriptors[key]!, 'value'),
    )
  ) {
    throw corrupt();
  }
  const allowLoopbackHttp = property('allowLoopbackHttp');
  if (
    property('version') !== 1 ||
    property('profile') !== profile ||
    typeof allowLoopbackHttp !== 'boolean'
  ) {
    throw corrupt();
  }
  try {
    requireProfileName(profile);
    const origin = normalizeOrigin(property('origin'), allowLoopbackHttp);
    if (origin !== property('origin')) throw corrupt();
    const metadata = { version: 1 as const, profile, origin, allowLoopbackHttp };
    return storage === 'file'
      ? { ...metadata, storage, token: requireToken(property('token')) }
      : { ...metadata, storage };
  } catch {
    throw corrupt();
  }
}
