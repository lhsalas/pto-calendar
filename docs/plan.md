# PTO / Vacation Calendar App Plan

## 1. Goal
Build a small internal app where team members can record planned PTO/vacation dates, view everyone’s time off in a shared calendar, and manage entries with role-based permissions.

## 2. Core Users
- **Team member**
  - Can log in
  - Can create, view, update, and delete their own PTO entries
  - Can view all other team members’ PTO entries
- **Team lead**
  - Can do everything a team member can do
  - Can update or delete any team member’s PTO entry

## 3. Main Requirements

### 3.1 Authentication
- Only logged-in users can access the app
- Every PTO entry must be linked to the authenticated user who created it
- Users must have a role field, at minimum:
  - `member`
  - `team_lead`

### 3.2 PTO CRUD
Any logged-in user can create PTO entries.

#### PTO entry rules
- A PTO can be:
  - **Multi-day**: if the user selects more than 1 day
  - **Single-day**: if the user selects only 1 day
- If the PTO is **single-day**, the user must choose one of:
  - `morning`
  - `evening`
  - `all_day`
- If the PTO spans **multiple days**, it should be treated as day-based PTO for the full selected date range

#### Ownership and permissions
- Any logged-in user can **view** all PTO entries
- A user can **edit/delete**:
  - their own PTO entries
  - any PTO entry if they are the **team lead**
- Users who are neither the owner nor team lead cannot modify or delete others’ entries

### 3.3 Calendar Main Page
The main page should be a **calendar view**.

#### Calendar behavior
- Show the selected month by default
- Allow navigation to:
  - previous month
  - next month
  - future months
- Display PTO entries on calendar days
- Use **different colors** to help identify who has requested time off
- Logged-in users should be able to quickly see:
  - who is off on each day
  - whether the day is full-day or half-day when applicable

## 4. Functional Scope

### 4.1 User stories
1. As a logged-in team member, I can create a PTO entry for one or more dates.
2. As a logged-in team member, if I choose only one date, I can specify morning, evening, or all day.
3. As a logged-in team member, I can view everyone’s PTO in a shared calendar.
4. As a logged-in team member, I can edit or delete my own PTO entries.
5. As a team lead, I can edit or delete any PTO entry.
6. As a logged-in user, I can move between months in the calendar to inspect future PTOs.

### 4.2 Admin/lead capabilities
- Team lead override for edit/delete actions
- Optional future enhancement: team lead dashboard filters by person or date range

## 5. Suggested MVP Features

### MVP
- Email/password login/authentication
- Manually seeded users for MVP (seed script is idempotent; re-running it refreshes password hashes, names, roles, and colors)
- User roles (`member`, `team_lead`)
- PTO create/read/update/delete
- Single-day half-day selection (`morning`, `evening`, `all_day`)
- Multi-day PTO date range selection
- Monthly calendar view
- Month-to-month navigation
- Color-coded PTO display by user
- Permission enforcement for owner/team lead actions

