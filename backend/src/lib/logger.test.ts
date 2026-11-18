import { Writable } from 'node:stream';
import pino, { type Logger, type LoggerOptions } from 'pino';
import { pinoHttp } from 'pino-http';
import { describe, expect, it } from 'vitest';
import { LOGGER_OPTIONS, REDACT_CENSOR, REDACT_PATHS } from './logger.js';
import { createPinoHttpOptions } from './logSanitizers.js';

function makeCapturingLogger(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const log = pino(
    {
      level: 'info',
      base: { pid: 0, hostname: 'test' },
      redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
    },
    sink as unknown as NodeJS.WritableStream,
  );
  return { log, lines };
}

/**
 * The production configuration, captured. The logger under test is built from
 * the same options the application uses, so these assertions describe the real
 * pipeline rather than a helper in isolation.
 */
function capture(options: Partial<LoggerOptions> = {}): { log: Logger; blob: () => string } {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const log = pino(
    { ...LOGGER_OPTIONS, base: { pid: 0, hostname: 'test' }, ...options },
    sink as unknown as NodeJS.WritableStream,
  );
  return { log, blob: () => lines.join('') };
}

const PAT_SECRET = 'a'.repeat(64);
const PAT_TOKEN = `pto_pat_11111111-1111-4111-8111-111111111111.${PAT_SECRET}`;

describe('logger redact configuration', () => {
  it('uses the documented redact paths and the [REDACTED] censor', () => {
    expect(REDACT_PATHS).toEqual([
      'req.headers.cookie',
      'req.headers.authorization',
      'res.headers["set-cookie"]',
      'password',
      'passwordHash',
      'token',
      'secret',
      'rawToken',
      'secretDigest',
      'setupToken',
      'setupTokenHash',
      'authorization',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.secret',
      '*.rawToken',
      '*.secretDigest',
      '*.setupToken',
      '*.setupTokenHash',
      '*.authorization',
    ]);
    expect(REDACT_CENSOR).toBe('[REDACTED]');
  });

  it('redacts top-level secret fields (password, passwordHash, token, secret)', () => {
    const { log, lines } = makeCapturingLogger();
    log.info(
      { password: 'pw-shhh', passwordHash: 'hash-shhh', token: 'tok-shhh', secret: 'sec-shhh' },
      'sample',
    );
    const blob = lines.join('');
    expect(blob).toContain('[REDACTED]');
    expect(blob).not.toContain('pw-shhh');
    expect(blob).not.toContain('hash-shhh');
    expect(blob).not.toContain('tok-shhh');
    expect(blob).not.toContain('sec-shhh');
  });

  it('redacts nested secret fields (req.headers.cookie, res.headers["set-cookie"])', () => {
    const { log, lines } = makeCapturingLogger();
    log.info(
      {
        req: { headers: { cookie: 'session=cookie-shhh', authorization: 'Bearer tok-shhh' } },
        res: { headers: { 'set-cookie': 'session=setcookie-shhh' } },
      },
      'sample',
    );
    const blob = lines.join('');
    expect(blob).toContain('[REDACTED]');
    expect(blob).not.toContain('cookie-shhh');
    expect(blob).not.toContain('setcookie-shhh');
  });
});

