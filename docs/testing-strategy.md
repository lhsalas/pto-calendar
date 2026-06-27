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

| Path | Lines | Branches | Notes |
|---|---|---|---|
| `src/services/AuthorizationService.*` | 100% | 100% | Highest-risk surface |
| `src/services/pto/validation.*` | 100% | 100% | All PTO business rules |
| `src/services/pto/PTOService.*` | 80% | 80% | CRUD + overlap checks |
| `src/services/calendar/CalendarQuery.*` | 80% | 80% | Overlap SQL + expansion |
| `src/services/audit/AuditLogService.*` | 80% | 80% | Required for audit correctness |
| Other backend services | tracked | tracked | Reported, not blocking |
| Frontend critical pages (`pages/CalendarPage.tsx`) | 80% | tracked | Reported and blocking |
| Frontend critical components (`components/pto/PTOFormModal.tsx`, `components/calendar/DayCell.tsx`) | 80% | tracked | Reported and blocking |
| Other frontend | tracked | tracked | Reported, not blocking |

A PR fails if coverage on a **blocking** path drops below its threshold.

## 6. Backend Test Conventions

### 6.1 Unit tests
- Cover pure functions and helpers: `validatePtoPayload`, `canModifyPTO`, `expandPTOToDates`, `isWeekend`, `normalizeDayPart`.
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

### 8.3 Configuration
- `playwright.config.ts` uses a `webServer` block that boots the backend and frontend in test mode.
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
- Local: `docker compose up -d db` for developers; document in `README.md`.
- Prisma migrations run on test setup. Assumes the baseline migration has been generated and committed under `backend/prisma/migrations/` before the first integration test run (see `plan.md` Phase 0). CI runs `prisma migrate deploy`, never `migrate dev`.
- `TRUNCATE pto_requests, audit_logs RESTART IDENTITY CASCADE;` between tests (keep `users` seeded once). The seed script itself must be **idempotent including password hashes** — re-running it updates each user's `passwordHash` to match the seed definition, so test fixtures stay reproducible across re-seeds.

### 9.3 Frontend mocking
- MSW handlers mirror `openapi.yaml` response shapes.
- Reuse handlers between component tests and Storybook (post-MVP).

## 10. CI/CD Automation (GitHub Actions)

### 10.1 Pipeline layout
Single workflow file: `.github/workflows/ci.yml`.

Jobs (run in order, with `needs:` dependencies):

| # | Job | Runs on | Needs | Steps |
|---|---|---|---|---|
| 1 | `lint` | ubuntu-latest | — | install, eslint, prettier check |
| 2 | `typecheck` | ubuntu-latest | — | install, `tsc --noEmit` (backend + frontend) |
| 3 | `test-backend-unit` | ubuntu-latest | — | vitest run backend unit suite |
| 4 | `test-backend-integration` | ubuntu-latest + postgres service | — | vitest run backend integration suite, coverage |
| 5 | `test-frontend` | ubuntu-latest | — | vitest run frontend, coverage |
| 6 | `build` | ubuntu-latest | lint, typecheck | build backend + frontend |
| 7 | `e2e` | ubuntu-latest + postgres service | build | playwright install, playwright test, upload trace/video on failure |
| 8 | `coverage-gate` | ubuntu-latest | 4, 5 | enforce thresholds; post coverage diff as PR comment |

### 10.2 Triggers
- `pull_request` to `main`: full pipeline.
- `push` to `main`: full pipeline + build production images (post-MVP).
- `schedule`: nightly cron at 02:00 UTC — full E2E + coverage trend (post-MVP).

### 10.3 Caching
- Cache `node_modules` and Playwright browsers keyed on lockfile hashes.

### 10.4 Required status checks
`lint`, `typecheck`, `test-backend-unit`, `test-backend-integration`, `test-frontend`, `e2e`, `coverage-gate` must all pass before merge to `main`.

### 10.5 Secrets
- `DATABASE_URL` for the Postgres service container (set per job, never from repo secrets).
- No real user data in CI; seed only.

## 11. Pre-commit & Local Hooks

- `lint-staged` runs ESLint + Prettier on staged files.
- `husky` pre-commit hook invokes `lint-staged`.
- Local `npm run test:ci` mirrors CI jobs for fast feedback.

### npm scripts (to be added)
```
"test":            "vitest run"
"test:watch":      "vitest"
"test:coverage":   "vitest run --coverage"
"test:e2e":        "playwright test"
"test:ci":         "npm run lint && npm run typecheck && npm run test:coverage && npm run test:e2e"
"lint":            "eslint ."
"format":          "prettier --write ."
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