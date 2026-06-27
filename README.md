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
- Shared monthly calendar view
- Month navigation
- Color-coded PTO visibility by person
- Edit/delete permissions restricted to owner or team lead

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

## Getting Started (after Phase 0)

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

## Confirmed Product Decisions

- PTO is informational only; no approval workflow for MVP
- Overlapping PTO entries for the same user are not allowed
- Weekends are displayed in the calendar and count as part of continuous multi-day PTO, but PTO cannot start or end on a weekend
- Public holidays are out of scope for MVP
- PTO notes are visible only to the owner and team leads
- Multiple team leads are supported
- Audit logging is included in MVP and stored internally only
- Calendar PTO data is fetched for the full visible grid range, including adjacent-month days

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
