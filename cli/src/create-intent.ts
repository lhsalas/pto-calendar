/**
 * The durable local journal of create intents (#262).
 *
 * A create that may already have reached the server must stay recoverable after
 * a crash, a timeout, an abort or a second invocation. This module keeps at
 * most one pending create per trusted owner on this host. The owner is the pair
 * of a canonical origin and the live actor, so a rotated token or a different
 * profile can never start a second key while a create is pending.
 *
 * Everything lives in one owner-only directory, by default
 * `$HOME/.local/state/pto-calendar/create-intents`:
 *
 * - `owner-<sha256>.json`: the pending create of one owner. It is written once,
 *   before any dispatch, through a staged file that is flushed, linked into
 *   place without overwriting, unlinked from its stage name and made durable
 *   with a directory flush. It is never rewritten. Only `complete()` on its own
 *   lease removes it. Callback outcomes, aborts, errors and restarts never do.
 * - `.lock.owner-<sha256>`: the exclusive lock of one owner, held from admission
 *   until the callback settles. A held lock is BUSY. It is never waited on,
 *   broken or replaced. A crash leaves it behind on purpose.
 * - `.stage.owner-<sha256>.<random>`: the staged file of an interrupted publish.
 *   It is not evidence. Only the publish that created it removes it, and only
 *   while the name still refers to that object.
 *
 * The record holds the operation identifier (a UUIDv4 chosen for the operator),
 * the wire idempotency key `v1.<13-digit UTC milliseconds>.<UUIDv4>` (a second,
 * independent random UUID), the expiry derived from the key, the origin, the
 * actor, the public token identifier and one digest. The digest is a
 * domain-separated HMAC of the normalized payload under a key derived from the
 * raw personal access token. Neither the token, nor a hash of it, nor the note,
 * nor the payload fields are stored.
 *
 * Decisions, in order, under the owner lock:
 *
 * - No record and no operation identifier: a fresh intent is published, then
 *   dispatched once with its new key.
 * - No record and an operation identifier: MISMATCH. The state is missing.
 * - A record that is future-dated, malformed, unsafe or unreadable: UNAVAILABLE.
 * - A record past its 24-hour deadline: EXPIRED. Nothing falls back to a new key.
 * - A record while no operation identifier, or a different one, is supplied:
 *   PENDING. The pending create is reported and nothing is dispatched.
 * - The same operation identifier with a different origin, actor, public token
 *   identifier, or normalized payload: MISMATCH.
 * - The same operation identifier with the same approved state: resume. The
 *   callback receives the stored key, so the server can replay its own result.
 *
 * Operator recovery is always explicit and manual. Confirm that no create runs
 * for the account, reconcile the live PTO records and audit rows for the
 * operation (the server replay row exists only within the 24-hour window), then
 * move the record and any stale lock directory into a private archive. Never
 * delete them, never edit a record and never clear a lock automatically.
 *
 * Durability: a create may reach the service only after its record and every
 * directory entry that leads to that record are durable. The record is written
 * through a staged file that is flushed, linked and followed by a flush of the
 * journal directory. Every directory on the path from the root to the journal is
 * opened through the descriptor of its parent, and that parent is flushed while
 * it is still open, so the name of a new or an adopted directory is durable
 * before the journal is used at all. "It already exists" is never durability
 * evidence: a directory that another process created, or that an interrupted
 * invocation left behind, is flushed like any other. A resumed record is
 * flushed in its directory under the owner lock, because a prior publication
 * may have linked the record and then been interrupted before the directory was
 * flushed.
 *
 * Trust boundary: Linux only. Every entry is reached through a descriptor of its
 * directory (`/proc/self/fd/<fd>/<name>`) with `O_NOFOLLOW`. A symbolic link, a
 * hard link, a directory, a FIFO, a socket, a foreign owner, a wider mode or a
 * record larger than its bound is refused, never read, replaced or removed.
 * Ancestors must belong to root or to the current user and must not be writable
 * by other users unless sticky. The journal directory must belong to the current
 * user with mode 0700. The journal is scoped to this host and user. It cannot
 * coordinate other devices, and it does not replace the server's overlap and
 * idempotency guards. A process running as the same user can still edit it.
 *
 * Failure contract for callers:
 *
 * - `TypeError` (fixed message): the request is malformed. Nothing was touched.
 * - `CreateIntentError`: a journal decision. Nothing was dispatched, except that
 *   `complete()` may fail after a dispatch. That failure carries the operation
 *   identifier and expiry, and the record is kept.
 * - A required flush that fails is unavailable: the journal is not used, nothing
 *   is dispatched, and the pending record is kept. The refusal of a resumed
 *   record carries the operation identifier and expiry of that record, so the
 *   next attempt uses the same operation and the same key.
 * - The signal's own reason (an `AbortError`): aborted before admission, nothing
 *   was touched. Aborted after admission, the record stays pending.
 * - Errors of the callback are re-thrown unchanged.
 * - Cleanup errors (lock release, store close) never replace a callback outcome.
 *   A lock that cannot be removed stays, so the next admission reports BUSY.
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The refusals of the journal. Each code has one fixed, safe message. */
export type CreateIntentCode = 'BUSY' | 'PENDING' | 'MISMATCH' | 'EXPIRED' | 'UNAVAILABLE';

