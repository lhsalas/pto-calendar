import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

/*
 * Independent real compiled stdio verification of the writable MCP surface.
 *
 * This file owns nothing but its own process fixture. It starts the compiled
 * `bin/pto-mcp.mjs` as a child process, speaks newline-delimited JSON-RPC to
 * it and reads only its stdout and its stderr. The service is a loopback
 * fixture owned by this file, every credential is synthetic, and the child
 * gets a private HOME, no keyring session and no ambient PTO_* value other
 * than the managed pair and the one host switch under test. No user profile,
 * no global process and no database is ever touched.
 *
 * The contract under test is the frozen #264 contract, not an implementation:
 *
 * - the write surface exists only for a trusted process that owns the exact
 *   own field `PTO_MCP_WRITES=1`; every other spelling keeps the two read
 *   tools exactly as they were and leaves a write call unroutable;
 * - `pto_create`, `pto_update` and `pto_delete` take a discriminated
 *   `mode: preview | apply`, the same canonical business input on both sides
 *   and an opaque `previewId` that only an apply may carry;
 * - a preview reads the live identity and the exact target where one is
 *   needed and dispatches no mutation at all;
 * - an apply is bound to the exact preview, to the live identity, the live
 *   role and the live scopes, and dispatches exactly one request;
 * - a create key is the canonical `v1.<13 digits>.<uuid>` of one intent, is
 *   never echoed, and is reused verbatim by an explicit replay;
 * - a note is never echoed: an update carries only the fields the caller
 *   named, so an omitted note survives and an explicit one clears it;
 * - an update and a delete carry the exact quoted version of the caller, and
 *   no other version is ever substituted;
 * - a stale answer, a conflict, a rate limit and a lost answer are reported
 *   with a bounded recovery and never retried by the server.
 *
 * Every assertion below states a property of that contract. Where the exact
 * envelope of a result is not frozen, the assertion checks the semantic
 * property instead of a field name, so a naming difference can never turn a
 * real defect into a green test. No assertion ever prints a credential, a key
 * or a note: the leak checks answer with a boolean on purpose.
 */

type Json = Record<string, unknown>;

const BIN = fileURLToPath(new URL('../bin/pto-mcp.mjs', import.meta.url));
const BUILT = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const SECRET = 'e'.repeat(64);
const TOKEN_ID = '11111111-2222-4333-8444-555555555555';
const TOKEN = `pto_pat_${TOKEN_ID}.${SECRET}`;
const ACTOR = '11111111-aaaa-4111-8111-000000000001';
const COLLEAGUE = '11111111-aaaa-4111-8111-000000000003';
const FIRST = '11111111-aaaa-4111-8111-000000000002';
const HIDDEN_NOTE = 'hidden synthetic note zq7-must-never-appear';
const CREATE_NOTE = 'caller synthetic note yp4-must-never-appear';
const PROBE = 'probe-8f3-must-never-appear';
const LONG = 20_000;

/** The days the scenarios use. They are weekdays, as the service requires. */
const DAY = '2026-12-07';
const OTHER_DAY = '2026-12-09';
/** A weekday before the stored range, used by the inverted-range scenarios. */
const EARLIER_DAY = '2026-12-04';
/** A hostile upstream correlation value. It must never reach a write result. */
const CORRELATION_SENTINEL = 'sentinel-4b7d-must-not-appear';

/**
 * The two ways one single bound can invert the merged range of the stored
 * entry, which runs from `DAY` to `DAY`.
 *
 * Each case supplies exactly one endpoint, so the merged range is only known
 * against the live entry and cannot be refused by the argument validation.
 */
const INVERTED_RANGES: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ['a start date later than the stored end date', { startDate: OTHER_DAY }],
  ['an end date earlier than the stored start date', { endDate: EARLIER_DAY }],
];

/** The scopes a full write credential holds in the scenarios. */
const WRITE_SCOPES = ['pto:read', 'pto:create', 'pto:update:self', 'pto:delete:self'];

/** The scopes a team credential holds in the ownership scenario. */
const TEAM_SCOPES = ['pto:read', 'pto:update:team', 'pto:delete:team'];

/**
 * The words a note intent may use.
 *
 * The contract fixes the intent, not the vocabulary, so the check accepts the
 * documented synonyms and never accepts the note text itself.
 */
const NOTE_INTENT_WORDS = {
  preserve: ['preserve', 'keep', 'retain', 'unchanged', 'untouched', 'hidden'],
  clear: ['clear', 'remove', 'empty', 'drop'],
  replace: ['replace', 'set'],
} as const;

/** The names a tool input may never carry. */
const FORBIDDEN_ARGUMENT_NAMES = [
  'actas',
  'actor',
  'actinguser',
  'role',
  'ownerid',
  'userid',
  'token',
  'credential',
  'secret',
  'apikey',
  'origin',
  'endpoint',
  'url',
  'baseurl',
  'header',
  'path',
  'command',
  'shell',
  'script',
  'confirmed',
  'approve',
  'approved',
  'yes',
];

/* ------------------------------------------------------------------------- */
/* The loopback service.                                                     */
/* ------------------------------------------------------------------------- */

/** One request the service saw. */
interface Seen {
  readonly method: string;
  readonly path: string;
  readonly ifMatch: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly body: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  status: number | null;
  replyLost: boolean;
  /** The peer closed the connection before the answer was written. */
  clientGone: boolean;
}

