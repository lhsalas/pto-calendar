/**
 * The strict argument parser of the PTO CLI.
 *
 * The parser is pure: it reads the argument vector and returns a typed
 * command, and it never looks at the environment, at a credential store, at
 * the terminal or at the network. Every argument is refused before a single
 * store is opened and before a single question is asked, so a hostile
 * argument vector can never reach a prompt.
 *
 * The rules are deliberately narrow:
 *
 * - only the documented commands, subcommands and flags exist;
 * - a flag may be given at most once and an unknown flag is refused;
 * - a string option takes its value as `--flag value` or `--flag=value`, and
 *   a boolean flag carries no value at all;
 * - there is no `--` separator and no short flag other than `-h`;
 * - the global `--json` flag may appear once, before or after the command and
 *   before or after the flags of the command.
 *
 * Every diagnostic is a fixed sentence. The parser never reflects the
 * argument vector, a value, the environment or a cause, so a usage error can
 * never carry an argument into a log, a terminal or a machine envelope.
 */

import { parseArgs } from 'node:util';

import type { ProfileStorage } from '@pto-calendar/agent-auth';
import type { CreatePtoPayload, PatchPtoChanges, PtoDayPart } from '@pto-calendar/api-client';

import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_PROFILE,
  MAX_PAGES,
  MAX_PAGE_SIZE,
  type CliCommand,
  type ParseResult,
  type ReadAuthOptions,
} from './contract.js';

/**
 * Every flag the CLI knows. The set is the union of the per-command sets: the
 * parser resolves the command first and then refuses every flag that the
 * resolved command does not document.
 */
const OPTION_SPEC = {
  json: { type: 'boolean', multiple: true },
  help: { type: 'boolean', multiple: true, short: 'h' },
  version: { type: 'boolean', multiple: true },
  origin: { type: 'string', multiple: true },
  profile: { type: 'string', multiple: true },
  storage: { type: 'string', multiple: true },
  'allow-loopback-http': { type: 'boolean', multiple: true },
  'token-stdin': { type: 'boolean', multiple: true },
  from: { type: 'string', multiple: true },
  to: { type: 'string', multiple: true },
  mine: { type: 'boolean', multiple: true },
  owner: { type: 'string', multiple: true },
  'page-size': { type: 'string', multiple: true },
  'max-pages': { type: 'string', multiple: true },
  'day-part': { type: 'string', multiple: true },
  note: { type: 'string', multiple: true },
  'clear-note': { type: 'boolean', multiple: true },
  operation: { type: 'string', multiple: true },
  yes: { type: 'boolean', multiple: true },
} as const;

/**
 * The option spec of the write commands.
 *
 * The only difference is the type of the version flag: a write names the
 * version of the record it changes, while the meta version flag carries no
 * value at all. The spec is chosen before the scan, from the command word,
 * so the read and the meta commands keep exactly the behavior they had.
 */
const WRITE_OPTION_SPEC = {
  ...OPTION_SPEC,
  version: { type: 'string', multiple: true },
} as const;

/** The name of a documented flag. */
type OptionName = keyof typeof OPTION_SPEC;

/** The command the parser resolved. */
type CommandName =
  | 'help'
  | 'version'
  | 'auth-set'
  | 'auth-status'
  | 'auth-remove'
  | 'list'
  | 'get'
  | 'create'
  | 'update'
  | 'delete';

/** The flags each command documents. */
const ALLOWED_OPTIONS: Readonly<Record<CommandName, readonly OptionName[]>> = {
  help: ['json', 'help'],
  version: ['json', 'version'],
  'auth-set': ['json', 'origin', 'profile', 'storage', 'allow-loopback-http', 'token-stdin'],
  'auth-status': ['json', 'profile', 'origin', 'allow-loopback-http'],
  'auth-remove': ['json', 'profile'],
  list: [
    'json',
    'from',
    'to',
    'mine',
    'owner',
    'page-size',
    'max-pages',
    'profile',
    'origin',
    'allow-loopback-http',
  ],
  get: ['json', 'profile', 'origin', 'allow-loopback-http'],
  create: [
    'json',
    'from',
    'to',
    'day-part',
    'note',
    'operation',
    'profile',
    'origin',
    'allow-loopback-http',
    'yes',
  ],
  update: [
    'json',
    'version',
    'from',
    'to',
    'day-part',
    'note',
    'clear-note',
    'profile',
    'origin',
    'allow-loopback-http',
    'yes',
  ],
  delete: ['json', 'version', 'profile', 'origin', 'allow-loopback-http', 'yes'],
};