const MESSAGES: Readonly<Record<CreateIntentCode, string>> = {
  BUSY: 'The local create journal is busy or has a stale lock. Make sure no create is running, then try again.',
  PENDING:
    'A create for this account is still pending in the local journal. Resume that operation or reconcile it before starting another create.',
  MISMATCH:
    'The pending create does not match this request. Reconcile the pending create before retrying.',
  EXPIRED:
    'The pending create has passed its 24-hour replay window. Reconcile it in PTO records before starting another create.',
  UNAVAILABLE:
    'The local create journal is unavailable or unsafe to use. Check it before retrying.',
};

/** The safe fields a refusal may carry. Neither one is a secret. */
interface SafeFields {
  readonly operationId?: string;
  readonly expiresAt?: string;
}

/**
 * A refusal of the create journal.
 *
 * It carries the code, and the operation identifier and expiry of the pending
 * create when that is known and safe to report. It never carries a path, a key,
 * a token, a note, a system error or a cause.
 */
export class CreateIntentError extends Error {
  readonly code: CreateIntentCode;
  readonly operationId: string | undefined;
  readonly expiresAt: string | undefined;

  constructor(code: CreateIntentCode, safe: SafeFields = {}) {
    super(MESSAGES[code]);
    this.name = 'CreateIntentError';
    this.code = code;
    this.operationId = safe.operationId;
    this.expiresAt = safe.expiresAt;
  }
}

/**
 * The identity a create is bound to.
 *
 * `origin` is the canonical origin the credential belongs to, `actorId` is the
 * live actor and `tokenId` is the public identifier of the token. `token` is the
 * raw personal access token. It is only used to derive the digest key and is
 * never stored.
 */
export interface CreateIntentBinding {
  readonly origin: string;
  readonly actorId: string;
  readonly tokenId: string;
  readonly token: string;
}

/** The approved fields of one create. Nothing else is accepted. */
export interface CreateIntentPayload {
  readonly startDate: string;
  readonly endDate: string;
  readonly dayPart?: 'morning' | 'evening' | 'all_day';
  readonly note?: string;
}

/** The intent a callback dispatches with. */
export interface CreateIntent {
  readonly operationId: string;
  readonly key: string;
  readonly expiresAt: string;
}

/**
 * The lease of one admitted create.
 *
 * It is only valid inside its callback. `complete()` removes the pending record
 * and must only be called after a verified success or a fresh attempt with a
 * definite no-write result. A lease that is used after its callback settled
 * refuses to touch any file.
 */
export interface CreateIntentLease {
  readonly intent: CreateIntent;
  complete(): void;
}

/** Test and isolated-host seams. The default is the HOME-derived journal. */
export interface CreateIntentOptions {
  /** A trusted absolute directory, owned by this user with mode 0700 when created. */
  readonly directory?: string;
  /** The clock, in milliseconds since the epoch. */
  readonly now?: () => number;
  /** Checked before admission and again before dispatch. */
  readonly signal?: AbortSignal;
}

type Act<T> = (lease: CreateIntentLease) => Promise<T>;

/**
 * Runs `act` with the lease of one create, under the exclusive lock of its owner.
 *
 * `operationId` is null or absent for a new intent. A supplied canonical UUIDv4
 * asks to resume the pending create with that identifier. The callback runs at
 * most once per call, after the pending record is durably published or matched.
 */
export async function withCreateIntent<T>(
  binding: CreateIntentBinding,
  payload: CreateIntentPayload,
  operationId: string | null | undefined,
  act: Act<T>,
  options: CreateIntentOptions = {},
): Promise<T> {
  if (typeof act !== 'function') throw new TypeError(INVALID_ACT);
  const settings = settingsOf(options);
  const request = requestOf(binding, payload, operationId);
  settings.signal?.throwIfAborted();
  const store = openStore(settings.segments);
  const outcome = await settle(() => withLock(store, request, settings, act));
  closeQuietly(store);
  return unwrap(outcome);
}

/* ------------------------------------------------------------------------- */
/* Fixed texts and limits.                                                    */
/* ------------------------------------------------------------------------- */

const INVALID_ACT = 'The create callback must be a function.';
const INVALID_BINDING =
  'The create binding must name a canonical origin, a canonical actor and token identifier, and a personal access token.';
const INVALID_PAYLOAD =
  'The create payload must carry only real, ordered, weekday dates, a day part that fits the range, and a bounded well-formed note.';
const INVALID_OPERATION = 'The operation identifier must be a canonical lowercase UUIDv4.';
const INVALID_OPTIONS = 'The create journal options are not valid.';

/** The replay window of a create key, which the server also enforces. */
const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A recorded key may not claim to be issued more than this far in the future. */
const MAX_FUTURE_SKEW_MS = 120 * 1000;
/** Clock values and key timestamps are 13-digit UTC milliseconds. */
const MIN_CLOCK_MS = 1_000_000_000_000;
const MAX_CLOCK_MS = 9_999_999_999_999;
/** The longest note, in UTF-16 code units, which is what the server's validator counts. */
const MAX_NOTE_LENGTH = 500;
/** The longest origin, as the shared client bounds it. */
const MAX_ORIGIN_LENGTH = 512;
/** A record is a small fixed-shape document. Anything larger is corrupt. */
const MAX_RECORD_BYTES = 2048;
/** The longest directory option and the deepest directory it may name. */
const MAX_PATH_LENGTH = 4096;
const MAX_PATH_SEGMENTS = 32;
/** The journal directory, relative to HOME. */
const DEFAULT_SEGMENTS = ['.local', 'state', 'pto-calendar', 'create-intents'] as const;

