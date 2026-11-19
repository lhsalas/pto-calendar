import { PassThrough, Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  LaunchOptions,
  Runtime,
  ToolErrorCode,
  ToolName,
  ToolResult,
} from '../src/contract.js';
import { MAX_FRAME_BYTES } from '../src/framing.js';
import { runServer, serve, type RunOptions, type ToolSeam } from '../src/server.js';
import { TOOL_DEFINITIONS, toolFailure } from '../src/tools.js';

type Json = Record<string, unknown>;

/** The classic revisions the SDK negotiates, in the order of its own list. */
const CLASSIC_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const LAUNCH: LaunchOptions = { allowLoopbackHttp: false };
/** Text that must never appear on stdout or stderr, whatever the client sends. */
const SENTINEL = 'SENTINEL-server-text-91bd';
const RECORD = {
  id: '11111111-aaaa-4111-8111-000000000002',
  owner: { id: '11111111-aaaa-4111-8111-000000000001', name: 'Ada' },
  startDate: '2026-12-07',
  endDate: '2026-12-07',
  dayPart: 'all_day',
  note: null,
  version: 1,
} as const;

function success(tool: ToolName): ToolResult {
  if (tool === 'pto_get') {
    return { schemaVersion: 1, requestId: 'req-ok', ok: true, tool, data: RECORD };
  }
  return {
    schemaVersion: 1,
    requestId: 'req-ok',
    ok: true,
    tool,
    data: { items: [RECORD], complete: true, reason: 'complete', pages: 1 },
  };
}

type Behaviour = (
  name: ToolName,
  input: unknown,
  signal: AbortSignal,
) => Promise<ToolResult> | ToolResult;

/** A tool surface whose calls the test controls and records. */
class FakeTools implements ToolSeam {
  readonly definitions = TOOL_DEFINITIONS;
  readonly calls: Array<{ name: ToolName; input: unknown; signal: AbortSignal }> = [];
  readonly #behaviour: Behaviour;

  constructor(behaviour: Behaviour = (name) => success(name)) {
    this.#behaviour = behaviour;
  }

  execute(
    name: ToolName,
    input: unknown,
    _launch: LaunchOptions,
    _env: NodeJS.ProcessEnv,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    this.calls.push({ name, input, signal });
    return Promise.resolve().then(() => this.#behaviour(name, input, signal));
  }

  failure(tool: ToolName, code: ToolErrorCode): ToolResult {
    return toolFailure(tool, code);
  }
}

/** A call that finishes only when the client cancels it, as a real REST read does. */
const abortable: Behaviour = (name, _input, signal) =>
  new Promise<ToolResult>((resolve) => {
    signal.addEventListener('abort', () => resolve(toolFailure(name, 'CANCELLED')), {
      once: true,
    });
  });

/** A call that ignores its signal and never finishes. */
const stubborn: Behaviour = () => new Promise<ToolResult>(() => undefined);

interface SessionOptions {
  readonly tools?: FakeTools;
  readonly run?: RunOptions;
  /** Keeps stdout unread until `release`, so the output stays full. */
  readonly holdOutput?: boolean;
}

/** One in-process server on in-memory streams, with a JSON-RPC client view of stdout. */
class Session {
  readonly input = new PassThrough();
  readonly output: PassThrough;
  readonly control = new AbortController();
  readonly tools: FakeTools;
  readonly done: Promise<number>;
  readonly lines: string[] = [];
  #stderr = '';
  #partial = '';
  #reading = false;

