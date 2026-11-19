import { describe, expect, it } from 'vitest';

import { parseArguments } from '../src/args.js';
import type { CliCommand } from '../src/contract.js';

const OWNER = '0864a7d8-6de5-46f1-9b5e-9e7ef2ef22fa';
const RECORD = '11111111-2222-4333-8444-555555555555';

function command(argv: readonly string[]): CliCommand {
  const parsed = parseArguments(argv);
  if (!parsed.ok) throw new Error(`expected a command, got: ${parsed.message}`);
  return parsed.command;
}

function usage(argv: readonly string[]): { readonly json: boolean; readonly message: string } {
  const parsed = parseArguments(argv);
  if (parsed.ok) throw new Error('expected a usage error');
  return { json: parsed.json, message: parsed.message };
}

describe('the meta commands', () => {
  it('shows the help for every documented spelling', () => {
    expect(command([])).toEqual({ kind: 'help' });
    expect(command(['help'])).toEqual({ kind: 'help' });
    expect(command(['--help'])).toEqual({ kind: 'help' });
    expect(command(['-h'])).toEqual({ kind: 'help' });
  });

  it('shows the version for every documented spelling', () => {
    expect(command(['version'])).toEqual({ kind: 'version' });
    expect(command(['--version'])).toEqual({ kind: 'version' });
  });

  it('accepts the global flag before and after the command', () => {
    expect(parseArguments(['--json', 'help']).json).toBe(true);
    expect(parseArguments(['help', '--json']).json).toBe(true);
    expect(parseArguments(['--json', 'version']).json).toBe(true);
    expect(parseArguments(['version', '--json']).json).toBe(true);
    expect(parseArguments(['help']).json).toBe(false);
  });

  it('refuses a repeated global flag', () => {
    expect(usage(['--json', 'help', '--json']).message).toBe(
      'A flag may not be given more than once.',
    );
  });

  it('refuses a setup or a read flag on the help and the version command', () => {
    expect(usage(['help', '--origin', 'https://api.example.com']).message).toBe(
      'A flag is not allowed for this command.',
    );
    expect(usage(['version', '--profile', 'default']).message).toBe(
      'A flag is not allowed for this command.',
    );
    expect(usage(['--profile', 'default']).message).toBe('A flag is not allowed for this command.');
  });

  it('refuses an unknown command and an unknown flag', () => {
    expect(usage(['create']).message).toBe('The command is not known.');
    expect(usage(['help', '--nope']).message).toBe('A flag is not allowed for this command.');
    expect(usage(['list', '--nope']).message).toBe('A flag is not allowed for this command.');
  });

  it('refuses a short flag other than the help alias', () => {
    expect(usage(['-x']).message).toBe('A flag is not allowed for this command.');
    expect(usage(['list', '-h']).message).toBe('A flag is not allowed for this command.');
  });

  it('refuses a separator and an unexpected argument', () => {
    expect(usage(['--', 'help']).message).toBe('A -- separator is not allowed.');
    expect(usage(['help', 'extra']).message).toBe('An unexpected argument was given.');
    expect(usage(['version', 'extra']).message).toBe('An unexpected argument was given.');
    expect(usage(['list', 'extra']).message).toBe('An unexpected argument was given.');
  });
});

describe('the strict flag rules', () => {
  it('refuses a repeated flag', () => {
    expect(usage(['auth', 'status', '--profile', 'a', '--profile', 'b']).message).toBe(
      'A flag may not be given more than once.',
    );
  });

  it('refuses a missing value, an ambiguous value and a value on a boolean flag', () => {
    expect(usage(['auth', 'status', '--profile']).message).toBe(
      'A flag value is missing or is not allowed.',
    );
    expect(usage(['auth', 'status', '--profile', '--json']).message).toBe(
      'A flag value is missing or is not allowed.',
    );
    expect(usage(['--json=true', 'help']).message).toBe(
      'A flag value is missing or is not allowed.',
    );
  });

  it('accepts both spellings of a string option', () => {
    const separated = command(['auth', 'status', '--profile', 'work']);
    const inline = command(['auth', 'status', '--profile=work']);
    expect(separated).toEqual(inline);
    expect(separated).toEqual({
      kind: 'auth-status',
      auth: { profile: 'work', origin: undefined, allowLoopbackHttp: false },
    });
  });

  it('never reflects the argument vector in a diagnostic', () => {
    const message = usage([
      'list',
      '--from',
      '2026-12-01',
      '--to',
      '2026-12-31',
      '--owner',
      'not-a-uuid',
    ]).message;
    expect(message).toBe('The identifier is not a valid UUID.');
    expect(message).not.toContain('not-a-uuid');
    expect(message).not.toContain('--owner');
  });
});

