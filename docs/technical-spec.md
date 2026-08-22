# PTO / Vacation Calendar App Technical Specification

## 1. Purpose
This document defines the technical specification for an internal PTO/vacation calendar app where authenticated users can create and view PTO entries, and only the owner or a team lead can modify or delete them.

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
- **Frontend**: React + TypeScript using Vite
- **Styling**: Tailwind CSS
- **Backend**: Node.js + Express + TypeScript
- **Database**: PostgreSQL with Prisma
- **Authentication**: Email/password authentication for manually seeded users with bcrypt password hashing and HTTP-only cookie sessions

### 3.2 Core modules
- Auth module
- Users module
- PTO module
- Calendar query module
- Authorization module
- **Rate-limit module** (`backend/src/lib/rateLimit.ts`) — factory functions for the strict login limiter and the global limiter
- **Lifecycle module** (`backend/src/lib/lifecycle.ts`) — graceful shutdown (SIGTERM/SIGINT drain + `prisma.$disconnect` + `SHUTDOWN_TIMEOUT_MS` fallback + uncaughtException/unhandledRejection handlers)
- **Health route** (`backend/src/routes/health.ts`) — `GET /health` (liveness, no DB) and `GET /ready` (readiness, DB probe)
- **Shared Zod schemas** (`backend/src/services/auth/schemas.ts`, `backend/src/services/pto/schemas.ts`) — request validation defined once, imported by routes and the validation layer

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

Rules:
- If `startDate == endDate`, `dayPart` is required
- If `startDate != endDate`, `dayPart` is normalized to `all_day`
- PTO entries cannot overlap another PTO entry for the same user
- PTO cannot start or end on a weekend
- Weekends inside a multi-day PTO range count and are displayed as part of the continuous PTO

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
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CHECK (end_date >= start_date),
  CHECK (start_date = end_date OR day_part = 'all_day')
);
```

### 6.2 Recommended indexes
```sql
CREATE INDEX idx_pto_requests_user_id ON pto_requests(user_id);
CREATE INDEX idx_pto_requests_start_date ON pto_requests(start_date);
CREATE INDEX idx_pto_requests_end_date ON pto_requests(end_date);
CREATE INDEX idx_pto_requests_date_range ON pto_requests(start_date, end_date);
```

### 6.3 Audit table
Audit logging for update/delete actions is included in MVP.
```sql
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  action VARCHAR(50) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id UUID NOT NULL,
  details JSONB NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

## 7. API Contracts

### 7.0 Operational middleware (applied to every request)

Every response carries an `X-Request-Id` header — UUID v4 generated by `crypto.randomUUID()`, or the inbound `X-Request-Id` if the client supplied one and matches the safe character class `[A-Za-z0-9._-]{1,200}`; values outside that class (e.g. containing whitespace or control characters) are rejected to prevent log-injection and replaced with a fresh UUID. Every non-probe request produces one structured log line via `pino-http` (with `req.{id, method, url}`, `res.statusCode`, `responseTime`); `/health` and `/ready` are skipped via `autoLogging.ignore`.

The base `pino` logger applies a `redact` configuration covering `req.headers.cookie`, `req.headers.authorization`, `res.headers["set-cookie"]`, `password`, `passwordHash`, `token`, and `secret` (at the top level and under any object), with `[REDACTED]` as the censor. Custom `req` and `res` serializers drop the `headers` field entirely so cookie / `Set-Cookie` / `Authorization` values never reach stdout even if the redact path is misconfigured. Login request bodies are never serialized into log lines (the default pino-http path does not log bodies on success, and the safe `req` serializer omits `body` on error).