  constructor(options: SessionOptions = {}) {
    this.tools = options.tools ?? new FakeTools();
    this.output = new PassThrough(options.holdOutput === true ? { highWaterMark: 1 } : undefined);
    this.output.setEncoding('utf8');
    if (options.holdOutput !== true) this.release();
    const stderr = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        this.#stderr += chunk.toString('utf8');
        done();
      },
    });
    const runtime: Runtime = {
      args: [],
      env: {},
      stdin: this.input,
      stdout: this.output,
      stderr,
      signal: this.control.signal,
      version: '0.1.0',
    };
    this.done = runServer(runtime, LAUNCH, { ...options.run, tools: this.tools });
  }

  get stderr(): string {
    return this.#stderr;
  }

  /** Starts reading stdout. A held output stays unread until this is called. */
  release(): void {
    if (this.#reading) return;
    this.#reading = true;
    this.output.on('data', (text: string) => {
      this.#partial += text;
      let index = this.#partial.indexOf('\n');
      while (index !== -1) {
        this.lines.push(this.#partial.slice(0, index));
        this.#partial = this.#partial.slice(index + 1);
        index = this.#partial.indexOf('\n');
      }
    });
  }

  send(message: unknown): void {
    this.input.write(`${JSON.stringify(message)}\n`);
  }

  sendRaw(text: string): void {
    this.input.write(text);
  }

  messages(): Json[] {
    return this.lines.map((line) => JSON.parse(line) as Json);
  }

  async response(id: number | string): Promise<Json> {
    await until(() => this.messages().some((message) => message['id'] === id), `reply ${id}`);
    return this.messages().find((message) => message['id'] === id) as Json;
  }
}

const sessions: Session[] = [];

function start(options: SessionOptions = {}): Session {
  const session = new Session(options);
  sessions.push(session);
  return session;
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.control.abort();
});