describe('the auth commands', () => {
  it('stores a credential with the documented defaults', () => {
    expect(command(['auth', 'set', '--origin', 'https://api.example.com'])).toEqual({
      kind: 'auth-set',
      profile: 'default',
      origin: 'https://api.example.com',
      storage: 'keyring',
      allowLoopbackHttp: false,
      tokenStdin: false,
    });
  });

  it('stores a credential with every documented option', () => {
    expect(
      command([
        'auth',
        'set',
        '--origin=https://api.example.com',
        '--profile=work',
        '--storage=file',
        '--allow-loopback-http',
        '--token-stdin',
      ]),
    ).toEqual({
      kind: 'auth-set',
      profile: 'work',
      origin: 'https://api.example.com',
      storage: 'file',
      allowLoopbackHttp: true,
      tokenStdin: true,
    });
  });

  it('refuses a missing origin, an unknown storage and an invalid profile', () => {
    expect(usage(['auth', 'set']).message).toBe('A required option is missing.');
    expect(
      usage(['auth', 'set', '--origin', 'https://a.example', '--storage', 'vault']).message,
    ).toBe('The storage must be keyring or file.');
    expect(
      usage(['auth', 'set', '--origin', 'https://a.example', '--profile', 'Work']).message,
    ).toBe('The profile name is not valid.');
    expect(usage(['auth', 'set', '--origin', 'https://a.example', '--profile', '']).message).toBe(
      'The profile name is not valid.',
    );
  });

  it('refuses a subcommand that is not documented', () => {
    expect(usage(['auth']).message).toBe('The command needs one of its documented subcommands.');
    expect(usage(['auth', 'refresh']).message).toBe(
      'The command needs one of its documented subcommands.',
    );
    expect(usage(['auth', 'set', 'extra']).message).toBe(
      'The command needs one of its documented subcommands.',
    );
  });

  it('reports the status of a profile', () => {
    expect(command(['auth', 'status'])).toEqual({
      kind: 'auth-status',
      auth: { profile: undefined, origin: undefined, allowLoopbackHttp: false },
    });
    expect(
      command([
        'auth',
        'status',
        '--profile',
        'work',
        '--origin',
        'https://api.example.com',
        '--allow-loopback-http',
      ]),
    ).toEqual({
      kind: 'auth-status',
      auth: { profile: 'work', origin: 'https://api.example.com', allowLoopbackHttp: true },
    });
  });

  it('removes a local profile with the documented default', () => {
    expect(command(['auth', 'remove'])).toEqual({ kind: 'auth-remove', profile: 'default' });
    expect(command(['auth', 'remove', '--profile', 'work'])).toEqual({
      kind: 'auth-remove',
      profile: 'work',
    });
  });

  it('refuses a read flag on the removal command', () => {
    expect(usage(['auth', 'remove', '--origin', 'https://api.example.com']).message).toBe(
      'A flag is not allowed for this command.',
    );
  });

  it('refuses a flag that the auth command does not document', () => {
    expect(usage(['auth', 'set', '--mine']).message).toBe(
      'A flag is not allowed for this command.',
    );
    expect(usage(['auth', 'status', '--token-stdin']).message).toBe(
      'A flag is not allowed for this command.',
    );
    expect(usage(['auth', 'status', '--from', '2026-12-01']).message).toBe(
      'A flag is not allowed for this command.',
    );
  });

  it('refuses an invalid profile on every command that names one', () => {
    expect(usage(['auth', 'status', '--profile', 'Work']).message).toBe(
      'The profile name is not valid.',
    );
    expect(usage(['auth', 'remove', '--profile', 'Work']).message).toBe(
      'The profile name is not valid.',
    );
    expect(
      usage(['list', '--from', '2026-12-01', '--to', '2026-12-31', '--profile', 'Work']).message,
    ).toBe('The profile name is not valid.');
    expect(usage(['get', RECORD, '--profile', 'Work']).message).toBe(
      'The profile name is not valid.',
    );
  });
});

