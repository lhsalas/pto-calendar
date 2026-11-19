/**
 * The Linux OS credential store lane of the agent credential package.
 *
 * A credential is kept in the freedesktop Secret Service through one fixed,
 * bundled Python helper. The helper runs as an absolute, isolated interpreter
 * with one bounded JSON request on stdin and one bounded JSON answer on
 * stdout, so a token never reaches an argument, the environment, a log or an
 * error message.
 *
 * The store is scoped. A record is found only when its namespace, profile and
 * origin attributes match exactly, so a record of another application is never
 * read, changed or removed. A lookup refuses an ambiguous or a locked match
 * instead of unlocking anything, and it never prompts. Only an explicit set or
 * remove may ask the secret service to prompt, and an outcome that cannot be
 * confirmed is always a failure.
 *
 * The helper is bound to one explicit local Unix session bus. A TCP address, a
 * list of addresses and an address that would let a bus be autolaunched are
 * refused, so the helper never reaches a bus that the user did not name. The
 * helper never starts the secret service either: a service that is not already
 * running is reported as unavailable.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';

import { AgentAuthError } from './errors.js';
import { normalizeOrigin, requireProfileName, requireToken } from './validation.js';

/**
 * The OS credential store of the agent credential package.
 *
 * Every method checks its scope the same way, so a profile and an origin mean
 * the same thing in a read, in a write and in a removal.
 */
export interface Keyring {
  /** The token stored for the profile at the origin, or null when there is none. */
  get(profile: string, origin: string): Promise<string | null>;
  /** Stores the token of the profile at the origin. */
  set(profile: string, origin: string, token: string): Promise<void>;
  /** Removes the token of the profile at the origin and reports whether one was there. */
  remove(profile: string, origin: string): Promise<boolean>;
}

/** The absolute interpreter of the bundled helper. */
const PYTHON = '/usr/bin/python3';

/** The bundled helper, resolved next to this module. */
const HELPER = fileURLToPath(new URL('../libexec/secret-service.py', import.meta.url));

/** The isolated flags of the helper: no user site, no environment, no bytecode. */
const PYTHON_ARGS: readonly string[] = ['-I', '-B', HELPER];

/**
 * The longest one helper call may take.
 *
 * A helper that has not answered by then is stopped and the call fails at that
 * moment. The call never waits for the helper to close its pipes.
 */
const HELPER_TIMEOUT_MS = 10_000;

/** The bound of one answer. A larger answer is a failure, never a partial read. */
const MAX_RESPONSE_BYTES = 4 * 1024;

/** The bound of one session bus address. */
const MAX_BUS_ADDRESS_LENGTH = 4096;

/**
 * The syntax of one local Unix session bus address.
 *
 * The transport is always `unix`, the value is either an absolute path or an
 * abstract socket name, and the canonical guid is optional. A list of addresses
 * is separated by a semicolon, which the syntax below does not admit, and no
 * other transport is admitted either.
 */
const UNIX_BUS_ADDRESS = /^unix:(path|abstract)=([^,;]+)(?:,guid=([0-9a-fA-F]{32}))?$/;

/** The operations of the helper protocol. */
type HelperOperation = 'get' | 'set' | 'remove';

/** One request of the helper protocol. */
interface HelperRequest {
  op: HelperOperation;
  profile: string;
  origin: string;
  token?: string;
}

/** One answer of the helper protocol, before it is checked. */
interface HelperResponse {
  status: string;
  token?: unknown;
  code?: unknown;
}

/** The checked scope of one credential. */
interface CredentialScope {
  profile: string;
  origin: string;
}

/**
 * Fail closed on a host that has no Secret Service.
 *
 * The platform is checked when the store is created and again before every
 * operation, so a store that was created elsewhere cannot be used to reach
 * another platform.
 */
function assertLinux(): void {
  if (process.platform !== 'linux') {
    throw new AgentAuthError('KEYRING_UNSUPPORTED');
  }
}

/** True when the address names one local Unix session bus. */
function isLocalUnixBus(address: string): boolean {
  const match = UNIX_BUS_ADDRESS.exec(address);
  if (!match) return false;
  return match[1] === 'abstract' || match[2]!.startsWith('/');
}

