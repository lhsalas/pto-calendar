/**
 * The renderer of the read-only PTO CLI.
 *
 * The renderer is pure: it takes the result the executor already produced and
 * turns it into three things — the bytes of stdout, the bytes of stderr and
 * the exit code. It never reads the environment, a store, the terminal or
 * the network, and it never fails: every input produces a safe rendering.
 *
 * The rules are the ones of the output contract:
 *
 * - stdout carries data only, and in the machine format it is exactly one
 *   newline-terminated JSON object;
 * - stderr carries the diagnostics, and a failure is always reported in the
 *   machine envelope as well;
 * - only allowlisted fields are rendered, and every rendered string is
 *   stripped of terminal control characters and bidirectional overrides;
 * - a PTO-shaped secret and a secret digest are redacted before they are
 *   shown;
 * - partial rows are never presented as a complete result.
 */

import {
  CLI_SCHEMA_VERSION,
  EXIT_CODES,
  type CliErrorCode,
  type CliFailure,
  type CliResult,
  type CliSuccess,
  type ExitCode,
  type ListData,
} from './contract.js';

/** What a caller writes to the two streams and returns to the process. */
export interface RenderedOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: ExitCode;
}

/** The operating system command sequence that a terminal would run. */
const ANSI_SEQUENCE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;

/** The operating system command string that a terminal would run. */
const OSC_SEQUENCE = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;

/** Every control character, including the line and tab characters. */
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/g;

/** Every control character but the line feed and the tab. */
const CONTROL_WITHOUT_LINES = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** The bidirectional overrides that can hide or reorder text. */
const BIDI_CONTROL = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** A personal access token, in the shape the service issues. */
const TOKEN_SHAPED = /pto_pat_[0-9A-Za-z._-]*/g;

/** The hex digest of a secret. */
const DIGEST_SHAPED = /\b[0-9a-f]{64}\b/gi;

/** What a redacted secret is replaced with. */
const REDACTED = '[redacted]';

/** One record of the calendar, projected onto the allowlisted fields. */
interface RenderedRecord {
  readonly id: string;
  readonly user: { readonly id: string; readonly name: string; readonly colorCode: string };
  readonly startDate: string;
  readonly endDate: string;
  readonly dayPart: string;
  readonly note: string | null;
  readonly version: number;
}

/** One page of the calendar, projected onto the allowlisted fields. */
interface RenderedList {
  readonly items: readonly RenderedRecord[];
  readonly complete: boolean;
  readonly reason: string;
  readonly pages: number;
}

/**
 * Removes the dangerous characters of one string.
 *
 * The escape sequences go first, because a sequence is made of a control
 * character and printable text. The remaining control characters become a
 * space, so a name or a note cannot break the line it is shown on, and the
 * bidirectional overrides are removed, so a note cannot reorder what is shown
 * after it.
 *
 * The renderer is pure and therefore never knows the credential of this run.
 * It redacts every secret it can recognize by its shape instead, and the
 * executor is required to keep the credential out of the result it hands
 * over.
 */
function sanitize(value: string, keepLines: boolean): string {
  return value
    .replace(OSC_SEQUENCE, '')
    .replace(ANSI_SEQUENCE, '')
    .replace(keepLines ? CONTROL_WITHOUT_LINES : CONTROL_CHARACTER, ' ')
    .replace(BIDI_CONTROL, '')
    .replace(TOKEN_SHAPED, REDACTED)
    .replace(DIGEST_SHAPED, REDACTED);
}

/** The safe form of one piece of text. */
function plain(value: string): string {
  return sanitize(value, false);
}

/** The safe form of one piece of text that keeps its line structure. */
function document(value: string): string {
  return sanitize(value, true);
}

/** The safe form of one piece of text that may be absent. */
function optionalPlain(value: string | null): string | null {
  return value === null ? null : plain(value);
}