/**
 * The fixed diagnostics of the parser.
 *
 * Every message is a constant. None of them names a flag, echoes a value or
 * repeats the argument vector, so a usage error never carries user input.
 */
const MESSAGES = {
  unknownCommand: 'The command is not known.',
  unknownSubcommand: 'The command needs one of its documented subcommands.',
  unexpectedArgument: 'An unexpected argument was given.',
  unknownOption: 'A flag is not allowed for this command.',
  repeatedOption: 'A flag may not be given more than once.',
  invalidOptionValue: 'A flag value is missing or is not allowed.',
  separator: 'A -- separator is not allowed.',
  missingOption: 'A required option is missing.',
  invalidProfile: 'The profile name is not valid.',
  invalidOrigin: 'The origin is not a valid trusted origin.',
  insecureOrigin: 'Only an HTTPS origin is allowed for a remote host.',
  invalidStorage: 'The storage must be keyring or file.',
  invalidDate: 'The date is not a real calendar date.',
  invalidRange: 'The date range must be ordered and at most 366 days long.',
  invalidUuid: 'The identifier is not a valid UUID.',
  invalidOperation: 'The operation identifier is not a valid UUID.',
  invalidPageSize: 'The page size must be a number between 1 and 200.',
  invalidMaxPages: 'The page count must be a number between 1 and 30.',
  conflictingFilters: 'The own-records filter and the owner filter cannot be combined.',
  weekendDate: 'A date must not fall on a weekend.',
  invalidDayPart: 'The day part must be morning, evening or all_day.',
  invalidVersion: 'The version must be a number between 1 and 2147483647.',
  invalidNote: 'The note must be 500 characters or fewer.',
  conflictingNote: 'The note and the clear-note flag cannot be combined.',
  emptyPatch: 'A partial update must change at least one field.',
} as const;

/** The shape of a local profile name, shared with the credential package. */
const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** The shape of a canonical UUID, shared with the API client. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The shape of a random public UUIDv4.
 *
 * The operation identifier is a separate public name for one approved
 * intent. It is never the wire idempotency key, and it is never derived
 * from the credential or from the payload.
 */
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The shape of a calendar date, shared with the API client. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The shape of a positive decimal integer without a leading zero. */
const INTEGER_PATTERN = /^[1-9][0-9]*$/;

/** The half-day vocabulary of the current API. */
const DAY_PARTS: readonly PtoDayPart[] = ['morning', 'evening', 'all_day'];

/** The longest note the API accepts. */
const MAX_NOTE_LENGTH = 500;

/** The highest record version the API accepts, an int32. */
const MAX_VERSION = 2_147_483_647;

/**
 * The shape of an origin, shared with the API client.
 *
 * The shape is checked before the URL parser runs, because normalization
 * could erase a dot-segment path, userinfo or an encoded host.
 */
const ORIGIN_PATTERN =
  /^https?:\/\/(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[1-9][0-9]{0,4})?\/?$/i;

/** The literal hosts that may be reached over plain HTTP. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** The longest origin the parser accepts. */
const MAX_ORIGIN_LENGTH = 512;

/** The longest range of days one read or one write may cover. */
const MAX_RANGE_DAYS = 366;

/**
 * The flags of the union spec that take a value.
 *
 * The list is only used to find the command word before the scan, so the
 * word the parser dispatches on is the word the scan would have found.
 */
const VALUE_OPTIONS: ReadonlySet<string> = new Set([
  'origin',
  'profile',
  'storage',
  'from',
  'to',
  'owner',
  'page-size',
  'max-pages',
]);

