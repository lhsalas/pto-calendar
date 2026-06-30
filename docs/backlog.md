# PTO / Vacation Calendar App Backlog

## 1. Epics
- Epic 1: Authentication and user management
- Epic 2: PTO request management
- Epic 3: Shared calendar experience
- Epic 4: Authorization and security
- Epic 5: Quality, testing, and deployment

## 2. Epic 1: Authentication and User Management

### Story 1.1: User can log in
**As** a team member
**I want** to log in to the app
**So that** I can manage and view PTO information

#### Acceptance Criteria
- User can enter email and password
- Valid seeded-user email/password credentials create an HTTP-only cookie session
- Passwords are verified with bcrypt
- Invalid credentials show an error message
- Unauthenticated users cannot access protected pages

#### Tasks
- Design login page UI
- Implement login API endpoint
- Add bcrypt password verification
- Add HTTP-only cookie session handling
- Add route protection middleware
- Add logout flow

### Story 1.2: App identifies team lead vs member
**As** the system
**I want** each user to have a role
**So that** permissions can be enforced

#### Acceptance Criteria
- Users have a persisted role field
- Allowed roles are `member` and `team_lead`
- Role is available in backend auth context
- Role is available to frontend session state

#### Tasks
- Add role field to schema
- Include role in auth response
- Add role-based helper functions

## 3. Epic 2: PTO Request Management

### Story 2.1: User can create PTO
**As** a logged-in user
**I want** to create a PTO entry
**So that** my team can see when I will be off

#### Acceptance Criteria
- User can select start and end dates on weekdays only
- User can save a valid PTO request
- A multi-day PTO may include weekends between valid weekday start/end dates
- PTO is associated to authenticated user
- PTO appears in calendar after save
- User cannot create PTO that overlaps their existing PTO

#### Tasks
- Build PTO form UI
- Implement create PTO API
- Persist PTO record in database
- Refresh calendar after create

### Story 2.2: Single-day PTO supports half-day selection
**As** a logged-in user
**I want** to choose morning, evening, or all day for a one-day PTO
**So that** my availability is accurately shown

#### Acceptance Criteria
- If start date equals end date, day-part selector is shown
- Allowed values are `morning`, `evening`, `all_day`
- Request cannot be saved without day part when single-day
- Saved PTO displays selected day part

#### Tasks
- Add conditional day-part field in form
- Add frontend validation
- Add backend validation
- Add rendering labels for half-day PTO

### Story 2.3: Multi-day PTO is treated as full-day range
**As** a logged-in user
**I want** multi-day PTO to cover all selected days
**So that** my full absence is visible

#### Acceptance Criteria
- If start date differs from end date, PTO is treated as full-day range
- Morning/evening options are not accepted for multi-day PTO
- Multi-day PTO is stored with `day_part = all_day`
- Calendar shows PTO on every day in range, including weekends
- Weekend dates cannot be selected as the start or end date

#### Tasks
- Add form rules for multi-day case
- Normalize day part in backend
- Expand PTO across covered dates in UI

### Story 2.4: User can edit own PTO
**As** a logged-in user
**I want** to edit my own PTO entries
**So that** I can correct mistakes or update plans

#### Acceptance Criteria
- Owner can open edit UI for own PTO
- Owner can update dates, day part, and note
- Updated PTO is revalidated, including weekend start/end and overlap rules, and persisted
- Calendar reflects changes immediately after save

#### Tasks
- Add edit action in PTO details
- Implement update PTO API
- Add owner permission checks in UI
- Refresh month data after update

### Story 2.5: User can delete own PTO
**As** a logged-in user
**I want** to delete my own PTO entries
**So that** I can remove canceled plans

#### Acceptance Criteria
- Owner can delete own PTO entry
- Delete action requires confirmation
- Deleted PTO no longer appears in calendar

#### Tasks
- Add delete action in PTO details
- Implement delete PTO API
- Add confirmation dialog
- Refresh month data after delete

## 4. Epic 3: Shared Calendar Experience