/** Directories of the journal are owner-only. */
const DIRECTORY_MODE = 0o700;
/** Records and stage files are owner-only regular files. */
const FILE_MODE = 0o600;
/** The procfs directory whose entries are the descriptors of this process. */
const PROC_FD = '/proc/self/fd';
const LOCK_PREFIX = '.lock.';
const STAGE_PREFIX = '.stage.';
const RECORD_SUFFIX = '.json';
/** Domain label of every digest and every owner name of this journal. */
const DOMAIN = 'pto-cli:create-intent:v1';
const RECORD_VERSION = 1;

/** The exact fields of a record. Sorted, because that is how they are compared. */
const RECORD_FIELDS = [
  'actorId',
  'digest',
  'expiresAt',
  'key',
  'operationId',
  'origin',
  'tokenId',
  'version',
] as const;
/** The approved fields a create may carry. */
const PAYLOAD_FIELDS: ReadonlySet<string> = new Set(['startDate', 'endDate', 'dayPart', 'note']);
const DAY_PARTS: ReadonlySet<string> = new Set(['morning', 'evening', 'all_day']);
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]', 'localhost']);

const UUID_ANY_CASE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN =
  /^pto_pat_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.[0-9a-f]{64}$/;
const KEY =
  /^v1\.([1-9][0-9]{12})\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DIGEST = /^[0-9a-f]{64}$/;
/** An unpaired surrogate, which UTF-8 cannot represent without changing the value. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/* ------------------------------------------------------------------------- */
/* Internal shapes.                                                           */
/* ------------------------------------------------------------------------- */

/** A validated request. It keeps the digest and the public identifiers, never the token. */
interface Request {
  readonly origin: string;
  readonly actorId: string;
  readonly tokenId: string;
  readonly operationId: string | null;
  readonly digest: string;
  readonly owner: string;
}

/** Validated options. */
interface Settings {
  readonly segments: readonly string[];
  readonly clock: () => number;
  readonly signal: AbortSignal | undefined;
}

/** The identity of one filesystem object. */
interface Identity {
  readonly device: number;
  readonly inode: number;
}

/** The exclusive lock of one owner. `handle` pins the lock directory until release. */
interface Lock {
  readonly name: string;
  readonly handle: number;
  readonly identity: Identity;
}

/** A staged file of one publish. `handle` stays open until the publish settles. */
interface Stage {
  readonly handle: number;
  readonly identity: Identity;
}

/** A pending record as it is validated. The two derived times are never stored. */
interface PendingRecord {
  readonly operationId: string;
  readonly key: string;
  readonly expiresAt: string;
  readonly origin: string;
  readonly actorId: string;
  readonly tokenId: string;
  readonly digest: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

/** An admitted record, pinned by its descriptor, with the lease state. */
interface Admitted {
  readonly store: number;
  readonly path: string;
  readonly handle: number;
  readonly identity: Identity;
  readonly intent: CreateIntent;
  state: 'pending' | 'unlinked' | 'completed';
  revoked: boolean;
}

/** An admitted record read from disk, with its pinned descriptor. */
interface Pinned {
  readonly handle: number;
  readonly identity: Identity;
  readonly record: PendingRecord;
}

/** The settled result of a callback or of a cleanup step. */
type Outcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/* ------------------------------------------------------------------------- */
/* Input validation. Nothing here touches the disk.                           */
/* ------------------------------------------------------------------------- */

/** Narrows a value to a plain object. Arrays and null are not records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The canonical lowercase form of a UUID of any version, or null. */
function canonicalUuid(value: unknown): string | null {
  if (typeof value !== 'string' || !UUID_ANY_CASE.test(value)) return null;
  return value.toLowerCase();
}

/**
 * The canonical form of a trusted origin, or null.
 *
 * Only `https` is trusted for any host. `http` is accepted only for the exact
 * loopback hosts. The origin must already be in its canonical serialized form,
 * so no two spellings of one origin can name two owners.
 */
function canonicalOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_ORIGIN_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== value) return null;
  if (url.protocol === 'https:') return value;
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) ? value : null;
}

/**
 * The approved payload in the canonical form the server fingerprints.
 *
 * The server stores an empty note as no note, keeps any other note verbatim
 * (no trimming) and bounds it by UTF-16 length. A multi-day range is always
 * `all_day`, while a single day needs its day part. Dates are real, ordered
 * weekday dates, as the service validates them. Unknown fields are refused.
 */
function canonicalPayload(input: unknown): string {
  if (!isRecord(input) || !Object.keys(input).every((key) => PAYLOAD_FIELDS.has(key))) {
    throw new TypeError(INVALID_PAYLOAD);
  }
  const startDate = civilDateOf(input['startDate']);
  const endDate = civilDateOf(input['endDate']);
  if (endDate < startDate) throw new TypeError(INVALID_PAYLOAD);
  const dayPart = dayPartOf(input['dayPart'], startDate === endDate);
  const note = noteOf(input['note']);
  return [DOMAIN, startDate, endDate, dayPart, note].join('\n');
}

