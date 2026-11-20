import type { CredentialSource, ProfileStorage } from '@pto-calendar/agent-auth';
import type { ListAllReason, PtoDetail, PtoPageItem, PtoScope } from '@pto-calendar/api-client';

import type { WriteCommand, WriteData, WriteRecovery } from './write-contract.js';

export const CLI_SCHEMA_VERSION = 1;
export const DEFAULT_PROFILE = 'default';
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGES = 30;
export const MAX_RECORDS = 5000;
export const READ_TIMEOUT_MS = 15_000;
export const LIST_TIMEOUT_MS = 30_000;

export const EXIT_CODES = {
  USAGE: 2,
  AUTH: 3,
  PERMISSION: 4,
  NOT_FOUND: 5,
  CONFLICT: 6,
  QUOTA: 7,
  NETWORK: 8,
  INCOMPLETE: 9,
  LOCAL: 10,
  CANCELLED: 130,
} as const;

export type CliErrorCode = keyof typeof EXIT_CODES;
export type ExitCode = 0 | (typeof EXIT_CODES)[CliErrorCode];

export interface ReadAuthOptions {
  readonly profile?: string | undefined;
  readonly origin?: string | undefined;
  readonly allowLoopbackHttp: boolean;
}

export type CliCommand =
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | {
      readonly kind: 'auth-set';
      readonly profile: string;
      readonly origin: string;
      readonly storage: ProfileStorage;
      readonly allowLoopbackHttp: boolean;
      readonly tokenStdin: boolean;
    }
  | { readonly kind: 'auth-status'; readonly auth: ReadAuthOptions }
  | { readonly kind: 'auth-remove'; readonly profile: string }
  | {
      readonly kind: 'list';
      readonly auth: ReadAuthOptions;
      readonly from: string;
      readonly to: string;
      readonly ownerId?: string | undefined;
      readonly mine: boolean;
      readonly pageSize: number;
      readonly maxPages: number;
    }
  | { readonly kind: 'get'; readonly auth: ReadAuthOptions; readonly id: string }
  | WriteCommand;

export type MetaCommand = Extract<CliCommand, { kind: 'help' | 'version' }>;
export type Operation = Exclude<CliCommand, MetaCommand>;
export type CommandKind = CliCommand['kind'];
export type ParseResult =
  | { readonly ok: true; readonly json: boolean; readonly command: CliCommand }
  | { readonly ok: false; readonly json: boolean; readonly message: string };

export interface ListData {
  readonly items: readonly PtoPageItem[];
  readonly complete: boolean;
  readonly reason: ListAllReason;
  readonly pages: number;
}

interface LocalProfileView {
  readonly profile: string | null;
  readonly origin: string;
  readonly source: CredentialSource;
}

interface DataByCommand {
  readonly help: { readonly text: string };
  readonly version: { readonly version: string };
  readonly 'auth-set': LocalProfileView;
  readonly 'auth-status': LocalProfileView & {
    readonly ownerId: string;
    readonly scopes: readonly PtoScope[];
    readonly expiresAt: string;
  };
  readonly 'auth-remove': {
    readonly profile: string;
    readonly source: CredentialSource;
    readonly removed: true;
    readonly guidance: string;
  };
  readonly list: ListData;
  readonly get: PtoDetail;
  readonly create: WriteData['create'];
  readonly update: WriteData['update'];
  readonly delete: WriteData['delete'];
}

export type CliSuccessFor<K extends CommandKind> = {
  readonly schemaVersion: typeof CLI_SCHEMA_VERSION;
  readonly ok: true;
  readonly command: K;
  readonly data: DataByCommand[K];
};

export type CliSuccess = { [K in CommandKind]: CliSuccessFor<K> }[CommandKind];

export interface CliFailure {
  readonly schemaVersion: typeof CLI_SCHEMA_VERSION;
  readonly ok: false;
  readonly command: CommandKind | null;
  readonly error: {
    readonly code: CliErrorCode;
    readonly message: string;
    readonly status: number | null;
    readonly requestId: string | null;
    readonly retryAfterMs: number | null;
  };
  readonly partial?: ListData;
  /**
   * The safe recovery facts of a write that did not end in a plain failure.
   *
   * The member is additive: a read or a write that failed in an ordinary way
   * carries no recovery, and a recovery never replaces the error itself.
   */
  readonly recovery?: WriteRecovery;
}

export type CliResult = CliSuccess | CliFailure;