### Story 3.1: Logged-in users can view all PTOs in a monthly calendar
**As** a logged-in user
**I want** to see everyone’s PTO on a month calendar
**So that** I can plan team availability

#### Acceptance Criteria
- Main page is a monthly calendar view
- Calendar displays PTOs for all users
- Days show who is off
- Calendar handles empty and populated days correctly

#### Tasks
- Build calendar page layout
- Implement month grid component
- Fetch PTO data for the full visible calendar grid range, including adjacent-month days
- Render PTO labels/chips in day cells

### Story 3.2: User can navigate between months
**As** a logged-in user
**I want** to move to past and future months
**So that** I can inspect upcoming PTO plans

#### Acceptance Criteria
- Previous and next month controls are available
- Selecting a new month refreshes PTO data
- Current month label updates correctly

#### Tasks
- Build calendar header controls
- Add selected month state
- Trigger data refetch on month change

### Story 3.3: Calendar uses different colors for different people
**As** a logged-in user
**I want** PTOs to have person-specific colors
**So that** I can quickly identify who requested time off

#### Acceptance Criteria
- Each user has a stable assigned color
- PTO entries display using that user’s color
- A legend or tooltip helps identify the person

#### Tasks
- Store color code per user
- Add PTO chip styling
- Add optional legend or hover details

## 5. Epic 4: Authorization and Security

### Story 4.1: Team lead can modify any PTO
**As** a team lead
**I want** to edit or delete any team member’s PTO
**So that** I can keep the shared calendar accurate

#### Acceptance Criteria
- Team lead can access edit/delete actions for any PTO
- Backend authorizes team lead override
- Audit log entry is created for **all** PTO update and delete actions (owner self-edits and team-lead edits alike), capturing actor, target, action, and timestamp

#### Tasks
- Add team lead authorization rules
- Surface lead actions in UI
- Add audit logging hooks for update/delete actions
- Verify audit logs are written for both owner and team-lead updates/deletes

### Story 4.2: Non-owners cannot modify others’ PTO
**As** a logged-in user
**I want** permissions enforced consistently
**So that** PTO ownership is protected

#### Acceptance Criteria
- Members cannot edit/delete PTO entries they do not own
- Unauthorized API calls return 403
- UI hides unauthorized controls

#### Tasks
- Add centralized authorization helper
- Enforce 403 in update/delete endpoints
- Hide forbidden actions in frontend

### Story 4.3: All protected routes require authentication
**As** the system
**I want** all sensitive pages and APIs to require login
**So that** PTO data remains internal

#### Acceptance Criteria
- Unauthenticated requests to protected APIs return 401
- Unauthenticated page access redirects to login
- Session expiration is handled gracefully

#### Tasks
- Add auth middleware
- Add frontend guard/navigation handling
- Add unauthorized error handling

## 6. Epic 5: Quality, Testing, and Deployment

### Story 5.1: Core business rules are covered by tests
**As** the team
**I want** critical PTO logic tested
**So that** regressions are reduced

#### Acceptance Criteria
- Validation logic has unit tests
- Authorization logic has unit tests
- PTO API flows have integration tests
- Calendar rendering scenarios have UI tests

#### Tasks
- Add unit test setup
- Add integration test setup
- Add UI/e2e test setup
- Write tests for happy path and permission edge cases

### Story 5.2: App is deployable for internal use
**As** the team lead
**I want** the app to be deployable internally
**So that** the team can start using it

#### Acceptance Criteria
- Environment variables are documented (DB connection string, session secret, cookie flags)
- Database schema can be created in the target environment via Prisma migrations
- Backend can run in production mode (build + start scripts)
- Frontend can be built and served as static assets behind the backend or via a reverse proxy
- Basic deployment steps are documented in the README

#### Tasks
- Create production `.env.example` template
- Add DB migration step to deployment runbook
- Add deployment documentation (local Docker compose + internal host instructions)
- Validate build and startup scripts end-to-end against a clean environment
- Audit `package.json` files for unused dependencies and remove them (per `technical-spec.md` §13.4 dep hygiene rule: prune any dependency that is not imported anywhere in `src/` or `tests/`, except config-only packages like `eslint`/`prettier`/`husky`/`lint-staged`)

