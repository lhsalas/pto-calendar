/**
 * Explicit secret input.
 *
 * This is the only place a secret may be typed or piped. It belongs to the
 * setup command alone: no resolution, no status and no removal path ever
 * reads a secret, so a tool call can never open a prompt.
 *
 * The reader never prints a label, never writes to the terminal, never echoes
 * what it reads and never puts a secret into an argument or an environment
 * variable. It returns the secret to its caller and nothing else.
 */

import { Readable } from 'node:stream';

import { AgentAuthError } from './errors.js';
import { requireToken } from './validation.js';

/**
 * The largest secret this reader accepts, in bytes.
 *
 * The bound covers the whole input, the line marker included. A personal
 * access token is far shorter than this. The bound keeps a runaway pipe from
 * filling the memory of the setup command.
 */
export const MAX_SECRET_BYTES = 256;

/** Where the secret comes from. */
export type SecretInputMode = 'stdin' | 'tty';

/**
 * The trusted stream this reader may use.
 *
 * The default is `process.stdin`. A caller may name its own stream, which is
 * how the tests use a synthetic one. The reader never opens a file, never
 * runs a process and never touches the network.
 */
export type SecretInputSource = Readable & {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

/** The options of the reader. */
export interface SecretInputOptions {
  /** `stdin` reads one line from a pipe, `tty` reads a hidden line. */
  readonly mode: SecretInputMode;
  /** The trusted stream to read. The default is `process.stdin`. */
  readonly input?: SecretInputSource;
  /** Cancels the read. */
  readonly signal?: AbortSignal;
}

/** The end of a line. */
const LINE_FEED = 0x0a;

/** The end of a line on a terminal. */
const CARRIAGE_RETURN = 0x0d;

/** The cancel key of a terminal. */
const CANCEL = 0x03;

/** The erase key of a terminal. */
const ERASE = 0x7f;

/** The older erase key of a terminal. */
const BACKSPACE = 0x08;

/** The last printable character of ASCII. */
const LAST_PRINTABLE = 0x7e;

/**
 * The trusted stream of the reader.
 *
 * A value that is not a readable stream is refused instead of being used.
 */
function requireSource(value: unknown): SecretInputSource {
  if (!(value instanceof Readable)) throw new AgentAuthError('INPUT_UNAVAILABLE');
  return value as SecretInputSource;
}

/**
 * The stream has to be able to carry the secret.
 *
 * A stream that is already gone, that already ended or that another reader
 * is already consuming is refused: the secret would be read twice or never.
 */
function requireUsableSource(source: SecretInputSource): void {
  if (source.readableEnded === true) throw new AgentAuthError('INPUT_REQUIRED');
  if (source.destroyed === true) throw new AgentAuthError('INPUT_UNAVAILABLE');
  if (source.listenerCount('data') > 0) throw new AgentAuthError('INPUT_UNAVAILABLE');
  if (source.listenerCount('readable') > 0) throw new AgentAuthError('INPUT_UNAVAILABLE');
}

/**
 * The bytes of one chunk.
 *
 * A stream may deliver text or bytes. The reader works on bytes, so the
 * bound is a bound on bytes and not on characters.
 */
function bytesOf(chunk: unknown): Buffer | null {
  if (typeof chunk === 'string') {
    return Buffer.byteLength(chunk, 'utf8') <= MAX_SECRET_BYTES ? Buffer.from(chunk, 'utf8') : null;
  }
  return Buffer.isBuffer(chunk) && chunk.length <= MAX_SECRET_BYTES ? chunk : null;
}

/**
 * A failure of the stream after the read is over.
 *
 * The reader takes the failure of the stream away from the caller and leaves
 * one listener behind that swallows whatever the stream reports afterwards:
 * a late failure must never become an unhandled error event with its raw
 * cause in it.
 */
function swallowStreamError(): void {
  // Nothing is reported, and nothing is shown.
}

function retainLateErrorGuard(source: SecretInputSource): void {
  if (!source.listeners('error').includes(swallowStreamError)) {
    source.on('error', swallowStreamError);
  }
}

/**
 * The flow of a stream, so it can be put back the way it was found.
 *
 * A stream that was not flowing is paused again, and a stream that was
 * flowing keeps flowing. The restoration is reported: a stream that cannot
 * be put back is never reported as a read that worked.
 */
function restoreFlow(source: SecretInputSource, previous: boolean | null | undefined): boolean {
  try {
    if (previous === true) source.resume();
    else source.pause();
    return true;
  } catch {
    return false;
  }
}

/** The one line of a finished input. */
type LineOutcome =
  | { readonly ok: true; readonly line: string }
  | { readonly ok: false; readonly error: AgentAuthError };

/**
 * The one line of a finished input.
 *
 * The input has to be exactly one line that ends with a line marker, and
 * nothing may follow that marker: a second line, an empty second line and
 * trailing spaces are all refused. The end marker of a terminal may be
 * preceded by a carriage return.
 */
function completeLine(chunks: Buffer[]): LineOutcome {
  const input = Buffer.concat(chunks);
  const marker = input.indexOf(LINE_FEED);
  if (marker === -1) {
    // The input ended before a line was complete.
    return { ok: false, error: new AgentAuthError('INPUT_REQUIRED') };
  }
  if (input.length !== marker + 1) {
    // More than one line, or anything at all after the line marker.
    return { ok: false, error: new AgentAuthError('INPUT_UNAVAILABLE') };
  }
  let line = input.subarray(0, marker).toString('utf8');
  if (line.endsWith('\r')) line = line.slice(0, -1);
  return { ok: true, line };
}

/**
 * Reads one line from a pipe.
 *
 * The input has to be exactly one line that ends with a line marker, and the
 * reader waits for the end of the input before it judges it: a line that is
 * followed by more bytes is refused, however late those bytes arrive.
 *
 * The bytes are counted before they are buffered, so an oversized input
 * never fills the memory of the setup command. A source that fails, that
 * goes away, that already ended or that another reader is already consuming
 * is refused with a fixed code, and no read is left hanging.
 */
function readFromStream(
  source: SecretInputSource,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (source.isTTY === true) {
    // A terminal in its ordinary mode echoes what is typed, so a terminal is
    // only accepted by the hidden reader.
    return Promise.reject(new AgentAuthError('INPUT_UNAVAILABLE'));
  }
  requireUsableSource(source);
  const previousFlowing = source.readableFlowing;
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const cleanup = (): boolean => {
      source.off('data', onData);
      source.off('end', onEnd);
      source.off('close', onClose);
      source.off('error', onError);
      // The stream keeps one listener that swallows a failure that arrives
      // after the read is over, so a late failure never becomes an
      // unhandled error event with its raw cause in it.
      retainLateErrorGuard(source);
      signal?.removeEventListener('abort', onAbort);
      return restoreFlow(source, previousFlowing);
    };
    const settle = (error: AgentAuthError | null, value = ''): void => {
      const restored = cleanup();
      if (error === null && !restored) {
        reject(new AgentAuthError('INPUT_UNAVAILABLE'));
        return;
      }
      if (error === null) resolve(value);
      else reject(error);
    };
    const onData = (chunk: unknown): void => {
      const bytes = bytesOf(chunk);
      if (bytes === null) {
        settle(new AgentAuthError('INPUT_UNAVAILABLE'));
        return;
      }
      // The bytes are counted before they are buffered.
      total += bytes.length;
      if (total > MAX_SECRET_BYTES) {
        settle(new AgentAuthError('INPUT_UNAVAILABLE'));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = (): void => {
      const outcome = completeLine(chunks);
      if (!outcome.ok) {
        settle(outcome.error);
        return;
      }
      settle(null, outcome.line);
    };
    const onError = (): void => {
      // The failure of the source is reported as a fixed code: the cause of
      // the failure is never shown.
      settle(new AgentAuthError('INPUT_UNAVAILABLE'));
    };
    const onClose = (): void => {
      // The source went away before the input was complete.
      settle(new AgentAuthError('INPUT_REQUIRED'));
    };
    const onAbort = (): void => {
      settle(new AgentAuthError('INPUT_CANCELLED'));
    };
    if (signal) {
      if (signal.aborted) {
        settle(new AgentAuthError('INPUT_CANCELLED'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      source.on('end', onEnd);
      source.on('error', onError);
      source.on('close', onClose);
      source.on('data', onData);
      source.resume();
    } catch {
      settle(new AgentAuthError('INPUT_UNAVAILABLE'));
    }
  });
}

/**
 * Reads one hidden line from a terminal.
 *
 * The terminal is put into its raw mode before a single byte is read, so
 * nothing is echoed and the cancel key reaches this reader instead of the
 * process. The raw mode and the flow of the terminal are put back on every
 * way out of this reader, and a terminal that cannot be put back is reported
 * as unusable instead of as a read that worked.
 */
function readFromTerminal(
  source: SecretInputSource,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (source.isTTY !== true) throw new AgentAuthError('INPUT_UNAVAILABLE');
  const setRawMode = source.setRawMode;
  if (typeof setRawMode !== 'function') throw new AgentAuthError('INPUT_UNAVAILABLE');
  requireUsableSource(source);
  const previousRaw = source.isRaw === true;
  const previousFlowing = source.readableFlowing;
  return new Promise<string>((resolve, reject) => {
    let secret = '';
    let rawEntered = false;
    const cleanup = (): boolean => {
      source.off('data', onData);
      source.off('end', onEnd);
      source.off('close', onClose);
      source.off('error', onError);
      // The terminal keeps one listener that swallows a failure that arrives
      // after the read is over, so a late failure never becomes an
      // unhandled error event with its raw cause in it.
      retainLateErrorGuard(source);
      signal?.removeEventListener('abort', onAbort);
      let restored = true;
      if (rawEntered) {
        try {
          setRawMode.call(source, previousRaw);
        } catch {
          // A terminal that cannot be put back was not used well.
          restored = false;
        }
      }
      if (!restoreFlow(source, previousFlowing)) restored = false;
      return restored;
    };
    const settle = (error: AgentAuthError | null, value = ''): void => {
      const restored = cleanup();
      if (error === null && !restored) {
        reject(new AgentAuthError('INPUT_UNAVAILABLE'));
        return;
      }
      if (error === null) resolve(value);
      else reject(error);
    };
    const onData = (chunk: unknown): void => {
      const bytes = bytesOf(chunk);
      if (bytes === null) {
        settle(new AgentAuthError('INPUT_UNAVAILABLE'));
        return;
      }
      for (const byte of bytes) {
        if (byte === CANCEL) {
          settle(new AgentAuthError('INPUT_CANCELLED'));
          return;
        }
        if (byte === CARRIAGE_RETURN || byte === LINE_FEED) {
          settle(null, secret);
          return;
        }
        if (byte === ERASE || byte === BACKSPACE) {
          secret = secret.slice(0, -1);
          continue;
        }
        if (byte < 0x20 || byte > LAST_PRINTABLE) {
          // A control character or an escape sequence is never part of a
          // secret this reader hands on.
          settle(new AgentAuthError('INPUT_UNAVAILABLE'));
          return;
        }
        secret += String.fromCharCode(byte);
        if (secret.length > MAX_SECRET_BYTES) {
          settle(new AgentAuthError('INPUT_UNAVAILABLE'));
          return;
        }
      }
    };
    const onError = (): void => {
      settle(new AgentAuthError('INPUT_UNAVAILABLE'));
    };
    const onEnd = (): void => {
      // The terminal reached its end without a line: there is no secret.
      settle(new AgentAuthError('INPUT_REQUIRED'));
    };
    const onClose = (): void => {
      settle(new AgentAuthError('INPUT_REQUIRED'));
    };
    const onAbort = (): void => {
      settle(new AgentAuthError('INPUT_CANCELLED'));
    };
    if (signal) {
      if (signal.aborted) {
        settle(new AgentAuthError('INPUT_CANCELLED'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    // The terminal is put into its raw mode first: only then is the input
    // read, so nothing is echoed and nothing is missed.
    try {
      setRawMode.call(source, true);
      rawEntered = true;
    } catch {
      settle(new AgentAuthError('INPUT_UNAVAILABLE'));
      return;
    }
    try {
      source.on('end', onEnd);
      source.on('error', onError);
      source.on('close', onClose);
      source.on('data', onData);
      source.resume();
    } catch {
      settle(new AgentAuthError('INPUT_UNAVAILABLE'));
    }
  });
}

/**
 * The secret of a line.
 *
 * An empty line is no secret at all, and a line that is not a token is
 * refused by the shared validator. The secret is returned to the caller and
 * is never written anywhere.
 */
function secretOf(line: string): string {
  if (line.length === 0) throw new AgentAuthError('INPUT_REQUIRED');
  return requireToken(line);
}

/**
 * Reads a secret from a pipe or from a terminal.
 *
 * This call belongs to the setup command alone. It is never made by
 * `resolve`, `status` or `removeProfile`, so no tool call ever opens a
 * prompt.
 *
 * The limits are deliberate: the input is at most 256 bytes, it is exactly
 * one line that ends with a line marker, nothing may follow that marker, a
 * control character is refused, a terminal is read in its raw mode so
 * nothing is echoed, and the raw mode and the flow of the terminal are
 * restored on every way out. A cancelled or aborted read stops at once, and
 * a source that fails or that has already been consumed is refused with a
 * fixed code instead of hanging.
 */
export async function readSecretInput(options: SecretInputOptions): Promise<string> {
  if (typeof options !== 'object' || options === null) {
    throw new AgentAuthError('INVALID_OPTIONS');
  }
  const mode = options.mode;
  if (mode !== 'stdin' && mode !== 'tty') throw new AgentAuthError('INVALID_OPTIONS');
  const signal = options.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new AgentAuthError('INVALID_OPTIONS');
  }
  const provided = options.input === undefined ? process.stdin : options.input;
  const source = requireSource(provided);
  const line =
    mode === 'tty' ? await readFromTerminal(source, signal) : await readFromStream(source, signal);
  return secretOf(line);
}
