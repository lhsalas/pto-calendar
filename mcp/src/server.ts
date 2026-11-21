/**
 * The local stdio MCP server.
 *
 * The server is the SDK's classic low-level `Server` on the SDK's stdio
 * transport, behind the bounded frame guard. It advertises tools and nothing
 * else: resources, prompts, logging and configuration are not reachable from
 * the protocol. Stdout carries protocol messages only, and diagnostics are
 * fixed sentences on stderr that never repeat client text or a credential.
 *
 * The server stops, and aborts every in-flight tool call, when the client
 * closes stdin, when the launcher aborts the runtime signal, or when a stream
 * fails. A stopped server returns its exit code and keeps no stream listener
 * that could write after it has returned.
 */

import type { Writable } from 'node:stream';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ErrorCode,
  McpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import {
  MCP_BUILD_NAME,
  MCP_SCHEMA_VERSION,
  TOOL_NAMES,
  type LaunchOptions,
  type Runtime,
  type ToolErrorCode,
  type ToolName,
} from './contract.js';
import {
  FrameGuard,
  MAX_FRAME_BYTES,
  untilWritable,
  writeFrame,
  type ErrorReply,
} from './framing.js';
import { TOOL_DEFINITIONS } from './tools.js';
import {
  isWriteToolName,
  writesEnabled,
  type AnyToolName,
  type AnyToolResult,
} from './write-contract.js';
import { WRITE_TOOL_DEFINITIONS, anyToolFailure, executeTool } from './write-tools.js';

/** The tool surface the protocol serves. */
export interface ToolSeam {
  /** The tools that `tools/list` advertises when no per-environment list exists. */
  readonly definitions: readonly Tool[];
  /** The tools `tools/list` advertises for this exact host environment. */
  readonly definitionsFor?: (env: NodeJS.ProcessEnv) => readonly Tool[];
  /** Runs one call. The signal aborts when the client cancels or the server stops. */
  execute(
    name: AnyToolName,
    input: unknown,
    launch: LaunchOptions,
    env: NodeJS.ProcessEnv,
    signal: AbortSignal,
  ): Promise<AnyToolResult>;
  /** A fixed failure of one category for one tool. */
  failure(tool: AnyToolName, code: ToolErrorCode): AnyToolResult;
}

export interface RunOptions {
  /** The tool surface. The read tools when omitted. */
  readonly tools?: ToolSeam;
  /** How many tool calls may run at once. A call over the limit gets a busy result. */
  readonly maxToolCalls?: number;
  /** How long a stopping server waits for aborted calls before it returns. */
  readonly drainMs?: number;
}

/** The most tool calls that run at once. A call over the limit is refused, not queued. */
export const MAX_TOOL_CALLS = 4;

/** How long a stopping server waits for its aborted calls to settle. */
export const SHUTDOWN_DRAIN_MS = 1_000;

/** The most diagnostic lines one server writes to stderr. */
const DIAGNOSTIC_LIMIT = 32;

const UNKNOWN_TOOL = 'Unknown tool';
const INVALID_PARAMS_TEXT = 'Invalid params';
const METHOD_NOT_FOUND = 'Method not found';
const INTERNAL_ERROR_TEXT = 'Internal error';
const FRAME_DIAGNOSTIC = 'pto-mcp: rejected a malformed protocol frame.';
const PROTOCOL_DIAGNOSTIC = 'pto-mcp: a protocol error was redacted.';
const INPUT_DIAGNOSTIC = 'pto-mcp: the protocol input stopped unexpectedly.';
const OUTPUT_DIAGNOSTIC = 'pto-mcp: the protocol output stopped unexpectedly.';
const TRANSPORT_DIAGNOSTIC = 'pto-mcp: the protocol transport stopped unexpectedly.';

const PRODUCTION_TOOLS: ToolSeam = {
  definitions: TOOL_DEFINITIONS,
  definitionsFor: (env) =>
    writesEnabled(env) ? [...TOOL_DEFINITIONS, ...WRITE_TOOL_DEFINITIONS] : TOOL_DEFINITIONS,
  execute: executeTool,
  failure: anyToolFailure,
};

/** Serves the protocol on the process stdio until the client leaves, and returns the exit code. */
export function serve(runtime: Runtime, launch: LaunchOptions): Promise<number> {
  return runServer(runtime, launch);
}

