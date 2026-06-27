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
- `AuthorizationService`, PTO validation, `PTOService`, `CalendarQuery`, and `AuditLogService` enforce ≥80% line coverage
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

## 8. Definition of Done
A backlog item is done when:
- Code is implemented
- Acceptance criteria are met
- Tests are added or updated
- Code is reviewed
- Documentation is updated where needed
- Feature works in a deployed test environment
