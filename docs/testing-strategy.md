# PTO / Vacation Calendar App — Testing & Automation Strategy

## 1. Purpose
This document defines the testing and automation strategy for the PTO calendar MVP. It complements the high-level testing references in `plan.md` §14, `technical-spec.md` §14, and the quality stories in `backlog.md` Epic 5 by specifying tooling, test data, coverage targets, CI/CD automation, and merge policy.

## 2. Quality Goals
- Permission rules are never bypassed (authorization is the highest-risk surface).
- Calendar rendering is correct for every supported edge case (single-day half-day, multi-day crossing weekend, overlapping attempts, adjacent-month bleed).
- The team can refactor backend services with confidence that regressions are caught automatically.
- The MVP is deployable to an internal environment with a single command.

## 3. Test Pyramid

```
       /\
      /  \      E2E (Playwright) — small, focused on critical journeys
     /----\
    /      \    Integration (Vitest + Supertest + ephemeral Postgres)
   /--------\
  /          \  Component (Vitest + React Testing Library)
 /------------\
/              \  Unit (Vitest) — pure logic, no I/O
```

## 4. Tooling Matrix

| Layer | Framework | Notes |
|---|---|---|
| Backend unit | Vitest | Matches Vite/TS stack; faster than Jest |
| Backend integration | Vitest + Supertest | Boots Express app in-process |
| Frontend unit/component | Vitest + React Testing Library | `@testing-library/user-event` for interactions |
| API mocking in component tests | MSW | Reuses OpenAPI schemas where possible |
| E2E | Playwright | Strong cookie/session support, trace viewer, cross-browser |
| Coverage | c8 (via Vitest) | `text`, `lcov`, `json-summary` reporters |
| Lint | ESLint | TypeScript + React plugins |
| Format | Prettier | Hooked via lint-staged |
| Type check | `tsc --noEmit` | Backend and frontend in CI |
| Mutation (post-MVP) | Stryker | Optional, not enforced for MVP |

## 5. Coverage Targets

Coverage is enforced on PRs via CI. Thresholds are set in `vitest.config.ts`.

| Path | Lines | Branches | Functions | Statements | Notes |
|---|---|---|---|---|---|
| `src/services/authorization/**` | 100% | 100% | 100% | 100% | Highest-risk surface; centralized note-visibility + modification logic |
| `src/services/pto/validation.ts` | 100% | 100% | 100% | 100% | All PTO business rules |
| `src/services/pto/schemas.ts` | 100% | 100% | 100% | 100% | Shared Zod schemas (route ↔ validation) |
| `src/services/auth/schemas.ts` | 100% | 100% | 100% | 100% | Shared Zod login schema |
| `src/services/auth/**` | 100% | 100% | 100% | 100% | `AuthService` + login schema |
| `src/services/users/**` | 100% | 100% | 100% | 100% | `UserService` |
| `src/middleware/requireAuth.ts` | 100% | 100% | 100% | 100% | Auth gate |
| `src/middleware/cookieSession.ts` | 80% | 80% | 80% | 80% | Cookie-session factory |
| `src/middleware/errorHandler.ts` | 80% | 80% | 80% | 80% | Centralized error formatter |
| `src/lib/lifecycle.ts` | 100% | 100% | 100% | 100% | Graceful shutdown (signal handlers + drain + force-exit) |
| `src/services/pto/PTOService.ts` | 90% | 80% | 90% | 90% | CRUD + overlap checks; create/overlap paths have direct unit coverage |
| `src/services/calendar/CalendarQuery.ts` | 80% | 80% | 80% | 80% | Overlap SQL + expansion |
| `src/services/audit/AuditLogService.ts` | 80% | 80% | 80% | 80% | Required for audit correctness |
| Other backend services | tracked | tracked | tracked | tracked | Reported, not blocking |
| Frontend critical pages (`pages/CalendarPage.tsx`) | 80% | tracked | tracked | tracked | Reported and blocking |
| Frontend critical components (`components/pto/PTOFormModal.tsx`, `components/calendar/DayCell.tsx`) | 80% | tracked | tracked | tracked | Reported and blocking |
| Other frontend | tracked | tracked | tracked | tracked | Reported, not blocking |

