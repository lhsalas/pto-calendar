import type { Readable, Writable } from 'node:stream';

import type { ListAllReason, PtoDayPart } from '@pto-calendar/api-client';

export const MCP_BUILD_NAME = 'pto-mcp';
export const MCP_SCHEMA_VERSION = 1;
export const LIST_PAGE_DEFAULT = 50;
export const LIST_PAGE_LIMIT = 100;
export const LIST_PAGES_DEFAULT = 6;
export const LIST_PAGES_LIMIT = 10;
export const LIST_RECORD_LIMIT = 250;
export const LIST_DEADLINE_MS = 20_000;
export const GET_DEADLINE_MS = 15_000;
export const TOOL_NAMES = ['pto_list', 'pto_get'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface LaunchOptions {
  readonly profile?: string;
  readonly allowLoopbackHttp: boolean;
}

export interface Runtime {
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly signal: AbortSignal;
  readonly version: string;
}

export type ReadToolInput =
  | {
      readonly name: 'pto_list';
      readonly from: string;
      readonly to: string;
      readonly ownerId?: string;
      readonly mine: boolean;
      readonly pageSize: number;
      readonly maxPages: number;
    }
  | {
      readonly name: 'pto_get';
      readonly id: string;
      readonly includeNote: boolean;
    };

export interface ToolRecord {
  readonly id: string;
  readonly owner: { readonly id: string; readonly name: string };
  readonly startDate: string;
  readonly endDate: string;
  readonly dayPart: PtoDayPart;
  readonly note: string | null;
  readonly version: number;
}

export interface ReadToolList {
  readonly items: readonly ToolRecord[];
  readonly complete: boolean;
  readonly reason: ListAllReason;
  readonly pages: number;
}

export const TOOL_ERROR_CODES = [
  'INPUT',
  'AUTH',
  'PERMISSION',
  'NOT_FOUND',
  'QUOTA',
  'NETWORK',
  'INCOMPLETE',
  'CANCELLED',
  'LOCAL',
  'BUSY',
] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export type ToolResult = {
  readonly schemaVersion: typeof MCP_SCHEMA_VERSION;
  readonly requestId: string;
} & (
  | {
      readonly ok: true;
      readonly tool: 'pto_list';
      readonly data: ReadToolList;
    }
  | {
      readonly ok: true;
      readonly tool: 'pto_get';
      readonly data: ToolRecord;
    }
  | {
      readonly ok: false;
      readonly tool: ToolName;
      readonly error: {
        readonly code: ToolErrorCode;
        readonly message: string;
        readonly status: number | null;
        readonly upstreamRequestId: string | null;
        readonly retryAfterMs: number | null;
      };
      readonly partial?: ReadToolList;
    }
);
