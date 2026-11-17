import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._\-]{1,200}$/;
const STATIC_URL_LABELS = new Map(
  [
    '/health',
    '/ready',
    '/auth/login',
    '/auth/setup-account',
    '/auth/logout',
    '/auth/me',
    '/pto',
    '/users',
    '/holidays',
    '/holidays/all',
    '/holidays/seed',
  ].map((label) => [label, label]),
);

export function safeRequestId(req: IncomingMessage, res: ServerResponse): string {
  const headerId = req.headers['x-request-id'];
  if (
    typeof headerId === 'string' &&
    headerId.length > 0 &&
    SAFE_REQUEST_ID.test(headerId) &&
    !/pto_pat_/i.test(headerId)
  ) {
    res.setHeader('X-Request-Id', headerId);
    return headerId;
  }
  // An early credential boundary may already have generated the safe ID before
  // pino/auth run. Preserve it so response, auth context and log IDs agree.
  const existing = res.getHeader('X-Request-Id');
  if (
    typeof existing === 'string' &&
    SAFE_REQUEST_ID.test(existing) &&
    !/pto_pat_/i.test(existing)
  ) {
    return existing;
  }
  const id = randomUUID();
  res.setHeader('X-Request-Id', id);
  return id;
}

export function safeReqSerializer(value: Record<string, unknown>): Record<string, unknown> {
  const url = value['url'];
  let safeUrl = '[unclassified]';
  if (typeof url === 'string') {
    // Classification happens before routing: never return any untrusted path
    // bytes, even when credentials are encoded or the path is malformed.
    const path = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').split(/[?#]/, 1)[0]!;
    if (/^\/auth\/tokens(?:\/|$)/i.test(path)) {
      safeUrl = '/auth/tokens';
    } else {
      safeUrl = STATIC_URL_LABELS.get(path.toLowerCase()) ?? '[unclassified]';
    }
  }
  return {
    id: value['id'],
    method: value['method'],
    url: safeUrl,
  };
}

export function safeResSerializer(value: Record<string, unknown>): Record<string, unknown> {
  return {
    statusCode: value['statusCode'],
  };
}