async function until(check: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    // The message names what was awaited; it never includes stream text.
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Lets the event loop run a fixed number of turns. Each turn drains every microtask first, so
 * a server that answers in its own microtasks has finished its work after this, whatever the
 * machine's load: the wait is in turns, not in milliseconds.
 */
async function settleTurns(turns: number): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function request(id: number | string, method: string, params?: Json): Json {
  return params === undefined
    ? { jsonrpc: '2.0', id, method }
    : { jsonrpc: '2.0', id, method, params };
}

function initialize(id: number, protocolVersion: string): Json {
  return request(id, 'initialize', {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  });
}

function call(id: number | string, name: unknown, args: Json = {}): Json {
  return request(id, 'tools/call', { name, arguments: args });
}

/** Completes the handshake of one session and returns the negotiated revision. */
async function handshake(session: Session, version = '2025-11-25'): Promise<void> {
  session.send(initialize(1, version));
  await session.response(1);
  session.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

/** Every stdout line is a JSON-RPC message, and no client text reached either stream. */
function expectPure(session: Session): void {
  for (const line of session.lines) {
    expect((JSON.parse(line) as Json)['jsonrpc']).toBe('2.0');
  }
  expect(session.lines.join('\n') + session.stderr).not.toContain(SENTINEL);
}

describe('classic protocol negotiation', () => {
  it.each(CLASSIC_VERSIONS)(
    'negotiates the classic revision %s and advertises tools only',
    async (version) => {
      const session = start();
      session.send(initialize(1, version));
      const response = await session.response(1);
      expect(response['result']).toMatchObject({
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: 'pto-mcp', version: '0.1.0' },
      });
      await handshake(session, version);
      session.send(request(2, 'ping'));
      expect(await session.response(2)).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
      expectPure(session);
    },
  );

  it('answers a revision it does not support with the latest classic revision', async () => {
    const session = start();
    session.send(initialize(1, '2026-07-28'));
    const response = await session.response(1);
    expect(response['result']).toMatchObject({ protocolVersion: '2025-11-25' });
    expectPure(session);
  });

  it('exposes no resources, prompts, or logging', async () => {
    const session = start();
    await handshake(session);
    session.send(request(2, 'resources/list'));
    session.send(request(3, 'prompts/list'));
    session.send(request(4, 'logging/setLevel', { level: 'info' }));
    expect((await session.response(2))['error']).toMatchObject({ code: -32601 });
    expect((await session.response(3))['error']).toMatchObject({ code: -32601 });
    expect((await session.response(4))['error']).toMatchObject({ code: -32601 });
    expectPure(session);
  });
});

describe('discovery', () => {
  it('lists exactly the two read-only tools with closed schemas', async () => {
    const session = start();
    await handshake(session);
    session.send(request(2, 'tools/list'));
    const result = (await session.response(2))['result'] as { tools: Json[] };
    expect(result.tools.map((tool) => tool['name'])).toEqual(['pto_list', 'pto_get']);
    for (const tool of result.tools) {
      expect(tool['annotations']).toMatchObject({ readOnlyHint: true });
      expect((tool['inputSchema'] as Json)['additionalProperties']).toBe(false);
      expect((tool['outputSchema'] as Json)['type']).toBe('object');
    }
    expectPure(session);
  });
});

describe('tool calls', () => {
  it('returns the same envelope as text and as structured content', async () => {
    const tools = new FakeTools();
    const session = start({ tools });
    await handshake(session);
    session.send(call(2, 'pto_get', { id: RECORD.id }));
    const result = (await session.response(2))['result'] as Json;
    const content = result['content'] as Array<{ type: string; text: string }>;
    expect(result['isError']).toBe(false);
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe('text');
    expect(result['structuredContent']).toEqual(JSON.parse(content[0]!.text));
    expect(tools.calls).toHaveLength(1);
    expect(tools.calls[0]).toMatchObject({ name: 'pto_get', input: { id: RECORD.id } });
    expect(tools.calls[0]!.signal.aborted).toBe(false);
  });

  it('reports a failed tool as an error result with its own category', async () => {
    const tools = new FakeTools(() => toolFailure('pto_get', 'AUTH'));
    const session = start({ tools });
    await handshake(session);
    session.send(call(2, 'pto_get', { id: RECORD.id }));
    const result = (await session.response(2))['result'] as Json;
    expect(result['isError']).toBe(true);
    expect(result['structuredContent']).toMatchObject({ ok: false, error: { code: 'AUTH' } });
    expectPure(session);
  });

  it('refuses an unknown tool name with a fixed protocol error and no echo', async () => {
    const tools = new FakeTools();
    const session = start({ tools });
    await handshake(session);
    session.send(call(2, SENTINEL));
    // The SDK adds its own fixed prefix to a protocol error; the text is still the fixed sentence.
    expect((await session.response(2))['error']).toEqual({
      code: -32602,
      message: 'MCP error -32602: Unknown tool',
    });
    expect(tools.calls).toHaveLength(0);
    expectPure(session);
  });

  it('turns a thrown tool error into a fixed local failure', async () => {
    const tools = new FakeTools(() => {
      throw new Error(SENTINEL);
    });
    const session = start({ tools });
    await handshake(session);
    session.send(call(2, 'pto_list', { from: '2026-12-07', to: '2026-12-07' }));
    const result = (await session.response(2))['result'] as Json;
    expect(result['isError']).toBe(true);
    expect(result['structuredContent']).toMatchObject({ ok: false, error: { code: 'LOCAL' } });
    expectPure(session);
  });

  it('turns a malformed tool result into a fixed local failure', async () => {
    const tools = new FakeTools(() => ({ junk: SENTINEL }) as unknown as ToolResult);
    const session = start({ tools });
    await handshake(session);
    session.send(call(2, 'pto_get', { id: RECORD.id }));
    const result = (await session.response(2))['result'] as Json;
    expect(result['structuredContent']).toMatchObject({ ok: false, error: { code: 'LOCAL' } });
    expectPure(session);
  });

  it('rejects a call whose name is not a string through the protocol', async () => {
    const session = start();
    await handshake(session);
    session.send(call(2, 5));
    expect((await session.response(2))['error']).toMatchObject({ code: -32602 });
    session.send(request(3, 'ping'));
    expect(await session.response(3)).toMatchObject({ result: {} });
  });

  it('refuses a call beyond the concurrency limit at once, then serves again', async () => {
    let count = 0;
    let finish!: (result: ToolResult) => void;
    const held = new Promise<ToolResult>((resolve) => {
      finish = resolve;
    });
    const tools = new FakeTools(async (name) => {
      count += 1;
      return count === 1 ? held : success(name);
    });
    const session = start({ tools, run: { maxToolCalls: 1 } });
    await handshake(session);
    session.send(call(2, 'pto_get', { id: RECORD.id }));
    await until(() => tools.calls.length === 1, 'the first call');
    session.send(call(3, 'pto_get', { id: RECORD.id }));
    const busy = (await session.response(3))['result'] as Json;
    expect(busy['isError']).toBe(true);
    expect(busy['structuredContent']).toMatchObject({ error: { code: 'BUSY' } });
    expect(tools.calls).toHaveLength(1);

    finish(success('pto_get'));
    expect(((await session.response(2))['result'] as Json)['isError']).toBe(false);
    session.send(call(4, 'pto_get', { id: RECORD.id }));
    expect(((await session.response(4))['result'] as Json)['isError']).toBe(false);
    expectPure(session);
  });
});

describe('cancellation and lifecycle', () => {
  it('aborts a call on client cancellation and sends it no reply', async () => {
    const tools = new FakeTools(abortable);
    const session = start({ tools });
    await handshake(session);
    session.send(call(7, 'pto_get', { id: RECORD.id }));
    await until(() => tools.calls.length === 1, 'the cancelled call');
    session.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 7, reason: 'client stopped waiting' },
    });
    await until(() => tools.calls[0]!.signal.aborted, 'the abort of the cancelled call');
    await sleep(60);
    expect(session.messages().some((message) => message['id'] === 7)).toBe(false);
    session.send(request(8, 'ping'));
    expect(await session.response(8)).toMatchObject({ result: {} });
    expectPure(session);
  });

  it('stops when the client closes stdin, aborts the call and returns zero', async () => {
    const tools = new FakeTools(abortable);
    const session = start({ tools });
    await handshake(session);
    session.send(call(8, 'pto_get', { id: RECORD.id }));
    await until(() => tools.calls.length === 1, 'the pending call');
    session.input.end();
    expect(await session.done).toBe(0);
    expect(tools.calls[0]!.signal.aborted).toBe(true);
    expect(session.messages().some((message) => message['id'] === 8)).toBe(false);
    expectPure(session);
  });

  it('stops when the launcher aborts the runtime signal and returns zero', async () => {
    const tools = new FakeTools(abortable);
    const session = start({ tools });
    await handshake(session);
    session.send(call(9, 'pto_get', { id: RECORD.id }));
    await until(() => tools.calls.length === 1, 'the pending call');
    session.control.abort();
    expect(await session.done).toBe(0);
    expect(tools.calls[0]!.signal.aborted).toBe(true);
  });

  it('returns at once when the launcher signal is already aborted', async () => {
    const session = start();
    session.control.abort();
    expect(await session.done).toBe(0);
  });

  it('returns a fixed diagnostic and exit code one when the output fails', async () => {
    const session = start();
    await handshake(session);
    session.output.destroy(new Error(SENTINEL));
    expect(await session.done).toBe(1);
    expect(session.stderr).toBe('pto-mcp: the protocol output stopped unexpectedly.\n');
  });

  it('returns a fixed diagnostic and exit code one when the input fails', async () => {
    const session = start();
    await handshake(session);
    session.input.destroy(new Error(SENTINEL));
    expect(await session.done).toBe(1);
    expect(session.stderr).toBe('pto-mcp: the protocol input stopped unexpectedly.\n');
  });

  it('returns after the bounded drain even when a call ignores its abort signal', async () => {
    const tools = new FakeTools(stubborn);
    const session = start({ tools, run: { drainMs: 20 } });
    await handshake(session);
    session.send(call(10, 'pto_get', { id: RECORD.id }));
    await until(() => tools.calls.length === 1, 'the stubborn call');
    session.input.end();
    const started = Date.now();
    expect(await session.done).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

/** A personal-token shaped id, built from the documented wire format with synthetic digits. */
const PERSONAL_TOKEN = `pto_pat_11111111-2222-4333-8444-555555555555.${'f'.repeat(64)}`;

/** Ids the server must never repeat: each one is credential-like, too long, or not a valid id. */
const UNSAFE_IDS: readonly unknown[] = [
  PERSONAL_TOKEN,
  'f'.repeat(64),
  'x'.repeat(65),
  'req\u0001',
  { nested: 'value' },
  1.5,
];

describe('request ids and params', () => {
  it('echoes only safe request ids on a valid request', async () => {
    const session = start();
    await handshake(session);
    for (const id of [0, 7, -3, 'req-1', '3f2b8c1e-9a7d-4e5f-8b6c-1d2e3f4a5b6c']) {
      session.send(request(id as number, 'ping'));
      expect(await session.response(id as number)).toEqual({ jsonrpc: '2.0', id, result: {} });
    }
    expectPure(session);
  });

  it('answers an unsafe id with a null id and runs no tool for it', async () => {
    const tools = new FakeTools();
    const session = start({ tools });
    await handshake(session);
    for (const id of UNSAFE_IDS) {
      session.send({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'pto_get', arguments: { id: RECORD.id } },
      });
    }
    await until(() => session.messages().length === UNSAFE_IDS.length + 1, 'every refusal');
    const refusals = session.messages().slice(1);
    for (const refusal of refusals) {
      expect(refusal).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      });
    }
    expect(tools.calls).toHaveLength(0);
    expect(session.lines.join('\n')).not.toContain('f'.repeat(64));
    expect(session.lines.join('\n')).not.toContain('x'.repeat(65));
    expectPure(session);
  });

  it('drops a response whose id is not safe and writes nothing for it', async () => {
    const session = start();
    await handshake(session);
    session.send({ jsonrpc: '2.0', id: PERSONAL_TOKEN, result: { note: 'x' } });
    session.send(request(9, 'ping'));
    expect(await session.response(9)).toEqual({ jsonrpc: '2.0', id: 9, result: {} });
    expect(session.messages()).toHaveLength(2);
    expectPure(session);
  });

  it('refuses a task-augmented request with a fixed reply and never repeats its method', async () => {
    const tools = new FakeTools();
    const session = start({ tools });
    await handshake(session);
    session.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'SENTINEL_METHOD_NAME',
      params: { task: {} },
    });
    expect(await session.response(4)).toEqual({
      jsonrpc: '2.0',
      id: 4,
      error: { code: -32601, message: 'Method not found' },
    });
    session.send({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'pto_get', arguments: { id: RECORD.id }, task: { ttl: 60_000 } },
    });
    expect((await session.response(5))['error']).toEqual({
      code: -32602,
      message: 'Invalid params',
    });
    expect(tools.calls).toHaveLength(0);
    expectPure(session);
    expect(session.lines.join('\n')).not.toContain('SENTINEL_METHOD_NAME');
  });

  it('redacts invalid initialize and ping params and keeps negotiating afterwards', async () => {
    const session = start();
    session.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: SENTINEL,
        clientInfo: { name: 'client', version: '1' },
      },
    });
    expect((await session.response(1))['error']).toEqual({
      code: -32602,
      message: 'Invalid params',
    });
    session.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: SENTINEL, version: 3 },
      },
    });
    expect((await session.response(2))['error']).toEqual({
      code: -32602,
      message: 'Invalid params',
    });
    session.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'ping',
      params: { _meta: { progressToken: [SENTINEL] } },
    });
    expect((await session.response(3))['error']).toMatchObject({ code: -32600 });
    expectPure(session);

    session.send(initialize(4, '2025-06-18'));
    expect((await session.response(4))['result']).toMatchObject({ protocolVersion: '2025-06-18' });
    expectPure(session);
  });
});