/** The flags and the positional words of one argument vector. */
interface Scan {
  readonly options: Readonly<Partial<Record<OptionName, string | boolean>>>;
  readonly names: readonly OptionName[];
  readonly positionals: readonly string[];
}

/** The outcome of a scan. */
type ScanResult =
  { readonly ok: true; readonly scan: Scan } | { readonly ok: false; readonly message: string };

/** The outcome of a command build. */
type CommandResult =
  | { readonly ok: true; readonly command: CliCommand }
  | { readonly ok: false; readonly message: string };

/** The outcome of a validated option. */
type OptionResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/** The option spec of one scan. */
type OptionSpec = typeof OPTION_SPEC | typeof WRITE_OPTION_SPEC;

/**
 * Whether a token names an option.
 *
 * A negative number is a value and not an option, exactly as the runtime
 * treats it, so a version or a date is never mistaken for a flag.
 */
function isOptionToken(token: string): boolean {
  if (token.length <= 1 || !token.startsWith('-')) return false;
  return !Number.isInteger(Number(token));
}

/**
 * The command word of an argument vector.
 *
 * The word is found with the rules of the scan itself: an option is skipped,
 * an option with a value takes the token behind it, and the first remaining
 * token is the command. The parser needs the word before the scan, because
 * the write commands name a record version with a value while the meta
 * version flag carries none.
 */
function commandWord(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--') return undefined;
    if (!isOptionToken(token)) return token;
    if (token.includes('=')) continue;
    const name = token.startsWith('--') ? token.slice(2) : '';
    if (!VALUE_OPTIONS.has(name)) continue;
    const next = args[index + 1];
    if (next !== undefined && !isOptionToken(next)) index += 1;
  }
  return undefined;
}

/**
 * Reads the argument vector.
 *
 * The scan is strict: an unknown flag, a missing value, a value on a boolean
 * flag and a repeated flag are all refused before anything else happens.
 */
function scan(args: readonly string[], spec: OptionSpec): ScanResult {
  try {
    const parsed = parseArgs({
      args: [...args],
      options: spec,
      strict: true,
      allowPositionals: true,
      tokens: true,
    });
    const options: Partial<Record<OptionName, string | boolean>> = {};
    const names: OptionName[] = [];
    for (const token of parsed.tokens) {
      if (token.kind === 'option-terminator') {
        return { ok: false, message: MESSAGES.separator };
      }
      if (token.kind !== 'option') continue;
      if (names.includes(token.name)) {
        return { ok: false, message: MESSAGES.repeatedOption };
      }
      names.push(token.name);
      options[token.name] = token.value === undefined ? true : token.value;
    }
    return { ok: true, scan: { options, names, positionals: parsed.positionals } };
  } catch (error) {
    // The runtime reports the offending flag in the message of its failure.
    // Only the constant code of the failure is used here, so a diagnostic
    // never repeats the argument vector.
    const code = (error as { readonly code?: unknown }).code;
    if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      return { ok: false, message: MESSAGES.unknownOption };
    }
    return { ok: false, message: MESSAGES.invalidOptionValue };
  }
}

/** The value of a string option, or nothing when the option was not given. */
function stringOption(
  options: Readonly<Partial<Record<OptionName, string | boolean>>>,
  name: OptionName,
): string | undefined {
  const value = options[name];
  return typeof value === 'string' ? value : undefined;
}

/** Whether a boolean flag was given. */
function flagOption(
  options: Readonly<Partial<Record<OptionName, string | boolean>>>,
  name: OptionName,
): boolean {
  return options[name] === true;
}

/** Refuses every flag the resolved command does not document. */
function unknownOption(
  names: readonly OptionName[],
  allowed: readonly OptionName[],
): string | undefined {
  for (const name of names) {
    if (!allowed.includes(name)) return MESSAGES.unknownOption;
  }
  return undefined;
}

/** Whether the value is a real calendar date. */
function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

/** Whether the range is ordered and short enough for one read. */
function isReadableRange(start: string, end: string): boolean {
  const from = Date.parse(`${start}T00:00:00.000Z`);
  const to = Date.parse(`${end}T00:00:00.000Z`);
  if (Number.isNaN(from) || Number.isNaN(to) || from > to) return false;
  return Math.round((to - from) / 86_400_000) + 1 <= MAX_RANGE_DAYS;
}