/** One stored row of the synthetic service. */
interface Row {
  id: string;
  userId: string;
  startDate: string;
  endDate: string;
  dayPart: string;
  note: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** How one write endpoint answers the next call. */
type Outcome = 'ok' | 'conflict' | 'rate-limit' | 'stale' | 'drop';

/** The kinds of answer the fixture may hold until it is released. */
type Hold = 'none' | 'identity' | 'detail' | 'create';

/** One answer the fixture is holding open. */
interface Held {
  readonly record: Seen;
  readonly response: ServerResponse;
  readonly respond: () => void;
}

/** The state of the synthetic service. */
interface Fixture {
  origin: string;
  readonly seen: Seen[];
  readonly rows: Map<string, Row>;
  readonly replays: Map<string, string>;
  readonly created: Row[];
  readonly held: Held[];
  revoked: boolean;
  role: string;
  scopes: string[];
  ownerId: string;
  note: string | null;
  version: number;
  createOutcome: Outcome;
  patchOutcome: Outcome;
  deleteOutcome: Outcome;
  /** The kind of answer the fixture holds open until it is released. */
  hold: Hold;
  /** The upstream correlation header every answer carries, when one is set. */
  correlation: string | undefined;
  /** Releases every held answer. A peer that is gone is ignored. */
  release(): void;
}

/** The header of a request, or nothing when it was not sent. */
function headerOf(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The body of a request, read as text. */
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/** The parsed body of a request, or an empty object. */
function bodyOf(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // A body that is not JSON is simply not a change the service understands.
  }
  return {};
}

/** The exact quoted version of a precondition, or nothing. */
function versionOf(ifMatch: string | undefined): number | null {
  const matched = /^\"([1-9][0-9]{0,9})\"$/.exec(ifMatch ?? '');
  return matched === null ? null : Number(matched[1]);
}

/** The expiry a keyed answer carries: the key's own millisecond plus one day. */
function expiresAtOf(key: string | undefined): string {
  const parts = (key ?? '').split('.');
  const millis = parts[1] ?? '';
  const issued = /^\d{13}$/.test(millis) ? Number(millis) : Date.now();
  return new Date(issued + 86_400_000).toISOString();
}

/** The public body of one row, as a mutation returns it. */
function rowBody(row: Row): Json {
  return {
    id: row.id,
    userId: row.userId,
    startDate: row.startDate,
    endDate: row.endDate,
    dayPart: row.dayPart,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/**
 * Starts the loopback service of one scenario.
 *
 * The service answers the documented read shapes, the three documented writes
 * and the refusal modes the scenarios need. Every request is recorded, so a
 * test can tell "no dispatch" from "one dispatch" and can read the exact
 * precondition and key of the requests that were sent.
 */
async function startFixture(): Promise<Fixture> {
  const seen: Seen[] = [];
  const rows = new Map<string, Row>();
  const replays = new Map<string, string>();
  const created: Row[] = [];
  const held: Held[] = [];
  const fixture: Fixture = {
    origin: '',
    seen,
    rows,
    replays,
    created,
    held,
    revoked: false,
    role: 'member',
    scopes: [...WRITE_SCOPES],
    ownerId: ACTOR,
    note: HIDDEN_NOTE,
    version: 1,
    createOutcome: 'ok',
    patchOutcome: 'ok',
    deleteOutcome: 'ok',
    hold: 'none',
    correlation: undefined,
    release: () => {
      for (const entry of held.splice(0)) {
        try {
          entry.respond();
        } catch {
          // The peer is gone, so the held answer has no one left to reach.
        }
      }
    },
  };
  rows.set(FIRST, {
    id: FIRST,
    userId: ACTOR,
    startDate: DAY,
    endDate: DAY,
    dayPart: 'all_day',
    note: HIDDEN_NOTE,
    version: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  });

  /**
   * Holds one answer open when the scenario asked for it.
   *
   * The answer is kept, not written, so the caller stays in flight and the
   * service can observe the moment the peer goes away.
   */
  const holdAnswer = (
    kind: Hold,
    record: Seen,
    response: ServerResponse,
    respond: () => void,
  ): boolean => {
    if (fixture.hold !== kind) return false;
    held.push({ record, response, respond });
    return true;
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const body = await readBody(request);
    const record: Seen = {
      method: request.method ?? '',
      path,
      ifMatch: headerOf(request, 'if-match'),
      idempotencyKey: headerOf(request, 'idempotency-key'),
      body,
      headers: { ...request.headers },
      status: null,
      replyLost: false,
      clientGone: false,
    };
    seen.push(record);
    response.on('close', () => {
      if (!response.writableFinished) {
        record.replyLost = true;
        // The peer went away before the answer was written: the caller
        // cancelled, or the connection was dropped.
        record.clientGone = true;
      }
    });
    // A hostile upstream may put anything in the correlation header. The
    // service is free to send it; the adapter is not free to reflect it.
    if (fixture.correlation !== undefined) {
      response.setHeader('x-request-id', fixture.correlation);
    }

    if (request.headers.authorization !== `Bearer ${TOKEN}` || fixture.revoked) {
      record.status = 401;
      send(response, 401, { error: { code: 'UNAUTHENTICATED', message: 'Not valid.' } });
      return;
    }

    if (path === '/auth/me' && request.method === 'GET') {
      record.status = 200;
      const answer = {
        id: ACTOR,
        role: fixture.role,
        auth: {
          method: 'pat',
          tokenId: TOKEN_ID,
          scopes: fixture.scopes,
          expiresAt: '2030-01-01T00:00:00.000Z',
        },
      };
      if (holdAnswer('identity', record, response, () => send(response, 200, answer))) return;
      send(response, 200, answer);
      return;
    }

    if (path === `/pto/${FIRST}` && request.method === 'GET') {
      const row = rows.get(FIRST);
      if (row === undefined) {
        record.status = 404;
        send(response, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
        return;
      }
      record.status = 200;
      const answer = {
        id: row.id,
        user: { id: row.userId, name: 'Ada Lovelace', colorCode: '#336699' },
        startDate: row.startDate,
        endDate: row.endDate,
        dayPart: row.dayPart,
        note: row.note,
        version: row.version,
      };
      if (holdAnswer('detail', record, response, () => send(response, 200, answer))) return;
      send(response, 200, answer);
      return;
    }

    if (path === '/pto' && request.method === 'POST') {
      const key = record.idempotencyKey;
      if (fixture.createOutcome === 'rate-limit') {
        record.status = 429;
        response.setHeader('retry-after', '7');
        send(response, 429, { error: { code: 'RATE_LIMITED', message: 'Too many requests.' } });
        return;
      }
      if (fixture.createOutcome === 'conflict') {
        record.status = 409;
        send(response, 409, {
          error: { code: 'CONFLICT', message: 'The range overlaps an existing entry.' },
        });
        return;
      }
      const payload = bodyOf(body);
      const known = key === undefined ? undefined : replays.get(key);
      const row =
        known === undefined
          ? (() => {
              const createdRow: Row = {
                id: `22222222-aaaa-4111-8111-${String(created.length + 1).padStart(12, '0')}`,
                userId: ACTOR,
                startDate: String(payload['startDate'] ?? DAY),
                endDate: String(payload['endDate'] ?? DAY),
                dayPart: String(payload['dayPart'] ?? 'all_day'),
                note: typeof payload['note'] === 'string' ? payload['note'] : null,
                version: 1,
                createdAt: '2026-11-21T00:00:00.000Z',
                updatedAt: '2026-11-21T00:00:00.000Z',
              };
              rows.set(createdRow.id, createdRow);
              created.push(createdRow);
              if (key !== undefined) replays.set(key, createdRow.id);
              return createdRow;
            })()
          : rows.get(known)!;
      record.status = 201;
      if (fixture.createOutcome === 'drop') {
        // The row is committed, but the answer never reaches the client.
        record.replyLost = true;
        request.socket.destroy();
        return;
      }
      response.setHeader('idempotency-replayed', known === undefined ? 'false' : 'true');
      response.setHeader('idempotency-key-expires-at', expiresAtOf(key));
      // The row is committed before the answer is written, so a held answer
      // is a committed write whose reply the caller never sees.
      if (holdAnswer('create', record, response, () => send(response, 201, rowBody(row)))) return;
      send(response, 201, rowBody(row));
      return;
    }

    if (path === `/pto/${FIRST}` && request.method === 'PATCH') {
      if (fixture.patchOutcome === 'rate-limit') {
        record.status = 429;
        response.setHeader('retry-after', '7');
        send(response, 429, { error: { code: 'RATE_LIMITED', message: 'Too many requests.' } });
        return;
      }
      if (fixture.patchOutcome === 'stale') {
        record.status = 412;
        send(response, 412, {
          error: { code: 'STALE_WRITE', message: 'The entry changed since it was read.' },
        });
        return;
      }
      const row = rows.get(FIRST);
      if (row === undefined) {
        record.status = 404;
        send(response, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
        return;
      }
      if (versionOf(record.ifMatch) !== row.version) {
        record.status = 412;
        send(response, 412, {
          error: { code: 'STALE_WRITE', message: 'The entry changed since it was read.' },
        });
        return;
      }
      if (fixture.patchOutcome === 'drop') {
        record.replyLost = true;
        request.socket.destroy();
        return;
      }
      const changes = bodyOf(body);
      if (typeof changes['startDate'] === 'string') row.startDate = changes['startDate'];
      if (typeof changes['endDate'] === 'string') row.endDate = changes['endDate'];
      if (typeof changes['dayPart'] === 'string') row.dayPart = changes['dayPart'];
      if (changes['note'] === null) row.note = null;
      else if (typeof changes['note'] === 'string' && changes['note'].length > 0) {
        row.note = changes['note'];
      }
      row.version += 1;
      row.updatedAt = '2026-11-21T00:00:01.000Z';
      record.status = 200;
      send(response, 200, rowBody(row));
      return;
    }

    if (path === `/pto/${FIRST}` && request.method === 'DELETE') {
      if (fixture.deleteOutcome === 'rate-limit') {
        record.status = 429;
        response.setHeader('retry-after', '7');
        send(response, 429, { error: { code: 'RATE_LIMITED', message: 'Too many requests.' } });
        return;
      }
      if (fixture.deleteOutcome === 'stale') {
        record.status = 412;
        send(response, 412, {
          error: { code: 'STALE_WRITE', message: 'The entry changed since it was read.' },
        });
        return;
      }
      const row = rows.get(FIRST);
      if (row === undefined) {
        record.status = 404;
        send(response, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
        return;
      }
      if (versionOf(record.ifMatch) !== row.version) {
        record.status = 412;
        send(response, 412, {
          error: { code: 'STALE_WRITE', message: 'The entry changed since it was read.' },
        });
        return;
      }
      if (fixture.deleteOutcome === 'drop') {
        record.replyLost = true;
        request.socket.destroy();
        return;
      }
      rows.delete(FIRST);
      record.status = 204;
      response.writeHead(204);
      response.end();
      return;
    }

    record.status = 404;
    send(response, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void handle(request, response);
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

/* ------------------------------------------------------------------------- */
/* The child process.                                                        */
/* ------------------------------------------------------------------------- */

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

  constructor(args: readonly string[], env: NodeJS.ProcessEnv) {
    this.process = spawn(process.execPath, [BIN, ...args], {
      cwd: sandbox,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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

  /** The reply with this id. A parse error is answered with a null id, so it is not matched. */
  async reply(id: number): Promise<Json> {
    await until(() => this.messages().some((message) => message['id'] === id), `reply ${id}`);
    return this.messages().find((message) => message['id'] === id) as Json;
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

/* ------------------------------------------------------------------------- */
/* The harness.                                                              */
/* ------------------------------------------------------------------------- */

const cleanups: Array<() => Promise<void> | void> = [];
const children: Child[] = [];
let sandbox: string;

beforeAll(() => {
  if (!existsSync(BUILT)) {
    throw new Error('Build the mcp workspace before the process tests: npm run build -w mcp');
  }
});

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  if (sandbox !== undefined) await rm(sandbox, { recursive: true, force: true });
});

async function prepareSandbox(): Promise<void> {
  sandbox = await mkdtemp(join(await realpath(tmpdir()), 'pto-mcp-writes-'));
  await mkdir(join(sandbox, 'home'), { mode: 0o700 });
}

/**
 * The environment of one child.
 *
 * There is no ambient PTO_* value, no user profile, no keyring session and no
 * shared store: the only credential is the synthetic managed pair, and the
 * only switch is the one the scenario puts there.
 */
function environment(options: { origin: string; writes?: string }): NodeJS.ProcessEnv {
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
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/pto-mcp-write-test-bus',
    PTO_API_ORIGIN: options.origin,
    PTO_API_TOKEN: TOKEN,
    ...(options.writes === undefined ? {} : { PTO_MCP_WRITES: options.writes }),
  };
}

/** A child with the exact host write switch. */
function startServer(fixture: Fixture, writes?: string): Child {
  return new Child(['--allow-loopback-http'], environment({ origin: fixture.origin, writes }));
}

function request(id: number, method: string, params?: Json): Json {
  return params === undefined
    ? { jsonrpc: '2.0', id, method }
    : { jsonrpc: '2.0', id, method, params };
}

function call(id: number, name: string, args: Json): Json {
  return request(id, 'tools/call', { name, arguments: args });
}

async function handshake(child: Child): Promise<void> {
  child.send(
    request(1, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'write-process-test', version: '1.0.0' },
    }),
  );
  await child.reply(1);
  child.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

/**
 * Cancels one in-flight request.
 *
 * The SDK aborts the handler of that request and, by the pinned protocol, it
 * answers neither the result nor an error: a cancelled request gets no reply
 * at all.
 */
function cancel(child: Child, id: number): void {
  child.send({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: id, reason: 'the host stopped waiting' },
  });
}

function resultOf(message: Json): Json {
  return (message['result'] ?? {}) as Json;
}

/** The structured content of one tool result. */
function structuredOf(message: Json): Json {
  return (resultOf(message)['structuredContent'] ?? {}) as Json;
}

/** The text fallback of one tool result. */
function textOf(message: Json): string {
  const content = (resultOf(message)['content'] ?? []) as Array<{ type?: string; text?: string }>;
  return content[0]?.text ?? '';
}

/** The data member of a successful envelope. */
function dataOf(message: Json): Json {
  return (structuredOf(message)['data'] ?? {}) as Json;
}

/** The typed error of a failed envelope. */
function errorOf(message: Json): Json {
  return (structuredOf(message)['error'] ?? {}) as Json;
}

/** Whether the reply carries a successful tool envelope. */
function succeeded(message: Json): boolean {
  return structuredOf(message)['ok'] === true;
}

/** Every string value of a JSON tree. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => stringsIn(item));
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap((item) => stringsIn(item));
  }
  return [];
}

/** Every number value of a JSON tree. */
function numbersIn(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => numbersIn(item));
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap((item) => numbersIn(item));
  }
  return [];
}

/** The lowercased JSON of a value, for the intent and vocabulary checks. */
function lowered(value: unknown): string {
  return JSON.stringify(value ?? '').toLowerCase();
}

/** The JSON of a value, for the "is this fact part of the answer" checks. */
function shown(value: unknown): string {
  return JSON.stringify(value ?? '');
}

/**
 * Whether the answer states the version of the target.
 *
 * The version may be a number of its own or part of a text line, so both
 * shapes are accepted; what is checked is that the version is shown at all.
 */
function statesVersion(value: unknown, version: number): boolean {
  if (numbersIn(value).includes(version)) return true;
  return stringsIn(value).some((text) => new RegExp(`version\\D*${version}\\b`, 'i').test(text));
}

/** Whether the value states the given note intent. */
function statesIntent(value: unknown, intent: keyof typeof NOTE_INTENT_WORDS): boolean {
  const text = lowered(value);
  return NOTE_INTENT_WORDS[intent].some((word) => text.includes(word));
}

/**
 * Whether any forbidden value appears in the text.
 *
 * The answer is a boolean on purpose: a failing assertion must never print a
 * credential, a key or a note.
 */
function leaks(text: string, forbidden: readonly string[]): boolean {
  return forbidden.some((value) => text.includes(value));
}

/** The requests the service saw that were not reads. */
function mutations(fixture: Fixture): Seen[] {
  return fixture.seen.filter((seen) => seen.method !== 'GET');
}

/** The requests the service saw, without the credential header. */
function requestText(fixture: Fixture): string {
  return JSON.stringify(
    fixture.seen.map((seen) => ({
      method: seen.method,
      path: seen.path,
      body: seen.body,
      headers: Object.fromEntries(
        Object.entries(seen.headers).filter(([name]) => name !== 'authorization'),
      ),
    })),
  );
}

/** Every stdout line is a JSON-RPC message, and the credential appears in neither stream. */
function expectClean(child: Child): void {
  for (const line of child.lines) {
    expect((JSON.parse(line) as Json)['jsonrpc']).toBe('2.0');
  }
  const text = child.lines.join('\n') + child.stderr;
  expect(leaks(text, [TOKEN, SECRET])).toBe(false);
}

/** A canonical create key of one intent. */
function createKey(): string {
  return `v1.${Date.now()}.${randomUUID()}`;
}

/** The create arguments of one intent. */
function createPlan(note?: string): Json {
  return {
    startDate: DAY,
    endDate: DAY,
    dayPart: 'all_day',
    idempotencyKey: createKey(),
    ...(note === undefined ? {} : { note }),
  };
}

/* ------------------------------------------------------------------------- */
/* The scenarios.                                                            */
/* ------------------------------------------------------------------------- */

describe('the host write switch of the compiled stdio server', () => {
  it(
    'advertises exactly the two read tools when the switch is absent',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture);
      await handshake(child);
      child.send(request(2, 'tools/list'));
      const tools = resultOf(await child.reply(2))['tools'] as Json[];
      expect(tools.map((tool) => tool['name']).sort()).toEqual(['pto_get', 'pto_list']);
      for (const tool of tools) {
        expect(tool['annotations']).toMatchObject({ readOnlyHint: true });
        expect((tool['inputSchema'] as Json)['additionalProperties']).toBe(false);
      }
      child.end();
      expect(await child.exit).toEqual({ code: 0, signal: null });
      expectClean(child);
    },
    LONG,
  );

  it(
    'refuses a write call before any credential lookup or request when the switch is absent',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture);
      await handshake(child);
      child.send(call(2, 'pto_create', { mode: 'preview', ...createPlan() }));
      const reply = await child.reply(2);
      // The write surface is not routed at all, so the call is a protocol error.
      expect(reply['error']).toBeDefined();
      expect(reply['result']).toBeUndefined();
      // Nothing was looked up and nothing was sent.
      expect(fixture.seen).toHaveLength(0);
      child.end();
      expect(await child.exit).toEqual({ code: 0, signal: null });
      expectClean(child);
    },
    LONG,
  );

  it.each(['', '0', 'true', 'yes', '2', '1 ', '01'])(
    'keeps the write surface absent when the switch is %j',
    async (value) => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, value);
      await handshake(child);
      child.send(request(2, 'tools/list'));
      const tools = resultOf(await child.reply(2))['tools'] as Json[];
      expect(tools.map((tool) => tool['name']).sort()).toEqual(['pto_get', 'pto_list']);
      child.send(call(3, 'pto_delete', { mode: 'preview', id: FIRST, expectedVersion: 1 }));
      const reply = await child.reply(3);
      expect(reply['error']).toBeDefined();
      expect(reply['result']).toBeUndefined();
      expect(fixture.seen).toHaveLength(0);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'advertises the three write tools with truthful annotations when the switch is exact',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      child.send(request(2, 'tools/list'));
      const tools = resultOf(await child.reply(2))['tools'] as Json[];
      expect(tools.map((tool) => tool['name']).sort()).toEqual([
        'pto_create',
        'pto_delete',
        'pto_get',
        'pto_list',
        'pto_update',
      ]);
      for (const tool of tools) {
        const name = String(tool['name']);
        const annotations = (tool['annotations'] ?? {}) as Json;
        expect(typeof annotations['readOnlyHint']).toBe('boolean');
        expect(typeof annotations['destructiveHint']).toBe('boolean');
        expect((tool['inputSchema'] as Json)['additionalProperties']).toBe(false);
        expect((tool['outputSchema'] as Json)['type']).toBe('object');
        if (!name.startsWith('pto_') || name === 'pto_list' || name === 'pto_get') continue;
        // A write is never read-only, and only the additive create is not
        // destructive.
        expect(annotations['readOnlyHint']).toBe(false);
        expect(annotations['destructiveHint']).toBe(name !== 'pto_create');
        // No write promises a replay it has not proven.
        if (name !== 'pto_create') expect(annotations['idempotentHint']).not.toBe(true);
      }
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'accepts no credential, role, owner, endpoint or consent argument on a write',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      child.send(request(2, 'tools/list'));
      const tools = resultOf(await child.reply(2))['tools'] as Json[];
      for (const tool of tools) {
        const name = String(tool['name']);
        if (name !== 'pto_create' && name !== 'pto_update' && name !== 'pto_delete') continue;
        const properties = ((tool['inputSchema'] as Json)['properties'] ?? {}) as Json;
        for (const property of Object.keys(properties)) {
          const normalized = property.toLowerCase().replace(/[^a-z]/g, '');
          expect(FORBIDDEN_ARGUMENT_NAMES).not.toContain(normalized);
        }
      }
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );
});

describe('the preview of the compiled stdio server', () => {
  it(
    'previews a create with the live actor and the owner of the credential, and dispatches no mutation',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      child.send(call(2, 'pto_create', { mode: 'preview', ...createPlan(CREATE_NOTE) }));
      const message = await child.reply(2);
      expect(succeeded(message)).toBe(true);
      const data = dataOf(message);
      expect(data['actorId']).toBe(ACTOR);
      expect(data['ownerId']).toBe(ACTOR);
      expect(typeof data['previewId']).toBe('string');
      expect((data['previewId'] as string).length).toBeGreaterThan(0);
      // The preview shows the proposed range and the note intent, never the note.
      const text = lowered(data);
      expect(text).toContain(DAY);
      expect(text).toContain('all_day');
      expect(statesIntent(data, 'replace')).toBe(true);
      expect(leaks(JSON.stringify(message), [CREATE_NOTE])).toBe(false);
      // Nothing was written.
      expect(mutations(fixture)).toHaveLength(0);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'previews an update with the actor, the owner, the target, the version, the dates and the diff',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      // The change extends the stored range, so the merged range stays valid.
      child.send(
        call(2, 'pto_update', {
          mode: 'preview',
          id: FIRST,
          expectedVersion: 1,
          changes: { endDate: OTHER_DAY },
        }),
      );
      const message = await child.reply(2);
      expect(succeeded(message)).toBe(true);
      const data = dataOf(message);
      expect(data['actorId']).toBe(ACTOR);
      expect(data['ownerId']).toBe(ACTOR);
      expect(typeof data['previewId']).toBe('string');
      // The target and its version are part of the preview.
      expect(shown(data)).toContain(FIRST);
      expect(statesVersion(data, 1)).toBe(true);
      // The current range and the proposed range are both shown, and the
      // changed field is named. The diff names exactly the field that changed.
      const text = lowered(data);
      expect(text).toContain(DAY);
      expect(text).toContain(OTHER_DAY);
      expect(text).toContain('enddate');
      expect(data['changedFields']).toEqual(['endDate']);
      // The hidden note is never shown; only its intent is.
      expect(statesIntent(data, 'preserve')).toBe(true);
      expect(leaks(JSON.stringify(message), [HIDDEN_NOTE])).toBe(false);
      expect(mutations(fixture)).toHaveLength(0);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it.each(INVERTED_RANGES)(
    'refuses an update whose merged range is inverted by %s',
    async (_label, changes) => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      // One bound is supplied, so the merged range is only known against the
      // live entry. The complete effective dates are validated before a
      // preview is granted, so an inverted range never becomes a proposal.
      child.send(
        call(2, 'pto_update', {
          mode: 'preview',
          id: FIRST,
          expectedVersion: 1,
          changes,
        }),
      );
      const message = await child.reply(2);
      expect(succeeded(message)).toBe(false);
      expect(errorOf(message)['code']).toBe('INPUT');
      // No preview was granted, so no apply can follow and nothing was written.
      expect(mutations(fixture)).toHaveLength(0);
      expect(fixture.rows.get(FIRST)?.version).toBe(1);
      expect(fixture.rows.get(FIRST)?.endDate).toBe(DAY);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'previews a delete with the target and its version, and dispatches no mutation',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      child.send(call(2, 'pto_delete', { mode: 'preview', id: FIRST, expectedVersion: 1 }));
      const message = await child.reply(2);
      expect(succeeded(message)).toBe(true);
      const data = dataOf(message);
      expect(data['actorId']).toBe(ACTOR);
      expect(data['ownerId']).toBe(ACTOR);
      expect(typeof data['previewId']).toBe('string');
      expect(shown(data)).toContain(FIRST);
      expect(statesVersion(data, 1)).toBe(true);
      expect(leaks(JSON.stringify(message), [HIDDEN_NOTE])).toBe(false);
      expect(mutations(fixture)).toHaveLength(0);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'never sends the preview reference to the service',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      child.send(
        call(2, 'pto_update', {
          mode: 'preview',
          id: FIRST,
          expectedVersion: 1,
          changes: { dayPart: 'morning' },
        }),
      );
      const previewId = String(dataOf(await child.reply(2))['previewId']);
      child.send(
        call(3, 'pto_update', {
          mode: 'apply',
          id: FIRST,
          expectedVersion: 1,
          changes: { dayPart: 'morning' },
          previewId,
        }),
      );
      expect(succeeded(await child.reply(3))).toBe(true);
      // The reference binds the local intent; it is not a service parameter.
      expect(leaks(requestText(fixture), [previewId])).toBe(false);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );
});

describe('the apply of the compiled stdio server', () => {
  it(
    'applies a create with one request, the exact key and the derived owner',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      const plan = createPlan(CREATE_NOTE);
      child.send(call(2, 'pto_create', { mode: 'preview', ...plan }));
      const previewId = String(dataOf(await child.reply(2))['previewId']);
      child.send(call(3, 'pto_create', { mode: 'apply', ...plan, previewId }));
      const message = await child.reply(3);
      expect(succeeded(message)).toBe(true);
      const posted = mutations(fixture);
      expect(posted).toHaveLength(1);
      expect(posted[0]?.method).toBe('POST');
      expect(posted[0]?.path).toBe('/pto');
      expect(posted[0]?.idempotencyKey).toBe(plan['idempotencyKey']);
      const body = bodyOf(posted[0]?.body ?? '');
      expect(body['startDate']).toBe(DAY);
      expect(body['endDate']).toBe(DAY);
      expect(body['dayPart']).toBe('all_day');
      expect(body['note']).toBe(CREATE_NOTE);
      // The owner is derived from the credential, never from an argument.
      expect(body['userId']).toBeUndefined();
      expect(body['id']).toBeUndefined();
      // The answer names the record the service created.
      const created = fixture.created[0];
      expect(created).toBeDefined();
      if (created !== undefined) expect(shown(dataOf(message))).toContain(created.id);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'refuses an apply whose input no longer matches the preview, and writes nothing',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      const plan = createPlan();
      child.send(call(2, 'pto_create', { mode: 'preview', ...plan }));
      const previewId = String(dataOf(await child.reply(2))['previewId']);
      child.send(call(3, 'pto_create', { mode: 'apply', ...plan, dayPart: 'evening', previewId }));
      const message = await child.reply(3);
      expect(succeeded(message)).toBe(false);
      expect(mutations(fixture)).toHaveLength(0);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'refuses an apply with another key for the same preview, and writes nothing',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      const plan = createPlan();
      child.send(call(2, 'pto_create', { mode: 'preview', ...plan }));
      const previewId = String(dataOf(await child.reply(2))['previewId']);
      child.send(
        call(3, 'pto_create', {
          mode: 'apply',
          ...plan,
          idempotencyKey: createKey(),
          previewId,
        }),
      );
      const message = await child.reply(3);
      expect(succeeded(message)).toBe(false);
      expect(mutations(fixture)).toHaveLength(0);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'refuses an apply without a preview reference, and writes nothing',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      child.send(call(2, 'pto_create', { mode: 'apply', ...createPlan() }));
      const message = await child.reply(2);
      expect(succeeded(message)).toBe(false);
      expect(mutations(fixture)).toHaveLength(0);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'refuses a preview that carries a preview reference, before any request',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      child.send(
        call(2, 'pto_create', { mode: 'preview', ...createPlan(), previewId: 'anything-at-all' }),
      );
      const message = await child.reply(2);
      expect(succeeded(message)).toBe(false);
      expect(fixture.seen).toHaveLength(0);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'refuses an apply with an unknown preview reference, and writes nothing',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      child.send(
        call(2, 'pto_create', {
          mode: 'apply',
          ...createPlan(),
          previewId: '22222222-aaaa-4111-8111-999999999999',
        }),
      );
      const message = await child.reply(2);
      expect(succeeded(message)).toBe(false);
      expect(mutations(fixture)).toHaveLength(0);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'applies an update with the exact quoted version and only the named fields',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      const intent = { id: FIRST, expectedVersion: 1, changes: { dayPart: 'morning' } };
      child.send(call(2, 'pto_update', { mode: 'preview', ...intent }));
      const previewId = String(dataOf(await child.reply(2))['previewId']);
      child.send(call(3, 'pto_update', { mode: 'apply', ...intent, previewId }));
      const message = await child.reply(3);
      expect(succeeded(message)).toBe(true);
      const patched = mutations(fixture);
      expect(patched).toHaveLength(1);
      expect(patched[0]?.method).toBe('PATCH');
      expect(patched[0]?.path).toBe(`/pto/${FIRST}`);
      expect(patched[0]?.ifMatch).toBe('"1"');
      const body = bodyOf(patched[0]?.body ?? '');
      expect(body['dayPart']).toBe('morning');
      // An omitted note is not represented at all, so the hidden note survives.
      expect(Object.hasOwn(body, 'note')).toBe(false);
      expect(Object.hasOwn(body, 'startDate')).toBe(false);
      expect(Object.hasOwn(body, 'endDate')).toBe(false);
      // The hidden note is still hidden in the answer.
      expect(leaks(JSON.stringify(message), [HIDDEN_NOTE])).toBe(false);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'clears the note only when the caller asked for it, and never sends a note otherwise',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      const intent = { id: FIRST, expectedVersion: 1, changes: { note: '' } };
      child.send(call(2, 'pto_update', { mode: 'preview', ...intent }));
      const previewId = String(dataOf(await child.reply(2))['previewId']);
      child.send(call(3, 'pto_update', { mode: 'apply', ...intent, previewId }));
      const message = await child.reply(3);
      expect(succeeded(message)).toBe(true);
      const patched = mutations(fixture);
      expect(patched).toHaveLength(1);
      const body = bodyOf(patched[0]?.body ?? '');
      // The note is addressed on purpose: it is empty or null, never a text.
      expect(Object.hasOwn(body, 'note')).toBe(true);
      expect(body['note']).toBeOneOf([null, '']);
      // The preview of an explicit clear says so, without the note.
      expect(statesIntent(dataOf(message), 'clear')).toBe(true);
      expect(leaks(JSON.stringify(message), [HIDDEN_NOTE])).toBe(false);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'deletes with the exact quoted version and without a body',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      const intent = { id: FIRST, expectedVersion: 1 };
      child.send(call(2, 'pto_delete', { mode: 'preview', ...intent }));
      const previewId = String(dataOf(await child.reply(2))['previewId']);
      child.send(call(3, 'pto_delete', { mode: 'apply', ...intent, previewId }));
      const message = await child.reply(3);
      expect(succeeded(message)).toBe(true);
      const deleted = mutations(fixture);
      expect(deleted).toHaveLength(1);
      expect(deleted[0]?.method).toBe('DELETE');
      expect(deleted[0]?.path).toBe(`/pto/${FIRST}`);
      expect(deleted[0]?.ifMatch).toBe('"1"');
      expect(deleted[0]?.body).toBe('');
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );
});

describe('the strict schemas of the compiled stdio server', () => {
  it(
    'refuses an extra argument on every write',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      const extras: Array<[string, Json]> = [
        ['pto_create', { mode: 'preview', ...createPlan(), confirmed: true }],
        ['pto_create', { mode: 'preview', ...createPlan(), actAs: COLLEAGUE }],
        [
          'pto_update',
          {
            mode: 'preview',
            id: FIRST,
            expectedVersion: 1,
            changes: { dayPart: 'morning' },
            extra: 1,
          },
        ],
        ['pto_delete', { mode: 'preview', id: FIRST, expectedVersion: 1, role: 'admin' }],
      ];
      let id = 2;
      for (const [name, args] of extras) {
        child.send(call(id, name, args));
        const message = await child.reply(id);
        expect(succeeded(message)).toBe(false);
        expect(errorOf(message)['code']).toBe('INPUT');
        id += 1;
      }
      // A refused argument never becomes a write.
      expect(mutations(fixture)).toHaveLength(0);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'refuses a structurally invalid write before any request reaches the service',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      child.send(call(2, 'pto_create', { mode: 'preview', ...createPlan(), actAs: COLLEAGUE }));
      expect(succeeded(await child.reply(2))).toBe(false);
      // Neither the local store nor the service was consulted.
      expect(fixture.seen).toHaveLength(0);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'refuses a mode it does not know, and an unknown tool',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      child.send(call(2, 'pto_create', { mode: 'commit', ...createPlan() }));
      expect(succeeded(await child.reply(2))).toBe(false);
      // The mode is required, not defaulted.
      child.send(call(4, 'pto_create', createPlan()));
      expect(succeeded(await child.reply(4))).toBe(false);
      child.send(call(3, 'pto_write', { mode: 'preview' }));
      const unknown = await child.reply(3);
      expect(unknown['error']).toBeDefined();
      expect(unknown['result']).toBeUndefined();
      expect(mutations(fixture)).toHaveLength(0);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );
});

describe('the concurrency and recovery of the compiled stdio server', () => {
  it(
    'keeps the text fallback and the structured content of a write in parity',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      const plan = createPlan();
      child.send(call(2, 'pto_create', { mode: 'preview', ...plan }));
      const preview = await child.reply(2);
      expect(JSON.parse(textOf(preview))).toEqual(structuredOf(preview));
      const previewId = String(dataOf(preview)['previewId']);
      child.send(call(3, 'pto_create', { mode: 'apply', ...plan, previewId }));
      const applied = await child.reply(3);
      expect(JSON.parse(textOf(applied))).toEqual(structuredOf(applied));
      expect(structuredOf(applied)['schemaVersion']).toBe(1);
      expect(structuredOf(applied)['tool']).toBe('pto_create');
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'sends one request for a conflict and never retries it',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      const plan = createPlan();
      child.send(call(2, 'pto_create', { mode: 'preview', ...plan }));
      const previewId = String(dataOf(await child.reply(2))['previewId']);
      fixture.createOutcome = 'conflict';
      child.send(call(3, 'pto_create', { mode: 'apply', ...plan, previewId }));
      const message = await child.reply(3);
      expect(succeeded(message)).toBe(false);
      expect(errorOf(message)['status']).toBe(409);
      // One dispatch, no automatic retry, and no row.
      expect(mutations(fixture)).toHaveLength(1);
      expect(fixture.created).toHaveLength(0);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'sends one request for a rate limit, reports the wait and never retries it',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      const plan = createPlan();
      child.send(call(2, 'pto_create', { mode: 'preview', ...plan }));
      const previewId = String(dataOf(await child.reply(2))['previewId']);
      fixture.createOutcome = 'rate-limit';
      child.send(call(3, 'pto_create', { mode: 'apply', ...plan, previewId }));
      const message = await child.reply(3);
      expect(succeeded(message)).toBe(false);
      expect(errorOf(message)['status']).toBe(429);
      // The bounded wait the service asked for is reported, in milliseconds or
      // in seconds, and no write is repeated.
      const text = lowered(message);
      expect(text.includes('7000') || text.includes('7 second')).toBe(true);
      expect(mutations(fixture)).toHaveLength(1);
      expect(fixture.created).toHaveLength(0);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'reports an uncertain outcome after a lost answer and never resends it',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      const plan = createPlan();
      child.send(call(2, 'pto_create', { mode: 'preview', ...plan }));
      const previewId = String(dataOf(await child.reply(2))['previewId']);
      fixture.createOutcome = 'drop';
      child.send(call(3, 'pto_create', { mode: 'apply', ...plan, previewId }));
      const message = await child.reply(3);
      expect(succeeded(message)).toBe(false);
      // The answer may have been committed, so the tool says so instead of
      // claiming a plain failure.
      expect(lowered(message)).toMatch(/unknown|may exist|may have|reconcil/);
      // One dispatch only: the server never resends a write on its own.
      expect(mutations(fixture)).toHaveLength(1);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'replays the identical intent with the same key and never mints a second one',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      const plan = createPlan(CREATE_NOTE);
      child.send(call(2, 'pto_create', { mode: 'preview', ...plan }));
      const previewId = String(dataOf(await child.reply(2))['previewId']);
      fixture.createOutcome = 'drop';
      child.send(call(3, 'pto_create', { mode: 'apply', ...plan, previewId }));
      expect(succeeded(await child.reply(3))).toBe(false);
      // The row was committed even though the answer was lost.
      expect(fixture.created).toHaveLength(1);
      fixture.createOutcome = 'ok';
      child.send(call(4, 'pto_create', { mode: 'apply', ...plan, previewId }));
      const replay = await child.reply(4);
      expect(succeeded(replay)).toBe(true);
      const posted = mutations(fixture);
      expect(posted).toHaveLength(2);
      // The same credential, the same key and the same payload: one intent.
      expect(posted[0]?.idempotencyKey).toBe(plan['idempotencyKey']);
      expect(posted[1]?.idempotencyKey).toBe(plan['idempotencyKey']);
      expect(posted[0]?.body).toBe(posted[1]?.body);
      expect(fixture.replays.size).toBe(1);
      // One row, and one audit of that row.
      expect(fixture.created).toHaveLength(1);
      const created = fixture.created[0];
      expect(created).toBeDefined();
      if (created !== undefined) expect(shown(dataOf(replay))).toContain(created.id);
      // The answer says the service replayed the intent instead of writing again.
      expect(dataOf(replay)['replayed']).toBe(true);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'never substitutes another version when the target changed after the preview',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      const intent = { id: FIRST, expectedVersion: 1 };
      child.send(call(2, 'pto_delete', { mode: 'preview', ...intent }));
      const previewId = String(dataOf(await child.reply(2))['previewId']);
      // The record moves on after the preview was shown.
      const row = fixture.rows.get(FIRST);
      if (row !== undefined) row.version = 2;
      child.send(call(3, 'pto_delete', { mode: 'apply', ...intent, previewId }));
      const message = await child.reply(3);
      expect(succeeded(message)).toBe(false);
      const deleted = mutations(fixture);
      // At most one dispatch, and never with a version the caller did not name.
      expect(deleted.length).toBeLessThanOrEqual(1);
      for (const seen of deleted) {
        expect(seen.method).toBe('DELETE');
        expect(seen.ifMatch).toBe('"1"');
      }
      // The record survives the stale attempt.
      expect(fixture.rows.get(FIRST)?.version).toBe(2);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'requires reconciliation when a restarted process receives no usable preview after a lost create answer',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const first = startServer(fixture, '1');
      await handshake(first);
      const plan = createPlan();
      first.send(call(2, 'pto_create', { ...plan, mode: 'preview' }));
      const staged = await first.reply(2);
      expect(succeeded(staged)).toBe(true);
      const previewId = dataOf(staged)['previewId'];
      fixture.createOutcome = 'drop';
      first.send(call(3, 'pto_create', { ...plan, mode: 'apply', previewId }));
      const lost = await first.reply(3);
      expect(errorOf(lost)).toMatchObject({ code: 'UNKNOWN_OUTCOME', recovery: 'reconcile' });
      expect(mutations(fixture)).toHaveLength(1);
      expect(fixture.created).toHaveLength(1);
      first.end();
      expect(await first.exit).toEqual({ code: 0, signal: null });
      expectClean(first);

      const restarted = startServer(fixture, '1');
      await handshake(restarted);
      const requestCount = fixture.seen.length;
      fixture.createOutcome = 'ok';
      restarted.send(call(2, 'pto_create', { ...plan, mode: 'apply' }));
      restarted.send(call(3, 'pto_create', { ...plan, mode: 'apply', previewId: PROBE }));
      for (const id of [2, 3]) {
        const refused = await restarted.reply(id);
        expect(succeeded(refused)).toBe(false);
        expect(errorOf(refused)).toMatchObject({ code: 'INPUT', recovery: 'reconcile' });
        expect(errorOf(refused)['message']).toContain('This call sent no mutation');
        expect(errorOf(refused)['message']).toContain('an earlier attempt may have committed');
        expect(errorOf(refused)['message']).toContain('before preparing a new preview');
        expect(errorOf(refused)['message']).toContain('with a new key or changed credential');
        expect(leaks(JSON.stringify(refused), [PROBE, String(plan['idempotencyKey'])])).toBe(false);
      }
      expect(fixture.seen).toHaveLength(requestCount);
      expect(mutations(fixture)).toHaveLength(1);
      expect(fixture.created).toHaveLength(1);
      restarted.end();
      expect(await restarted.exit).toEqual({ code: 0, signal: null });
      expectClean(restarted);
    },
    LONG,
  );
});

describe('the live authority of the compiled stdio server', () => {
  it(
    'refuses a write when the live token holds no write scope',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      fixture.scopes = ['pto:read'];
      const child = startServer(fixture, '1');
      await handshake(child);
      child.send(call(2, 'pto_create', { mode: 'preview', ...createPlan() }));
      const message = await child.reply(2);
      expect(succeeded(message)).toBe(false);
      // The service stays authoritative: nothing was written.
      expect(mutations(fixture)).toHaveLength(0);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    "refuses a write to another owner's record with a member token",
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const row = fixture.rows.get(FIRST);
      if (row !== undefined) row.userId = COLLEAGUE;
      fixture.role = 'member';
      fixture.scopes = [...WRITE_SCOPES];
      const child = startServer(fixture, '1');
      await handshake(child);
      child.send(
        call(2, 'pto_update', {
          mode: 'preview',
          id: FIRST,
          expectedVersion: 1,
          changes: { dayPart: 'morning' },
        }),
      );
      const message = await child.reply(2);
      expect(succeeded(message)).toBe(false);
      expect(mutations(fixture)).toHaveLength(0);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'refuses the apply when the live role changed after the preview',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const row = fixture.rows.get(FIRST);
      if (row !== undefined) row.userId = COLLEAGUE;
      fixture.role = 'team_lead';
      fixture.scopes = [...TEAM_SCOPES];
      const child = startServer(fixture, '1');
      await handshake(child);
      const intent = { id: FIRST, expectedVersion: 1, changes: { dayPart: 'morning' } };
      child.send(call(2, 'pto_update', { mode: 'preview', ...intent }));
      const preview = await child.reply(2);
      expect(succeeded(preview)).toBe(true);
      expect(dataOf(preview)['ownerId']).toBe(COLLEAGUE);
      // The live role is downgraded before the apply reaches the service.
      fixture.role = 'member';
      child.send(
        call(3, 'pto_update', {
          mode: 'apply',
          ...intent,
          previewId: dataOf(preview)['previewId'],
        }),
      );
      const message = await child.reply(3);
      expect(succeeded(message)).toBe(false);
      expect(mutations(fixture)).toHaveLength(0);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'refuses the apply when the credential was revoked after the preview',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      const plan = createPlan();
      child.send(call(2, 'pto_create', { mode: 'preview', ...plan }));
      const preview = await child.reply(2);
      expect(succeeded(preview)).toBe(true);
      // The token is revoked while the preview waits for its approval.
      fixture.revoked = true;
      child.send(
        call(3, 'pto_create', { mode: 'apply', ...plan, previewId: dataOf(preview)['previewId'] }),
      );
      const message = await child.reply(3);
      expect(succeeded(message)).toBe(false);
      expect(mutations(fixture)).toHaveLength(0);
      expect(fixture.created).toHaveLength(0);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );
});

describe('the cancellation of the compiled stdio server', () => {
  it(
    'cancels a write before any dispatch and leaves the entry untouched',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      const intent = { id: FIRST, expectedVersion: 1, changes: { dayPart: 'morning' } };
      child.send(call(2, 'pto_update', { mode: 'preview', ...intent }));
      const previewId = String(dataOf(await child.reply(2))['previewId']);
      // The live read of the target is held open, so the call is in flight and
      // provably before any mutation is dispatched.
      fixture.hold = 'detail';
      child.send(call(3, 'pto_update', { mode: 'apply', ...intent, previewId }));
      await until(() => fixture.held.length === 1, 'the held live read');
      // The host cancels the call while the live read is still open.
      cancel(child, 3);
      // The cancellation reached the service: the held read was abandoned.
      // The child settles the call in the same turn as the abort, so this
      // observation is also the point where the call is over.
      await until(() => fixture.held[0]?.record.clientGone === true, 'the abandoned read');
      // The server keeps serving after the cancellation.
      child.send(request(4, 'ping'));
      expect(await child.reply(4)).toEqual({ jsonrpc: '2.0', id: 4, result: {} });
      // The cancelled call is answered with nothing at all.
      expect(child.messages().some((message) => message['id'] === 3)).toBe(false);
      // Nothing was dispatched, and the entry is exactly as it was.
      expect(mutations(fixture)).toHaveLength(0);
      expect(fixture.rows.get(FIRST)?.version).toBe(1);
      expect(fixture.rows.get(FIRST)?.dayPart).toBe('all_day');
      // The held read is released and the process stops cleanly.
      fixture.hold = 'none';
      fixture.release();
      child.end();
      expect(await child.exit).toEqual({ code: 0, signal: null });
      expectClean(child);
    },
    LONG,
  );

  it(
    'cancels a write after the row was committed, claims no outcome and never resends it',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      const plan = createPlan();
      child.send(call(2, 'pto_create', { mode: 'preview', ...plan }));
      const previewId = String(dataOf(await child.reply(2))['previewId']);
      // The service commits the row and holds the answer, so the write is
      // committed while the caller is still waiting.
      fixture.hold = 'create';
      child.send(call(3, 'pto_create', { mode: 'apply', ...plan, previewId }));
      await until(() => fixture.held.length === 1, 'the held answer');
      // The row is committed even though the answer never arrives.
      expect(fixture.created).toHaveLength(1);
      // The host cancels the call while the answer is still held.
      cancel(child, 3);
      await until(() => fixture.held[0]?.record.clientGone === true, 'the abandoned answer');
      // The server keeps serving after the cancellation.
      child.send(request(4, 'ping'));
      expect(await child.reply(4)).toEqual({ jsonrpc: '2.0', id: 4, result: {} });
      // No result is claimed for the cancelled call, and the row is not named.
      expect(child.messages().some((message) => message['id'] === 3)).toBe(false);
      const created = fixture.created[0];
      expect(created).toBeDefined();
      if (created !== undefined) expect(child.lines.join('\n')).not.toContain(created.id);
      // The write was dispatched once and was never resent by the server.
      expect(mutations(fixture)).toHaveLength(1);
      expect(fixture.created).toHaveLength(1);
      // The safe recovery: the same intent, the same key and the same
      // credential replay the one row instead of writing a second one.
      fixture.hold = 'none';
      fixture.release();
      child.send(call(5, 'pto_create', { mode: 'apply', ...plan, previewId }));
      const replay = await child.reply(5);
      expect(succeeded(replay)).toBe(true);
      expect(dataOf(replay)['replayed']).toBe(true);
      const posted = mutations(fixture);
      expect(posted).toHaveLength(2);
      expect(posted[0]?.idempotencyKey).toBe(plan['idempotencyKey']);
      expect(posted[1]?.idempotencyKey).toBe(plan['idempotencyKey']);
      expect(posted[0]?.body).toBe(posted[1]?.body);
      expect(fixture.created).toHaveLength(1);
      child.end();
      expect(await child.exit).toEqual({ code: 0, signal: null });
      expectClean(child);
    },
    LONG,
  );
});