### Story 5.3: CI pipeline runs all checks on every PR
**As** the team
**I want** every pull request to run lint, typecheck, unit, integration, and E2E tests automatically
**So that** regressions are caught before merge

#### Acceptance Criteria
- GitHub Actions workflow runs on every PR and push to `main`
- Pipeline includes: lint, typecheck, backend unit, backend integration (with ephemeral Postgres), frontend unit/component, build, Playwright E2E
- Required status checks block merge when any job fails
- Pipeline runs in under 15 minutes for typical PRs

#### Tasks
- Add `.github/workflows/ci.yml`
- Configure Postgres service container for integration jobs
- Configure Playwright with `webServer` for E2E
- Cache `node_modules` and Playwright browsers
- Configure branch protection required status checks

### Story 5.4: Coverage gates enforced on critical paths
**As** the team
**I want** automated coverage gates on authorization, validation, and core services
**So that** critical logic cannot silently lose test coverage

#### Acceptance Criteria
- Vitest coverage thresholds configured in `vitest.config.ts`
- `AuthorizationService`, PTO validation, `PTOService`, `CalendarQuery`, `AuditLogService`, `UserService`, and `AuthService` enforce ≥80% line coverage
- `PTOService` enforces ≥90% lines/statements/functions coverage (≥80% branches)
- `services/{auth,pto}/schemas.ts`, `middleware/requireAuth.ts`, and `lib/lifecycle.ts` enforce 100% across all metrics
- `middleware/{cookieSession,errorHandler}.ts` enforce ≥80%
- Frontend critical components (`PTOFormModal`, `DayCell`, `CalendarPage`) enforce ≥80% line coverage
- PR fails if any blocking path drops below its threshold
- Coverage diff posted as a PR comment

#### Tasks
- Configure `c8`/`@vitest/coverage-v8` thresholds per path
- Add coverage diff PR comment step to CI
- Document thresholds in `testing-strategy.md` (already done) and link from README

### Story 5.5: Playwright E2E covers critical user journeys
**As** the team
**I want** automated end-to-end tests for the most important user flows
**So that** full-stack regressions are caught even when unit/integration tests pass

#### Acceptance Criteria
- Playwright suite covers: login, single-day PTO create, multi-day PTO create, weekend rejection, overlap rejection, edit own PTO, delete own PTO, permission enforcement (member vs team lead), month navigation
- Tests run in CI against a freshly seeded test database
- Traces and videos uploaded as artifacts on failure
- Suite is stable (no known flaky tests)

#### Tasks
- Add Playwright config with `webServer` and ephemeral DB
- Implement critical journey specs listed in `testing-strategy.md` §8.2
- Wire Playwright into GitHub Actions with artifact uploads

## 7. Prioritized Delivery Plan

### Sprint 1
- Story 1.1 User can log in
- Story 1.2 App identifies team lead vs member
- Story 4.3 All protected routes require authentication
- Story 2.1 User can create PTO
- Story 2.2 Single-day PTO supports half-day selection

### Sprint 2
- Story 2.3 Multi-day PTO is treated as full-day range
- Story 2.4 User can edit own PTO
- Story 2.5 User can delete own PTO
- Story 4.2 Non-owners cannot modify others’ PTO

### Sprint 3
- Story 3.1 Logged-in users can view all PTOs in a monthly calendar
- Story 3.2 User can navigate between months
- Story 3.3 Calendar uses different colors for different people
- Story 4.1 Team lead can modify any PTO

### Sprint 4
- Story 5.1 Core business rules are covered by tests
- Story 5.3 CI pipeline runs all checks on every PR
- Story 5.4 Coverage gates enforced on critical paths
- Story 5.5 Playwright E2E covers critical user journeys
- Story 5.2 App is deployable for internal use

## 7b. Epic 6: Production Hardening (Shipped)

All 8 stories below were implemented and merged during the post-MVP hardening sprint. PRs reference the GitHub issue numbers and merge commits; each story closes an issue via the PR body footer.

