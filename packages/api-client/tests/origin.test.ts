import { describe, expect, it } from 'vitest';
import { PtoApiError } from '../src/errors.js';
import { parseTrustedOrigin, sameOrigin } from '../src/origin.js';

describe('trusted origins', () => {
  it('normalizes an HTTPS origin and drops the default port', () => {
    const origin = parseTrustedOrigin('https://api.example.com');
    expect(origin.value).toBe('https://api.example.com');
    expect(origin.protocol).toBe('https:');
    expect(origin.host).toBe('api.example.com');
    expect(origin.port).toBeNull();
    expect(origin.isLoopback).toBe(false);
    expect(parseTrustedOrigin('https://api.example.com:443').value).toBe('https://api.example.com');
    expect(parseTrustedOrigin('https://api.example.com:8443').value).toBe(
      'https://api.example.com:8443',
    );
    expect(parseTrustedOrigin('https://API.Example.COM').value).toBe('https://api.example.com');
    expect(parseTrustedOrigin('https://api.example.com/').value).toBe('https://api.example.com');
  });

  it('refuses anything that is not a plain origin', () => {
    for (const raw of [
      'https://api.example.com/v1',
      'https://api.example.com/pto',
      'https://api.example.com/v1/..',
      'https://api.example.com/%2e',
      'https://%61pi.example.com',
      'https://user@api.example.com',
      'https://@api.example.com',
      'https://api.example.com?query=1',
      'https://api.example.com?',
      'https://api.example.com#fragment',
      'https://api.example.com#',
      'https://api.example.com\\path',
      'https://api.example.com/path\\x',
      'https://api example.com',
      'https://api.example.com\t',
      'https://api.example.com ',
      'https://api.example.com\n',
      'ftp://api.example.com',
      'file://api.example.com',
      'javascript://api.example.com',
      'https://',
      'https:///path',
      'api.example.com',
      '',
      '   ',
      'https://api.example.com:port',
      'https://api.example.com:0',
      'https://api.example.com:0443',
      'https://api.example.com:',
      'https://api.example.com:65536',
      'https://api..example.com',
      'https://.api.example.com',
      'https://api.example.com.',
      'https://[::1',
      'https://[::1]x',
    ]) {
      expect(() => parseTrustedOrigin(raw)).toThrow(PtoApiError);
      try {
        parseTrustedOrigin(raw);
      } catch (err) {
        expect((err as PtoApiError).code).toBe('INVALID_OPTIONS');
      }
    }
  });

  it('accepts plain HTTP only for the exact loopback hosts and only on request', () => {
    expect(() => parseTrustedOrigin('http://127.0.0.1:8080')).toThrow(PtoApiError);
    const loopback = parseTrustedOrigin('http://127.0.0.1:8080', true);
    expect(loopback.value).toBe('http://127.0.0.1:8080');
    expect(loopback.isLoopback).toBe(true);
    expect(parseTrustedOrigin('http://[::1]:8080', true).value).toBe('http://[::1]:8080');
    expect(parseTrustedOrigin('http://localhost:8080', true).value).toBe('http://localhost:8080');
    expect(parseTrustedOrigin('http://localhost', true).value).toBe('http://localhost');
  });

  it('rejects obfuscated loopback literals instead of normalizing them into allowlisted hosts', () => {
    for (const raw of [
      'http://127.1',
      'http://2130706433',
      'http://0x7f.0.0.1',
      'http://[0:0:0:0:0:0:0:1]',
    ]) {
      expect(() => parseTrustedOrigin(raw, true)).toThrow(PtoApiError);
    }
    expect(parseTrustedOrigin('http://LOCALHOST', true).host).toBe('localhost');
  });

  it('refuses a host that only looks like a loopback host', () => {
    for (const raw of [
      'http://127.0.0.2',
      'http://localhost.localdomain',
      'http://127.0.0.1.evil.example',
    ]) {
      expect(() => parseTrustedOrigin(raw, true)).toThrow(PtoApiError);
    }
  });

  it('compares origins by their normalized value', () => {
    expect(
      sameOrigin(
        parseTrustedOrigin('https://a.example.com'),
        parseTrustedOrigin('https://a.example.com:443'),
      ),
    ).toBe(true);
    expect(
      sameOrigin(
        parseTrustedOrigin('https://a.example.com'),
        parseTrustedOrigin('https://b.example.com'),
      ),
    ).toBe(false);
    expect(
      sameOrigin(
        parseTrustedOrigin('https://a.example.com'),
        parseTrustedOrigin('http://127.0.0.1', true),
      ),
    ).toBe(false);
  });
});
