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
- **Purpose:** Tooling matrix, test pyramid, coverage targets (≥80% on critical services), GitHub Actions CI pipeline, ephemeral Postgres for integration tests, Playwright E2E scope, pre-commit hooks, and merge policy.

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
- Responsive layout (page padding shrinks on phones, top header wraps, grid scrolls horizontally only inside its own container with a sticky weekday header); all primary interactive elements meet ≥44px tap targets (44px on buttons, 36px on destructive confirm pair); modals (Add/Edit PTO + PTO details) support Escape-to-close, backdrop-click-to-close, body-scroll-lock, and focus trapping with auto-focus of the first focusable element
- Editorial / paper-planner visual identity: warm cream surface (#FBF8F1), terracotta accent (#B5533A), Fraunces serif for the month label and login h1, IBM Plex Sans for body UI, IBM Plex Mono with tabular-nums for every date display; raw ISO date strings are formatted via `Intl.DateTimeFormat`; loading state is an `aria-busy` skeleton; modals fade-and-slide in via `motion`
- Persistent keyboard focus indicators: every input and `<button>` carries a `focus:ring-2` (inputs) or `focus-visible:ring-2 ring-accent-500` (buttons) so the keyboard user always sees where focus lives; ring offset matches the page surface so it reads as part of the layout; chips, calendar cells, modal ×, list-row opens, and Retry link all participate
- Tab favicon: a single 723-byte SVG under `frontend/public/favicon.svg` — calendar-grid mark (rounded-rect page outline, two binding stubs, header divider, 3×3 day grid, one filled "today" square) — single mid-tone terracotta (#B5533A) fill, tab-only, no PNG/apple-touch-icon/manifest/OG

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

- Review and confirm open product decisions in `docs/plan.md`
- Approve technical choices in `docs/technical-spec.md`
- Validate schema and API contract
- Prioritize backlog items for the first sprint
- Scaffold `backend/` and `frontend/` workspaces
- Start implementation with auth, PTO CRUD, and calendar view

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

Frontend runs on http://localhost:5173, backend on http://localhost:3000. Seeded credentials are printed by `npm run db:seed`.

## Scripts

| Command                     | Effect                                            |
| --------------------------- | ------------------------------------------------- |
| `npm run dev`               | Run backend + frontend together (concurrently)    |
| `npm run build`             | Production build for both workspaces              |
| `npm run start`             | Start the compiled backend (`node dist/index.js`) |
| `npm run lint`              | ESLint across both workspaces                     |
| `npm run typecheck`         | `tsc --noEmit` in both workspaces                 |
| `npm run format`            | Prettier write                                    |
| `npm run format:check`      | Prettier check                                    |
| `npm run test:coverage`     | Vitest with coverage for both workspaces          |
| `npm run test:e2e`          | Playwright E2E suite                              |
| `npm run db:up` / `db:down` | Docker compose for local Postgres                 |
| `npm run db:migrate`        | `prisma migrate dev` (creates new migrations)     |
| `npm run db:migrate:deploy` | `prisma migrate deploy` (production)              |
| `npm run db:reset`          | Drop, recreate, migrate, and seed                 |
| `npm run db:seed`           | Seed the dev users                                |

The backend reads `backend/.env` automatically on `npm run dev` and `npm run test:integration`. No `source` step is required. Existing shell env vars (e.g. production overrides) always win over the file.

## Production Deployment

The MVP deploys as two artifacts (the Node API and a static SPA) fronted by a reverse proxy. The proxy terminates TLS, serves the SPA, and forwards `/auth/*` and `/pto/*` to the Node service so the session cookie's origin matches the API host.

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

Configure the environment from `backend/.env.example`:

| Variable         | Production value                                      |
| ---------------- | ----------------------------------------------------- |
| `NODE_ENV`       | `production`                                          |
| `PORT`           | `3000`                                                |
| `DATABASE_URL`   | `postgresql://user:pass@host:5432/pto`                |
| `SESSION_SECRET` | `openssl rand -base64 32` (≥32 chars)                 |
| `COOKIE_SECURE`  | `true`                                                |
| `COOKIE_DOMAIN`  | API host (e.g., `api.pto.internal.example.com`)       |
| `CORS_ORIGIN`    | SPA origin (e.g., `https://pto.internal.example.com`) |
| `BCRYPT_ROUNDS`  | `12` (production; tests use `4`)                      |
| `LOG_LEVEL`      | `info`                                                |

```bash
cd backend
node dist/index.js
```

The server now exposes the API at `/health`, `/auth/*`, and `/pto/*`.

### 4. Reverse proxy

Use any reverse proxy that can route by path. Example for Caddy:

```
pto.internal.example.com {
  route /auth/* localhost:3000
  route /pto/* localhost:3000
  route /health localhost:3000
  reverse_proxy localhost:5173
}
```

Or Nginx:

```
server {
  listen 443 ssl;
  server_name pto.internal.example.com;

  location /auth/ { proxy_pass http://localhost:3000; }
  location /pto/  { proxy_pass http://localhost:3000; }
  location /health { proxy_pass http://localhost:3000; }
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

## Deliverables in This Repo

- Product planning document
- Technical specification
- SQL schema
- API contract
- Delivery backlog
- Testing and automation strategy

## Optional Next Artifacts

If needed, the following can be added next:

- Wireframes or low-fidelity mockups
- Architecture diagram
- ER diagram
- Postman collection
- Seed data script
- Initial project scaffold
