/**
 * The shared correlation-ID policy.
 *
 * A correlation ID is echoed in a response header, written to the request log
 * and stored in the audit trail, so it must never carry a credential or a
 * client key. This module is deliberately pure — it imports nothing — so the
 * HTTP pipeline and the audit trail share one rule without an import cycle,
 * and so it can be used before the logger and the body parser exist.
 */

/**
 * The grammar a correlation ID may use. It mirrors the database CHECK
 * constraint on the audit trail's request ID.
 */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._-]{1,200}$/;

/** Prior credential material: a personal access token. */
const PAT_MATERIAL = /pto_pat_/i;

/**
 * The canonical v1 create key, in full or embedded in a longer value.
 *
 * A key is client state for one approved intent, not a correlation ID. A
 * client that reuses its key as a request ID must not get it back in the
 * response, the log or the audit trail.
 */
const V1_CREATE_KEY =
  /v1\.\d{13}\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

/**
 * Whether a correlation ID may be used as it is.
 *
 * `submittedKeys` are the raw values of the submitted `Idempotency-Key`
 * header. A correlation ID that repeats one of them is refused as well, even
 * when that key is malformed: the value is client state either way. The
 * comparison is exact — no whitespace is trimmed and no list is joined — so an
 * ordinary request keeps its correlation ID.
 */
export function isSafeCorrelationId(value: string, submittedKeys: readonly string[] = []): boolean {
  if (!SAFE_CORRELATION_ID.test(value)) return false;
  if (PAT_MATERIAL.test(value)) return false;
  if (V1_CREATE_KEY.test(value)) return false;
  for (const key of submittedKeys) {
    if (key !== '' && key === value) return false;
  }
  return true;
}
