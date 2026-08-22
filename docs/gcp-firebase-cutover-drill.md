# GCP/Firebase Cutover & Disaster Recovery Drill

This runbook validates the preserved GCP/Firebase fallback deployment (Cloud Run
API + Firebase Hosting SPA + Supabase Postgres). OCI is now the primary
production path. It is split into two halves:

- **Cutover** — the first-time deployment of a clean Supabase project.
- **DR drill** — periodic validation that backups restore, rollbacks work,
  and the rollback path doesn't leave the database in a broken state.

Each step is a single observation + checkbox. Fill the template at the end
and attach it to the issue that closes the cutover / drill.

## Prerequisites

- Google Cloud, Firebase, and Supabase projects configured per
  [`gcp-firebase-deploy.md`](gcp-firebase-deploy.md) § 1–§ 4.
- GitHub repository variables / secrets set per
  [`gcp-firebase-deploy.md`](gcp-firebase-deploy.md) § 4.
- A workstation with `gcloud`, `firebase-tools`, `psql`, `pg_dump`, and
  `gpg` on `PATH`. The repo provides `bin/backup-db.mjs` and
  `bin/restore-backup.mjs` so manual backup / restore is a single shell
  command; see [`docs/database-backups.md`](database-backups.md).
- A disposable Supabase project (or local Postgres container) for the
  restore-drill target. Do not run restores against production.

## Cutover

### 1. Apply Prisma migrations to a clean Supabase project

From a workstation, run `prisma migrate deploy` against the Supabase
direct URL (or session-mode URL if the runner cannot reach the direct
endpoint):

```bash
DATABASE_URL='<supabase-direct-or-session-url>' \
  npx prisma migrate deploy --schema=backend/prisma/schema.prisma
```

Verify:

- [ ] `prisma migrate deploy` exits `0` with `No pending migrations to apply`
      (or every migration listed is applied).
- [ ] `SELECT MAX(migration_name) FROM _prisma_migrations;` returns the
      most recent migration in `backend/prisma/migrations/`.

### 2. Deploy the Cloud Run API

Push a commit to `master` (or run `gh workflow run deploy.yml`). The
  `Deploy GCP fallback` workflow builds `backend/Dockerfile`, runs the
migration once, and rolls out the Cloud Run revision. Watch the run at
`https://github.com/<org>/<repo>/actions/workflows/deploy.yml`.

Verify:

- [ ] Backend unit, integration, frontend, lint, typecheck, build,
      coverage-gate, Docker smoke, and E2E jobs all green before the
      deploy job fires (the deploy is gated on CI success).
- [ ] `Deploy Cloud Run backend` job green.
- [ ] `Deploy Firebase Hosting frontend` job green (cross-origin
      /health + SPA /auth/me smoke tests pass).
- [ ] Image tag in Artifact Registry matches the commit SHA on `master`.

### 3. Smoke-test the deployed API directly

The Cloud Run service URL is in the `deploy` job output (`service_url`):

```bash
SERVICE_URL="$(gh run view <run-id> --json outputs --jq '.jobs | map(select(.name=="deploy")) | .[0].outputs.service_url')"
curl --fail --silent --show-error --max-time 30 "${SERVICE_URL}/health"
curl --fail --silent --show-error --max-time 30 "${SERVICE_URL}/ready"
```

Verify:

- [ ] `/health` returns `{"status":"ok"}` with `200`.
- [ ] `/ready` returns `{"status":"ok","db":"up",...}` with `200`. A `503`
      here means the runtime SA cannot reach the Supabase URL or the
      pooled `DATABASE_URL` secret is wrong.
- [ ] `gcloud run services describe pto-api --region=<region>` shows
      `min-instances: 0` and `max-instances: 3` (initial cap).

### 4. Bootstrap the first team lead

The development seed never runs in production. Use the documented
bootstrap command from [`gcp-firebase-deploy.md`](gcp-firebase-deploy.md) § 7:

```bash
DATABASE_URL='<supabase-direct-or-session-url>' \
LEAD_EMAIL='<lead-email>' \
LEAD_NAME='Team Lead' \
APP_PUBLIC_BASE_URL='https://<firebase-project>.web.app' \
  npm run db:bootstrap -w backend
```

Verify:

- [ ] The command prints a one-time setup link of the form
      `https://<firebase-site>/setup-account#token=<token>`.
- [ ] Opening the link in a browser lets you set a password and lands
      on the calendar.
- [ ] Re-running the command with the same email prints
      `Lead already set up (<email>, id=<id>). Nothing to do.` (idempotent).

### 5. Smoke-test the SPA at the Firebase origin

```bash
SITE_URL="https://<firebase-project>.web.app"
curl --fail --silent --show-error --max-time 30 "${SITE_URL}/" | grep -q 'id="root"'
curl --fail --silent --show-error --max-time 30 -H "Origin: ${SITE_URL}" "${SERVICE_URL}/health"
```

Verify:

- [ ] SPA root returns HTML containing `<div id="root">`.
- [ ] Cloud Run `/health` accepts the Firebase origin in `Origin`
      (returns `200`, not a `403` from `csrfOriginMiddleware`).

### 6. End-to-end critical journeys against the production site

Open `https://<firebase-project>.web.app`, log in as the lead you just
created, and exercise the critical journeys:

- [ ] **Login** — submit email + password, lands on the calendar.
- [ ] **Logout** — sign-out button returns to `/login` and `/auth/me`
      returns `401`.
- [ ] **Account setup** — `db:bootstrap` link completes the
      password-set flow.