/** The projection of one record. */
function renderRecord(record: {
  readonly id: string;
  readonly user: { readonly id: string; readonly name: string; readonly colorCode: string };
  readonly startDate: string;
  readonly endDate: string;
  readonly dayPart: string;
  readonly note: string | null;
  readonly version: number;
}): RenderedRecord {
  return {
    id: plain(record.id),
    user: {
      id: plain(record.user.id),
      name: plain(record.user.name),
      colorCode: plain(record.user.colorCode),
    },
    startDate: plain(record.startDate),
    endDate: plain(record.endDate),
    dayPart: plain(record.dayPart),
    note: optionalPlain(record.note),
    version: record.version,
  };
}

/** The projection of one page of the calendar. */
function renderList(data: ListData): RenderedList {
  return {
    items: data.items.map((item) => renderRecord(item)),
    complete: data.complete,
    reason: plain(data.reason),
    pages: data.pages,
  };
}

/** The projection of the data of a successful command. */
function renderData(result: CliSuccess): Record<string, unknown> {
  switch (result.command) {
    case 'help':
      return { text: document(result.data.text) };
    case 'version':
      return { version: plain(result.data.version) };
    case 'auth-set':
      return {
        profile: optionalPlain(result.data.profile),
        origin: plain(result.data.origin),
        source: plain(result.data.source),
      };
    case 'auth-status':
      return {
        profile: optionalPlain(result.data.profile),
        origin: plain(result.data.origin),
        source: plain(result.data.source),
        ownerId: plain(result.data.ownerId),
        scopes: result.data.scopes.map((scope) => plain(scope)),
        expiresAt: plain(result.data.expiresAt),
      };
    case 'auth-remove':
      return {
        profile: plain(result.data.profile),
        source: plain(result.data.source),
        removed: result.data.removed,
        guidance: plain(result.data.guidance),
      };
    case 'list':
      return { ...renderList(result.data) };
    case 'get':
      return { ...renderRecord(result.data) };
  }
}

/**
 * The category a failure is reported with.
 *
 * A cancellation wins over every other category, and rows that were really
 * read are reported as incomplete, so a partial traversal never borrows the
 * category of a failure that produced no rows at all.
 */
function effectiveCode(result: CliFailure): CliErrorCode {
  if (result.error.code === 'CANCELLED') return 'CANCELLED';
  if (result.partial !== undefined && result.partial.items.length > 0) return 'INCOMPLETE';
  return result.error.code;
}

/** The machine envelope of one result. */
function envelope(result: CliResult): Record<string, unknown> {
  if (result.ok) {
    return {
      schemaVersion: CLI_SCHEMA_VERSION,
      ok: true,
      command: result.command,
      data: renderData(result),
    };
  }
  const failure: Record<string, unknown> = {
    schemaVersion: CLI_SCHEMA_VERSION,
    ok: false,
    command: result.command,
    error: {
      code: effectiveCode(result),
      message: plain(result.error.message),
      status: result.error.status,
      requestId: optionalPlain(result.error.requestId),
      retryAfterMs: result.error.retryAfterMs,
    },
  };
  if (result.partial !== undefined) {
    failure['partial'] = { ...renderList(result.partial) };
  }
  return failure;
}

/** The exit code of one result. */
function exitCodeOf(result: CliResult): ExitCode {
  if (result.ok) return 0;
  return EXIT_CODES[effectiveCode(result)];
}

/** The lines of one human rendering. */
function join(parts: readonly string[]): string {
  return `${parts.join('\n')}\n`;
}

/** The one line that names a value. */
function field(label: string, value: string): string {
  return `${label}: ${value}`;
}

/** The human rendering of one record of the calendar. */
function renderRecordLine(record: RenderedRecord): string {
  return `${record.startDate}..${record.endDate}  ${record.dayPart}  ${record.user.name} <${record.user.id}>`;
}

