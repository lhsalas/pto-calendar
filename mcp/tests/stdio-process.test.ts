import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

/*
 * Real compiled stdio: each test starts `bin/pto-mcp.mjs` as a child process,
 * speaks newline-delimited JSON-RPC to it, and reads only its stdout and
 * stderr. The API is a loopback fixture owned by this test file, and every
 * credential is synthetic. The child gets a fresh HOME, no keyring session and
 * no ambient PTO_* variables, so no user profile or store can answer for it.
 */

type Json = Record<string, unknown>;

const BIN = fileURLToPath(new URL('../bin/pto-mcp.mjs', import.meta.url));
const BUILT = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const CLASSIC_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const SECRET = 'e'.repeat(64);
const TOKEN_ID = '11111111-2222-4333-8444-555555555555';
const TOKEN = `pto_pat_${TOKEN_ID}.${SECRET}`;
const OWNER = '11111111-aaaa-4111-8111-000000000001';
const FIRST = '11111111-aaaa-4111-8111-000000000002';
const NOTE = 'synthetic private note for the loopback fixture';
const LONG = 20_000;

/** The repository root, so the private build can use the reviewed packages. */
const REPO = fileURLToPath(new URL('../../', import.meta.url));

/** The synthetic helper that replaces the bundled one in the private build. */
const PENDING_HELPER = fileURLToPath(new URL('./fixtures/pending-lookup.py', import.meta.url));

/** The file the synthetic helper writes when its lookup is pending. */
const PENDING_MARKER = 'pending-lookup.pid';

/** The longest the helper of the production package may hold a lookup. */
const HELPER_TIMEOUT_MS = 10_000;

const ROW = {
  id: FIRST,
  startDate: '2026-12-07',
  endDate: '2026-12-07',
  dayPart: 'all_day',
  note: null,
  version: 1,
  user: { id: OWNER, name: 'Ada Lovelace', colorCode: '#336699' },
};
const IDENTITY = {
  id: OWNER,
  role: 'member',
  auth: {
    method: 'pat',
    tokenId: TOKEN_ID,
    scopes: ['pto:read'],
    expiresAt: '2030-01-01T00:00:00.000Z',
  },
};

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  aborted: boolean;
}

interface Fixture {
  origin: string;
  readonly seen: Seen[];
  mode: 'ok' | 'revoked' | 'hang';
}

const cleanups: Array<() => Promise<void> | void> = [];
const children: Child[] = [];
let sandbox: string;
/** The marker of the synthetic helper of the private build, when one was made. */
let ownedMarker: string | null = null;

beforeAll(() => {
  if (!existsSync(BUILT)) {
    throw new Error('Build the mcp workspace before the process tests: npm run build -w mcp');
  }
  if (!existsSync(join(REPO, 'packages/agent-auth/dist/keyring.js'))) {
    throw new Error(
      'Build the credential package before the process tests: npm run build -w packages/agent-auth',
    );
  }
});

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await stopOwnedHelper();
  if (sandbox !== undefined) await rm(sandbox, { recursive: true, force: true });
});

/**
 * Stops the synthetic helper of the private build, when one is still running.
 *
 * Only the helper this test file started is ever touched: the process id comes
 * from the marker of the private sandbox, and the command line of the process
 * is checked before it is stopped. A process that cannot be proven to be ours
 * is never stopped.
 */
async function stopOwnedHelper(): Promise<void> {
  const marker = ownedMarker;
  ownedMarker = null;
  if (marker === null) return;
  const pid = await readHelperPid(marker);
  if (pid === null) return;
  if ((await helperState(pid, marker)) !== 'running') return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // The helper is already gone.
  }
}

