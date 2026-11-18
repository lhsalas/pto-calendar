import { describe, expect, it, vi } from 'vitest';
import {
  isSensitiveKey,
  REDACTED,
  safeErrorSerializer,
  safeMessageSerializer,
  scrubLogData,
  scrubLogLine,
  scrubLogMethodArguments,
  scrubLogObject,
  scrubString,
  scrubValue,
} from './logRedaction.js';

const PAT_SECRET = 'a'.repeat(64);
const PAT_TOKEN = `pto_pat_11111111-1111-4111-8111-111111111111.${PAT_SECRET}`;

describe('isSensitiveKey', () => {
  it('normalizes separators and case so every spelling of a credential key matches', () => {
    expect(isSensitiveKey('password')).toBe(true);
    expect(isSensitiveKey('passwordHash')).toBe(true);
    expect(isSensitiveKey('password_hash')).toBe(true);
    expect(isSensitiveKey('PASSWORD-HASH')).toBe(true);
    expect(isSensitiveKey('rawToken')).toBe(true);
    expect(isSensitiveKey('raw-token')).toBe(true);
    expect(isSensitiveKey('secretDigest')).toBe(true);
    expect(isSensitiveKey('setupTokenHash')).toBe(true);
    expect(isSensitiveKey('authorization')).toBe(true);
    expect(isSensitiveKey('Proxy-Authorization')).toBe(true);
    expect(isSensitiveKey('cookie')).toBe(true);
    expect(isSensitiveKey('set-cookie')).toBe(true);
    expect(isSensitiveKey('credential')).toBe(true);
    expect(isSensitiveKey('credentials')).toBe(true);
    expect(isSensitiveKey('credentialType')).toBe(true);
    expect(isSensitiveKey('accessToken')).toBe(true);
    expect(isSensitiveKey('refreshToken')).toBe(true);
    expect(isSensitiveKey('clientSecret')).toBe(true);
    expect(isSensitiveKey('apiKey')).toBe(true);
    expect(isSensitiveKey('privateKey')).toBe(true);
    expect(isSensitiveKey('setupSecret')).toBe(true);
    expect(isSensitiveKey('passwordConfirmation')).toBe(true);
    expect(isSensitiveKey('newPassword')).toBe(true);
    expect(isSensitiveKey('oldPassword')).toBe(true);
    expect(isSensitiveKey('currentPassword')).toBe(true);
    expect(isSensitiveKey('tokenValue')).toBe(true);
    expect(isSensitiveKey('idToken')).toBe(true);
    expect(isSensitiveKey('bearerToken')).toBe(true);
    expect(isSensitiveKey('sessionSecret')).toBe(true);
  });

  it('leaves public attribution identifiers visible', () => {
    expect(isSensitiveKey('tokenId')).toBe(false);
    expect(isSensitiveKey('sourceTokenId')).toBe(false);
    expect(isSensitiveKey('targetOwnerId')).toBe(false);
    expect(isSensitiveKey('requestId')).toBe(false);
    expect(isSensitiveKey('actorUserId')).toBe(false);
    expect(isSensitiveKey('scope')).toBe(false);
    expect(isSensitiveKey('userId')).toBe(false);
  });
});

describe('scrubString', () => {
  it('removes personal tokens, 64-hex digests and bearer credentials', () => {
    expect(scrubString(`token ${PAT_TOKEN} here`)).not.toContain(PAT_TOKEN);
    expect(scrubString(`digest ${PAT_SECRET}`)).not.toContain(PAT_SECRET);
    expect(scrubString('Authorization: Bearer secret-value')).not.toContain('secret-value');
    expect(scrubString('nothing to hide')).toBe('nothing to hide');
  });

  it('replaces every occurrence, not only the first', () => {
    const scrubbed = scrubString(`${PAT_TOKEN} and ${PAT_TOKEN}`);
    expect(scrubbed).not.toContain(PAT_TOKEN);
    expect(scrubbed.split(REDACTED).length - 1).toBe(2);
  });
});

