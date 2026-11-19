import { PassThrough, Writable } from 'node:stream';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

import {
  FrameGuard,
  FrameReader,
  INVALID_PARAMS,
  INVALID_REQUEST,
  MAX_FRAME_BYTES,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  SERVED_METHODS,
  classifyFrame,
  isSafeRequestId,
  untilWritable,
  writeFrame,
  type ErrorReply,
  type FrameEvent,
} from '../src/framing.js';

/** A sentinel that must never appear in a reply, a diagnostic or a log. */
const SENTINEL = 'SENTINEL-client-text-7f3a';

/** A personal-token shaped id, built from the documented wire format with synthetic digits. */
const PERSONAL_TOKEN = `pto_pat_11111111-2222-4333-8444-555555555555.${'e'.repeat(64)}`;

/** The verdict of one frame, given as text, so a test can search the whole reply. */
function verdictOf(text: string) {
  return classifyFrame(Buffer.from(text, 'utf8'));
}

function framesOf(events: Iterable<FrameEvent>): string[] {
  return [...events].map((event) => {
    if (event.kind === 'oversize') return 'OVERSIZE';
    return event.bytes.toString('utf8');
  });
}

describe('FrameReader', () => {
  it('splits complete frames, keeps CR bytes for the classifier and skips blank lines', () => {
    const reader = new FrameReader(64);
    const events = framesOf(reader.feed(Buffer.from('{"a":1}\r\n\n   \n{"b":2}\n')));
    expect(events).toEqual(['{"a":1}\r', '{"b":2}']);
  });

  it('gives the same frames when the bytes arrive one at a time', () => {
    const text = '{"id":1}\n\n{"id":2}\r\n{"id":3}\n';
    const whole = framesOf(new FrameReader().feed(Buffer.from(text)));
    const reader = new FrameReader();
    const pieces: FrameEvent[] = [];
    for (const byte of Buffer.from(text)) pieces.push(...reader.feed(Buffer.from([byte])));
    expect(framesOf(pieces)).toEqual(whole);
    expect(whole).toHaveLength(3);
  });

  it('accepts a frame of exactly the limit and reports one longer frame once', () => {
    const reader = new FrameReader(4);
    expect(framesOf(reader.feed(Buffer.from('abcd\n')))).toEqual(['abcd']);
    expect(framesOf(reader.feed(Buffer.from('abcde\n')))).toEqual(['OVERSIZE']);
    expect(framesOf(reader.feed(Buffer.from('ok\n')))).toEqual(['ok']);
  });

  it('discards an oversized frame across many chunks without storing it', () => {
    const reader = new FrameReader(64);
    const chunk = Buffer.alloc(64 * 1024, 0x78);
    let events: string[] = [];
    // 16 MiB of one frame: the reader must report it once and keep nothing.
    for (let index = 0; index < 256; index += 1) {
      events = events.concat(framesOf(reader.feed(chunk)));
    }
    expect(events).toEqual(['OVERSIZE']);
    expect(framesOf(reader.feed(Buffer.from('\n{"id":9}\n')))).toEqual(['{"id":9}']);
  });

  it('resynchronises when the oversized frame and the next valid frame share a chunk', () => {
    const reader = new FrameReader(4);
    const events = framesOf(reader.feed(Buffer.from('0123456789\nok\n')));
    expect(events).toEqual(['OVERSIZE', 'ok']);
  });

  it('forgets a partial frame on reset', () => {
    const reader = new FrameReader(64);
    expect(framesOf(reader.feed(Buffer.from('partial')))).toEqual([]);
    reader.reset();
    expect(framesOf(reader.feed(Buffer.from('fresh\n')))).toEqual(['fresh']);
  });

  it('rejects an invalid limit', () => {
    expect(() => new FrameReader(0)).toThrow(RangeError);
    expect(() => new FrameReader(1.5)).toThrow(RangeError);
    expect(MAX_FRAME_BYTES).toBe(262_144);
  });
});

