import { describe, expect, it } from 'vitest';

import type { PtoDetail, PtoPageItem } from '@pto-calendar/api-client';

import {
  CLI_SCHEMA_VERSION,
  type CliErrorCode,
  type CliFailure,
  type CliResult,
  type CliSuccess,
  type ListData,
} from '../src/contract.js';
import { renderResult } from '../src/output.js';

const OWNER = '0864a7d8-6de5-46f1-9b5e-9e7ef2ef22fa';
const RECORD = '11111111-2222-4333-8444-555555555555';

const ITEM: PtoPageItem = {
  id: RECORD,
  user: { id: OWNER, name: 'Jane Doe', colorCode: '#ff8800' },
  startDate: '2026-12-01',
  endDate: '2026-12-02',
  dayPart: 'all_day',
  note: null,
  version: 1,
};

const DETAIL: PtoDetail = { ...ITEM, note: 'Sick day' };

const LIST: ListData = { items: [ITEM], complete: true, reason: 'complete', pages: 1 };

function success(command: CliSuccess['command'], data: unknown): CliResult {
  return {
    schemaVersion: CLI_SCHEMA_VERSION,
    ok: true,
    command,
    data,
  } as CliResult;
}

function failure(code: CliErrorCode, message: string, extra: Partial<CliFailure> = {}): CliFailure {
  return {
    schemaVersion: CLI_SCHEMA_VERSION,
    ok: false,
    command: null,
    error: { code, message, status: null, requestId: null, retryAfterMs: null },
    ...extra,
  };
}

function envelope(stdout: string): Record<string, unknown> {
  const lines = stdout.split('\n');
  expect(lines).toHaveLength(2);
  expect(lines[1]).toBe('');
  return JSON.parse(lines[0] ?? '') as Record<string, unknown>;
}

