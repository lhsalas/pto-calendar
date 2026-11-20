import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const BIN = fileURLToPath(new URL('../bin/pto.mjs', import.meta.url));
const PTY = fileURLToPath(new URL('./fixtures/write-pty.py', import.meta.url));
const OWNER = '11111111-aaaa-4111-8111-000000000001';
const PEER = '11111111-aaaa-4111-8111-000000000002';
const RECORD = '11111111-aaaa-4111-8111-000000000003';
const TOKEN_ID = '11111111-aaaa-4111-8111-000000000009';
const SECRET = '8'.repeat(64);
const PAT = `pto_pat_${TOKEN_ID}.${SECRET}`;
const DAY = '2026-12-07';
const NOTE = 'untrusted and private server fields';
const PATCH = ['update', RECORD, '--version', '1', '--day-part', 'evening'];
const DELETE = ['delete', RECORD, '--version', '1'];
const CREATE = ['create', '--from', DAY, '--to', DAY, '--day-part', 'morning'];
const SCOPES = ['pto:read', 'pto:update:self', 'pto:delete:self', 'pto:create'];
const HTTP = ['--allow-loopback-http', '--json'];

interface ChildOutput {
  readonly exit: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface ServiceOptions {
  readonly owner?: string;
  readonly scopes?: readonly string[];
  readonly refuseMutation?: boolean;
}

let home: string;
const listeners: Array<ReturnType<typeof createServer>> = [];

beforeEach(async () => {
  home = await mkdtemp(join(await realpath(tmpdir()), 'pto-cli-write-'));
});

afterEach(async () => {
  await Promise.all(
    listeners.splice(0).map(
      (listener) =>
        new Promise<void>((resolve, reject) => {
          listener.close((error) => (error ? reject(error) : resolve()));
          listener.closeAllConnections();
        }),
    ),
  );
  await rm(home, { recursive: true, force: true });
});

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Request-Id': 'fixture-rid' });
  res.end(JSON.stringify(data));
}

async function service(options: ServiceOptions = {}) {
  const requests: {
    method: string | undefined;
    url: string | undefined;
    conditional: string | undefined;
    patOnly: boolean;
    body: unknown;
  }[] = [];
  const owner = options.owner ?? OWNER;
  const listener = createServer((req, res) => {
    const body: Buffer[] = [];
    req.on('data', (chunk: Buffer) => body.push(chunk));
    req.on('end', () => {
      const data: unknown = body.length === 0 ? null : JSON.parse(Buffer.concat(body).toString());
      requests.push({
        method: req.method,
        url: req.url,
        conditional: req.headers['if-match'],
        patOnly: req.headers.authorization === `Bearer ${PAT}` && req.headers.cookie === undefined,
        body: data,
      });
      if (req.method === 'GET' && req.url === '/auth/me') {
        return send(res, 200, {
          id: OWNER,
          role: 'team_lead',
          auth: {
            method: 'pat',
            tokenId: TOKEN_ID,
            scopes: options.scopes ?? SCOPES,
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        });
      }
      if (req.url !== `/pto/${RECORD}`) {
        return send(res, 404, { error: { code: 'NOT_FOUND', message: NOTE } });
      }
      const base = { id: RECORD, startDate: DAY, endDate: DAY };
      if (req.method === 'GET') {
        return send(res, 200, {
          ...base,
          user: { id: owner, name: NOTE, colorCode: '#333333' },
          dayPart: 'morning',
          note: null,
          version: 1,
        });
      }
      if (options.refuseMutation) {
        return send(res, 403, { error: { code: 'FORBIDDEN', message: NOTE } });
      }
      if (req.method === 'PATCH') {
        return send(res, 200, {
          ...base,
          userId: owner,
          dayPart: 'evening',
          note: NOTE,
          version: 2,
          updatedAt: `${DAY}T00:00:00.000Z`,
          createdAt: `${DAY}T00:00:00.000Z`,
        });
      }
      res.writeHead(204).end();
    });
  });
  listeners.push(listener);
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, requests };
}

function collect(command: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  return new Promise<ChildOutput>((resolve, reject) => {
    const child = spawn(command, args, { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 13_000);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Compiled process could not start.'));
    });
    child.once('close', (exit) => {
      clearTimeout(timer);
      resolve({
        exit,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      });
    });
  });
}

function environment(origin: string, enabled = true): NodeJS.ProcessEnv {
  return {
    HOME: home,
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    PTO_API_ORIGIN: origin,
    PTO_API_TOKEN: PAT,
    ...(enabled ? { PTO_CLI_WRITES: '1' } : {}),
  };
}

function run(args: readonly string[], origin: string, enabled = true) {
  return collect(process.execPath, [BIN, ...args, ...HTTP], environment(origin, enabled));
}

async function tty(args: readonly string[], origin: string, decision: 'yes' | 'no' | 'interrupt') {
  const harness = await collect(
    '/usr/bin/python3',
    ['-I', '-B', PTY, decision, process.execPath, BIN, ...args, ...HTTP],
    environment(origin),
  );
  expect(harness.exit).toBe(0);
  expect(harness.stderr).toBe('');
  return JSON.parse(harness.stdout) as ChildOutput;
}

interface PipedOutput extends ChildOutput {
  /** What the disposable terminal received. The CLI must write nothing to it. */
  readonly terminal: string;
}

/**
 * The CLI with a disposable terminal as stdin and a pipe as its diagnostic stream.
 *
 * The harness types nothing, so a prompt could never be answered: a write that
 * still asks a question can only fail here. The write flags are the same ones
 * a real host would use, so a refusal cannot be an accident of the arguments.
 */