describe('classifyFrame', () => {
  const text = (value: string) => Buffer.from(value, 'utf8');

  it('forwards valid requests, notifications and responses', () => {
    expect(classifyFrame(text('{"jsonrpc":"2.0","id":1,"method":"ping"}'))).toEqual({
      kind: 'forward',
    });
    expect(classifyFrame(text('{"jsonrpc":"2.0","method":"notifications/initialized"}')).kind).toBe(
      'forward',
    );
    expect(classifyFrame(text('{"jsonrpc":"2.0","id":5,"result":{}}')).kind).toBe('forward');
    expect(classifyFrame(text('{"jsonrpc":"2.0","id":1,"method":"ping"}\r')).kind).toBe('forward');
  });

  it('answers text that is not JSON with a parse error that has no id', () => {
    const verdict = classifyFrame(text(`{"${SENTINEL}`));
    expect(verdict).toEqual({
      kind: 'reply',
      reply: { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } },
    });
    expect(JSON.stringify(verdict)).not.toContain(SENTINEL);
  });

  it.each(['[1,2]', '"text"', '42', 'null', 'true'])(
    'answers %s with an invalid request',
    (raw) => {
      expect(classifyFrame(text(raw))).toEqual({
        kind: 'reply',
        reply: {
          jsonrpc: '2.0',
          id: null,
          error: { code: INVALID_REQUEST, message: 'Invalid Request' },
        },
      });
    },
  );

  it('repeats a safe request id and drops an unsafe one', () => {
    const numeric = classifyFrame(text('{"id":7,"method":"tools/list","jsonrpc":"1.0"}'));
    expect(numeric).toMatchObject({ kind: 'reply', reply: { id: 7 } });
    const long = classifyFrame(text(`{"id":"${'a'.repeat(129)}","method":"ping"}`));
    expect(long).toMatchObject({ kind: 'reply', reply: { id: null } });
    const object = classifyFrame(text('{"id":{"x":1},"method":"ping"}'));
    expect(object).toMatchObject({ kind: 'reply', reply: { id: null } });
    const fractional = classifyFrame(text('{"id":1.5,"method":"ping"}'));
    expect(fractional).toMatchObject({ kind: 'reply', reply: { id: null } });
  });

  it('drops invalid notifications and invalid responses without any reply', () => {
    expect(classifyFrame(text('{"method":"notifications/x"}'))).toEqual({ kind: 'drop' });
    expect(classifyFrame(text('{"jsonrpc":"2.0","result":{}}'))).toEqual({ kind: 'drop' });
    expect(classifyFrame(text('{"jsonrpc":"2.0","error":{"code":1}}'))).toEqual({ kind: 'drop' });
  });

  it('answers an invalid request that has no method and no response shape', () => {
    expect(classifyFrame(text('{"id":3}'))).toMatchObject({
      kind: 'reply',
      reply: { id: 3, error: { code: INVALID_REQUEST } },
    });
    expect(classifyFrame(text('{}'))).toMatchObject({ kind: 'reply', reply: { id: null } });
  });

  it('never repeats client text other than a bounded request id', () => {
    const verdicts = [
      classifyFrame(text(`{"jsonrpc":"2.0","id":"req-1","method":"ping","${SENTINEL}":1}`)),
      classifyFrame(text(`["${SENTINEL}"]`)),
      classifyFrame(text(`{"${SENTINEL}":`)),
      classifyFrame(text(`{"jsonrpc":"2.0","id":{"${SENTINEL}":1},"method":"ping"}`)),
    ];
    for (const verdict of verdicts) {
      expect(JSON.stringify(verdict)).not.toContain(SENTINEL);
    }
    expect(verdicts[0]).toEqual({
      kind: 'reply',
      reply: {
        jsonrpc: '2.0',
        id: 'req-1',
        error: { code: INVALID_REQUEST, message: 'Invalid Request' },
      },
    });
  });
});

