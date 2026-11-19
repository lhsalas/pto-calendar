import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { HttpError } from '../../middleware/errorHandler.js';
import {
  EXCLUSION_VIOLATION_SQLSTATE,
  PTO_OVERLAP_CONSTRAINT,
  isOwnerOverlapViolation,
  ownerOverlapConflict,
  throwIfPtoWriteConflict,
} from './constraintErrors.js';

/**
 * The shape the pinned driver adapter reports for an exclusion violation: a
 * known request error whose driver adapter cause keeps the SQLSTATE and the
 * PostgreSQL message. The row detail it also carries is never read.
 */
function overlapViolation(
  options: {
    constraint?: string;
    message?: string;
    sqlstate?: string;
    code?: string;
    errorCode?: string;
    meta?: Record<string, unknown>;
  } = {},
): Prisma.PrismaClientKnownRequestError {
  const constraint = options.constraint ?? PTO_OVERLAP_CONSTRAINT;
  const message =
    options.message ?? `conflicting key value violates exclusion constraint "${constraint}"`;
  const sqlstate = options.sqlstate ?? EXCLUSION_VIOLATION_SQLSTATE;
  return new Prisma.PrismaClientKnownRequestError(
    `Database error. Code: \`${sqlstate}\`. Message: \`${message}\``,
    {
      code: options.errorCode ?? 'P2039',
      clientVersion: '7.10.1',
      meta:
        options.meta ??
        ({
          modelName: 'PTORequest',
          driverAdapterError: {
            name: 'DriverAdapterError',
            cause: {
              kind: 'postgres',
              originalCode: sqlstate,
              code: sqlstate,
              severity: 'ERROR',
              originalMessage: message,
              message,
              detail:
                "Key (user_id, daterange(start_date, end_date, '[]'::text))=(...) conflicts with existing key (...)",
            },
          },
        } as Record<string, unknown>),
    },
  );
}