Global middleware order:
1. `app.disable('x-powered-by')`
2. `helmet()` — canonical security headers (CSP, HSTS, `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, COOP/CORP/OAC)
3. `cors({ origin: env.CORS_ORIGIN, credentials: true })`
4. `express.json({ limit: '100kb' })`
5. `pinoHttp(...)` — generates the `X-Request-Id` and emits the request-completion log
6. `cookieSession(...)`
7. `createGlobalLimiter()` — per-IP rate limiter (default 100/15min); returns `429 RATE_LIMITED` + `Retry-After` on overflow

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
Response 200:
```json
{
  "id": "uuid",
  "name": "Jane Doe",
  "email": "jane@example.com",
  "role": "member",
  "colorCode": "#3B82F6"
}
```

### 7.2 PTO APIs

#### GET /pto?start=YYYY-MM-DD&end=YYYY-MM-DD
Returns all PTO entries that overlap the requested visible calendar grid range, including adjacent-month days.

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
- The list endpoint (`GET /pto?start=&end=`) **never** returns the `note` field, regardless of the requester's role. Notes are only surfaced through the detail endpoint (`GET /pto/:id`) for the PTO owner or a team lead, and rendered in the `PTOViewModal` UI. The list response and the calendar chip never display notes (per MVP product decision).

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
  "note": "Appointment"
}
```

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
  "updatedAt": "2026-05-03T12:00:00Z"
}
```

#### PUT /pto/:id
Updates a PTO record if requester is owner or team lead.

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
  "updatedAt": "2026-05-03T12:30:00Z"
}
```

#### DELETE /pto/:id
Deletes a PTO record if requester is owner or team lead.

Response 204.

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
- `VALIDATION_ERROR` (400) — request body fails Zod validation
- `NOT_FOUND` (404) — referenced PTO does not exist
- `CONFLICT` (409) — proposed PTO overlaps an existing PTO for the same user
- `RATE_LIMITED` (429) — login limiter or global limiter tripped; `Retry-After` header carries seconds-until-reset
- `NOT_READY` (503) — readiness probe only; DB unreachable or probe timed out
- `INTERNAL_ERROR` (500) — unhandled exception

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

### 10.2 PTOService responsibilities
- Validate PTO payload
- Persist PTO entries
- Retrieve visible-date-range-overlapping entries
- Enforce normalization rules
- Prepare display-friendly response payloads

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

### 10.6 Lifecycle (`backend/src/lib/lifecycle.ts`)

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