describe('the origin rules', () => {
  it('canonicalizes an origin', () => {
    expect(command(['auth', 'status', '--origin', 'https://API.Example.COM/'])).toEqual({
      kind: 'auth-status',
      auth: { profile: undefined, origin: 'https://api.example.com', allowLoopbackHttp: false },
    });
    expect(command(['auth', 'status', '--origin', 'https://api.example.com:443'])).toEqual({
      kind: 'auth-status',
      auth: { profile: undefined, origin: 'https://api.example.com', allowLoopbackHttp: false },
    });
  });

  it('refuses a hostile or an ambiguous origin', () => {
    for (const raw of [
      'https://api.example.com/v1',
      'https://api.example.com/pto',
      'https://user@api.example.com',
      'https://api.example.com?query=1',
      'https://api.example.com#fragment',
      'https://%61pi.example.com',
      'https://api.example.com\\path',
      'https://2130706433',
      'https://api.example.com..',
      'https://api..example.com',
      'https://api.example.com:99999',
      'ftp://api.example.com',
      'file:///etc/passwd',
      'api.example.com',
      '',
    ]) {
      expect(usage(['auth', 'status', '--origin', raw]).message).toBe(
        'The origin is not a valid trusted origin.',
      );
    }
  });

  it('refuses plain HTTP for a remote host', () => {
    expect(usage(['auth', 'status', '--origin', 'http://api.example.com']).message).toBe(
      'Only an HTTPS origin is allowed for a remote host.',
    );
  });

  it('admits a syntactically valid loopback expectation', () => {
    expect(command(['auth', 'status', '--origin', 'http://localhost:3000'])).toEqual({
      kind: 'auth-status',
      auth: { profile: undefined, origin: 'http://localhost:3000', allowLoopbackHttp: false },
    });
    expect(command(['auth', 'status', '--origin', 'http://127.0.0.1:3000'])).toEqual({
      kind: 'auth-status',
      auth: { profile: undefined, origin: 'http://127.0.0.1:3000', allowLoopbackHttp: false },
    });
    expect(command(['auth', 'status', '--origin', 'http://[::1]:3000'])).toEqual({
      kind: 'auth-status',
      auth: { profile: undefined, origin: 'http://[::1]:3000', allowLoopbackHttp: false },
    });
  });

  it('refuses an origin that is too long', () => {
    expect(
      usage(['auth', 'status', '--origin', `https://${'a'.repeat(600)}.example`]).message,
    ).toBe('The origin is not a valid trusted origin.');
  });
});