describe('the owner overlap constraint', () => {
  it('recognizes only the exclusion violation of this constraint', () => {
    expect(isOwnerOverlapViolation(overlapViolation())).toBe(true);
  });

  it('refuses other Prisma error classes even if their metadata looks similar', () => {
    expect(isOwnerOverlapViolation(overlapViolation({ errorCode: 'P2010' }))).toBe(false);
    expect(isOwnerOverlapViolation(overlapViolation({ errorCode: 'P2004' }))).toBe(false);
  });

  it('refuses a different constraint name ending in a dotted lookalike', () => {
    expect(
      isOwnerOverlapViolation(
        overlapViolation({ constraint: 'public.pto_requests_no_owner_overlap' }),
      ),
    ).toBe(false);
  });

  it('refuses another SQLSTATE', () => {
    expect(isOwnerOverlapViolation(overlapViolation({ sqlstate: '23505' }))).toBe(false);
    expect(
      isOwnerOverlapViolation(overlapViolation({ sqlstate: '23505', message: 'unique violation' })),
    ).toBe(false);
  });

  it('refuses another constraint of the same SQLSTATE', () => {
    expect(isOwnerOverlapViolation(overlapViolation({ constraint: 'other_exclusion' }))).toBe(
      false,
    );
    expect(
      isOwnerOverlapViolation(
        overlapViolation({ constraint: 'pto_requests_no_owner_overlap_extra' }),
      ),
    ).toBe(false);
  });

  it('refuses a message that is not the anchored PostgreSQL wording', () => {
    expect(
      isOwnerOverlapViolation(
        overlapViolation({ message: 'conflicting key value violates exclusion constraint' }),
      ),
    ).toBe(false);
    expect(
      isOwnerOverlapViolation(
        overlapViolation({
          message: 'something else entirely pto_requests_no_owner_overlap',
        }),
      ),
    ).toBe(false);
    expect(
      isOwnerOverlapViolation(
        overlapViolation({
          message:
            'conflicting key value violates exclusion constraint "pto_requests_no_owner_overlap" and more',
        }),
      ),
    ).toBe(false);
  });

  it('refuses an error without the driver adapter cause', () => {
    expect(isOwnerOverlapViolation(new Error('plain failure'))).toBe(false);
    expect(isOwnerOverlapViolation('a string')).toBe(false);
    expect(isOwnerOverlapViolation(null)).toBe(false);
    expect(isOwnerOverlapViolation(undefined)).toBe(false);
    expect(isOwnerOverlapViolation({ meta: {} })).toBe(false);
    expect(
      isOwnerOverlapViolation(
        new Prisma.PrismaClientKnownRequestError('missing adapter metadata', {
          code: 'P2039',
          clientVersion: '7.10.1',
        }),
      ),
    ).toBe(false);
    expect(isOwnerOverlapViolation(overlapViolation({ meta: { modelName: 'PTORequest' } }))).toBe(
      false,
    );
    expect(
      isOwnerOverlapViolation(
        overlapViolation({ meta: { driverAdapterError: { name: 'DriverAdapterError' } } }),
      ),
    ).toBe(false);
  });

  it('refuses another known request error, such as a constraint failure', () => {
    const other = new Prisma.PrismaClientKnownRequestError('constraint failed', {
      code: 'P2004',
      clientVersion: '7.10.1',
      meta: { modelName: 'PTORequest' },
    });
    expect(isOwnerOverlapViolation(other)).toBe(false);
  });

  it('requires the original SQLSTATE from the adapter', () => {
    const cause = {
      kind: 'postgres',
      code: EXCLUSION_VIOLATION_SQLSTATE,
      severity: 'ERROR',
      originalMessage: `conflicting key value violates exclusion constraint "${PTO_OVERLAP_CONSTRAINT}"`,
      message: `conflicting key value violates exclusion constraint "${PTO_OVERLAP_CONSTRAINT}"`,
    };
    const error = new Prisma.PrismaClientKnownRequestError('Database error', {
      code: 'P2039',
      clientVersion: '7.10.1',
      meta: { driverAdapterError: { name: 'DriverAdapterError', cause } },
    });
    expect(isOwnerOverlapViolation(error)).toBe(false);
  });

  it('requires the original message from the adapter', () => {
    const cause = {
      kind: 'postgres',
      originalCode: EXCLUSION_VIOLATION_SQLSTATE,
      severity: 'ERROR',
      message: `conflicting key value violates exclusion constraint "${PTO_OVERLAP_CONSTRAINT}"`,
    };
    const error = new Prisma.PrismaClientKnownRequestError('Database error', {
      code: 'P2039',
      clientVersion: '7.10.1',
      meta: { driverAdapterError: { name: 'DriverAdapterError', cause } },
    });
    expect(isOwnerOverlapViolation(error)).toBe(false);
  });

  it('refuses a driver error without a SQLSTATE and without a message', () => {
    const error = new Prisma.PrismaClientKnownRequestError('Database error', {
      code: 'P2039',
      clientVersion: '7.10.1',
      meta: { driverAdapterError: { name: 'DriverAdapterError', cause: { kind: 'postgres' } } },
    });
    expect(isOwnerOverlapViolation(error)).toBe(false);
  });

  it('refuses a driver error with a SQLSTATE but without any message', () => {
    const error = new Prisma.PrismaClientKnownRequestError('Database error', {
      code: 'P2039',
      clientVersion: '7.10.1',
      meta: {
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: { kind: 'postgres', originalCode: EXCLUSION_VIOLATION_SQLSTATE },
        },
      },
    });
    expect(isOwnerOverlapViolation(error)).toBe(false);
  });

  it('refuses the same text and SQLSTATE from a non-PostgreSQL adapter cause', () => {
    expect(
      isOwnerOverlapViolation(
        overlapViolation({
          meta: {
            driverAdapterError: {
              cause: {
                kind: 'sqlite',
                originalCode: EXCLUSION_VIOLATION_SQLSTATE,
                originalMessage: `conflicting key value violates exclusion constraint "${PTO_OVERLAP_CONSTRAINT}"`,
              },
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it('answers an overlap with the shared conflict', () => {
    let caught: unknown;
    try {
      ownerOverlapConflict();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect(caught).toMatchObject({ status: 409, code: 'CONFLICT' });
    expect((caught as HttpError).message).not.toMatch(/\d/);
  });

  it('reports a transaction write conflict without claiming any row overlapped', () => {
    expect(() =>
      throwIfPtoWriteConflict(
        overlapViolation({ errorCode: 'P2034', message: 'private database details' }),
      ),
    ).toThrow(new HttpError(409, 'CONFLICT', 'A concurrent write prevented this PTO change.'));
  });
});
