import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACT_CENSOR, REDACT_PATHS } from './logger.js';

function makeCapturingLogger(): { log: pino.Logger; lines: string[] } {
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
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.secret',
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