describe('isSafeRequestId', () => {
  it.each([
    0,
    7,
    -3,
    Number.MAX_SAFE_INTEGER,
    'req-1',
    'a.b:c',
    'Z9',
    'x'.repeat(64),
    'e'.repeat(23),
    '3f2b8c1e-9a7d-4e5f-8b6c-1d2e3f4a5b6c',
    '3F2B8C1E-9A7D-4E5F-8B6C-1D2E3F4A5B6C',
  ])('accepts the safe id %j', (value) => {
    expect(isSafeRequestId(value)).toBe(true);
  });

  it.each([
    1.5,
    Number.MAX_SAFE_INTEGER + 2,
    Number.NaN,
    null,
    undefined,
    true,
    {},
    [],
    '',
    '-req',
    '.req',
    'req_1',
    'req 1',
    'req\n1',
    'req\u0001',
    'req\u007f',
    'café',
    'x'.repeat(65),
    'e'.repeat(24),
    '0123456789abcdef0123456789abcdef',
    '3f2b8c1e9a7d4e5f8b6c1d2e3f4a5b6c',
    PERSONAL_TOKEN,
    'pto_pat',
    `token.${'a'.repeat(30)}`,
  ])('refuses the unsafe id %j', (value) => {
    expect(isSafeRequestId(value)).toBe(false);
  });
});

