/**
 * The typed PTO API client.
 *
 * The client owns the wire contract: it validates every request it sends,
 * parses every response against the documented shape and turns an upstream
 * failure into a machine-readable error. It never logs, never echoes a
 * credential and never retries a write: the transport owns the network and the
 * retry policy, this layer owns the contract.
 */

import {
  createTransport,
  type PtoClientOptions,
  type RequestOptions,
  type TransportRequest,
  type TransportResult,
} from './transport.js';
import { PtoApiError } from './errors.js';
import {
  isIsoDateTime,
  parseCreateKey,
  parseDetail,
  parseIdentity,
  parsePage,
  parseRecord,
  PtoWireError,
  requireIfMatch,
  requireUuid,
  validateCreatePayload,
  validateListQuery,
  validatePatchChanges,
  type CreatePtoPayload,
  type CreatePtoResult,
  type ListAllQuery,
  type ListQuery,
  type PatchPtoChanges,
  type PtoDetail,
  type PtoIdentity,
  type PtoPage,
  type PtoRecord,
} from './wire.js';
import { traversePages, type ListAllOptions, type ListAllReason } from './pagination.js';

/** The status a documented answer carries. */
const STATUS_IDENTITY = 200;
const STATUS_READ = 200;
const STATUS_CREATE = 201;
const STATUS_UPDATE = 200;
const STATUS_DELETE = 204;

/** The replay window of a create key, in milliseconds. */
const REPLAY_WINDOW_MS = 86_400_000;

/** The result of a traversal, with the typed cause of an incomplete run. */
export interface ListAllClientResult {
  items: PtoPage['items'];
  complete: boolean;
  reason: ListAllReason;
  pages: number;
  error?: PtoApiError;
}

/** The client every adapter uses. */
export interface PtoClient {
  getIdentity(options?: RequestOptions): Promise<PtoIdentity>;
  listPage(query: ListQuery, options?: RequestOptions): Promise<PtoPage>;
  listAll(query: ListAllQuery, options?: ListAllOptions): Promise<ListAllClientResult>;
  getDetail(id: string, options?: RequestOptions): Promise<PtoDetail>;
  create(
    payload: CreatePtoPayload,
    idempotencyKey: string,
    options?: RequestOptions,
  ): Promise<CreatePtoResult>;
  patch(
    id: string,
    expectedVersion: number,
    changes: PatchPtoChanges,
    options?: RequestOptions,
  ): Promise<PtoRecord>;
  delete(id: string, expectedVersion: number, options?: RequestOptions): Promise<void>;
}

/**
 * Turns a wire mismatch into the fixed invalid-response error.
 *
 * The status and the sanitized correlation id of the answer are kept, and a
 * write that was already dispatched may have committed. Anything that is not
 * a wire mismatch is a defect of the client and is never masked as a service
 * answer.
 */
export function invalidResponseFor(
  error: unknown,
  context?: { status?: number; requestId?: string | null; write?: boolean },
): never {
  if (error instanceof PtoWireError) {
    throw new PtoApiError('INVALID_RESPONSE', {
      status: context?.status ?? 0,
      requestId: context?.requestId ?? null,
      unknownWriteOutcome: context?.write === true,
    });
  }
  throw error;
}

function requestOptions(options: RequestOptions): Partial<TransportRequest> {
  return {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };
}

/** The documented status of the answer, or a fixed invalid-response error. */
function requireStatus(result: TransportResult, expected: number, write: boolean): void {
  if (result.status === expected) return;
  invalidResponseFor(new PtoWireError(), {
    status: result.status,
    requestId: result.requestId,
    write,
  });
}

/** Parses the body of a documented answer. */
function parseBody<T>(result: TransportResult, parse: (body: unknown) => T, write: boolean): T {
  try {
    return parse(result.body);
  } catch (error) {
    return invalidResponseFor(error, {
      status: result.status,
      requestId: result.requestId,
      write,
    });
  }
}

/** The replay flag the service reported. */
function parseReplayed(value: string | null, result: TransportResult): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return invalidResponseFor(new PtoWireError(), {
    status: result.status,
    requestId: result.requestId,
    write: true,
  });
}

/** The expiry the service reported. */
function parseExpiresAt(value: string | null, result: TransportResult): string {
  if (value === null || !isIsoDateTime(value)) {
    return invalidResponseFor(new PtoWireError(), {
      status: result.status,
      requestId: result.requestId,
      write: true,
    });
  }
  return value;
}

