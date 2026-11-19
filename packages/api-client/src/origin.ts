import { PtoApiError } from './errors.js';

/**
 * A normalized, trusted origin.
 *
 * The value is the canonical form of the origin: the scheme, the host and the
 * port when it is not the default of the scheme. Two origins are the same
 * trusted origin only when their normalized values are equal.
 */
export interface TrustedOrigin {
  readonly value: string;
  readonly protocol: 'https:' | 'http:';
  readonly host: string;
  readonly port: string | null;
  /** True for the exact loopback hosts, never for an alias of them. */
  readonly isLoopback: boolean;
}

/** The literal hosts that may be reached over plain HTTP. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]', 'localhost']);

/**
 * Admit the raw origin syntax before WHATWG normalization. In particular,
 * normalization could erase a dot-segment path, userinfo or an encoded host.
 */
const ORIGIN_SHAPE =
  /^https?:\/\/(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[1-9][0-9]{0,4})?\/?$/i;

function invalid(): never {
  throw new PtoApiError('INVALID_OPTIONS');
}

/**
 * Parses one trusted origin.
 *
 * Require origin-only syntax and check that fetch's URL parser will use the
 * exact named host. Normalize casing and scheme-default ports but reject
 * alternate IP spellings, encoded hosts and ambiguous authorities.
 */
export function parseTrustedOrigin(raw: string, allowLoopbackHttp = false): TrustedOrigin {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) invalid();
  const match = ORIGIN_SHAPE.exec(raw);
  if (!match) invalid();
  const host = match[1]!.toLowerCase();
  if (host.includes('..')) invalid();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    invalid();
  }
  if (url.hostname !== host) invalid();
  const isLoopback = LOOPBACK_HOSTS.has(host);
  if (url.protocol === 'http:' && !(allowLoopbackHttp && isLoopback)) invalid();
  const port = url.port === '' ? null : url.port;
  return {
    value: url.origin,
    protocol: url.protocol === 'http:' ? 'http:' : 'https:',
    host,
    port,
    isLoopback,
  };
}

/**
 * True when two origins are the same trusted origin. The comparison is on the
 * normalized value, so a default port and its omitted form are one origin.
 */
export function sameOrigin(left: TrustedOrigin, right: TrustedOrigin): boolean {
  return left.value === right.value;
}