/** The process id the synthetic helper recorded, when it recorded one. */
async function readHelperPid(marker: string): Promise<number | null> {
  try {
    const value = Number.parseInt((await readFile(marker, 'utf8')).trim(), 10);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** The state of the recorded helper process. */
type HelperState = 'running' | 'gone' | 'unverified';

/**
 * Whether the recorded process is still running, and whether it is our helper.
 *
 * The command line is checked when the platform exposes it, so a process that
 * reused the recorded id is never mistaken for the helper. A process that
 * cannot be proven to be ours is reported as unverified and is never stopped.
 */
async function helperState(pid: number, marker: string): Promise<HelperState> {
  try {
    process.kill(pid, 0);
  } catch {
    return 'gone';
  }
  try {
    const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    const directory = marker.slice(0, marker.length - PENDING_MARKER.length);
    return cmdline.includes(directory) ? 'running' : 'unverified';
  } catch {
    return 'unverified';
  }
}

async function prepareSandbox(): Promise<void> {
  sandbox = await mkdtemp(join(await realpath(tmpdir()), 'pto-mcp-'));
  await mkdir(join(sandbox, 'home'), { mode: 0o700 });
}

/** A loopback API that answers only the documented read shapes, with the fixture's own answer modes. */
async function startFixture(): Promise<Fixture> {
  const seen: Seen[] = [];
  const fixture: Fixture = { origin: '', seen, mode: 'ok' };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const record: Seen = {
      method: request.method ?? '',
      path: request.url ?? '',
      authorization: request.headers.authorization,
      aborted: false,
    };
    seen.push(record);
    response.on('close', () => {
      if (!response.writableFinished) record.aborted = true;
    });
    if (fixture.mode === 'hang') return;
    if (fixture.mode === 'revoked' || request.headers.authorization !== `Bearer ${TOKEN}`) {
      return send(response, 401, { error: { code: 'UNAUTHENTICATED', message: 'Not valid.' } });
    }
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/auth/me') return send(response, 200, IDENTITY);
    if (path === '/pto') {
      return send(response, 200, { items: [ROW], nextCursor: null, hasMore: false });
    }
    if (path === `/pto/${FIRST}`) return send(response, 200, { ...ROW, note: NOTE });
    return send(response, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  fixture.origin = `http://127.0.0.1:${port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, 'close').catch(() => undefined);
  });
  return fixture;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** One running child with line-based access to its streams. */
class Child {
  readonly process: ChildProcess;
  readonly lines: string[] = [];
  readonly exit: Promise<Exit>;
  #stderr = '';
  #partial = '';

  constructor(args: readonly string[], env: NodeJS.ProcessEnv, binary: string = BIN) {
    this.process = spawn(process.execPath, [binary, ...args], {
      cwd: sandbox,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // A child that has already exited may refuse input; the test reports what it did instead.
    this.process.stdin?.on('error', () => undefined);
    this.process.stdout?.setEncoding('utf8');
    this.process.stdout?.on('data', (text: string) => {
      this.#partial += text;
      let index = this.#partial.indexOf('\n');
      while (index !== -1) {
        this.lines.push(this.#partial.slice(0, index));
        this.#partial = this.#partial.slice(index + 1);
        index = this.#partial.indexOf('\n');
      }
    });
    this.process.stderr?.setEncoding('utf8');
    this.process.stderr?.on('data', (text: string) => {
      this.#stderr += text;
    });
    this.exit = new Promise<Exit>((resolve) => {
      this.process.once('close', (code, signal) => resolve({ code, signal }));
    });
    children.push(this);
  }

  get stderr(): string {
    return this.#stderr;
  }

  send(value: unknown): void {
    this.process.stdin?.write(`${JSON.stringify(value)}\n`);
  }

  sendRaw(text: string): void {
    this.process.stdin?.write(text);
  }

  end(): void {
    this.process.stdin?.end();
  }

  kill(): void {
    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill('SIGKILL');
    }
  }

  messages(): Json[] {
    return this.lines.map((line) => JSON.parse(line) as Json);
  }

  /** The reply with this id. Parse errors are answered with a null id, so they are counted instead. */
  async reply(id: number): Promise<Json> {
    await until(() => this.messages().some((message) => message['id'] === id), `reply ${id}`);
    return this.messages().find((message) => message['id'] === id) as Json;
  }

  async lineCount(count: number): Promise<void> {
    await until(() => this.lines.length >= count, `${count} stdout lines`);
  }
}

async function until(check: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    // The label names what was awaited; no stream text is ever part of the message.
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Waits for a check that reads the state of a process. */
async function untilAsync(
  check: () => Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A child environment with no ambient PTO_* values, an isolated HOME and no keyring. */
function environment(managed?: { origin: string; token: string }): NodeJS.ProcessEnv {
  const home = join(sandbox, 'home');
  return {
    PATH: '/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CACHE_HOME: join(home, 'cache'),
    TMPDIR: home,
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    NODE_ENV: 'test',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/pto-mcp-test-bus',
    ...(managed === undefined
      ? {}
      : { PTO_API_ORIGIN: managed.origin, PTO_API_TOKEN: managed.token }),
  };
}

/** A child with the managed pair of the fixture and the loopback opt-in. */
function startServer(fixture: Fixture): Child {
  return new Child(
    ['--allow-loopback-http'],
    environment({ origin: fixture.origin, token: TOKEN }),
  );
}

/** The private build of the server, with its own credential package. */
interface PrivateBuild {
  /** The executable of the private build. */
  readonly binary: string;
  /** The synthetic helper of the private credential package. */
  readonly helper: string;
  /** The marker the synthetic helper writes when its lookup is pending. */
  readonly marker: string;
  /** The owner-only local store of the profile. */
  readonly store: string;
}

/**
 * Builds a private copy of the server with its own credential package.
 *
 * The copy holds the reviewed build of the credential package and a synthetic
 * helper at the bundled helper path of that copy, so a lookup is observably
 * pending. The production code has no hook to configure it: the helper path
 * is always the bundled one, next to the module that spawns it.
 */
async function createPrivateBuild(): Promise<PrivateBuild> {
  const root = join(sandbox, 'private');
  const modules = join(root, 'node_modules');
  const packages = join(modules, '@pto-calendar');
  await mkdir(join(modules, '@modelcontextprotocol'), { recursive: true });
  await mkdir(packages, { recursive: true });

  // The credential package is a private copy: its own build and its own helper.
  const credential = join(packages, 'agent-auth');
  await mkdir(join(credential, 'libexec'), { recursive: true });
  await cp(join(REPO, 'packages/agent-auth/dist'), join(credential, 'dist'), { recursive: true });
  await cp(join(REPO, 'packages/agent-auth/package.json'), join(credential, 'package.json'));
  await cp(PENDING_HELPER, join(credential, 'libexec', 'secret-service.py'));

  // The other packages are the reviewed ones of this repository.
  await symlink(join(REPO, 'packages/api-client'), join(packages, 'api-client'), 'dir');
  // Resolve the pinned SDK's dist/cjs/server entry by module name. A clean
  // npm install hoists it to the root; a local workspace may not.
  const sdkEntry = createRequire(import.meta.url).resolve('@modelcontextprotocol/sdk/server');
  const sdkRoot = await realpath(join(dirname(sdkEntry), '../../..'));
  await symlink(sdkRoot, join(modules, '@modelcontextprotocol', 'sdk'), 'dir');

  // The private build of the server itself.
  await mkdir(join(root, 'mcp'), { recursive: true });
  await cp(join(REPO, 'mcp/dist'), join(root, 'mcp/dist'), { recursive: true });
  await cp(join(REPO, 'mcp/bin'), join(root, 'mcp/bin'), { recursive: true });
  await cp(join(REPO, 'mcp/package.json'), join(root, 'mcp/package.json'));

  const helper = join(credential, 'libexec', 'secret-service.py');
  const marker = join(credential, 'libexec', PENDING_MARKER);
  ownedMarker = marker;
  return {
    binary: join(root, 'mcp/bin/pto-mcp.mjs'),
    helper,
    marker,
    store: join(sandbox, 'home', '.config', 'pto-calendar', 'agent-auth'),
  };
}

/**
 * Writes the synthetic profile of the private store.
 *
 * The record is metadata only: it binds the loopback origin of the fixture to
 * the credential store of the operating system, and it holds no secret.
 */
async function writeProfile(store: string, origin: string): Promise<void> {
  await mkdir(store, { recursive: true, mode: 0o700 });
  await writeFile(
    join(store, 'default.json'),
    `${JSON.stringify({
      version: 1,
      profile: 'default',
      origin,
      allowLoopbackHttp: true,
      storage: 'keyring',
    })}\n`,
    { mode: 0o600 },
  );
}

function request(id: number, method: string, params?: Json): Json {
  return params === undefined
    ? { jsonrpc: '2.0', id, method }
    : { jsonrpc: '2.0', id, method, params };
}

function call(id: number, name: string, args: Json): Json {
  return request(id, 'tools/call', { name, arguments: args });
}

function initialize(id: number, protocolVersion: string): Json {
  return request(id, 'initialize', {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'process-test', version: '1.0.0' },
  });
}

async function handshake(child: Child, version = '2025-11-25'): Promise<void> {
  child.send(initialize(1, version));
  await child.reply(1);
  child.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

/** Every stdout line is a JSON-RPC message, and the credential appears in neither stream. */
function expectClean(child: Child): void {
  for (const line of child.lines) {
    expect((JSON.parse(line) as Json)['jsonrpc']).toBe('2.0');
  }
  // A boolean keeps a credential out of the assertion output if the check ever fails.
  const text = child.lines.join('\n') + child.stderr;
  expect(text.includes(TOKEN) || text.includes(SECRET)).toBe(false);
}

function resultOf(message: Json): Json {
  return message['result'] as Json;
}

function structuredOf(message: Json): Json {
  return resultOf(message)['structuredContent'] as Json;
}

describe('compiled stdio server', () => {
  it.each(CLASSIC_VERSIONS)(
    'negotiates the classic revision %s and serves ping over real stdio',
    async (version) => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture);
      child.send(initialize(1, version));
      expect(await child.reply(1)).toMatchObject({
        result: {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: 'pto-mcp', version: '0.1.0' },
        },
      });
      child.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      child.send(request(2, 'ping'));
      expect(await child.reply(2)).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
      child.end();
      expect(await child.exit).toEqual({ code: 0, signal: null });
      expectClean(child);
    },
    LONG,
  );

  it(
    'answers a revision it does not support with the latest classic revision',
    async () => {
      await prepareSandbox();
      const child = startServer(await startFixture());
      child.send(initialize(1, '2026-07-28'));
      expect(resultOf(await child.reply(1))).toMatchObject({ protocolVersion: '2025-11-25' });
      child.end();
      expect(await child.exit).toEqual({ code: 0, signal: null });
      expectClean(child);
    },
    LONG,
  );

  it(
    'discovers exactly the two read-only tools with closed schemas',
    async () => {
      await prepareSandbox();
      const child = startServer(await startFixture());
      await handshake(child);
      child.send(request(2, 'tools/list'));
      const tools = resultOf(await child.reply(2))['tools'] as Json[];
      expect(tools.map((tool) => tool['name'])).toEqual(['pto_list', 'pto_get']);
      for (const tool of tools) {
        expect(tool['annotations']).toMatchObject({ readOnlyHint: true });
        expect((tool['inputSchema'] as Json)['additionalProperties']).toBe(false);
        expect((tool['outputSchema'] as Json)['type']).toBe('object');
      }
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'reads a list through the loopback API with the managed credential and returns it as text and structure',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture);
      await handshake(child);
      child.send(call(2, 'pto_list', { from: '2026-12-07', to: '2026-12-07', ownerId: OWNER }));
      const message = await child.reply(2);
      const result = resultOf(message);
      expect(result['isError']).toBe(false);
      const structured = structuredOf(message);
      expect(structured).toMatchObject({ ok: true, tool: 'pto_list' });
      const data = structured['data'] as Json;
      expect(data).toMatchObject({ complete: true, reason: 'complete', pages: 1 });
      expect((data['items'] as Json[])[0]).toMatchObject({ id: FIRST, note: null });
      const text = (result['content'] as Array<{ text: string }>)[0]!.text;
      expect(JSON.parse(text)).toEqual(structured);
      expect(fixture.seen.some((seen) => seen.authorization === `Bearer ${TOKEN}`)).toBe(true);
      expect(
        fixture.seen.map(({ path }) => {
          const query = new URL(path, fixture.origin);
          return [query.pathname, query.searchParams.get('userId')];
        }),
      ).toEqual([['/pto', OWNER]]);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'returns the private note only when it is asked for, and never in a list',
    async () => {
      await prepareSandbox();
      const child = startServer(await startFixture());
      await handshake(child);
      child.send(call(2, 'pto_get', { id: FIRST }));
      expect((structuredOf(await child.reply(2))['data'] as Json)['note']).toBeNull();
      child.send(call(3, 'pto_get', { id: FIRST, includeNote: true }));
      expect((structuredOf(await child.reply(3))['data'] as Json)['note']).toBe(NOTE);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'refuses an extra argument before any request reaches the API',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture);
      await handshake(child);
      child.send(call(2, 'pto_list', { from: '2026-12-07', to: '2026-12-07', token: 'x' }));
      const result = resultOf(await child.reply(2));
      expect(result['isError']).toBe(true);
      expect(structuredOf(await child.reply(2))).toMatchObject({ error: { code: 'INPUT' } });
      expect(fixture.seen).toHaveLength(0);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'answers an unknown tool name with a fixed protocol error and does not echo it',
    async () => {
      await prepareSandbox();
      const child = startServer(await startFixture());
      await handshake(child);
      child.send(call(2, 'pto_delete_everything', {}));
      const error = (await child.reply(2))['error'] as Json;
      expect(error).toEqual({ code: -32602, message: 'MCP error -32602: Unknown tool' });
      child.end();
      await child.exit;
      expect(child.lines.join('\n')).not.toContain('pto_delete_everything');
      expectClean(child);
    },
    LONG,
  );

  it(
    'refuses unsafe ids, task-augmented requests and invalid initialize params without echoing them',
    async () => {
      await prepareSandbox();
      const child = startServer(await startFixture());
      // The probe is a unique marker in each refused value. It must never reach either stream.
      const probe = 'probe-7c1d-no-echo';
      child.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: probe,
          clientInfo: { name: 'process-test', version: '1.0.0' },
        },
      });
      expect((await child.reply(1))['error']).toEqual({
        code: -32602,
        message: 'Invalid params',
      });
      child.sendRaw(
        `${JSON.stringify({ jsonrpc: '2.0', id: `${TOKEN}${probe}`, method: 'ping' })}\n`,
      );
      await child.lineCount(2);
      child.sendRaw(
        `${JSON.stringify({ jsonrpc: '2.0', id: 3, method: `${probe}-method`, params: { task: {} } })}\n`,
      );
      expect((await child.reply(3))['error']).toEqual({
        code: -32601,
        message: 'Method not found',
      });
      await handshake(child);
      child.send(request(4, 'ping'));
      expect(await child.reply(4)).toEqual({ jsonrpc: '2.0', id: 4, result: {} });
      child.end();
      expect(await child.exit).toEqual({ code: 0, signal: null });
      expectClean(child);
      const everything = child.lines.join('\n') + child.stderr;
      expect(everything.includes(probe)).toBe(false);
      expect(child.messages().filter((message) => message['id'] === null)).toEqual([
        { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
      ]);
    },
    LONG,
  );

  it(
    'answers malformed and oversized frames and keeps serving',
    async () => {
      await prepareSandbox();
      const child = startServer(await startFixture());
      await handshake(child);
      child.sendRaw('{not json\n');
      child.sendRaw(`${'x'.repeat(300 * 1024)}\n`);
      child.send(request(9, 'ping'));
      expect(await child.reply(9)).toEqual({ jsonrpc: '2.0', id: 9, result: {} });
      const replies = child.messages().filter((message) => message['id'] === null);
      expect(replies).toEqual([
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Request frame is too large' },
        },
      ]);
      // The diagnostics are fixed sentences: one per rejected frame, and no client text. Stderr is
      // a separate pipe, so its lines are awaited rather than assumed to have arrived already.
      const diagnostic = 'pto-mcp: rejected a malformed protocol frame.\n';
      await until(() => child.stderr.length >= diagnostic.length * 2, 'the diagnostics');
      expect(child.stderr).toBe(diagnostic.repeat(2));
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'reports a revoked credential on the next call without reconnecting',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture);
      await handshake(child);
      child.send(call(2, 'pto_get', { id: FIRST }));
      expect(resultOf(await child.reply(2))['isError']).toBe(false);
      fixture.mode = 'revoked';
      child.send(call(3, 'pto_get', { id: FIRST }));
      const revoked = resultOf(await child.reply(3));
      expect(revoked['isError']).toBe(true);
      expect(structuredOf(await child.reply(3))).toMatchObject({ error: { code: 'AUTH' } });
      child.send(request(4, 'ping'));
      expect(await child.reply(4)).toEqual({ jsonrpc: '2.0', id: 4, result: {} });
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'sends nothing to a plain-HTTP origin without the loopback opt-in',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = new Child([], environment({ origin: fixture.origin, token: TOKEN }));
      await handshake(child);
      child.send(call(2, 'pto_list', { from: '2026-12-07', to: '2026-12-07' }));
      expect(resultOf(await child.reply(2))['isError']).toBe(true);
      expect(fixture.seen).toHaveLength(0);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'reports missing credentials as a fixed tool error and never prompts',
    async () => {
      await prepareSandbox();
      const child = new Child([], environment());
      await handshake(child);
      child.send(call(2, 'pto_list', { from: '2026-12-07', to: '2026-12-07' }));
      const message = await child.reply(2);
      expect(resultOf(message)['isError']).toBe(true);
      expect(structuredOf(message)).toMatchObject({ error: { code: 'AUTH' } });
      child.send(request(3, 'ping'));
      expect(await child.reply(3)).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'stops a cancelled read, aborts its request and sends it no reply',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture);
      await handshake(child);
      fixture.mode = 'hang';
      child.send(call(7, 'pto_list', { from: '2026-12-07', to: '2026-12-07' }));
      await until(() => fixture.seen.some((seen) => seen.path.startsWith('/pto?')), 'the read');
      child.send({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 7, reason: 'user stopped waiting' },
      });
      await until(() => fixture.seen.some((seen) => seen.aborted), 'the aborted read');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(child.messages().some((message) => message['id'] === 7)).toBe(false);
      fixture.mode = 'ok';
      child.send(request(8, 'ping'));
      expect(await child.reply(8)).toEqual({ jsonrpc: '2.0', id: 8, result: {} });
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'releases an in-flight read and exits zero when stdin closes',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture);
      await handshake(child);
      fixture.mode = 'hang';
      child.send(call(5, 'pto_list', { from: '2026-12-07', to: '2026-12-07' }));
      await until(() => fixture.seen.some((seen) => seen.path.startsWith('/pto?')), 'the read');
      child.end();
      expect(await child.exit).toEqual({ code: 0, signal: null });
      await until(() => fixture.seen.some((seen) => seen.aborted), 'the aborted read');
      expectClean(child);
    },
    LONG,
  );

  it(
    'releases an in-flight read and exits zero on SIGTERM',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture);
      await handshake(child);
      fixture.mode = 'hang';
      child.send(call(6, 'pto_list', { from: '2026-12-07', to: '2026-12-07' }));
      await until(() => fixture.seen.some((seen) => seen.path.startsWith('/pto?')), 'the read');
      child.process.kill('SIGTERM');
      expect(await child.exit).toEqual({ code: 0, signal: null });
      await until(() => fixture.seen.some((seen) => seen.aborted), 'the aborted read');
      expectClean(child);
    },
    LONG,
  );
});

describe('a cancelled credential lookup over real stdio', () => {
  it(
    'releases the helper, the profile lock and the tool slot before the helper timeout',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const build = await createPrivateBuild();
      await writeProfile(build.store, fixture.origin);
      const child = new Child(['--allow-loopback-http'], environment(), build.binary);

      await handshake(child);
      child.send(call(2, 'pto_list', { from: '2026-12-07', to: '2026-12-07' }));

      // The lookup is pending: the synthetic helper of the private build runs
      // and has not answered, and the profile is locked while it runs.
      await until(() => existsSync(build.marker), 'the pending lookup');
      const helperPid = await readHelperPid(build.marker);
      expect(helperPid).not.toBeNull();
      expect(await helperState(helperPid!, build.marker)).toBe('running');
      expect(existsSync(join(build.store, '.lock.default'))).toBe(true);
      // Nothing reached the API while the credential was pending.
      expect(fixture.seen).toHaveLength(0);

      const started = Date.now();
      child.send({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 2, reason: 'user stopped waiting' },
      });

      // The helper is stopped and the profile lock is released, both long
      // before the ten-second fallback of the credential package.
      await untilAsync(
        async () => (await helperState(helperPid!, build.marker)) === 'gone',
        'the released helper',
        5_000,
      );
      await untilAsync(
        async () => !existsSync(join(build.store, '.lock.default')),
        'the released lock',
        5_000,
      );
      expect(Date.now() - started).toBeLessThan(HELPER_TIMEOUT_MS);

      // The cancelled call is answered with nothing, and no request ever
      // reached the API.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(child.messages().some((message) => message['id'] === 2)).toBe(false);
      expect(fixture.seen).toHaveLength(0);

      // The server keeps serving: the slot of the cancelled call was released.
      child.send(request(3, 'ping'));
      expect(await child.reply(3)).toEqual({ jsonrpc: '2.0', id: 3, result: {} });

      child.end();
      expect(await child.exit).toEqual({ code: 0, signal: null });
      expectClean(child);
    },
    LONG,
  );

  it(
    'releases the helper and the profile lock when the client closes stdin',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const build = await createPrivateBuild();
      await writeProfile(build.store, fixture.origin);
      const child = new Child(['--allow-loopback-http'], environment(), build.binary);

      await handshake(child);
      child.send(call(4, 'pto_list', { from: '2026-12-07', to: '2026-12-07' }));
      await until(() => existsSync(build.marker), 'the pending lookup');
      const helperPid = await readHelperPid(build.marker);
      expect(helperPid).not.toBeNull();

      const started = Date.now();
      child.end();

      // The server stops, the lookup is stopped with it, and the process exits
      // before the helper timeout of the credential package.
      expect(await child.exit).toEqual({ code: 0, signal: null });
      expect(Date.now() - started).toBeLessThan(HELPER_TIMEOUT_MS);
      await untilAsync(
        async () => (await helperState(helperPid!, build.marker)) === 'gone',
        'the released helper',
        5_000,
      );
      await untilAsync(
        async () => !existsSync(join(build.store, '.lock.default')),
        'the released lock',
        5_000,
      );
      // No request reached the API while the credential was pending.
      expect(fixture.seen).toHaveLength(0);
      expectClean(child);
    },
    LONG,
  );
});