Note: `lib/rateLimit.ts` is excluded from coverage entirely (factory wrapper around `express-rate-limit`; no branching logic to test).

> **Coverage partition (single source of truth).** Each backend source file is gated by exactly one coverage config. Service-layer files (`lib/lifecycle.ts`, `services/pto/**`, `services/audit/**`, `services/calendar/**`) are measured by the **unit** run (`backend/vitest.config.ts`) and excluded from the integration config because their branches (SIGTERM/SIGINT handlers, Zod validation, audit `listForEntity`, calendar SQL) are either unsafe to exercise via real HTTP requests or duplicated by the unit suite. HTTP routes + `lib/rateLimit.ts` are measured by the **integration** run (`backend/vitest.integration.config.ts`) and excluded from the unit config because they require a live Prisma + Express stack to exercise meaningfully. The PR-comment coverage summary aggregates only the integration partition; per-file thresholds inside each config are the real gate.

A PR fails if coverage on a **blocking** path drops below its threshold.

## 6. Backend Test Conventions

### 6.1 Unit tests
- Cover pure functions and helpers: `validatePtoPayload`, `canModifyPTO`, `canViewNote` (note-visibility helper that delegates to `canModifyPTO`), `createPto`, `findOverlapping`, `expandPTOToDates`, `isWeekend`, `normalizeDayPart`.
- Cover every shared Zod schema in `services/pto/schemas.ts` and `services/auth/schemas.ts` with accept/reject path tests (schemas are the contract between routes and the validation layer).
- Cover the middleware layer (`cookieSession`, `errorHandler`, `requireAuth`) at the unit level by mocking the relevant module boundaries — these are no longer covered only transitively through the server test.
- Cover `lib/lifecycle.ts` (`installShutdown` + `shutdown`) directly: SIGTERM/SIGINT drain path, uncaughtException/unhandledRejection force-exit path, `SHUTDOWN_TIMEOUT_MS` grace timer via `vi.useFakeTimers`, `prisma.$disconnect` rejection path, and `server.closeAllConnections()` (Node 18+) guard.
- No DB or network access.
- Use table-driven tests for boundary cases.
- Tests must not mutate `process.env` directly without restoring it. Cache env state via `beforeAll`/`afterAll` (capture the original values, set required vars in `beforeAll`, restore originals in `afterAll`), calling `resetEnvForTests()` (or the equivalent env-cache reset helper) after setting and after restoring so the `loadEnv()` cache doesn't leak between files. This prevents one test file's env from influencing another's cached configuration.

### 6.2 Integration tests
- Spin up an ephemeral PostgreSQL container per CI job (GitHub Actions service container).
- Apply Prisma migrations on test setup.
- Reset between tests with `TRUNCATE ... CASCADE`.
- Use Supertest to hit Express routes with a real session cookie.
- Cover at minimum:
  - Authenticated member creates own PTO
  - Member edits/deletes own PTO
  - Member cannot edit/delete another user's PTO (403)
  - Team lead edits/deletes another user's PTO (200/204)
  - Unauthenticated requests return 401
  - State-changing requests from an untrusted Origin return `403 CSRF_REJECTED`
  - Same-day PTO without `dayPart` is rejected
  - Multi-day PTO is normalized to `all_day`
  - PTO starting or ending on a weekend is rejected
  - Multi-day PTO crossing a weekend is accepted and persisted
  - Overlapping PTO for the same user is rejected (409)
  - Visible-range endpoint returns only overlapping PTOs
  - Audit log entry is written for every update and delete

