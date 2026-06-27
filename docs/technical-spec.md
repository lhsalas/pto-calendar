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

### 7.1 Authentication APIs

#### POST /auth/login
Authenticates a user.

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
- Include notes only when the requester is the PTO owner or has role `team_lead`

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

Suggested error codes:
- `UNAUTHENTICATED`
- `FORBIDDEN`
- `VALIDATION_ERROR`
- `NOT_FOUND`
- `CONFLICT`
- `INTERNAL_ERROR`

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

### 10.3 Authorization helper
Pseudo-logic:
```ts
function canModifyPTO(currentUser, pto) {
  return currentUser.role === 'team_lead' || currentUser.id === pto.userId;
}
```

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
- All APIs authenticated
- Authorization enforced server-side
- Input validation and sanitization
- bcrypt password hashing
- HTTP-only secure cookie sessions
- Cross-origin requests are allowed via the `cors` middleware using the `CORS_ORIGIN` env var allowlist. Credentials are permitted (`credentials: true`) so the HTTP-only cookie session works across origins in production. The allowlist is enforced server-side.
- Health-check endpoints must return a minimal payload (`{ "status": "ok" }`) and must not leak environment, version, or deployment metadata.

### 13.3 Reliability
- Failed requests should return clear errors
- Database writes should be transactional where needed

### 13.4 Maintainability
- Strong typing recommended
- Shared validation schema between frontend and backend if possible
- Centralized permission logic
- Tailwind v4 builds CSS via `@tailwindcss/vite`; `autoprefixer` is not required and should not be installed.
- Dependency hygiene: prune unused `dependencies`/`devDependencies` after each sprint. A dependency is unused if no `import`/`require` references it in `src/` or `tests/` (excluding config-only packages like `eslint`/`prettier`/`husky`/`lint-staged`).

## 14. Testing Specification

### 14.1 Unit tests
- validate same-day PTO rules
- validate multi-day PTO rules
- validate authorization helper
- validate visible date-range overlap query logic
- validate date expansion logic

### 14.2 Integration tests
- authenticated member can create PTO
- member can update own PTO
- member cannot update another user PTO
- team lead can update another user PTO
- delete permissions enforced
- visible date-range endpoint returns overlapping records

### 14.3 UI tests
- calendar page loads current month
- next/previous month navigation works
- PTO chips render correct color and label
- single-day form toggles day-part selector
- edit/delete visibility respects permissions

### 14.4 Automation, tooling, CI/CD, and coverage policy
See `testing-strategy.md` for the full automation plan: tooling matrix (Vitest, Supertest, React Testing Library, MSW, Playwright, GitHub Actions), coverage targets with strict gates on authorization and PTO validation, ephemeral Postgres for integration tests, pre-commit hooks, and merge policy.

## 15. Suggested Implementation Choices

### Confirmed MVP implementation choice
- React + TypeScript frontend using Vite
- Tailwind CSS styling
- Node.js + Express + TypeScript backend
- PostgreSQL database with Prisma
- Email/password auth for manually seeded users
- bcrypt password hashing
- HTTP-only cookie sessions
- Custom month calendar grid or lightweight calendar library

## 16. Deployment Notes
- Internal-only deployment is sufficient for MVP
- Back up database regularly
- Configure environment variables for DB and auth secrets
- Set `CORS_ORIGIN` to the frontend's production origin (e.g., `https://pto.internal.example.com`). Backends must run with `COOKIE_SECURE=true` and `COOKIE_DOMAIN` set to the backend's host so session cookies are set with the right scope across origins.

## 17. Confirmed Technical Decisions
- Audit logs are stored internally only and are not exposed in the MVP UI

## 18. Acceptance Criteria Summary
- Authenticated users can create PTOs
- Single-day PTO requires day-part selection
- All authenticated users can view all PTOs in monthly calendar view
- Only PTO owner or team lead can edit/delete PTOs
- Calendar supports month navigation and fetches PTO entries for the full visible grid range
- PTOs display with user-specific colors
