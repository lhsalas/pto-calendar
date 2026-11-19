import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Options as PinoHttpOptions } from 'pino-http';
import type { Logger as PinoLogger } from 'pino';
import { safeErrorSerializer } from './logRedaction.js';
import { isSafeCorrelationId } from './requestCorrelation.js';

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

/**
 * The raw occurrences of the submitted `Idempotency-Key` header.
 *
 * The joined header value cannot tell a repeated header from a single one, so
 * the occurrences are read from the raw header list. The values are used only
 * to recognise a correlation ID that repeats a client key; they are never
 * logged, echoed or stored.
 */
function submittedIdempotencyKeys(req: IncomingMessage): string[] {
  const values: string[] = [];
  const raw = req.rawHeaders ?? [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    if (raw[index]?.toLowerCase() === 'idempotency-key') {
      values.push(raw[index + 1]!);
    }
  }
  return values;
}

export function safeRequestId(req: IncomingMessage, res: ServerResponse): string {
  const submittedKeys = submittedIdempotencyKeys(req);
  const headerId = req.headers['x-request-id'];
  if (typeof headerId === 'string' && isSafeCorrelationId(headerId, submittedKeys)) {
    res.setHeader('X-Request-Id', headerId);
    return headerId;
  }
  // An early credential boundary may already have generated the safe ID before
  // pino/auth run. Preserve it so response, auth context and log IDs agree.
  const existing = res.getHeader('X-Request-Id');
  if (typeof existing === 'string' && isSafeCorrelationId(existing, submittedKeys)) {
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

/**
 * The HTTP logging pipeline, assembled next to the serializers it uses so the
 * request pipeline and the application logger can never drift apart.
 *
 * pino-http would otherwise install its own error serializer, which copies
 * enumerable error properties and cause messages verbatim; the credential-safe
 * serializer is passed explicitly instead.
 */
export function createPinoHttpOptions(target: PinoLogger): PinoHttpOptions {
  return {
    logger: target,
    genReqId: safeRequestId,
    serializers: {
      req: safeReqSerializer,
      res: safeResSerializer,
      err: safeErrorSerializer,
    },
    autoLogging: {
      ignore: (req) => req.url === '/health' || req.url === '/ready',
    },
  };
}
