# PTO / Vacation Calendar App Documentation

This repository contains planning and technical documentation for a small internal PTO/vacation calendar app for a development team.

## Repository Layout

```
pto-calendar/
├── backend/     # Node.js + Express + TypeScript + Prisma + PostgreSQL
├── frontend/    # React + TypeScript (Vite) + Tailwind CSS
└── docs/        # Project documentation (see below)
```

## Documents

All project documentation lives under [`docs/`](docs/).

### 1. Product Plan

- **File:** `docs/plan.md`
- **Purpose:** High-level product plan covering goals, users, requirements, UX, technical recommendations, implementation phases, and success criteria.

### 2. Technical Specification

- **File:** `docs/technical-spec.md`
- **Purpose:** Detailed technical design including architecture, domain model, database structure, API behavior, frontend/backend responsibilities, validation rules, and testing guidance.

### 3. Database Schema

- **File:** `docs/schema.sql`
- **Purpose:** SQL schema for the initial relational database setup, including users, PTO requests, indexes, and audit logs.

### 4. OpenAPI Specification

- **File:** `docs/openapi.yaml`
- **Purpose:** API contract for authentication and PTO endpoints, including request/response models and error structures.

### 5. Backlog

- **File:** `docs/backlog.md`
- **Purpose:** Epics, user stories, acceptance criteria, tasks, sprint suggestions, and definition of done.

### 6. Testing & Automation Strategy

- **File:** `docs/testing-strategy.md`
- **Purpose:** Tooling matrix, test pyramid, coverage targets (≥80% on critical services, ≥90% on `PTOService`, 100% on authorization, validation, schemas, middleware, and lifecycle), GitHub Actions CI pipeline, ephemeral Postgres for integration tests, Playwright E2E scope (desktop + mobile-chrome projects), pre-commit hooks, and merge policy.

## Functional Summary

The app is intended to support:

