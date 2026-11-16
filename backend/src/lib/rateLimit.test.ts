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

  it.each([
    ['2001:db8:abcd:1200::1', '2001:db8:abcd:1200::/56'],
    ['2001:db8:abcd:12ff:ffff::1', '2001:db8:abcd:1200::/56'],
    ['2001:0db8:abcd:1200:0000:0000:0000:0001', '2001:db8:abcd:1200::/56'],
    ['2001:db8:abcd:1300::1', '2001:db8:abcd:1300::/56'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::ffff:cb00:7107', '203.0.113.7'],
  ])('normalizes %s without splitting the same client subnet', (ip, expected) => {
    const req = { ip, socket: { remoteAddress: '127.0.0.1' } } as Request;
    expect(clientIpKey(req)).toBe(expected);
  });

  it.each([undefined, '', 'garbage', '203.0.113.7:12345', '[2001:db8::1]:443'])(
    'uses a valid socket fallback for invalid Express IP %s',
    (ip) => {
      const req = { ip, socket: { remoteAddress: '2001:db8:abcd:1200::1' } } as Request;
      expect(clientIpKey(req)).toBe('2001:db8:abcd:1200::/56');
    },
  );

  it.each(['attacker-a', 'attacker-b:443', '', undefined])(
    'bounds unusable address %s to the shared unknown key',
    (ip) => {
      const req = { ip, socket: { remoteAddress: undefined } } as Request;
      expect(clientIpKey(req)).toBe('unknown');
    },
  );
});