/** A real, weekday calendar date in `YYYY-MM-DD` form. */
function civilDateOf(value: unknown): string {
  if (typeof value !== 'string' || !CIVIL_DATE.test(value)) throw new TypeError(INVALID_PAYLOAD);
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  const real =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  const weekday = date.getUTCDay();
  if (!real || weekday === 0 || weekday === 6) throw new TypeError(INVALID_PAYLOAD);
  return value;
}

/** The day part of a payload. A multi-day range is normalized to `all_day`. */
function dayPartOf(value: unknown, single: boolean): string {
  if (value === undefined) {
    if (single) throw new TypeError(INVALID_PAYLOAD);
    return 'all_day';
  }
  if (typeof value !== 'string' || !DAY_PARTS.has(value)) throw new TypeError(INVALID_PAYLOAD);
  return single ? value : 'all_day';
}

/** The note of a payload. An absent or empty note is the same as no note. */
function noteOf(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > MAX_NOTE_LENGTH) {
    throw new TypeError(INVALID_PAYLOAD);
  }
  if (LONE_SURROGATE.test(value)) throw new TypeError(INVALID_PAYLOAD);
  return value;
}

/** The optional operation identifier. A canonical UUIDv4 resumes; null or undefined starts anew. */
function operationOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !UUID_V4.test(value)) throw new TypeError(INVALID_OPERATION);
  return value;
}

/**
 * Validates the binding, the payload and the operation identifier.
 *
 * The token must be a personal access token whose embedded public identifier is
 * the identifier the caller bound. A different identifier is a mismatch.
 */
function requestOf(binding: unknown, payload: unknown, operation: unknown): Request {
  if (!isRecord(binding)) throw new TypeError(INVALID_BINDING);
  const origin = canonicalOrigin(binding['origin']);
  const actorId = canonicalUuid(binding['actorId']);
  const tokenId = canonicalUuid(binding['tokenId']);
  const rawToken = binding['token'];
  const token = typeof rawToken === 'string' ? rawToken : '';
  const embedded = TOKEN.exec(token);
  if (origin === null || actorId === null || tokenId === null || embedded === null) {
    throw new TypeError(INVALID_BINDING);
  }
  if (tokenId !== embedded[1]) throw new CreateIntentError('MISMATCH');
  const canonical = canonicalPayload(payload);
  return {
    origin,
    actorId,
    tokenId,
    operationId: operationOf(operation),
    digest: payloadDigest(token, canonical),
    owner: ownerOf(origin, actorId),
  };
}

/** The validated options. Only an explicit directory, clock or signal may change the default. */
function settingsOf(options: unknown): Settings {
  if (!isRecord(options)) throw new TypeError(INVALID_OPTIONS);
  // Every field is read exactly once, so a caller cannot change it between checks.
  const directory = options['directory'];
  const now = options['now'];
  const signal = options['signal'];
  const segments = directory === undefined ? defaultSegments() : explicitSegments(directory);
  const clock = now === undefined ? Date.now : clockFunction(now);
  return { segments, clock, signal: signalOf(signal) };
}

/** A clock must be a function. Its values are checked where they are used. */
function clockFunction(value: unknown): () => number {
  if (typeof value !== 'function') throw new TypeError(INVALID_OPTIONS);
  return value as () => number;
}

/** An abort signal, when one is given. */
function signalOf(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof AbortSignal)) throw new TypeError(INVALID_OPTIONS);
  return value;
}

/** The explicit directory of a test or an isolated host. It must be an exact absolute path. */
function explicitSegments(value: unknown): string[] {
  const segments = typeof value === 'string' ? splitAbsolute(value) : null;
  if (segments === null) throw new TypeError(INVALID_OPTIONS);
  return segments;
}

/** The HOME-derived journal directory. It is never derived from the working directory. */
function defaultSegments(): string[] {
  let home: string;
  try {
    home = homedir();
  } catch {
    // The runtime cannot name a home directory, so no default journal exists.
    throw unavailable();
  }
  const segments = splitAbsolute(join(home, ...DEFAULT_SEGMENTS));
  if (segments === null) throw unavailable();
  return segments;
}

/**
 * Splits an exact absolute path into its components.
 *
 * A relative path, a NUL byte, an empty component, a dot or a parent segment,
 * the root itself, and any path beyond the bounds are refused.
 */
function splitAbsolute(path: string): string[] | null {
  if (path.length > MAX_PATH_LENGTH || !path.startsWith('/') || path.includes('\0')) return null;
  const segments = path.split('/').slice(1);
  if (segments.length > MAX_PATH_SEGMENTS) return null;
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }
  return segments;
}

/* ------------------------------------------------------------------------- */
/* Digests and owners.                                                        */
/* ------------------------------------------------------------------------- */

/**
 * The domain-separated HMAC of the canonical payload.
 *
 * The HMAC key is derived from the raw token under its own label, so the payload
 * digest is keyed by the credential and cannot be reproduced without it. The
 * stored value is one digest and nothing that can be checked against the token.
 */
function payloadDigest(token: string, canonical: string): string {
  const derived = createHmac('sha256', token).update(`${DOMAIN}:digest-key`, 'utf8').digest();
  return createHmac('sha256', derived).update(canonical, 'utf8').digest('hex');
}

/** Compares two digests in constant time. Both are fixed-length hexadecimal strings. */
function digestMatches(stored: string, computed: string): boolean {
  return timingSafeEqual(Buffer.from(stored, 'utf8'), Buffer.from(computed, 'utf8'));
}

