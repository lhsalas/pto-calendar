import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const BIN = fileURLToPath(new URL('../bin/pto.mjs', import.meta.url));
const TOKEN_SECRET = '8'.repeat(64);
const TOKEN = `pto_pat_11111111-1111-4111-8111-111111111111.${TOKEN_SECRET}`;
const DIGEST = createHash('sha256').update(TOKEN_SECRET, 'utf8').digest('hex');
const OWNER = '11111111-aaaa-4111-8111-000000000001';
const TOKEN_ID = '11111111-aaaa-4111-8111-000000000009';
const FIRST = '11111111-aaaa-4111-8111-000000000002';
const SECOND = '11111111-aaaa-4111-8111-000000000003';
const DATES = ['--from', '2026-12-07', '--to', '2026-12-08'];

interface RequestView {
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly headers: IncomingHttpHeaders;
}
interface RunOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
}
interface RunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

let home: string;
let cwd: string;
const closeFixtures: Array<() => Promise<void>> = [];

beforeEach(async () => {
  home = await mkdtemp(join(await realpath(tmpdir()), 'pto-cli-'));
  cwd = join(home, 'unrelated-cwd');
  await mkdir(cwd, { mode: 0o700 });
});

afterEach(async () => {
  await Promise.all(closeFixtures.splice(0).map((close) => close()));
  await rm(home, { recursive: true, force: true });
});

function start(args: readonly string[], options: RunOptions = {}) {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd,
    env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.stdin.on('error', () => undefined);
  const done = new Promise<RunResult>((resolve, reject) => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 8_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
  child.stdin.end(options.input);
  return { child, done };
}

function run(args: readonly string[], options?: RunOptions): Promise<RunResult> {
  return start(args, options).done;
}

function asMachine(result: RunResult, code: number): unknown {
  expect(result.code).toBe(code);
  expect(result.signal).toBeNull();
  expect(result.stdout.split('\n')).toHaveLength(2);
  expect(result.stdout.endsWith('\n')).toBe(true);
  noLeak(result);
  return JSON.parse(result.stdout) as unknown;
}

function noLeak(result: RunResult): void {
  const text = result.stdout + result.stderr;
  // Test the boolean only; never send potentially sensitive bytes to an assertion printer.
  expect([TOKEN, TOKEN_SECRET, DIGEST].some((value) => text.includes(value))).toBe(false);
}

function respond(res: ServerResponse, code: number, value: unknown, headers = {}): void {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'X-Request-Id': 'mock-request',
    ...headers,
  });
  res.end(JSON.stringify(value));
}

async function fixture(reply: (req: RequestView, res: ServerResponse) => void) {
  const calls: RequestView[] = [];
  const listener = createServer((request, response) => {
    const view = { method: request.method, path: request.url, headers: request.headers };
    calls.push(view);
    reply(view, response);
  });
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = (listener.address() as AddressInfo).port;
  closeFixtures.push(
    () =>
      new Promise((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
        listener.closeAllConnections();
      }),
  );
  return { origin: `http://127.0.0.1:${port}`, calls };
}

const identity = {
  id: OWNER,
  role: 'member',
  auth: {
    method: 'pat',
    tokenId: TOKEN_ID,
    scopes: ['pto:read'],
    expiresAt: '2027-01-01T00:00:00.000Z',
  },
};

function row(id = FIRST, day = '2026-12-07', note: string | null = null, name = 'Fixture Member') {
  return {
    id,
    user: { id: OWNER, name, colorCode: '#005588' },
    startDate: day,
    endDate: day,
    dayPart: 'morning',
    version: 1,
    note,
  };
}

function credentials(origin: string): NodeJS.ProcessEnv {
  return { PTO_API_ORIGIN: origin, PTO_API_TOKEN: TOKEN };
}

function expectBearerOnly(calls: readonly RequestView[]): void {
  expect(calls.length).toBeGreaterThan(0);
  expect(
    calls.every(
      ({ method, headers }) =>
        method === 'GET' && headers.authorization === `Bearer ${TOKEN}` && !headers.cookie,
    ),
  ).toBe(true);
}