/**
 * Whether a date falls on a weekend.
 *
 * The rule is the rule of the service: a Saturday or a Sunday is refused as
 * the first or the last day of a record. A date that falls inside a range
 * is not affected, so a range may still span a weekend.
 */
function isWeekendDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

/**
 * A date a write may carry.
 *
 * The date must be a real calendar date and must not fall on a weekend. The
 * date is never moved, shifted or resolved: a natural language date is not
 * a date at all.
 */
function writeDate(raw: string): OptionResult<string> {
  if (!isCalendarDate(raw)) return { ok: false, message: MESSAGES.invalidDate };
  if (isWeekendDate(raw)) return { ok: false, message: MESSAGES.weekendDate };
  return { ok: true, value: raw };
}

/** The half-day value of a write. */
function writeDayPart(raw: string): OptionResult<PtoDayPart> {
  if (!DAY_PARTS.includes(raw as PtoDayPart)) {
    return { ok: false, message: MESSAGES.invalidDayPart };
  }
  return { ok: true, value: raw as PtoDayPart };
}

/** The expected version of a write, a positive int32. */
function writeVersion(raw: string | undefined): OptionResult<number> {
  if (raw === undefined) return { ok: false, message: MESSAGES.missingOption };
  if (!INTEGER_PATTERN.test(raw)) return { ok: false, message: MESSAGES.invalidVersion };
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_VERSION) {
    return { ok: false, message: MESSAGES.invalidVersion };
  }
  return { ok: true, value };
}

/**
 * The note of a create.
 *
 * A note that is longer than the API accepts is refused instead of being
 * shortened, and an empty note is left out, because the service stores a
 * note that is empty exactly like a record without a note.
 */
function createNote(raw: string | undefined): OptionResult<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw.length > MAX_NOTE_LENGTH) return { ok: false, message: MESSAGES.invalidNote };
  if (raw.length === 0) return { ok: true, value: undefined };
  return { ok: true, value: raw };
}

/**
 * The note of a partial update.
 *
 * The note is only changed when it is named. An omitted note keeps the
 * stored one, even a hidden one, and an explicit empty note or the clear
 * flag empties it.
 */
function updateNote(
  raw: string | undefined,
  clear: boolean,
): OptionResult<string | null | undefined> {
  if (clear && raw !== undefined) return { ok: false, message: MESSAGES.conflictingNote };
  if (clear) return { ok: true, value: null };
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw.length > MAX_NOTE_LENGTH) return { ok: false, message: MESSAGES.invalidNote };
  if (raw.length === 0) return { ok: true, value: null };
  return { ok: true, value: raw };
}

/** The operation identifier of a create, when one was named. */
function operationId(raw: string | undefined): OptionResult<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!UUID_V4_PATTERN.test(raw)) return { ok: false, message: MESSAGES.invalidOperation };
  return { ok: true, value: raw };
}

/** The parsed shape of an origin. */
interface OriginShape {
  readonly value: string;
  readonly host: string;
  readonly protocol: string;
}

/**
 * The canonical form of an origin.
 *
 * The shape is checked first and the URL parser second, so a userinfo, a
 * path, a query, a fragment, an encoded host or an alternate spelling of a
 * loopback address is refused instead of being normalized away.
 */
function originShape(raw: string): OriginShape | null {
  if (raw.length === 0 || raw.length > MAX_ORIGIN_LENGTH) return null;
  const matched = ORIGIN_PATTERN.exec(raw);
  if (matched === null) return null;
  const host = matched[1]!.toLowerCase();
  if (host.includes('..')) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hostname !== host) return null;
  return { value: url.origin, host, protocol: url.protocol };
}

/**
 * The canonical origin of an option.
 *
 * A plain HTTP origin is admitted for the literal loopback hosts only: the
 * resolver enforces whether such an origin may really be used, while the
 * parser never suggests plain HTTP to a remote host.
 */