describe('the list command', () => {
  it('reads an explicit range with the documented defaults', () => {
    expect(command(['list', '--from', '2026-12-01', '--to', '2026-12-31'])).toEqual({
      kind: 'list',
      auth: { profile: undefined, origin: undefined, allowLoopbackHttp: false },
      from: '2026-12-01',
      to: '2026-12-31',
      ownerId: undefined,
      mine: false,
      pageSize: 100,
      maxPages: 30,
    });
  });

  it('accepts the owner filter and the own-records filter', () => {
    expect(command(['list', '--from=2026-12-01', '--to=2026-12-31', '--owner', OWNER])).toEqual({
      kind: 'list',
      auth: { profile: undefined, origin: undefined, allowLoopbackHttp: false },
      from: '2026-12-01',
      to: '2026-12-31',
      ownerId: OWNER,
      mine: false,
      pageSize: 100,
      maxPages: 30,
    });
    expect(command(['list', '--from', '2026-12-01', '--to', '2026-12-31', '--mine'])).toEqual({
      kind: 'list',
      auth: { profile: undefined, origin: undefined, allowLoopbackHttp: false },
      from: '2026-12-01',
      to: '2026-12-31',
      ownerId: undefined,
      mine: true,
      pageSize: 100,
      maxPages: 30,
    });
  });

  it('refuses both filters at once and an invalid owner', () => {
    expect(
      usage(['list', '--from', '2026-12-01', '--to', '2026-12-31', '--mine', '--owner', OWNER])
        .message,
    ).toBe('The own-records filter and the owner filter cannot be combined.');
    expect(
      usage(['list', '--from', '2026-12-01', '--to', '2026-12-31', '--owner', 'x']).message,
    ).toBe('The identifier is not a valid UUID.');
  });

  it('refuses a missing or an impossible date', () => {
    expect(usage(['list', '--from', '2026-12-01']).message).toBe('A required option is missing.');
    expect(usage(['list', '--to', '2026-12-01']).message).toBe('A required option is missing.');
    expect(usage(['list', '--from', '2026-02-30', '--to', '2026-03-01']).message).toBe(
      'The date is not a real calendar date.',
    );
    expect(usage(['list', '--from', '2026-12-01', '--to', '2026-12-01', '--from']).message).toBe(
      'A flag value is missing or is not allowed.',
    );
    expect(usage(['list', '--from', '2026-13-01', '--to', '2026-12-31']).message).toBe(
      'The date is not a real calendar date.',
    );
    expect(usage(['list', '--from', '2026-1-1', '--to', '2026-12-31']).message).toBe(
      'The date is not a real calendar date.',
    );
    expect(usage(['list', '--from', 'yesterday', '--to', '2026-12-31']).message).toBe(
      'The date is not a real calendar date.',
    );
  });

  it('refuses a reversed range and a range that is too long', () => {
    expect(usage(['list', '--from', '2026-12-31', '--to', '2026-12-01']).message).toBe(
      'The date range must be ordered and at most 366 days long.',
    );
    expect(usage(['list', '--from', '2026-01-01', '--to', '2027-01-02']).message).toBe(
      'The date range must be ordered and at most 366 days long.',
    );
    expect(command(['list', '--from', '2026-01-01', '--to', '2027-01-01'])).toBeTruthy();
  });

  it('refuses a page size and a page count outside their bounds', () => {
    expect(
      usage(['list', '--from', '2026-12-01', '--to', '2026-12-31', '--page-size', '0']).message,
    ).toBe('The page size must be a number between 1 and 200.');
    expect(
      usage(['list', '--from', '2026-12-01', '--to', '2026-12-31', '--page-size', '201']).message,
    ).toBe('The page size must be a number between 1 and 200.');
    expect(
      usage(['list', '--from', '2026-12-01', '--to', '2026-12-31', '--page-size', '10.5']).message,
    ).toBe('The page size must be a number between 1 and 200.');
    expect(
      usage(['list', '--from', '2026-12-01', '--to', '2026-12-31', '--page-size', 'x']).message,
    ).toBe('The page size must be a number between 1 and 200.');
    expect(
      usage(['list', '--from', '2026-12-01', '--to', '2026-12-31', '--max-pages', '31']).message,
    ).toBe('The page count must be a number between 1 and 30.');
    expect(
      usage(['list', '--from', '2026-12-01', '--to', '2026-12-31', '--max-pages', '0']).message,
    ).toBe('The page count must be a number between 1 and 30.');
  });

  it('accepts a page size and a page count inside their bounds', () => {
    const listed = command([
      'list',
      '--from',
      '2026-12-01',
      '--to',
      '2026-12-31',
      '--page-size',
      '200',
      '--max-pages',
      '30',
    ]);
    expect(listed).toMatchObject({ pageSize: 200, maxPages: 30 });
  });
});

describe('the get command', () => {
  it('reads one record by its canonical identifier', () => {
    expect(command(['get', RECORD])).toEqual({
      kind: 'get',
      auth: { profile: undefined, origin: undefined, allowLoopbackHttp: false },
      id: RECORD,
    });
  });

  it('refuses a missing or an invalid identifier', () => {
    expect(usage(['get']).message).toBe('An unexpected argument was given.');
    expect(usage(['get', 'not-a-uuid']).message).toBe('The identifier is not a valid UUID.');
    expect(usage(['get', RECORD, 'extra']).message).toBe('An unexpected argument was given.');
  });

  it('refuses a setup flag on the read command', () => {
    expect(usage(['get', RECORD, '--token-stdin']).message).toBe(
      'A flag is not allowed for this command.',
    );
  });
});

describe('the machine flag of a usage error', () => {
  it('selects the machine envelope when the global flag was given', () => {
    expect(usage(['--json', 'list', '--nope']).json).toBe(true);
    expect(usage(['list', '--nope', '--json']).json).toBe(true);
    expect(usage(['list', '--from', '--json']).json).toBe(true);
    expect(usage(['list', '--nope']).json).toBe(false);
  });

  it('is not selected by a global flag that carries a value', () => {
    expect(usage(['--json=true', 'help']).json).toBe(false);
  });
});

it('refuses loopback HTTP setup without the explicit flag at argument parsing', () => {
  const result = usage(['auth', 'set', '--origin', 'http://localhost:3000', '--json']);
  expect(result.json).toBe(true);
  expect(result.message).toContain('opt in');
});
