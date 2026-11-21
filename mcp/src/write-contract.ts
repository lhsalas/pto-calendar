/**
 * The typed contract of the writable PTO tools (#264).
 *
 * The three mutation tools are a separately typed surface: they are advertised
 * only when the trusted host sets the exact own switch `PTO_MCP_WRITES=1`, and
 * they never extend the read-only types. Every mutation runs the same two
 * phases:
 *
 * - `preview` reads the live identity, the live entry where the operation
 *   needs one, and returns an allowlisted description of the exact change. It
 *   never writes, never reads a note into the answer and never claims that a
 *   human approved anything;
 * - `apply` names the same canonical arguments plus the opaque `previewId` of
 *   that preview. The server re-reads the live identity, the live entry and the
 *   live permissions, then dispatches at most one conditional request.
 *
 * This module is pure. It holds the vocabulary, the closed result envelopes and
 * the exact local switch. It opens no store, sends no request and sees no
 * credential.
 */

import type { PtoDayPart } from '@pto-calendar/api-client';

import type { MCP_SCHEMA_VERSION, ToolName, ToolResult } from './contract.js';

/** The three mutation tools. They are never part of the read-only surface. */
export const WRITE_TOOL_NAMES = ['pto_create', 'pto_update', 'pto_delete'] as const;
export type WriteToolName = (typeof WRITE_TOOL_NAMES)[number];

/** The closed set of tools the protocol may dispatch. */
export type AnyToolName = ToolName | WriteToolName;

/** The operation one mutation tool performs. */
export type WriteOperation = 'create' | 'update' | 'delete';

/** The two phases of every mutation. */
export const WRITE_MODES = ['preview', 'apply'] as const;
export type WriteMode = (typeof WRITE_MODES)[number];

/**
 * The exact own local switch.
 *
 * Only the field `PTO_MCP_WRITES` with the exact value `1` on the process
 * environment opens the write surface. A value inherited through a prototype,
 * read from a dotenv file, given in any other spelling or stored in a profile
 * does not. The API keeps its own rollout flags and remains authoritative.
 */
export const WRITES_SWITCH = 'PTO_MCP_WRITES';

/** Whether the trusted host enabled the writable tools for this process. */
export function writesEnabled(env: NodeJS.ProcessEnv): boolean {
  return Object.hasOwn(env, WRITES_SWITCH) && env[WRITES_SWITCH] === '1';
}

/** The half-day vocabulary. `AM` and `PM` are never accepted. */
export const WRITE_DAY_PARTS: readonly PtoDayPart[] = ['morning', 'evening', 'all_day'];

/** The fields an update may change. */
export const CHANGED_FIELDS = ['startDate', 'endDate', 'dayPart', 'note'] as const;
export type ChangedField = (typeof CHANGED_FIELDS)[number];

/**
 * The note intention of one proposal. The note text itself is never read into
 * an answer: a preview shows only whether the stored note is preserved, set or
 * cleared, and an omitted PATCH note is not represented at all.
 */
export const NOTE_INTENTS = ['none', 'keep', 'set', 'clear'] as const;
export type NoteIntent = (typeof NOTE_INTENTS)[number];

/** The validated arguments of one create. */
export interface CreateArguments {
  readonly name: 'pto_create';
  readonly mode: WriteMode;
  readonly startDate: string;
  readonly endDate: string;
  readonly dayPart: PtoDayPart;
  readonly note?: string;
  readonly idempotencyKey: string;
  readonly previewId?: string;
}

/**
 * The validated changes of one update.
 *
 * The object is closed and nonempty. An omitted note preserves the stored note,
 * `null` and the empty string clear it, and any other text replaces it.
 */
export interface UpdateChanges {
  readonly startDate?: string;
  readonly endDate?: string;
  readonly dayPart?: PtoDayPart;
  readonly note?: string | null;
}

/** The validated arguments of one update. */
export interface UpdateArguments {
  readonly name: 'pto_update';
  readonly mode: WriteMode;
  readonly id: string;
  readonly expectedVersion: number;
  readonly changes: UpdateChanges;
  readonly previewId?: string;
}

/** The validated arguments of one delete. */
export interface DeleteArguments {
  readonly name: 'pto_delete';
  readonly mode: WriteMode;
  readonly id: string;
  readonly expectedVersion: number;
  readonly previewId?: string;
}

/** The validated arguments of any mutation. */
export type WriteArguments = CreateArguments | UpdateArguments | DeleteArguments;

/** The exact target of one change. It never carries a display name. */
export interface TargetReference {
  readonly id: string;
  readonly version: number;
}

/** The effective dates and day part of one side of a change. */
export interface EffectiveRange {
  readonly startDate: string;
  readonly endDate: string;
  readonly dayPart: PtoDayPart;
}

/** The fields every preview shares. */
interface PreviewBase {
  readonly phase: 'preview';
  readonly previewId: string;
  readonly actorId: string;
  readonly ownerId: string;
  readonly expiresAt: string;
  readonly changedFields: readonly ChangedField[];
}