### Story 6.1: Backend security headers and rate limiting — #28
**Status:** Shipped (PR #44)
**Summary:** `helmet` mounted globally for canonical security headers (CSP, HSTS, `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, COOP/CORP/OAC). Stricter login limiter on `POST /auth/login` (5 failed/15min/IP, `skipSuccessfulRequests: true`); broader global limiter across the rest of the API (100/15min/IP). Both respond with `{ error: { code: 'RATE_LIMITED', message } }` + `Retry-After`. Limits are env-driven (`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_MAX`); CI bumps them so the e2e suite doesn't trip.

### Story 6.2: Graceful shutdown — #31
**Status:** Shipped (PR #45)
**Summary:** SIGTERM/SIGINT triggers `shutdown(server, prisma)` — drains `server.close()`, calls `server.closeAllConnections()` (Node 18+), then `prisma.$disconnect()`. `SHUTDOWN_TIMEOUT_MS` (default 10s) fallback force-exits 1 if drain hangs. `uncaughtException` and `unhandledRejection` handlers log `logger.fatal` and call `process.exit(1)`. Lifecycle extracted to `backend/src/lib/lifecycle.ts` and unit-tested at 100% (10 tests).

### Story 6.3: Liveness and readiness probes — #33
**Status:** Shipped (PR #46)
**Summary:** `GET /health` is a no-DB liveness probe (always 200 + `{ status: 'ok' }`); `GET /ready` runs `prisma.$queryRaw\`SELECT 1\`` with a `READY_TIMEOUT_MS` (default 5s) race-timer — 200 + `{ status, db, uptime }` on success, 503 + `{ error: { code: 'NOT_READY', details } }` on failure/timeout. Both unauthenticated, registered before `authRouter`/`ptoRouter`. Covered by `server.test.ts` (7 tests including DB-throw and DB-hang cases).

### Story 6.4: Request logging with correlation IDs — #29
**Status:** Shipped (PR #47)
**Summary:** `pino-http` mounted globally between `express.json` and `cookieSession`. Every response echoes an `X-Request-Id` header (UUID v4 generated by `crypto.randomUUID()`, or the inbound `X-Request-Id` if the client supplied one and it matches the safe character class). Inbound `X-Request-Id` values containing control characters or whitespace are replaced with a fresh UUID to prevent log injection. One structured log line per non-probe request (`req.{id,method,url}`, `res.statusCode`, `responseTime`); `/health` and `/ready` are skipped via `autoLogging.ignore`. `errorHandler` middleware logs `reqId` with any unhandled error. The base `pino` logger applies a `redact` configuration covering `req.headers.cookie`, `req.headers.authorization`, `res.headers["set-cookie"]`, `password`, `passwordHash`, `token`, and `secret` (at the top level and under any object), with `[REDACTED]` as the censor; custom `req`/`res` serializers drop the `headers` field entirely so cookie / `Set-Cookie` / `Authorization` values never reach stdout.

### Story 6.5: Centralized note-visibility authorization — #30
**Status:** Shipped (PR #48)
**Summary:** `GET /pto/:id` uses the shared `canViewNote(actor, pto)` helper from `services/authorization/AuthorizationService` (delegates to `canModifyPTO`) to decide whether to redact the `note` field. The route no longer carries a local `isOwnerOrLead` helper — note-visibility logic flows through the authorization service only.

### Story 6.6: Shared Zod schemas between routes and validation — #32
**Status:** Shipped (PR #49)
**Summary:** Zod schemas are defined once per domain — `services/pto/schemas.ts` (`CreatePtoSchema`, `RangeQuerySchema`, `IdParamSchema`, `DayPartSchema`, `ISO_DATE`) and `services/auth/schemas.ts` (`LoginSchema`). Both route files import from these and infer request types directly (no `as` casts). `validation.ts` re-uses `ISO_DATE` and `CreatePtoInput` from the same source. Both modules are unit-tested at 100% coverage (11 + 4 tests).

### Story 6.7: Direct unit coverage for middleware — #34
**Status:** Shipped (PR #50)
**Summary:** `cookieSession.ts`, `errorHandler.ts`, and `requireAuth.ts` each have a dedicated unit suite (5 + 5 + 4 tests, 100% on `requireAuth`, 80% on the others). The middleware layer is no longer covered only via the server-level integration tests.

### Story 6.8: Direct unit coverage for `PTOService` create + overlap — #27
**Status:** Shipped (PR #51)
**Summary:** `createPto` and `findOverlapping` now have direct unit tests (10 new tests in `PTOService.test.ts`), bumping the per-file threshold from 80% to 90% (lines/statements/functions; branches stay at 80% due to a small uncovered defensive branch in the update path).

### Sprint 5 — Production Hardening
- Story 6.1 Helmet + rate limiting
- Story 6.2 Graceful shutdown
- Story 6.3 Liveness + readiness probes
- Story 6.4 Request logging + correlation IDs
- Story 6.5 Centralized note-visibility authorization
- Story 6.6 Shared Zod schemas
- Story 6.7 Middleware unit coverage
- Story 6.8 `PTOService` create + overlap unit coverage

## 8. Definition of Done
A backlog item is done when:
- Code is implemented
- Acceptance criteria are met
- Tests are added or updated
- Code is reviewed
- Documentation is updated where needed
- Feature works in a deployed test environment
- Production hardening (helmet, rate limiting, graceful shutdown, liveness + readiness probes, request logging with `X-Request-Id`, shared Zod schemas, centralized `canViewNote`, direct unit coverage for all middleware and the `PTOService` create path) is live and reflected in the docs
- Boot-time env validation: `SESSION_SECRET` must be ≥32 chars, must not be a known placeholder, and must have Shannon entropy ≥ 3.5 bits/char; `NODE_ENV=production` additionally requires `COOKIE_SECURE=true` and `BCRYPT_ROUNDS>=10`. Comma-separated `SESSION_SECRET` values are supported for graceful key rotation. `backend/src/config/env.ts` and `backend/src/config/sessionSecret.ts` carry the rules; `backend/src/config/env.test.ts` covers every branch.
- Login timing-equalization: `AuthService.login` runs a dummy `bcrypt.compare` against a module-level precomputed hash on the unknown-email, empty-password, and `passwordHash == null` branches so the response time does not leak which branch fired. The error payload is byte-identical across all three branches. New `AuthService.test.ts` cases assert the unknown-email and empty-password paths stay within a 50ms differential of the bad-password path.
- `requireAuth` revalidates every session user against the database via a per-process in-memory cache keyed by user id (`AUTH_USER_CACHE_TTL_MS`, default 15s). A deleted user is revoked within one TTL window; a role change is reflected in `req.user` / `req.session.user` on the next request after expiry. Login regenerates the session by replacing `req.session` with a fresh object (session-fixation mitigation; `cookie-session` has no `regenerate`). New unit tests cover cache hit/miss, role demotion, deleted-user 401, negative-cache TTL, and DB error forwarding; new integration tests cover deleted-user 401 and role demotion.
- `/ready` no longer leaks the underlying Prisma error message to the client. The 503 response body returns only `{ db: 'unreachable' }`; the original error is logged via `logger.warn({ err }, 'Readiness check failed')` and stays in the server log. Test in `backend/src/server.test.ts` and `backend/tests/integration/health.test.ts` assert no `reason` field is present in the response body.
- Graceful shutdown now calls `server.closeIdleConnections()` before awaiting `server.close()`, so idle keep-alive peers drop within the grace window instead of waiting for the kernel keep-alive timeout. `server.closeAllConnections()` is still invoked after the close callback to terminate any stragglers. `backend/src/lib/lifecycle.ts` carries the change; `backend/src/lib/lifecycle.test.ts` asserts the call order.
- Login form input caps: `frontend/src/pages/LoginPage.tsx` sets `maxLength={254}` on the email input (RFC 5321 practical cap) and `maxLength={72}` on the password input (bcrypt's hard cap). This mirrors the server's `LoginSchema.email.max(254)` and prevents a minor DoS surface (oversized payloads) and a password-truncation footgun. `tests/unit/LoginPage.test.tsx` asserts the attributes; `docs/technical-spec.md` §7.1 notes the client-side caps.
- Dev-toolchain bump: `vite ^6.0.3 → ^7.3.6`, `vitest ^2.1.8 → ^3.2.6`, `@vitest/coverage-v8 ^2.1.8 → ^3.2.6` (frontend `package.json` + lockfile). `npm audit` (with devDeps) now reports `0 vulnerabilities` (was 6: esbuild dev-server cross-origin, vite `.map` path traversal, vite `server.fs.deny` Windows bypass, vitest UI arbitrary file read, plus transitive duplicates). Production bundle is unaffected (`npm audit --omit=dev` = 0 before and after). All frontend unit, e2e, lint, typecheck, and build gates stay green.
- Trust-proxy + correct rate limiting behind a reverse proxy: new `TRUST_PROXY_HOPS` env (default 0 in dev/test, 2 in production). `createApp()` calls `app.set('trust proxy', N)` when `N > 0`. Both the login and global limiters use a `keyGenerator` that reads `X-Forwarded-For` only when trust proxy is enabled, falling back to `req.socket.remoteAddress` otherwise (spoofing guard). The global limiter `skip`s `/health` and `/ready` so health probes don't consume the user-facing bucket. `backend/src/config/env.ts` carries the schema; `backend/src/lib/rateLimit.ts` carries the limiters; new unit tests in `server.test.ts` cover the trust-proxy pass-through and ignore behavior; new integration test in `tests/integration/auth.test.ts` proves two distinct `X-Forwarded-For` IPs get distinct rate-limit buckets when `TRUST_PROXY_HOPS=2`.
- Production security headers + Caddy prod topology: `frontend/nginx.conf` emits `Content-Security-Policy` (with the SHA-256 of the inline theme-init script in `frontend/index.html`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera/microphone/geolocation/payment disabled), and `X-Frame-Options: DENY` on every static + proxied response. All four `proxy_pass` blocks add `X-Forwarded-Proto` and `X-Forwarded-Host`. nginx does NOT set HSTS (Caddy owns it). New `Caddyfile` (repo root) uses `{$HOST}` + `{$ACME_EMAIL}` placeholders, sets HSTS, and reverse-proxies to `nginx:80`. New `docker-compose.prod.yml` adds a Caddy service on ports 80/443 with auto-TLS, requires `HOST`, `ACME_EMAIL`, `SESSION_SECRET`, `CORS_ORIGIN` at deploy time, and sets `TRUST_PROXY_HOPS=2` + `COOKIE_SECURE=true` on the backend. Static config invariants are enforced by `npm run prod:config:check` (`infra/tests/prod-headers.test.mjs`).
- Harden `frontend/src/api/client.ts` `apiRequest`: safe-JSON parse (throws `ApiError(0, { code: 'BAD_RESPONSE' })` on malformed body, no more uncaught `SyntaxError` leaking to callers), default 15s timeout (`VITE_API_TIMEOUT_MS` + per-request `timeoutMs` option) enforced via `Promise.race` with a `clearTimeout` in `finally` (no leaked timers), caller `signal` forwarded to `fetch` and reported as `ApiError(0, { code: 'ABORTED' })` on abort, network failures reported as `ApiError(0, { code: 'NETWORK' })`. `vite-env.d.ts` documents the new `VITE_API_TIMEOUT_MS`; `frontend/.env.example` documents it; unit tests in `tests/unit/apiClient.test.ts` cover the four error paths. The `AuthContext` `/auth/me` effect keeps the `cancelled`-flag cleanup pattern (the AbortController-based pattern runs into a vitest+jsdom+undici `AbortSignal` instanceof mismatch; documented in the file's docblock).
- Use `apiRequest` consistently + encode URL segments: `PTOViewModal.loadDetail` was the only remaining raw `fetch(` call site; rewrote to `apiRequest<PTO & { user }>` with `encodeURIComponent(pto.id)`. `usePtoList` builds the `/pto?start=…&end=…` query via `URLSearchParams` (not string concatenation) and encodes `id` in the `update` and `remove` paths. `frontend/eslint.config.js` adds a `no-restricted-syntax` rule that bans raw `fetch(` outside `src/api/client.ts` and the `apiClient` test, with a helpful error message pointing to `apiRequest`; the `PTOFormModal` overlap test was using a raw `fetch(` in a mock `onSubmit` and was rewritten to `apiRequest` via dynamic import.
- Top-level `ErrorBoundary` (`frontend/src/components/ErrorBoundary.tsx`): a React class component (with `getDerivedStateFromError` + `componentDidCatch`) that wraps the route tree in `App.tsx`, so a render-time throw — a malformed server payload cast to the wrong shape, a `new Date(invalidString)`-style NaN, etc. — shows a user-facing fallback with a "Back to calendar" button instead of unmounting the whole app to a blank screen. `componentDidCatch` logs to `console.error` (no raw error body in the fallback — no info leak). Unit tests in `tests/unit/ErrorBoundary.test.tsx` cover the four paths: no-error render, fallback render on child throw, no raw-error echo in the fallback, and the Reload button → `window.location.assign('/calendar')`.
- Self-service account setup (Issue #62): `POST /users` (team_lead only) creates a member with `passwordHash: null`, a one-time setup token (sha256-hashed in the DB, TTL `SETUP_TOKEN_TTL_MS` default 24h), and returns `{ user, setupToken, expiresAt }`. `POST /auth/setup-account` (public) redeems the token, hashes the password, clears the token columns, starts a session, and returns the user. `POST /users/:id/reset-password` (team-lead only, no self-reset, no resetting the only team_lead) issues a fresh token. `Role` enum is widened to `member | team_lead | admin` (`admin` is a forward-compatible role used by `canManageUsers` / `canModifyPto`; today the team_lead gate is the active one). The `Prisma User` table gets nullable `password_hash`, `setup_token_hash VARCHAR(64)`, and `setup_token_expires_at`. The frontend exposes `/setup-account?token=...` (`SetupAccountPage`) and a team-lead-only `/admin/users` page (`AdminUsersPage` with a list + "Add user" form + "Reset password" buttons). The new `Role.admin` enum value is in the Prisma schema and 4 TS files (cookieSession, AuthorizationService, frontend permissions, frontend types/api) plus `docs/openapi.yaml` and `docs/schema.sql` (per the issue's implementation-gaps list). `docs/openapi.yaml` adds the `Password`, `SetupAccountRequest`, `CreateUserRequest`, `CreateUserResponse`, `ResetPasswordResponse` schemas and `POST /auth/setup-account`, `GET /users`, `POST /users`, `POST /users/{id}/reset-password` paths with FORBIDDEN 403 documentation. Unit tests in `backend/src/services/users/UserService.test.ts` cover every branch (14 cases). Integration tests in `backend/tests/integration/users.test.ts` cover the routes end-to-end (15 cases). Frontend unit tests in `SetupAccountPage.test.tsx` (5) and `AdminUsersPage.test.tsx` (2) cover the new pages. The setup-account route is rate-limited by the existing login limiter. Audit-log entries are written for `create_user` and `reset_user_password` actions.
- Production first-run team-lead bootstrap (Issue #67): `npm run db:bootstrap` runs `backend/prisma/bootstrap.ts` and creates a single `team_lead` user with a one-time setup token (reusing `generateSetupToken` from #62). Env: `LEAD_EMAIL` (required), `LEAD_NAME` (default `"Team Lead"`), `LEAD_COLOR_CODE` (default `#3B82F6`), `APP_PUBLIC_BASE_URL` (or `--base-url` flag, default `http://localhost:5173`). Prints the setup link to stdout. Idempotent: if the lead already has a password, it's a no-op; if the lead exists with no password, the token is regenerated and the new link is printed. `backend/.env.example` documents all four envs. `backend/tests/integration/bootstrap.test.ts` (5 cases) covers the validation, fresh-create, `--base-url` override, no-op idempotency, and token-regeneration paths.