function parseOrigin(raw: string): OptionResult<string> {
  const shape = originShape(raw);
  if (shape === null) return { ok: false, message: MESSAGES.invalidOrigin };
  if (shape.protocol === 'http:' && !LOOPBACK_HOSTS.has(shape.host)) {
    return { ok: false, message: MESSAGES.insecureOrigin };
  }
  return { ok: true, value: shape.value };
}

/** The origin of an option that may be left out. */
function optionalOrigin(raw: string | undefined): OptionResult<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const parsed = parseOrigin(raw);
  if (!parsed.ok) return parsed;
  return { ok: true, value: parsed.value };
}

/** The origin of an option that is required. */
function requiredOrigin(raw: string | undefined): OptionResult<string> {
  if (raw === undefined) return { ok: false, message: MESSAGES.missingOption };
  return parseOrigin(raw);
}

/** The profile of an option, with the default of the command applied. */
function parseProfile(raw: string): OptionResult<string> {
  if (!PROFILE_PATTERN.test(raw)) return { ok: false, message: MESSAGES.invalidProfile };
  return { ok: true, value: raw };
}

/** The profile of an option that may be left out. */
function optionalProfile(raw: string | undefined): OptionResult<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const parsed = parseProfile(raw);
  if (!parsed.ok) return parsed;
  return { ok: true, value: parsed.value };
}

/** The profile of an option that falls back to the default profile. */
function defaultProfile(raw: string | undefined): OptionResult<string> {
  if (raw === undefined) return { ok: true, value: DEFAULT_PROFILE };
  return parseProfile(raw);
}

/** A positive integer inside an inclusive bound. */
function readBound(
  raw: string | undefined,
  fallback: number,
  maximum: number,
  message: string,
): OptionResult<number> {
  if (raw === undefined) return { ok: true, value: fallback };
  if (!INTEGER_PATTERN.test(raw)) return { ok: false, message };
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    return { ok: false, message };
  }
  return { ok: true, value };
}

/** The read options of a command that talks to the API. */
function readAuthOptions(
  options: Readonly<Partial<Record<OptionName, string | boolean>>>,
): OptionResult<ReadAuthOptions> {
  const profile = optionalProfile(stringOption(options, 'profile'));
  if (!profile.ok) return profile;
  const origin = optionalOrigin(stringOption(options, 'origin'));
  if (!origin.ok) return origin;
  return {
    ok: true,
    value: {
      profile: profile.value,
      origin: origin.value,
      allowLoopbackHttp: flagOption(options, 'allow-loopback-http'),
    },
  };
}

/** The `help` and the `version` command. */
function metaCommand(kind: 'help' | 'version', names: readonly OptionName[]): CommandResult {
  const unknown = unknownOption(names, ALLOWED_OPTIONS[kind]);
  if (unknown !== undefined) return { ok: false, message: unknown };
  return { ok: true, command: { kind } };
}

/** The `auth set` command. */
function authSetCommand(
  options: Readonly<Partial<Record<OptionName, string | boolean>>>,
  names: readonly OptionName[],
): CommandResult {
  const unknown = unknownOption(names, ALLOWED_OPTIONS['auth-set']);
  if (unknown !== undefined) return { ok: false, message: unknown };
  const origin = requiredOrigin(stringOption(options, 'origin'));
  if (!origin.ok) return origin;
  const allowLoopbackHttp = flagOption(options, 'allow-loopback-http');
  if (origin.value.startsWith('http:') && !allowLoopbackHttp) {
    return { ok: false, message: 'Explicitly opt in to loopback HTTP for this setup.' };
  }
  const profile = defaultProfile(stringOption(options, 'profile'));
  if (!profile.ok) return profile;
  let storage: ProfileStorage = 'keyring';
  const requested = stringOption(options, 'storage');
  if (requested !== undefined) {
    if (requested !== 'keyring' && requested !== 'file') {
      return { ok: false, message: MESSAGES.invalidStorage };
    }
    storage = requested;
  }
  return {
    ok: true,
    command: {
      kind: 'auth-set',
      profile: profile.value,
      origin: origin.value,
      storage,
      allowLoopbackHttp,
      tokenStdin: flagOption(options, 'token-stdin'),
    },
  };
}