describe('the confidentiality of the compiled stdio server', () => {
  it(
    'does not reflect an upstream correlation header into a write result',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      // The service answers with a hostile correlation value. The service is
      // free to send it; the adapter is not free to reflect it.
      fixture.correlation = CORRELATION_SENTINEL;
      const child = startServer(fixture, '1');
      await handshake(child);
      const plan = createPlan();
      child.send(call(2, 'pto_create', { mode: 'preview', ...plan }));
      const previewId = String(dataOf(await child.reply(2))['previewId']);
      fixture.createOutcome = 'conflict';
      child.send(call(3, 'pto_create', { mode: 'apply', ...plan, previewId }));
      const message = await child.reply(3);
      expect(succeeded(message)).toBe(false);
      expect(errorOf(message)['status']).toBe(409);
      // The write result carries no upstream correlation at all.
      expect(errorOf(message)['upstreamRequestId']).toBeNull();
      expect(leaks(JSON.stringify(message), [CORRELATION_SENTINEL])).toBe(false);
      // The read surface keeps its own safe correlation: the baseline is
      // unchanged by the write surface.
      child.send(call(4, 'pto_get', { id: '99999999-aaaa-4111-8111-999999999999' }));
      const read = await child.reply(4);
      expect(succeeded(read)).toBe(false);
      expect(errorOf(read)['upstreamRequestId']).toBe(CORRELATION_SENTINEL);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );

  it(
    'never echoes the credential, the create key or a note into either stream',
    async () => {
      await prepareSandbox();
      const fixture = await startFixture();
      const child = startServer(fixture, '1');
      await handshake(child);
      const plan = createPlan(CREATE_NOTE);
      child.send(call(2, 'pto_create', { mode: 'preview', ...plan }));
      const previewId = String(dataOf(await child.reply(2))['previewId']);
      child.send(call(3, 'pto_create', { mode: 'apply', ...plan, previewId }));
      await child.reply(3);
      child.send(
        call(4, 'pto_update', {
          mode: 'preview',
          id: FIRST,
          expectedVersion: 1,
          changes: { note: PROBE },
        }),
      );
      await child.reply(4);
      const text = child.lines.join('\n') + child.stderr;
      // The answer is a boolean: a failure never prints what it found.
      expect(leaks(text, [TOKEN, SECRET, String(plan['idempotencyKey'])])).toBe(false);
      expect(leaks(text, [CREATE_NOTE, HIDDEN_NOTE, PROBE])).toBe(false);
      // The probe never reached the service either: it is only a caller value.
      expect(leaks(requestText(fixture), [PROBE])).toBe(false);
      child.end();
      await child.exit;
      expectClean(child);
    },
    LONG,
  );
});