describe('scrubValue', () => {
  it('passes primitives through and normalizes the exotic ones', () => {
    expect(scrubValue('text')).toBe('text');
    expect(scrubValue(42)).toBe(42);
    expect(scrubValue(true)).toBe(true);
    expect(scrubValue(null)).toBeNull();
    expect(scrubValue(undefined)).toBeUndefined();
    expect(scrubValue(10n)).toBe('10');
    expect(scrubValue(() => undefined)).toBeUndefined();
    expect(scrubValue(Symbol('secret'))).toBeUndefined();
  });

  it('keeps dates and replaces binary payloads', () => {
    const date = new Date('2026-05-11T00:00:00.000Z');
    expect(scrubValue(date)).toBe(date);
    expect(scrubValue(Buffer.from([1, 2, 3]))).toBe('[Binary]');
    expect(scrubValue(new Uint8Array([1, 2, 3]))).toBe('[Binary]');
    expect(scrubValue(new ArrayBuffer(4))).toBe('[Binary]');
  });

  it('redacts a credential key at any depth and keeps the surrounding structure', () => {
    const scrubbed = scrubValue({
      level1: { level2: { level3: { password: 'deep-secret', keep: 'visible' } } },
    }) as { level1: { level2: { level3: Record<string, unknown> } } };
    expect(scrubbed.level1.level2.level3['password']).toBe(REDACTED);
    expect(scrubbed.level1.level2.level3['keep']).toBe('visible');
  });

  it('marks a cycle instead of recursing forever', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic['self'] = cyclic;
    const scrubbed = scrubValue(cyclic) as Record<string, unknown>;
    expect(scrubbed['self']).toBe('[Circular]');
    expect(scrubbed['name']).toBe('root');
  });

  it('truncates a payload that is deeper than the traversal bound', () => {
    let deep: Record<string, unknown> = { token: 'too-deep-secret' };
    for (let index = 0; index < 12; index += 1) deep = { nested: deep };
    expect(JSON.stringify(scrubValue(deep))).not.toContain('too-deep-secret');
    expect(JSON.stringify(scrubValue(deep))).toContain('[Truncated]');
  });

  it('bounds the breadth of a wide object and reports the remainder', () => {
    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 150; index += 1) wide[`key${index}`] = index;
    const scrubbed = scrubValue(wide) as Record<string, unknown>;
    expect(Object.keys(scrubbed)).toHaveLength(100);
  });

  it('bounds the breadth of a wide array and reports the remainder', () => {
    const wide = Array.from({ length: 150 }, (_, index) => index);
    const scrubbed = scrubValue(wide) as unknown[];
    expect(scrubbed).toHaveLength(101);
    expect(scrubbed[100]).toBe('[50 more]');
  });

  it('scrubs an error, its own properties and its cause', () => {
    const failure = new Error('driver said no');
    Object.assign(failure, { password: 'error-secret', rawToken: PAT_TOKEN });
    const scrubbed = scrubValue(failure) as Record<string, unknown>;
    expect(scrubbed['type']).toBe('Error');
    expect(scrubbed['message']).toBe('driver said no');
    expect(scrubbed['password']).toBe(REDACTED);
    expect(scrubbed['rawToken']).toBe(REDACTED);
    expect(scrubbed['stack']).toContain('Error');
  });

  it('scrubs an error type that carries a personal token', () => {
    const failure = new Error('driver said no');
    failure.name = PAT_TOKEN;
    const scrubbed = scrubValue(failure) as Record<string, unknown>;
    expect(scrubbed['type']).toBe(REDACTED);
    expect(JSON.stringify(scrubbed)).not.toContain(PAT_TOKEN);
  });

  it('scrubs a non-error cause without keeping the original value', () => {
    const failure = new Error('outer');
    Object.assign(failure, { cause: { authorization: 'Bearer cause-secret' } });
    const scrubbed = scrubValue(failure) as Record<string, unknown>;
    expect(JSON.stringify(scrubbed)).not.toContain('cause-secret');
    expect((scrubbed['cause'] as Record<string, unknown>)['authorization']).toBe(REDACTED);
  });

  it('summarizes an error without a stack and never repeats its own summary keys', () => {
    const withoutStack = new Error('no stack here');
    delete (withoutStack as unknown as { stack?: string }).stack;
    const scrubbed = scrubValue(withoutStack) as Record<string, unknown>;
    expect(scrubbed['stack']).toBe('');
    expect(scrubbed['message']).toBe('no stack here');
    const enumerable = new Error('enumerable message');
    Object.defineProperty(enumerable, 'message', {
      value: 'enumerable message',
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const summarized = scrubValue(enumerable) as Record<string, unknown>;
    expect(summarized['message']).toBe('enumerable message');
    expect(summarized['type']).toBe('Error');
  });

  it('does not mutate the value it scrubs', () => {
    const original = { password: 'kept-secret', nested: { token: 'kept-token' } };
    scrubValue(original);
    expect(original.password).toBe('kept-secret');
    expect(original.nested.token).toBe('kept-token');
  });

  it('replaces a throwing getter instead of failing the log line', () => {
    const hostile: Record<string, unknown> = { safe: 'value' };
    Object.defineProperty(hostile, 'explode', {
      enumerable: true,
      get() {
        throw new Error('getter leaked its message');
      },
    });
    const scrubbed = scrubValue(hostile) as Record<string, unknown>;
    expect(scrubbed['explode']).toBe('[Unreadable]');
    expect(scrubbed['safe']).toBe('value');
  });
});