/** The `auth status` command. */
function authStatusCommand(
  options: Readonly<Partial<Record<OptionName, string | boolean>>>,
  names: readonly OptionName[],
): CommandResult {
  const unknown = unknownOption(names, ALLOWED_OPTIONS['auth-status']);
  if (unknown !== undefined) return { ok: false, message: unknown };
  const auth = readAuthOptions(options);
  if (!auth.ok) return auth;
  return { ok: true, command: { kind: 'auth-status', auth: auth.value } };
}

/** The `auth remove` command. */
function authRemoveCommand(
  options: Readonly<Partial<Record<OptionName, string | boolean>>>,
  names: readonly OptionName[],
): CommandResult {
  const unknown = unknownOption(names, ALLOWED_OPTIONS['auth-remove']);
  if (unknown !== undefined) return { ok: false, message: unknown };
  const profile = defaultProfile(stringOption(options, 'profile'));
  if (!profile.ok) return profile;
  return { ok: true, command: { kind: 'auth-remove', profile: profile.value } };
}

/** The `list` command. */
function listCommand(
  options: Readonly<Partial<Record<OptionName, string | boolean>>>,
  names: readonly OptionName[],
): CommandResult {
  const unknown = unknownOption(names, ALLOWED_OPTIONS.list);
  if (unknown !== undefined) return { ok: false, message: unknown };
  const from = stringOption(options, 'from');
  const to = stringOption(options, 'to');
  if (from === undefined || to === undefined) {
    return { ok: false, message: MESSAGES.missingOption };
  }
  if (!isCalendarDate(from) || !isCalendarDate(to)) {
    return { ok: false, message: MESSAGES.invalidDate };
  }
  if (!isReadableRange(from, to)) return { ok: false, message: MESSAGES.invalidRange };
  const mine = flagOption(options, 'mine');
  const owner = stringOption(options, 'owner');
  if (mine && owner !== undefined) {
    return { ok: false, message: MESSAGES.conflictingFilters };
  }
  let ownerId: string | undefined;
  if (owner !== undefined) {
    if (!UUID_PATTERN.test(owner)) return { ok: false, message: MESSAGES.invalidUuid };
    ownerId = owner;
  }
  const pageSize = readBound(
    stringOption(options, 'page-size'),
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
    MESSAGES.invalidPageSize,
  );
  if (!pageSize.ok) return pageSize;
  const maxPages = readBound(
    stringOption(options, 'max-pages'),
    MAX_PAGES,
    MAX_PAGES,
    MESSAGES.invalidMaxPages,
  );
  if (!maxPages.ok) return maxPages;
  const auth = readAuthOptions(options);
  if (!auth.ok) return auth;
  return {
    ok: true,
    command: {
      kind: 'list',
      auth: auth.value,
      from,
      to,
      ownerId,
      mine,
      pageSize: pageSize.value,
      maxPages: maxPages.value,
    },
  };
}

/** The `get` command. */
function getCommand(
  options: Readonly<Partial<Record<OptionName, string | boolean>>>,
  names: readonly OptionName[],
  positionals: readonly string[],
): CommandResult {
  if (positionals.length !== 2) return { ok: false, message: MESSAGES.unexpectedArgument };
  const unknown = unknownOption(names, ALLOWED_OPTIONS.get);
  if (unknown !== undefined) return { ok: false, message: unknown };
  const id = positionals[1]!;
  if (!UUID_PATTERN.test(id)) return { ok: false, message: MESSAGES.invalidUuid };
  const auth = readAuthOptions(options);
  if (!auth.ok) return auth;
  return { ok: true, command: { kind: 'get', auth: auth.value, id } };
}

/**
 * The `create` command.
 *
 * The create always belongs to the owner of the credential, so the command
 * carries no owner, no path and no role. The dates are literal: they are
 * real calendar dates, they are ordered and they never fall on a weekend.
 */
