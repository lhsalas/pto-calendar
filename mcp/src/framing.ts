/**
 * Newline-delimited stdio framing for the local MCP server.
 *
 * The guard sits between the process stdin and the SDK's stdio transport. It
 * keeps at most one bounded frame in memory, answers the frames the protocol
 * must never see with a fixed JSON-RPC error, and waits for the output to
 * drain before it hands another frame to the protocol. Nothing it reads is
 * echoed: the only bytes it writes are the fixed replies below, in the wire
 * format of the protocol.
 */

import { Transform, type TransformCallback, type Writable } from 'node:stream';

import {
  InitializeRequestSchema,
  JSONRPCMessageSchema,
  PingRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/** The largest frame, in bytes, without its newline. */
export const MAX_FRAME_BYTES = 256 * 1024;

/** The JSON-RPC error code of a frame that is not JSON. */
export const PARSE_ERROR = -32700;

/** The JSON-RPC error code of a frame that is JSON but not a valid message. */
export const INVALID_REQUEST = -32600;

/** The JSON-RPC error code of a request for a method this server does not serve. */
export const METHOD_NOT_FOUND = -32601;

/** The JSON-RPC error code of a request whose params this server does not accept. */
export const INVALID_PARAMS = -32602;

/**
 * The request methods this server answers. `initialize` and `ping` are answered by the SDK, and
 * the two tool methods by the server. A request for any other method is answered here.
 */
export const SERVED_METHODS: readonly string[] = ['initialize', 'ping', 'tools/list', 'tools/call'];

/**
 * The SDK's own params schemas for the requests it answers without the server's help. They are
 * checked here first, because the SDK reports a failed check with the schema issues, and those
 * issues can quote the values that were sent.
 */
interface ParamsCheck {
  safeParse(value: unknown): { success: boolean };
}

const SDK_REQUEST_SCHEMAS: ReadonlyMap<string, ParamsCheck> = new Map<string, ParamsCheck>([
  ['initialize', InitializeRequestSchema],
  ['ping', PingRequestSchema],
]);

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const SPACE = 0x20;
const TAB = 0x09;
const NEWLINE_FRAME = Buffer.from('\n');

/** A bounded ASCII name. Underscores are not admitted, because token prefixes use them. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,63}$/;

/** The canonical UUID shape that clients use as a request id. */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The prefix of a personal access token. A name that carries it is never repeated. */
const PERSONAL_TOKEN_PREFIX = /pto_pat/i;

/** A name with this many hex digits or more is credential-like, for example a 64-digit secret. */
const MAX_HEX_DIGITS_IN_NAME = 24;

const FORWARD: FrameVerdict = { kind: 'forward' };
const DROP: FrameVerdict = { kind: 'drop' };

export type RequestId = string | number;

/** A JSON-RPC error reply. Its text is a fixed sentence, never client input. */
export interface ErrorReply {
  readonly jsonrpc: '2.0';
  readonly id: RequestId | null;
  readonly error: { readonly code: number; readonly message: string };
}

/** One complete frame, or the notice that a frame was too large and was discarded. */
export type FrameEvent =
  { readonly kind: 'frame'; readonly bytes: Buffer } | { readonly kind: 'oversize' };

/** What the guard does with one complete frame. */
export type FrameVerdict =
  | { readonly kind: 'forward' }
  | { readonly kind: 'drop' }
  | { readonly kind: 'reply'; readonly reply: ErrorReply };

/**
 * Splits a byte stream into newline-terminated frames in bounded memory.
 *
 * A frame longer than the limit is reported once, and its remaining bytes are
 * discarded up to the next newline without being stored. Blank lines are not
 * frames.
 */
export class FrameReader {
  readonly #limit: number;
  #parts: Buffer[] = [];
  #size = 0;
  #discarding = false;

  constructor(limit: number = MAX_FRAME_BYTES) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError('The frame limit must be a positive integer.');
    }
    this.#limit = limit;
  }

  /** Yields the events of one chunk, in order, one at a time. */
  *feed(chunk: Buffer): Generator<FrameEvent, void, undefined> {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(NEWLINE, start);
      const end = newline === -1 ? chunk.length : newline;
      if (!this.#discarding) {
        const piece = chunk.subarray(start, end);
        if (this.#size + piece.length > this.#limit) {
          this.#parts = [];
          this.#size = 0;
          this.#discarding = true;
          yield { kind: 'oversize' };
        } else if (piece.length > 0) {
          this.#parts.push(Buffer.from(piece));
          this.#size += piece.length;
        }
      }
      if (newline === -1) return;
      const discarded = this.#discarding;
      this.#discarding = false;
      if (!discarded) {
        const frame = this.#take();
        if (!isBlank(frame)) yield { kind: 'frame', bytes: frame };
      }
      start = newline + 1;
    }
  }

  /** Forgets a partial frame, for example at the end of the stream. */
  reset(): void {
    this.#parts = [];
    this.#size = 0;
    this.#discarding = false;
  }

  #take(): Buffer {
    const frame =
      this.#parts.length === 1 ? this.#parts[0]! : Buffer.concat(this.#parts, this.#size);
    this.#parts = [];
    this.#size = 0;
    return frame;
  }
}