describe('classifyFrame id, method and params policy', () => {
  it('refuses a request whose id is not safe and never forwards or repeats that id', () => {
    const cases = [
      {
        text: `{"jsonrpc":"2.0","id":"${PERSONAL_TOKEN}","method":"ping"}`,
        secret: PERSONAL_TOKEN,
      },
      {
        text: `{"jsonrpc":"2.0","id":"${'e'.repeat(64)}","method":"ping"}`,
        secret: 'e'.repeat(64),
      },
      {
        text: `{"jsonrpc":"2.0","id":"${'x'.repeat(65)}","method":"ping"}`,
        secret: 'x'.repeat(65),
      },
      { text: '{"jsonrpc":"2.0","id":"req\\u0001","method":"ping"}', secret: 'req\u0001' },
      { text: '{"jsonrpc":"2.0","id":{"nested":"keep"},"method":"ping"}', secret: 'keep' },
      { text: '{"jsonrpc":"2.0","id":1.5,"method":"ping"}', secret: '1.5' },
    ];
    for (const { text, secret } of cases) {
      const verdict = verdictOf(text);
      expect(verdict).toEqual({
        kind: 'reply',
        reply: {
          jsonrpc: '2.0',
          id: null,
          error: { code: INVALID_REQUEST, message: 'Invalid Request' },
        },
      });
      expect(JSON.stringify(verdict).includes(secret)).toBe(false);
    }
  });

  it('repeats a safe id on an invalid request and answers it with the invalid request code', () => {
    expect(verdictOf('{"jsonrpc":"1.0","id":"req-9","method":"ping"}')).toEqual({
      kind: 'reply',
      reply: {
        jsonrpc: '2.0',
        id: 'req-9',
        error: { code: INVALID_REQUEST, message: 'Invalid Request' },
      },
    });
  });

  it('answers a valid request for a method the server does not serve with a fixed reply', () => {
    const verdict = verdictOf('{"jsonrpc":"2.0","id":"req-1","method":"resources/list"}');
    expect(verdict).toEqual({
      kind: 'reply',
      reply: {
        jsonrpc: '2.0',
        id: 'req-1',
        error: { code: METHOD_NOT_FOUND, message: 'Method not found' },
      },
    });
    expect(JSON.stringify(verdict)).not.toContain('resources/list');
  });

  it('refuses a task-augmented request with a fixed reply and never repeats its method', () => {
    const unknown = verdictOf(
      '{"jsonrpc":"2.0","id":3,"method":"SENTINEL-method-x","params":{"task":{}}}',
    );
    expect(unknown).toEqual({
      kind: 'reply',
      reply: {
        jsonrpc: '2.0',
        id: 3,
        error: { code: METHOD_NOT_FOUND, message: 'Method not found' },
      },
    });
    expect(JSON.stringify(unknown)).not.toContain('SENTINEL-method-x');

    const served = verdictOf(
      '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"pto_get","arguments":{},"task":{"ttl":1000}}}',
    );
    expect(served).toEqual({
      kind: 'reply',
      reply: { jsonrpc: '2.0', id: 4, error: { code: INVALID_PARAMS, message: 'Invalid params' } },
    });

    const ping = verdictOf('{"jsonrpc":"2.0","id":5,"method":"ping","params":{"task":{}}}');
    expect(ping).toMatchObject({
      kind: 'reply',
      reply: { id: 5, error: { code: INVALID_PARAMS } },
    });
  });

  it('forwards the requests it serves when they are valid', () => {
    expect(SERVED_METHODS).toEqual(['initialize', 'ping', 'tools/list', 'tools/call']);
    expect(verdictOf('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')).toEqual({
      kind: 'forward',
    });
    expect(
      verdictOf(
        '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"pto_get","arguments":{}}}',
      ),
    ).toEqual({ kind: 'forward' });
    expect(verdictOf('{"jsonrpc":"2.0","id":3,"method":"ping"}')).toEqual({ kind: 'forward' });
    expect(
      verdictOf(
        '{"jsonrpc":"2.0","id":"req-4","method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"c","version":"1"}}}',
      ),
    ).toEqual({ kind: 'forward' });
  });

  it('redacts invalid initialize and ping params before the SDK can quote them', () => {
    const initialize = verdictOf(
      `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":"${SENTINEL}","clientInfo":{"name":"c","version":"1"}}}`,
    );
    expect(initialize).toEqual({
      kind: 'reply',
      reply: { jsonrpc: '2.0', id: 1, error: { code: INVALID_PARAMS, message: 'Invalid params' } },
    });
    expect(JSON.stringify(initialize)).not.toContain(SENTINEL);

    // For ping, the envelope and the SDK's params schema have the same shape: a bad params value
    // fails the envelope, so it is answered as an invalid request with the same fixed sentence.
    const ping = verdictOf(`{"jsonrpc":"2.0","id":2,"method":"ping","params":"${SENTINEL}"}`);
    expect(ping).toEqual({
      kind: 'reply',
      reply: {
        jsonrpc: '2.0',
        id: 2,
        error: { code: INVALID_REQUEST, message: 'Invalid Request' },
      },
    });
    expect(JSON.stringify(ping)).not.toContain(SENTINEL);
    const meta = verdictOf(
      `{"jsonrpc":"2.0","id":3,"method":"ping","params":{"_meta":{"progressToken":["${SENTINEL}"]}}}`,
    );
    expect(meta).toMatchObject({
      kind: 'reply',
      reply: { id: 3, error: { code: INVALID_REQUEST } },
    });
    expect(JSON.stringify(meta)).not.toContain(SENTINEL);
  });

  it('drops a response whose id is not safe and never answers a response', () => {
    expect(verdictOf(`{"jsonrpc":"2.0","id":"${PERSONAL_TOKEN}","result":{}}`)).toEqual({
      kind: 'drop',
    });
    expect(verdictOf('{"jsonrpc":"2.0","id":5,"result":{}}')).toEqual({ kind: 'forward' });
    expect(verdictOf('{"jsonrpc":"2.0","id":6,"result":{},"extra":1}')).toEqual({ kind: 'drop' });
  });

  it('forwards a valid notification without repeating anything from it', () => {
    expect(
      verdictOf(
        `{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"${PERSONAL_TOKEN}"}}`,
      ),
    ).toEqual({ kind: 'forward' });
  });
});