describe('call edges and lifecycle bounds', () => {
  it('serves the production tools through serve and returns zero at the end of input', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.setEncoding('utf8');
    let text = '';
    output.on('data', (chunk: string) => {
      text += chunk;
    });
    const runtime: Runtime = {
      args: [],
      env: {},
      stdin: input,
      stdout: output,
      stderr: new Writable({
        write: (_chunk, _encoding, done) => {
          done();
        },
      }),
      signal: new AbortController().signal,
      version: '0.1.0',
    };
    const done = serve(runtime, LAUNCH);
    input.write(`${JSON.stringify(request(1, 'tools/list'))}\n`);
    await until(() => text.includes('\n'), 'the listing');
    input.end();
    expect(await done).toBe(0);
    const listing = JSON.parse(text.split('\n')[0] as string) as Json;
    expect((listing['result'] as { tools: Json[] }).tools.map((tool) => tool['name'])).toEqual([
      'pto_list',
      'pto_get',
    ]);
  });

  it('refuses a call without params or with non-object arguments, and runs nothing', async () => {
    const tools = new FakeTools();
    const session = start({ tools });
    await handshake(session);
    session.send(request(2, 'tools/call'));
    expect((await session.response(2))['error']).toEqual({
      code: -32602,
      message: 'MCP error -32602: Invalid params',
    });
    session.send(request(3, 'tools/call', { name: 'pto_get', arguments: SENTINEL }));
    expect((await session.response(3))['error']).toEqual({
      code: -32602,
      message: 'MCP error -32602: Invalid params',
    });
    expect(tools.calls).toHaveLength(0);
    expectPure(session);
  });

  it('runs a call without arguments with an empty input', async () => {
    const tools = new FakeTools();
    const session = start({ tools });
    await handshake(session);
    session.send(request(2, 'tools/call', { name: 'pto_get' }));
    expect(((await session.response(2))['result'] as Json)['isError']).toBe(false);
    expect(tools.calls[0]).toMatchObject({ name: 'pto_get', input: {} });
  });

  it('sends nothing for a call that fails after it was cancelled', async () => {
    const tools = new FakeTools(
      (_name, _input, signal) =>
        new Promise<ToolResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error(SENTINEL)), { once: true });
        }),
    );
    const session = start({ tools });
    await handshake(session);
    session.send(call(7, 'pto_get', { id: RECORD.id }));
    await until(() => tools.calls.length === 1, 'the call');
    session.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } });
    await until(() => tools.calls[0]!.signal.aborted, 'the abort');
    await sleep(60);
    expect(session.messages().some((message) => message['id'] === 7)).toBe(false);
    expectPure(session);
  });

  it('answers a result that cannot be serialized with a fixed internal error', async () => {
    const data: Record<string, unknown> = {};
    data['self'] = data;
    const cyclic = {
      schemaVersion: 1,
      requestId: 'req-cycle',
      ok: true,
      tool: 'pto_get',
      data,
    } as unknown as ToolResult;
    const tools = new FakeTools(() => cyclic);
    const session = start({ tools });
    await handshake(session);
    session.send(call(2, 'pto_get', { id: RECORD.id }));
    expect((await session.response(2))['error']).toEqual({
      code: -32603,
      message: 'MCP error -32603: Internal error',
    });
    expect(session.lines.join('\n')).not.toContain('circular');
    expectPure(session);
  });

  it('waits for an aborted call that settles soon after, within the bound', async () => {
    const tools = new FakeTools(
      (name) =>
        new Promise<ToolResult>((resolve) => {
          setTimeout(() => resolve(toolFailure(name, 'CANCELLED')), 30);
        }),
    );
    const session = start({ tools, run: { drainMs: 2_000 } });
    await handshake(session);
    session.send(call(3, 'pto_get', { id: RECORD.id }));
    await until(() => tools.calls.length === 1, 'the call');
    session.input.end();
    const started = Date.now();
    expect(await session.done).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('admits no further frame once the server has stopped', async () => {
    const tools = new FakeTools();
    const session = start({ tools, holdOutput: true });
    // Three calls arrive together, as a burst. The output is held, so only the first may be
    // answered; the other two must wait at the gate.
    session.send(call(1, 'pto_get', { id: RECORD.id }));
    session.send(call(2, 'pto_get', { id: RECORD.id }));
    session.send(call(3, 'pto_get', { id: RECORD.id }));
    await until(() => session.input.readableLength === 0, 'the burst to reach the guard');
    await settleTurns(20);
    expect(session.output.writableNeedDrain).toBe(true);
    expect(tools.calls).toHaveLength(1);
    session.input.end();
    expect(await session.done).toBe(0);
    session.release();
    await sleep(40);
    // The count is the proof: the protocol was handed one call, and none after the stop.
    expect(tools.calls).toHaveLength(1);
    expect(session.lines).toHaveLength(1);
  });

  it('admits no frame that arrives after the launcher stopped the server', async () => {
    const tools = new FakeTools();
    const session = start({ tools, holdOutput: true });
    session.send(call(1, 'pto_get', { id: RECORD.id }));
    await until(() => session.output.writableNeedDrain, 'the held output to fill');
    session.control.abort();
    expect(await session.done).toBe(0);
    // The input is still open, but nothing reads it after the stop.
    session.send(call(2, 'pto_get', { id: RECORD.id }));
    await sleep(40);
    session.release();
    await sleep(40);
    expect(tools.calls).toHaveLength(1);
    expect(session.lines).toHaveLength(1);
  });

  it('rejects a non-positive concurrency limit before it reads a frame', async () => {
    const runtime: Runtime = {
      args: [],
      env: {},
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new Writable({
        write: (_chunk, _encoding, done) => {
          done();
        },
      }),
      signal: new AbortController().signal,
      version: '0.1.0',
    };
    await expect(runServer(runtime, LAUNCH, { maxToolCalls: 0 })).rejects.toThrow(RangeError);
  });
});