function isBlank(frame: Buffer): boolean {
  for (const byte of frame) {
    if (byte !== SPACE && byte !== TAB && byte !== CARRIAGE_RETURN) return false;
  }
  return true;
}

function errorReply(id: RequestId | null, code: number, message: string): ErrorReply {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** The reply to a frame that was larger than the limit. */
function oversizeReply(): ErrorReply {
  return errorReply(null, INVALID_REQUEST, 'Request frame is too large');
}

function replyWith(id: RequestId | null, code: number, message: string): FrameVerdict {
  return { kind: 'reply', reply: errorReply(id, code, message) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a request id may be repeated in a reply or forwarded to the protocol.
 *
 * A safe integer is always accepted. A string is accepted only when it is the canonical UUID
 * shape, or a bounded ASCII name (at most 64 characters, no underscore) that carries fewer than 24
 * hex digits and no personal-token prefix. Every other value is refused: control characters,
 * whitespace, non-ASCII text, longer names, credential-like names and all other types.
 */
export function isSafeRequestId(value: unknown): value is RequestId {
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (typeof value !== 'string') return false;
  if (CANONICAL_UUID.test(value)) return true;
  if (!SAFE_NAME.test(value) || PERSONAL_TOKEN_PREFIX.test(value)) return false;
  return (value.match(/[0-9a-f]/gi)?.length ?? 0) < MAX_HEX_DIGITS_IN_NAME;
}

/**
 * Decides what happens to one complete frame.
 *
 * The id of a request is the only client value that a reply can repeat, so it is repeated only
 * when it is safe, and a request whose id is not safe is refused without being forwarded. A request
 * for a method the server does not serve, a task-augmented request, and invalid params for
 * `initialize` or `ping` are refused here with a fixed sentence, before the SDK can quote them.
 * Everything else that is valid is forwarded.
 *
 * A notification is forwarded when it is valid and is never answered. A response is forwarded only
 * with a safe id and is never answered, so an invalid response or one with an unsafe id is dropped.
 * A frame that is not JSON gets a parse error, and any other invalid frame gets an invalid request.
 */
export function classifyFrame(frame: Buffer): FrameVerdict {
  const text = frame.toString('utf8').replace(/\r$/, '');
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return replyWith(null, PARSE_ERROR, 'Parse error');
  }
  if (!isRecord(message)) return replyWith(null, INVALID_REQUEST, 'Invalid Request');

  const valid = JSONRPCMessageSchema.safeParse(message).success;
  const method = message['method'];
  if (typeof method === 'string' && !('id' in message)) return valid ? FORWARD : DROP;
  if (typeof method !== 'string' && ('result' in message || 'error' in message)) {
    return valid && isSafeRequestId(message['id']) ? FORWARD : DROP;
  }

  // What is left is a request, or something that is not a message at all.
  const rawId = message['id'];
  const id: RequestId | null = isSafeRequestId(rawId) ? rawId : null;
  if (!valid) return replyWith(id, INVALID_REQUEST, 'Invalid Request');
  if (id === null || typeof method !== 'string') {
    return replyWith(null, INVALID_REQUEST, 'Invalid Request');
  }
  if (!SERVED_METHODS.includes(method)) {
    return replyWith(id, METHOD_NOT_FOUND, 'Method not found');
  }
  const params = message['params'];
  if (isRecord(params) && 'task' in params) {
    return replyWith(id, INVALID_PARAMS, 'Invalid params');
  }
  const schema = SDK_REQUEST_SCHEMAS.get(method);
  if (schema !== undefined && !schema.safeParse(message).success) {
    return replyWith(id, INVALID_PARAMS, 'Invalid params');
  }
  return FORWARD;
}

export interface FrameGuardOptions {
  /** Resolves true when the next frame may be handled, and false when the guard must stop. */
  readonly admit: () => Promise<boolean>;
  /** Writes one fixed reply and resolves once the output has accepted it. */
  readonly reply: (reply: ErrorReply) => Promise<void>;
  /** The largest frame, in bytes. The protocol default when omitted. */
  readonly limit?: number;
}

/**
 * A readable stream of valid protocol frames, one frame per object.
 *
 * It is written with the raw process input. Each valid frame is pushed with
 * its newline, one object at a time, so the SDK never receives a chunk that
 * holds more than one frame. Backpressure runs in both directions: the guard
 * waits for the output before it handles a frame, and it waits for the reader
 * before it pushes the next one.
 */
export class FrameGuard extends Transform {
  readonly #reader: FrameReader;
  readonly #admit: () => Promise<boolean>;
  readonly #reply: (reply: ErrorReply) => Promise<void>;
  #wake: (() => void) | undefined;
  #stopped = false;

  constructor(options: FrameGuardOptions) {
    super({ readableObjectMode: true });
    this.#reader = new FrameReader(options.limit ?? MAX_FRAME_BYTES);
    this.#admit = options.admit;
    this.#reply = options.reply;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#process(chunk).then(
      () => callback(),
      (error: unknown) => callback(error instanceof Error ? error : new Error('frame failure')),
    );
  }

  override _flush(callback: TransformCallback): void {
    this.#reader.reset();
    callback();
  }

  override _read(size: number): void {
    super._read(size);
    this.#release();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.#stopped = true;
    this.#release();
    callback(error);
  }

  async #process(chunk: Buffer): Promise<void> {
    for (const event of this.#reader.feed(chunk)) {
      if (this.#stopped) return;
      const admitted = await this.#admit();
      // Checked again after the wait: a stop can land while admission is pending, and a frame that
      // was waiting then must neither reach the protocol nor be answered.
      if (!admitted || this.#stopped) return;
      if (event.kind === 'oversize') {
        await this.#reply(oversizeReply());
      } else {
        const verdict = classifyFrame(event.bytes);
        if (verdict.kind === 'forward') {
          await this.#forward(Buffer.concat([event.bytes, NEWLINE_FRAME]));
        } else if (verdict.kind === 'reply') {
          await this.#reply(verdict.reply);
        }
      }
      // The protocol writes the answer to a request it has just been handed in its own
      // microtasks. Yielding to the event loop lets that write happen before the next frame is
      // admitted, so a full output stops the next frame rather than the one after it.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  #forward(line: Buffer): Promise<void> {
    if (this.push(line) || this.#stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#wake = resolve;
    });
  }

  #release(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }
}

/**
 * Writes one protocol message as one newline-terminated JSON line.
 *
 * The promise waits for the output to drain rather than queueing writes
 * without bound, and it rejects when the output is gone.
 */
export function writeFrame(output: Writable, message: unknown): Promise<void> {
  if (output.destroyed || output.writableEnded) {
    return Promise.reject(new Error('The protocol output is closed.'));
  }
  if (output.write(`${JSON.stringify(message)}\n`)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const settle = (error?: Error): void => {
      output.off('drain', onDrain);
      output.off('close', onClose);
      output.off('error', onError);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onDrain = (): void => settle();
    const onClose = (): void => settle(new Error('The protocol output is closed.'));
    const onError = (error: Error): void => settle(error);
    output.on('drain', onDrain);
    output.on('close', onClose);
    output.on('error', onError);
  });
}

/**
 * Resolves when the output can take another write, or when it is gone or the
 * signal aborts. It never rejects: the caller checks the state afterwards.
 */
export function untilWritable(output: Writable, signal: AbortSignal): Promise<void> {
  if (signal.aborted || output.destroyed || !output.writableNeedDrain) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      output.off('drain', done);
      output.off('close', done);
      output.off('error', done);
      signal.removeEventListener('abort', done);
      resolve();
    };
    output.on('drain', done);
    output.on('close', done);
    output.on('error', done);
    signal.addEventListener('abort', done, { once: true });
  });
}