/** The same record, whatever case the service used for the identifier. */
function sameId(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Creates the typed client.
 *
 * The credential and the base URL are bound together by the transport: the
 * token can only ever be sent to the one origin the caller named. The client
 * itself exposes no way to add a header, a URL or a transport.
 */
export function createPtoClient(options: PtoClientOptions): PtoClient {
  const transport = createTransport(options);

  const listPage = async (query: ListQuery, request: RequestOptions = {}): Promise<PtoPage> => {
    validateListQuery(query, true);
    // The filters are captured, so a caller that mutates its own object
    // cannot change a request that is already on its way.
    const filters = {
      start: query.start,
      end: query.end,
      ...(query.userId !== undefined ? { userId: query.userId } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    };
    const search = new URLSearchParams();
    search.set('start', filters.start);
    search.set('end', filters.end);
    if (filters.userId !== undefined) search.set('userId', filters.userId);
    search.set('format', 'page');
    if (filters.limit !== undefined) search.set('limit', String(filters.limit));
    if (filters.cursor !== undefined) search.set('cursor', filters.cursor);
    const result = await transport({
      method: 'GET',
      path: '/pto',
      query: search,
      ...requestOptions(request),
    });
    requireStatus(result, STATUS_READ, false);
    return parseBody(result, parsePage, false);
  };

  return {
    async getIdentity(request: RequestOptions = {}): Promise<PtoIdentity> {
      const result = await transport({
        method: 'GET',
        path: '/auth/me',
        ...requestOptions(request),
      });
      requireStatus(result, STATUS_IDENTITY, false);
      return parseBody(result, parseIdentity, false);
    },

    listPage,

    async listAll(query: ListAllQuery, options: ListAllOptions = {}): Promise<ListAllClientResult> {
      validateListQuery(query, false);
      // The validated filters and the caller's signal are captured before the
      // first page, so a mutation of the caller's object cannot change the
      // traversal.
      const filters: ListAllQuery = {
        start: query.start,
        end: query.end,
        ...(query.userId !== undefined ? { userId: query.userId } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
      };
      const signal = options.signal;
      const traversal = await traversePages(
        filters,
        { ...options, ...(signal ? { signal } : {}) },
        async (page) => {
          return listPage(
            {
              ...filters,
              ...(page.cursor === null ? {} : { cursor: page.cursor }),
            },
            {
              ...(signal ? { signal } : {}),
              // The remaining budget of the traversal bounds every request.
              timeoutMs: page.timeoutMs,
            },
          );
        },
      );
      const failure = traversal.failure;
      // The caller's own bound is not a service failure and carries no error.
      if (!failure || failure.reason === 'budget') {
        return {
          items: traversal.items,
          complete: traversal.complete,
          reason: traversal.reason,
          pages: traversal.pages,
        };
      }
      // A failure the service produced keeps its own safe fields; every other
      // stop gets a fixed local code.
      const error =
        failure.error instanceof PtoApiError
          ? failure.error
          : new PtoApiError(localCodeFor(failure.reason));
      return {
        items: traversal.items,
        complete: traversal.complete,
        reason: traversal.reason,
        pages: traversal.pages,
        error,
      };
    },

    async getDetail(id: string, request: RequestOptions = {}): Promise<PtoDetail> {
      const target = requireUuid(id);
      const result = await transport({
        method: 'GET',
        path: `/pto/${target}`,
        ...requestOptions(request),
      });
      requireStatus(result, STATUS_READ, false);
      const detail = parseBody(result, parseDetail, false);
      if (!sameId(detail.id, target)) {
        return invalidResponseFor(new PtoWireError(), {
          status: result.status,
          requestId: result.requestId,
          write: false,
        });
      }
      return detail;
    },

    async create(
      payload: CreatePtoPayload,
      idempotencyKey: string,
      request: RequestOptions = {},
    ): Promise<CreatePtoResult> {
      validateCreatePayload(payload);
      const key = requireKey(idempotencyKey);
      const result = await transport({
        method: 'POST',
        path: '/pto',
        body: { ...payload },
        idempotencyKey: key.value,
        ...requestOptions(request),
      });
      requireStatus(result, STATUS_CREATE, true);
      const record = parseBody(result, parseRecord, true);
      const replayed = parseReplayed(result.replayed, result);
      const expiresAt = parseExpiresAt(result.expiresAt, result);
      // The expiry belongs to the key: a different expiry would mean the
      // answer belongs to another intent.
      if (Date.parse(expiresAt) !== key.issuedAtMs + REPLAY_WINDOW_MS) {
        return invalidResponseFor(new PtoWireError(), {
          status: result.status,
          requestId: result.requestId,
          write: true,
        });
      }
      return { record, replayed, expiresAt };
    },

    async patch(
      id: string,
      expectedVersion: number,
      changes: PatchPtoChanges,
      request: RequestOptions = {},
    ): Promise<PtoRecord> {
      const target = requireUuid(id);
      const ifMatch = requireIfMatch(expectedVersion);
      validatePatchChanges(changes);
      const result = await transport({
        method: 'PATCH',
        path: `/pto/${target}`,
        body: { ...changes },
        ifMatch,
        ...requestOptions(request),
      });
      requireStatus(result, STATUS_UPDATE, true);
      const record = parseBody(result, parseRecord, true);
      if (!sameId(record.id, target)) {
        return invalidResponseFor(new PtoWireError(), {
          status: result.status,
          requestId: result.requestId,
          write: true,
        });
      }
      return record;
    },

    async delete(id: string, expectedVersion: number, request: RequestOptions = {}): Promise<void> {
      const target = requireUuid(id);
      const ifMatch = requireIfMatch(expectedVersion);
      const result = await transport({
        method: 'DELETE',
        path: `/pto/${target}`,
        ifMatch,
        ...requestOptions(request),
      });
      requireStatus(result, STATUS_DELETE, true);
    },
  };
}

/**
 * The fixed local code of a stop the service did not cause.
 *
 * A stop that the service produced keeps its own code; a stop that belongs to
 * the caller — a cancelled run, an expired deadline — gets one of the fixed
 * local codes. An answer that cannot be used gets the fixed invalid-response
 * code, never the code of the service.
 */
export function localCodeFor(reason: ListAllReason): string {
  if (reason === 'aborted') return 'ABORTED';
  if (reason === 'deadline') return 'TIMEOUT';
  return 'INVALID_RESPONSE';
}

/** The canonical create key with the time it was issued. */
function requireKey(value: unknown): { value: string; issuedAtMs: number } {
  const parsed = parseCreateKey(value);
  if (!parsed) {
    throw new PtoApiError('INVALID_INPUT');
  }
  return parsed;
}
