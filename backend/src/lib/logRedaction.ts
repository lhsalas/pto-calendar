/**
 * Credential-safe logging transforms (#252). Pino path redaction is shallow by
 * design: `*.token` reaches one level only, so deeper credential shapes would
 * pass unchanged. These transforms walk arbitrary payloads before pino
 * serializes them, so a credential key is recognized at any depth instead of at
 * a fixed wildcard depth.
 *
 * Request and response objects are left to their allowlisting serializers, which
 * are the only sanctioned way to log those objects. Errors are owned by the
 * error serializer, which scrubs them at any depth.
 */

export const REDACTED = '[REDACTED]';

const MAX_DEPTH = 8;
const MAX_ENTRIES = 100;

// Normalized names (lowercase, without `-` or `_`), so `raw_token`, `rawToken`
// and `Raw-Token` are all covered. Identifiers such as tokenId stay visible:
// they are public attribution, not credentials.
const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'passwordconfirmation',
  'newpassword',
  'oldpassword',
  'currentpassword',
  'token',
  'rawtoken',
  'tokenvalue',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'bearertoken',
  'secret',
  'secretdigest',
  'digest',
  'clientsecret',
  'sessionsecret',
  'apikey',
  'privatekey',
  'setuptoken',
  'setupsecret',
  'setuptokenhash',
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  // The credential descriptor and its closed type vocabulary are attribution
  // metadata for the audit trail, not general log content.
  'credential',
  'credentials',
  'credentialtype',
]);

// Objects with dedicated serializers. The formatter must not rewrite them,
// because a raw request carries headers that only the serializer may emit and
// an error carries a stack that only the error serializer may summarize.
const SERIALIZER_KEYS = new Set(['req', 'res', 'err']);

const PERSONAL_TOKEN = /pto_pat_[^\s"'`<>]*/gi;
const SHA256_HEX = /\b[0-9a-f]{64}\b/gi;
const BEARER_CREDENTIAL = /\bBearer\s+[^\s"'`,;]+/gi;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.replace(/[-_]/g, '').toLowerCase());
}

/** Removes personal tokens, 64-hex digests/setup secrets and bearer credentials from text. */
export function scrubString(value: string): string {
  return value
    .replace(PERSONAL_TOKEN, REDACTED)
    .replace(SHA256_HEX, REDACTED)
    .replace(BEARER_CREDENTIAL, `Bearer ${REDACTED}`);
}

/**
 * Scrubs an arbitrary value. The result is a fresh structure: the input is never
 * mutated, and cycles, oversized breadth, excessive depth and binary payloads are
 * replaced by markers rather than being emitted.
 */
export function scrubValue(value: unknown): unknown {
  return scrub(value, 0, new WeakSet<object>());
}

function scrub(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof Date) return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[Binary]';
  if (ancestors.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]';
  ancestors.add(value);
  try {
    if (value instanceof Error) return scrubError(value, depth, ancestors);
    if (Array.isArray(value)) return scrubArray(value, depth, ancestors);
    return scrubObject(value, depth, ancestors);
  } finally {
    // Only ancestors count as cycles; a shared, non-circular reference scrubs again.
    ancestors.delete(value);
  }
}

function scrubArray(items: unknown[], depth: number, ancestors: WeakSet<object>): unknown[] {
  const kept = items.slice(0, MAX_ENTRIES).map((item) => scrub(item, depth + 1, ancestors));
  if (items.length > MAX_ENTRIES) kept.push(`[${items.length - MAX_ENTRIES} more]`);
  return kept;
}

function scrubObject(
  object: object,
  depth: number,
  ancestors: WeakSet<object>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(object).slice(0, MAX_ENTRIES)) {
    out[key] = scrubEntry(object, key, depth, ancestors);
  }
  return out;
}