/**
 * The one session bus the helper is bound to.
 *
 * A TCP address, a list of addresses and an address that would let the bus be
 * autolaunched are all refused. Without an explicit local Unix address, the
 * helper is not started at all.
 */
function sessionBusAddress(): string {
  const address = process.env['DBUS_SESSION_BUS_ADDRESS']?.trim() ?? '';
  if (address.length === 0 || address.length > MAX_BUS_ADDRESS_LENGTH || !isLocalUnixBus(address)) {
    throw new AgentAuthError('KEYRING_UNAVAILABLE');
  }
  return address;
}

/**
 * The environment of the helper.
 *
 * The environment is exactly the one explicit local session bus address. No
 * inherited variable is forwarded, not a path, a locale, a debug switch or a
 * variable that could start a bus on its own.
 */
function helperEnvironment(): Record<string, string> {
  return { DBUS_SESSION_BUS_ADDRESS: sessionBusAddress() };
}

/**
 * Map the fixed code of the helper onto the fixed error of this package.
 *
 * An unknown code is a failure: a code that this package does not know can
 * never be reported as a different, milder outcome.
 */
function helperError(code: unknown): AgentAuthError {
  switch (code) {
    case 'unsupported':
      return new AgentAuthError('KEYRING_UNSUPPORTED');
    case 'unavailable':
      return new AgentAuthError('KEYRING_UNAVAILABLE');
    case 'locked':
      return new AgentAuthError('KEYRING_LOCKED');
    case 'ambiguous':
      return new AgentAuthError('KEYRING_AMBIGUOUS');
    default:
      return new AgentAuthError('KEYRING_FAILED');
  }
}

/** Read one bounded answer of the helper protocol. */
function parseResponse(text: string): HelperResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AgentAuthError('KEYRING_FAILED');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AgentAuthError('KEYRING_FAILED');
  }
  const record = parsed as Record<string, unknown>;
  const status = record['status'];
  if (typeof status !== 'string') {
    throw new AgentAuthError('KEYRING_FAILED');
  }
  const response: HelperResponse = { status };
  if ('token' in record) response.token = record['token'];
  if ('code' in record) response.code = record['code'];
  return response;
}

/**
 * Wipe the request and every answer byte that one call holds.
 *
 * A JavaScript string cannot be wiped. The request and the answer are kept as
 * bytes for as short a time as possible, and the strings that the helper
 * protocol needs are created only where a value is returned.
 */
function redact(body: Buffer, chunks: Buffer[]): void {
  body.fill(0);
  for (const chunk of chunks) chunk.fill(0);
  chunks.length = 0;
}

/** Start the helper with no shell, from the absolute interpreter and the bundled script. */
function startHelper(
  environment: Record<string, string>,
): ChildProcessByStdio<Writable, Readable, Readable> | null {
  try {
    return spawn(PYTHON, [...PYTHON_ARGS], {
      cwd: '/',
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
  } catch {
    return null;
  }
}

/**
 * Run the helper once and read its answer.
 *
 * The helper receives only the request on stdin, and its standard error is read
 * and dropped. The first of these outcomes settles the call: an answer that is
 * closed in time, an answer that is too large, a timeout, a signal, or a helper
 * that cannot be started. The outcome is settled first. Then the request and
 * every answer byte are wiped, and only then is a helper that may still be
 * running stopped. A late event never changes a settled call.
 */
function runHelper(request: HelperRequest): Promise<HelperResponse> {
  if (!existsSync(HELPER)) {
    throw new AgentAuthError('KEYRING_UNSUPPORTED');
  }
  const environment = helperEnvironment();
  return new Promise<HelperResponse>((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(request), 'utf8');
    const child = startHelper(environment);
    if (child === null) {
      body.fill(0);
      reject(new AgentAuthError('KEYRING_UNAVAILABLE'));
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    let exited = false;

    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
      redact(body, chunks);
      if (!exited) child.kill('SIGKILL');
    };

    const timer = setTimeout(() => {
      finish(() => reject(new AgentAuthError('KEYRING_UNAVAILABLE')));
    }, HELPER_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) {
        chunk.fill(0);
        return;
      }
      chunks.push(chunk);
      received += chunk.length;
      if (received > MAX_RESPONSE_BYTES) {
        finish(() => reject(new AgentAuthError('KEYRING_FAILED')));
      }
    });

    child.stderr.on('data', () => {
      // The helper never writes a diagnostic, and whatever it writes is dropped.
    });

    child.stdin.on('error', () => {
      // A helper that stops reading is reported through its exit, not here.
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      exited = true;
      finish(() =>
        reject(
          new AgentAuthError(
            error.code === 'ENOENT' ? 'KEYRING_UNSUPPORTED' : 'KEYRING_UNAVAILABLE',
          ),
        ),
      );
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      exited = true;
      if (signal !== null) {
        finish(() => reject(new AgentAuthError('KEYRING_UNAVAILABLE')));
        return;
      }
      if (code !== 0) {
        finish(() => reject(new AgentAuthError('KEYRING_FAILED')));
        return;
      }
      const joined = Buffer.concat(chunks);
      const text = joined.toString('utf8');
      joined.fill(0);
      let response: HelperResponse;
      try {
        response = parseResponse(text);
      } catch (error) {
        finish(() => reject(error));
        return;
      }
      finish(() => resolve(response));
    });

    child.stdin.end(body);
  });
}

