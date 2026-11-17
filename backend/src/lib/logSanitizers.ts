import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._\-]{1,200}$/;

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
  let safeUrl = url;
  if (typeof url === 'string') {
    // Do not decode or log an authority, query, or fragment. Match percent
    // encoded prefix bytes directly so malformed escapes cannot throw.
    const path = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').split(/[?#]/, 1)[0]!;
    if (/^\/auth\/tokens(?:\/|$)/i.test(path)) {
      safeUrl = '/auth/tokens';
    } else if (
      /(?:p|%70)(?:t|%74)(?:o|%6f)(?:_|%5f)(?:p|%70)(?:a|%61)(?:t|%74)(?:_|%5f)/i.test(path)
    ) {
      safeUrl = '[REDACTED]';
    } else {
      safeUrl = path;
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