/** The owner name of one origin and actor. It contains no credential and no path character. */
function ownerOf(origin: string, actorId: string): string {
  const digest = createHash('sha256')
    .update(`${DOMAIN}:owner\n${origin}\n${actorId}`, 'utf8')
    .digest('hex');
  return `owner-${digest}`;
}

/* ------------------------------------------------------------------------- */
/* Clock, decisions and records.                                              */
/* ------------------------------------------------------------------------- */

/** A clock value that can be a key timestamp. Anything else is unavailable. */
function clockOf(clock: () => number): number {
  let value: unknown;
  try {
    value = clock();
  } catch {
    throw unavailable();
  }
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < MIN_CLOCK_MS ||
    value > MAX_CLOCK_MS
  ) {
    throw unavailable();
  }
  return value;
}

/**
 * Decides whether a pending record may be resumed by this request.
 *
 * A future-dated record is untrustworthy and reports nothing about itself.
 * Expiry wins over every other comparison, and a plain request never compares
 * the binding, so the same owner stays blocked after a token rotation.
 */
function assertResumable(record: PendingRecord, request: Request, now: number): void {
  if (record.issuedAtMs > now + MAX_FUTURE_SKEW_MS) throw unavailable();
  const safe = { operationId: record.operationId, expiresAt: record.expiresAt };
  if (now >= record.expiresAtMs) throw new CreateIntentError('EXPIRED', safe);
  if (request.operationId !== record.operationId) throw new CreateIntentError('PENDING', safe);
  if (
    record.origin !== request.origin ||
    record.actorId !== request.actorId ||
    record.tokenId !== request.tokenId ||
    !digestMatches(record.digest, request.digest)
  ) {
    throw new CreateIntentError('MISMATCH', safe);
  }
}

/** Parses and checks the bytes of a record. Every field must be exact and consistent. */
function parseRecord(text: string, owner: string): PendingRecord {
  const value = parseJson(text);
  if (!isRecord(value) || !sameFields(value)) throw unavailable();
  if (value['version'] !== RECORD_VERSION) throw unavailable();
  const operationId = value['operationId'];
  if (typeof operationId !== 'string' || !UUID_V4.test(operationId)) throw unavailable();
  const key = value['key'];
  const match = typeof key === 'string' ? KEY.exec(key) : null;
  if (typeof key !== 'string' || match === null) throw unavailable();
  const issuedAtMs = Number(match[1]);
  const expiresAtMs = issuedAtMs + REPLAY_WINDOW_MS;
  const expiresAt = value['expiresAt'];
  if (typeof expiresAt !== 'string' || expiresAt !== new Date(expiresAtMs).toISOString()) {
    throw unavailable();
  }
  const origin = canonicalOrigin(value['origin']);
  const actorId = canonicalUuid(value['actorId']);
  const tokenId = canonicalUuid(value['tokenId']);
  const digest = value['digest'];
  if (origin === null || actorId === null || tokenId === null) throw unavailable();
  if (typeof digest !== 'string' || !DIGEST.test(digest)) throw unavailable();
  if (actorId !== value['actorId'] || tokenId !== value['tokenId']) throw unavailable();
  if (ownerOf(origin, actorId) !== owner) throw unavailable();
  return {
    operationId,
    key,
    expiresAt,
    origin,
    actorId,
    tokenId,
    digest,
    issuedAtMs,
    expiresAtMs,
  };
}

/** Whether a parsed object carries exactly the record fields, and nothing else. */
function sameFields(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === RECORD_FIELDS.length && keys.every((key, i) => key === RECORD_FIELDS[i]);
}

/** Parses JSON, refusing any text that is not one document. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw unavailable();
  }
}

/** The bytes of a record. The field order is fixed, and no field is optional. */
function encodeRecord(record: PendingRecord): Buffer {
  const stored = {
    version: RECORD_VERSION,
    operationId: record.operationId,
    key: record.key,
    expiresAt: record.expiresAt,
    origin: record.origin,
    actorId: record.actorId,
    tokenId: record.tokenId,
    digest: record.digest,
  };
  return Buffer.from(JSON.stringify(stored), 'utf8');
}

/** The intent a callback receives. It is frozen, so a callback cannot change it. */
function intentOf(record: PendingRecord): CreateIntent {
  return Object.freeze({
    operationId: record.operationId,
    key: record.key,
    expiresAt: record.expiresAt,
  });
}

/** The safe summary of an unavailable journal, with optional fields that are known and safe. */
function unavailable(safe?: SafeFields): CreateIntentError {
  return new CreateIntentError('UNAVAILABLE', safe);
}

/** The refusal of a busy or stale owner lock. */
function busy(): CreateIntentError {
  return new CreateIntentError('BUSY');
}

/* ------------------------------------------------------------------------- */
/* Orchestration: lock, admission, callback, release.                         */
/* ------------------------------------------------------------------------- */

/** Settles a promise into an outcome without throwing. */
async function settle<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Returns the value of a success or re-throws the error of a failure. */
function unwrap<T>(outcome: Outcome<T>): T {
  if (outcome.ok) return outcome.value;
  throw outcome.error;
}

/**
 * Takes the owner lock, admits the request and runs the callback.
 *
 * The lock is released after the callback settles, whatever it did. A release
 * failure never replaces the outcome. The record is never touched here.
 */