async function terminalWithPipe(args: readonly string[], origin: string): Promise<PipedOutput> {
  const harness = await collect(
    '/usr/bin/python3',
    ['-I', '-B', PTY, 'pipe', process.execPath, BIN, ...args, ...HTTP],
    environment(origin),
  );
  expect(harness.exit).toBe(0);
  expect(harness.stderr).toBe('');
  return JSON.parse(harness.stdout) as PipedOutput;
}

function json(output: ChildOutput, exit: number): unknown {
  expect(output.exit).toBe(exit);
  expect(output.stdout.split('\n')).toHaveLength(2);
  expect([PAT, SECRET, NOTE].some((value) => (output.stdout + output.stderr).includes(value))).toBe(
    false,
  );
  return JSON.parse(output.stdout) as unknown;
}

describe('compiled write command process', () => {
  it.each([
    { enabled: false, args: [...PATCH, '--yes'], exit: 4 },
    { enabled: true, args: PATCH, exit: 2 },
  ])('fails without both write enablement and non-TTY approval ($exit)', async (sample) => {
    const fixture = await service();
    const result = await run(sample.args, fixture.origin, sample.enabled);
    expect(json(result, sample.exit)).toMatchObject({ ok: false, command: 'update' });
    expect(fixture.requests).toEqual([]);
    expect(result.stderr).not.toContain('Type yes');
  });

  it('sends only changed fields and omits a note that is not being changed', async () => {
    const fixture = await service();
    const result = await run([...PATCH, '--yes'], fixture.origin);
    expect(json(result, 0)).toMatchObject({
      ok: true,
      command: 'update',
      data: { record: { id: RECORD, ownerId: OWNER, version: 2, dayPart: 'evening' } },
    });
    expect(fixture.requests.filter(({ method }) => method !== 'GET')).toEqual([
      {
        method: 'PATCH',
        url: `/pto/${RECORD}`,
        conditional: '"1"',
        patOnly: true,
        body: { dayPart: 'evening' },
      },
    ]);
  });

  it('only sends the note null when clearing explicitly', async () => {
    const fixture = await service();
    const result = await run(
      ['update', RECORD, '--version', '1', '--clear-note', '--yes'],
      fixture.origin,
    );
    expect(json(result, 0)).toMatchObject({ ok: true });
    expect(fixture.requests.find(({ method }) => method === 'PATCH')?.body).toEqual({ note: null });
  });

  it('reports the authoritative 403 without reflecting its body', async () => {
    const fixture = await service({ refuseMutation: true });
    expect(json(await run([...DELETE, '--yes'], fixture.origin), 4)).toMatchObject({
      ok: false,
      error: { code: 'PERMISSION', status: 403 },
    });
    expect(fixture.requests.filter(({ method }) => method === 'DELETE')).toHaveLength(1);
  });

  it.each([{ owner: PEER }, { scopes: ['pto:read'] }])(
    'keeps self scopes and lead role separate',
    async (options) => {
      const fixture = await service(options);
      expect(json(await run([...DELETE, '--yes'], fixture.origin), 4)).toMatchObject({ ok: false });
      expect(fixture.requests.every(({ method }) => method === 'GET')).toBe(true);
    },
  );

  it('refuses a fuzzy or wildcard deletion before any API request', async () => {
    const fixture = await service();
    expect(
      json(await run(['delete', '*', '--version', '1', '--yes'], fixture.origin), 2),
    ).toMatchObject({
      ok: false,
      error: { code: 'USAGE' },
    });
    expect(fixture.requests).toEqual([]);
  });

  it.each(['yes', 'no', 'interrupt'] as const)(
    'previews the exact target and honors interactive %s even with --yes',
    async (answer) => {
      const fixture = await service();
      const result = await tty([...DELETE, '--yes'], fixture.origin, answer);
      expect(json(result, answer === 'yes' ? 0 : 130)).toMatchObject({
        command: 'delete',
        ok: answer === 'yes',
      });
      expect(result.stderr).toContain(OWNER);
      expect(result.stderr).toContain(RECORD);
      expect(result.stderr).toContain(DAY);
      expect(result.stderr).toContain('morning');
      expect(
        fixture.requests.some(({ method, url }) => method === 'GET' && url === `/pto/${RECORD}`),
      ).toBe(true);
      expect(fixture.requests.filter(({ method }) => method === 'DELETE')).toHaveLength(
        answer === 'yes' ? 1 : 0,
      );
    },
    15_000,
  );

  it.each([
    { kind: 'create', args: CREATE },
    { kind: 'update', args: PATCH },
    { kind: 'delete', args: DELETE },
  ])(
    'refuses a $kind on a terminal input with a piped diagnostic stream',
    async ({ kind, args }) => {
      const fixture = await service();
      const result = await terminalWithPipe([...args, '--yes'], fixture.origin);
      expect(json(result, 2)).toMatchObject({
        ok: false,
        command: kind,
        error: { code: 'USAGE' },
      });
      expect(result.stderr).toContain('needs a terminal diagnostic stream to show its preview');
      expect(result.terminal).toBe('');
      expect(result.stdout + result.stderr).not.toContain('Type yes');
      expect(fixture.requests).toEqual([]);
    },
    15_000,
  );

  it('still reads on a terminal input with a piped diagnostic stream', async () => {
    const fixture = await service();
    const result = await terminalWithPipe(['auth', 'status'], fixture.origin);
    expect(json(result, 0)).toMatchObject({
      ok: true,
      command: 'auth-status',
      data: { ownerId: OWNER },
    });
    expect(fixture.requests.filter(({ method }) => method === 'GET')).toHaveLength(1);
  });
});
