import type { CreatePtoPayload, PatchPtoChanges, PtoDayPart } from '@pto-calendar/api-client';

import type { ReadAuthOptions } from './contract.js';

interface WriteOptions {
  readonly auth: ReadAuthOptions;
  readonly yes: boolean;
}

interface ExactTarget {
  readonly id: string;
  readonly version: number;
}

export type WriteCommand = WriteOptions &
  (
    | {
        readonly kind: 'create';
        readonly payload: CreatePtoPayload;
        readonly operationId?: string;
      }
    | ({ readonly kind: 'update'; readonly changes: PatchPtoChanges } & ExactTarget)
    | ({ readonly kind: 'delete' } & ExactTarget)
  );

/** Structural facts only; carrying a write scope doesn't confer note access. */
export interface WriteRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly version: number;
  readonly startDate: string;
  readonly endDate: string;
  readonly dayPart: PtoDayPart;
}

export interface WriteData {
  readonly create: {
    readonly record: WriteRecord;
    readonly operationId: string;
    readonly replayed: boolean;
    readonly expiresAt: string;
  };
  readonly update: { readonly record: WriteRecord };
  readonly delete: ExactTarget & { readonly ownerId: string };
}

export type WriteRecovery =
  | {
      readonly kind: 'create-pending';
      readonly operationId: string;
      readonly expiresAt: string;
    }
  | {
      readonly kind: 'outcome-unknown';
      readonly id: string;
      readonly expectedVersion: number;
    }
  | {
      readonly kind: 'stale';
      readonly id: string;
      readonly expectedVersion: number;
      readonly before: WriteRecord | null;
      readonly current: WriteRecord | null;
    };