async function withLock<T>(
  store: number,
  request: Request,
  settings: Settings,
  act: Act<T>,
): Promise<T> {
  const lock = acquireLock(store, request.owner);
  const outcome = await settle(() => admitAndRun(store, request, settings, act));
  releaseLockQuietly(store, lock);
  return unwrap(outcome);
}

/**
 * Admits the request and runs the callback once while the lease is valid.
 *
 * The signal is checked again after admission and before the callback starts.
 * The lease is revoked and its descriptor released when the callback settles.
 */
async function admitAndRun<T>(
  store: number,
  request: Request,
  settings: Settings,
  act: Act<T>,
): Promise<T> {
  const admitted = admit(store, request, clockOf(settings.clock));
  const outcome = await settle(async () => {
    settings.signal?.throwIfAborted();
    return act(leaseOf(admitted));
  });
  admitted.revoked = true;
  closeQuietly(admitted.handle);
  return unwrap(outcome);
}

/**
 * Decides admission under the owner lock.
 *
 * A pinned record that is refused is closed before the refusal is thrown. A
 * fresh publish is the only write, and it happens before any dispatch.
 */
function admit(store: number, request: Request, now: number): Admitted {
  const name = `${request.owner}${RECORD_SUFFIX}`;
  const existing = pinRecord(store, name, request.owner);
  if (existing === null) {
    if (request.operationId !== null) throw new CreateIntentError('MISMATCH');
    return publishFresh(store, request, now);
  }
  try {
    assertResumable(existing.record, request, now);
  } catch (error) {
    closeQuietly(existing.handle);
    throw error;
  }
  // The bytes of the record were flushed when it was published, but a prior
  // publication may have linked the record and then been interrupted before the
  // journal directory was flushed. The directory is flushed here, under the owner
  // lock, so the record survives a crash before anything is dispatched.
  try {
    syncDirectory(store);
  } catch {
    closeQuietly(existing.handle);
    throw unavailable({
      operationId: existing.record.operationId,
      expiresAt: existing.record.expiresAt,
    });
  }
  return admittedOf(store, anchoredPath(store, name), existing);
}

/** A new intent: a fresh operation identifier and a fresh key, published before dispatch. */
function publishFresh(store: number, request: Request, now: number): Admitted {
  const record: PendingRecord = {
    operationId: randomUUID(),
    key: `v1.${now}.${randomUUID()}`,
    expiresAt: new Date(now + REPLAY_WINDOW_MS).toISOString(),
    origin: request.origin,
    actorId: request.actorId,
    tokenId: request.tokenId,
    digest: request.digest,
    issuedAtMs: now,
    expiresAtMs: now + REPLAY_WINDOW_MS,
  };
  return publishRecord(store, request.owner, record);
}

/** The lease state of an admitted record, pinned by the descriptor it came with. */
function admittedOf(store: number, path: string, pinned: Pinned): Admitted {
  return {
    store,
    path,
    handle: pinned.handle,
    identity: pinned.identity,
    intent: intentOf(pinned.record),
    state: 'pending',
    revoked: false,
  };
}

/** The lease of an admitted record. Its `complete()` is the only way to remove the record. */
function leaseOf(admitted: Admitted): CreateIntentLease {
  return Object.freeze({
    intent: admitted.intent,
    complete: (): void => completeAdmitted(admitted),
  });
}

/**
 * Removes the admitted record, and nothing else, once the lease is completed.
 *
 * The record must still be the object that was admitted and must have one link.
 * A failure after the unlink is reported with the same safe fields, so a caller
 * can report the pending state without claiming that the write failed.
 */
function completeAdmitted(admitted: Admitted): void {
  if (admitted.state === 'completed') return;
  if (admitted.revoked) throw unavailableFor(admitted);
  try {
    if (admitted.state === 'pending') {
      assertIdentityAt(admitted.path, admitted.identity);
      if (statHandle(admitted.handle).nlink !== 1) throw unavailable();
      attempt(() => unlinkSync(admitted.path));
      admitted.state = 'unlinked';
    }
    attempt(() => fsyncSync(admitted.store));
    admitted.state = 'completed';
  } catch {
    throw unavailableFor(admitted);
  }
}

/** A cleanup refusal of a lease, with the safe fields of its intent. */
function unavailableFor(admitted: Admitted): CreateIntentError {
  return unavailable({
    operationId: admitted.intent.operationId,
    expiresAt: admitted.intent.expiresAt,
  });
}

/* ------------------------------------------------------------------------- */
/* Descriptor-anchored filesystem.                                            */
/* ------------------------------------------------------------------------- */

/** A directory handle that never follows a symbolic link at its last component. */
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
/** A record is opened without blocking, so a FIFO is inspected and refused, never waited on. */
const RECORD_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
/** A stage file is only ever created exclusively, never opened over an existing entry. */
const STAGE_FLAGS =
  fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;

/** The path of an entry, anchored through the descriptor of its directory. */
function anchoredPath(handle: number, name: string): string {
  return `${PROC_FD}/${handle}/${name}`;
}

/** Runs one system call whose failure is the fixed unavailable error. */
function attempt<T>(run: () => T): T {
  try {
    return run();
  } catch {
    throw unavailable();
  }
}

/** The state of an open descriptor. */
function statHandle(handle: number): Stats {
  return attempt(() => fstatSync(handle));
}

/** Closes a descriptor. A failed close is unavailable. */
function closeHandle(handle: number): void {
  attempt(() => closeSync(handle));
}