- [ ] **Session persistence** — reload the page; session survives.
- [ ] **CSRF rejection** — make a state-changing request from a
      different origin (e.g. `curl -X POST -H "Origin: https://evil.example"
      ${SERVICE_URL}/pto`) and verify a `403`.
- [ ] **PTO CRUD** — create, edit, and delete a single-day and a
      multi-day PTO; both render in the calendar.
- [ ] **Holidays** — load `/admin/holidays`, add a US holiday, and
      confirm the badge appears on the calendar.
- [ ] **Role enforcement** — log in as a `member` (create via the
      admin /users page), confirm `/admin/holidays` is hidden, and
      confirm a member cannot edit another user's PTO.

### 7. Verify Cloud Run autoscaling settings

```bash
gcloud run services describe pto-api \
  --region=<region> \
  --format='yaml(spec.template.metadata.annotations,spec.template.spec.containerConcurrency,spec.template.spec.containers[0].resources.limits,spec.template.metadata.labels)'
```

Verify:

- [ ] `run.googleapis.com/minScale: "0"` (scale-to-zero).
- [ ] `run.googleapis.com/maxScale: "3"` (initial cap).
- [ ] No `run.googleapis.com/cpu-throttling` change — billing is
      request-based.
- [ ] `revision.containers[].resources.limits.cpu` and `memory` are at
      the Cloud Run defaults for the configured concurrency.

### 8. Cold-start observation

Hit `/health` after a 5-minute idle, then time the first request:

```bash
SERVICE_URL="https://<cloud-run-host>"
sleep 300
time curl --fail --silent --show-error --max-time 60 "${SERVICE_URL}/ready"
```

Record:

- [ ] Time from first byte to `200 OK` (cold-start latency).
- [ ] Container instance count reported by
      `gcloud run services describe ... --format='value(status.traffic)'`.

## DR Drill

Run the DR drill on a schedule (e.g. quarterly) and after any change to
the deployment pipeline. The drill exercises both the
"restore-from-backup" path and the "rollback" path; neither touches
production data.

### 9. Restore one encrypted backup to a disposable target

Pick the most recent backup that the daily workflow produced (the
filename contains the UTC timestamp). Restore it into a disposable
Supabase project (or local Postgres) — never into production:

```bash
BACKUP_BUCKET='<backup-bucket>' \
TARGET_DATABASE_URL='<disposable-target-url>' \
ENCRYPTION_KEY='<passphrase>' \
  node bin/restore-backup.mjs \
    --archive pto-<timestamp>.tar.gz.gpg \
    --allow-disposable-target
```

Verify:

- [ ] `sha256sum --check` of the downloaded archive passed.
- [ ] GPG decryption succeeded without `gpg: WARNING: encrypted data...`.
- [ ] `psql --variable=ON_ERROR_STOP=1 --file schema.sql` and
      `data.sql` exited `0`.
- [ ] `SELECT COUNT(*) FROM users;` matches the source.
- [ ] `SELECT COUNT(*) FROM pto_requests;` matches the source.
- [ ] `SELECT COUNT(*) FROM holidays;` matches the source.
- [ ] `SELECT COUNT(*) FROM audit_logs;` matches the source.
- [ ] Login with a restored account works against the disposable
      Cloud Run revision.
- [ ] A `member` cannot edit a `team_lead`'s PTO on the restored DB
      (authorization rules survive the round-trip).

### 10. Cloud Run revision rollback

Cloud Run keeps every previous revision's image, so a rollback is a
traffic shift. Pick an earlier revision by commit SHA:

```bash
gcloud run revisions list \
  --service=pto-api \
  --region=<region> \
  --format='table(metadata.name,metadata.creationTimestamp)'
gcloud run services update-traffic pto-api \
  --region=<region> \
  --to-revisions=pto-api-<previous-revision>=100
```

Verify:

- [ ] `/health` returns `200` from the rolled-back revision.
- [ ] `/ready` returns `200` (the previous revision's Prisma client
      connects to the current schema).
- [ ] If the previous revision depended on a migration that has since
      been rolled forward, the rollback will *not* work — record the
      observation and rely on the backup restore (step 9) instead.
      Forward-only migrations are documented in
      [`gcp-firebase-deploy.md`](gcp-firebase-deploy.md) § 8.

### 11. Recovery time observation

Time the full restore drill (step 9):

- Start: download begins.
- End: `psql --file data.sql` exits `0`.

Record:

- [ ] Elapsed recovery time (start → end).
- [ ] Backup age (archive timestamp → drill start).
- [ ] Total bytes restored.
- [ ] Any failures and how they were remediated.

## Cutover / Drill Log Template

Fill this in and attach it to the closing issue / ticket.

| Field | Value |
| --- | --- |
| Date | |
| Operator | |
| Commit SHA | |
| Cloud Run service URL | |
| Firebase Hosting URL | |
| Supabase project reference | |
| Migration version | `SELECT MAX(migration_name) FROM _prisma_migrations;` |
| Cold-start latency (s) | |
| Restore target | |
| Backup archive | `pto-<timestamp>.tar.gz.gpg` |
| Backup age at restore start | |
| Restore duration (s) | |
| Rollback revision | `pto-api-<name>` |
| Rollback succeeded | yes / no |
| Failures & remediations | |
| Follow-ups | |

The "Failures & remediations" row is the most valuable input for the
next cutover. If any checkbox above is unchecked, the cutover is
**not** complete — file a follow-up issue before declaring the GCP fallback
healthy. Do not retire the OCI deployment unless the active production decision
has deliberately changed again.