/** One preview of a create. The owner is the live credential holder. */
export interface CreatePreviewData extends PreviewBase {
  readonly operation: 'create';
  readonly target: null;
  readonly before: null;
  readonly after: EffectiveRange;
  readonly noteIntent: Extract<NoteIntent, 'none' | 'set'>;
}

/** One preview of an update, with the exact current and proposed range. */
export interface UpdatePreviewData extends PreviewBase {
  readonly operation: 'update';
  readonly target: TargetReference;
  readonly before: EffectiveRange;
  readonly after: EffectiveRange;
  readonly noteIntent: Extract<NoteIntent, 'keep' | 'set' | 'clear'>;
}

/** One preview of a delete. The proposed side has no record. */
export interface DeletePreviewData extends PreviewBase {
  readonly operation: 'delete';
  readonly target: TargetReference;
  readonly before: EffectiveRange;
  readonly after: null;
  readonly noteIntent: 'none';
}

/** One safe record of a mutation answer. It never carries a note. */
export interface AppliedRecord extends EffectiveRange {
  readonly id: string;
  readonly ownerId: string;
  readonly version: number;
}

/** The safe answer of one applied create. */
export interface CreateApplyData {
  readonly phase: 'apply';
  readonly operation: 'create';
  readonly record: AppliedRecord;
  readonly replayed: boolean;
  readonly expiresAt: string;
}

/** The safe answer of one applied update. */
export interface UpdateApplyData {
  readonly phase: 'apply';
  readonly operation: 'update';
  readonly record: AppliedRecord;
  readonly noteIntent: Extract<NoteIntent, 'keep' | 'set' | 'clear'>;
}

/** The safe answer of one applied delete. */
export interface DeleteApplyData {
  readonly phase: 'apply';
  readonly operation: 'delete';
  readonly deleted: TargetReference & { readonly ownerId: string };
}

/** The closed payload of a successful mutation answer. */
export type WriteData =
  | CreatePreviewData
  | CreateApplyData
  | UpdatePreviewData
  | UpdateApplyData
  | DeletePreviewData
  | DeleteApplyData;

/**
 * The failure categories of the write surface.
 *
 * `CONFLICT` covers a stale version, an overlapping range and a key-bound
 * create refusal; `PREVIEW` covers an unknown, expired, already used or
 * mismatched preview; `UNKNOWN_OUTCOME` marks a dispatched write whose answer
 * was lost and whose state is not known. The fixed message distinguishes the
 * cases further.
 */
export const WRITE_ERROR_CODES = [
  'INPUT',
  'AUTH',
  'PERMISSION',
  'NOT_FOUND',
  'QUOTA',
  'NETWORK',
  'CANCELLED',
  'LOCAL',
  'BUSY',
  'CONFLICT',
  'PREVIEW',
  'UNKNOWN_OUTCOME',
] as const;
export type WriteErrorCode = (typeof WRITE_ERROR_CODES)[number];

/**
 * The bounded recovery a host may show next to a failure.
 *
 * - `none`: nothing to recover beyond reading the message;
 * - `retry-preview`: prepare and approve a new preview;
 * - `refresh-version`: read the entry again and prepare a preview with its new version;
 * - `wait-retry-after`: respect the service's wait hint first, then reconcile;
 * - `reconcile`: read the records before proposing any further mutation;
 * - `reauthenticate`: replace the local credential outside the tool.
 */
export const WRITE_RECOVERIES = [
  'none',
  'retry-preview',
  'refresh-version',
  'wait-retry-after',
  'reconcile',
  'reauthenticate',
] as const;
export type WriteRecovery = (typeof WRITE_RECOVERIES)[number];

/** The fixed failure of one mutation. It carries no cause and no argument. */
export interface WriteError {
  readonly code: WriteErrorCode;
  readonly message: string;
  readonly status: number | null;
  readonly upstreamRequestId: string | null;
  readonly retryAfterMs: number | null;
  readonly recovery: WriteRecovery;
}

/** The closed envelope of one mutation call. */
export type WriteToolResult = {
  readonly schemaVersion: typeof MCP_SCHEMA_VERSION;
  readonly requestId: string;
} & (
  | {
      readonly ok: true;
      readonly tool: 'pto_create';
      readonly data: CreatePreviewData | CreateApplyData;
    }
  | {
      readonly ok: true;
      readonly tool: 'pto_update';
      readonly data: UpdatePreviewData | UpdateApplyData;
    }
  | {
      readonly ok: true;
      readonly tool: 'pto_delete';
      readonly data: DeletePreviewData | DeleteApplyData;
    }
  | {
      readonly ok: false;
      readonly tool: WriteToolName;
      readonly error: WriteError;
    }
);

/** The result any tool of the server may return. */
export type AnyToolResult = ToolResult | WriteToolResult;

/** Whether the value names one of the mutation tools. */
export function isWriteToolName(value: string): value is WriteToolName {
  return (WRITE_TOOL_NAMES as readonly string[]).includes(value);
}
