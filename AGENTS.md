# AGENTS.md

## App

PTO Calendar — a team web app for requesting and tracking paid time off.
Members log in, pick dates on a monthly grid or a 90-day list, and submit a
request with a day-part (AM/PM/Full). Team leads can approve and edit any
member's PTO. Backend is Express + Prisma + PostgreSQL with cookie-session
auth, helmet, rate limiting, pino-http logging, and a graceful shutdown
lifecycle. Frontend is React + Vite + Tailwind v4 with a hand-rolled grid,
3-chip rendering, dark mode, and a typed OpenAPI client. Tests: Vitest
(unit + integration against an ephemeral `pto_test` Postgres) and Playwright
(real Chromium, 30 specs).

See `README.md` for features, `docs/plan.md` for the roadmap,
`docs/technical-spec.md` for architecture, `docs/openapi.yaml` for the API,
and `docs/testing-strategy.md` for the full automation + coverage policy.

## Creating a GitHub issue

- Use `gh issue create`; one issue = one deliverable. Split large work into
  multiple numbered issues.
- Title is imperative and scoped (e.g. "Reject PTO starting on a weekend").
- Label with `enhancement` for new features and `bug` for defects. Add an
  `area:*` or `epic:*` label if one exists.
- Body template:
  - **Problem** — 1-2 sentences, user-visible.
  - **Acceptance criteria** — bullet list, each item a testable assertion.
  - **Out of scope** — 1-3 bullets.
  - **Notes** — optional: prior art, files to touch, coverage targets.
- For pure-config / test-only work, still file an issue so the change is
  traceable to a numbered PR.

## Solving a GitHub issue

- Branch from `master` named after the issue:
  `feat/<#>-<slug>`, `refactor/<#>-<slug>`, `fix/<#>-<slug>`,
  `test/<#>-<slug>`, `docs/<slug>`.
- Commit with Conventional Commits (`feat:`, `refactor:`, `fix:`,
  `test:`, `docs:`, `chore:`). Body includes `Closes #<#>` and a 1-3 line
  "what changed" summary.
- `gh pr create` body references `Closes #<#>` and includes
  Summary / Files changed / Local gates / Acceptance criteria sections.
- **Per-PR gate — all must pass locally before push:**
  - `npm run lint` and `npm run typecheck` in both workspaces.
  - `npm test` (unit) in both workspaces.
  - `npm run test:integration:coverage -w backend` against `pto_test` —
    integration `All files` lines must stay ≥ 90%.
  - `npm run build -w frontend`.
  - Playwright e2e vs the dev `pto` DB, after
    `TRUNCATE pto_requests, audit_logs RESTART IDENTITY CASCADE`,
    with `--project=chromium --workers=1` — must stay 100% green.
- **After push:** wait for all 8 CI jobs green (Backend unit, Backend
  integration, Frontend unit, Lint, Typecheck, Build, Coverage gate, E2E).
- **Before merge:** self-review with `gh pr diff <#> --name-only` — must
  show only the files the PR body lists.
- **Merge:** `gh pr merge <#> --merge --delete-branch`, then
  `git checkout master && git pull`.
- **Update docs in the same PR** when shipping user-visible behavior, API
  surface, env vars, or test policy (`README.md`, `docs/plan.md`,
  `docs/technical-spec.md`, `docs/backlog.md`, `docs/testing-strategy.md`,
  `docs/openapi.yaml`). Use small targeted edits, not rewrites.
- **Local environment:** `npm run db:up` (which invokes
  `node bin/container.mjs compose up -d db`, auto-detecting podman or
  docker) starts `pto-calendar-db` (postgres:16-alpine) on `:5432`;
  backend dev runs on `:3000` (use `setsid` to detach), Vite on `:5173`.
  E2E specs that write data run on the desktop `chromium` project only;
  the `mobile-chrome` project uses `testMatch` to run only read-only
  specs. See `docs/podman.md` for the Podman path.