function scrubError(
  error: Error,
  depth: number,
  ancestors: WeakSet<object>,
): Record<string, unknown> {
  // Pino's own error serializer copies enumerable properties, which can carry
  // driver details. Here every value is scrubbed, including the type, the
  // message and the stack: an error name is attacker-influenced text.
  const out: Record<string, unknown> = {
    type: scrubString(String(error.name)),
    message: scrubString(String(error.message)),
    stack: scrubString(String(error.stack ?? '')),
  };
  for (const key of Object.keys(error).slice(0, MAX_ENTRIES)) {
    if (!(key in out)) out[key] = scrubEntry(error, key, depth, ancestors);
  }
  if (error.cause !== undefined) out['cause'] = scrub(error.cause, depth + 1, ancestors);
  return out;
}

function scrubEntry(
  source: object,
  key: string,
  depth: number,
  ancestors: WeakSet<object>,
): unknown {
  if (isSensitiveKey(key)) return REDACTED;
  try {
    return scrub((source as Record<string, unknown>)[key], depth + 1, ancestors);
  } catch {
    // A throwing getter must not stop the log line or reveal its message.
    return '[Unreadable]';
  }
}

/**
 * Scrubs the keys of one log payload. Serializer-owned keys pass through so
 * their allowlists can apply; every other entry is scrubbed at any depth.
 */
function scrubStructured(object: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(object)) {
    out[key] = SERIALIZER_KEYS.has(key)
      ? object[key]
      : isSensitiveKey(key)
        ? REDACTED
        : scrub(object[key], 0, new WeakSet<object>());
  }
  return out;
}

/**
 * pino `formatters.log`: runs on the raw merging object, before serializers.
 * Serializer-owned keys pass through so their allowlists can apply; every other
 * entry is scrubbed at any depth.
 */
export function scrubLogObject(object: Record<string, unknown>): Record<string, unknown> {
  return scrubStructured(object);
}

/**
 * Scrubs message and interpolation data. No serializer owns these values, so
 * every key is scrubbed here — including `req`, `res` and `err`, whose
 * allowlisting serializers never run for interpolated arguments.
 */
export function scrubLogData(value: unknown): unknown {
  return scrub(value, 0, new WeakSet<object>());
}

/**
 * pino `hooks.streamWrite`: the last boundary before a record reaches the
 * stream. Child-logger bindings are serialized apart from the merging object
 * and never pass through `formatters.log`, so the finished record is scrubbed
 * here. This is what makes an arbitrarily deep bound credential safe.
 */
export function scrubLogLine(line: string): string {
  const ending = /\r?\n$/.exec(line);
  const body = ending ? line.slice(0, line.length - ending[0].length) : line;
  const suffix = ending ? ending[0] : '';
  try {
    const record = JSON.parse(body) as unknown;
    return `${JSON.stringify(scrubLogData(record))}${suffix}`;
  } catch {
    // A line that is not JSON is scrubbed as text rather than dropped.
    return scrubString(line);
  }
}

/** Error serializer for pino's `err` key: scrubbed at any depth, never a raw copy. */
export function safeErrorSerializer(value: unknown): unknown {
  return scrubValue(value);
}

/**
 * Message serializer for pino's `msg` key. The message is built after the
 * arguments are formatted, so this is the last place where interpolated
 * credentials can still be removed.
 */
export function safeMessageSerializer(value: unknown): unknown {
  return typeof value === 'string' ? scrubString(value) : value;
}

/**
 * Scrubs one argument of a log call. The first argument is the structured log
 * payload when it is an object, so the request, response and error serializers
 * still own their keys there. Every other argument is message or interpolation
 * data, where no serializer applies and every key is scrubbed.
 */
function scrubLogArgument(value: unknown, structured: boolean): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value instanceof Error) return structured ? value : scrubLogData(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value) || value instanceof Date) return scrubLogData(value);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return scrubLogData(value);
  return structured ? scrubStructured(value as Record<string, unknown>) : scrubLogData(value);
}

/**
 * pino `hooks.logMethod`: scrubs every argument, including message text,
 * interpolated values and structured payloads. Objects are left to the
 * formatter and serializers above.
 */
export function scrubLogMethodArguments(
  this: unknown,
  args: unknown[],
  method: (...values: unknown[]) => void,
): void {
  const [payload, ...rest] = args;
  method.apply(this, [
    scrubLogArgument(payload, true),
    ...rest.map((arg) => scrubLogArgument(arg, false)),
  ]);
}