function createCommand(
  options: Readonly<Partial<Record<OptionName, string | boolean>>>,
  names: readonly OptionName[],
): CommandResult {
  const unknown = unknownOption(names, ALLOWED_OPTIONS.create);
  if (unknown !== undefined) return { ok: false, message: unknown };
  const from = stringOption(options, 'from');
  const to = stringOption(options, 'to');
  const dayPart = stringOption(options, 'day-part');
  if (from === undefined || to === undefined || dayPart === undefined) {
    return { ok: false, message: MESSAGES.missingOption };
  }
  const start = writeDate(from);
  if (!start.ok) return start;
  const end = writeDate(to);
  if (!end.ok) return end;
  if (!isReadableRange(start.value, end.value)) {
    return { ok: false, message: MESSAGES.invalidRange };
  }
  const part = writeDayPart(dayPart);
  if (!part.ok) return part;
  const note = createNote(stringOption(options, 'note'));
  if (!note.ok) return note;
  const operation = operationId(stringOption(options, 'operation'));
  if (!operation.ok) return operation;
  const auth = readAuthOptions(options);
  if (!auth.ok) return auth;
  const payload: CreatePtoPayload =
    note.value === undefined
      ? { startDate: start.value, endDate: end.value, dayPart: part.value }
      : { startDate: start.value, endDate: end.value, dayPart: part.value, note: note.value };
  return {
    ok: true,
    command: {
      kind: 'create',
      auth: auth.value,
      yes: flagOption(options, 'yes'),
      payload,
      operationId: operation.value,
    },
  };
}

/**
 * The changed fields of a partial update.
 *
 * Only the fields that are named are changed. An omitted field keeps its
 * stored value, even a hidden note, and the update is refused when it would
 * change nothing at all.
 */
function updateChanges(
  options: Readonly<Partial<Record<OptionName, string | boolean>>>,
): OptionResult<PatchPtoChanges> {
  const changes: {
    startDate?: string;
    endDate?: string;
    dayPart?: PtoDayPart;
    note?: string | null;
  } = {};
  const from = stringOption(options, 'from');
  if (from !== undefined) {
    const start = writeDate(from);
    if (!start.ok) return start;
    changes.startDate = start.value;
  }
  const to = stringOption(options, 'to');
  if (to !== undefined) {
    const end = writeDate(to);
    if (!end.ok) return end;
    changes.endDate = end.value;
  }
  const dayPart = stringOption(options, 'day-part');
  if (dayPart !== undefined) {
    const part = writeDayPart(dayPart);
    if (!part.ok) return part;
    changes.dayPart = part.value;
  }
  const note = updateNote(stringOption(options, 'note'), flagOption(options, 'clear-note'));
  if (!note.ok) return note;
  if (note.value !== undefined) changes.note = note.value;
  if (Object.keys(changes).length === 0) {
    return { ok: false, message: MESSAGES.emptyPatch };
  }
  if (
    changes.startDate !== undefined &&
    changes.endDate !== undefined &&
    !isReadableRange(changes.startDate, changes.endDate)
  ) {
    return { ok: false, message: MESSAGES.invalidRange };
  }
  return { ok: true, value: changes };
}

/**
 * The `update` command.
 *
 * The target is one exact record, named by its canonical identifier, and the
 * expected version is the version the caller read. The update is a partial
 * write: it names only the fields that change.
 */
function updateCommand(
  options: Readonly<Partial<Record<OptionName, string | boolean>>>,
  names: readonly OptionName[],
  positionals: readonly string[],
): CommandResult {
  if (positionals.length !== 2) return { ok: false, message: MESSAGES.unexpectedArgument };
  const unknown = unknownOption(names, ALLOWED_OPTIONS.update);
  if (unknown !== undefined) return { ok: false, message: unknown };
  const id = positionals[1]!;
  if (!UUID_PATTERN.test(id)) return { ok: false, message: MESSAGES.invalidUuid };
  const version = writeVersion(stringOption(options, 'version'));
  if (!version.ok) return version;
  const changes = updateChanges(options);
  if (!changes.ok) return changes;
  const auth = readAuthOptions(options);
  if (!auth.ok) return auth;
  return {
    ok: true,
    command: {
      kind: 'update',
      auth: auth.value,
      yes: flagOption(options, 'yes'),
      id,
      version: version.value,
      changes: changes.value,
    },
  };
}