### 11.6 Toast notifications
- Page-level feedback (create / update / delete / list-fetch errors) is delivered through a single toast system, not inline banners.
- Files: `frontend/src/context/ToastContext.ts` (types + context), `frontend/src/context/ToastProvider.tsx` (state + dedupe + cap + auto-dismiss timers), `frontend/src/hooks/useToast.ts` (imperative `push` / `dismiss`), `frontend/src/components/common/Toast.tsx` (single toast), `frontend/src/components/common/ToastViewport.tsx` (fixed top-right region, `AnimatePresence` stack, `Escape` key handler), mounted in `frontend/src/App.tsx` inside `<ToastProvider>`.
- Tones: `success` (terracotta left-stripe, `CheckCircle2` icon) and `error` (danger left-stripe, `XCircle` icon). Success uses `role="status" aria-live="polite"`; error uses `role="alert" aria-live="assertive"` and moves focus to the close button so SR / keyboard users can act immediately.
- Queue: newest on top, max 3 visible (oldest auto-evicted), same `tone+title` dedupes in place (refreshes timestamp and content).
- Motion: `motion/react` slide+fade enter (~180ms) and exit (~120ms); hairline progress bar driven by `requestAnimationFrame`; pauses on `hover` or `focus-within` and resumes on leave; `prefers-reduced-motion` reduces to opacity-only.

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
- HTTP-only secure cookie sessions (`cookie-session`). `COOKIE_SAME_SITE` defaults to `lax` locally and in the primary OCI single-host deployment; the manual split Firebase Hosting + Cloud Run fallback uses `none`; `COOKIE_SECURE=true` is required whenever `none` is used
- Cross-origin requests are allowed via the `cors` middleware using the `CORS_ORIGIN` env var allowlist. Credentials are permitted (`credentials: true`) so the HTTP-only cookie session works across origins in production. State-changing requests also pass through `csrfOriginMiddleware`, which rejects a supplied `Origin` or `Referer` outside the configured origin and rejects missing origin metadata when an authenticated session cookie is present; unauthenticated CLI login/setup requests remain supported
- `helmet` mounted globally for canonical security headers: Content-Security-Policy, Strict-Transport-Security, `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, Cross-Origin-Opener-Policy, Cross-Origin-Resource-Policy, Origin-Agent-Cluster
- `frontend/src/api/client.ts` `apiRequest` enforces a default 15s per-request timeout (configurable via `VITE_API_TIMEOUT_MS` or the `timeoutMs` option), normalizes fetch errors into a typed `ApiError(0, { code: 'TIMEOUT' | 'ABORTED' | 'NETWORK' | 'BAD_RESPONSE', message })`, and accepts a caller `signal` to abort in-flight requests. A `try/catch` around `JSON.parse(text)` throws `BAD_RESPONSE` for malformed (non-JSON) bodies so the caller never gets an uncaught `SyntaxError` from the fetch layer. All HTTP calls in the app go through this client; `frontend/eslint.config.js` has a `no-restricted-syntax` rule that bans raw `fetch(` outside the api client module + the apiClient test, so the timeout/abort/JSON-parse/error-normalization behavior is uniform. ID and query segments are always `encodeURIComponent`-ed
- A top-level `ErrorBoundary` (`frontend/src/components/ErrorBoundary.tsx`) wraps the route tree inside `App.tsx`. Any uncaught render-time error (a malformed server payload cast to the wrong shape, a `new Date(invalidString)`-style NaN, etc.) is caught and replaced with a user-facing fallback that includes a "Back to calendar" button — no blank screen, no leaked error body
- Self-service account setup: `POST /users` (team_lead only) creates a member with `passwordHash: null`, a one-time setup token (sha256-hashed in the DB, TTL `SETUP_TOKEN_TTL_MS` default 24h), and returns `{ user, setupToken, expiresAt }`. `POST /auth/setup-account` (public) atomically claims the token, hashes the password, increments `session_version`, clears the token columns, starts a session, and returns the user. `POST /users/:id/reset-password` (team-lead only, no self-reset, no resetting the only team_lead) increments `session_version` and issues a fresh token, revoking existing sessions. `Role` is widened to `member | team_lead | admin` (`admin` is a forward-compatible role used by `canManageUsers` / `canModifyPto`; today the team_lead gate is the active one). The `Prisma User` table gets nullable `password_hash`, `setup_token_hash VARCHAR(64)`, `setup_token_expires_at`, and `session_version INTEGER NOT NULL DEFAULT 0`. New setup links use `/setup-account#token=...`; legacy query-token links are scrubbed on load. The frontend exposes `/setup-account#token=...` and a team-lead-only `/admin/users` page
- Per-IP rate limiting: `POST /auth/login` is subject to a strict login limiter (default 5 failed attempts per 15 min, `skipSuccessfulRequests: true`) and every route except `/health` and `/ready` is subject to a global limiter (default 100 requests per 15 min). Both return `429 RATE_LIMITED` + `Retry-After`. The `keyGenerator` uses Express's `req.ip`, which is resolved using the configured trusted proxy chain; it never parses the first raw `X-Forwarded-For` value. `app.set('trust proxy', TRUST_PROXY_HOPS)` is called in `createApp()` when `TRUST_PROXY_HOPS > 0`; the default is `0` in dev/test, `1` for Cloud Run, and the OCI Compose deployment explicitly sets `2` for Caddy -> nginx -> backend. Production requires `RATE_LIMIT_REDIS_URL` and uses separate shared Redis prefixes for login/global counters; dev/test retain the in-memory store.
- Structured request logging via `pino-http` with `X-Request-Id` correlation IDs on every response; `errorHandler` logs `reqId` with any unhandled error so operators can correlate. `/health` and `/ready` are skipped via `autoLogging.ignore`. The base `pino` logger applies a `redact` configuration that strips session cookies, `Set-Cookie`, `Authorization`, and `password`/`passwordHash`/`token`/`secret` fields from every log line, and the custom `req`/`res` serializers drop the `headers` field entirely.
- Liveness `/health` and readiness `/ready` probes — readiness probes the DB with `prisma.$queryRaw\`SELECT 1\`` raced against `READY_TIMEOUT_MS` (default 5s); both return minimal payloads and do not leak environment, version, or deployment metadata
- Production deployment uses an OCI Always Free ARM64 VM with Caddy for TLS/HSTS, nginx for the static SPA and API proxy, Node/Express for the API, PostgreSQL in a persistent container, and Upstash TLS Redis/Valkey for the shared rate-limit store. The browser uses one custom HTTPS hostname, so `CORS_ORIGIN` is the exact OCI origin, `COOKIE_SAME_SITE=lax`, `COOKIE_SECURE=true`, and `COOKIE_DOMAIN` is empty. `TRUST_PROXY_HOPS=2` matches the Caddy -> nginx -> backend chain. PostgreSQL backups are encrypted and stored off-VM in private OCI Object Storage. Cloud Run, Firebase Hosting, and Supabase remain a manual fallback documented in `docs/gcp-firebase-deploy.md`; the deferred shared-parent custom-domain option is in `docs/gcp-firebase-custom-domain.md`
- Production images use Node.js 24 base images pinned by digest; the backend runtime installs production dependencies only, retaining Prisma CLI for one-off migrations while excluding test/Vite tooling. The local Compose migration service targets the full build stage because it is development-only.
- Production first-run team-lead bootstrap: `npm run db:bootstrap` runs `backend/prisma/bootstrap.ts` and creates a single `team_lead` user with a one-time setup token (reusing `generateSetupToken` from #62). Env: `LEAD_EMAIL` (required), `LEAD_NAME` (default `"Team Lead"`), `LEAD_COLOR_CODE` (default `#3B82F6`), `APP_PUBLIC_BASE_URL` (or `--base-url` flag, default `http://localhost:5173`). Prints the setup link to stdout. Idempotent: if the lead already has a password, it's a no-op; if the lead exists with no password, the token is regenerated and the new link is printed. `backend/.env.example` documents all four envs. `backend/tests/integration/bootstrap.test.ts` (5 cases) covers the validation, fresh-create, `--base-url` override, no-op idempotency, and token-regeneration paths.

### 13.3 Reliability
- Failed requests return clear errors with machine-readable codes (`UNAUTHENTICATED`, `FORBIDDEN`, `VALIDATION_ERROR`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `NOT_READY`, `INTERNAL_ERROR`)
- Database writes are transactional where needed (PTO create/update run inside a single Prisma operation; audit-log writes are best-effort and do not block the response)
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

### 14.4 Automation, tooling, CI/CD, and coverage policy
See `testing-strategy.md` for the full automation plan: tooling matrix (Vitest, Supertest, React Testing Library, MSW, Playwright, GitHub Actions), coverage targets with strict gates on authorization and PTO validation, ephemeral Postgres for integration tests, pre-commit hooks, and merge policy.

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
- The one-time migration source is the encrypted Supabase CLI/GCS flow described in `docs/database-backups.md`
- Configure DB, session, Upstash, and backup secrets in the VM's protected `.env` file; retain recovery copies outside the VM
- Set `CORS_ORIGIN` to the OCI production origin. Use `COOKIE_SECURE=true`, `COOKIE_SAME_SITE=lax`, an empty `COOKIE_DOMAIN`, and `TRUST_PROXY_HOPS=2`
- A self-contained local "clone-and-run" flow is provided via `docker-compose.app.yml`: Postgres + one-shot development-only `migrate` service + backend + nginx-served frontend on a single Docker network with only localhost port `5173` exposed. nginx proxies `/auth`, `/pto`, `/health`, `/ready` to the backend and serves the SPA on `/`. See `README.md` §"Running with Docker (all-in-one)". This is a developer demo path and does not replace the TLS / real-secret deployment pattern described above

## 17. Confirmed Technical Decisions
- Audit logs are stored internally only and are not exposed in the MVP UI
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
