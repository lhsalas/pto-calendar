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
| Coverage | `@vitest/coverage-v8` | `text`, `lcov`, `json-summary` reporters |
| Lint | ESLint | TypeScript + React plugins |
| Format | Prettier | Hooked via lint-staged |
| Type check | `tsc --noEmit` | Backend and frontend in CI |
| Mutation (post-MVP) | Stryker | Optional, not enforced for MVP |

React and React DOM use the same 19.x runtime line in the frontend and root
test dependency graph. Their type packages also share the 19.x line; component
tests must not resolve a second React runtime. Toast provider tests exercise
batched pushes, duplicate refresh, dismissal, eviction and expiry under Strict
Mode, including cleanup of timers on unmount.

## 5. Coverage Targets

Coverage targets are declared in `vitest.config.ts`. The backend unit CI job runs
`npm run test:coverage -w backend` and enforces its configured thresholds. Its
`backend-unit-coverage` artifact comes from `backend/coverage-unit`, separate
from integration's `backend-coverage` (`backend/coverage`) and frontend's
`frontend-coverage`. For local security changes, run that direct unit coverage
command with a fake test-only environment; a plain `npm test` does not enforce
the coverage thresholds.

**Known baseline diagnostic (2026-11-15):** the coordinator reproduced
`npm run test:coverage -w backend` failure on unchanged master `156cc6f` and the
documentation-only #246 candidate, with no backend/frontend/package/CI source
diffs. All **269 unit tests pass**, but authorization has **66.66% lines / 60%
branches**, user services **85.24% lines / 87.5% branches**, and `requireAuth`
**90% branches**, below declared 100% targets (other metrics also fail).
This was an additional diagnostic failure, **not a #235/#246 regression**.
#270 adds behavioral coverage and enables the unit coverage command in CI.
Passing integration/aggregate coverage does not substitute for unit thresholds.

The test toolchain is pinned to a supported, patched line: `vitest` and
`@vitest/coverage-v8` are on the matching 5.1.x line, `vite` is on the patched 8.3.x
line, and `concurrently` and `lint-staged` are on patched releases.

ESLint 10 runs the stable React Hooks 7 recommended rules, including compiler
diagnostics. The frontend keeps the previous core recommended-rule baseline;
the three unrelated core additions in ESLint 10 are not enabled by this
migration. Both workspaces use one ESLint version.

Both workspaces declare TypeScript `~6.0.3`, resolving one 6.0.x compiler.
This stays inside the existing typescript-eslint 8.72 peer range
(`>=4.8.4 <6.1.0`); TypeScript 7 remains blocked by Dependabot's `>=7`
ignore rule. Keep the strict compiler settings, NodeNext/backend and
Bundler/frontend module resolution, explicit global types, and backend build
`rootDir` unchanged. Do not suppress migration errors with `ignoreDeprecations`
or broaden `skipLibCheck`; the matcher declaration regression below must also
typecheck with `skipLibCheck: false`. See the
[TypeScript 6.0 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html)
for the changed compiler defaults.

Both the root and each workspace declare the runner and coverage provider.
Keep their versions aligned: `npm ls vitest @vitest/coverage-v8` must show a
single resolved version of each, with exactly matching runner/provider versions.
The root declarations keep the provider resolvable from the hoisted runner and
prevent a second Vitest copy from receiving the frontend's matcher augmentation.
`frontend/tests/setup.ts` registers the standalone jest-dom matchers with
`expect.extend`. `frontend/tests/vitest.d.ts` augments Vitest 5's `Matchers<R, T>`
interface because jest-dom 7.0.1's bundled adapter still uses the old
`Assertion<T>` interface. The frontend typecheck includes this declaration and
`vitestMatchers.test.ts`, which checks both synchronous (`void`) and asynchronous
(`Promise<void>`) matcher return types without loading the Jest-global types.

Vitest 4 removed `poolOptions`, so the integration suite uses the top-level
`fileParallelism: false` and `isolate: true` instead of the old
`poolOptions.forks.singleFork`. The specs share one database, so they must run
sequentially, and each file needs its own module registry so a file that
disconnects the shared Prisma client does not break the next one. The
integration config also sorts the spec files by path, because Vitest otherwise
orders them by cached duration, which differs between a workstation and CI.

Vitest 4's V8 coverage provider counts defensive fallback branches that an
earlier version did not. Those branches are covered by tests rather than by
relaxing a threshold: `usePtoList` has a dedicated spec that exercises the
non-`Error` fallback by mocking the API boundary, and the `AuthContext` and
`PTOViewModal` specs cover the remaining conditional paths.