/** Serves the protocol with the given options. `serve` uses the defaults. */
export async function runServer(
  runtime: Runtime,
  launch: LaunchOptions,
  options: RunOptions = {},
): Promise<number> {
  const tools = options.tools ?? PRODUCTION_TOOLS;
  const slots = new ToolSlots(options.maxToolCalls ?? MAX_TOOL_CALLS);
  const drainMs = options.drainMs ?? SHUTDOWN_DRAIN_MS;
  const diagnostics = new Diagnostics(runtime.stderr);
  const lifecycle = new AbortController();
  const inFlight = new Set<Promise<unknown>>();

  const execute = async (
    name: AnyToolName,
    input: unknown,
    signal: AbortSignal,
  ): Promise<CallToolResult> => {
    let result: unknown;
    try {
      result = await tools.execute(name, input, launch, runtime.env, signal);
    } catch {
      // The cause of a thrown error is never surfaced: only the category is.
      const code: ToolErrorCode = signal.aborted ? 'CANCELLED' : 'LOCAL';
      return toCallResult(tools.failure(name, code));
    }
    return toCallResult(isEnvelope(result, name) ? result : tools.failure(name, 'LOCAL'));
  };

  // The advertisement is derived from the exact host environment on every listing. A
  // definition whose name is a mutation is filtered out while the switch is closed, even
  // when a custom seam still returns it.
  const advertised = (env: NodeJS.ProcessEnv): readonly Tool[] => {
    const listed = tools.definitionsFor?.(env) ?? tools.definitions;
    if (writesEnabled(env)) return listed;
    return listed.filter((definition) => !isWriteToolName(definition.name));
  };

  const server = new Server(
    { name: MCP_BUILD_NAME, version: runtime.version },
    { capabilities: { tools: {} } },
  );
  server.onerror = () => diagnostics.report(PROTOCOL_DIAGNOSTIC);

  // The SDK reports a failed params check with the schema issues, and the server's own errors
  // are fixed sentences. The two tool methods are dispatched here, and every error leaves through
  // the wrapper below: the client only ever sees a fixed sentence and its protocol code.
  server.fallbackRequestHandler = async (request, extra) => {
    try {
      // The framing guard has already checked that params are an object or absent, so the
      // listing takes no argument and ignores any cursor. The write definitions are never
      // advertised while the exact local switch is closed, even if a seam forgot to filter.
      if (request.method === 'tools/list') return { tools: [...advertised(runtime.env)] };
      if (request.method === 'tools/call') return await callTool(request.params, extra.signal);
      throw new McpError(ErrorCode.MethodNotFound, METHOD_NOT_FOUND);
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError(ErrorCode.InternalError, INTERNAL_ERROR_TEXT);
    }
  };

  const callTool = async (params: unknown, signal: AbortSignal): Promise<CallToolResult> => {
    if (!isRecord(params)) throw new McpError(ErrorCode.InvalidParams, INVALID_PARAMS_TEXT);
    const name = params['name'];
    if (typeof name !== 'string') throw new McpError(ErrorCode.InvalidParams, INVALID_PARAMS_TEXT);
    if (!isAnyToolName(name)) throw new McpError(ErrorCode.InvalidParams, UNKNOWN_TOOL);
    // A write that was not advertised is not dispatchable. It is refused as an unknown tool
    // before any credential, store, preview or request, even if the args are well formed.
    if (isWriteToolName(name) && !writesEnabled(runtime.env)) {
      throw new McpError(ErrorCode.InvalidParams, UNKNOWN_TOOL);
    }
    const args = params['arguments'];
    if (args !== undefined && !isRecord(args)) {
      throw new McpError(ErrorCode.InvalidParams, INVALID_PARAMS_TEXT);
    }
    // A call that reaches the protocol after the server began to stop runs nothing: the protocol
    // has already aborted its request, so no answer would be written.
    if (lifecycle.signal.aborted) return toCallResult(tools.failure(name, 'CANCELLED'));
    const release = slots.acquire();
    if (release === undefined) return toCallResult(tools.failure(name, 'BUSY'));
    const running: Promise<CallToolResult> = execute(name, args ?? {}, signal).finally(() => {
      release();
      inFlight.delete(running);
    });
    inFlight.add(running);
    return running;
  };

  const guard = new FrameGuard({
    limit: MAX_FRAME_BYTES,
    admit: async () => {
      if (lifecycle.signal.aborted) return false;
      // No frame reaches the protocol while the output is full: the client has to read first.
      await untilWritable(runtime.stdout, lifecycle.signal);
      return !lifecycle.signal.aborted && !runtime.stdout.destroyed;
    },
    reply: async (reply: ErrorReply) => {
      diagnostics.report(FRAME_DIAGNOSTIC);
      await writeFrame(runtime.stdout, reply);
    },
  });

  let finish: (code: number) => void = () => undefined;
  const finished = new Promise<number>((resolve) => {
    finish = resolve;
  });

  // The flag is set before any work starts: closing the protocol reports its own close back here,
  // and that report must not start a second stop with a different code.
  let stopped = false;
  const stop = (code: number, message?: string): void => {
    if (stopped) return;
    stopped = true;
    if (message !== undefined) diagnostics.report(message);
    lifecycle.abort();
    runtime.signal.removeEventListener('abort', onAbort);
    void shutdown(code);
  };

  const shutdown = async (code: number): Promise<void> => {
    runtime.stdin.unpipe(guard);
    runtime.stdin.pause();
    guard.destroy();
    // Closing the protocol aborts every in-flight request, so each call stops its REST read.
    await server.close().catch(() => undefined);
    await settleWithin(inFlight, drainMs);
    finish(code);
  };

  const onAbort = (): void => stop(0);
  const onInputEnd = (): void => stop(0);
  const onInputError = (): void => stop(1, INPUT_DIAGNOSTIC);
  const onOutputFailure = (): void => stop(1, OUTPUT_DIAGNOSTIC);

  const transport = new StdioServerTransport(guard, runtime.stdout, {
    maxBufferSize: MAX_FRAME_BYTES + 1,
  });
  server.onclose = () => stop(1, TRANSPORT_DIAGNOSTIC);
  await server.connect(transport);

  // These listeners stay attached after the server returns: a late stream error must not crash
  // the process, and the CLI keeps the same guards for the same reason.
  runtime.stdout.on('error', onOutputFailure);
  runtime.stdout.on('close', onOutputFailure);
  runtime.stderr.on('error', () => undefined);
  runtime.stdin.on('error', onInputError);
  runtime.stdin.once('end', onInputEnd);
  runtime.stdin.once('close', onInputEnd);
  guard.on('error', onOutputFailure);
  runtime.signal.addEventListener('abort', onAbort, { once: true });
  runtime.stdin.pipe(guard);
  if (runtime.signal.aborted) stop(0);
  return finished;
}