describe('frames', () => {
  it('answers malformed frames with fixed errors and keeps serving', async () => {
    const session = start();
    session.sendRaw(`not json ${SENTINEL}\n`);
    session.sendRaw('[1,2,3]\n');
    session.sendRaw('{"jsonrpc":"2.0","id":"req-x","method":"ping","extra":1}\n');
    session.send(request(9, 'ping'));
    expect(await session.response(9)).toEqual({ jsonrpc: '2.0', id: 9, result: {} });
    expect(session.messages().slice(0, 3)).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
      { jsonrpc: '2.0', id: 'req-x', error: { code: -32600, message: 'Invalid Request' } },
    ]);
    expect(session.stderr).toBe('pto-mcp: rejected a malformed protocol frame.\n'.repeat(3));
    expectPure(session);
  });

  it('answers an oversized frame and resynchronises on the next one', async () => {
    const session = start();
    session.sendRaw(`${'x'.repeat(MAX_FRAME_BYTES + 1)}\n`);
    await until(() => session.lines.length === 1, 'the oversize reply');
    expect(session.messages()).toEqual([
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Request frame is too large' },
      },
    ]);
    session.send(request(5, 'ping'));
    expect(await session.response(5)).toMatchObject({ result: {} });
    expectPure(session);
  });

  it('drops an invalid notification without any reply', async () => {
    const session = start();
    session.sendRaw('{"method":"notifications/nothing"}\n');
    session.send(request(3, 'ping'));
    await session.response(3);
    expect(session.lines).toHaveLength(1);
    expectPure(session);
  });

  it('redacts a protocol error and writes no reply for a stray response', async () => {
    const session = start();
    session.send({ jsonrpc: '2.0', id: 99, result: { note: SENTINEL } });
    session.send(request(4, 'ping'));
    await session.response(4);
    expect(session.lines).toHaveLength(1);
    expect(session.stderr).toBe('pto-mcp: a protocol error was redacted.\n');
    expectPure(session);
  });

  it('writes at most a fixed number of diagnostic lines', async () => {
    const session = start();
    for (let index = 0; index < 40; index += 1) session.sendRaw('bad\n');
    await until(() => session.lines.length === 40, 'forty replies');
    const diagnostics = session.stderr.split('\n').filter((line) => line !== '');
    expect(diagnostics).toHaveLength(32);
    expectPure(session);
  });

  it('stops reading requests while the output is full and resumes once it drains', async () => {
    const session = start({ holdOutput: true });
    for (let id = 1; id <= 6; id += 1) session.send(request(id, 'ping'));
    await sleep(100);
    // One reply is about 38 bytes. A full output admits no further frame until it drains.
    expect(session.output.readableLength).toBeGreaterThan(0);
    expect(session.output.readableLength).toBeLessThan(76);
    session.release();
    for (let id = 1; id <= 6; id += 1) {
      expect(await session.response(id)).toEqual({ jsonrpc: '2.0', id, result: {} });
    }
    expectPure(session);
  });
});