### 6.3 Authorization tests
- One parameterized test per role × action matrix cell (member, team_lead) × (own PTO, other's PTO).

## 7. Frontend Test Conventions

### 7.1 Component tests
- Test components in isolation with React Testing Library.
- Mock API with MSW handlers that mirror `openapi.yaml`.
- Cover at minimum:
  - `LoginPage` shows error on invalid credentials
  - `CalendarPage` loads current month by default
  - `CalendarHeader` prev/next buttons dispatch correct month change
  - `DayCell` renders PTO chips with user color and day-part label
  - `PTOFormModal` toggles day-part selector on same-day range
  - `PTOViewModal` shows edit/delete only when allowed
  - `Delete` action requires confirmation
  - Submitting an invalid range shows validation error inline

### 7.2 Accessibility checks (post-MVP)
- `axe-playwright` smoke check on `LoginPage` and `CalendarPage`.

## 8. End-to-End Tests (Playwright)

### 8.1 Scope
Keep the E2E suite small and focused on critical user journeys. Heavy logic coverage belongs in integration tests.

### 8.2 Critical journeys
1. **Login flow**: seeded member logs in, lands on calendar, sees their previous month PTO.
2. **Create single-day PTO**: select date, pick `morning`, save, see chip on correct day with correct color.
3. **Create multi-day PTO**: select Mon–Fri range, save, see chips across all weekdays.
4. **Reject weekend start**: attempt to start on Saturday, see inline error, request not sent.
5. **Reject overlap**: create a PTO that conflicts with an existing one, see 409 surfaced as error.
6. **Edit own PTO**: open detail, change date, save, see update reflected.
7. **Delete own PTO**: open detail, confirm, see entry removed.
8. **Permission enforcement**: member sees no edit/delete on another member's PTO; team lead does.
9. **Month navigation**: prev/next buttons refetch and update grid.

Additional shipped journeys (frontend enhancements #18–#26):
- **Default start date** (`e2e/default-start-date.spec.ts`): create modal pre-fills with the 1st of the viewed future month (or today for current/past month) in grid view, and today in list view.
- **Click-to-create** (`e2e/click-to-create-pto.spec.ts`): clicking a weekday cell in grid view opens the create modal pre-filled with that day; weekend cells are non-interactive; chip clicks bubble-stop to the view modal.
- **Today highlight** (`e2e/critical-journeys.spec.ts`): today's cell is rendered with a filled accent circle on the day number, and the "Today" nav button is disabled on the current month.
- **List view** (`e2e/list-view.spec.ts`): list mode shows today through today + 90 days, grouped by month; 90-day window shifts with Next/Previous/Today.
- **Focus rings** (`e2e/focus-rings.spec.ts`): Tab focus produces a visible `box-shadow` ring on inputs, buttons, chips, calendar cells, and the modal close button.
- **Mobile smoke** (`e2e/mobile-smoke.spec.ts`): 375px viewport — page padding shrinks, header wraps, calendar scrolls inside its own container with a sticky weekday header, modal opens and locks body scroll, ≥44px tap targets.
- **Dark mode** (`e2e/dark-mode.spec.ts`): System theme resolves correctly and toggling persists across reloads with no FOUC.
- **Favicon** (`e2e/smoke.spec.ts`): `<link rel="icon">` href ends with `/favicon.svg`.
- **Admin users surface** (`e2e/admin-users.spec.ts`, chromium-only): the team-lead link from the calendar reaches `/admin/users`, the user list renders, "Create user" surfaces the one-time setup link, and the "Back to calendar" link returns to the calendar. The spec cleans up created users in `test.afterAll` via `PrismaClient` using the `e2e-admin-users-` email prefix.

### 8.3 Configuration
- `playwright.config.ts` uses a `webServer` block that boots only the Vite frontend (`npx vite` on :5173). The backend is started separately by CI (via `npm run dev -w backend` in the background, polling `/health`) and locally via `npm run dev` + the backend already running on :3000.
- Two projects:
  - `chromium` (Desktop Chrome) — runs every `e2e/*.spec.ts` and is the only project that drives state-changing flows (create/edit/delete PTO).
  - `mobile-chrome` (Pixel 5) — `testMatch` is whitelisted to `e2e/mobile-smoke.spec.ts`, `e2e/focus-rings.spec.ts`, and `e2e/smoke.spec.ts` only. The whitelist keeps the mobile run from racing against desktop tests that share the dev `pto` database (since the mobile project reuses the same DB).
- `workers=1` in CI to keep the shared Postgres deterministic; locally the default worker count is used.
- Reuses seeded fixtures from `tests/fixtures/`.
- Auth state stored in `storageState` to skip re-login between tests within a file.
- Trace + video captured on failure, uploaded as CI artifacts.

## 9. Test Data Strategy

### 9.1 Fixtures
- `tests/fixtures/users.ts` — seeded users (one `team_lead`, one `member`) with known bcrypt hashes.
- `tests/fixtures/pto.ts` — sample PTOs covering: single-day morning, single-day evening, single-day all_day, multi-day, multi-day crossing a weekend, conflict attempt.
- `tests/fixtures/calendar.ts` — visible grid ranges including adjacent-month bleed.

### 9.2 Database lifecycle
- CI: GitHub Actions service container `postgres:16` with health check.
- Local: `npm run db:up` (calls `node bin/container.mjs compose up -d db`, auto-detects podman or docker) for developers; the dev compose file is `docker-compose.yml` and is documented in `README.md`
- Local: `npm run app:up` (calls `node bin/container.mjs compose -f docker-compose.app.yml up --build`) for the development-only all-in-one stack (db + migrate + backend + frontend, only localhost port 5173) when a contributor has Docker or Podman but not Node.js — exercise this path before merge when the all-in-one compose changes. See `docs/podman.md` for the Podman-specific notes
- CI: `docker-smoke` job in `.github/workflows/ci.yml` runs `docker compose -f docker-compose.app.yml up --build -d` directly (GitHub Actions runners ship with Docker; no `bin/container.mjs` wrapper needed), polls `/health` for up to 90 s, logs in as `lead@example.com`, asserts `GET /holidays/all` returns the expected US/MX/CO/CL counts (proves the auto-seed via `seedHolidays.ts --all` worked), and asserts `POST /holidays/seed {"countryCode":"CO"}` returns `{inserted:0, skipped:42, errors:[]}` (proves the runtime JSON-asset bundling works in the production backend binary). Always tears down with `down -v` even on failure.
- Playwright's `cleanupCreatedUsers()` helper (`frontend/e2e/admin-users.spec.ts`) reads `DATABASE_URL` first and falls back to `postgresql://pto:pto@localhost:5432/pto_test?schema=public`. The `npm run test:e2e -w frontend` script prepends `DATABASE_URL=…/pto_test…` so a fresh local clone Just Works (CI does the same via the job's `env:` block). The hardcoded fallback deliberately points at `pto_test`, not `pto` (the dev DB), so a missing env var doesn't silently target the wrong DB.
- Prisma migrations run on test setup. Assumes the baseline migration has been generated and committed under `backend/prisma/migrations/` before the first integration test run (see `plan.md` Phase 0). CI runs `prisma migrate deploy`, never `migrate dev`.
- `TRUNCATE pto_requests, audit_logs RESTART IDENTITY CASCADE;` between tests (keep `users` seeded once). The seed script itself must be **idempotent including password hashes** — re-running it updates each user's `passwordHash` to match the seed definition, so test fixtures stay reproducible across re-seeds.

### 9.3 Frontend mocking
- MSW handlers mirror `openapi.yaml` response shapes.
- Reuse handlers between component tests and Storybook (post-MVP).

## 10. CI/CD Automation (GitHub Actions)

### 10.1 Pipeline layout

The test gate is `.github/workflows/ci.yml`. Production deployment is kept in
separate workflows so the CI gate never receives production credentials. The
OCI tag workflow (`deploy-oci.yml`) is gated by CI through the
`workflow_run` trigger (it fires when the CI workflow completes for a tag
push); the `push: tags` and `workflow_dispatch` triggers are retained as
fallbacks. The GCP/Firebase workflows are manual-only fallbacks.

Jobs (run in order, with `needs:` dependencies):

| # | Job | Runs on | Needs | Steps |
|---|---|---|---|---|
| 1 | `lint` | ubuntu-latest | — | install, eslint, prettier check |
| 2 | `typecheck` | ubuntu-latest | — | install, `tsc --noEmit` (backend + frontend) |
| 3 | `test-backend-unit` | ubuntu-latest | — | vitest run backend unit suite |
| 4 | `test-backend-integration` | ubuntu-latest + postgres service | — | vitest run backend integration suite, coverage |
| 5 | `test-frontend` | ubuntu-latest | — | vitest run frontend, coverage |
| 6 | `build` | ubuntu-latest | lint, typecheck | build backend + frontend |
| 7 | `deployment-config` | ubuntu-latest | lint, typecheck | validate Firebase/GCP fallback configuration, OCI Compose/Caddy headers, deployment scripts, workflow guards, and supply-chain pins |
| 8 | `e2e` | ubuntu-latest + postgres service | build | playwright install, playwright test, upload trace/video on failure |
| 9 | `docker-smoke` | ubuntu-latest | build | start the all-in-one compose stack, poll `/health`, login + validate auto-seeded holidays + validate the seed endpoint, tear down with `-v` |
| 10 | `coverage-gate` | ubuntu-latest | 4, 5 | enforce thresholds; post coverage diff as PR comment |

### 10.2 Triggers
- `pull_request`: full pipeline.
- `push` to `master`: full pipeline.
- `push` of a semver `v*.*.*` tag: full pipeline for release gating.
- Supabase backups run in the separate `database-backup.yml` workflow.

### 10.3 Caching
- Cache `node_modules` and Playwright browsers keyed on lockfile hashes.

### 10.4 Required status checks
`lint`, `typecheck`, `test-backend-unit`, `test-backend-integration`,
`test-frontend`, `deployment-config`, `e2e`, `docker-smoke`, and
`coverage-gate` must all pass before merge to `master`.

### 10.5 Secrets
- `DATABASE_URL` for the Postgres service container (set per job, never from repo secrets).
- OCI deployment uses protected-environment values `OCI_HOST`,
  `OCI_DEPLOY_USER`, `OCI_KNOWN_HOSTS`, and `OCI_SSH_PRIVATE_KEY`; the OCI
  workflow has no OIDC permission.
- No real user data in CI; seed only.

## 11. Pre-commit & Local Hooks

- `lint-staged` runs ESLint + Prettier on staged files.
- `husky` pre-commit hook invokes `lint-staged`.
- Local `npm run test:ci` mirrors CI jobs for fast feedback.

### npm scripts
```
"test":            "vitest run"
"test:watch":      "vitest"
"test:coverage":   "vitest run --coverage"
"test:e2e":        "playwright test"
"test:ci":         "npm run lint && npm run typecheck && npm run test:coverage && npm run test:e2e"
"lint":            "eslint ."
"format":          "prettier --write ."
"prod:config:check": "node infra/tests/prod-headers.test.mjs"
"deploy:scripts:check": "node infra/tests/deploy-scripts.test.mjs"
```

## 12. Reporting & Artifacts

- Coverage uploaded as `lcov`; CI posts a Markdown diff comment on PRs.
- Playwright `trace.zip`, `video.webm`, and `junit.xml` uploaded on failure.
- JUnit reports surfaced in the GitHub Actions UI summary.
- Nightly coverage trend stored as artifact (post-MVP).

## 13. Test Categorization Backlog (mapped to `backlog.md`)

| Backlog Story | Test requirement |
|---|---|
| 1.1 Login | E2E journey #1; component test for `LoginPage`; integration test for `/auth/login` |
| 1.2 Roles | Unit test for role helper; integration test for `/auth/me` returning role |
| 2.1 Create PTO | E2E #2, #3; integration tests for create + weekend + overlap |
| 2.2 Single-day half-day | E2E #2; component test for day-part toggle; unit test for `normalizeDayPart` |
| 2.3 Multi-day | E2E #3, #4; integration test for weekend-mid-range; unit test for `expandPTOToDates` |
| 2.4 Edit own | E2E #6; integration test for owner update |
| 2.5 Delete own | E2E #7; integration test for owner delete |
| 3.1 Calendar view | E2E #1; component test for `CalendarPage` |
| 3.2 Month navigation | E2E #9; component test for `CalendarHeader` |
| 3.3 Color coding | Component test for `DayCell` color binding |
| 4.1 Team-lead override | E2E #8; integration test for team-lead update/delete of others |
| 4.2 Non-owner protection | E2E #8; integration test for 403 cases |
| 4.3 Auth required | Integration test for 401 on all PTO endpoints |
| #18 Default start date | E2E `default-start-date.spec.ts` |
| #19 Click weekday to create | E2E `click-to-create-pto.spec.ts` |
| #21 Today highlight | E2E `critical-journeys.spec.ts` (today cell) |
| #22 Design tokens | Smoke-rendered component tests (no separate spec) |
| #23 Mobile a11y + modal a11y | E2E `mobile-smoke.spec.ts` (Pixel 5); unit tests for `useModalA11y` (8) |
| #24 Editorial palette + motion | E2E `dark-mode.spec.ts`; visual assertions via chip color sampling |
| #25 Focus rings | E2E `focus-rings.spec.ts` (chromium + mobile-chrome) |
| #26 Favicon | E2E `smoke.spec.ts` (link tag check) |
| #28 B1 Helmet + rate limit | Unit test for helmet header set; integration test for 429 on login; env override used in CI |
| #31 B2 Graceful shutdown | Unit test for `lib/lifecycle.ts` (10 tests): SIGTERM/SIGINT, uncaughtException, fake-timer timeout |
| #33 B3 `/health` + `/ready` | Integration tests in `server.test.ts` (7): success, DB throw, DB hang, warning log, autologging skip |
| #29 B4 Request logging | Integration tests in `server.test.ts` (7): `X-Request-Id` echo, inbound passthrough, structured line per request |
| #30 B5 `canViewNote` | Integration test for note redaction when requester is neither owner nor team lead |
| #32 B6 Shared Zod schemas | Unit tests for `services/pto/schemas.ts` (11) + `services/auth/schemas.ts` (4) |
| #34 B7 Middleware unit coverage | Unit tests for `middleware/cookieSession.ts` (5) + `errorHandler.ts` (5) + `requireAuth.ts` (4) |
| #27 B8 `PTOService` create + overlap unit coverage | Unit tests for `createPto` + `findOverlapping` in `PTOService.test.ts` (10 new tests) |

## 14. Flaky-Test Policy

- Any test that fails twice in a 14-day window is quarantined (skipped with a tracking issue) until fixed.
- Playwright tests must not depend on time-of-day; always pass explicit dates.
- No `sleep` calls in tests; use Playwright auto-waiting and `expect.poll` for async assertions.

## 15. Out of Scope for MVP

- Performance/load testing.
- Mutation testing (Stryker).
- Visual regression testing.
- Contract testing against `openapi.yaml` (the OpenAPI spec is treated as documentation; integration tests validate actual behavior).
- Accessibility audits beyond an `axe` smoke check.

## 16. Open Decisions

- None for MVP. All tooling choices above are confirmed.