describe('scrubLogObject', () => {
  it('leaves serializer-owned keys to their allowlisting serializers', () => {
    const req = { id: 'req-1', method: 'GET', url: '/pto' };
    const res = { statusCode: 200 };
    const err = new Error('boom');
    const scrubbed = scrubLogObject({ req, res, err });
    expect(scrubbed['req']).toBe(req);
    expect(scrubbed['res']).toBe(res);
    expect(scrubbed['err']).toBe(err);
  });

  it('redacts a credential key and scrubs every other entry', () => {
    const scrubbed = scrubLogObject({
      password: 'plain-secret',
      nested: { token: 'nested-secret', keep: 'visible' },
    });
    expect(scrubbed['password']).toBe(REDACTED);
    const nested = scrubbed['nested'] as Record<string, unknown>;
    expect(nested['token']).toBe(REDACTED);
    expect(nested['keep']).toBe('visible');
  });
});

describe('safeErrorSerializer', () => {
  it('never returns a raw error copy', () => {
    const failure = new Error('boom');
    Object.assign(failure, { password: 'serializer-secret' });
    const serialized = safeErrorSerializer(failure) as Record<string, unknown>;
    expect(serialized['password']).toBe(REDACTED);
    expect(serialized['message']).toBe('boom');
  });
});

describe('safeMessageSerializer', () => {
  it('scrubs text and leaves non-text messages untouched', () => {
    expect(safeMessageSerializer(`issued ${PAT_TOKEN}`)).not.toContain(PAT_TOKEN);
    expect(safeMessageSerializer(42)).toBe(42);
    expect(safeMessageSerializer(undefined)).toBeUndefined();
  });
});

