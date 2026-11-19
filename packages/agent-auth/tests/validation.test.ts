import { describe, expect, it } from 'vitest';
import { AgentAuthError } from '../src/errors.js';
import {
  normalizeOrigin,
  requireProfileName,
  requireToken,
  validateStoredProfile,
} from '../src/validation.js';

const origin = 'https://pto.example.invalid';
const token = `pto_pat_a1111111-1111-4111-8111-111111111111.${'a'.repeat(64)}`;
const metadata = {
  version: 1,
  profile: 'default',
  origin,
  allowLoopbackHttp: false,
  storage: 'keyring',
};

describe('explicit origin and credential admission', () => {
  it('accepts just canonical profile identifiers and credentials', () => {
    expect(requireProfileName('west-1_a')).toBe('west-1_a');
    for (const value of [null, '', '..', 'Default', 'x'.repeat(33), 'a\n', 'other/path']) {
      expect(() => requireProfileName(value)).toThrow(
        expect.objectContaining({ code: 'INVALID_PROFILE' }),
      );
    }
    expect(requireToken(token)).toBe(token);
    for (const value of [null, '', `${token}\n`, `Bearer ${token}`, token.toUpperCase()]) {
      expect(() => requireToken(value)).toThrow(expect.objectContaining({ code: 'INVALID_TOKEN' }));
    }
  });

  it('normalizes HTTPS without accepting paths or origin disguises', () => {
    expect(normalizeOrigin('HTTPS://PTO.EXAMPLE.INVALID:443/')).toBe(origin);
    expect(normalizeOrigin(`${origin}:5173/`)).toBe(`${origin}:5173`);
    for (const value of [
      null,
      '',
      'x'.repeat(513),
      `${origin}?`,
      `${origin}#`,
      `${origin}\n`,
      'https://@pto.example.invalid',
      'https://pto..example.invalid',
      'https://[0:0:0:0:0:0:0:1]',
      'https://256.0.0.1',
      'https://pto.example.invalid/a/..',
      'http://pto.example.invalid',
    ]) {
      expect(() => normalizeOrigin(value, true)).toThrow(
        expect.objectContaining({ code: 'INVALID_ORIGIN' }),
      );
    }
  });

  it('permits exact loopback origins only by explicit opt-in', () => {
    for (const host of ['127.0.0.1', '[::1]', 'localhost']) {
      const loopback = `http://${host}:5173`;
      expect(normalizeOrigin(loopback, true)).toBe(loopback);
      expect(() => normalizeOrigin(loopback)).toThrow(AgentAuthError);
    }
    expect(() => normalizeOrigin('http://127.1:5173', true)).toThrow(AgentAuthError);
  });
});

describe('stored profile validation', () => {
  it('returns only the record for the selected fixed storage and origin', () => {
    expect(validateStoredProfile(metadata, 'default')).toEqual(metadata);
    const file = { ...metadata, storage: 'file', token };
    expect(validateStoredProfile(file, 'default')).toEqual(file);
    const dev = { ...metadata, origin: 'http://localhost:3000', allowLoopbackHttp: true };
    expect(validateStoredProfile(dev, 'default')).toEqual(dev);
  });

  it('refuses malformed, differently bound and unapproved secret metadata', () => {
    const hidden = Object.defineProperty({ ...metadata }, 'origin', { enumerable: false });
    const getter = {
      ...metadata,
      get origin() {
        throw new Error('must not execute');
      },
    };
    for (const value of [
      'json',
      null,
      [],
      {},
      { ...metadata, storage: 'other' },
      { ...metadata, token },
      { ...metadata, profile: 'another' },
      { ...metadata, version: 2 },
      { ...metadata, allowLoopbackHttp: null },
      { ...metadata, origin: `${origin}/` },
      { ...metadata, origin: 'http://localhost' },
      { ...metadata, storage: 'file', token: 'not a token' },
      { ...metadata, storage: 'file' },
      { ...metadata, token, storage: 'keyring', description: 'extra' },
      hidden,
      getter,
    ]) {
      expect(() => validateStoredProfile(value, 'default')).toThrow(
        expect.objectContaining({ code: 'PROFILE_CORRUPT' }),
      );
    }
    expect(() => validateStoredProfile({ ...metadata, profile: '..' }, '..')).toThrow(
      expect.objectContaining({ code: 'PROFILE_CORRUPT' }),
    );
  });
});

it('links errors to fixed safe hints rather than the rejected values', () => {
  const error = new AgentAuthError('CREDENTIAL_MISSING');
  expect(error).toMatchObject({ name: 'AgentAuthError', code: 'CREDENTIAL_MISSING' });
  expect(error.message).toMatch(/local credential/);
  expect(error.cause).toBeUndefined();
  expect(JSON.stringify(error)).not.toContain(token);
});