describe('production logger credential safety', () => {
  it('never emits credential material on the success path', () => {
    const { log, blob } = capture();
    log.info(
      {
        credential: { type: 'personal_access_token', tokenId: 'public-token-id' },
        credentialType: 'personal_access_token',
        rawToken: PAT_TOKEN,
        secretDigest: 'b'.repeat(64),
        setupTokenHash: 'c'.repeat(64),
        setupToken: 'd'.repeat(64),
        password: 'password-marker',
        passwordHash: 'e'.repeat(64),
        authorization: 'Bearer authorization-marker',
        token: 'token-marker',
        secret: 'secret-marker',
        scope: 'pto:read',
      },
      'personal token issued',
    );
    const out = blob();
    for (const marker of [
      'password-marker',
      'authorization-marker',
      'token-marker',
      'secret-marker',
      PAT_SECRET,
      'b'.repeat(64),
      'c'.repeat(64),
      'd'.repeat(64),
      'e'.repeat(64),
      PAT_TOKEN,
    ]) {
      expect(out).not.toContain(marker);
    }
    // Operational context that is not credential material survives.
    expect(out).toContain('pto:read');
    expect(out).toContain('personal token issued');
  });

  it('never emits credential material on the failure path', () => {
    const { log, blob } = capture();
    const failure = new Error('driver rejected the request');
    Object.assign(failure, {
      password: 'error-password-marker',
      rawToken: PAT_TOKEN,
      cause: { authorization: 'Bearer cause-marker', nested: { secret: 'cause-secret-marker' } },
    });
    log.error({ err: failure, reqId: 'req-failure-1' }, 'token operation failed');
    const out = blob();
    expect(out).not.toContain('error-password-marker');
    expect(out).not.toContain('cause-marker');
    expect(out).not.toContain('cause-secret-marker');
    expect(out).not.toContain(PAT_TOKEN);
    expect(out).toContain('req-failure-1');
    expect(out).toContain('driver rejected the request');
  });

  it('never emits credential material on the debug path', () => {
    const { log, blob } = capture({ level: 'debug' });
    log.debug(
      {
        token: 'debug-token-marker',
        nested: { deeper: { secret: 'debug-secret-marker' } },
        scope: 'pto:notes:read',
      },
      'debug trace',
    );
    const out = blob();
    expect(out).not.toContain('debug-token-marker');
    expect(out).not.toContain('debug-secret-marker');
    expect(out).toContain('pto:notes:read');
  });

  it('redacts arbitrarily nested and cyclic credential shapes', () => {
    const { log, blob } = capture();
    const cyclic: Record<string, unknown> = { password: 'cyclic-password-marker' };
    cyclic['self'] = cyclic;
    let deep: Record<string, unknown> = { token: 'deep-token-marker' };
    for (let index = 0; index < 12; index += 1) deep = { nested: deep };
    log.info({ cyclic, deep }, 'shapes');
    const out = blob();
    expect(out).not.toContain('cyclic-password-marker');
    expect(out).not.toContain('deep-token-marker');
    expect(out).toContain('[Circular]');
  });

  it('keeps the fixed endpoint label and never reflects a credential query value', () => {
    const { log, blob } = capture();
    log.info(
      { req: { id: 'req-label-1', method: 'POST', url: `/auth/tokens?token=${PAT_TOKEN}` } },
      'request',
    );
    const parsed = JSON.parse(blob().trim()) as { req: Record<string, unknown> };
    expect(parsed.req).toEqual({ id: 'req-label-1', method: 'POST', url: '/auth/tokens' });
    expect(blob()).not.toContain(PAT_TOKEN);
  });

  it('scrubs an interpolated structured payload instead of only its text', () => {
    const { log, blob } = capture();
    log.info('payload %j', { password: 'interpolated-marker', scope: 'pto:read' });
    const out = blob();
    expect(out).not.toContain('interpolated-marker');
    expect(out).toContain('[REDACTED]');
  });

  it('removes a personal token, a digest and a bearer credential from message text', () => {
    const { log, blob } = capture();
    log.info(`issued ${PAT_TOKEN} digest ${'f'.repeat(64)} with Bearer bearer-text-marker`);
    const out = blob();
    expect(out).not.toContain(PAT_TOKEN);
    expect(out).not.toContain('f'.repeat(64));
    expect(out).not.toContain('bearer-text-marker');
  });

  it('censors credential keys in child bindings and keeps the safe request label', () => {
    const { log, blob } = capture();
    log
      .child({ password: 'binding-password-marker', meta: { token: 'binding-token-marker' } })
      .info('bound');
    const out = blob();
    expect(out).not.toContain('binding-password-marker');
    expect(out).not.toContain('binding-token-marker');
  });

  it('uses the credential-safe error serializer inside the HTTP request pipeline', () => {
    const { log, blob } = capture();
    const httpLogger = pinoHttp(createPinoHttpOptions(log));
    const failure = new Error('request errored');
    Object.assign(failure, { password: 'http-password-marker', token: 'http-token-marker' });
    httpLogger.logger.error(
      {
        res: { headersSent: true, statusCode: 500, getHeaders: () => ({}) },
        err: failure,
      },
      'request errored',
    );
    const out = blob();
    expect(out).not.toContain('http-password-marker');
    expect(out).not.toContain('http-token-marker');
    expect(out).toContain('request errored');
    expect(out).toContain('"statusCode":500');
  });
});

describe('production logger credential safety regressions', () => {
  it('never emits a credential bound to a child logger at any depth', () => {
    const { log, blob } = capture();
    log.child({ context: { deeper: { password: 'child-binding-marker' } } }).info('safe context');
    const out = blob();
    expect(out).not.toContain('child-binding-marker');
    expect(out).toContain('safe context');
  });

  it('never emits a credential bound to a nested child logger', () => {
    const { log, blob } = capture();
    log
      .child({ context: { deeper: { password: 'nested-binding-marker' } } })
      .child({ deeper: { secret: 'nested-child-marker' } })
      .info('safe context');
    const out = blob();
    expect(out).not.toContain('nested-binding-marker');
    expect(out).not.toContain('nested-child-marker');
  });

  it('never emits an error whose name carries a personal token', () => {
    const { log, blob } = capture();
    const failure = new Error('synthetic driver failure');
    failure.name = PAT_TOKEN;
    log.error({ err: failure }, 'safe context');
    const out = blob();
    expect(out).not.toContain(PAT_TOKEN);
    expect(out).not.toContain(PAT_SECRET);
    expect(out).toContain('synthetic driver failure');
  });

  it('never emits a credential interpolated into a request-shaped payload', () => {
    const { log, blob } = capture();
    log.info('payload %j', { req: { body: { password: 'interpolated-request-marker' } } });
    const out = blob();
    expect(out).not.toContain('interpolated-request-marker');
    expect(out).toContain('[REDACTED]');
  });

  it('never emits a credential interpolated with an error payload', () => {
    const { log, blob } = capture();
    const failure = new Error('synthetic driver failure');
    Object.assign(failure, { password: 'interpolated-error-marker' });
    log.info('payload %j', { err: failure });
    const out = blob();
    expect(out).not.toContain('interpolated-error-marker');
  });

  it('keeps the request metadata and the endpoint label of a real HTTP request', () => {
    const { log, blob } = capture();
    const httpLogger = pinoHttp(createPinoHttpOptions(log));
    httpLogger.logger.info(
      {
        req: {
          id: 'req-http-1',
          method: 'POST',
          url: '/auth/tokens',
          headers: { cookie: 'session=cookie-marker', authorization: 'Bearer header-marker' },
        },
      },
      'request',
    );
    const out = blob();
    expect(out).not.toContain('cookie-marker');
    expect(out).not.toContain('header-marker');
    expect(out).toContain('"url":"/auth/tokens"');
    expect(out).toContain('"id":"req-http-1"');
  });
});
