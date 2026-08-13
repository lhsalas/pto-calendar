import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { clientIpKey } from './rateLimit.js';

describe('clientIpKey', () => {
  it('uses Express trusted-proxy resolution instead of raw forwarding headers', () => {
    const req = {
      ip: '203.0.113.7',
      socket: { remoteAddress: '127.0.0.1' },
      headers: { 'x-forwarded-for': '198.51.100.10, 203.0.113.7' },
    } as unknown as Request;

    expect(clientIpKey(req)).toBe('203.0.113.7');
  });

  it('falls back to the socket address when Express has no IP', () => {
    const req = {
      ip: undefined,
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;

    expect(clientIpKey(req)).toBe('127.0.0.1');
  });
});
