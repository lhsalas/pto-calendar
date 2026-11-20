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
    expect(usage(['create-all']).message).toBe('The command is not known.');
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

  it('refuses a value option without a value before any command', () => {
    expect(usage(['--profile']).message).toBe('A flag value is missing or is not allowed.');
    expect(usage(['--profile', '--json']).message).toBe(
      'A flag value is missing or is not allowed.',
    );
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

describe('the write commands', () => {
  it('creates a record for the owner of the credential', () => {
    expect(
      command(['create', '--from', '2026-12-01', '--to', '2026-12-01', '--day-part', 'morning']),
    ).toEqual({
      kind: 'create',
      auth: { profile: undefined, origin: undefined, allowLoopbackHttp: false },
      yes: false,
      payload: { startDate: '2026-12-01', endDate: '2026-12-01', dayPart: 'morning' },
      operationId: undefined,
    });
  });

  it('creates a record with every documented option', () => {
    expect(
      command([
        'create',
        '--from=2026-12-01',
        '--to=2026-12-31',
        '--day-part=all_day',
        '--note=Doctor appointment',
        '--operation=9f1b0d3a-4c2e-4b8a-9f31-2c7d5e6f8a10',
        '--yes',
        '--profile=work',
        '--origin=https://api.example.com',
        '--allow-loopback-http',
      ]),
    ).toEqual({
      kind: 'create',
      auth: { profile: 'work', origin: 'https://api.example.com', allowLoopbackHttp: true },
      yes: true,
      payload: {
        startDate: '2026-12-01',
        endDate: '2026-12-31',
        dayPart: 'all_day',
        note: 'Doctor appointment',
      },
      operationId: '9f1b0d3a-4c2e-4b8a-9f31-2c7d5e6f8a10',
    });
  });

  it('refuses a create without its dates or its day part', () => {
    expect(usage(['create', '--to', '2026-12-01', '--day-part', 'morning']).message).toBe(
      'A required option is missing.',
    );
    expect(usage(['create', '--from', '2026-12-01', '--day-part', 'morning']).message).toBe(
      'A required option is missing.',
    );
    expect(usage(['create', '--from', '2026-12-01', '--to', '2026-12-01']).message).toBe(
      'A required option is missing.',
    );
  });

  it('refuses a date that is not a real calendar date', () => {
    expect(
      usage(['create', '--from', '2026-02-30', '--to', '2026-03-02', '--day-part', 'morning'])
        .message,
    ).toBe('The date is not a real calendar date.');
    expect(
      usage(['create', '--from', 'next monday', '--to', '2026-03-02', '--day-part', 'morning'])
        .message,
    ).toBe('The date is not a real calendar date.');
  });

  it('refuses a weekend endpoint without moving the date', () => {
    expect(
      usage(['create', '--from', '2026-12-05', '--to', '2026-12-08', '--day-part', 'morning'])
        .message,
    ).toBe('A date must not fall on a weekend.');
    expect(
      usage(['create', '--from', '2026-12-01', '--to', '2026-12-06', '--day-part', 'morning'])
        .message,
    ).toBe('A date must not fall on a weekend.');
  });

  it('refuses a reversed range and a range that is too long', () => {
    expect(
      usage(['create', '--from', '2026-12-31', '--to', '2026-12-01', '--day-part', 'all_day'])
        .message,
    ).toBe('The date range must be ordered and at most 366 days long.');
    expect(
      usage(['create', '--from', '2026-01-05', '--to', '2027-01-06', '--day-part', 'all_day'])
        .message,
    ).toBe('The date range must be ordered and at most 366 days long.');
    expect(
      command(['create', '--from', '2026-01-05', '--to', '2027-01-05', '--day-part', 'all_day']),
    ).toBeTruthy();
  });

  it('refuses a day part outside the current vocabulary', () => {
    expect(
      usage(['create', '--from', '2026-12-01', '--to', '2026-12-01', '--day-part', 'full_day'])
        .message,
    ).toBe('The day part must be morning, evening or all_day.');
    expect(
      usage(['create', '--from', '2026-12-01', '--to', '2026-12-01', '--day-part', 'Morning'])
        .message,
    ).toBe('The day part must be morning, evening or all_day.');
  });

  it('refuses a note that is longer than the service accepts', () => {
    expect(
      usage([
        'create',
        '--from',
        '2026-12-01',
        '--to',
        '2026-12-01',
        '--day-part',
        'morning',
        '--note',
        'a'.repeat(501),
      ]).message,
    ).toBe('The note must be 500 characters or fewer.');
    expect(
      command([
        'create',
        '--from',
        '2026-12-01',
        '--to',
        '2026-12-01',
        '--day-part',
        'morning',
        '--note',
        'a'.repeat(500),
      ]),
    ).toBeTruthy();
  });

  it('leaves an empty note out of a create', () => {
    expect(
      command([
        'create',
        '--from',
        '2026-12-01',
        '--to',
        '2026-12-01',
        '--day-part',
        'morning',
        '--note=',
      ]),
    ).toMatchObject({ payload: { startDate: '2026-12-01', endDate: '2026-12-01' } });
    expect(
      command([
        'create',
        '--from',
        '2026-12-01',
        '--to',
        '2026-12-01',
        '--day-part',
        'morning',
        '--note=',
      ]),
    ).not.toMatchObject({ payload: { note: expect.anything() } });
  });

  it('refuses an operation identifier that is not a random UUIDv4', () => {
    expect(
      usage([
        'create',
        '--from',
        '2026-12-01',
        '--to',
        '2026-12-01',
        '--day-part',
        'morning',
        '--operation',
        'not-a-uuid',
      ]).message,
    ).toBe('The operation identifier is not a valid UUID.');
    expect(
      usage([
        'create',
        '--from',
        '2026-12-01',
        '--to',
        '2026-12-01',
        '--day-part',
        'morning',
        '--operation',
        '11111111-2222-1333-8444-555555555555',
      ]).message,
    ).toBe('The operation identifier is not a valid UUID.');
  });

  it('refuses an unexpected word and a flag the create does not document', () => {
    expect(usage(['create', 'extra']).message).toBe('An unexpected argument was given.');
    expect(
      usage([
        'create',
        '--from',
        '2026-12-01',
        '--to',
        '2026-12-01',
        '--day-part',
        'morning',
        '--owner',
        OWNER,
      ]).message,
    ).toBe('A flag is not allowed for this command.');
    expect(
      usage([
        'create',
        '--from',
        '2026-12-01',
        '--to',
        '2026-12-01',
        '--day-part',
        'morning',
        '--clear-note',
      ]).message,
    ).toBe('A flag is not allowed for this command.');
    expect(
      usage([
        'create',
        '--from',
        '2026-12-01',
        '--to',
        '2026-12-01',
        '--day-part',
        'morning',
        '--version',
        '1',
      ]).message,
    ).toBe('A flag is not allowed for this command.');
  });

  it('updates one exact record with the fields that change', () => {
    expect(command(['update', RECORD, '--version', '3', '--day-part', 'evening'])).toEqual({
      kind: 'update',
      auth: { profile: undefined, origin: undefined, allowLoopbackHttp: false },
      yes: false,
      id: RECORD,
      version: 3,
      changes: { dayPart: 'evening' },
    });
  });

  it('updates a record with every documented option', () => {
    expect(
      command([
        'update',
        RECORD,
        '--version=3',
        '--from=2026-12-01',
        '--to=2026-12-02',
        '--day-part=morning',
        '--note=Back from a trip',
        '--yes',
        '--profile=work',
        '--origin=https://api.example.com',
        '--allow-loopback-http',
      ]),
    ).toEqual({
      kind: 'update',
      auth: { profile: 'work', origin: 'https://api.example.com', allowLoopbackHttp: true },
      yes: true,
      id: RECORD,
      version: 3,
      changes: {
        startDate: '2026-12-01',
        endDate: '2026-12-02',
        dayPart: 'morning',
        note: 'Back from a trip',
      },
    });
  });

  it('refuses an update without a version and with a version outside its bounds', () => {
    expect(usage(['update', RECORD, '--day-part', 'evening']).message).toBe(
      'A required option is missing.',
    );
    for (const version of ['0', 'x', '2147483648', '1.5', '01']) {
      expect(usage(['update', RECORD, '--version', version]).message).toBe(
        'The version must be a number between 1 and 2147483647.',
      );
    }
    expect(usage(['update', RECORD, '--version', '-1']).message).toBe(
      'A flag value is missing or is not allowed.',
    );
    expect(
      command(['update', RECORD, '--version', '2147483647', '--day-part', 'evening']),
    ).toBeTruthy();
    expect(command(['update', RECORD, '--version', '1', '--day-part', 'evening'])).toBeTruthy();
  });

  it('refuses an update of a record that is not named exactly', () => {
    expect(usage(['update', 'not-a-uuid', '--version', '1', '--day-part', 'evening']).message).toBe(
      'The identifier is not a valid UUID.',
    );
    expect(usage(['update']).message).toBe('An unexpected argument was given.');
    expect(usage(['update', RECORD, 'extra', '--version', '1']).message).toBe(
      'An unexpected argument was given.',
    );
  });

  it('refuses an update that changes nothing', () => {
    expect(usage(['update', RECORD, '--version', '1']).message).toBe(
      'A partial update must change at least one field.',
    );
    expect(usage(['update', RECORD, '--version', '1', '--yes']).message).toBe(
      'A partial update must change at least one field.',
    );
  });

  it('keeps a stored note when no note option is given', () => {
    const parsed = command(['update', RECORD, '--version', '1', '--day-part', 'evening']);
    expect(parsed.kind).toBe('update');
    if (parsed.kind !== 'update') throw new Error('expected an update command');
    expect(Object.keys(parsed.changes)).toEqual(['dayPart']);
  });

  it('clears a note with the clear flag and with an empty note', () => {
    expect(command(['update', RECORD, '--version', '1', '--clear-note'])).toMatchObject({
      changes: { note: null },
    });
    expect(command(['update', RECORD, '--version', '1', '--note='])).toMatchObject({
      changes: { note: null },
    });
  });

  it('refuses a note and the clear flag at once', () => {
    expect(usage(['update', RECORD, '--version', '1', '--note=x', '--clear-note']).message).toBe(
      'The note and the clear-note flag cannot be combined.',
    );
    expect(usage(['update', RECORD, '--version', '1', '--note=', '--clear-note']).message).toBe(
      'The note and the clear-note flag cannot be combined.',
    );
  });

  it('refuses an update with a date that is not a real calendar date', () => {
    expect(usage(['update', RECORD, '--version', '1', '--from', '2026-02-30']).message).toBe(
      'The date is not a real calendar date.',
    );
  });

  it('refuses an update with a weekend endpoint', () => {
    expect(usage(['update', RECORD, '--version', '1', '--from', '2026-12-05']).message).toBe(
      'A date must not fall on a weekend.',
    );
    expect(usage(['update', RECORD, '--version', '1', '--to', '2026-12-06']).message).toBe(
      'A date must not fall on a weekend.',
    );
  });

  it('refuses an update whose named range is reversed or too long', () => {
    expect(
      usage(['update', RECORD, '--version', '1', '--from', '2026-12-31', '--to', '2026-12-01'])
        .message,
    ).toBe('The date range must be ordered and at most 366 days long.');
    expect(
      usage(['update', RECORD, '--version', '1', '--from', '2026-01-05', '--to', '2027-01-06'])
        .message,
    ).toBe('The date range must be ordered and at most 366 days long.');
    expect(
      command(['update', RECORD, '--version', '1', '--from', '2026-01-05', '--to', '2027-01-05']),
    ).toBeTruthy();
  });

  it('refuses an update with a day part outside the current vocabulary', () => {
    expect(usage(['update', RECORD, '--version', '1', '--day-part', 'day']).message).toBe(
      'The day part must be morning, evening or all_day.',
    );
  });

  it('refuses an update with a note that is longer than the service accepts', () => {
    expect(usage(['update', RECORD, '--version', '1', '--note', 'a'.repeat(501)]).message).toBe(
      'The note must be 500 characters or fewer.',
    );
  });

  it('refuses a flag the update does not document', () => {
    expect(
      usage(['update', RECORD, '--version', '1', '--day-part', 'evening', '--operation', OWNER])
        .message,
    ).toBe('A flag is not allowed for this command.');
    expect(
      usage(['update', RECORD, '--version', '1', '--day-part', 'evening', '--mine']).message,
    ).toBe('A flag is not allowed for this command.');
  });

  it('deletes one exact record with its expected version', () => {
    expect(command(['delete', RECORD, '--version', '2'])).toEqual({
      kind: 'delete',
      auth: { profile: undefined, origin: undefined, allowLoopbackHttp: false },
      yes: false,
      id: RECORD,
      version: 2,
    });
  });

  it('deletes a record with every documented option', () => {
    expect(
      command([
        'delete',
        RECORD,
        '--version=2',
        '--yes',
        '--profile=work',
        '--origin=https://api.example.com',
        '--allow-loopback-http',
      ]),
    ).toEqual({
      kind: 'delete',
      auth: { profile: 'work', origin: 'https://api.example.com', allowLoopbackHttp: true },
      yes: true,
      id: RECORD,
      version: 2,
    });
  });

  it('refuses a delete without a version and with a version outside its bounds', () => {
    expect(usage(['delete', RECORD]).message).toBe('A required option is missing.');
    expect(usage(['delete', RECORD, '--version', '0']).message).toBe(
      'The version must be a number between 1 and 2147483647.',
    );
    expect(usage(['delete', RECORD, '--version', '2147483648']).message).toBe(
      'The version must be a number between 1 and 2147483647.',
    );
  });

  it('refuses a delete of a record that is not named exactly', () => {
    expect(usage(['delete', 'not-a-uuid', '--version', '1']).message).toBe(
      'The identifier is not a valid UUID.',
    );
    expect(usage(['delete']).message).toBe('An unexpected argument was given.');
    expect(usage(['delete', RECORD, '*', '--version', '1']).message).toBe(
      'An unexpected argument was given.',
    );
  });

  it('refuses a flag the delete does not document', () => {
    expect(usage(['delete', RECORD, '--version', '1', '--day-part', 'morning']).message).toBe(
      'A flag is not allowed for this command.',
    );
    expect(usage(['delete', RECORD, '--version', '1', '--note=x']).message).toBe(
      'A flag is not allowed for this command.',
    );
  });

  it('never reflects an argument in a write diagnostic', () => {
    const message = usage([
      'update',
      RECORD,
      '--version',
      '1',
      '--note',
      'private note text',
      '--day-part',
      'wrong',
    ]).message;
    expect(message).toBe('The day part must be morning, evening or all_day.');
    expect(message).not.toContain('private note text');
    expect(message).not.toContain('--note');
  });

  it('keeps the meta version flag and the read commands untouched', () => {
    expect(command(['--version'])).toEqual({ kind: 'version' });
    expect(command(['version'])).toEqual({ kind: 'version' });
    expect(usage(['--version', '3']).message).toBe('The command is not known.');
    expect(usage(['--version=3']).message).toBe('A flag value is missing or is not allowed.');
    expect(command(['get', RECORD])).toEqual({
      kind: 'get',
      auth: { profile: undefined, origin: undefined, allowLoopbackHttp: false },
      id: RECORD,
    });
  });

  it('keeps the machine flag of a write usage error', () => {
    expect(usage(['create', '--nope', '--json']).json).toBe(true);
    expect(usage(['create', '--nope']).json).toBe(false);
  });

  it('resolves the command behind the options that carry a value', () => {
    expect(
      command([
        '--profile',
        'work',
        'create',
        '--from',
        '2026-12-01',
        '--to',
        '2026-12-01',
        '--day-part',
        'morning',
      ]),
    ).toMatchObject({ kind: 'create', auth: { profile: 'work' } });
    expect(command(['--profile=work', 'delete', RECORD, '--version', '1'])).toMatchObject({
      kind: 'delete',
      auth: { profile: 'work' },
    });
    expect(
      command([
        '--origin',
        'https://api.example.com',
        'update',
        RECORD,
        '--version',
        '1',
        '--day-part',
        'evening',
      ]),
    ).toMatchObject({ kind: 'update', auth: { origin: 'https://api.example.com' } });
  });

  it('refuses an invalid profile or origin on every write command', () => {
    expect(
      usage([
        'create',
        '--from',
        '2026-12-01',
        '--to',
        '2026-12-01',
        '--day-part',
        'morning',
        '--profile',
        'Work',
      ]).message,
    ).toBe('The profile name is not valid.');
    expect(
      usage(['update', RECORD, '--version', '1', '--day-part', 'evening', '--profile', 'Work'])
        .message,
    ).toBe('The profile name is not valid.');
    expect(usage(['delete', RECORD, '--version', '1', '--profile', 'Work']).message).toBe(
      'The profile name is not valid.',
    );
    expect(
      usage([
        'create',
        '--from',
        '2026-12-01',
        '--to',
        '2026-12-01',
        '--day-part',
        'morning',
        '--origin',
        'not-an-origin',
      ]).message,
    ).toBe('The origin is not a valid trusted origin.');
    expect(
      usage([
        'update',
        RECORD,
        '--version',
        '1',
        '--day-part',
        'evening',
        '--origin',
        'not-an-origin',
      ]).message,
    ).toBe('The origin is not a valid trusted origin.');
    expect(usage(['delete', RECORD, '--version', '1', '--origin', 'not-an-origin']).message).toBe(
      'The origin is not a valid trusted origin.',
    );
  });

  it('refuses a version that is not a number at all', () => {
    expect(usage(['delete', RECORD, '--version', '99999999999999999999']).message).toBe(
      'The version must be a number between 1 and 2147483647.',
    );
  });

  it('treats a lone dash and a negative number as words, not as options', () => {
    expect(usage(['-']).message).toBe('The command is not known.');
    expect(usage(['-5']).message).toBe('A flag is not allowed for this command.');
  });
});
