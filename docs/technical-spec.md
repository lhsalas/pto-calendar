# PTO / Vacation Calendar App Technical Specification

## 1. Purpose
This document defines the technical specification for an internal PTO/vacation calendar app where authenticated users can create and view PTO entries, and only the owner or a team lead can modify or delete them.

> **Agent-access architecture (#246):** the
> [shared scope/API/compatibility contract](agent-access-delivery-plan.md)
> covers session-only own-token management, scoped bearer REST, complete paged
> queries and versioned writes before CLI/local MCP delivery. The versioned
> write contract (#256) is implemented here: a failed `If-Match` is
> **412 STALE_WRITE**, a missing precondition is **428 PRECONDITION_REQUIRED**,
> and business/idempotency conflicts stay **409**. Owning implementation PRs
> update this specification, OpenAPI and browser callers together. The CLI and
> the local MCP server are still not distributed, and this documentation alone
> makes no route or security scheme available.

## 2. Scope
The application will support:
- Authentication for all users
- Role-based authorization
- PTO CRUD operations
- Monthly calendar view with month navigation
- Color-coded PTO display by employee
- Single-day half-day selection and multi-day full-day ranges

## 3. System Overview

### 3.1 High-level architecture
Confirmed architecture:
- **Frontend**: React 19 + TypeScript using Vite
- **Styling**: Tailwind CSS
- **Backend**: Node.js + Express + TypeScript
- **Database**: PostgreSQL with Prisma 7 and the `@prisma/adapter-pg` driver adapter.
  CLI configuration and migration paths live in `backend/prisma.config.ts`;
  it loads dotenv explicitly and uses `DATABASE_URL` when supplied. Generate
  the client after installing dependencies. The adapter creates its own
  PostgreSQL pool, which is disposed by `prisma.$disconnect()`.
- **Personal-token foundation (#249)**: internal persistence and services only;
  no PAT HTTP endpoints, bearer authentication, UI, CLI or MCP are enabled by
  this change. Token names are 1–120 Unicode code points with no surrounding
  whitespace. Scopes are validated, deduplicated by rejection and returned in
  canonical vocabulary order; absent scopes default to `pto:read`. The
  `pto:notes:read` scope requires `pto:read`, and team writes require a live
  team-lead/admin role. Lifetime defaults to 90 days and is bounded by 365
  24-hour days. Public metadata never includes the digest or secret.

  Issuance takes the session version captured by the caller's credential
  verification and locks the owner row before checking eligibility, version
  and the ten-active-token cap. Verification checks the database on each call.
  `changeRoleAndInvalidate` atomically increments `sessionVersion` with role
  changes; operational/manual role changes must do the same. Existing reset and
  setup operations already increment that version atomically. The development
  seed increments it when changing a seeded user's role or password. Revoked and
  expired metadata is retained for future audit attribution; no purge or
  plaintext recovery path is introduced. Verification updates `lastUsedAt`
  with an additional validity-guarded write; it does not cache validity.
  Its SQL guard uses live database time, and a final application-clock check
  after the write rejects expiry crossed while waiting for a row lock.

  Token persistence uses a small native `pg` boundary rather than Prisma
  operations containing digests: Prisma diagnostic argument logging can expose
  those values even when the service later sanitizes an error. The existing
  Prisma model and additive migration still own the schema. No global debug
  output is disabled or filtered. The repository binds data parameters, quotes
  the configured schema, sends UTC wall-clock timestamp strings and returns
  timestamp columns as UTC `timestamptz` instants.

  `createTokenDatabase` creates one lazy, owned pool; its caller must await
  `close()` at shutdown. No token pool is created at module import. A borrowed
  pool wrapper does not end its caller's pool. Transactions explicitly use one
  checked-out client with read-committed isolation, so the active-token count
  sees prior issuances after waiting for the owner lock. Error paths roll back
  and release or discard that client, exposing only generic errors without
  driver causes. Idle errors on an owned pool fail the wrapper closed; recovery
  requires an explicit replacement. Unknown issuance outcomes are not retried
  automatically: list safe metadata and revoke an unusable entry instead.

  Each Express application owns one lazy token runtime. It opens no connection
  until a token operation needs the pool; `app.closeResources()` closes that
  runtime permanently and is awaited by graceful shutdown after HTTP drain,
  before Prisma disconnect. Integration test teardown also awaits it.
- **Shared API client package ([#259](https://github.com/lhsalas/pto-calendar/issues/259))**: `packages/api-client`
  is a private, unpublished npm workspace holding the shared typed HTTP client
  for the REST API. It is runtime-neutral Node ESM: no Vite, no browser
  globals, no cookie jar, no database driver and no dependency on the backend
  or frontend sources. The backend remains authoritative for validation,
  scopes, live role/ownership, privacy, audit and write integrity; the client
  only encodes the wire contract.

  The caller supplies an explicit base URL and an explicit credential
  (origin + token). The credential origin is normalized and matched exactly
  against the request origin; HTTPS is required and plain HTTP is accepted
  only for an explicit literal loopback development opt-in. URL userinfo,
  cross-origin redirects, caller-supplied request URLs and caller-supplied
  header maps are all rejected. The client builds every request internally
  against a frozen authority, sends the exact backend PAT wire format and
  never follows a redirect.

  Reads use a real `AbortSignal` deadline that spans the body and the backoff
  window, with bounded read retries and safe `Retry-After` handling. Writes
  are never retried automatically; a create is replayed only with the same
  caller-supplied idempotency key, and the client never mints one. Errors are
  reported through a sanitized envelope (`code`, `status`, `requestId`,
  `retryAfterMs`, `unknownWriteOutcome`); upstream messages, bodies, URLs,
  headers, tokens and arbitrary causes are never copied into an error.

  The package is built as ESM with type declarations, targets the same
  Node.js floor as the repository root and is consumed from the local
  workspace source only. It has no registry, release or public SDK support
  promise.
- **Authentication**: Email/password authentication for manually seeded users with bcrypt password hashing and HTTP-only cookie sessions

### 3.2 Core modules
- Auth module
- Users module
- PTO module
- Calendar query module
- Authorization module
- **Rate-limit module** (`backend/src/lib/rateLimit.ts`) — factory functions for the strict login limiter and the global limiter, plus the shared Redis connection and its lifecycle
- **Agent quota module** (`backend/src/middleware/agentQuota.ts`) — the personal-token issuance and authenticated-traffic quotas: namespaced shared counters, the bounded policy, the verified-identity keys and the standard rejection response
- **Lifecycle module** (`backend/src/lib/lifecycle.ts`) — graceful shutdown (SIGTERM/SIGINT drain + `prisma.$disconnect` + `SHUTDOWN_TIMEOUT_MS` fallback + uncaughtException/unhandledRejection handlers)
- **Health route** (`backend/src/routes/health.ts`) — `GET /health` (liveness, no DB) and `GET /ready` (readiness, DB probe)
- **Shared Zod schemas** (`backend/src/services/auth/schemas.ts`, `backend/src/services/pto/schemas.ts`) — request validation defined once, imported by routes and the validation layer
- **Shared API client module** (`packages/api-client/`) — the runtime-neutral typed REST client shared by the planned CLI and local MCP adapters: origin binding and credential injection, bounded read retries with real abort/deadline handling, the sanitized error envelope and the paged-read traversal with completeness metadata
- **Local agent credential module** (`packages/agent-auth/`) — trusted-host
  profile selection, exact origin binding, hidden setup input, and
  separately redacted local status. Prefer a supported Linux Secret Service
  store, with owner-only file storage only by explicit opt-in. Resolve
  without prompting, and treat local removal separately from remote revoke.
  No requests, browser state or CLI/MCP protocol behavior are introduced.
- **Read-only terminal client** (`cli/`) — the private `pto` executable
  composes those two packages. Explicit setup handles hidden TTY or stdin;
  status checks the same origin at `/auth/me`. List/get expose bounded reads,
  sanitized output, and an explicit incomplete result. No cookie reuse,
  remote mutations, or changes to the REST API or production flags.

## 4. Roles and Access Model

### 4.1 Roles
- `member`
- `team_lead`

### 4.2 Access matrix
| Action | Member | Team Lead |
|---|---|---|
| Log in | Yes | Yes |
| View all PTOs | Yes | Yes |
| Create own PTO | Yes | Yes |
| Edit own PTO | Yes | Yes |
| Delete own PTO | Yes | Yes |
| Edit others' PTO | No | Yes |
| Delete others' PTO | No | Yes |

### 4.3 Authorization rules
- All endpoints require authentication unless explicitly public
- PTO update/delete requires one of:
  - requester is PTO owner
  - requester role is `team_lead`

## 5. Domain Model

### 5.1 User
Represents an authenticated employee using the app.

Fields:
- `id: uuid`
- `name: string`
- `email: string`
- `role: enum(member, team_lead)`
- `colorCode: string`
- `createdAt: datetime`
- `updatedAt: datetime`

### 5.2 PTORequest
Represents a planned time-off entry.

Fields:
- `id: uuid`
- `userId: uuid`
- `startDate: date`
- `endDate: date`
- `dayPart: enum(morning, evening, all_day)`
- `note: string | null`
- `createdAt: datetime`
- `updatedAt: datetime`
- `version: integer` — optimistic-concurrency revision; starts at 1 for new and migrated rows and increments by one on every successful write

Rules:
- If `startDate == endDate`, `dayPart` is required
- If `startDate != endDate`, `dayPart` is normalized to `all_day`
- PTO entries cannot overlap another PTO entry for the same user
- PTO cannot start or end on a weekend
- Weekends inside a multi-day PTO range count and are displayed as part of the continuous PTO
- `version` is never derived by a client: it is read from the detail, create or paged response and stated back as the write precondition

### 5.3 Holiday
A public holiday. Read by every authenticated user; written by team leads only. Two holidays on the same `date` with different `countryCode` values coexist; the unique key is `(date, country_code)`. A `countryCode` of `null` denotes a locale-agnostic holiday that applies to everyone. Holidays do not interact with PTO validation — a PTO that starts or ends on a holiday is allowed.

Fields:
- `id: uuid`
- `date: date`
- `name: string`
- `countryCode: string | null` (ISO 3166-1 alpha-2, or null)
- `createdById: uuid` (FK to `users.id`)
- `createdAt: datetime`
- `updatedAt: datetime`

## 6. Database Schema

### 6.1 PostgreSQL DDL
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  role VARCHAR(20) NOT NULL CHECK (role IN ('member', 'team_lead')),
  color_code VARCHAR(20) NOT NULL,
  password_hash TEXT NOT NULL,
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE pto_requests (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  day_part VARCHAR(20) NOT NULL CHECK (day_part IN ('morning', 'evening', 'all_day')),
  note TEXT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CHECK (end_date >= start_date),
  CHECK (start_date = end_date OR day_part = 'all_day')
);
```

### 6.1a Owner/date exclusion constraint (#257)
```sql
-- Trusted extension: the database owner (or a role with CREATE on the
-- database) installs it without superuser rights.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE pto_requests
  ADD CONSTRAINT pto_requests_no_owner_overlap
  EXCLUDE USING gist (
    user_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  );
```

- The invariant is enforced **at the database boundary**, so it holds for
  every write path — browser session, personal token and future adapter — and
  not only for the preflight check.
- `daterange(start_date, end_date, '[]')` is inclusive on both ends: a
  single-day entry and a range that starts on the same day overlap. Two
  half-day entries of one owner on the same date therefore conflict, while
  entries of different owners never do.
- `btree_gist` provides the UUID equality operator class the constraint needs.
- The migration preflights the existing rows first. If two entries of one
  owner already overlap, the migration stops with a sanitized, actionable
  report (how many stored entries end before they start and how many overlap
  another entry of the same owner; no entry data is listed). It never rewrites
  or deletes PTO.
- The role that applies the migration must own `pto_requests` and needs
  `CREATE` on the database when the extension is not installed yet.
- The backup archive must carry the extension declaration: a schema dump
  that only covers the `public` schema omits it, and such an archive cannot be
  restored. See [`deploy.md`](deploy.md) §5.1.

### 6.2 Recommended indexes
```sql
CREATE INDEX idx_pto_requests_user_id ON pto_requests(user_id);
CREATE INDEX idx_pto_requests_start_date ON pto_requests(start_date);
CREATE INDEX idx_pto_requests_end_date ON pto_requests(end_date);
CREATE INDEX idx_pto_requests_date_range ON pto_requests(start_date, end_date);
```

### 6.3 Audit table
Audit logging for update/delete actions is included in MVP. #252 adds credential
attribution and records PTO creates and the token/credential lifecycle as well.
```sql
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  action VARCHAR(50) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id UUID NOT NULL,
  details JSONB NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  credential_type VARCHAR(32) NULL,
  source_token_id UUID NULL,
  target_owner_id UUID NULL,
  request_id VARCHAR(200) NULL
);
```

Attribution columns are additive and nullable. `credential_type` is a closed
vocabulary (`session`, `personal_access_token`, `setup_token`, `operator`),
enforced by a CHECK constraint. `source_token_id` carries the **public** personal
token ID and is only allowed with the `personal_access_token` credential. It is a
plain UUID with **no foreign key**, so audit history survives token revocation
and credential metadata deletion; deleting a credential never cascades into the
audit trail. `target_owner_id` records the owner of the affected record or
credential, which differs from `actor_user_id` when a team lead acts on a
colleague's request. `request_id` carries the safe correlation ID and is
constrained to `[A-Za-z0-9._-]{1,200}` and may never contain a personal-token
prefix. Legacy rows keep `NULL` attribution: there is no backfill, rewrite or
deletion of historical records.

`audit_logs` has no public browsing endpoint or UI; the table is internal and
is read only by internal tooling. The recorded `details` are a flat change
summary (dates, day part, scopes, roles, session version, whether a note was
written). **New audit rows never contain note text.** Historic rows written
before #252 can still contain the note text: they are retained exactly as they
are, with no automatic expiry and no cleanup, and reading that privileged
history is restricted to internal operator/database access. No cleanup is
performed without separate authorization.

## 7. API Contracts

### 7.0 Operational middleware (applied to every request)

Every response carries an `X-Request-Id` header — UUID v4 generated by `crypto.randomUUID()`, or the inbound `X-Request-Id` if the client supplied one and matches the safe character class `[A-Za-z0-9._-]{1,200}`; values outside that class or containing the PAT prefix anywhere are replaced with a safe ID. Every non-probe request reaching logging produces one structured log line via `pino-http` (with `req.{id, method, url}`, `res.statusCode`, `responseTime`); `/health` and `/ready` are skipped via `autoLogging.ignore`.

The base `pino` logger applies a `redact` configuration covering `req.headers.cookie`, `req.headers.authorization`, `res.headers["set-cookie"]`, `password`, `passwordHash`, `token`, and `secret` (at the top level and under any object), with `[REDACTED]` as the censor. Custom `req` and `res` serializers drop the `headers` field entirely so cookie / `Set-Cookie` / `Authorization` values never reach stdout even if the redact path is misconfigured. Logged URLs contain only fixed allowlisted endpoint labels, `/auth/tokens` for that namespace, or `[unclassified]`; authority, query, fragment and arbitrary dynamic path content are never logged, regardless of encoding. Classification does not depend on routing or authentication having run. Login request bodies are never serialized into log lines (the default pino-http path does not log bodies on success, and the safe `req` serializer omits `body` on error).

Redact paths are shallow by design, so #252 complements them with instrumented
transforms in `backend/src/lib/logRedaction.ts`, wired through the production
`LOGGER_OPTIONS` (every logger built from those options is equally protected):

- `formatters.log` walks the whole merging object before any serializer runs. A
  credential key (`password`, `passwordHash`, `rawToken`, `secretDigest`,
  `setupToken`, `setupTokenHash`, `authorization`, `cookie`, `token`, `secret`,
  `credential`, …) is redacted **at any depth**, not at a fixed wildcard depth.
  Cycles, oversized breadth, excessive depth and binary payloads are replaced
  by markers instead of being emitted, and the input is never mutated.
- `hooks.logMethod` scrubs the arguments of every log call. The **first**
  argument is the structured log payload when it is an object, so the
  allowlisting serializers still own `req`, `res` and `err` there. Every other
  argument is message or interpolation data, where no serializer applies, and
  every key of it is scrubbed — including a request-shaped or error-shaped
  interpolation value.
- `serializers.err` replaces the pino error serializer, so an error's type,
  message, stack, own enumerable properties and `cause` are scrubbed at any
  depth instead of copied verbatim. The `pino-http` pipeline is configured with
  the same serializer, because pino-http would otherwise install its own error
  serializer that copies enumerable error properties and cause messages.
- `serializers.msg` scrubs the final message, which is where interpolated
  values land after formatting.
- `hooks.streamWrite` scrubs the finished record. Pino v10 serializes
  child-logger bindings outside `formatters.log` and resets a custom
  `formatters.bindings` for every child, so the finished record is the only
  boundary that sees the bindings of every child at every depth. The request
  and response metadata survive it: the allowlisting serializers have already
  reduced them to `{id, method, url}` and `{statusCode}`.

`req`, `res` and `err` keys of the structured payload are serializer-owned: they
pass through the formatter untouched so the allowlisting serializers stay the
only way those objects are logged. The application itself creates no child
loggers, and `pino-http` binds only the raw request, which the `req` serializer
reduces to `{id, method, url}`.

A body-parser error quotes the request body in its message, so `errorHandler`
never logs such an error verbatim: it records the correlation ID and a
`request_body_error` classification instead. If parsing fails before the HTTP
logger runs, the handler establishes the safe response/log correlation ID itself.
The owner-approved additive header also applies to malformed and oversized JSON;
the response status and error envelope are unchanged.

Global middleware order:
1. `app.disable('x-powered-by')`
2. `helmet()` — canonical security headers (CSP, HSTS, `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, COOP/CORP/OAC)
   For `/auth/tokens` and its children, a narrow boundary then sets `no-store`
   and a safe correlation ID before CORS/body parsing/CSRF/limiter failures.
   Authorization-bearing requests get the same early headers. Generated IDs
   survive later logging/auth layers so context, response and logs agree.
3. `cors({ origin: env.CORS_ORIGIN, credentials: true, preflightContinue: true })`
4. `express.json({ limit: '100kb' })` for requests without Authorization
5. `pinoHttp(...)` — generates the `X-Request-Id` and emits the request-completion log
6. `cookieSession(...)`
7. `createGlobalLimiter()` — per-IP rate limiter (default 100/15min); returns `429 RATE_LIMITED` + `Retry-After` on overflow
8. `createPatAuth(tokenRuntime)` — strict credential selection, live verification,
   default-deny route classification and server write/scope gates; no session fallback.
   The failed-bearer budget is charged here **before** the credential lookup and is
   refunded as soon as the secret verifies; the verified token then pays its own
   user and token traffic budgets once, before the scope gate
9. `csrfOriginMiddleware()` — unchanged browser rules, verified cookie-free PAT
   exemption only, retaining foreign-Origin rejection on writes
10. The same JSON parser handles Authorization requests that passed the limiter,
    PAT selector and CSRF checks. Invalid credentials receive generic 401 even
    with malformed input, unless the limiter has already returned 429.
11. `finishPreflight` returns the existing 204 for cookie-free non-bearer
    preflight; Authorization-bearing OPTIONS is denied rather than implicitly
    authenticating. CORS origins/credentials have not been widened.
12. `requireAuth` charges the verified-user traffic budget once, after the live
    record and session version are verified; a rejected budget answers `429`
    with the standard envelope instead of running the route

Operational probes (unauthenticated, registered before `authRouter`/`ptoRouter`):

- `GET /health` — liveness. Always returns `200` + `{ "status": "ok" }` while the process is responsive; no DB check.
- `GET /ready` — readiness. Runs `prisma.$queryRaw\`SELECT 1\`` with a `READY_TIMEOUT_MS` (default 5s) race-timer. Returns `200` + `{ "status": "ready", "db": "ok", "uptime": <seconds> }` on success, `503` + `{ "error": { "code": "NOT_READY", "details": { "db": "unreachable" } } }` on failure or timeout. The DB error message is logged server-side via `logger.warn({ err }, 'Readiness check failed')` but never returned to the client (no host/DSN leak).

### 7.1 Authentication APIs

#### POST /auth/login
Authenticates a user. Subject to the strict login limiter (default 5 failed attempts per 15 min per IP, `skipSuccessfulRequests: true`) in addition to the global limiter; rate-limit overflow returns `429` + `Retry-After` + `{ "error": { "code": 'RATE_LIMITED', "message": "..." } }`. The error message is byte-identical for unknown email, bad password, and empty password; the unknown-email and empty-password paths run a dummy `bcrypt.compare` against a module-level precomputed hash (`backend/src/services/auth/AuthService.ts`) so response time does not leak which branch fired. The same dummy-compare covers the `passwordHash == null` case once the self-service setup flow (#62) lands. The login form (`frontend/src/pages/LoginPage.tsx`) caps the email input at 254 characters (RFC 5321 practical max) and the password input at 72 characters (bcrypt's hard cap) to mirror the server's `LoginSchema.email.max(254)` and `bcryptjs` silent-truncation behavior; the caps prevent a minor DoS surface (oversized payloads to `/auth/login`) and a password-truncation footgun.

Request:
```json
{
  "email": "user@example.com",
  "password": "secret"
}
```

Response 200:
```json
{
  "user": {
    "id": "uuid",
    "name": "Jane Doe",
    "email": "jane@example.com",
    "role": "member",
    "colorCode": "#3B82F6"
  }
}
```

#### POST /auth/logout
Response 204.

#### GET /auth/me
Browser-session response 200 (unchanged):
```json
{
  "id": "uuid",
  "name": "Jane Doe",
  "email": "jane@example.com",
  "role": "member",
  "colorCode": "#3B82F6"
}
```

A verified PAT instead receives only `{ id, role, auth: { method: "pat",
tokenId, scopes, expiresAt } }`, with absolute UTC expiry and no password,
digest/raw secret, email or browser `sessionVersion`. This status endpoint
does not require `pto:read` and never starts/updates a browser session.

#### Session-only personal-token management

All `member`, `team_lead` and `admin` browser sessions manage only their own
tokens. `GET /auth/tokens` returns `{ tokens: [...] }` with safe metadata.
`POST /auth/tokens` accepts a strict object with `name`, `password`, optional
`scopes` and `expiresInDays`; it returns 201 `{ rawToken, token }` exactly once.
Passwords are 1–72 characters, as for login, and are verified afresh by the
session-derived owner ID. The live credential version used by that proof is
passed to the serialized issuance primitive; there is no recent-auth cache.
Token issuance and the issuance password check have their own per-owner
budgets (#253) and no longer consume the browser login budget; the browser
login keeps its five failed attempts per address and window.

Unknown properties/query fields, owner/role spoofing, invalid scope dependencies
or lifetimes return 400 `VALIDATION_ERROR`; team scopes require live lead/admin
eligibility (403 `FORBIDDEN`). The active cap returns 409 `TOKEN_LIMIT_REACHED`.
Invalid sessions/passwords return 401; Authorization-bearing requests return
generic 401 `UNAUTHENTICATED`, never cookie fallback. Management DB failures fail closed with a
generic 500. Malformed/oversized/unsupported parser input returns 400/413/415,
without serializing parser bodies, Zod inputs or driver causes.

`DELETE /auth/tokens/:id` returns 204 for an own token, including an already
revoked token; foreign and unknown valid UUIDs both return 404 `NOT_FOUND`.
`POST /auth/tokens/revoke-all` returns 204. Both accept only an absent/empty
body, need no fresh password, retain normal cookie CSRF/Origin checks and
never return credentials. Logout does not revoke PATs.

Every management response, including early errors and 429s, is `no-store` with
`X-Request-Id`. Request logs replace dynamic token paths/queries with the fixed
`/auth/tokens` namespace; a pasted `pto_pat_` credential cannot become a request
ID. OpenAPI defines the complete payload/status contract.
There is no token UI yet; lifecycle auditing,
dedicated quotas and the separate pilot/release gates remain prerequisites.

#### Scoped personal-token authentication (#251)

`req.auth` is a discriminated `session | pat` context with shared
`actor: { id, role }` and safe `requestId`. PAT context adds only public
`tokenId`, validated scopes and absolute expiry. `req.user` and browser
`sessionVersion` remain session-only; browser role-cache/lifetime semantics
are unchanged. PATs never reuse the browser cache and use the same
application-owned native token runtime on every request.

Only GET/POST `/pto`, GET/PUT/DELETE `/pto/:uuid` and GET `/auth/me` are
deliberately classified. HEAD, OPTIONS with credentials, PATCH (not implemented
yet), non-UUID/unclassified paths, login/setup/logout/token management,
users, holidays and probes cannot authenticate with a PAT. Ineligible routes,
disabled/invalid credentials and verifier DB failures share a generic 401.
Duplicate Authorization fields, malformed schemes/credentials and any Cookie
header (including empty/invalid/unrelated cookies) with Authorization are denied.

Strict `PAT_AUTH_ENABLED` and `PAT_WRITES_ENABLED` boolean strings both default
to false in **all** environments. Neither issue delivery nor minting a token
enables writes. Explicit test flags exercise the foundation while production
stays disabled pending the audit/quota/query/client/pilot gates in the ADR.

Read scope grants shared calendar metadata; list notes are always null.
Create scope grants only owner creation. Updates/deletes require the matching
self scope on an owned record, or explicit team scope **and** a live lead/admin
role **and** existing record authority. Note redaction uses note-read scope
plus `canViewNote` on detail **and POST/PUT responses**; write scopes alone
never reveal the old stored note when PUT omits it. Scope/write-gate failures
are 403 `FORBIDDEN`; all Authorization-bearing responses are no-store.

Production cookie requests still need the allowed Origin/Referer on writes.
Only successfully verified cookie-free PAT writes may omit that browser
proof; foreign Origin/Referer remains rejected. Raw headers alone confer no
exemption. Verification checks live expiry/revocation/password/version/role;
reset/revoke/demotion take effect on the next request across instances, and
subsequent promotion does not revive an invalidated token.

### 7.2 PTO APIs

#### GET /pto?start=YYYY-MM-DD&end=YYYY-MM-DD
Returns PTO entries that overlap the requested calendar range, including
adjacent-month days. The unchanged browser request returns the legacy array,
capped at 1,000 rows. Clients that need a complete traversal must opt in to
`format=page`.

Example request:
`GET /pto?start=2026-04-27&end=2026-05-31`

Response 200:
```json
[
  {
    "id": "uuid",
    "user": {
      "id": "uuid",
      "name": "Jane Doe",
      "colorCode": "#3B82F6"
    },
    "startDate": "2026-05-10",
    "endDate": "2026-05-12",
    "dayPart": "all_day",
    "note": null
  },
  {
    "id": "uuid",
    "user": {
      "id": "uuid",
      "name": "John Doe",
      "colorCode": "#10B981"
    },
    "startDate": "2026-05-20",
    "endDate": "2026-05-20",
    "dayPart": "morning",
    "note": null
  }
]
```

Query behavior:
- Return any PTO where:
  - `start_date <= requested_end`
  - `end_date >= requested_start`
- Start and end must be real `YYYY-MM-DD` dates, ordered and at most 366 days
  inclusive. A valid UUID `userId` can filter either representation. The filter
  runs in PostgreSQL before ordering and limiting; a nonexistent owner yields
  an empty result. All permitted readers see the same shared metadata.
- Both list representations always include `note: null`; the database query
  does not select notes. Note access through the detail endpoint is unchanged.

With `format=page`, `limit` is optional (default 100, range 1–200) and the
response is `{ items, nextCursor, hasMore }`. Ask for the next page using
`cursor=<nextCursor>` with the same date range and normalized owner filter.
`hasMore: false` and `nextCursor: null` indicate that this read found no later
rows, including an empty result. `limit` and `cursor` are invalid without
`format=page`.

Pages use the ascending `(startDate, userId, id)` key and a `limit + 1` read
instead of an offset or anchor lookup. A cursor is opaque, bounded to 512
characters and signed with a domain-separated HMAC using the active session
key. A key rotation invalidates prior cursors; restart without the cursor.
Malformed or mismatched cursors return the standard `400 VALIDATION_ERROR`
and `X-Request-Id`, without echoing the cursor. Authentication and scope checks
still apply to each request. Signing validates integrity, not authorization.

Each page queries current data, not a point-in-time snapshot. Changes ahead
of a cursor can appear on a later page; changes at or behind the boundary
can be missed, and moving a previously returned row forward can repeat it.
Adapters must follow the [bounded traversal and incomplete-result rules](./agent-access-delivery-plan.md#4-adapter-distribution-and-client-acceptance-contract).

#### GET /pto/:id
Response 200:
```json
{
  "id": "uuid",
  "user": {
    "id": "uuid",
    "name": "Jane Doe",
    "colorCode": "#3B82F6"
  },
  "startDate": "2026-05-10",
  "endDate": "2026-05-10",
  "dayPart": "evening",
  "note": "Appointment",
  "version": 1
}
```

The `version` is the value a write must state as its `If-Match` precondition.

#### POST /pto
Creates a PTO record for the authenticated user.

Request:
```json
{
  "startDate": "2026-05-10",
  "endDate": "2026-05-10",
  "dayPart": "morning",
  "note": "Doctor"
}
```

Validation:
- `startDate` required
- `endDate` required
- `endDate >= startDate`
- if same day, `dayPart` required and must be `morning`, `evening`, or `all_day`
- if multi-day, `dayPart` is normalized to `all_day`
- reject PTO where `startDate` or `endDate` falls on Saturday or Sunday
- allow Saturday/Sunday inside a multi-day PTO range and display those dates in the calendar
- reject overlapping PTO entries for the same user

Response 201:
```json
{
  "id": "uuid",
  "userId": "uuid",
  "startDate": "2026-05-10",
  "endDate": "2026-05-10",
  "dayPart": "morning",
  "note": "Doctor",
  "createdAt": "2026-05-03T12:00:00Z",
  "updatedAt": "2026-05-03T12:00:00Z",
  "version": 1
}
```

#### PUT /pto/:id
Updates a PTO record if requester is owner or team lead.

Requires the `If-Match` precondition: one canonical quoted strong version,
for example `If-Match: "1"`. A missing precondition is `428
PRECONDITION_REQUIRED`, a malformed one is `400 VALIDATION_ERROR` and an
outdated one is `412 STALE_WRITE` with the stored record unchanged.

Request:
```json
{
  "startDate": "2026-05-11",
  "endDate": "2026-05-11",
  "dayPart": "all_day",
  "note": "Updated plan"
}
```

Response 200:
```json
{
  "id": "uuid",
  "userId": "uuid",
  "startDate": "2026-05-11",
  "endDate": "2026-05-11",
  "dayPart": "all_day",
  "note": "Updated plan",
  "updatedAt": "2026-05-03T12:30:00Z",
  "version": 2
}
```

#### PATCH /pto/:id
Changes only the fields the request carries. An omitted key preserves the
stored value, so a client never has to read, merge or write back a field it
did not change. The merged record is validated with every create-time rule
before anything is written.

Requires the same `If-Match` precondition as `PUT` (`428` when missing, `400`
when malformed, `412` when outdated), and the same scope, live role and
record authorization as the legacy PUT.

Request (a non-empty object; only these four keys are accepted):
```json
{
  "dayPart": "evening"
}
```

The note contract matches the legacy PUT and adds an explicit null: omit
`note` to preserve it, send `null` or `""` to clear it, send a non-empty
string to replace it. `null` stays invalid for `PUT`.

Response 200: the updated record with the incremented `version`.

#### DELETE /pto/:id
Deletes a PTO record if requester is owner or team lead.

Requires the `If-Match` precondition: one canonical quoted strong version,
for example `If-Match: "2"`. A missing precondition is `428
PRECONDITION_REQUIRED`, a malformed one is `400 VALIDATION_ERROR` and an
outdated one is `412 STALE_WRITE` — a stale delete never removes a newer
revision.

Response 204, empty body.

### 7.3 Holiday APIs

#### GET /holidays?start=YYYY-MM-DD&end=YYYY-MM-DD
Returns every holiday whose `date` falls within `[start, end]` (inclusive). Open to any authenticated user.

Response 200:
```json
[
  { "id": "uuid", "date": "2026-07-04", "name": "Independence Day", "countryCode": "US" },
  { "id": "uuid", "date": "2026-12-25", "name": "Christmas Day", "countryCode": null }
]
```

#### GET /holidays/all
Returns every holiday in the system. Used by the team-lead admin page.

#### POST /holidays
Creates a holiday. Team-lead only (403 otherwise). Writes an audit-log entry `action='create_holiday'` with `{ id, date, name, countryCode }`.

Request:
```json
{ "date": "2026-07-04", "name": "Independence Day", "countryCode": "US" }
```

`countryCode` is optional and nullable. Two holidays on the same `date` with different `countryCode` coexist; two holidays on the same `date` with the same `countryCode` return `409 CONFLICT`.

Response 201: the created holiday.

#### DELETE /holidays/:id
Deletes a holiday. Team-lead only (403 otherwise). Writes an audit-log entry `action='delete_holiday'`.

Response 204.

#### POST /holidays/seed
Inserts the federal-holiday preset for a supported country. Team-lead only (403 otherwise). Idempotent on the `(date, country_code)` unique constraint. Writes an audit-log entry `action='seed_holidays'` with `{ countryCode, inserted, skipped, errorCount }`.

Request:
```json
{ "countryCode": "US" }
```

Response 200:
```json
{ "inserted": 26, "skipped": 0, "errors": [] }
```

Supported `countryCode` values: `US`, `MX`, `CO`, `CL`. The presets are defined as JSON under `backend/src/services/holidays/presets/` and are loaded by `loadPreset(countryCode)`, which reads from `__dirname/presets/${cc}.json` at runtime.

### Runtime-asset bundling

`tsc` with `resolveJsonModule: true` only inlines JSON files that are imported as TypeScript modules. JSON files read at runtime via `fs.readFile` from `__dirname` are not copied automatically into `dist/`. The `backend/scripts/copy-assets.mjs` script (invoked by `npm run build:assets`, chained from `npm run build`) copies the runtime-asset directories listed in `RUNTIME_ASSET_DIRS` from `src/` to `dist/`. Add a new entry there when introducing a new runtime-asset directory. The build is verified by `backend/tests/unit/scripts/copy-assets.test.ts`, which runs `npm run build` once and asserts every supported country preset lands in `dist/services/holidays/presets/`.

### Bulk seeding

`npm run db:seed-holidays -w backend -- --all` iterates `SUPPORTED_COUNTRY_CODES` and runs `seedDefaults` for each, in order. The command is idempotent: re-running after the data is already loaded produces `inserted=0 skipped=N` for every country. The all-in-one Docker stack (`docker-compose.app.yml`'s `migrate` service) calls this with `--all` after `prisma migrate deploy` and `prisma/seed.ts`, so `npm run app:up` ships with US + MX + CO + CL holidays pre-seeded out of the box.

## 8. Error Model
Use consistent API error responses.

Example:
```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "You are not allowed to modify this PTO entry."
  }
}
```

Standard error codes:
- `UNAUTHENTICATED` (401) — no valid session cookie
- `FORBIDDEN` (403) — requester is not allowed to perform the action
- `CSRF_REJECTED` (403) — state-changing request has an untrusted Origin or Referer
- `VALIDATION_ERROR` (400) — request body fails Zod validation, or the `If-Match` precondition is malformed
- `NOT_FOUND` (404) — referenced PTO does not exist
- `CONFLICT` (409) — proposed PTO overlaps an existing PTO for the same user or the write transaction could not complete due to a concurrent write
- `STALE_WRITE` (412) — the `If-Match` version no longer matches the stored record; the record is unchanged
- `PRECONDITION_REQUIRED` (428) — a write reached the server without the required `If-Match` version
- `RATE_LIMITED` (429) — login limiter, global limiter or a personal-token quota tripped; `Retry-After` header carries seconds-until-reset of the exact rejecting window
- `NOT_READY` (503) — readiness probe only; DB unreachable or probe timed out
- `INTERNAL_ERROR` (500) — unhandled exception

A failed precondition is never reported as a business conflict: `412`/`428` mean
"the expected version did not hold", `409` means "the business rules refuse
this change".

The owner/date exclusion constraint of #257 is a business rule, so its
violation is the same safe `409 CONFLICT` envelope as the preflight overlap
check: the raw driver error, the constraint name and the conflicting rows
never reach the client. A serialization failure or deadlock reported by the
write transaction is also `409 CONFLICT`, with a distinct fixed message that
does not claim an overlap; the server does not retry the transaction. The
friendly preflight may still run first, but the database enforces the rule.

## 9. Validation Rules

### 9.1 PTO validation
- `startDate` must be valid ISO date
- `endDate` must be valid ISO date
- `endDate` cannot be before `startDate`
- Same-day PTO requires valid `dayPart`
- Multi-day PTO is normalized to `all_day`
- PTO cannot start or end on a weekend
- Weekends inside multi-day PTO ranges count and are displayed
- PTO entries cannot overlap another PTO entry for the same user
- `note` max length recommended: 500 chars
- The non-overlap invariant is enforced by the exclusion constraint of §6.1a, so it holds for concurrent writes and for every credential type; a violation is the safe `409 CONFLICT` envelope

### 9.1a Write preconditions and partial updates (#256)
- `PUT`, `PATCH` and `DELETE` on `/pto/:id` require exactly one `If-Match`
  header holding the expected version as one canonical quoted strong
  entity-tag: `"1"`, `"2"`, … The value is an integer in 1..2147483647.
- Accepted spelling: one double-quoted decimal integer. A missing header is
  `428 PRECONDITION_REQUIRED`; a list, `*`, a weak validator (`W/"1"`), an
  unquoted number, a non-numeric value or a value outside the range is
  `400 VALIDATION_ERROR`.
- A well-formed but outdated version is `412 STALE_WRITE`. The stored record
  is left exactly as it is; the client refetches, shows the difference and
  confirms again. The server never retries a stale write.
- The version check, the write, the increment and the audit row run in one
  transaction/conditional statement, so two updates based on one version
  cannot both succeed and a stale delete cannot remove a newer revision.
- `PATCH /pto/:id` accepts a non-empty object with only `startDate`,
  `endDate`, `dayPart` and `note`. Omitted keys preserve the stored value;
  `note: null` and `note: ""` clear it; a non-empty string replaces it. The
  merged record is validated with every rule in §9.1 before anything is
  written, and unknown fields are rejected.
- `PUT /pto/:id` keeps its contract: both dates are required, an omitted
  `note` preserves the stored value, `""` clears it, a non-empty string
  replaces it and `null` is invalid.
- The owner can never be transferred by either method, and a personal token
  needs the same scope, live role and record authority as the legacy PUT.

### 9.1b Create replay (#258)

`POST /pto` requires `Idempotency-Key` for an authorized PAT and accepts it
optionally for a cookie session. A key is `v1.<UTC Unix milliseconds, 13 digits>.<lowercase UUIDv4>`.
The server rejects duplicate/list headers and timestamps over 120 seconds
ahead of database time. The absolute deadline is the key's timestamp plus
24 hours. At or after that deadline `409 IDEMPOTENCY_EXPIRED` is returned,
even when bounded cleanup has already removed an expired replay entry.
The deadline controls replay eligibility, not physical retention: expired
rows are pruned in bounded batches, and normal encrypted backup retention
still applies. No other write uses this key.

Keys are scoped to trusted owner, credential and operation. PAT identity
is its public ID; a keyed cookie request uses the signed per-login nonce
and checks current session version. Existing keyless cookies still work;
for a keyed request from an older session, sign in again. New login or
token replacement is a different replay scope, not a retry credential.

The database claim, PTO write, original note-free result and create audit
commit or roll back together. An identical authorized retry receives the
same `201` with `Idempotency-Replayed: true` and the original expiry
header. A different canonical payload yields `409 IDEMPOTENCY_CONFLICT`
after current credential and scope checks. The claim does not replace
the #257 overlap guard for distinct intents. No stored note copy is used:
an authorized note is read only from the unchanged original revision.
Neither a replay nor an error generates another mutation audit.

Persist a key and its deadline with one approved client intent. If the
reply is lost, reuse that exact key and payload with the original
credential before expiry. After expiry, changed credentials or unresolved
conflict, reconcile the result with current records; do not automatically
submit a fresh create. The server does not retry failed transactions.

### 9.2 Auth validation
- Email must be unique
- Role must be one of allowed enum values

## 10. Backend Service Design

### 10.1 Services
- `AuthService`
- `UserService`
- `PTOService`
- `AuthorizationService`
- `AuditLogService`
- `auditContext` (`backend/src/services/audit/auditContext.ts`) — the attribution vocabulary
- `nativeAudit` (`backend/src/services/audit/nativeAudit.ts`) — audit rows on the native token transaction

### 10.2 PTOService responsibilities
- Validate PTO payload
- Persist PTO entries
- Retrieve visible-date-range-overlapping entries
- Enforce normalization rules
- Prepare display-friendly response payloads
- Write the create/update/delete audit row in the same transaction as the mutation

### 10.2a Audit attribution (`backend/src/services/audit/`)

`auditContext.ts` defines the closed attribution vocabulary and the only
supported ways to build an actor:

```ts
type AuditCredential =
  | { type: 'session' }
  | { type: 'personal_access_token'; tokenId: string }
  | { type: 'setup_token' }
  | { type: 'operator' };

interface AuditActor { id: string; credential: AuditCredential; requestId: string | null }
```

- `attributedActorFromAuth(auth)` maps a **verified** request context: a cookie
  session becomes `session`, a personal token becomes `personal_access_token`
  with its **public** token ID. The correlation ID is filtered to the safe
  character class and dropped to `NULL` otherwise.
- `setupTokenActor(userId, requestId)` is used by the account-setup claim. The
  identity is the user row that the server claimed inside the transaction, so a
  setup claim is never attributed to a session or a personal token.
- `trustedOperatorActor(userId)` is the explicit attribution for trusted
  server-side maintenance code such as a role change with credential-version
  invalidation. No HTTP route accepts or constructs an operator actor, so this
  adds no administrative surface.

Request bodies, query parameters, headers, client-supplied labels and
user-agent strings are **not** identity. A label never proves CLI or MCP
provenance.

`AuditLogService.record` writes one row with the attribution columns and a flat
`details` summary; `auditEntryFor` derives the actor fields from a single
verified actor so identity, credential and correlation ID cannot drift apart.
`nativeAudit.recordNativeAudit` writes the same rows on the caller's native
`pg` transaction, so a personal-token change and its audit row commit or roll
back together without a second connection or a runtime Prisma import in the
token path. A batch with no entity IDs writes nothing, which is what makes a
no-op revocation produce no duplicate row.

### 10.3 Authorization helpers

```ts
function canModifyPTO(currentUser, pto) {
  return currentUser.role === 'team_lead' || currentUser.id === pto.userId;
}

function canViewNote(currentUser, pto) {
  return canModifyPTO(currentUser, pto);
}
```

`canViewNote` is the single source of truth for note-visibility: `GET /pto/:id` calls it before serializing the response and redacts `note` to `null` when it returns `false`. There is no route-local `isOwnerOrLead` helper — every note-visibility decision flows through `AuthorizationService`.

### 10.4 Shared Zod schemas

Request validation is defined once per domain and imported by both the routes and the validation layer:

- `backend/src/services/pto/schemas.ts` — `CreatePtoSchema`, `RangeQuerySchema`, `IdParamSchema`, `DayPartSchema`, `ISO_DATE`. Inferred types (`CreatePtoInput`, `RangeQuery`, `IdParam`) replace hand-written TypeScript request types and remove `as` casts from the routes.
- `backend/src/services/auth/schemas.ts` — `LoginSchema` + inferred `LoginInput`.

`backend/src/services/pto/validation.ts` re-uses `ISO_DATE` and `CreatePtoInput` from `./schemas.js` so the business-rule validation operates on the same shape the routes have already parsed.

### 10.5 Rate-limit factories (`backend/src/lib/rateLimit.ts`)

```ts
export function createLoginLimiter(): RequestHandler { /* 5/15min/IP, skipSuccessfulRequests */ }
export function createGlobalLimiter(): RequestHandler { /* 100/15min/IP */ }
```

Both factories call `loadEnv()` per invocation so per-test env overrides produce fresh limiter instances (a module-level constant could not pick up env resets). Both produce the same `429 RATE_LIMITED` response shape with `Retry-After`.

The module also owns the shared Redis connection: `sharedRedisClient(url)` opens one connection per configured store URL and `acquireRateLimitResources()` / `closeRateLimitResources()` bracket the application lifetime, so `app.closeResources()` closes the limiter connection once the last application releases it. A connection that cannot be closed cleanly is discarded instead of being reused. The release is idempotent per application: `app.closeResources()` memoizes its promise, so a repeated cleanup cannot take a connection that another live application still owns.

### 10.6 Personal-token quotas (`backend/src/middleware/agentQuota.ts`)

The shared IP limiter above stays the emergency high-water for one client address. The per-caller budgets are charged against a **verified** identity, so office users behind one NAT address no longer share one account budget:

| Control | Default | Window | Key |
| --- | --- | --- | --- |
| Failed bearer verification (`RATE_LIMIT_BEARER_FAILURE_MAX`) | 20 | `RATE_LIMIT_ATTEMPT_WINDOW_MS` (15 min) | client address |
| Verified-user traffic (`RATE_LIMIT_USER_QUOTA_MAX`) | 600 | `RATE_LIMIT_QUOTA_WINDOW_MS` (60 s) | verified user id |
| Verified-token traffic (`RATE_LIMIT_TOKEN_QUOTA_MAX`) | 300 | `RATE_LIMIT_QUOTA_WINDOW_MS` (60 s) | verified token public id |
| Token issuance (`RATE_LIMIT_TOKEN_ISSUANCE_MAX`) | 20 | `RATE_LIMIT_ATTEMPT_WINDOW_MS` | verified owner id |
| Issuance password verification (`RATE_LIMIT_TOKEN_PASSWORD_MAX`) | 20 | `RATE_LIMIT_ATTEMPT_WINDOW_MS` | verified owner id |

Every value is bounded by the environment schema (`1..1000`, `1..100000`, `1000..3600000` for the quota window and `1000..86400000` for the attempt window). An extreme value is rejected at startup instead of being silently accepted. The attempt window is separate from the legacy `RATE_LIMIT_WINDOW_MS`, so the global and failed-login budgets keep their current behavior.

**The shared address high-water still binds first.** With the defaults, `RATE_LIMIT_MAX` is 100 requests per 15 minutes for the whole address, which is lower than the per-caller budgets. Users behind one office address therefore still share that ceiling, and the per-caller budgets only take effect below it. An operator who wants the per-caller isolation to matter has to raise `RATE_LIMIT_MAX`; the Compose files expose every limiter value as an operator override for exactly that reason. Nothing is raised automatically.

The issuance and password budgets are separate from the browser login budget, so failed issuance attempts never lock a browser login. Both stay above the ten active tokens per owner, so a legitimate owner can provision a full portfolio while the issuance cap remains the observable limit.

Rules that the implementation guarantees:

- **The key is the verified identity.** A user budget uses the user id of the verified session or the verified token owner; a token budget uses the verified token public id. An unverified `Authorization` header is never an identity, not even hashed, and the pre-verification counter is keyed by the client address only.
- **The failure counter is charged before the credential lookup.** A syntactically valid bearer on an eligible route is charged before `verifyToken` runs, so an invalid-token flood stops at the database boundary. A secret that verifies refunds the charge immediately, before any scope decision, so a verified credential that is later denied for scope is never counted as a failed secret.
- **The charge is compensated, not skipped.** The counter therefore tracks *failed attempts plus in-flight attempts*. A burst of concurrent legitimate requests can transiently occupy the budget while they are in flight; the documented behaviour is that the budget is given back as each attempt completes.
- **A compensation is atomic and bound to its own window.** Every counter carries the identity of the window it belongs to. The compensation is one atomic store operation that checks that identity, so it can never credit a later window, can never compensate the same attempt twice, and never creates a counter that does not exist.
- **Authenticated traffic is charged exactly once.** A session request is charged in `requireAuth` after the live record and session version are verified; a personal-token request is charged in `createPatAuth` after the credential verifies and before the scope gate. A personal-token request never reaches the session path.
- **The password budget bounds the expensive comparisons.** The issuance password budget is charged before the bcrypt comparison and is **not** given back, so it bounds the number of comparisons themselves and not only the failed ones. A verified password consumes the budget like any other attempt.
- **Issuance is bounded before it costs anything.** The issuance budget is charged before any token material is generated or any row is written, so a rejected issuance never writes an audit row.
- **A store failure fails closed.** An unavailable shared store refuses the request instead of running unmetered, and the driver cause never reaches a log, a header or a response. A store command waits for a usable socket with a bounded delay, so an outage produces a fixed message instead of a raw driver error.
- **Probes stay exempt.** `/health` and `/ready` are unauthenticated and outside every quota, so monitoring never consumes a user budget.
- **Polling is bounded.** A client that polls faster than its budget receives the standard `429` with the exact `Retry-After` delay; there is no unbounded polling path and no long-lived hold that would let a caller keep a budget open.

The counters live in the same production Redis deployment as the login and global limiters, each in its own namespace (`pto:rate-limit:bearer-failure:`, `pto:rate-limit:quota-user:`, `pto:rate-limit:quota-token:`, `pto:rate-limit:token-issuance:`, `pto:rate-limit:token-password:`). Every count and every compensation is one atomic script, so every instance of the API shares one budget and a restart continues the same counter. Outside production the counters fall back to a process-local store with the same window and compensation behavior; production always resolves Redis because the environment schema rejects a production configuration without `RATE_LIMIT_REDIS_URL`.

The rejection response is the standard envelope `{ "error": { "code": "RATE_LIMITED", "message": "..." } }` with `Retry-After` computed from the exact rejecting window, the draft-7 `RateLimit`/`RateLimit-Policy` headers (whose `reset` is the remaining delay of that window, not an absolute timestamp) and a safe `X-Request-Id`.

### 10.7 Lifecycle (`backend/src/lib/lifecycle.ts`)

```ts
export function installShutdown(server: Server, prisma: PrismaClient): void { /* SIGTERM/SIGINT + uncaughtException/unhandledRejection */ }
export function shutdown(signal: NodeJS.Signals, server: Server, prisma: PrismaClient): Promise<void>
```

`shutdown` drains `server.close()`, then calls `server.closeAllConnections()` (guarded by `typeof` for Node 18+), then awaits `prisma.$disconnect()`. A `setTimeout` force-exits 1 after `SHUTDOWN_TIMEOUT_MS` (default 10s) if drain hangs; the timer is `unref()`'d so it never holds the event loop.

## 11. Frontend Specification

### 11.1 Main routes
- `/login`
- `/calendar`
- optional `/pto/:id`

### 11.2 Main calendar page components

**Route pages** (live under `frontend/src/pages/`):
- `LoginPage`
- `CalendarPage` — the `/calendar` route container; fetches the visible-grid PTO range, owns `selectedMonth` state, renders `CalendarHeader` and `MonthGrid`

**Calendar grid components** (live under `frontend/src/components/calendar/` and `frontend/src/components/pto/`):
- `CalendarHeader`
- `MonthGrid`
- `DayCell`
- `PTOChip`
- `PTOFormModal` (under `components/pto/`)
- `PTOViewModal` (under `components/pto/`)

### 11.3 State requirements
Frontend state should track:
- current authenticated user
- selected month
- PTO entries for current visible calendar grid range
- selected PTO for viewing/editing
- loading/error/submission states

### 11.4 Calendar rendering logic
For each day in the visible calendar grid:
- include PTOs overlapping that date
- render user name with color chip
- render markers for:
  - morning
  - evening
  - all day

### 11.5 UX behaviors
- `Add PTO` opens modal or side panel
- Clicking PTO opens details
- Edit/delete shown only when current user is owner or team lead
- Confirm before delete
- An edit or a delete states the loaded record version as its `If-Match` precondition, and a stale write is refused with a visible conflict instead of overwriting the newer record (§11.8)

### 11.6 Toast notifications
- Page-level feedback (create / update / delete / list-fetch errors) is delivered through a single toast system, not inline banners.
- Files: `frontend/src/context/ToastContext.ts` (types + context), `frontend/src/context/ToastProvider.tsx` (state + dedupe + cap + auto-dismiss timers), `frontend/src/hooks/useToast.ts` (imperative `push` / `dismiss`), `frontend/src/components/common/Toast.tsx` (single toast), `frontend/src/components/common/ToastViewport.tsx` (fixed top-right region, `AnimatePresence` stack, `Escape` key handler), mounted in `frontend/src/App.tsx` inside `<ToastProvider>`.
- Tones: `success` (terracotta left-stripe, `CheckCircle2` icon) and `error` (danger left-stripe, `XCircle` icon). Success uses `role="status" aria-live="polite"`; error uses `role="alert" aria-live="assertive"` and moves focus to the close button so SR / keyboard users can act immediately.
- Queue: newest on top, max 3 visible (oldest auto-evicted), same `tone+title` dedupes in place (refreshes timestamp and content).
- Motion: `motion/react` slide+fade enter (~180ms) and exit (~120ms); hairline progress bar driven by `requestAnimationFrame`; pauses on `hover` or `focus-within` and resumes on leave; `prefers-reduced-motion` reduces to opacity-only.

### 11.7 Personal access token settings page (#254)

- Route `/settings/tokens` renders `TokenSettingsPage` (`frontend/src/pages/settings/TokenSettingsPage.tsx`) behind the ordinary `RequireAuth` guard. Every role (`member`, `team_lead`, `admin`) reaches it; it is not under `/admin` and carries no team-lead guard. An unauthenticated visit is redirected to `/login`.
- The calendar header carries the entry point: a `Link` to `/settings/tokens` labelled **API access** (`data-testid="api-access-link"`), rendered for every signed-in user.
- The page heading is **Personal access tokens**. It has three sections: *Issue a token* (`Generate token`, `data-testid="generate-token-button"`), *Your tokens* (one card per owned token) and *Revoke every token* (`Revoke all tokens`, `data-testid="revoke-all-button"`).
- Issuance dialog (`TokenCreateDialog`): `Token name`, `Current password`, `Expires after` (30/90/180/365 days) and the scope picker (`TokenScopePicker`). The defaults are read-only (`pto:read`) and 90 days. The picker applies the server's scope dependencies: note reading needs read access, and the team scopes are only offered to a live team lead or administrator.
- The password lives in component state only, is cleared when the form is submitted or closed, and is never stored, logged, put in the URL or echoed back. Credential requests are sent with `cache: 'no-store'` and `redirect: 'error'` so a raw token cannot enter the HTTP cache and a redirect is never re-requested with the session cookie.
- Reveal dialog (`TokenRevealDialog`): the raw secret is shown exactly once, in a read-only `New token` field (`data-testid="new-token-value"`), with `Copy token` and `Done`. Copying uses the Clipboard API and reports the result accessibly — an inline `role="status"` / `role="alert"` line plus a toast that never carries the secret. The secret is kept in component memory only and is dropped when the dialog closes, when the page navigates and when the document is hidden for navigation (`pagehide`).
- Token cards (`TokenCard`) show owned metadata only: name, display prefix, scopes, created/expiry/last-used and the server-computed status (`Active`, `Expired`, `Revoked`, `Invalidated`). The absolute expiry is rendered in the reader's time zone with the zone name, and a token inside the seven-day window gets an explicit near-expiry warning. An existing secret is never revealed.
- Revocation: `Revoke <token name>` and `Revoke all tokens` open `TokenConfirmDialog` (titles `Revoke token` and `Revoke all tokens`, confirm button `Confirm revocation`). Revocation needs a valid session only — no password — and the owned list is refreshed afterwards.
- The dialogs reuse the shared modal trap (Escape to close, Tab cycling, scroll lock, initial focus) and add focus restoration through `useTokenDialog`: the control that opened a dialog gets its focus back when the dialog closes.
- The CLI/local MCP section is placeholder-only. It states that no client is distributed yet, so there is nothing to install and nothing to paste, and it explains that an assistant can see whatever the tool sends it — including note text — and that this reaches whichever AI provider is configured, so a token must never be pasted into a chat or a shared document.
- No token is written to `localStorage`, no `VITE_*` token configuration exists, and the rollout flags `PAT_AUTH_ENABLED` / `PAT_WRITES_ENABLED` stay off by default in every environment. A token issued in this page therefore cannot reach a bearer route until an operator enables bearer authentication; the separate read-only/write rollout gates are unchanged.

### 11.8 Versioned PTO writes in the browser (#256)

- The browser never invents a version. Opening the edit form or the delete confirmation loads `GET /pto/:id` and keeps the `version` of that response; the write then states it as one canonical quoted strong `If-Match` value (`"1"`, `"2"`, …).
- The legacy `PUT` body is unchanged: both dates, the day part and the note. The precondition is a header, not a body field, and the note journeys of #235–#237 keep working unchanged.
- A successful write updates the record and the version. The list is refetched, so the calendar shows the new state.
- A refused write is never silent. `412 STALE_WRITE` means the record changed after it was read: the stored data stays untouched, the user is told that the record changed, and the app offers the current record again (refetch/reopen) instead of retrying the stale write. The write is attempted once — there is no automatic retry that could overwrite a newer revision.
- `428 PRECONDITION_REQUIRED` means the client did not state a version. An older cached browser client receives it and must refresh the record; the server never grants an unguarded write.
- The conflict message is a normal error surface (inline `role="alert"` in the form or the details modal, or an error toast). It never contains data from the other revision that the user is not allowed to read.

## 12. Query and Rendering Logic

### 12.1 Visible date-range overlap query
Given visible grid start and end:
```sql
SELECT p.*, u.name, u.color_code
FROM pto_requests p
JOIN users u ON u.id = p.user_id
WHERE p.start_date <= $1
  AND p.end_date >= $2;
```

Parameter mapping:
- `$1 = visible_grid_end`
- `$2 = visible_grid_start`

### 12.2 Date expansion pseudocode
```ts
function expandPTOToDates(pto) {
  const dates = [];
  let current = pto.startDate;
  while (current <= pto.endDate) {
    dates.push({
      date: current,
      dayPart: pto.dayPart,
      userName: pto.user.name,
      colorCode: pto.user.colorCode,
      ptoId: pto.id,
    });
    current = addDays(current, 1);
  }
  return dates;
}
```

## 13. Non-Functional Requirements

### 13.1 Performance
- Month view should load in under 2 seconds for small team usage
- API should support at least tens to low hundreds of PTO entries per month without degradation

### 13.2 Security
- All APIs authenticated **except** the operational probes `GET /health` and `GET /ready`, which are intentionally unauthenticated for orchestrators
- Authorization enforced server-side via the centralized `AuthorizationService` (`canModifyPTO`, `canViewNote`)
- Input validation and sanitization via shared Zod schemas imported by both the routes and the validation layer (single source of truth — `services/{auth,pto}/schemas.ts`)
- bcrypt password hashing (`BCRYPT_ROUNDS` env var; minimum 10 enforced in production, 4 in tests/CI; recommended 12)
- `SESSION_SECRET` is validated at boot: must be ≥32 characters, must not be a known placeholder string, and must have Shannon entropy ≥ 3.5 bits/char. Comma-separated values are supported for graceful key rotation (the new key signs, older keys verify). In `NODE_ENV=production` the process refuses to start if `SESSION_SECRET` is a placeholder, fails the entropy check, `COOKIE_SECURE` is not `true`, or `INSECURE_COOKIES_ALLOWED` is set
- `INSECURE_COOKIES_ALLOWED` (default `false`) is accepted only outside production for the HTTP-only `docker-compose.app.yml` development demo (no TLS termination, no Caddy). Production rejects the flag so session cookies cannot be sent over plaintext by configuration mistake.
- `requireAuth` revalidates every session user against the database. The role lookup uses a per-process in-memory cache keyed by user id (`AUTH_USER_CACHE_TTL_MS`, default 15s), while `session_version` is checked directly on every authenticated request so password resets and setup completion revoke old cookies immediately across instances. If the user no longer exists or the session version is stale, the session is cleared and the response is `401 UNAUTHENTICATED`. Login regenerates the session by replacing `req.session` with a fresh object containing the new user id, role, and session version (mitigates session-fixation — `cookie-session` has no `regenerate`).
- HTTP-only secure cookie sessions (`cookie-session`). `COOKIE_SAME_SITE` defaults to `lax` locally and in the supported OCI single-host deployment. The configurable `none` option still requires `COOKIE_SECURE=true`; no split-origin production deployment is maintained
- Cross-origin requests are allowed via the `cors` middleware using the `CORS_ORIGIN` env var allowlist. Credentials are permitted (`credentials: true`) so the HTTP-only cookie session works across origins in production. State-changing requests also pass through `csrfOriginMiddleware`, which rejects a supplied `Origin` or `Referer` outside the configured origin and rejects missing origin metadata when an authenticated session cookie is present; unauthenticated CLI login/setup requests remain supported
- `helmet` mounted globally for canonical security headers: Content-Security-Policy, Strict-Transport-Security, `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, Cross-Origin-Opener-Policy, Cross-Origin-Resource-Policy, Origin-Agent-Cluster
- `frontend/src/api/client.ts` `apiRequest` enforces a default 15s per-request timeout (configurable via `VITE_API_TIMEOUT_MS` or the `timeoutMs` option), normalizes fetch errors into a typed `ApiError(0, { code: 'TIMEOUT' | 'ABORTED' | 'NETWORK' | 'BAD_RESPONSE', message })`, and accepts a caller `signal` to abort in-flight requests. A `try/catch` around `JSON.parse(text)` throws `BAD_RESPONSE` for malformed (non-JSON) bodies so the caller never gets an uncaught `SyntaxError` from the fetch layer. All HTTP calls in the app go through this client; `frontend/eslint.config.js` has a `no-restricted-syntax` rule that bans raw `fetch(` outside the api client module + the apiClient test, so the timeout/abort/JSON-parse/error-normalization behavior is uniform. ID and query segments are always `encodeURIComponent`-ed
- A top-level `ErrorBoundary` (`frontend/src/components/ErrorBoundary.tsx`) wraps the route tree inside `App.tsx`. Any uncaught render-time error (a malformed server payload cast to the wrong shape, a `new Date(invalidString)`-style NaN, etc.) is caught and replaced with a user-facing fallback that includes a "Back to calendar" button — no blank screen, no leaked error body
- Self-service account setup: `POST /users` (team_lead only) creates a member with `passwordHash: null`, a one-time setup token (sha256-hashed in the DB, TTL `SETUP_TOKEN_TTL_MS` default 24h), and returns `{ user, setupToken, expiresAt }`. `POST /auth/setup-account` (public) atomically claims the token, hashes the password, increments `session_version`, clears the token columns, starts a session, and returns the user. `POST /users/:id/reset-password` (team-lead only, no self-reset, no resetting the only team_lead) increments `session_version` and issues a fresh token, revoking existing sessions. `Role` is widened to `member | team_lead | admin` (`admin` is a forward-compatible role used by `canManageUsers` / `canModifyPto`; today the team_lead gate is the active one). The `Prisma User` table gets nullable `password_hash`, `setup_token_hash VARCHAR(64)`, `setup_token_expires_at`, and `session_version INTEGER NOT NULL DEFAULT 0`. New setup links use `/setup-account#token=...`; legacy query-token links are scrubbed on load. The frontend exposes `/setup-account#token=...` and a team-lead-only `/admin/users` page
- Per-IP rate limiting: `POST /auth/login` is subject to a strict login limiter (default 5 failed attempts per 15 min, `skipSuccessfulRequests: true`) and every route except `/health` and `/ready` is subject to a global limiter (default 100 requests per 15 min). Both return `429 RATE_LIMITED` + `Retry-After`. The `keyGenerator` uses Express's `req.ip`, which is resolved using the configured trusted proxy chain; it never parses the first raw `X-Forwarded-For` value. `app.set('trust proxy', TRUST_PROXY_HOPS)` is called in `createApp()` when `TRUST_PROXY_HOPS > 0`; the default is `0` in dev/test and the generic production default remains `1` for compatibility, while OCI Compose explicitly sets `2` for Caddy -> nginx -> backend. Production requires `RATE_LIMIT_REDIS_URL` and uses separate shared Redis prefixes for login/global counters; dev/test retain the in-memory store.
- Per-caller quotas for personal-token traffic (#253): the address-based limiter above stays the emergency high-water, while the per-user and per-token budgets are charged against the verified identity. The shared address high-water still binds first with the conservative defaults, so the per-caller isolation only becomes effective below that ceiling or after an operator raises `RATE_LIMIT_MAX` explicitly. The defaults, the bounded environment values, the pre-verification failure counter, the atomic compensation behavior, the fail-closed store policy and the probe exemption are specified in section 10.6.
- Structured request logging via `pino-http` with `X-Request-Id` correlation IDs on every response; `errorHandler` logs `reqId` with any unhandled error so operators can correlate. `/health` and `/ready` are skipped via `autoLogging.ignore`. The base `pino` logger applies a `redact` configuration that strips session cookies, `Set-Cookie`, `Authorization`, and `password`/`passwordHash`/`token`/`secret` fields from every log line, and the custom `req`/`res` serializers drop the `headers` field entirely. #252 adds the credential-safe transforms described in §7.0: credential keys are redacted at any depth, and the error, message and argument paths are scrubbed on success, failure and debug output.
- Liveness `/health` and readiness `/ready` probes — readiness probes the DB with `prisma.$queryRaw\`SELECT 1\`` raced against `READY_TIMEOUT_MS` (default 5s); both return minimal payloads and do not leak environment, version, or deployment metadata
- Production deployment uses an OCI Always Free ARM64 VM with Caddy for TLS/HSTS, nginx for the static SPA and API proxy, Node/Express for the API, PostgreSQL in a persistent container, and Upstash TLS Redis/Valkey for the shared rate-limit store. The browser uses one custom HTTPS hostname, so `CORS_ORIGIN` is the exact OCI origin, `COOKIE_SAME_SITE=lax`, `COOKIE_SECURE=true`, and `COOKIE_DOMAIN` is empty. `TRUST_PROXY_HOPS=2` matches the Caddy -> nginx -> backend chain. PostgreSQL backups are encrypted and stored off-VM in private OCI Object Storage. OCI is the only supported production/recovery target; legacy automation and runbooks are retired without changing cloud resources or the existing redirect
- Production images use Node.js 24 base images pinned by digest; the backend runtime installs production dependencies only, retaining Prisma CLI for one-off migrations while excluding test/Vite tooling. The local Compose migration service targets the full build stage because it is development-only.
- The supported Node.js patch level (24.22.3, November 2026 HTTP/2/TLS security release) is pinned once in `.nvmrc` and drives the CI runtime (`actions/setup-node` `node-version-file`), every Node container stage, and the `engines.node` floor/root lockfile metadata. `npm run node:baseline:check` keeps them in sync and enforces the minimum supported release; Docker smoke exports and executes both Node builders and the backend runtime with exact-version assertions, covering migration/bootstrap targets too. The final frontend image is nginx, not Node. `npm audit` does not cover the Node.js runtime itself, so the runtime version is tracked separately from the npm dependency graph.
- Production first-run team-lead bootstrap: `npm run db:bootstrap` runs `backend/prisma/bootstrap.ts` and creates a single `team_lead` user with a one-time setup token (reusing `generateSetupToken` from #62). Env: `LEAD_EMAIL` (required), `LEAD_NAME` (default `"Team Lead"`), `LEAD_COLOR_CODE` (default `#3B82F6`), `APP_PUBLIC_BASE_URL` (or `--base-url` flag, default `http://localhost:5173`). Prints the setup link to stdout. Idempotent: if the lead already has a password, it's a no-op; if the lead exists with no password, the token is regenerated and the new link is printed. `backend/.env.example` documents all four envs. `backend/tests/integration/bootstrap.test.ts` (5 cases) covers the validation, fresh-create, `--base-url` override, no-op idempotency, and token-regeneration paths.

### 13.3 Reliability
- Failed requests return clear errors with machine-readable codes (`UNAUTHENTICATED`, `FORBIDDEN`, `VALIDATION_ERROR`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `NOT_READY`, `INTERNAL_ERROR`)
- Database writes are transactional where needed (PTO create/update/delete run inside a single Prisma transaction that also writes the audit row, so a mutation can never commit without its audit row; the personal-token lifecycle writes its audit rows on the same native `pg` transaction as the token change)
- Graceful shutdown on SIGTERM/SIGINT: `shutdown(server, prisma)` calls `server.closeIdleConnections()` first to drop idle keep-alive peers immediately (so `server.close()` does not block on the keep-alive timeout), awaits the `server.close()` callback, calls `server.closeAllConnections()` to terminate any stragglers, then disconnects the global Prisma client, with a `SHUTDOWN_TIMEOUT_MS` (default 10s) fallback that force-exits 1 if the drain hangs. `uncaughtException` and `unhandledRejection` handlers log `logger.fatal` and call `process.exit(1)`. Lifecycle is extracted to `backend/src/lib/lifecycle.ts` and unit-tested at 100%

### 13.4 Maintainability
- Strong typing — Zod schemas infer request types directly so routes and the validation layer cannot drift apart
- Shared validation schema between frontend and backend if possible
- Centralized permission logic — `AuthorizationService` is the single source of truth for note-visibility (`canViewNote`) and modification rights (`canModifyPTO`)
- Tailwind v4 builds CSS via `@tailwindcss/vite`; `autoprefixer` is not required and should not be installed
- Design tokens (palette, typography, radii, motion) are defined once in a Tailwind v4 `@theme` block in `frontend/src/index.css` and consumed by every component
- Dependency hygiene: prune unused `dependencies`/`devDependencies` after each sprint. A dependency is unused if no `import`/`require` references it in `src/` or `tests/` (excluding config-only packages like `eslint`/`prettier`/`husky`/`lint-staged`). Currently confirmed runtime deps: `bcryptjs`, `cookie-session`, `cors`, `express`, `express-rate-limit`, `helmet`, `pino`, `pino-http`, `zod`, `@prisma/client`

## 14. Testing Specification

### 14.1 Unit tests
- validate same-day PTO rules
- validate multi-day PTO rules
- validate authorization helper (`canModifyPTO`, `canViewNote`)
- validate visible date-range overlap query logic
- validate date expansion logic
- validate every Zod schema in `services/{auth,pto}/schemas.ts` (accept + reject paths)
- validate `createPto` and `findOverlapping` directly (10 tests in `PTOService.test.ts`)
- validate the middleware layer (`cookieSession`, `errorHandler`, `requireAuth`) via mocked module boundaries
- validate the lifecycle module (`lib/lifecycle.ts`): SIGTERM/SIGINT drain, uncaughtException/unhandledRejection force-exit, `SHUTDOWN_TIMEOUT_MS` grace timer via `vi.useFakeTimers`, `prisma.$disconnect` rejection path

### 14.2 Integration tests
- authenticated member can create PTO
- member can update own PTO
- member cannot update another user PTO
- team lead can update another user PTO
- delete permissions enforced
- visible date-range endpoint returns overlapping records
- `GET /health` always returns 200 without touching the DB
- `GET /ready` returns 200 on a healthy DB and 503 when the DB is unreachable or times out
- helmet headers are present on every response
- `X-Request-Id` is echoed (generated UUID v4) and an inbound `X-Request-Id` is passed through
- `/health` and `/ready` are excluded from the request-completion log

### 14.3 UI tests
- calendar page loads current month
- next/previous month navigation works
- PTO chips render correct color and label
- single-day form toggles day-part selector
- edit/delete visibility respects permissions
- useModalA11y: Esc-to-close, scroll-lock, focus-trap, Tab cycle (8 tests)
- mobile-chrome project (Pixel 5) verifies the responsive layout, ≥44px tap targets, modal scroll-lock on small viewports
- keyboard focus indicators on inputs, buttons, chips, calendar cells, and the modal close button
- own-token settings (#254, `frontend/e2e/token-settings.spec.ts`, chromium-only): the member journey from the calendar **API access** entry to a read-only 90-day token, the copy-once reveal, the clear-on-close/navigation rule, revoke-one and revoke-all without a password, and the cookie-free bearer proof on `GET /auth/me` (200 before revocation, 401 after)

### 14.4 Automation, tooling, CI/CD, and coverage policy
See `testing-strategy.md` for the full automation plan: tooling matrix (Vitest, Supertest, React Testing Library, MSW, Playwright, GitHub Actions), coverage targets with strict gates on authorization and PTO validation, ephemeral Postgres for integration tests, pre-commit hooks, and merge policy.

### 14.5 Shared API client tests (#259)
`packages/api-client` has its own Vitest suite with a per-package coverage gate:
package totals require at least 90% lines, statements and functions and at least
80% branches, and the security-sensitive surfaces (origin binding, the error
envelope, the transport and retry policy, the wire parser and input validation)
require 100% on every metric. The suite is service-free — it uses in-process
loopback fixtures only and never touches PostgreSQL, Redis or a hosted
endpoint. The package is discovered by the root `lint`, `typecheck`, `test`,
`test:coverage` and `build` scripts and by the CI `Lint`, `Typecheck`,
`Frontend tests` and `Coverage gate` jobs.

### 14.6 Local read-only MCP (#263)
`pto-mcp` is a private stdio process using classic initialization and the
shared credential resolver and REST client. It declares only `pto_list`
and `pto_get`, with bounded closed schemas and structured results. The API
authorizes every request; a long-lived protocol connection does not keep a
revoked or expired credential valid. Note display is opt-in for an authorized
detail call and is always absent from list results. The server exposes no
HTTP transport, database access or writable tool.

### 14.7 CLI write safety (#262)
`pto` keeps writes off unless the invocation's host explicitly opts in. The
CLI preflights the live actor, exact record, scope and version before asking
for interactive confirmation or honoring noninteractive `--yes`; the API
still enforces its own flags, scopes, ownership and versioned writes. A
create's pending operation is bound to one origin, actor, live credential
and normalized payload. The journal synchronizes the parent directory entries
and the record before dispatch. The client never automatically retries writes.
See [CLI write and recovery policy](../cli/README.md) for version conflicts,
lost responses and note handling. These controls do not prove consent to the
server or enable production access.

### 14.8 Scoped consent-aware MCP writes (#264)

`pto-mcp` exposes `pto_create`, `pto_update` and `pto_delete` only behind
the exact own `PTO_MCP_WRITES=1` host opt-in, which is default-off with no
ambient `.env` fallback. The API `PAT_AUTH_ENABLED` /
`PAT_WRITES_ENABLED` flags default off; this does not enable them in
production. Matching scopes and
live role, ownership and record checks remain authoritative at the API.
Preview does not attest that the API write flag is on.
Create ownership is derived from the live credential; tools accept no
`actAs`, owner, role, credential, URL, header, path or shell argument, and
no `confirmed`/acting-user field.

Each tool uses strict discriminated `mode = preview | apply` on the
canonical arguments: create takes dates/day-part/optional note plus a
canonical `v1.<ms>.<uuid>` idempotency key; update/delete take an exact ID
plus an exact positive-int32 expected version, with update carrying a
closed nonempty `changes` object. `previewId` is admitted only on `apply`
and is required there. `apply` carries the same target and exact business
payload as its `preview`.

`preview` is read-only and returns the phase, the opaque preview ID, the
actor/owner IDs, the record ID/version for update/delete, the canonical
before/after dates and day part, the changed fields and the note
preserve/replace/clear intent — never a raw note, token, token ID, key or
reflected caller value. A preview ID is process-scoped, expiring and bound
to the canonical input, operation, actor, origin, credential, live role and
target/version. Apply rechecks authorization and the same preview's expiry
before dispatch. It does not pass the preview ID to REST or treat it as
proof of human consent. A separate bounded in-process binding prevents a
fresh preview from rebinding an observed create key to another credential
or intent. Its 256-entry limit refuses new keys rather than evicting known
bindings; this is not a durable journal. `apply` returns the phase and the safe
affected record/owner/version or deleted target, with validated
replay/expiry on create only. Mutation results carry no note text.

Definitions mark mutations `readOnlyHint: false`, create additive and
update/delete destructive, with create idempotent only under its replay
contract. Writes use one conditional `PATCH`/`DELETE` with a canonical
quoted `If-Match` version or POST with a stable create key. PATCH and DELETE
share a single in-flight guard per origin, target ID and expected version.
PATCH sends only effective changed fields and any explicit note. An omitted PATCH note
preserves the stored note while explicit `null`/`""` clears it. Concurrent,
expired, revoked or unknown outcomes are reconciled with a fresh read and a
fresh preview — never a blind `PATCH`/`DELETE` retry or a fresh-key
create. Only the explicit exact same credential/payload/key within the
proven window may resume a lost create. Annotations, IDs and booleans are
hints only; the host must show the exact proposed change and obtain actual
per-call approval, omitting denied calls and never recommending
auto-approve-all. Actual host approval evidence belongs to #266–#268. This
contract enables no hosted distribution, production access or deployment, and
keeps the pinned private stdio SDK 1.32.2 through 2025-11-25.

## 15. Suggested Implementation Choices

### Confirmed MVP implementation choice
- React + TypeScript frontend using Vite
- Tailwind CSS styling (Tailwind v4 via `@tailwindcss/vite`; design tokens in a single `@theme` block)
- Node.js + Express + TypeScript backend
- PostgreSQL database with Prisma
- Email/password auth for manually seeded users
- bcrypt password hashing
- HTTP-only cookie sessions
- Custom month calendar grid or lightweight calendar library
- `helmet` for canonical security headers
- `express-rate-limit` for per-IP rate limiting (login + global)
- `pino` + `pino-http` for structured request logging with `X-Request-Id` correlation
- Custom lifecycle module for graceful SIGTERM/SIGINT shutdown
- Shared Zod schemas in `services/{auth,pto}/schemas.ts` for request validation
- Self-hosted typography (Fraunces, IBM Plex Sans, IBM Plex Mono) under `frontend/public/fonts/`

## 16. Deployment Notes
- Internal-only deployment is sufficient for MVP
- The primary production deployment is the OCI VM flow in `docs/deploy.md`
- Back up the database using the encrypted OCI Object Storage flow described in `docs/database-backups.md`
- Validate downloaded OCI archives with the cloud-independent disposable restore helper; use the separately confirmed OCI restore command only for production recovery
- Configure DB, session, Upstash, and backup secrets in the VM's protected `.env` file; retain recovery copies outside the VM
- Set `CORS_ORIGIN` to the OCI production origin. Use `COOKIE_SECURE=true`, `COOKIE_SAME_SITE=lax`, an empty `COOKIE_DOMAIN`, and `TRUST_PROXY_HOPS=2`
- A self-contained local "clone-and-run" flow is provided via `docker-compose.app.yml`: Postgres + one-shot development-only `migrate` service + backend + nginx-served frontend on a single Docker network with only localhost port `5173` exposed. nginx proxies `/auth`, `/pto`, `/health`, `/ready` to the backend and serves the SPA on `/`. See `README.md` §"Running with Docker (all-in-one)". This is a developer demo path and does not replace the TLS / real-secret deployment pattern described above

## 17. Confirmed Technical Decisions
- Audit logs are stored internally only and are not exposed in the MVP UI
- #252: every audited **PTO mutation** and every **credential-lifecycle change** (token issuance/revocation, password reset, account setup, trusted role change) writes its audit row in the same transaction as the mutation, so a failed validation, a denied authorization or a rollback leaves no committed success record. Other audit writers (user creation, holiday changes) keep their existing, non-atomic behavior
- #252: audit attribution comes only from verified server state — the authenticated request context, a setup row claimed inside the transaction, or an explicit trusted operator. Request bodies, query parameters, headers, client labels and user-agent strings are never treated as identity
- #252: audit rows carry a flat change summary and never note text, raw tokens, digests, setup-token hashes or passwords. New summaries exclude note text; historic rows are retained as they are, indefinitely and without automatic cleanup
- Production hardening (helmet + rate limiting + structured request logging + graceful shutdown + liveness/readiness probes) is shipped for MVP and is the explicit scope of `docs/backlog.md` Epic 6
- `/health` and `/ready` are intentionally unauthenticated orchestrator probes; every other API requires authentication
- Note-visibility is enforced via a single `canViewNote` helper in `AuthorizationService`; no route-local re-implementations
- Request validation is defined once via shared Zod schemas (`services/{auth,pto}/schemas.ts`); routes and the validation layer import from the same source so the request contract cannot drift

## 18. Acceptance Criteria Summary
- Authenticated users can create PTOs
- Single-day PTO requires day-part selection
- All authenticated users can view all PTOs in monthly calendar view
- Only PTO owner or team lead can edit/delete PTOs
- Calendar supports month navigation and fetches PTO entries for the full visible grid range
- PTOs display with user-specific colors
