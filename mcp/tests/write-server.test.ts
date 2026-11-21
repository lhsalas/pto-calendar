import { PassThrough, Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import type { LaunchOptions, Runtime, ToolErrorCode } from '../src/contract.js';
import { runServer, type ToolSeam } from '../src/server.js';
import { TOOL_DEFINITIONS } from '../src/tools.js';
import type { AnyToolName, AnyToolResult, WriteToolResult } from '../src/write-contract.js';
import { WRITE_TOOL_DEFINITIONS, anyToolFailure } from '../src/write-tools.js';

type Json = Record<string, unknown>;

const LAUNCH: LaunchOptions = { allowLoopbackHttp: false };
const PREVIEW_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR = '11111111-aaaa-4111-8111-000000000001';
const REQUEST_ID = '77777777-7777-4777-8777-777777777777';

/** One preview envelope that is identical in text and structured content. */
const PREVIEW: WriteToolResult = {
  schemaVersion: 1,
  requestId: REQUEST_ID,
  ok: true,
  tool: 'pto_create',
  data: {
    phase: 'preview',
    operation: 'create',
    previewId: PREVIEW_ID,
    actorId: ACTOR,
    ownerId: ACTOR,
    expiresAt: '2026-11-21T12:05:00.000Z',
    target: null,
    before: null,
    after: { startDate: '2026-12-07', endDate: '2026-12-09', dayPart: 'all_day' },
    changedFields: ['startDate', 'endDate', 'dayPart'],
    noteIntent: 'none',
  },
};

/** A seam whose definitions and results the test controls. */
class FakeSeam implements ToolSeam {
  readonly definitions: readonly Tool[];
  readonly calls: AnyToolName[] = [];
  readonly result: AnyToolResult;

  constructor(result: AnyToolResult = PREVIEW) {
    this.definitions = [...TOOL_DEFINITIONS, ...WRITE_TOOL_DEFINITIONS];
    this.result = result;
  }

  execute(name: AnyToolName): Promise<AnyToolResult> {
    this.calls.push(name);
    return Promise.resolve(this.result);
  }

  failure(tool: AnyToolName, code: ToolErrorCode): AnyToolResult {
    return anyToolFailure(tool, code);
  }
}

/** One in-process server on in-memory streams. */
class Session {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  readonly control = new AbortController();
  readonly done: Promise<number>;
  readonly lines: string[] = [];
  #stderr = '';
  #partial = '';
  #reading = false;

  constructor(env: NodeJS.ProcessEnv = {}, tools?: ToolSeam) {
    this.output.setEncoding('utf8');
    this.#release();
    const stderr = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        this.#stderr += chunk.toString('utf8');
        done();
      },
    });
    const runtime: Runtime = {
      args: [],
      env,
      stdin: this.input,
      stdout: this.output,
      stderr,
      signal: this.control.signal,
      version: '0.1.0',
    };
    this.done =
      tools === undefined ? runServer(runtime, LAUNCH) : runServer(runtime, LAUNCH, { tools });
  }

  #release(): void {
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

  get stderr(): string {
    return this.#stderr;
  }

  send(message: unknown): void {
    this.input.write(`${JSON.stringify(message)}\n`);
  }

  messages(): Json[] {
    return this.lines.map((line) => JSON.parse(line) as Json);
  }

  async response(id: number): Promise<Json> {
    await until(() => this.messages().some((message) => message['id'] === id), `reply ${id}`);
    return this.messages().find((message) => message['id'] === id) as Json;
  }

  async stop(): Promise<void> {
    this.control.abort();
    await this.done;
  }
}

const sessions: Session[] = [];

function start(env: NodeJS.ProcessEnv = {}, tools?: ToolSeam): Session {
  const session = new Session(env, tools);
  sessions.push(session);
  return session;
}

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop();
});

async function until(check: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function request(id: number, method: string, params?: Json): Json {
  return params === undefined
    ? { jsonrpc: '2.0', id, method }
    : { jsonrpc: '2.0', id, method, params };
}

async function handshake(session: Session): Promise<void> {
  session.send(
    request(1, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'write-test', version: '1.0.0' },
    }),
  );
  await session.response(1);
  session.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