| Path | Lines | Branches | Functions | Statements | Notes |
|---|---|---|---|---|---|
| `src/services/authorization/**` | 100% | 100% | 100% | 100% | Highest-risk surface; centralized note-visibility + modification logic |
| `src/services/tokens/**` | 100% | 100% | 100% | 100% | Token parsing, scopes, validity and lifecycle |
| `src/routes/tokens.ts` | 100% | 100% | 100% | 100% | Session-only credential-management HTTP adapter |
| `src/routes/auth.ts`, `src/routes/pto.ts` | 100% | 100% | 100% | 100% | Cookie/PAT identity and every PTO HTTP method |
| `src/middleware/patAuth.ts`, `src/middleware/csrf.ts` | 100% | 100% | 100% | 100% | Credential selection, rollout and verified-only CSRF exemption |
| `src/middleware/tokenManagement.ts` | 100% | 100% | 100% | 100% | Early no-store/session boundary and safe errors |
| `src/lib/logSanitizers.ts` | 100% | 100% | 100% | 100% | Correlation IDs, credential-path redaction and the HTTP logging pipeline |
| `src/lib/logRedaction.ts` | 100% | 100% | 100% | 100% | Credential-safe payload, message, argument and error scrubbing |
| `src/services/audit/**` | 100% | 100% | 100% | 100% | Attribution vocabulary, audit rows and native-transaction audit writes |
| `src/services/pto/validation.ts` | 100% | 100% | 100% | 100% | All PTO business rules |
| `src/services/pto/schemas.ts` | 100% | 100% | 100% | 100% | Shared Zod schemas (route ↔ validation) |
| `src/services/auth/schemas.ts` | 100% | 100% | 100% | 100% | Shared Zod login schema |
| `src/services/auth/**` | 100% | 100% | 100% | 100% | `AuthService` + login schema |
| `src/services/users/**` | 100% | 100% | 100% | 100% | `UserService` |
| `src/middleware/requireAuth.ts` | 100% | 100% | 100% | 100% | Auth gate |
| `src/middleware/cookieSession.ts` | 80% | 80% | 80% | 80% | Cookie-session factory |
| `src/middleware/errorHandler.ts` | 80% | 80% | 80% | 80% | Centralized error formatter |
| `src/lib/lifecycle.ts` | 100% | 100% | 100% | 100% | Documented target only; no explicit unit threshold is currently configured or enforced |
| `src/services/pto/PTOService.ts` | 90% | 80% | 90% | 90% | CRUD + overlap checks; create/overlap paths have direct unit coverage |
| `src/services/calendar/CalendarQuery.ts` | 80% | 80% | 80% | 80% | Overlap SQL + expansion |
| `src/services/audit/AuditLogService.ts` | 100% | 100% | 100% | 100% | Required for audit correctness; the whole `src/services/audit/**` directory is enforced at 100% |
| Other backend services | tracked | tracked | tracked | tracked | Reported, not blocking |
| Frontend critical pages (`pages/CalendarPage.tsx`) | 80% | tracked | tracked | tracked | Reported and blocking |
| Frontend critical components (`components/pto/PTOFormModal.tsx`, `components/calendar/DayCell.tsx`) | 80% | tracked | tracked | tracked | Reported and blocking |
| Other frontend | tracked | tracked | tracked | tracked | Reported, not blocking |

`lib/rateLimit.ts` is measured by integration coverage, including synthetic Redis
command tests that exercise the actual limiter and store without a Redis service.
These tests do not certify behavior against a real Redis deployment.

Token foundation tests include synthetic successful/failing persistence with
`DEBUG=prisma:client` and `DEBUG=*`, without opening a socket. They check that
native token operations do not expose a digest or raw token in diagnostics or
exception causes. Pool tests cover transaction isolation, rollback, release,
owned/borrowed cleanup and fail-closed errors. Written PostgreSQL tests cover
concurrent issuance, invalidation and UTC round-trips across process timezones;
these require a separate identity-verified disposable-database run before
claiming database-backed guarantees.

> **Coverage partition.** Service-layer files (`lib/lifecycle.ts`, `services/pto/**`, `services/audit/**`, `services/calendar/**`) are measured by the **unit** run (`backend/vitest.config.ts`) and excluded from integration. User/health/holiday routes and `lib/rateLimit.ts` remain measured by the **integration** run and excluded from unit coverage. Token/auth/PTO routers are deliberately included in both runs, each with a 100% unit floor. New route/security code is never blanket-excluded; the rollout schema lives in the instrumented auth service rather than excluded env wiring. Existing config/session-secret exclusions are unchanged. The sets are not strictly disjoint: for example, `lib/prismaClient.ts` and holiday services can appear in both reports. The PR-comment backend summary uses integration coverage only; configured path thresholds in each run are separate gates.

Token-management tests exercise all-role ownership, fresh password/version
proof, failed-auth limiting, bearer/mixed denial, CSRF, no-store and correlation
headers on parser/auth/limiter failures, show-once metadata/error redaction,
concurrent HTTP cap enforcement, reset/setup and application-owned pool cleanup.
Mocked in-process unit transport is separate from the disposable PostgreSQL
integration suite; written tests alone do not certify a database-backed result.

#252 adds three layers of audit evidence.

- **Unit** — `src/services/audit/auditContext.test.ts` pins the attribution
  vocabulary and the rule that a credential type is derived from verified
  server state; `src/services/audit/nativeAudit.test.ts` pins the native audit
  statement, the empty-batch no-op and the public-ID-only values;
  `src/services/audit/AuditLogService.test.ts` pins the stored attribution
  columns and the NULL fallbacks. `src/services/pto/PTOService.test.ts` and
  `src/services/tokens/tokenService.test.ts` pin that each mutation writes its
  audit row in the same transaction, that a denied or invalid change writes
  none, and that a repeated revocation writes no duplicate row.