- Authenticated access only
- Team member and team lead roles
- PTO CRUD operations
- Single-day PTO with `morning`, `evening`, or `all_day`
- Multi-day PTO across date ranges
- PTO form auto-syncs the end date to the start date on every start-date change; the end-date input has `min={startDate}` so the browser's date picker prevents picking an end date before the start
- In grid view, opening the create modal pre-fills the start date with the 1st of the **viewed future month** (or today for the current/past month); list view always pre-fills with today
- In grid view, clicking a weekday cell (Mon–Fri, including adjacent-month cells) opens the create modal pre-filled with that day; weekend cells are non-interactive; chips inside cells open the view modal without bubbling to the cell handler
- Shared monthly calendar view
- Month navigation (prev/next + a "Today" button to jump back to the current month; the Today button is disabled while the calendar is already on the current month; today's cell is highlighted with a filled blue circle on the day number)
- A "Calendar | List" view toggle: in list mode the app shows all PTOs from today through today + 90 days, grouped by month and sorted ascending, with a "Next" / "Today" / "Previous" shift control that moves the 90-day window
- Color-coded PTO visibility by person
- Edit/delete permissions restricted to owner or team lead
- Light / Dark / System theme toggle (persisted in `localStorage`; default is System and follows `prefers-color-scheme`; no flash of incorrect theme on load)
- Self-hosted typography (IBM Plex Sans body, Fraunces display, IBM Plex Mono for tabular dates) and a Tailwind v4 `@theme` block with the warm-editorial palette tokens defined (consumed in PR C); `lucide-react` icon set re-exported from `src/components/icons.tsx`; `motion` package installed for upcoming animations
- Responsive layout (page padding shrinks on phones, top header wraps, grid scrolls horizontally only inside its own container with a sticky weekday header); all primary interactive elements meet ≥44px tap targets (44px on buttons, 36px on destructive confirm pair); modals (Add/Edit PTO + PTO details) support Escape-to-close, backdrop-click-to-close, body-scroll-lock, and focus trapping with auto-focus of the first focusable element. The shared a11y logic is encapsulated in `frontend/src/hooks/useModalA11y.ts` (generic over the modal root element) and unit-tested at 100% (`useModalA11y.test.tsx`, 8 tests).
- Editorial / paper-planner visual identity: warm cream surface (#FBF8F1), terracotta accent (#B5533A), Fraunces serif for the month label and login h1, IBM Plex Sans for body UI, IBM Plex Mono with tabular-nums for every date display; raw ISO date strings are formatted via `Intl.DateTimeFormat`; loading state is an `aria-busy` skeleton; modals fade-and-slide in via `motion`. Design tokens (palette, typography, radii, motion) are defined once in a Tailwind v4 `@theme` block in `frontend/src/index.css` and consumed by every component.
- Toast notifications for save/update/delete/load-error feedback: a unified `Toast` + `ToastViewport` + `ToastProvider` + `useToast` system mounted in `App.tsx`. Success and error tones, terracotta or danger left-stripe on a `surface-3` card, `CheckCircle2` / `XCircle` lucide icons, slide+fade enter/exit via `motion`, hairline progress bar (pauses on hover/focus, resumes on leave), manual close button, `Escape` dismisses the topmost when the viewport has focus, error toasts move focus to the close button for SR/keyboard users, `prefers-reduced-motion` honored, queue capped at 3 with oldest auto-evicted, and same `tone+title` toasts dedupe in place. `error` toasts from `usePtoList` carry a Retry action that calls `refetch()`.
- Persistent keyboard focus indicators: every input and `<button>` carries a `focus:ring-2` (inputs) or `focus-visible:ring-2 ring-accent-500` (buttons) so the keyboard user always sees where focus lives; ring offset matches the page surface so it reads as part of the layout; chips, calendar cells, modal ×, list-row opens, and Retry link all participate
- Tab favicon: a single 723-byte SVG under `frontend/public/favicon.svg` — calendar-grid mark (rounded-rect page outline, two binding stubs, header divider, 3×3 day grid, one filled "today" square) — single mid-tone terracotta (#B5533A) fill, tab-only, no PNG/apple-touch-icon/manifest/OG
- Production hardening (backend): `helmet` mounted globally for the canonical security headers (CSP, HSTS, `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, COOP/CORP/OAC); stricter login limiter on `POST /auth/login` (5 failed attempts per 15 min per IP, `skipSuccessfulRequests: true`); broader global limiter across the rest of the API (100 requests per 15 min per IP); both respond with `{ error: { code: 'RATE_LIMITED', message } }` and `Retry-After`. All three limits are env-driven (`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_MAX`); defaults are conservative for production but the dev `.env` and CI bump them so e2e suites don't trip the limiter.
- Graceful shutdown (backend): SIGTERM/SIGINT triggers `shutdown(server, prisma)` which drains `server.close()`, then disconnects the global Prisma client, with a `SHUTDOWN_TIMEOUT_MS` (default 10s) fallback that force-exits 1 if drain hangs. `server.closeAllConnections()` (Node 18+) closes idle keep-alives. `uncaughtException` and `unhandledRejection` handlers log `logger.fatal` and call `process.exit(1)`. Lifecycle is extracted to `backend/src/lib/lifecycle.ts` and unit-tested at 100% coverage (`lifecycle.test.ts`).
- Health vs readiness (backend): `GET /health` is a no-DB liveness probe that always returns 200 + `{ status: 'ok' }` so orchestrators can restart hung instances; `GET /ready` runs `prisma.$queryRaw\`SELECT 1\``with a`READY_TIMEOUT_MS`(default 5s) race-timer and returns 200 +`{ status: 'ready', db: 'ok', uptime }`on success or 503 +`{ error: { code: 'NOT_READY', ... } }`on failure or timeout. Both endpoints are unauthenticated and registered before`authRouter`/`ptoRouter`. Extracted to `backend/src/routes/health.ts`; covered by `server.test.ts` (7 tests including DB-throw and DB-hang cases).
- Request logging (backend): `pino-http` mounted globally between `express.json` and `cookieSession` so request-scoped logs are available everywhere. Every response echoes an `X-Request-Id` header (UUID v4 generated by `crypto.randomUUID()`, or the inbound `X-Request-Id` if the client sent one and it matches the safe character class — values containing control characters or whitespace are replaced with a fresh UUID to prevent log injection). Every non-probe request produces exactly one structured log line with `req.{id,method,url}`, `res.statusCode`, and `responseTime` on response finish; `/health` and `/ready` are skipped via `autoLogging.ignore` so probes don't spam logs. `errorHandler` middleware logs `reqId` with any unhandled error so operators can correlate. The base `pino` logger applies a `redact` configuration that strips `Cookie`, `Set-Cookie`, `Authorization`, and `password`/`passwordHash`/`token`/`secret` fields from every log line, and the custom `req`/`res` serializers drop the `headers` field entirely so session cookies and other auth headers never reach stdout.
- Authorization centralization (backend): the `GET /pto/:id` route uses the shared `canViewNote(actor, pto)` helper from `services/authorization/AuthorizationService` (which delegates to `canModifyPTO`) to decide whether to redact the `note` field. There is no longer a route-local `isOwnerOrLead` helper — all note-visibility logic flows through the authorization service.
- Shared Zod validation (backend): Zod schemas are defined once per domain — `backend/src/services/pto/schemas.ts` (`CreatePtoSchema`, `RangeQuerySchema`, `IdParamSchema`, `DayPartSchema`, `ISO_DATE`) and `backend/src/services/auth/schemas.ts` (`LoginSchema`). Both route files import from these and infer their request types directly, so there are no `as` casts or duplicated validation rules. `validation.ts` re-uses `ISO_DATE` and `CreatePtoInput` from the same source. Both schema modules are unit-tested at 100% coverage (4 + 11 tests).
- Middleware direct unit coverage (backend): `cookieSession.ts`, `errorHandler.ts`, and `requireAuth.ts` each have a dedicated unit suite (5 + 5 + 4 tests, 100% on `requireAuth`, 80% on `cookieSession`/`errorHandler`). The middleware layer is no longer covered only via the server-level integration tests.
- `PTOService` direct unit coverage (backend): the create-path and overlap-check helpers (`createPto`, `findOverlapping`) now have direct unit tests (10 new tests in `PTOService.test.ts`), pushing the per-file threshold from 80% to **90% lines/statements/functions** (branches remain at 80% due to a small uncovered defensive branch in the update path).
- Playwright project split (frontend): `frontend/playwright.config.ts` runs two projects — a desktop `chromium` (all `e2e/*.spec.ts`) and a `mobile-chrome` project (Pixel 5) whose `testMatch` is whitelisted to `e2e/mobile-smoke.spec.ts`, `e2e/focus-rings.spec.ts`, and `e2e/smoke.spec.ts` only. The whitelist keeps the mobile run from racing against desktop tests that share the dev `pto` database. `workers=1` in CI.

## Confirmed MVP Stack

- **Frontend:** React + TypeScript using Vite
- **Styling:** Tailwind CSS
- **Backend:** Node.js + Express + TypeScript
- **Database:** PostgreSQL with Prisma
- **Auth:** Email/password login with bcrypt password hashing and HTTP-only cookie sessions
- **User provisioning:** Seeded manually for MVP

## Suggested Reading Order

1. `docs/plan.md`
2. `docs/technical-spec.md`
3. `docs/schema.sql`
4. `docs/openapi.yaml`
5. `docs/backlog.md`
6. `docs/testing-strategy.md`

## Suggested Next Steps

All 16 tracked enhancements (8 frontend issues #18–#26 and 8 backend hardening issues B1–B8) are shipped. Reasonable follow-ups for the next iteration:

- **Security beyond helmet:** add a CSRF token strategy for cookie-session flows, swap seed credentials for SSO when an IdP is available, and add an `IP allowlist` opt-in for `/ready` + `/health` from internal probe networks.
- **Observability:** wire `pino-http` logs into a structured log sink (Loki/CloudWatch) and expose a `/metrics` endpoint (Prometheus format) that surfaces request count, rate-limit hits, `/ready` latency, and DB query time.
- **Calendar features:** public-holiday overlay (read-only), iCal export of the visible month, and team-lead "PTO conflict warnings" when more than N% of the team is out on the same day.
- **API surface:** support `?userId=` filter on `GET /pto` for team-lead dashboards, and add a soft-delete + audit-restore path for accidentally-deleted PTO entries.
- **Frontend polish:** Storybook for the component library, animated month transitions via `motion`, and a keyboard-shortcut overlay.

## Getting Started

```bash
npm install
npm run db:up
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
npm run db:migrate
npm run db:seed
npm run dev
```

Frontend runs on http://localhost:5173, backend on http://localhost:3000. Sign in with any of the [seeded dev users](#seeded-dev-users) below.

## Running with Docker (all-in-one)

If you only have Docker installed (no Node.js / npm), you can run the entire stack with a single command:

```bash
npm run app:up          # or: docker compose -f docker-compose.app.yml up --build
```

This builds and starts four containers — Postgres, a one-shot migrate+seed job, the backend, and an nginx-served SPA. Only **host port 5173** is exposed; the database and backend live on an internal Docker network. The seeded users are created automatically; log in at <http://localhost:5173> with any of the [seeded dev users](#seeded-dev-users) below. Stop with Ctrl+C and `npm run app:down` to remove the containers; add `-v` (`npm run app:reset`) to wipe the database volume too.

The standalone host flow (`npm run dev`) and the dev-only Postgres (`npm run db:up`) are unchanged — the new compose file lives at `docker-compose.app.yml` and is purely additive.

## Scripts

| Command                       | Effect                                              |
| ----------------------------- | --------------------------------------------------- |
| `npm run dev`                 | Run backend + frontend together (concurrently)      |
| `npm run build`               | Production build for both workspaces                |
| `npm run start`               | Start the compiled backend (`node dist/index.js`)   |
| `npm run lint`                | ESLint across both workspaces                       |
| `npm run typecheck`           | `tsc --noEmit` in both workspaces                   |
| `npm run format`              | Prettier write                                      |
| `npm run format:check`        | Prettier check                                      |
| `npm run test:coverage`       | Vitest with coverage for both workspaces            |
| `npm run test:e2e`            | Playwright E2E suite                                |
| `npm run db:up` / `db:down`   | Docker compose for local Postgres                   |
| `npm run db:migrate`          | `prisma migrate dev` (creates new migrations)       |
| `npm run db:migrate:deploy`   | `prisma migrate deploy` (production)                |
| `npm run db:reset`            | Drop, recreate, migrate, and seed                   |
| `npm run db:seed`             | Seed the dev users                                  |
| `npm run app:up` / `app:down` | Docker compose all-in-one (db + backend + frontend) |
| `npm run app:reset`           | All-in-one, plus drop the DB volume                 |

The backend reads `backend/.env` automatically on `npm run dev` and `npm run test:integration`. No `source` step is required. Existing shell env vars (e.g. production overrides) always win over the file.

## Seeded Dev Users

Both run modes ([host dev](#getting-started) and [Docker all-in-one](#running-with-docker-all-in-one)) seed the same three users via `backend/prisma/seed.ts`. Use any of them at the login page:

| Email              | Password            | Role        | Calendar color    |
| ------------------ | ------------------- | ----------- | ----------------- |
| `lead@example.com` | `lead-dev-password` | `team_lead` | `#3B82F6` (blue)  |
| `dev1@example.com` | `dev1-dev-password` | `member`    | `#10B981` (green) |
| `dev2@example.com` | `dev2-dev-password` | `member`    | `#F59E0B` (amber) |

Sign in as the team lead to see (and edit) every member's PTO; sign in as a member to manage only their own PTO. The `npm run db:seed` command also prints the same list when run manually.

> These are **dev-only credentials** baked into the seed file. They must be replaced before any real deployment — see [Production Deployment](#production-deployment).

## Production Deployment

The MVP deploys as three artifacts (the Node API, a static SPA, and nginx) fronted by Caddy as the TLS-terminating reverse proxy. The recommended production topology is **Caddy → nginx → backend**, with nginx serving the static SPA and proxying `/auth/*`, `/pto/*`, `/health`, `/ready` to the Node service. Caddy terminates TLS, sets the HSTS header, and forwards `X-Forwarded-{For,Proto,Host}` to nginx. nginx emits the rest of the defense-in-depth security headers (CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`). HSTS must NOT be duplicated on nginx (Caddy owns it).

The full `docker-compose.prod.yml` ships with this layout and can be brought up with:

```bash
HOST=pto.example.com \
ACME_EMAIL=ops@example.com \
SESSION_SECRET="$(openssl rand -base64 32)" \
CORS_ORIGIN=https://pto.example.com \
  docker compose -f docker-compose.prod.yml up -d
```

`HOST`, `ACME_EMAIL`, `SESSION_SECRET`, and `CORS_ORIGIN` are required; the process refuses to start without them (Caddyfile uses `{$HOST:localhost}` with a localhost fallback for dev, and `docker-compose.prod.yml` uses `${HOST:?HOST is required}` for prod).

A `npm run prod:config:check` script (see `infra/tests/prod-headers.test.mjs`) statically asserts that the configured headers, HSTS placement, `X-Forwarded-Proto`/`-Host` forwarding on every proxy_pass, the Caddy reverse-proxy + HSTS directives, and the inline-script CSP hash all line up — run it before any production deploy.

### 1. Provision a Postgres instance

Any Postgres 14+ works. Record the connection string in `DATABASE_URL`.

```bash
createdb pto
```

### 2. Build the workspaces

```bash
npm ci
npm run prisma:generate
npx prisma migrate deploy --schema=backend/prisma/schema.prisma
npm run db:seed
npm run build
```

This produces `backend/dist/` (Node service) and `frontend/dist/` (static SPA).

### 3. Start the backend in production mode

For a brand-new production database, run `npm run db:bootstrap` once (instead of `npm run db:seed`) to create the single team lead with a one-time setup link. The script reads `LEAD_EMAIL` (required), optional `LEAD_NAME` / `LEAD_COLOR_CODE` / `APP_PUBLIC_BASE_URL` (or `--base-url` flag), and prints the setup link to stdout. Idempotent: if the lead already has a password, it's a no-op; if the lead exists with no password, it regenerates the token and prints the new link. See [`backend/prisma/bootstrap.ts`](backend/prisma/bootstrap.ts) for the exact contract.

```bash
LEAD_EMAIL=lead@yourcompany.com \
APP_PUBLIC_BASE_URL=https://pto.yourcompany.com \
  npm run db:bootstrap
# prints: https://pto.yourcompany.com/setup-account?token=...
```

Configure the rest of the environment from `backend/.env.example`:

| Variable                 | Production value                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`               | `production` (required)                                                                                                               |
| `PORT`                   | `3000`                                                                                                                                |
| `DATABASE_URL`           | `postgresql://user:pass@host:5432/pto`                                                                                                |
| `SESSION_SECRET`         | `openssl rand -base64 32` (≥32 chars, high entropy; comma-separated values are accepted for graceful key rotation)                    |
| `COOKIE_SECURE`          | `true` (required in production)                                                                                                       |
| `COOKIE_DOMAIN`          | API host (e.g., `api.pto.internal.example.com`)                                                                                       |
| `CORS_ORIGIN`            | SPA origin (e.g., `https://pto.internal.example.com`)                                                                                 |
| `BCRYPT_ROUNDS`          | `12` (minimum `10` enforced in production; tests use `4`)                                                                             |
| `AUTH_USER_CACHE_TTL_MS` | `15000` (15s) — how long `requireAuth` caches the live (id, role) record per session user before re-validating against the DB         |
| `TRUST_PROXY_HOPS`       | `2` in production (Caddy → nginx → backend); `0` in dev/test. Used by `app.set('trust proxy', N)` and the rate-limiter `keyGenerator` |
| `LOG_LEVEL`              | `info`                                                                                                                                |
| `RATE_LIMIT_WINDOW_MS`   | `900000` (15 min) — global limiter window                                                                                             |
| `RATE_LIMIT_MAX`         | `100` — global requests per window per IP                                                                                             |
| `AUTH_RATE_LIMIT_MAX`    | `5` — failed-login attempts per window per IP                                                                                         |

`SESSION_SECRET` and `COOKIE_SECURE` are validated at boot. The process refuses to start in production with a placeholder, low-entropy, or short `SESSION_SECRET`, or with `COOKIE_SECURE=false`. Multiple comma-separated keys enable key rotation (the new key signs, older keys verify). Generate a fresh secret with `openssl rand -base64 32`.
| `SHUTDOWN_TIMEOUT_MS` | `10000` — graceful shutdown deadline before force-exit |
| `READY_TIMEOUT_MS` | `5000` — `/ready` DB probe race timer |

```bash
cd backend
node dist/index.js
```

The server now exposes the API at `/health`, `/ready`, `/auth/*`, and `/pto/*`.

### 4. Reverse proxy

The shipped Caddyfile + nginx.conf implement the Caddy → nginx → backend layout. To customize, edit the Caddyfile (`{$HOST}` and `{$ACME_EMAIL}` are required), then `docker compose -f docker-compose.prod.yml up -d --build caddy nginx`. Run `npm run prod:config:check` after any change to validate the static config invariants.

Or Nginx:

```
server {
  listen 443 ssl;
  server_name pto.internal.example.com;

  location /auth/ { proxy_pass http://localhost:3000; }
  location /pto/  { proxy_pass http://localhost:3000; }
  location /health { proxy_pass http://localhost:3000; }
  location /ready  { proxy_pass http://localhost:3000; }
  location /      { root /srv/pto/frontend/dist; try_files $uri /index.html; }
}
```

For a single-host deployment, point `VITE_API_BASE_URL` at the empty string at build time and serve the SPA at `/`. For a split-host setup, set `VITE_API_BASE_URL` to `https://api.pto.internal.example.com` and let the SPA call the API directly (CORS + `credentials: 'include'` is wired in the backend and the Vite dev proxy).

### 5. Backup

`prisma migrate deploy` is the schema entry point; row-level backups via `pg_dump` are recommended. The audit log grows monotonically — set a retention policy if storage is a concern.

### CI verification

The `build` and `e2e` jobs in `.github/workflows/ci.yml` run against an ephemeral Postgres with the seeded users. If both are green, the artifact is production-ready.

## Confirmed Product Decisions

- PTO is informational only; no approval workflow for MVP
- Overlapping PTO entries for the same user are not allowed
- Weekends are displayed in the calendar and count as part of continuous multi-day PTO, but PTO cannot start or end on a weekend
- Public holidays are out of scope for MVP
- PTO notes are visible only in the `PTOViewModal` (the calendar list and the day chips never display the note body); the detail endpoint returns the note for the owner or a team lead
- Multiple team leads are supported
- Audit logging is included in MVP and stored internally only
- Calendar PTO data is fetched for the full visible grid range, including adjacent-month days
- Dark mode is class-based via Tailwind v4 `@custom-variant dark`; a tiny pre-paint script in `index.html` applies the `.dark` class to `<html>` to avoid FOUC when the system prefers dark
- Production hardening (helmet, rate limiting, request logging with `X-Request-Id`, graceful shutdown, liveness `/health` + readiness `/ready`, shared Zod schemas, centralized `canViewNote`) is in scope and shipped for MVP — see `docs/technical-spec.md` §13 and `docs/backlog.md` Epic 6 for the full list

## Deliverables in This Repo

- Product planning document
- Technical specification
- SQL schema
- API contract
- Delivery backlog
- Testing and automation strategy

## Optional Next Artifacts

- Wireframes or low-fidelity mockups (not currently tracked; design is encoded directly in the Tailwind v4 `@theme` tokens and the component library)
- Architecture diagram (the runtime topology is two artifacts behind a reverse proxy — see `## Production Deployment`)
- ER diagram (the schema is in `docs/schema.sql` and `backend/prisma/schema.prisma`)
- Postman / Insomnia collection (the OpenAPI contract at `docs/openapi.yaml` is the source of truth; importable into either tool)
- Seed data script (already shipped as `npm run db:seed -w backend`; idempotent and re-runnable)
- Storybook for the frontend component library