describe('the machine envelope', () => {
  it('writes exactly one newline-terminated JSON object', () => {
    const rendered = renderResult(success('list', LIST), true);
    expect(rendered.stdout.endsWith('\n')).toBe(true);
    expect(rendered.stdout.trimEnd().includes('\n')).toBe(false);
    expect(rendered.stderr).toBe('');
    expect(rendered.exitCode).toBe(0);
  });

  it('projects only the allowlisted fields of a list', () => {
    const rendered = renderResult(success('list', LIST), true);
    const parsed = envelope(rendered.stdout);
    expect(parsed).toEqual({
      schemaVersion: 1,
      ok: true,
      command: 'list',
      data: {
        items: [
          {
            id: RECORD,
            user: { id: OWNER, name: 'Jane Doe', colorCode: '#ff8800' },
            startDate: '2026-12-01',
            endDate: '2026-12-02',
            dayPart: 'all_day',
            note: null,
            version: 1,
          },
        ],
        complete: true,
        reason: 'complete',
        pages: 1,
      },
    });
  });

  it('projects only the allowlisted fields of a detail', () => {
    const rendered = renderResult(success('get', DETAIL), true);
    expect(envelope(rendered.stdout)).toEqual({
      schemaVersion: 1,
      ok: true,
      command: 'get',
      data: {
        id: RECORD,
        user: { id: OWNER, name: 'Jane Doe', colorCode: '#ff8800' },
        startDate: '2026-12-01',
        endDate: '2026-12-02',
        dayPart: 'all_day',
        note: 'Sick day',
        version: 1,
      },
    });
  });

  it('projects the status of a credential', () => {
    const rendered = renderResult(
      success('auth-status', {
        profile: 'work',
        origin: 'https://api.example.com',
        source: 'keyring',
        ownerId: OWNER,
        scopes: ['pto:read', 'pto:notes:read'],
        expiresAt: '2027-01-01T00:00:00.000Z',
      }),
      true,
    );
    expect(envelope(rendered.stdout)).toEqual({
      schemaVersion: 1,
      ok: true,
      command: 'auth-status',
      data: {
        profile: 'work',
        origin: 'https://api.example.com',
        source: 'keyring',
        ownerId: OWNER,
        scopes: ['pto:read', 'pto:notes:read'],
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
    });
  });

  it('projects a local profile, a removal, the help and the version', () => {
    expect(
      envelope(
        renderResult(
          success('auth-set', {
            profile: 'work',
            origin: 'https://api.example.com',
            source: 'file',
          }),
          true,
        ).stdout,
      ),
    ).toEqual({
      schemaVersion: 1,
      ok: true,
      command: 'auth-set',
      data: { profile: 'work', origin: 'https://api.example.com', source: 'file' },
    });
    expect(
      envelope(
        renderResult(
          success('auth-remove', {
            profile: 'work',
            source: 'keyring',
            removed: true,
            guidance: 'The credential was removed from this machine.',
          }),
          true,
        ).stdout,
      ),
    ).toEqual({
      schemaVersion: 1,
      ok: true,
      command: 'auth-remove',
      data: {
        profile: 'work',
        source: 'keyring',
        removed: true,
        guidance: 'The credential was removed from this machine.',
      },
    });
    expect(
      envelope(renderResult(success('help', { text: 'Usage:\n  pto\n' }), true).stdout),
    ).toEqual({
      schemaVersion: 1,
      ok: true,
      command: 'help',
      data: { text: 'Usage:\n  pto\n' },
    });
    expect(envelope(renderResult(success('version', { version: '0.1.0' }), true).stdout)).toEqual({
      schemaVersion: 1,
      ok: true,
      command: 'version',
      data: { version: '0.1.0' },
    });
  });

  it('reports a failure in the envelope and keeps the diagnostic on stderr', () => {
    const rendered = renderResult(
      failure('PERMISSION', 'The credential may not read the calendar.', {
        command: 'list',
      }),
      true,
    );
    expect(envelope(rendered.stdout)).toEqual({
      schemaVersion: 1,
      ok: false,
      command: 'list',
      error: {
        code: 'PERMISSION',
        message: 'The credential may not read the calendar.',
        status: null,
        requestId: null,
        retryAfterMs: null,
      },
    });
    expect(rendered.stderr).toBe('The credential may not read the calendar.\n');
    expect(rendered.exitCode).toBe(4);
  });

  it('keeps the correlation fields of a failure', () => {
    const rendered = renderResult(
      {
        schemaVersion: CLI_SCHEMA_VERSION,
        ok: false,
        command: 'list',
        error: {
          code: 'QUOTA',
          message: 'The service refused the request for now.',
          status: 429,
          requestId: 'req-123',
          retryAfterMs: 1500,
        },
      },
      true,
    );
    expect(envelope(rendered.stdout)['error']).toEqual({
      code: 'QUOTA',
      message: 'The service refused the request for now.',
      status: 429,
      requestId: 'req-123',
      retryAfterMs: 1500,
    });
    expect(rendered.exitCode).toBe(7);
  });
});

describe('the exit categories', () => {
  it('maps every category onto its own exit code', () => {
    const codes: readonly [CliErrorCode, number][] = [
      ['USAGE', 2],
      ['AUTH', 3],
      ['PERMISSION', 4],
      ['NOT_FOUND', 5],
      ['CONFLICT', 6],
      ['QUOTA', 7],
      ['NETWORK', 8],
      ['INCOMPLETE', 9],
      ['LOCAL', 10],
      ['CANCELLED', 130],
    ];
    for (const [code, expected] of codes) {
      const rendered = renderResult(failure(code, 'The operation did not succeed.'), true);
      expect(rendered.exitCode).toBe(expected);
      expect(envelope(rendered.stdout)['error']).toMatchObject({ code });
    }
  });

  it('reports rows that were really read as an incomplete result', () => {
    const rendered = renderResult(
      failure('NETWORK', 'The traversal stopped early.', {
        command: 'list',
        partial: { items: [ITEM], complete: false, reason: 'budget', pages: 3 },
      }),
      true,
    );
    const parsed = envelope(rendered.stdout);
    expect(parsed['error']).toMatchObject({ code: 'INCOMPLETE' });
    expect(parsed['partial']).toEqual({
      items: [
        {
          id: RECORD,
          user: { id: OWNER, name: 'Jane Doe', colorCode: '#ff8800' },
          startDate: '2026-12-01',
          endDate: '2026-12-02',
          dayPart: 'all_day',
          note: null,
          version: 1,
        },
      ],
      complete: false,
      reason: 'budget',
      pages: 3,
    });
    expect(rendered.exitCode).toBe(9);
  });

  it('lets a cancellation win over every other category', () => {
    const rendered = renderResult(
      failure('CANCELLED', 'The operation was cancelled.', {
        command: 'list',
        partial: { items: [ITEM], complete: false, reason: 'aborted', pages: 1 },
      }),
      true,
    );
    expect(envelope(rendered.stdout)['error']).toMatchObject({ code: 'CANCELLED' });
    expect(rendered.exitCode).toBe(130);
  });

  it('reports an incomplete list that was reported as a success', () => {
    const rendered = renderResult(
      success('list', { items: [ITEM], complete: false, reason: 'drift', pages: 2 }),
      true,
    );
    expect(rendered.exitCode).toBe(9);
    expect(envelope(rendered.stdout)).toMatchObject({
      ok: false,
      error: { code: 'INCOMPLETE' },
      partial: { complete: false, reason: 'drift' },
    });
  });

  it('preserves a classified failure when the traversal read no rows', () => {
    const denied = failure('AUTH', 'Replace the credential in the signed-in UI.', {
      command: 'list',
      partial: { items: [], complete: false, reason: 'error', pages: 0 },
    });
    const machine = renderResult(denied, true);
    expect(machine.exitCode).toBe(3);
    expect(envelope(machine.stdout)).toMatchObject({
      ok: false,
      error: { code: 'AUTH' },
      partial: { complete: false, items: [] },
    });
    const human = renderResult(denied, false);
    expect(human.exitCode).toBe(3);
    expect(human.stdout).toContain('No records were read');
    expect(human.stdout).not.toContain('No records.');
  });
});

describe('the human output', () => {
  it('shows the help and the version', () => {
    expect(renderResult(success('help', { text: 'Usage:\n  pto\n' }), false)).toEqual({
      stdout: 'Usage:\n  pto\n',
      stderr: '',
      exitCode: 0,
    });
    expect(renderResult(success('version', { version: '0.1.0' }), false).stdout).toBe('0.1.0\n');
  });

  it('shows the slot, the dates, the owner and the status of a list', () => {
    const rendered = renderResult(success('list', LIST), false);
    expect(rendered.stdout).toBe(
      `2026-12-01..2026-12-02  all_day  Jane Doe (owner <${OWNER}>)  record <${RECORD}>\n` +
        '\nRecords: 1\nStatus: complete\nPages: 1\n',
    );
    expect(rendered.stderr).toBe('');
  });

  it('labels the record identifier of every row so it cannot be read as the owner', () => {
    const rendered = renderResult(success('list', LIST), false);
    const row = rendered.stdout.split('\n')[0] ?? '';
    expect(row).toContain(`record <${RECORD}>`);
    expect(row).toContain(`owner <${OWNER}>`);
    expect(row.indexOf(`record <${RECORD}>`)).toBeGreaterThan(row.indexOf(`owner <${OWNER}>`));
    expect(row).not.toContain(` ${RECORD}>`);
  });

  it('shows the sanitized record identifier of a row', () => {
    const rendered = renderResult(
      success('list', {
        items: [{ ...ITEM, id: 'id\u001B[31m-2' }],
        complete: true,
        reason: 'complete',
        pages: 1,
      }),
      false,
    );
    expect(rendered.stdout).toContain('record <id-2>');
    expect(rendered.stdout).not.toContain('\u001B');
  });

  it('never presents an incomplete list as a complete one', () => {
    const rendered = renderResult(
      success('list', { items: [ITEM], complete: false, reason: 'budget', pages: 3 }),
      false,
    );
    expect(rendered.stdout).toBe(
      'Partial results (incomplete):\n\n' +
        `2026-12-01..2026-12-02  all_day  Jane Doe (owner <${OWNER}>)  record <${RECORD}>\n` +
        '\nRecords: 1\nStatus: incomplete\nReason: budget\nPages: 3\n',
    );
    expect(rendered.stderr).toBe('The calendar read is incomplete.\n');
    expect(rendered.exitCode).toBe(9);
  });

  it('shows an empty list', () => {
    const rendered = renderResult(
      success('list', { items: [], complete: true, reason: 'complete', pages: 1 }),
      false,
    );
    expect(rendered.stdout).toBe('No records.\n\nRecords: 0\nStatus: complete\nPages: 1\n');
  });

  it('shows the note of a detail only when the server returned one', () => {
    expect(renderResult(success('get', DETAIL), false).stdout).toBe(
      `Record: ${RECORD}\nDates: 2026-12-01..2026-12-02\nSlot: all_day\nOwner: Jane Doe <${OWNER}>\n\nNote: Sick day\n`,
    );
    expect(renderResult(success('get', { ...DETAIL, note: null }), false).stdout).toBe(
      `Record: ${RECORD}\nDates: 2026-12-01..2026-12-02\nSlot: all_day\nOwner: Jane Doe <${OWNER}>\n`,
    );
  });

  it('shows the local state of a credential', () => {
    expect(
      renderResult(
        success('auth-set', {
          profile: 'work',
          origin: 'https://api.example.com',
          source: 'keyring',
        }),
        false,
      ).stdout,
    ).toBe('Profile: work\nOrigin: https://api.example.com\nSource: keyring\n');
    expect(
      renderResult(
        success('auth-set', {
          profile: null,
          origin: 'https://api.example.com',
          source: 'environment',
        }),
        false,
      ).stdout,
    ).toBe('Profile: none\nOrigin: https://api.example.com\nSource: environment\n');
    expect(
      renderResult(
        success('auth-status', {
          profile: 'work',
          origin: 'https://api.example.com',
          source: 'keyring',
          ownerId: OWNER,
          scopes: ['pto:read', 'pto:notes:read'],
          expiresAt: '2027-01-01T00:00:00.000Z',
        }),
        false,
      ).stdout,
    ).toBe(
      'Profile: work\nOrigin: https://api.example.com\nSource: keyring\n' +
        `Owner: ${OWNER}\nScopes: pto:read, pto:notes:read\nExpires: 2027-01-01T00:00:00.000Z\n`,
    );
    expect(
      renderResult(
        success('auth-status', {
          profile: null,
          origin: 'https://api.example.com',
          source: 'environment',
          ownerId: OWNER,
          scopes: ['pto:read'],
          expiresAt: '2027-01-01T00:00:00.000Z',
        }),
        false,
      ).stdout,
    ).toBe(
      'Profile: none\nOrigin: https://api.example.com\nSource: environment\n' +
        `Owner: ${OWNER}\nScopes: pto:read\nExpires: 2027-01-01T00:00:00.000Z\n`,
    );
    expect(
      renderResult(
        success('auth-remove', {
          profile: 'work',
          source: 'keyring',
          removed: true,
          guidance: 'The credential was removed from this machine.',
        }),
        false,
      ).stdout,
    ).toBe(
      'Profile: work\nSource: keyring\nRemoved: yes\n\nThe credential was removed from this machine.\n',
    );
  });

  it('keeps a failure on stderr and the rows that were read on stdout', () => {
    const rendered = renderResult(
      failure('NETWORK', 'The traversal stopped early.', {
        command: 'list',
        partial: { items: [ITEM], complete: false, reason: 'budget', pages: 3 },
      }),
      false,
    );
    expect(rendered.stdout).toBe(
      'Partial results (incomplete):\n\n' +
        `2026-12-01..2026-12-02  all_day  Jane Doe (owner <${OWNER}>)  record <${RECORD}>\n` +
        '\nRecords: 1\nStatus: incomplete\nReason: budget\nPages: 3\n',
    );
    expect(rendered.stderr).toBe('The traversal stopped early.\n');
    expect(rendered.exitCode).toBe(9);
  });

  it('keeps a failure without rows off stdout', () => {
    const rendered = renderResult(failure('AUTH', 'The credential was refused.'), false);
    expect(rendered.stdout).toBe('');
    expect(rendered.stderr).toBe('The credential was refused.\n');
    expect(rendered.exitCode).toBe(3);
  });
});

describe('the sanitization of displayed text', () => {
  it('removes terminal control characters and bidirectional overrides', () => {
    const rendered = renderResult(
      success('get', {
        ...DETAIL,
        user: { ...DETAIL.user, name: 'Ja\u001B[31mne\u202E Doe' },
      }),
      false,
    );
    expect(rendered.stdout).toContain('Owner: Jane Doe <');
    expect(rendered.stdout).not.toContain('\u001B');
    expect(rendered.stdout).not.toContain('\u202E');
  });

  it('keeps a note on one line', () => {
    const rendered = renderResult(
      success('get', { ...DETAIL, note: 'first\nsecond\ttabbed' }),
      false,
    );
    expect(rendered.stdout).toContain('Note: first second tabbed\n');
    expect(rendered.stdout.split('\n').filter((line) => line.startsWith('Note:'))).toHaveLength(1);
  });

  it('redacts a token and a digest', () => {
    const secret = 'pto_pat_11111111-2222-4333-8444-555555555555.' + 'a'.repeat(64);
    const rendered = renderResult(success('get', { ...DETAIL, note: secret }), false);
    expect(rendered.stdout).toContain('Note: [redacted]');
    expect(rendered.stdout).not.toContain(secret);
  });

  it('redacts a digest that is shown on its own', () => {
    const digest = 'b'.repeat(64);
    const rendered = renderResult(success('get', { ...DETAIL, note: digest }), false);
    expect(rendered.stdout).toContain('Note: [redacted]');
    expect(rendered.stdout).not.toContain(digest);
  });

  it('redacts a secret in the machine envelope as well', () => {
    const secret = 'pto_pat_11111111-2222-4333-8444-555555555555.' + 'a'.repeat(64);
    const rendered = renderResult(success('get', { ...DETAIL, note: secret }), true);
    expect(rendered.stdout).not.toContain(secret);
    expect(rendered.stdout).toContain('[redacted]');
  });
});