### Post-MVP / Nice to have
- Approval workflow
- Email/Slack notifications
- PTO conflicts/high team absence warning
- ~~Public holiday support~~ (shipped via #112 — see §18)
- Search/filter by employee
- Mobile-friendly calendar interactions
- Export to CSV/iCal

## 6. Business Rules

### 6.1 PTO creation rules
- Start date is required
- End date is required
- If `start_date == end_date`, user must pick a `day_part`:
  - `morning`
  - `evening`
  - `all_day`
- If `start_date != end_date`, `day_part` is normalized to `all_day`
- End date cannot be earlier than start date
- PTO entries should not allow empty or invalid date ranges
- PTO entries cannot overlap another PTO entry for the same user
- PTO cannot start or end on a weekend; weekends inside a multi-day PTO range count and are displayed as part of the continuous PTO

### 6.2 Visibility rules
- All authenticated users can view all PTO records
- PTO records must show at least:
  - employee name
  - start date
  - end date
  - day part when single-day

### 6.3 Authorization rules
- Create: any authenticated user
- Read: any authenticated user
- Update: owner or team lead
- Delete: owner or team lead

## 7. UX / UI Plan

### 7.1 Main screen: calendar-first layout
- **Header**
  - App name
  - Current month/year
  - Previous / next month controls
  - Logged-in user menu
- **Calendar grid**
  - Standard month layout
  - Each day cell lists PTO entries for that date
  - Entries appear as color-coded chips, badges, or bars
- **Legend / side panel**
  - Color mapping by user
  - Optional hover or click for details

### 7.2 PTO creation/edit flow
- Button: `Add PTO`
- Form fields:
  - Start date
  - End date
  - If one-day selection: day part selector
  - Optional note/reason
- Save / cancel actions
- Validation messages for invalid ranges

### 7.3 PTO details display
Each displayed PTO item should show:
- Person name
- PTO duration
- Day part if single-day
- Optional note

### 7.4 Editing/deleting behavior
- If current user is owner or team lead:
  - show edit button
  - show delete button
- Otherwise:
  - view-only display

### 7.5 Toast notifications (feedback)
- All page-level feedback (create / update / delete / list-fetch errors) is delivered through a unified toast system (`success` + `error` tones), not inline banners. The viewport is a fixed top-right region with a 3-item cap, slide+fade enter/exit, and a hairline progress bar that pauses on hover or focus-within. Error toasts can carry a `Retry` action (e.g. for `usePtoList` load failures).

## 8. Recommended Technical Design

### 8.1 Frontend
Confirmed MVP stack:
- **React + TypeScript using Vite**
- **Tailwind CSS** for styling
- Calendar UI library options:
  - FullCalendar
  - React Big Calendar
  - custom month grid for a simpler MVP

Frontend responsibilities:
- Authentication state handling
- Calendar rendering
- PTO forms and validation
- Role-based action visibility

### 8.2 Backend
Confirmed MVP stack:
- **Node.js + Express + TypeScript**
- **Prisma** for database access
- **`cors` middleware** for cross-origin support (MVP, with `CORS_ORIGIN` allowlist)
- **`helmet`** for canonical security headers (CSP, HSTS, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, COOP/CORP/OAC)
- **`express-rate-limit`** for per-IP rate limiting (login limiter on `POST /auth/login`, global limiter on the rest of the API)
- **`pino` + `pino-http`** for structured request logging with `X-Request-Id` correlation
- **Custom lifecycle module** (`backend/src/lib/lifecycle.ts`) for graceful SIGTERM/SIGINT shutdown
- **Shared Zod schemas** (`backend/src/services/{auth,pto}/schemas.ts`) for request validation, imported by routes and the validation layer
- **Container images** (`backend/Dockerfile`, `frontend/Dockerfile`) for the all-in-one Docker Compose flow (`docker-compose.app.yml`) — Postgres + one-shot migrate+seed + backend (`node:20-alpine`) + nginx-served SPA (`nginx:alpine`); only host port 5173 is exposed. The host dev flow (`npm run dev`) and dev-only Postgres (`docker compose up -d db`) are unchanged and remain the canonical local setup; the compose file is purely additive

Backend responsibilities:
- Email/password authentication validation
- PTO CRUD endpoints
- Authorization checks
- Query PTO entries by visible calendar date range
- User and role management for manually seeded users
- Production hardening (security headers, rate limiting, request logging, graceful shutdown, liveness + readiness probes)

### 8.3 Database
Suggested relational DB:
- PostgreSQL
- MySQL
- SQLite for a very small MVP/internal prototype

Suggested tables:

#### `users`
- `id`
- `name`
- `email`
- `role` (`member`, `team_lead`)
- `color_code` (used in calendar)
- `created_at`
- `updated_at`

#### `pto_requests`
- `id`
- `user_id`
- `start_date`
- `end_date`
- `day_part` (`morning`, `evening`, `all_day`; multi-day PTO uses `all_day`)
- `note` (optional)
- `created_at`
- `updated_at`

## 9. API Plan

### Operational probes (unauthenticated)
- `GET /health` — liveness probe; always 200 + `{ status: 'ok' }` while the process is responsive (no DB check).
- `GET /ready` — readiness probe; runs `SELECT 1` against the DB with a `READY_TIMEOUT_MS` race-timer. 200 + `{ status, db, uptime }` on success, 503 + `{ error: { code: 'NOT_READY', details } }` on failure/timeout.

### Authentication
MVP authentication uses email/password login with manually seeded users, bcrypt password hashing, and HTTP-only cookie sessions.

- `POST /auth/login` — subject to the strict login limiter (`AUTH_RATE_LIMIT_MAX` failed attempts per `RATE_LIMIT_WINDOW_MS` per IP, `skipSuccessfulRequests: true`). On rate-limit hit, returns 429 + `Retry-After` + `{ error: { code: 'RATE_LIMITED', message } }`.
- `POST /auth/logout`
- `GET /auth/me`

All routes are subject to a global limiter (`RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW_MS` per IP) that returns 429 + `Retry-After` on overflow.

Every response carries an `X-Request-Id` header (UUID v4 generated by `crypto.randomUUID()`, or the inbound `X-Request-Id` if the client supplied one); non-probe requests produce one structured log line per response.

### PTO endpoints
- `GET /pto?start=YYYY-MM-DD&end=YYYY-MM-DD`
  - Returns all PTO entries overlapping the requested visible calendar grid range
- `POST /pto`
  - Create PTO entry for current user
- `PUT /pto/:id`
  - Update PTO entry if owner or team lead
- `DELETE /pto/:id`
  - Delete PTO entry if owner or team lead
- `GET /pto/:id`
  - View PTO details. The `note` field is returned for the owner or a team lead; redacted (`null`) otherwise. Note-visibility is enforced by the shared `canViewNote` helper in `AuthorizationService`.

### Validation rules in API
- Reject invalid date ranges
- Reject missing `day_part` for single-day PTO
- Normalize multi-day PTO `day_part` to `all_day`
- Reject overlapping PTO entries for the same user
- Reject PTO if the start or end date falls on a weekend
- Allow weekends inside a multi-day PTO range and display them as part of the continuous PTO
- Enforce authorization on update/delete
- Zod schemas live in `services/{auth,pto}/schemas.ts` and are imported by both the routes and the validation layer so the request contract is defined once

## 10. Calendar Data Behavior

### Display logic
- For each month view, fetch PTO records that overlap the full visible calendar grid range, including adjacent-month days
- Expand multi-day PTOs into each covered date, including weekends, for rendering purposes
- For single-day half-day PTOs:
  - visually mark morning/evening/all-day distinctly if possible

### Color strategy
Options:
- Assign each user a fixed profile color
- Or derive color deterministically from user ID/name

Recommendation:
- Store a `color_code` per user for consistent display

## 11. Security and Permissions
- Require authentication for all app routes and APIs **except** `GET /health` and `GET /ready`, which are intentionally unauthenticated probes for orchestrators
- Validate user identity server-side, not only in UI
- Enforce owner/team lead authorization in backend
- Centralize note-visibility logic via `canViewNote(actor, pto)` in `AuthorizationService` (delegates to `canModifyPTO`); no route-local `isOwnerOrLead` helpers
- `helmet` mounted globally for canonical security headers (CSP, HSTS, `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, COOP/CORP/OAC)
- Per-IP rate limiting on `POST /auth/login` (`AUTH_RATE_LIMIT_MAX` failed attempts per `RATE_LIMIT_WINDOW_MS`, `skipSuccessfulRequests: true`) and globally across the rest of the API (`RATE_LIMIT_MAX` per window). Both return `429 RATE_LIMITED` + `Retry-After`
- Structured request logging via `pino-http` with `X-Request-Id` correlation IDs on every response; `/health` and `/ready` are skipped via `autoLogging.ignore`. The base `pino` logger applies a `redact` configuration that strips session cookies, `Set-Cookie`, `Authorization`, and `password`/`passwordHash`/`token`/`secret` fields from every log line, and the custom `req`/`res` serializers drop the `headers` field entirely.
- Graceful shutdown on SIGTERM/SIGINT — drains the HTTP server, disconnects Prisma, with a `SHUTDOWN_TIMEOUT_MS` fallback. `uncaughtException` and `unhandledRejection` handlers log `fatal` and `process.exit(1)`
- Audit logging covers **all** PTO update and delete actions, including owner self-edits; logs are stored internally only and not exposed in the MVP UI

## 12. Edge Cases to Consider
- Single-day PTO with missing half-day selection
- End date before start date
- User tries to edit another person’s PTO without team lead role
- Many users off on the same day causing crowded calendar cells
- Attempts to create overlapping PTO entries for the same user
- Attempts to use a weekend as the PTO start date or end date
- Multi-day PTO ranges that include weekends in the middle
- Time zone consistency for date storage/display

## 13. Suggested Implementation Phases

### Phase 0: Foundation Scaffolding
- Generate the initial Prisma migration from `backend/prisma/schema.prisma` and commit it under `backend/prisma/migrations/<timestamp>_init/migration.sql`.
- The committed migration is propagated to CI and integration test setup via `prisma migrate deploy`; `migrate dev` must never run in CI.
- Migration SQL must include the `CHECK` constraints defined in `docs/schema.sql` §6.1 (`end_date >= start_date`, `start_date = end_date OR day_part = 'all_day'`) since Prisma's schema DSL cannot express CHECK constraints.

### Phase 1: Foundation
- Set up app project structure
- Add authentication
- Add user roles
- Create database schema for users and PTO requests

### Phase 2: PTO CRUD
- Build create/edit/delete PTO form
- Implement server-side validation
- Implement authorization checks

### Phase 3: Calendar UI
- Build month calendar view
- Add month navigation
- Render PTO entries with user colors
- Add detail tooltips/modal/cards

### Phase 4: Polish
- Improve mobile responsiveness
- Add empty/loading/error states
- Add confirmation for delete
- Add tests for auth and permission logic

### Phase 5: Production Hardening (shipped)
- `helmet` for canonical security headers
- Per-IP rate limiting on login + global rate limiter across the API
- Graceful shutdown on SIGTERM/SIGINT with `SHUTDOWN_TIMEOUT_MS` fallback
- Liveness `/health` + readiness `/ready` probes (DB probe raced against `READY_TIMEOUT_MS`)
- Structured request logging via `pino-http` with `X-Request-Id` correlation IDs; the base `pino` logger redacts session cookies, `Set-Cookie`, `Authorization`, and `password`/`passwordHash`/`token`/`secret` fields, and the custom `req`/`res` serializers drop `headers` entirely
- Centralized `canViewNote` authorization helper in `AuthorizationService`
- Shared Zod schemas between route handlers and the validation layer
- Direct unit coverage for middleware (`cookieSession`, `errorHandler`, `requireAuth`) and `PTOService` create + overlap paths
- Per-file coverage thresholds bumped where direct unit coverage was added (`PTOService` 80→90, middleware 0→80, schemas 0→100, lifecycle 0→100)

## 14. Testing Plan

### Unit tests
- PTO validation logic
- Authorization rules
- Date range expansion logic for calendar rendering

### Integration tests
- User can create own PTO
- User can edit/delete own PTO
- User cannot edit/delete another user’s PTO
- Team lead can edit/delete anyone’s PTO
- Visible date-range API returns overlapping PTO correctly

### UI tests
- Calendar month navigation works
- PTO entries render in correct days
- Single-day half-day selection appears only when applicable

## 15. Confirmed Product Decisions
- PTO is informational only; no approval workflow for MVP
- Overlapping PTO entries for the same user are not allowed
- PTO cannot start or end on a weekend, but weekends inside a multi-day PTO range count and are displayed
- Public holidays are out of scope for MVP
- PTO notes are visible only to the owner or team leads
- Multiple team leads are supported
- Audit logging for update/delete actions is included in MVP and stored internally only
- Calendar PTO data is fetched for the full visible grid range, including adjacent-month days
- Production hardening (helmet, rate limiting, structured request logging, graceful shutdown, liveness/readiness probes) is in scope and shipped for MVP
- `/health` and `/ready` are intentionally unauthenticated orchestrator probes; every other API requires authentication
- Note-visibility is enforced via a single `canViewNote` helper in `AuthorizationService`; no route-local re-implementations
- The single team lead (default `lead@example.com`) creates new members; the new member sets their own password via a one-time setup link. No email delivery. A team lead can also reset a member's password (same one-time flow). An `admin` Role enum value exists for forward compatibility but no `admin` user is seeded; the active gate is `team_lead`
- Request validation is defined once via shared Zod schemas (`services/{auth,pto}/schemas.ts`); routes and the validation layer import from the same source

## 16. Recommended MVP Definition
A good first version would include:
- Secure email/password login using bcrypt and HTTP-only cookie sessions
- Manually seeded users with member/team lead roles
- PTO CRUD
- Single-day half-day options
- Monthly shared calendar view
- View all PTOs
- Edit/delete restricted to owner or team lead
- Color-coded display by user
- Month navigation for future planning

## 17. Success Criteria
The app is successful if:
- Team members can easily add planned PTO
- Everyone can quickly see who will be off in a given month
- Team lead can manage entries when needed
- Permission rules are enforced correctly
- Calendar navigation supports forward planning

## 18. Public Holiday Support (Shipped)

Issue #112. The calendar now overlays a read-only `HolidayBadge` on every day
that matches a row in the `holidays` table. Two holidays on the same `date`
with different `countryCode` values coexist; the unique key is
`(date, country_code)`. A `countryCode` of `null` denotes a locale-agnostic
holiday that applies to everyone.

- **Read path**: every authenticated user fetches `GET /holidays?start=&end=`
  for the visible grid range, in parallel with `GET /pto`. The `DayCell`
  renders one `HolidayBadge` per matching `(date, countryCode)`, ordered by
  `countryCode ASC` (null first), stacked above the PTO chips.
- **Write path**: team leads only. `POST /holidays`, `DELETE /holidays/:id`,
  and `POST /holidays/seed` are all gated by `canManageUsers`. Members who hit
  the API directly get `403 FORBIDDEN`; the admin nav link is hidden for them.
- **Audit logging**: `create_holiday`, `delete_holiday`, and `seed_holidays`
  entries are written via `AuditLogService.record` with the actor's id and a
  JSON `details` payload.
- **PTO × holiday interaction**: independent. A PTO whose start or end date
  matches a holiday is allowed; no backend rejection, no frontend warning.
  PTO chips and holiday badges render independently on the same day.
- **Out of scope (deliberately)**: iCal/CSV export of holidays, live
  holiday-feed sync (Nager.Date, ICS subscription), per-user "ignore
  holiday" preferences, holiday-colored PTO chips, locales beyond US + MX.

## 19. ADR: Cloud Run + Firebase Hosting + Supabase

### Decision

Deploy the Node/Express API to Google Cloud Run with request-based billing and
minimum instances set to `0`. Deploy the Vite SPA as static files on Firebase
Hosting. Keep PostgreSQL and Prisma migrations on Supabase.

### Consequences

- The frontend calls the Cloud Run URL directly with `credentials: 'include'`.
- Production uses exact CORS, `COOKIE_SECURE=true`, and
  `COOKIE_SAME_SITE=none` for the default split Firebase/Cloud Run hostnames.
- State-changing requests validate the browser `Origin` or `Referer`.
- Cloud Run uses a Supabase pooler URL at runtime; migrations and backups use a
  direct or session-mode URL in one-off jobs.
- Firebase Hosting rewrites are not used because they strip cookies other than
  `__session`, which is incompatible with the current signed cookie-session
  pair.
- Supabase Free does not provide downloadable managed backups. Daily encrypted
  logical dumps are stored outside Supabase in private GCS storage.
- The Deno adapter and OCI production infrastructure are retired. The local
  Docker/Podman development stack remains supported.