- **Logger capture** — `src/lib/logRedaction.test.ts` covers the scrubbing
  helper, and `src/lib/logger.test.ts` builds pino from the **production**
  `LOGGER_OPTIONS` and `createPinoHttpOptions` and captures real output on the
  success, failure and debug paths: new credential field names, arbitrarily
  nested and cyclic shapes, passwords, `Authorization`, raw tokens, digests and
  setup-token hashes must never appear, while the fixed endpoint label and the
  safe correlation ID must survive. The regression cases are the production
  shapes that leaked before: a credential bound to a child logger at any depth,
  an error whose `name` carries a personal token, and a request- or
  error-shaped value interpolated into a message. The `pino-http` child is
  exercised through the same factory, so the request pipeline uses the
  credential-safe error serializer.
- **Integration (disposable PostgreSQL)** — `tests/integration/credentialAudit.test.ts`
  asserts the real rows: attribution columns, note-text absence, one row per
  public token ID, no row for a no-op, history that survives token deletion,
  legacy rows that are never backfilled, the CHECK constraints, and a
  constraint-trigger rollback that leaves no committed mutation and no audit
  row. It also drives the **real HTTP surface**: a cookie session and a
  verified personal token each produce a persisted row with the right
  credential type, source token ID, target owner and correlation ID, and a
  denied request produces none. Native mutations, credential-version changes
  and PTO update/delete each roll back when their audit row cannot be written,
  two independent native connections produce exactly one row per changed
  public ID, and a temporary custom schema proves that the quoted table names
  and the audit row live in the same schema and transaction. Every assertion is
  scoped to the generated fixture actors, owners and entities, and the
  temporary trigger and schema are always removed.
  `tests/integration/credentialLogging.test.ts` captures the **production**
  logger options through the real request pipeline and asserts that a submitted
  password, an `Authorization` credential and a rejected request body never
  reach a log line while the endpoint label and the correlation ID do. The file
  creates and clears audit rows in FK-safe order (audit rows before users).
  Written tests alone do not certify a database-backed result.

#253 adds three layers of quota evidence.

- **Unit** — `src/middleware/agentQuota.test.ts` pins the bounded policy and
  its defaults, the namespaced keys of every counter, the compensation of a
  verified attempt, the fail-closed behavior of an unavailable or uninitialised
  shared store, the rejection envelope with its `Retry-After`, draft-7 headers
  and correlation id, and the process-local counter's window and floor.
  `src/lib/rateLimit.test.ts` pins the shared connection lifecycle (one
  connection per store URL, released with the last application, a connection
  that cannot be closed cleanly) next to the existing address-key behavior.
  `src/middleware/patAuth.test.ts` proves that a repeated failed verification
  is refused **before** the credential lookup and that a verified secret is
  given its budget back; `src/middleware/requireAuth.test.ts` proves the
  verified-session traffic budget; `src/routes/tokens.test.ts` proves the
  issuance and issuance-password budgets, including that a rejected issuance
  writes neither a token row nor an audit row and that the password budget
  covers every verification rather than only the failed ones.
  `tests/unit/applicationCleanup.test.ts` pins the per-application cleanup:
  a repeated release must not take a connection another live application
  still owns. `tests/unit/rateLimitComposeConfig.test.ts` pins that every
  limiter value reaches the container as an explicit bounded operator
  override whose default equals the schema default.
- **Integration (disposable PostgreSQL)** — `tests/integration/agentQuota.test.ts`
  asserts the real HTTP behavior: two verified users behind one address keep
  independent budgets, two verified tokens of one owner keep independent token
  budgets, an invalid bearer flood stops before the credential lookup (proved
  through the untouched usage timestamp of a valid token), a verified secret
  never consumes the failure budget, issuance password failures are bounded
  without locking the browser login, the password budget bounds the bcrypt
  comparisons themselves (proved with a spy over the real comparison, so no
  further comparison runs once the budget is used, including after a request
  that was denied for its scope), token creation is bounded separately from
  ordinary reads, one owner budget stays apart from another owner and from
  ordinary reads, a budget restarts when its window elapsed, a rejection never
  exposes a credential or a store address and reports the remaining delay of
  the rejecting window, and an unavailable shared store fails closed instead of
  running unmetered.
- **Real-Redis certification** — `tests/integration/rate-limit-real-redis.test.ts`
  runs against an explicit disposable fixture (`RATE_LIMIT_TEST_REDIS_URL`).
  The file fails with a clear error when the fixture is missing; it never falls
  back to an ambient store, never uses a process-local substitute and never
  skips. It proves that the counter lives in the store (an independent
  connection reads and extends it), that two running application instances
  share one budget, that an application restart continues the same counter,
  that concurrent attempts are counted exactly once, and that the counter
  expires with its window. It also pins the compensation semantics against a
  real store: a compensation that is held across a window expiry leaves the
  new window's count and expiry untouched, the same attempt is compensated
  only once, and a compensation whose window is gone never creates a counter.
  Cleanup removes only the fixture's own keys. The CI backend-integration job
  starts an isolated Redis service and exports that fixture so the
  certification actually runs.

`scopedPatAuth.test.ts` adds the three-role × own/other × ten-scope-profile
matrix on list/detail/POST/legacy PUT/DELETE, including impossible member/team
credentials failing closed. Notes are checked on every note-bearing response.
It covers strict/duplicate/mixed credentials, default-deny routes and methods,
both rollout flags, cross-instance revocation/expiry/password/version/role
invalidation, an actual PostgreSQL missing-relation verifier failure, and
production-mode cookies/CSRF. Production tests substitute only Redis's
external store adapter with an in-memory store while retaining real limiters
and PostgreSQL; they do **not** certify real Redis. Pino output is captured at
trace level for HTTP credential-redaction checks, not every possible external
production diagnostic configuration.
Unit fixtures also exercise the shared parser at its browser and verified-PAT
positions, invalid bearer/mixed requests before parser errors and IP limiting,
and denied-request URL and correlation-ID redaction.