/**
 * Check the scope of one credential.
 *
 * The profile is checked, and the origin is normalized the way the reviewed
 * client admits it. Plain HTTP is admitted only for a loopback host, and only
 * in the exact form that the facade has already approved. Two spellings of one
 * origin therefore never reach two different records.
 */
function credentialScope(profile: string, origin: string): CredentialScope {
  assertLinux();
  requireProfileName(profile);
  return { profile, origin: normalizeOrigin(origin, true) };
}

/** The token of a successful read. A value that is not a credential is a failure. */
function storedToken(value: unknown): string {
  try {
    return requireToken(value);
  } catch {
    throw new AgentAuthError('KEYRING_FAILED');
  }
}

/** Read one credential. A lookup never unlocks and never prompts. */
async function getCredential(profile: string, origin: string): Promise<string | null> {
  const scope = credentialScope(profile, origin);
  const response = await runHelper({ op: 'get', profile: scope.profile, origin: scope.origin });
  if (response.status === 'ok') return storedToken(response.token);
  if (response.status === 'missing') return null;
  if (response.status === 'error') throw helperError(response.code);
  throw new AgentAuthError('KEYRING_FAILED');
}

/** Store one credential. Only an ok answer is a success. */
async function setCredential(profile: string, origin: string, token: string): Promise<void> {
  const scope = credentialScope(profile, origin);
  const secret = requireToken(token);
  const response = await runHelper({
    op: 'set',
    profile: scope.profile,
    origin: scope.origin,
    token: secret,
  });
  if (response.status === 'ok') return;
  if (response.status === 'error') throw helperError(response.code);
  throw new AgentAuthError('KEYRING_FAILED');
}

/** Remove one credential. Only a removed or an absent answer is a success. */
async function removeCredential(profile: string, origin: string): Promise<boolean> {
  const scope = credentialScope(profile, origin);
  const response = await runHelper({ op: 'remove', profile: scope.profile, origin: scope.origin });
  if (response.status === 'removed') return true;
  if (response.status === 'absent') return false;
  if (response.status === 'error') throw helperError(response.code);
  throw new AgentAuthError('KEYRING_FAILED');
}

/**
 * Create the Linux OS credential store.
 *
 * The store talks to the freedesktop Secret Service. It has no file fallback:
 * a host without a usable secret service reports that it is unsupported or
 * unavailable instead of keeping a credential somewhere else.
 */
export function createLinuxKeyring(): Keyring {
  assertLinux();
  const keyring: Keyring = {
    get: (profile, origin) => getCredential(profile, origin),
    set: (profile, origin, token) => setCredential(profile, origin, token),
    remove: (profile, origin) => removeCredential(profile, origin),
  };
  return Object.freeze(keyring);
}