/**
 * The `delete` command.
 *
 * The target is one exact record, named by its canonical identifier, and the
 * expected version is the version the caller read. There is no fuzzy target
 * and no wildcard.
 */
function deleteCommand(
  options: Readonly<Partial<Record<OptionName, string | boolean>>>,
  names: readonly OptionName[],
  positionals: readonly string[],
): CommandResult {
  if (positionals.length !== 2) return { ok: false, message: MESSAGES.unexpectedArgument };
  const unknown = unknownOption(names, ALLOWED_OPTIONS.delete);
  if (unknown !== undefined) return { ok: false, message: unknown };
  const id = positionals[1]!;
  if (!UUID_PATTERN.test(id)) return { ok: false, message: MESSAGES.invalidUuid };
  const version = writeVersion(stringOption(options, 'version'));
  if (!version.ok) return version;
  const auth = readAuthOptions(options);
  if (!auth.ok) return auth;
  return {
    ok: true,
    command: {
      kind: 'delete',
      auth: auth.value,
      yes: flagOption(options, 'yes'),
      id,
      version: version.value,
    },
  };
}

/** The command of a scanned argument vector. */
function buildCommand(scan: Scan): CommandResult {
  const { options, names, positionals } = scan;
  const word = positionals[0];
  if (word === undefined) {
    // Without a command word the CLI shows its help, and the version flag is
    // the only thing that selects another command.
    if (flagOption(options, 'version') && !flagOption(options, 'help')) {
      return metaCommand('version', names);
    }
    return metaCommand('help', names);
  }
  switch (word) {
    case 'help':
      if (positionals.length !== 1) return { ok: false, message: MESSAGES.unexpectedArgument };
      return metaCommand('help', names);
    case 'version':
      if (positionals.length !== 1) return { ok: false, message: MESSAGES.unexpectedArgument };
      return metaCommand('version', names);
    case 'auth': {
      const subcommand = positionals[1];
      if (positionals.length !== 2 || subcommand === undefined) {
        return { ok: false, message: MESSAGES.unknownSubcommand };
      }
      if (subcommand === 'set') return authSetCommand(options, names);
      if (subcommand === 'status') return authStatusCommand(options, names);
      if (subcommand === 'remove') return authRemoveCommand(options, names);
      return { ok: false, message: MESSAGES.unknownSubcommand };
    }
    case 'list':
      if (positionals.length !== 1) return { ok: false, message: MESSAGES.unexpectedArgument };
      return listCommand(options, names);
    case 'get':
      return getCommand(options, names, positionals);
    case 'create':
      if (positionals.length !== 1) return { ok: false, message: MESSAGES.unexpectedArgument };
      return createCommand(options, names);
    case 'update':
      return updateCommand(options, names, positionals);
    case 'delete':
      return deleteCommand(options, names, positionals);
    default:
      return { ok: false, message: MESSAGES.unknownCommand };
  }
}

/**
 * Parses the argument vector of the CLI.
 *
 * The result is either the resolved command or a fixed usage message. The
 * `json` member says whether the machine envelope was asked for, so a usage
 * error can be reported in the selected format even though no command was
 * resolved.
 */
export function parseArguments(argv: readonly string[]): ParseResult {
  const args = [...argv];
  const word = commandWord(args);
  // The write commands name a record version with a value, while the meta
  // version flag carries none, so the spec follows the command word.
  const spec =
    word === 'create' || word === 'update' || word === 'delete' ? WRITE_OPTION_SPEC : OPTION_SPEC;
  const scanned = scan(args, spec);
  if (!scanned.ok) {
    // Invalid syntax has no parsed flags. A standalone format marker still
    // selects the machine error without changing validity or reflecting argv.
    return { ok: false, json: args.includes('--json'), message: scanned.message };
  }
  const json = flagOption(scanned.scan.options, 'json');
  const built = buildCommand(scanned.scan);
  if (!built.ok) return { ok: false, json, message: built.message };
  return { ok: true, json, command: built.command };
}