/** Closes a descriptor on an error path, where the first error is the one reported. */
function closeQuietly(handle: number): void {
  try {
    closeSync(handle);
  } catch {
    // The descriptor is already gone.
  }
}

/**
 * Flushes a directory, so that its names and its own metadata are durable.
 *
 * A failure is the fixed unavailable error. A directory that was never flushed
 * may lose its entries, so a required flush is never skipped and never guessed.
 */
function syncDirectory(handle: number): void {
  attempt(() => fsyncSync(handle));
}

/** The state of an entry without following a symbolic link. An absent entry is null. */
function statOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null;
    throw unavailable();
  }
}

/** Opens an entry without following a symbolic link. An absent entry is null. */
function openOrNull(path: string, flags: number): number | null {
  try {
    return openSync(path, flags);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null;
    throw unavailable();
  }
}

/** The system error code of a failure, or an empty code when there is none. */
function errnoCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

/** The current user. Every owner check compares against it. */
function currentUid(): number {
  return process.getuid!();
}

/** The identity of a filesystem object. */
function identityOf(stat: Stats): Identity {
  return { device: stat.dev, inode: stat.ino };
}

/** Whether an entry is the object with the expected identity. An absent entry never is. */
function matchesIdentity(stat: Stats | null, expected: Identity): boolean {
  return stat !== null && stat.dev === expected.device && stat.ino === expected.inode;
}

/** Fails closed when the entry at a path is not the object with the expected identity. */
function assertIdentityAt(path: string, expected: Identity): void {
  if (!matchesIdentity(statOrNull(path), expected)) throw unavailable();
}

/** An ancestor, or the root, may not let other users replace its entries. */
function assertTrustedAncestor(stat: Stats): void {
  if (stat.uid !== 0 && stat.uid !== currentUid()) throw unavailable();
  const mode = stat.mode & 0o7777;
  const writableByOthers = (mode & 0o022) !== 0;
  const sticky = (mode & 0o1000) !== 0;
  if (writableByOthers && !sticky) throw unavailable();
}

/** The journal directory belongs to the current user, and to nobody else, with mode 0700. */
function assertOwnerOnlyDirectory(stat: Stats): void {
  if (stat.uid !== currentUid()) throw unavailable();
  if ((stat.mode & 0o7777) !== DIRECTORY_MODE) throw unavailable();
}

/** A record or a stage is one owner-only regular file with exactly one link. */
function assertOwnerOnlyRecord(stat: Stats): void {
  if (!stat.isFile()) throw unavailable();
  if (stat.uid !== currentUid()) throw unavailable();
  if ((stat.mode & 0o7777) !== FILE_MODE) throw unavailable();
  if (stat.nlink !== 1) throw unavailable();
}

/**
 * Opens the journal directory, creating its missing components owner-only.
 *
 * Every component is opened relative to the handle of the one before it. A
 * missing component is created with `mkdir` and then set owner-only through its
 * own handle, so no substituted path can receive the mode change. The parent of
 * every component is flushed while it is still open, so the name of the
 * component is durable before the parent is released and long before the
 * journal is used. Each handle is closed on every path.
 */
function openStore(segments: readonly string[]): number {
  if (process.platform !== 'linux' || !existsSync(PROC_FD)) throw unavailable();
  let current = attempt(() => openSync('/', DIRECTORY_FLAGS));
  try {
    assertTrustedAncestor(statHandle(current));
    for (const [index, name] of segments.entries()) {
      const child = openChild(current, name);
      try {
        const stat = statHandle(child);
        if (index === segments.length - 1) assertOwnerOnlyDirectory(stat);
        else assertTrustedAncestor(stat);
        // The name of the child is durable only once its parent is flushed.
        syncDirectory(current);
      } catch (error) {
        closeQuietly(child);
        throw error;
      }
      const releasing = current;
      current = child;
      closeHandle(releasing);
    }
    return current;
  } catch (error) {
    closeQuietly(current);
    throw error;
  }
}

/**
 * Opens one child of an anchored parent, creating it when it is missing.
 *
 * A directory that another process creates first is adopted, and the caller
 * checks it. A directory created here is set owner-only through its own handle,
 * and that handle is flushed, so the owner-only mode survives a crash. The name
 * of the child in its parent is flushed by the caller.
 */
function openChild(parent: number, name: string): number {
  const path = anchoredPath(parent, name);
  const existing = openOrNull(path, DIRECTORY_FLAGS);
  if (existing !== null) return existing;
  const created = makeDirectory(path);
  const child = openOrNull(path, DIRECTORY_FLAGS);
  if (child === null) throw unavailable();
  if (created) {
    try {
      attempt(() => fchmodSync(child, DIRECTORY_MODE));
      // The owner-only mode of a new directory is durable only once the
      // directory itself has been flushed.
      syncDirectory(child);
    } catch (error) {
      closeQuietly(child);
      throw error;
    }
  }
  return child;
}

/** Creates an owner-only directory. True when created here, false when it already existed. */
function makeDirectory(path: string): boolean {
  try {
    mkdirSync(path, { mode: DIRECTORY_MODE });
    return true;
  } catch (error) {
    if (errnoCode(error) === 'EEXIST') return false;
    throw unavailable();
  }
}

/**
 * Takes the exclusive lock of one owner.
 *
 * The lock is a directory, so taking it is one atomic step that every process
 * observes. An existing entry of that name is busy, whatever it is. The lock is
 * never waited on, adopted or removed by anyone who did not create it.
 */