describe('compiled pto command process', () => {
  it('runs help, version and a secret-shaped misuse with no credential or dotenv lookup', async () => {
    await writeFile(join(cwd, '.env'), 'PTO_API_ORIGIN=https://untrusted.example.invalid\n', {
      mode: 0o600,
    });
    const env = { PTO_API_TOKEN: TOKEN };
    const help = await run(['--help'], { env });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('pto');
    expect(help.stderr).toBe('');
    noLeak(help);
    expect(asMachine(await run(['--version', '--json'], { env }), 0)).toMatchObject({
      ok: true,
      command: 'version',
      data: { version: '0.1.0' },
    });
    const invalid = await run(['auth', 'set', `--token=${TOKEN}`, '--json'], { env });
    expect(asMachine(invalid, 2)).toMatchObject({ ok: false, error: { code: 'USAGE' } });
    const lookup = await run(['get', FIRST, '--json']);
    expect(asMachine(lookup, 3)).toMatchObject({ ok: false, error: { code: 'AUTH' } });
  });

  it('uses a private local profile across processes and removes it without revoking', async () => {
    const service = await fixture((req, res) => {
      respond(res, 200, req.path === '/auth/me' ? identity : row());
    });
    const set = [
      'auth',
      'set',
      '--profile',
      'work',
      '--origin',
      service.origin,
      '--storage',
      'file',
      '--allow-loopback-http',
      '--token-stdin',
      '--json',
    ];
    expect(asMachine(await run(set, { input: `${TOKEN}\n` }), 0)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: 'auth-set',
      data: { profile: 'work', origin: service.origin, source: 'file' },
    });
    expect(service.calls).toHaveLength(0);
    const dir = join(home, '.config', 'pto-calendar', 'agent-auth');
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'work.json'))).mode & 0o777).toBe(0o600);

    const status = await run(['auth', 'status', '--profile', 'work', '--json']);
    expect(asMachine(status, 0)).toEqual({
      schemaVersion: 1,
      ok: true,
      command: 'auth-status',
      data: {
        profile: 'work',
        origin: service.origin,
        source: 'file',
        ownerId: OWNER,
        scopes: ['pto:read'],
        expiresAt: identity.auth.expiresAt,
      },
    });
    expect(status.stdout.includes(TOKEN_ID)).toBe(false);
    expect(status.stderr).toBe('');
    expect(
      asMachine(
        await run(['get', FIRST, '--profile', 'work', '--origin', service.origin, '--json']),
        0,
      ),
    ).toMatchObject({
      ok: true,
      command: 'get',
      data: { id: FIRST, note: null },
    });
    expectBearerOnly(service.calls);
    expect(service.calls).toHaveLength(2);

    const removal = await run(['auth', 'remove', '--profile', 'work', '--json']);
    expect(asMachine(removal, 0)).toMatchObject({
      ok: true,
      command: 'auth-remove',
      data: { profile: 'work', removed: true },
    });
    expect(removal.stdout.toLowerCase()).toContain('does not revoke');
    expect(asMachine(await run(['get', FIRST, '--profile', 'work', '--json']), 3)).toMatchObject({
      ok: false,
      error: { code: 'AUTH' },
    });
    expect(service.calls).toHaveLength(2);
  });

  it('refuses stdin extra lines, and never quietly reads a non-TTY without the stdin flag', async () => {
    const args = [
      'auth',
      'set',
      '--origin',
      'https://pto.example.invalid',
      '--storage',
      'file',
      '--json',
    ];
    const piped = await run(args, { input: `${TOKEN}\n` });
    expect(piped.code).not.toBe(0);
    noLeak(piped);
    const extra = await run([...args, '--token-stdin'], { input: `${TOKEN}\nnext\n` });
    expect(extra.code).not.toBe(0);
    noLeak(extra);
    expect(asMachine(await run(['auth', 'status', '--json']), 3)).toMatchObject({
      ok: false,
      error: { code: 'AUTH' },
    });
  });

  it('uses identity for --mine and follows paginated read-only filters', async () => {
    const service = await fixture((req, res) => {
      if (req.path === '/auth/me') {
        respond(res, 200, identity);
      } else if (req.path?.includes('cursor=second')) {
        respond(res, 200, { items: [row(SECOND, '2026-12-08')], nextCursor: null, hasMore: false });
      } else {
        respond(res, 200, { items: [row()], nextCursor: 'second', hasMore: true });
      }
    });
    const args = [
      'list',
      ...DATES,
      '--mine',
      '--page-size',
      '1',
      '--allow-loopback-http',
      '--json',
    ];
    const runOptions = { env: credentials(service.origin) };
    expect(asMachine(await run(args, runOptions), 0)).toMatchObject({
      ok: true,
      command: 'list',
      data: {
        items: [{ id: FIRST }, { id: SECOND }],
        complete: true,
        pages: 2,
        reason: 'complete',
      },
    });
    expect(service.calls[0]?.path).toBe('/auth/me');
    expectBearerOnly(service.calls);
    expect(service.calls).toHaveLength(3);
    for (const req of service.calls.slice(1)) {
      const query = new URL(req.path!, service.origin).searchParams;
      expect(query.get('userId')).toBe(OWNER);
      expect(query.get('start')).toBe(DATES[1]);
      expect(query.get('end')).toBe(DATES[3]);
      expect(query.get('format')).toBe('page');
      expect(query.get('limit')).toBe('1');
    }
    expect(asMachine(await run([...args, '--max-pages', '1'], runOptions), 9)).toMatchObject({
      ok: false,
      error: { code: 'INCOMPLETE' },
      partial: { items: [{ id: FIRST }], complete: false, pages: 1, reason: 'budget' },
    });
  });

  it.each([
    [401, 'UNAUTHENTICATED', 3, 'AUTH'],
    [403, 'FORBIDDEN', 4, 'PERMISSION'],
    [404, 'NOT_FOUND', 5, 'NOT_FOUND'],
    [409, 'CONFLICT', 6, 'CONFLICT'],
    [429, 'RATE_LIMITED', 7, 'QUOTA'],
  ] as const)('maps HTTP %s without echoing response text', async (status, code, exit, cliCode) => {
    const source = await fixture((_req, res) => {
      respond(res, status, { error: { code, message: TOKEN } }, { 'Retry-After': '61' });
    });
    const result = await run(['get', FIRST, '--allow-loopback-http', '--json'], {
      env: credentials(source.origin),
    });
    expect(asMachine(result, exit)).toMatchObject({
      ok: false,
      error: { code: cliCode, requestId: 'mock-request', status },
    });
    expect(source.calls).toHaveLength(1);
    if (status === 429) {
      expect(JSON.parse(result.stdout)).toMatchObject({ error: { retryAfterMs: 61_000 } });
    }
  });

  it('never follows a different origin or rewrites a bound credential', async () => {
    const target = await fixture((_req, res) => respond(res, 200, row()));
    const source = await fixture((_req, res) => {
      respond(res, 302, {}, { Location: `${target.origin}/pto/${FIRST}` });
    });
    const args = ['get', FIRST, '--allow-loopback-http', '--json'];
    const options = { env: credentials(source.origin) };
    const mismatch = await run([...args, '--origin', target.origin], options);
    expect(mismatch.code).not.toBe(0);
    noLeak(mismatch);
    expect(source.calls).toHaveLength(0);
    expect(asMachine(await run(args, options), 8)).toMatchObject({
      ok: false,
      error: { code: 'NETWORK' },
    });
    expect(source.calls).toHaveLength(1);
    expect(target.calls).toHaveLength(0);
  });

  it('preserves an auth failure from the first page instead of claiming records are absent', async () => {
    const service = await fixture((_req, res) =>
      respond(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'Do not reflect.' } }),
    );
    const output = await run(['list', ...DATES, '--allow-loopback-http', '--json'], {
      env: credentials(service.origin),
    });
    expect(asMachine(output, 3)).toMatchObject({
      command: 'list',
      ok: false,
      error: { code: 'AUTH', status: 401 },
      partial: { complete: false, items: [], pages: 0 },
    });
    expectBearerOnly(service.calls);
    expect(service.calls).toHaveLength(1);
  });

  it('keeps authorized detail data without reflecting tokens, digests or terminal control bytes', async () => {
    const service = await fixture((_req, res) => {
      respond(
        res,
        200,
        row(FIRST, '2026-12-07', `A permitted note. ${TOKEN} ${DIGEST}`, '\u001b[31mSynthetic'),
      );
    });
    const args = ['get', FIRST, '--allow-loopback-http'];
    const options = { env: credentials(service.origin) };
    for (const flags of [[], ['--json']]) {
      const result = await run([...args, ...flags], options);
      expect(result.code).toBe(0);
      noLeak(result);
      expect(result.stdout).toContain('A permitted note.');
      expect(result.stdout.includes('\u001b') || result.stdout.includes('\\u001b')).toBe(false);
    }
  });

  it('cancels a pending HTTP read on SIGINT, without prompting or emitting a stack', async () => {
    let markRequest!: () => void;
    const request = new Promise<void>((resolve) => {
      markRequest = resolve;
    });
    const service = await fixture(markRequest);
    const { child, done } = start(['get', FIRST, '--allow-loopback-http', '--json'], {
      env: credentials(service.origin),
    });
    const first = await Promise.race([done.then(() => 'exited'), request.then(() => 'request')]);
    expect(first).toBe('request');
    expect(child.kill('SIGINT')).toBe(true);
    expect(asMachine(await done, 130)).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expectBearerOnly(service.calls);
  });
});