/** The human rendering of one page of the calendar. */
function renderListLines(data: RenderedList): string[] {
  const lines: string[] = [];
  if (data.items.length === 0) {
    lines.push(
      data.complete ? 'No records.' : 'No records were read before the traversal stopped.',
    );
  } else {
    for (const item of data.items) {
      lines.push(renderRecordLine(item));
    }
  }
  lines.push('');
  lines.push(field('Records', String(data.items.length)));
  lines.push(field('Status', data.complete ? 'complete' : 'incomplete'));
  if (!data.complete) lines.push(field('Reason', data.reason));
  lines.push(field('Pages', String(data.pages)));
  return lines;
}

/** The human rendering of one detail record. */
function renderDetailLines(record: RenderedRecord): string[] {
  const lines = [
    field('Record', record.id),
    field('Dates', `${record.startDate}..${record.endDate}`),
    field('Slot', record.dayPart),
    field('Owner', `${record.user.name} <${record.user.id}>`),
  ];
  if (record.note !== null) {
    lines.push('');
    lines.push(field('Note', record.note));
  }
  return lines;
}

/** The human rendering of a successful command. */
function renderSuccess(result: CliSuccess): string {
  switch (result.command) {
    case 'help':
      return `${document(result.data.text).replace(/\s+$/u, '')}\n`;
    case 'version':
      return `${plain(result.data.version)}\n`;
    case 'auth-set':
      return join([
        field('Profile', result.data.profile === null ? 'none' : plain(result.data.profile)),
        field('Origin', plain(result.data.origin)),
        field('Source', plain(result.data.source)),
      ]);
    case 'auth-status':
      return join([
        field('Profile', result.data.profile === null ? 'none' : plain(result.data.profile)),
        field('Origin', plain(result.data.origin)),
        field('Source', plain(result.data.source)),
        field('Owner', plain(result.data.ownerId)),
        field('Scopes', result.data.scopes.map((scope) => plain(scope)).join(', ')),
        field('Expires', plain(result.data.expiresAt)),
      ]);
    case 'auth-remove':
      return join([
        field('Profile', plain(result.data.profile)),
        field('Source', plain(result.data.source)),
        field('Removed', 'yes'),
        '',
        plain(result.data.guidance),
      ]);
    case 'list':
      return join(renderListLines(renderList(result.data)));
    case 'get':
      return join(renderDetailLines(renderRecord(result.data)));
  }
}

/**
 * The human rendering of a failure.
 *
 * The rows that were really read are shown on stdout and are labelled as
 * incomplete; the diagnostic itself goes to stderr.
 */
function renderFailure(result: CliFailure): { readonly stdout: string; readonly stderr: string } {
  const stderr = `${plain(result.error.message)}\n`;
  if (result.partial === undefined) return { stdout: '', stderr };
  const lines = ['Partial results (incomplete):', ''];
  for (const line of renderListLines(renderList(result.partial))) {
    lines.push(line);
  }
  return { stdout: join(lines), stderr };
}

/**
 * Renders one result of the CLI.
 *
 * The machine format is exactly one newline-terminated JSON object on stdout.
 * The human format puts the data on stdout and the diagnostics on stderr.
 * Either way the exit code is the category the result was classified with.
 */
export function renderResult(result: CliResult, json: boolean): RenderedOutput {
  if (result.ok && result.command === 'list' && !result.data.complete) {
    // Keep the schema and exit code consistent even for an internally
    // misclassified traversal. It can never become a success on stdout.
    result = {
      schemaVersion: CLI_SCHEMA_VERSION,
      ok: false,
      command: 'list',
      error: {
        code: 'INCOMPLETE',
        message: 'The calendar read is incomplete.',
        status: null,
        requestId: null,
        retryAfterMs: null,
      },
      partial: result.data,
    };
  }
  if (json) {
    const stderr = result.ok ? '' : `${plain(result.error.message)}\n`;
    return {
      stdout: `${JSON.stringify(envelope(result))}\n`,
      stderr,
      exitCode: exitCodeOf(result),
    };
  }
  if (result.ok) {
    return { stdout: renderSuccess(result), stderr: '', exitCode: exitCodeOf(result) };
  }
  const failure = renderFailure(result);
  return { stdout: failure.stdout, stderr: failure.stderr, exitCode: exitCodeOf(result) };
}
