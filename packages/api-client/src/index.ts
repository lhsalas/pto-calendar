/**
 * The public surface of the shared PTO API client.
 *
 * The runtime surface is exactly two things: the client factory and the error
 * type. Everything else is a type: the inputs a caller may pass and the
 * results it may receive. There is deliberately no way to add a header, a
 * URL, a query string or a transport from here — the credential is bound to
 * the origin the caller named, and the transport is owned by the package.
 */

export { createPtoClient, type ListAllClientResult, type PtoClient } from './client.js';

export { PtoApiError } from './errors.js';

export type {
  CreatePtoPayload,
  CreatePtoResult,
  ListAllQuery,
  ListQuery,
  PatchPtoChanges,
  PtoDetail,
  PtoIdentity,
  PtoPage,
  PtoPageItem,
  PtoRecord,
  PtoRole,
  PtoScope,
  PtoDayPart,
  PtoUserSummary,
} from './wire.js';

export type { ListAllOptions, ListAllReason } from './pagination.js';

export type { PtoClientOptions, RequestOptions } from './transport.js';