/** The tool names one listing advertises. */
function named(listReply: Json): string[] {
  const result = listReply['result'] as Json;
  const tools = result['tools'] as Array<{ name: string }>;
  return tools.map((tool) => tool.name);
}

/** The text and the structured content of one call result. */
function contentOf(reply: Json): { text: string; structured: Json } {
  const result = reply['result'] as Json;
  const content = result['content'] as Array<{ text?: string }>;
  return {
    text: content[0]?.text ?? '',
    structured: result['structuredContent'] as Json,
  };
}

describe('the write advertisement of the server', () => {
  it('lists only the two read tools without the exact host switch', async () => {
    for (const env of [{}, { PTO_MCP_WRITES: 'true' }, { PTO_MCP_WRITES: '0' }]) {
      const session = start(env);
      await handshake(session);
      session.send(request(2, 'tools/list'));
      const reply = await session.response(2);
      expect(named(reply)).toEqual(['pto_list', 'pto_get']);
    }
  });

  it('lists all five tools with the exact own switch', async () => {
    const session = start({ PTO_MCP_WRITES: '1' });
    await handshake(session);
    session.send(request(2, 'tools/list'));
    expect(named(await session.response(2))).toEqual([
      'pto_list',
      'pto_get',
      'pto_create',
      'pto_update',
      'pto_delete',
    ]);
  });

  it('filters a write definition out of a custom seam while the switch is closed', async () => {
    const seam = new FakeSeam();
    const session = start({}, seam);
    await handshake(session);
    session.send(request(2, 'tools/list'));
    expect(named(await session.response(2))).toEqual(['pto_list', 'pto_get']);
  });

  it('refuses an unadvertised write as an unknown tool with no seam call', async () => {
    const seam = new FakeSeam();
    const session = start({}, seam);
    await handshake(session);
    session.send(request(2, 'tools/call', { name: 'pto_create', arguments: {} }));
    const reply = await session.response(2);
    expect(reply['error']).toMatchObject({ code: -32602 });
    expect(String((reply['error'] as Json)['message'])).toContain('Unknown tool');
    expect(seam.calls).toEqual([]);
  });
});

describe('the write dispatch of the server', () => {
  it('routes an enabled write and keeps the text and structured content identical', async () => {
    const seam = new FakeSeam();
    const session = start({ PTO_MCP_WRITES: '1' }, seam);
    await handshake(session);
    session.send(request(2, 'tools/call', { name: 'pto_create', arguments: { mode: 'preview' } }));
    const reply = await session.response(2);
    const { text, structured } = contentOf(reply);
    expect(seam.calls).toEqual(['pto_create']);
    expect(structured).toEqual(JSON.parse(text));
    expect(structured).toMatchObject({ ok: true, tool: 'pto_create', requestId: REQUEST_ID });
    expect(text).not.toContain('"note":');
  });

  it('routes an enabled write through the production validator without a credential', async () => {
    const session = start({ PTO_MCP_WRITES: '1' });
    await handshake(session);
    session.send(request(2, 'tools/call', { name: 'pto_create', arguments: {} }));
    const reply = await session.response(2);
    const { text, structured } = contentOf(reply);
    expect(structured).toEqual(JSON.parse(text));
    expect(structured).toMatchObject({ ok: false, tool: 'pto_create' });
    expect((structured['error'] as Json)['code']).toBe('INPUT');
  });

  it('reports a write cancellation through the seam', async () => {
    const pending = new Promise<AnyToolResult>(() => undefined);
    const seam = new FakeSeam(PREVIEW);
    seam.execute = (name: AnyToolName): Promise<AnyToolResult> => {
      seam.calls.push(name);
      return pending;
    };
    const session = start({ PTO_MCP_WRITES: '1' }, seam);
    await handshake(session);
    session.send(request(2, 'tools/call', { name: 'pto_create', arguments: {} }));
    await until(() => seam.calls.length === 1, 'the write call');
    session.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
    // The server aborts the call, drains it and keeps serving; the pending seam
    // never answers, so no tool result is invented.
    expect(seam.calls).toEqual(['pto_create']);
    expect(session.stderr).toBe('');
    await session.stop();
  });
});