function acquireLock(store: number, owner: string): Lock {
  const name = `${LOCK_PREFIX}${owner}`;
  const path = anchoredPath(store, name);
  try {
    mkdirSync(path, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (errnoCode(error) === 'EEXIST') throw busy();
    throw unavailable();
  }
  let handle = -1;
  let lock: Lock | undefined;
  try {
    handle = attempt(() => openSync(path, DIRECTORY_FLAGS));
    const stat = statHandle(handle);
    if (stat.uid !== currentUid()) throw unavailable();
    lock = { name, handle, identity: identityOf(stat) };
    attempt(() => fchmodSync(handle, DIRECTORY_MODE));
    return lock;
  } catch (error) {
    if (lock !== undefined) {
      try {
        removeOwnLock(store, lock);
      } catch {
        // A lock that cannot be removed stays closed for the next admission.
      }
    }
    if (handle >= 0) closeQuietly(handle);
    throw error;
  }
}

/** Removes the lock directory when it is still the one this process created. */
function removeOwnLock(store: number, lock: Lock): void {
  const path = anchoredPath(store, lock.name);
  const current = statOrNull(path);
  if (current === null) return;
  if (!matchesIdentity(current, lock.identity)) throw unavailable();
  attempt(() => rmdirSync(path));
}

/** Releases a lock after its callback. A failure is kept as a closed lock, never reported as an outcome. */
function releaseLockQuietly(store: number, lock: Lock): void {
  try {
    removeOwnLock(store, lock);
  } catch {
    // The lock stays in place: the next admission reports BUSY.
  } finally {
    closeQuietly(lock.handle);
  }
}

/**
 * Admits a record that is already on disk, and keeps its descriptor open.
 *
 * Returns null when there is no record. Otherwise the entry must be an
 * owner-only regular file with one link, bounded, valid, and owned by this
 * owner. The caller closes the returned handle exactly once.
 */
function pinRecord(store: number, name: string, owner: string): Pinned | null {
  const handle = openOrNull(anchoredPath(store, name), RECORD_FLAGS);
  if (handle === null) return null;
  try {
    const stat = statHandle(handle);
    assertOwnerOnlyRecord(stat);
    return { handle, identity: identityOf(stat), record: readRecord(handle, owner) };
  } catch (error) {
    closeQuietly(handle);
    throw error;
  }
}

/** Reads at most one byte beyond the bound, with explicit positions, then parses the record. */
function readRecord(handle: number, owner: string): PendingRecord {
  const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
  let length = 0;
  while (length < buffer.byteLength) {
    const count = attempt(() =>
      readSync(handle, buffer, length, buffer.byteLength - length, length),
    );
    if (count === 0) break;
    length += count;
  }
  if (length > MAX_RECORD_BYTES) throw unavailable();
  return parseRecord(buffer.toString('utf8', 0, length), owner);
}

/**
 * Publishes a new record without overwriting anything.
 *
 * The bytes are staged in an exclusively created, owner-only file, flushed, and
 * then linked to the record name. The link refuses to overwrite an existing
 * entry. The stage name is removed afterwards, and the directory is flushed
 * before the caller can dispatch, so the record and its name are both durable
 * before any request is sent. Any failure removes the stage name only while
 * it still refers to the staged object. The record itself is never removed here.
 */
function publishRecord(store: number, owner: string, record: PendingRecord): Admitted {
  const target = anchoredPath(store, `${owner}${RECORD_SUFFIX}`);
  const stagePath = anchoredPath(
    store,
    `${STAGE_PREFIX}${owner}.${randomBytes(8).toString('hex')}`,
  );
  const stage = createStage(stagePath);
  try {
    attempt(() => fchmodSync(stage.handle, FILE_MODE));
    attempt(() => writeFileSync(stage.handle, encodeRecord(record)));
    attempt(() => fsyncSync(stage.handle));
    assertOwnerOnlyRecord(statHandle(stage.handle));
    assertIdentityAt(stagePath, stage.identity);
    attempt(() => linkSync(stagePath, target));
    assertIdentityAt(stagePath, stage.identity);
    attempt(() => unlinkSync(stagePath));
    assertIdentityAt(target, stage.identity);
    syncDirectory(store);
  } catch (error) {
    discardStage(stagePath, stage);
    throw error;
  }
  return admittedOf(store, target, {
    handle: stage.handle,
    identity: stage.identity,
    record,
  });
}

/**
 * Creates a stage file exclusively and records its identity.
 *
 * A stage that cannot be inspected has no identity, so it is closed and left in
 * place. It is never removed by name.
 */
function createStage(path: string): Stage {
  const handle = attempt(() => openSync(path, STAGE_FLAGS, FILE_MODE));
  try {
    return { handle, identity: identityOf(statHandle(handle)) };
  } catch (error) {
    closeQuietly(handle);
    throw error;
  }
}

/**
 * Removes the stage name while it still refers to the staged object, then
 * closes the stage. A stage that cannot be inspected is left alone.
 */
function discardStage(path: string, stage: Stage): void {
  try {
    if (matchesIdentity(statOrNull(path), stage.identity)) attempt(() => unlinkSync(path));
  } catch {
    // The stage cannot be inspected, so it is left in place.
  }
  closeQuietly(stage.handle);
}
