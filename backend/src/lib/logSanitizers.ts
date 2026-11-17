import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._\-]{1,200}$/;

export function safeRequestId(req: IncomingMessage, res: ServerResponse): string {
  const headerId = req.headers['x-request-id'];
  if (
    typeof headerId === 'string' &&
    headerId.length > 0 &&
    SAFE_REQUEST_ID.test(headerId) &&
    !/^pto_pat_/i.test(headerId)
  ) {
    res.setHeader('X-Request-Id', headerId);
    return headerId;
  }
  const id = randomUUID();
  res.setHeader('X-Request-Id', id);
  return id;
}

export function safeReqSerializer(value: Record<string, unknown>): Record<string, unknown> {
  const url = value['url'];
  // Token endpoints have no query API. Dynamic paths/queries can contain a
  // pasted credential; log only the fixed namespace, never those values.
  const safeUrl =
    typeof url === 'string' &&
    /^\/auth\/tokens(?:[/?#]|$)/i.test(url.replace(/^https?:\/\/[^/]*/i, ''))
      ? '/auth/tokens'
      : url;
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