#255 adds unit coverage for query validation and signed cursors, plus a YAML
contract test for legacy arrays, bounded pages, and null-only list notes.
`pto-pagination.test.ts` uses disposable PostgreSQL to traverse 1,050
matching rows, verify pre-limit owner filtering and sort-key ties, and check
deletion or movement between pages. It also checks cursor errors and
correlation IDs, the 366-day bound, and note redaction across credential types.
The existing Chromium tests still exercise the unchanged browser response.

A coverage run fails if a **blocking** path falls below its configured threshold.
The local integration requirement remains All files lines ≥90%; the CI coverage
summary job currently checks report existence and publishes totals, not that
aggregate floor. Integration route thresholds remain enforced by its Vitest run.

## 6. Backend Test Conventions

### Express 5 migration baseline (#229)

Express **5.3.0**, body-parser **2.4.0** and Express types **5.0.6** replace the
4.x runtime/types together. The direct body-parser declaration stays aligned
with Express's compatible 2.x dependency; `express.json({ limit: '100kb' })`
remains the application's parser. That migration did not change route paths,
payloads, query-parser setting, limiter versions or middleware order; later PAT
selection defers that same parser only for Authorization requests. See the
[official migration guide](https://expressjs.com/en/guide/migrating-5.html).

`server.test.ts` characterizes the same HTTP outcomes before/after the upgrade:
missing/unsupported bodies produce 400 validation errors; malformed/oversized
JSON without Authorization retains the existing generic 500 envelope without a
request ID because parsing precedes logging. This documents the baseline, not a new parser-error
policy. Scalar/reordered range queries retain bounds/date validation; duplicate
and bracket-form required parameters remain invalid despite the framework's
simple query-parser default. Async rejection tests cover explicit `next(err)`
and Express 5 automatic forwarding with one JSON response and one error log.

Request-serializer and captured pino-http tests verify fixed URL labels and the
constant fallback for unknown or dynamic paths, including malformed and
multiply encoded synthetic PATs in denied requests. Logs must omit secrets,
authority, query and fragment without relying on route metadata.

`index.test.ts` invokes a mocked listen callback, never a real occupied port:
successful binding logs readiness; bind errors are rethrown into the already
installed fatal exception lifecycle and cannot log false readiness. Existing
lifecycle tests retain the nonzero fatal-exit contract. Password-reset integration
tests retain member/other-lead/sole-lead/self/unknown-user permissions, session
invalidation and audit coverage. The #237 note omission/clear/set and browser
regressions, #281 readiness tests, and all coverage thresholds remain unchanged.

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
- The shared rate-limit certification (#253) needs a disposable Redis as well:
  the integration suite reads the explicit fixture `RATE_LIMIT_TEST_REDIS_URL`
  and fails with a clear error when it is missing. It never falls back to an
  ambient store and never skips, so a local integration run must point that
  variable at a disposable Redis (CI starts an isolated service for it).
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
- **Own personal access tokens** (`e2e/token-settings.spec.ts`, chromium-only, 6 tests): a normal member reaches `/settings/tokens` through the calendar **API access** entry and is redirected to `/login` when signed out; issues a token through the dialog — the expiry default (90 days) is read after the form is open — and copies the one-time secret; sees the secret cleared when the dialog is dismissed and after navigating away and back; revokes one token (`Revoke <token name>`) and every token (`Revoke all tokens`) without being asked for a password; and a freshly issued token authorizes `GET /auth/me` with a bearer header and **no browser cookie** (200 before revocation, 401 after revoke-one and after revoke-all). The same spec covers the keyboard path (Tab to the revoke control, `Enter` to open the dialog, `Escape` to close it, focus returned to the trigger), the focus indicator on the focused control, and the page in dark mode at a 360 px viewport with a populated token list, checked for horizontal overflow the same way `e2e/mobile-smoke.spec.ts` does (`scrollWidth <= clientWidth + 1`). The local-target guards and their refusals are asserted in the same file; see §9.5.
- **Versioned PTO writes** (`e2e/critical-journeys.spec.ts`, chromium-only, 3 tests): a fresh edit and a fresh delete carry the expected version as one canonical quoted strong `If-Match` value (`"1"`, `"2"`, …) and the response carries the incremented version. A record that changed after the browser read it is refused: the stale update answers `412 STALE_WRITE`, is attempted exactly once (no silent retry), leaves the newer record untouched and is followed by an explicit recovery — reopening the form loads the current record. The stale delete answers `412 STALE_WRITE` as well and the record survives. The journeys use the real browser against the disposable development database; the direct fixture request is a controlled own request that always states the expected version, and it refuses to run against anything but a loopback origin. See §9.6.

### 8.3 Configuration
- `playwright.config.ts` uses a `webServer` block that boots only the Vite frontend (`npx vite` on :5173). The backend is started separately by CI (via `npm run dev -w backend` in the background, polling `/health`) and locally via `npm run dev` + the backend already running on :3000.
- The disposable E2E backend runs with `PAT_AUTH_ENABLED=true` and `PAT_WRITES_ENABLED=false`, set on the backend start step only. The token-settings spec depends on bearer authentication being enabled: it asserts that a freshly issued token authorizes `GET /auth/me` and is rejected with 401 once it is revoked. It never skips when a flag is unset — an unset flag fails the assertion instead.
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

MSW is on **3.0.6** (#228), following the
[official v3 migration guide](https://mswjs.io/docs/migrations/2.x-to-3.x).
The shared Node interceptor uses `onUnhandledFrame: 'error'`; do not replace it
with warnings, bypasses or catch-all responses. Match `/holidays` exactly,
without its query string, and read `new URL(request.url).searchParams` to verify
both range bounds independently of query ordering. `/holidays/all` remains a
separate administration route. `mswSetup.test.ts` covers default matching,
unhandled API rejection and override reset; calendar tests retain the 42-cell
render and PTO/holiday navigation-range assertions.

The installed MSW 3.0.6 metadata requires Node >=22.12 and optional TypeScript
>=5.9/Vite >=6 peers, met by Node 24.22.3, TypeScript 6.0.3 and Vite 8.3.4.
Vitest's 5.1.0 mocker accepts MSW `^2.4.9 || ^3.0.0`; React remains 18.
Root `http`/`HttpResponse` exports are still present in published 3.0.6, so this
migration preserves those imports and existing handler bodies/set. No Vite
plugin or browser worker is introduced; keep #227's matcher setup and coverage
targets unchanged.

### 9.4 Parallel issue work: exclusive disposable-test lease

For the [approved #246 execution plan](agent-access-delivery-plan.md), worktrees
do **not** isolate DBs, ports, Compose container names or volumes. Shared-service
integration/E2E/Docker gates and any migrations/truncation/teardown need an
exclusive coordinator-issued disposable-test lease: holder, commit/worktree,
verified non-production DB/service targets, reset scope and cleanup/release.
Never infer the target from a default `.env` or a test script's DB fallback.
Static/unit checks without shared services may run in isolated worktrees.

### 9.5 Disposable token-settings fixture (`e2e/token-settings.spec.ts`)

- **Explicit local targets, no ambient fallback.** The spec reads `DATABASE_URL` and `VITE_API_BASE_URL` from the environment and refuses to start when either is missing: there is no built-in default URL, so a run can never drift onto an unintended database or API. The database URL must use the `postgres`/`postgresql` scheme, one of the literal hosts `127.0.0.1`, `::1` or `localhost` (a DNS name such as `127.example.com` is refused, not treated as a loopback address), the exact database `pto` or `pto_test`, and at most the optional `?schema=public` parameter — a `?host=`/`?port=` override or any other parameter is refused. The API URL must be http(s), on one of the same literal hosts, and carry no URL credentials. The refusals are covered by negative assertions inside the spec.
- Every test creates its own randomized, non-admin member — `e2e-token-settings-<uuid>@example.com`, role `member`, a bcrypt-hashed throwaway password — through `createPrismaClient`, and removes it in `test.afterEach`: the owned token rows first, then the audit rows that actor wrote, then the user row. The reference is cleared before the next setup runs, so a failed setup cannot leave a stale account behind for the cleanup hook. Nothing shared is touched, no seeded account is revoked, and `revoke all` only ever runs against the account the test itself created.
- The bearer probes use a standalone Playwright `APIRequestContext` (`playwright.request.newContext`), never `browserContext.request`: the context has no browser cookie jar (the spec asserts `storageState().cookies` is empty) and talks to the explicit loopback API base with `maxRedirects: 0`, so a synthetic credential probe never follows a redirect to another endpoint. Reading the owned metadata for the scope/expiry assertions uses a second, separately logged-in context, so the probe context stays cookie-free.
- The issued secret is never printed, logged or asserted literally. Every assertion on it compares a derived boolean, so a failure message carries no token value. The clipboard is read back through the real Clipboard API with granted `clipboard-read`/`clipboard-write` permissions, and the comparison happens inside the page, so only the boolean leaves the browser.
- Failure artifacts (trace, video, screenshot) follow the unchanged global artifact policy and may contain the disposable secret. The account is deleted right after the test, so the credential cannot be used afterwards, and no artifact rule is changed to hide a failure.

### 9.6 Versioned-write fixture (`e2e/critical-journeys.spec.ts`)

- The versioned-write journeys create their own record through the real Add PTO form and remove exactly that record in a `finally` block. The cleanup reads the current version first and then deletes with it, so it works whether the journey already deleted the record or the browser bumped its version.
- The record that changes underneath the browser is a **controlled own request**: the same signed-in member changes it through the app's own API with the expected `If-Match` version. No second account, no bearer token and no production credential is involved, and the request always states the version it expects.
- The journeys refuse to run against anything but a loopback origin: the direct fixture request derives the origin from the Playwright base URL and throws on any other host.
- The stale paths are exercised for real: the browser's own write is let through with the precondition it computed, the server refuses it with `412 STALE_WRITE`, and the test then proves that the newer record is neither overwritten nor deleted and that the write was attempted exactly once.
- The existing note journeys in `e2e/note-visibility.spec.ts` keep their assertions; only their cleanup call changed, because a delete now states the expected version.

## 10. CI/CD Automation (GitHub Actions)

### 10.1 Pipeline layout

The test gate is `.github/workflows/ci.yml`. Production deployment is kept in
separate workflows so the CI gate never receives production credentials. The
OCI tag workflow (`deploy-oci.yml`) is gated by CI through the
`workflow_run` trigger (it fires when the CI workflow completes for a tag
push), or a manual `workflow_dispatch` that verifies the exact target commit's
CI checks. There is no direct tag-push trigger in the deploy workflow and no
legacy deployment or backup workflow.

Jobs (run in order, with `needs:` dependencies):

| # | Job | Runs on | Needs | Steps |
|---|---|---|---|---|
| 1 | `lint` | ubuntu-latest | — | install, eslint, prettier check |
| 2 | `typecheck` | ubuntu-latest | — | install, `tsc --noEmit` (backend + frontend) |
| 3 | `test-backend-unit` | ubuntu-latest | — | backend unit suite with coverage and separate unit artifact |
| 4 | `test-backend-integration` | ubuntu-latest + postgres + redis services | — | vitest run backend integration suite, coverage |
| 5 | `test-frontend` | ubuntu-latest | — | vitest run frontend, coverage |
| 6 | `build` | ubuntu-latest | lint, typecheck | build backend + frontend |
| 7 | `deployment-config` | ubuntu-latest | lint, typecheck | validate OCI Compose/Caddy headers, deployment scripts, workflow guards, retirement isolation, supply-chain pins, and the Node.js runtime baseline |
| 8 | `security` | ubuntu-latest | — | audit the locked npm graphs, scan the pinned production base images for OS and runtime vulnerabilities |
| 9 | `e2e` | ubuntu-latest + postgres service | build | playwright install, playwright test, upload trace/video on failure |
| 10 | `docker-smoke` | ubuntu-latest | build | start the all-in-one compose stack, poll `/health`, assert the images run the supported Node.js baseline, login + validate auto-seeded holidays + validate the seed endpoint, tear down with `-v` |
| 11 | `coverage-gate` | ubuntu-latest | 3, 4, 5 | check integration/frontend reports exist; post coverage summary as PR comment |

### 10.1a Node.js runtime baseline

`.nvmrc` is the single source of truth for the supported Node.js runtime. It
pins one 24.x patch level, and the same value is used by:

- `actions/setup-node` in every workflow, via `node-version-file: '.nvmrc'`, so
  a cached runner can never silently fall back to an older 24.x patch level;
- the container base image tag (`node:<version>-alpine`) in
  `backend/Dockerfile` and `frontend/Dockerfile`, still pinned by digest;
- the `engines.node` floor in the root `package.json` and root lockfile metadata.

`npm run node:baseline:check` (`infra/tests/node-baseline.test.mjs`) asserts
these stay in sync and that the pinned version is at least the minimum
supported release, **24.22.3**, containing the November 2026 HTTP/2/TLS security
fixes. Its daemon-free runtime-checker regression tests reject older/newer
patches, other majors, malformed versions and a floor override.

The Docker smoke job builds, exports and executes `backend:build`,
`frontend:build` and `backend:runtime` from the actual Dockerfiles, then runs
`infra/tests/node-runtime-check.mjs` with an exact `.nvmrc` match. Backend build
is also the all-in-one migration/production bootstrap target; backend runtime
is the production migration/API target. It retains the all-in-one backend and
migration service probes and application smoke. The final nginx image is not
misrepresented as a Node runtime. These checks validate executed artifacts,
not only tags or image-config environment metadata; they use the CI runner's
native platform, while the production base security scan remains linux/arm64.

Bump `.nvmrc`, the `MINIMUM_SUPPORTED_VERSION` constant in
`infra/tests/node-version.mjs`, root engine/lock metadata and the container
digests together whenever a newer 24.x security release ships. Preserve exact
alignment; a newer or other-major container runtime must not silently pass.

### 10.2 Triggers
- `pull_request`: full pipeline.
- `push` to `master`: full pipeline.
- `push` of a semver `v*.*.*` tag: full pipeline for release gating.
- `schedule` (Mondays, 06:30 UTC): full pipeline, so a newly disclosed advisory
  in the unchanged lockfile or in a pinned image is noticed without a commit.
- Production database backups run daily at 03:00 UTC on the OCI VM via
  `pto-calendar-backup.timer`, not GitHub Actions.

The disposable restore helper is tested with real encrypted local archives and
a recording `psql` executable: checksum tampering, missing/symlink inputs,
unexpected archive members, wrong/weak keys, SQL failure, temporary-file cleanup,
and explicit plaintext retention are covered without cloud credentials. The
PostgreSQL backup roundtrip integration test remains the real database check.

**Backup/restore coverage for the exclusion constraint (#257):**
`backend/tests/integration/backupRestore.test.ts` dumps with the very same
arguments the production backup uses (public schema, no owner, no ACL and the
`btree_gist` extension **only when the source has it**), and both dumps read
**one exported PostgreSQL snapshot**, exactly like the production backup: a
migration that commits between the two dumps can no longer produce a schema
without the constraint next to a data file with a finished migration marker.
The roundtrip proves that the restored database

- carries the `btree_gist` extension and the named
  `pto_requests_no_owner_overlap` exclusion constraint,
- keeps the restored row's dates, day part, note and `version` identical to
  the source, and
- really refuses an overlapping PTO for the same owner (the insert fails with
  the exclusion violation and the row count does not change).

The restored schema and the restored data must also agree about the #257
migration: the data file records the migration as applied exactly when the
schema file carries the constraint it installed. The same file keeps the
pre-existing baseline tests intact (the encrypted roundtrip and the sanitizer
rules) and adds focused checks: a database without the extension is still
dumped without it, so an older backup is never blocked, and a schema dump
that carries the constraint without the extension is the shape the backup
script must refuse.

The script itself needs the container and the object store, so its behaviour is
checked against a recording stand-in that answers with a fixed snapshot:
both dumps must name the **same** snapshot, the exporting session must be open
while both dumps run and closed afterwards, an archive whose schema does not
match the snapshot or records an unfinished migration must be refused
**without an upload**, a failing dump must still close the exporter, and a database that predates the migration must
still be backed up. The guard the script adds (the fixed existence queries,
the narrow extension selection, the fail-closed rules and the unchanged
encryption/upload settings) is asserted statically as well. The
database-backed tests keep the existing conditional local skip; CI requires
them.
The missing-ledger regression test runs the backup script's snapshot query
against real disposable PostgreSQL. An empty `public` schema can be backed
up for recovery; a schema containing an object with no migration ledger is
refused before dumping or uploading.

**Create-replay verification (#258):** Real PostgreSQL tests hold a claim
transaction and observe the second writer's database lock. They assert
one committed PTO/audit for two identical calls, recovery after the first
rolls back, and recovery after commit without a successful first reply.
They also cover credential/payload isolation, expired keys after cleanup,
authorization changes during the wait, and a note changed or removed after
creation. Existing overlap, audit and browser compatibility cases remain.

### 10.3 Caching
- Cache `node_modules` and Playwright browsers keyed on lockfile hashes.

### 10.4 Required status checks
`lint`, `typecheck`, `test-backend-unit`, `test-backend-integration`,
`test-frontend`, `build`, `deployment-config`, `security`, `e2e`, `docker-smoke`, and
`coverage-gate` must all pass before merge to `master` — **all current 11 checks**,
not the stale count of eight in older instructions. The OCI deployment
workflow lists the same job names, so a release cannot be tagged around a
failing check.

**Explicit owner security waiver (PR #293, restoration #294):** for
`lhsalas/pto-calendar`, the owner authorized disabling the entire job named
`Security scan` repository-wide until it is restored through issue #294, because
the unpatched `picomatch` advisory GHSA-fc5q-39xc-vjpf blocks the existing
development dependency graph. The job condition is false only for this
repository; this disables both npm dependency audits and the pinned-image
vulnerability/secret scans on PR, master, tag and scheduled CI runs. Its skipped result is waived,
not a passing security scan or remediation. All other checks remain mandatory.
Before applying this waiver, the coordinator verified that this was the only
failing dependency advisory and all four pinned images passed the unchanged
image-risk policy with zero rejected findings (40 temporary and 79 legacy
acceptances, not clean images). The underlying audit/image policies, branch
protections, required-check settings, permissions and deployment guards are
unchanged. No production deployment or PAT activation is authorized. Issue #294
remains an open security item with manual review on 2026-11-24; closing the issue
alone does not restore the control. Restoration must remove the false condition
and prove both audit graphs, real image scans and all normal CI checks pass.

### 10.5 Secrets
- `DATABASE_URL` for the Postgres service container (set per job, never from repo secrets).
- OCI deployment uses `OCI_HOST`,
  `OCI_DEPLOY_USER`, `OCI_PRODUCTION_DEPLOY_ENABLED`, `OCI_KNOWN_HOSTS`,
  `OCI_SSH_HOST`, and `OCI_SSH_PRIVATE_KEY` from repository configuration. The
  job uses the `production` environment and has no OIDC permission.
- `OCI_DB_PASSWORD`, `OCI_SESSION_SECRET`, `OCI_RATE_LIMIT_REDIS_URL`, and
  `OCI_BACKUP_ENCRYPTION_KEY` remain recovery copies in GitHub, not workflow
  inputs. The application and daily backup timer read the VM's protected `.env`.
- `npm run deployment:sunset:check` rejects retired files and legacy
  deployment credential/tool references in active workflows while requiring
  OCI recovery assets to remain. Local encrypted-archive restore tests and the
  real PostgreSQL backup roundtrip remain mandatory.
- No real user data in CI; seed only.

### 10.6 Vulnerability scanning

The `security` job runs two read-only checks. Neither needs a secret, so it is
safe on a pull request from a fork.

1. **npm dependency audit** — `node infra/security/audit.mjs` audits the
   production graph (`--omit=dev`) and the development graph separately from
   the lockfile. A high or critical finding fails the job in either graph;
   lower severities are printed. A scanner failure (registry unreachable,
   unreadable lockfile, malformed report) fails the job rather than passing
   silently, because a scan that did not run is not a clean result.
2. **Container image scan** — `node infra/security/scan-production-images.mjs`
   runs Trivy 0.76.2 against each pinned production base image
   (`node infra/security/production-images.mjs` reads the digests out of the
   Dockerfiles and the production compose file, so the list cannot drift from
   what is deployed). The scan targets `linux/arm64`, which is the production
   platform. Findings that are high or critical and have a published fix fail
   the job; unfixed findings are reported but do not block, because there is
   nothing to upgrade to. The runner retains unfiltered JSON before applying
   reviewed policy, attempts later images after individual failures and blocks
   scanner, conversion, enumeration and malformed-report errors.

`.trivyignore.yaml` holds the exceptions for advisories in the upstream base
images that the project cannot fix itself, because the fix needs an upstream
image rebuild. Every entry names the advisory, the path it applies to, the
exposure assessment, the owner and an expiry date, and the static deployment
checks fail when an entry has no statement or has expired. #273 preserves
that file byte-for-byte and hash-binds it against silent scope/expiry changes;
it does not revalidate its historical reachability statements. Caddy is the
public TLS endpoint, and package presence or an internal plain-HTTP hop alone
does not establish that an advisory is unreachable.

**Temporary accepted risk, NOT remediated (#273):** owner-approved 2026-11-15,
owned by Repository maintainers, expiring **2026-12-15 at 00:00 UTC**. The
separate `infra/security/image-risk-acceptances.json` binds the 40 newly
accepted current matches to exact image digests/advisories/packages/paths,
installed versions and severities. The 79 existing legacy matches remain
separate. New findings, unknown images (even clean ones) and expiry remain
blocking; no future Node digest is pre-authorized. All eleven CI jobs, npm
audit and coverage gates remain required.
The subsequent dated [#248 Node review](node-security-review-2026-11-15.md)
explicitly authorizes only its reviewed 24.22.3 entry after #273 integration,
with all six tuples reviewed, unchanged globals/legacy hash and the original
deadline. Its complete fixed-DB replay is not a fresh-advisory check; final CI
must refresh advisory data and reject unexpected blocking findings.

The `production-image-security` artifact and job summary retain raw reports,
legacy-filtered reports with suppressed rows, logs, `summary.json` and
`accepted-risk.md`, including on failure. `npm run deploy:scripts:check` also
runs daemon-free exact-match, expiry, scan-aggregation and failure regressions.
[#247](https://github.com/lhsalas/pto-calendar/issues/247) remains **OPEN,
priority:high**. See [the acceptance/removal runbook](image-risk-acceptance.md)
for the exact inventory, evidence, weekly official-candidate review, #248
new-digest review and prompt removal procedure. No silent renewal.

`infra/security/generate-trivy-exceptions.mjs` regenerates the candidate
exception list from a local Trivy run. The generated file is reviewed and
committed by hand; the pipeline only ever reads it. It must not be used to
expand the legacy list or automatically populate the #273 manifest. Unaccepted
findings at the blocking threshold fail; neither list grows on its own.

The scheduled run repeats both checks against the unchanged lockfile and the
unchanged digests, which is what catches an advisory that is published after a
release.

`.github/dependabot.yml` opens reviewed pull requests for npm, Docker and
GitHub Actions updates. Dependabot never publishes a release and never edits a
digest or an action pin on its own: the pipeline still requires images to be
pinned by digest and release actions to be pinned to a commit SHA.

The Node.js runtime stays on the latest LTS line, which is 24.x at the moment.
The patch level is pinned in `.nvmrc`, the container base image tag has to
match it, and `@types/node` is held to the same major. Dependabot may propose
a rebuild of the same image tag and a patch or minor update inside the LTS
line, but not a move to the current release line, because that line is not an
LTS release. The static deployment checks assert that the update rule still
ignores exactly the next major, so the rule has to be moved deliberately when
the runtime moves to the next LTS line.

Repository vulnerability alerts are enabled, so the advisory database is
watched in the GitHub UI as well.

Any exception to the policy names the advisory or image, the actual exposure
assessment, an owner and an expiry date.

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

## 17. Planned agent-access acceptance (#246)

**#246 integration checkpoint (2026-11-15):** master `2a4ed0f` includes #273
via PR #276, #248 via PR #274 (Node 24.22.3), and #235 via PR #272.
The [landed policy/runbook](image-risk-acceptance.md) and note regressions are
retained unchanged. See the
[dated owner decision and baseline sequence](agent-access-delivery-plan.md#baseline-repair-and-every-pre-existing-issue)
for orchestration while #247 stays open/high priority.
Accepted risk is not a raw-clean scan; all current CI, npm audit and coverage
requirements still apply. The integrated #246 candidate needs fresh validation;
policy delivery did not ship token/API/CLI/MCP features.

The [delivery contract and release gates](agent-access-delivery-plan.md) are
approved requirements, **not tests implemented or passed by this documentation**.
Keep existing per-path floors and backend integration All files lines >=90%;
new authentication/authorization/scope/validation code requires 100% unit coverage
across metrics. Other new agent packages target >=90% lines/statements/functions
and >=80% branches; wire each workspace into existing CI/security gates.

The eleven original backlog issues and #270 are delivered on master `c4233a5d`
(master CI `43986788679`, eleven jobs). Future token/auth verification must include
`npm run test:coverage -w backend` with fake test-only environment values (no DB
or services), not only passing unit tests; preserve the existing configured targets.

Owning stories add expiry/cap/reset/revoke and role/scope/owner/note matrices,
cookie/PAT/CSRF isolation, atomic audit/overlap/idempotency, complete queries,
412 stale/428 missing preconditions versus 409 business conflicts, secret-safe
adapter process tests, clean packed installs and actual OpenCode V2/Claude
Code/VS Code Copilot approve/reject evidence. Preserve #235–#237 browser note
regressions. Manual permission checks supplement automation; plausible chat output
or tool annotations are not consent evidence. #269 owns dated staging go/no-go;
production rollout/mutations still require explicit maintainer approval.
