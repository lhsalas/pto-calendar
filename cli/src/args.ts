/**
 * The strict argument parser of the read-only PTO CLI.
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
} as const;

/** The name of a documented flag. */
type OptionName = keyof typeof OPTION_SPEC;

/** The command the parser resolved. */
type CommandName = 'help' | 'version' | 'auth-set' | 'auth-status' | 'auth-remove' | 'list' | 'get';

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
  invalidPageSize: 'The page size must be a number between 1 and 200.',
  invalidMaxPages: 'The page count must be a number between 1 and 30.',
  conflictingFilters: 'The own-records filter and the owner filter cannot be combined.',
} as const;

/** The shape of a local profile name, shared with the credential package. */
const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** The shape of a canonical UUID, shared with the API client. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The shape of a calendar date, shared with the API client. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The shape of a positive decimal integer without a leading zero. */
const INTEGER_PATTERN = /^[1-9][0-9]*$/;

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

/** The longest range of days one read may cover. */
const MAX_RANGE_DAYS = 366;

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

/**
 * Reads the argument vector.
 *
 * The scan is strict: an unknown flag, a missing value, a value on a boolean
 * flag and a repeated flag are all refused before anything else happens.
 */
function scan(args: readonly string[]): ScanResult {
  try {
    const parsed = parseArgs({
      args: [...args],
      options: OPTION_SPEC,
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
  const scanned = scan(args);
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
