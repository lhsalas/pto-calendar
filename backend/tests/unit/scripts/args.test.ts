import { describe, expect, it } from 'vitest';
import { parseBootstrapArgs, parseSeedHolidaysArgs } from '../../../scripts/args.js';

describe('parseSeedHolidaysArgs', () => {
  it('accepts --country <code> (space-separated)', () => {
    expect(parseSeedHolidaysArgs(['--country', 'CO'])).toEqual({
      countryCode: 'CO',
      all: false,
    });
  });

  it('accepts --country=<code> (equals form)', () => {
    expect(parseSeedHolidaysArgs(['--country=CO'])).toEqual({
      countryCode: 'CO',
      all: false,
    });
  });

  it('accepts --all', () => {
    expect(parseSeedHolidaysArgs(['--all'])).toEqual({
      countryCode: undefined,
      all: true,
    });
  });

  it('accepts --all with --country <code>', () => {
    expect(parseSeedHolidaysArgs(['--all', '--country', 'CO'])).toEqual({
      countryCode: 'CO',
      all: true,
    });
  });

  it('accepts --all with --country=<code>', () => {
    expect(parseSeedHolidaysArgs(['--all', '--country=CO'])).toEqual({
      countryCode: 'CO',
      all: true,
    });
  });

  it('returns empty result for no args (caller raises user-facing error)', () => {
    expect(parseSeedHolidaysArgs([])).toEqual({
      countryCode: undefined,
      all: false,
    });
  });

  it('rejects unknown flags (strict)', () => {
    expect(() => parseSeedHolidaysArgs(['--bad-flag'])).toThrow();
  });

  it('rejects --country with no value', () => {
    expect(() => parseSeedHolidaysArgs(['--country'])).toThrow();
  });

  it('rejects positional arguments', () => {
    expect(() => parseSeedHolidaysArgs(['CO'])).toThrow();
  });
});

describe('parseBootstrapArgs', () => {
  it('accepts --base-url <url> (space-separated)', () => {
    expect(parseBootstrapArgs(['--base-url', 'https://example.com'])).toEqual({
      baseUrl: 'https://example.com',
    });
  });

  it('accepts --base-url=<url> (equals form)', () => {
    expect(parseBootstrapArgs(['--base-url=https://example.com'])).toEqual({
      baseUrl: 'https://example.com',
    });
  });

  it('returns empty result for no args', () => {
    expect(parseBootstrapArgs([])).toEqual({ baseUrl: undefined });
  });

  it('rejects unknown flags (strict)', () => {
    expect(() => parseBootstrapArgs(['--bad-flag'])).toThrow();
  });

  it('rejects --base-url with no value', () => {
    expect(() => parseBootstrapArgs(['--base-url'])).toThrow();
  });

  it('rejects positional arguments', () => {
    expect(() => parseBootstrapArgs(['https://example.com'])).toThrow();
  });
});