describe('FrameGuard', () => {
  function collect(guard: FrameGuard): Buffer[] {
    const frames: Buffer[] = [];
    guard.on('data', (chunk: Buffer) => frames.push(chunk));
    return frames;
  }

  it('pushes each valid frame as one newline-terminated object', async () => {
    const replies: ErrorReply[] = [];
    const guard = new FrameGuard({
      admit: async () => true,
      reply: async (reply) => {
        replies.push(reply);
      },
    });
    const frames = collect(guard);
    guard.end(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}\n\n{"oops\n'));
    await once(guard, 'end');
    expect(frames.map((frame) => frame.toString('utf8'))).toEqual([
      '{"jsonrpc":"2.0","id":1,"method":"ping"}\n',
    ]);
    expect(replies).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } },
    ]);
  });

  it('never pushes a request with an unsafe id to the protocol', async () => {
    const replies: ErrorReply[] = [];
    const guard = new FrameGuard({
      admit: async () => true,
      reply: async (reply) => {
        replies.push(reply);
      },
    });
    const frames = collect(guard);
    guard.end(
      Buffer.from(
        `{"jsonrpc":"2.0","id":"${PERSONAL_TOKEN}","method":"ping"}\n{"jsonrpc":"2.0","id":8,"method":"ping"}\n`,
      ),
    );
    await once(guard, 'end');
    expect(frames.map((frame) => frame.toString('utf8'))).toEqual([
      '{"jsonrpc":"2.0","id":8,"method":"ping"}\n',
    ]);
    expect(replies).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Invalid Request' } },
    ]);
    expect(JSON.stringify(replies)).not.toContain(PERSONAL_TOKEN);
  });

  it('answers an oversized frame and keeps reading the frames after it', async () => {
    const replies: ErrorReply[] = [];
    const guard = new FrameGuard({
      limit: 48,
      admit: async () => true,
      reply: async (reply) => {
        replies.push(reply);
      },
    });
    const frames = collect(guard);
    guard.end(Buffer.from(`${'x'.repeat(60)}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n`));
    await once(guard, 'end');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ id: null, error: { code: INVALID_REQUEST } });
    expect(frames.map((frame) => frame.toString('utf8'))).toEqual([
      '{"jsonrpc":"2.0","id":2,"method":"ping"}\n',
    ]);
  });

  it('stops without a reply when admission refuses the next frame', async () => {
    const replies: ErrorReply[] = [];
    let admitted = 0;
    const guard = new FrameGuard({
      admit: async () => {
        admitted += 1;
        return admitted === 1;
      },
      reply: async (reply) => {
        replies.push(reply);
      },
    });
    const frames = collect(guard);
    guard.end(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"x\n'));
    await once(guard, 'end');
    expect(frames).toHaveLength(1);
    expect(replies).toEqual([]);
  });

  it('waits for the reader before it pushes the next frame', async () => {
    const guard = new FrameGuard({
      admit: async () => true,
      reply: async () => undefined,
    });
    const line = '{"jsonrpc":"2.0","id":1,"method":"ping"}\n';
    guard.write(Buffer.from(line.repeat(200)));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The object-mode buffer holds a bounded number of frames until somebody reads.
    expect(guard.readableLength).toBeLessThanOrEqual(17);
    let delivered = 0;
    guard.on('data', () => {
      delivered += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(delivered).toBe(200);
    guard.destroy();
  });

  it('releases a waiting frame when the guard is destroyed', async () => {
    const guard = new FrameGuard({
      admit: async () => true,
      reply: async () => undefined,
    });
    const errors: Error[] = [];
    guard.on('error', (error: Error) => errors.push(error));
    guard.write(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}\n'.repeat(50)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    guard.destroy();
    await once(guard, 'close');
    expect(errors).toEqual([]);
  });

  it('neither admits nor answers a frame whose admission was pending when the guard stopped', async () => {
    // The admission waits until the test decides it, so the stop can land inside that wait.
    const gate: { decide?: (admitted: boolean) => void } = {};
    const replies: ErrorReply[] = [];
    const delivered: Buffer[] = [];
    const guard = new FrameGuard({
      admit: () =>
        new Promise<boolean>((resolve) => {
          gate.decide = resolve;
        }),
      reply: async (reply) => {
        replies.push(reply);
      },
    });
    guard.on('data', (chunk: Buffer) => delivered.push(chunk));
    guard.write(Buffer.from('not json\n'));
    for (let attempt = 0; attempt < 500 && gate.decide === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(gate.decide).toBeDefined();
    guard.destroy();
    gate.decide?.(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(replies).toEqual([]);
    expect(delivered).toEqual([]);
  });

  it('turns a failure that is not an Error into a fixed stream error', async () => {
    const guard = new FrameGuard({
      admit: async () => true,
      reply: async () => {
        throw SENTINEL;
      },
    });
    const failure = once(guard, 'error');
    guard.end(Buffer.from('not json\n'));
    const [error] = (await failure) as [Error];
    expect(error.message).toBe('frame failure');
    expect(error.message.includes(SENTINEL)).toBe(false);
  });

  it('surfaces a failed reply as a stream error', async () => {
    const guard = new FrameGuard({
      admit: async () => true,
      reply: async () => {
        throw new Error(SENTINEL);
      },
    });
    const failure = once(guard, 'error');
    guard.end(Buffer.from('not json\n'));
    const [error] = (await failure) as [Error];
    expect(error.message).toBe(SENTINEL);
  });
});

describe('writeFrame', () => {
  it('writes one newline-terminated JSON line and resolves when accepted', async () => {
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk.toString('utf8'));
        done();
      },
    });
    await writeFrame(output, { jsonrpc: '2.0', id: 1, result: {} });
    expect(chunks).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}\n']);
  });

  it('waits for the drain of a full output', async () => {
    const callbacks: Array<() => void> = [];
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, done) {
        callbacks.push(done);
      },
    });
    let settled = false;
    const pending = writeFrame(output, { id: 1 }).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    callbacks.splice(0).forEach((done) => done());
    await pending;
    expect(settled).toBe(true);
  });

  it('rejects when the output is already closed', async () => {
    const output = new PassThrough();
    output.destroy();
    await expect(writeFrame(output, { id: 1 })).rejects.toThrow('closed');
  });

  it('rejects a waiting write when the output closes or fails', async () => {
    const closing = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, done) {
        void done;
      },
    });
    const pendingClose = writeFrame(closing, { id: 1 });
    closing.destroy();
    await expect(pendingClose).rejects.toThrow('closed');

    const failing = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, done) {
        void done;
      },
    });
    const pendingError = writeFrame(failing, { id: 2 });
    failing.destroy(new Error(SENTINEL));
    await expect(pendingError).rejects.toThrow(SENTINEL);
  });
});

describe('untilWritable', () => {
  it('resolves at once when the output is not full, destroyed or aborted', async () => {
    const output = new PassThrough();
    await untilWritable(output, new AbortController().signal);
    output.destroy();
    await untilWritable(output, new AbortController().signal);
    const aborted = new AbortController();
    aborted.abort();
    await untilWritable(new PassThrough(), aborted.signal);
  });

  it('resolves on drain, on close and on abort while the output is full', async () => {
    const callbacks: Array<() => void> = [];
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, done) {
        callbacks.push(done);
      },
    });
    output.write('first');
    expect(output.writableNeedDrain).toBe(true);

    const drained = untilWritable(output, new AbortController().signal);
    callbacks.splice(0).forEach((done) => done());
    await drained;

    output.write('second');
    const controller = new AbortController();
    const aborted = untilWritable(output, controller.signal);
    controller.abort();
    await aborted;

    output.write('third');
    const closed = untilWritable(output, new AbortController().signal);
    output.destroy();
    await closed;
  });
});