/** Whether the value names one of the documented read tools. */
function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value);
}

/** Whether the value names a tool of either surface. */
function isAnyToolName(value: string): value is AnyToolName {
  return isToolName(value) || isWriteToolName(value);
}

/** Whether the value is a JSON object, and not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether the value is a complete envelope of the named tool. */
function isEnvelope(value: unknown, tool: AnyToolName): value is AnyToolResult {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record['schemaVersion'] === MCP_SCHEMA_VERSION &&
    typeof record['requestId'] === 'string' &&
    typeof record['ok'] === 'boolean' &&
    record['tool'] === tool
  );
}

/**
 * The MCP result of one envelope.
 *
 * The text fallback and the structured content are the same serialized
 * envelope, so a client that reads either one sees the same answer.
 */
function toCallResult(result: AnyToolResult): CallToolResult {
  const text = JSON.stringify(result);
  return {
    content: [{ type: 'text', text }],
    structuredContent: JSON.parse(text) as Record<string, unknown>,
    isError: !result.ok,
  };
}

/** Resolves when every promise settles, or after the bound, whichever comes first. */
function settleWithin(pending: ReadonlySet<Promise<unknown>>, ms: number): Promise<void> {
  if (pending.size === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void Promise.allSettled([...pending]).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** A fixed number of concurrent tool calls. Acquiring over the limit fails at once. */
class ToolSlots {
  readonly #limit: number;
  #active = 0;

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError('The tool call limit must be a positive integer.');
    }
    this.#limit = limit;
  }

  acquire(): (() => void) | undefined {
    if (this.#active >= this.#limit) return undefined;
    this.#active += 1;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.#active -= 1;
    };
  }
}

/** Writes at most a fixed number of fixed diagnostic lines. */
class Diagnostics {
  readonly #stream: Writable;
  #written = 0;

  constructor(stream: Writable) {
    this.#stream = stream;
  }

  report(message: string): void {
    if (this.#written >= DIAGNOSTIC_LIMIT) return;
    this.#written += 1;
    this.#stream.write(`${message}\n`);
  }
}