describe('scrubLogMethodArguments', () => {
  it('scrubs text, payloads and interpolated values before they reach pino', () => {
    const calls: unknown[][] = [];
    const context = { marker: 'context' };
    const failure = new Error('boom');
    const date = new Date('2026-05-11T00:00:00.000Z');
    scrubLogMethodArguments.call(
      context,
      [
        `issued ${PAT_TOKEN}`,
        { password: 'argument-secret' },
        failure,
        date,
        [1, 2],
        Buffer.from([1]),
        7,
        null,
      ],
      (...values: unknown[]) => {
        calls.push(values);
      },
    );
    expect(calls).toHaveLength(1);
    const values = calls[0]!;
    expect(String(values[0])).not.toContain(PAT_TOKEN);
    expect((values[1] as Record<string, unknown>)['password']).toBe(REDACTED);
    // An interpolated error is summarized: no serializer owns it there.
    expect(values[2]).not.toBe(failure);
    expect(values[2]).toMatchObject({ type: 'Error', message: 'boom' });
    expect(values[3]).toBe(date);
    expect(values[4]).toEqual([1, 2]);
    expect(values[5]).toBe('[Binary]');
    expect(values[6]).toBe(7);
    expect(values[7]).toBeNull();
  });

  it('keeps the serializer-owned keys of the structured payload only', () => {
    const calls: unknown[][] = [];
    const req = { id: 'req-1', method: 'GET', url: '/pto' };
    const res = { statusCode: 200 };
    const failure = new Error('boom');
    scrubLogMethodArguments.call(
      {},
      [{ req, res, err: failure }, { req: { body: { password: 'nested-marker' } } }],
      (...values: unknown[]) => {
        calls.push(values);
      },
    );
    const values = calls[0]!;
    const payload = values[0] as Record<string, unknown>;
    expect(payload['req']).toBe(req);
    expect(payload['res']).toBe(res);
    expect(payload['err']).toBe(failure);
    // The interpolated request is data, not a request: it is scrubbed as a whole.
    const interpolated = values[1] as Record<string, unknown>;
    expect(JSON.stringify(interpolated)).not.toContain('nested-marker');
  });

  it('leaves a leading error to the error serializer', () => {
    const calls: unknown[][] = [];
    const failure = new Error('boom');
    scrubLogMethodArguments.call({}, [failure], (...values: unknown[]) => {
      calls.push(values);
    });
    expect(calls[0]![0]).toBe(failure);
  });

  it('calls the log method with the same receiver', () => {
    const context = { marker: 'context' };
    const receiver = vi.fn(function (this: unknown) {
      expect(this).toBe(context);
    });
    scrubLogMethodArguments.call(context, ['message'], receiver);
    expect(receiver).toHaveBeenCalledOnce();
  });
});

describe('scrubLogData', () => {
  it('scrubs every key, including the serializer-owned names', () => {
    const scrubbed = scrubLogData({
      req: { body: { password: 'data-password-marker' } },
      err: { password: 'data-error-marker' },
      token: 'data-token-marker',
      keep: 'visible',
    }) as Record<string, unknown>;
    expect(JSON.stringify(scrubbed)).not.toContain('data-password-marker');
    expect(JSON.stringify(scrubbed)).not.toContain('data-error-marker');
    expect(JSON.stringify(scrubbed)).not.toContain('data-token-marker');
    expect(scrubbed['keep']).toBe('visible');
  });
});

describe('scrubLogLine', () => {
  it('scrubs the finished record, which is where child bindings appear', () => {
    const line = JSON.stringify({
      level: 30,
      context: { deeper: { password: 'line-password-marker' } },
      msg: 'bound',
    });
    const scrubbed = scrubLogLine(line);
    expect(scrubbed).not.toContain('line-password-marker');
    expect(JSON.parse(scrubbed)).toMatchObject({ level: 30, msg: 'bound' });
  });

  it('keeps the trailing newline of the record', () => {
    expect(scrubLogLine('{"a":1}\n')).toBe('{"a":1}\n');
    expect(scrubLogLine('{"a":1}\r\n')).toBe('{"a":1}\r\n');
    expect(scrubLogLine('{"a":1}')).toBe('{"a":1}');
  });

  it('scrubs a line that is not JSON as text instead of dropping it', () => {
    expect(scrubLogLine(`not json ${PAT_TOKEN}\n`)).not.toContain(PAT_TOKEN);
    expect(scrubLogLine(`not json ${PAT_TOKEN}\n`)).toContain('not json');
  });
});
