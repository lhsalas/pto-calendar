# Production Deployment & Operations

This runbook deploys PTO Calendar as a Node/Express API on Google Cloud Run,
a static Vite SPA on Firebase Hosting, and PostgreSQL on Supabase.

```text
Browser -> Firebase Hosting (frontend/dist)
       -> Cloud Run (Node + Express + Prisma)
       -> Supabase PostgreSQL
```

Firebase Hosting is intentionally used for static files only. Do not add a
Firebase Hosting `run` rewrite for this application: Firebase strips incoming
cookies for Cloud Run rewrites except for a cookie named `__session`, while
`cookie-session` uses a session cookie and a separate signature cookie.

## 1. Required Accounts and Projects

You need:

- A Google Cloud project with billing enabled.
- A Firebase project associated with that Google Cloud project. The Firebase
  project can live in a different GCP project, but both projects must be in
  the same Google Cloud organization so that a single Workload Identity
  Federation pool can mint short-lived tokens for either project.
- A Supabase project.
- A GitHub repository administrator who can configure Actions variables,
  secrets, and Workload Identity Federation.

Cloud Run has a monthly free tier, but billing is still required. Firebase
Hosting may move the project to the Blaze billing plan when Google Cloud
services are used. Set a Google Cloud budget alert before deploying.

Choose a Cloud Run region close to the Supabase project and users. For a
North American internal team, `us-central1` is a reasonable starting point.

## 2. Create the Supabase Project

Create a PostgreSQL project and record:

- The project reference.
- The database password.
- The shared pooler **session-mode** connection string.
- A direct connection string, or a session-mode connection string usable by
  the migration and backup runner.

Use the session pooler URL for the running Cloud Run service. Add a small
Prisma connection limit, for example:

```text
postgres://postgres.<project-ref>:<password>@aws-<region>.pooler.supabase.com:5432/postgres?schema=public&connection_limit=5
```

Use the direct connection URL only for one-off migrations and database dumps.
If the direct endpoint is not reachable from the runner, use the Supabase
shared pooler session URL for those commands.

Do not put Supabase browser keys in the frontend. This application keeps its
existing custom cookie-session authentication and accesses PostgreSQL only
from the backend.

## 3. Create Google Cloud Resources

Enable these APIs:

```bash
gcloud services enable \
  artifactregistry.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com \
  iamcredentials.googleapis.com
```

Create an Artifact Registry Docker repository:

```bash
gcloud artifacts repositories create pto-calendar \
  --repository-format=docker \
  --location=us-central1
```

Create Secret Manager entries for:

- `pto-session-secret`
- `pto-database-url` containing the Supabase session-pooler URL
- `pto-direct-url` containing the migration/backup URL
- `pto-rate-limit-redis-url` containing a TLS Redis/Valkey URL for the shared
  login and global rate-limit stores

Create separate deployment and runtime service accounts. Grant only the
permissions needed for Artifact Registry, Cloud Run deployment, Secret
Manager access, and Firebase Hosting deployment. If the Firebase project
is in a different GCP project than the Cloud Run project, the deployment
service account must additionally be granted `roles/firebasehosting.admin`
(or a narrower custom role) on the Firebase project — see
[Firebase Hosting IAM roles](https://firebase.google.com/docs/hosting/admin-intro#grant-access).
Configure GitHub Actions Workload Identity Federation instead of storing
a JSON service-account key.

## 4. Configure GitHub Actions

Set repository variables:

| Variable | Example |
|---|---|
| `PRODUCTION_DEPLOY_ENABLED` | `true` |
| `GCP_PROJECT_ID` | `my-project` |
| `GCP_REGION` | `us-central1` |
| `GCP_ARTIFACT_REGISTRY_REPOSITORY` | `pto-calendar` |
| `FIREBASE_PROJECT_ID` | `my-project` |
| `FIREBASE_SITE_ORIGIN` | `https://my-project.web.app` |
| `GCP_DIRECT_URL_SECRET` | `pto-direct-url` |
| `GCP_DATABASE_URL_SECRET` | `pto-database-url` |
| `GCP_SESSION_SECRET_SECRET` | `pto-session-secret` |
| `GCP_RATE_LIMIT_REDIS_URL_SECRET` | `pto-rate-limit-redis-url` |
| `GCP_RUNTIME_SERVICE_ACCOUNT` | `pto-runtime@my-project.iam.gserviceaccount.com` |

Set repository secrets:

- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_DEPLOY_SERVICE_ACCOUNT`
- `GCP_BACKUP_SERVICE_ACCOUNT`

The `Deploy production` workflow is triggered by a semver tag push
(`v*.*.*`) on `master`, or manually through `workflow_dispatch` from `master`.
The tag is the image tag (`pto-api:v1.0.0`), so each release has a
human-readable label in both Artifact Registry and Cloud Run revisions. A
manual dispatch uses the commit SHA as the image tag. Both paths validate
that a successful `CI` push run for the exact commit exists before cloud
authentication and deployment begin. Both Cloud Run and Firebase deployment
jobs use the protected `production` environment, so configure required
reviewers and restrict its deployment branches to `master`. The workflow
builds `backend/Dockerfile`, pushes an image, applies migrations once, and
deploys Cloud Run.

Four workflows ship deploys; see
[§8 Releasing a Version](#8-releasing-a-version) for the decision tree.

| Workflow | Trigger | Image | Frontend | Migrations | Firebase |
|---|---|---|---|---|---|
| `deploy.yml` | tag `v*.*.*` push OR master dispatch | builds + tags with the git tag | builds + deploys | yes | yes |
| `deploy-backend.yml` | `workflow_dispatch` (image_tag required) | reuses Artifact Registry image | no | yes | no |
| `deploy-frontend.yml` | `workflow_dispatch` | n/a | builds + deploys | no | yes |
| `deploy-secrets.yml` | `workflow_dispatch` (image_tag optional) | reuses Artifact Registry image | no | no | no |

## 5. Deploy the Backend

The workflow configures the service with:

- Node.js 24 on pinned container base images.
- Container port `3000`.
- Request-based billing.
- Minimum instances `0`.
- Maximum instances `3` initially.
- Public invocation, because the application performs its own cookie-session
  authentication.
- `TRUST_PROXY_HOPS=1`.
- A shared TLS Redis/Valkey rate-limit store through `RATE_LIMIT_REDIS_URL`.
- `COOKIE_SECURE=true` and `COOKIE_SAME_SITE=none`.
- Exact `CORS_ORIGIN` equal to the Firebase production origin.

Cloud Run injects `PORT`; the application listens on that value. A cold start
after inactivity is expected with minimum instances set to zero.

The Redis URL is read from Secret Manager and is required in production. Use a
private TLS Redis/Valkey endpoint reachable from Cloud Run, and keep the
`GCP_RATE_LIMIT_REDIS_URL_SECRET` repository variable pointed at the matching
Secret Manager entry. If the shared store is unavailable, the rate-limit
middleware fails the request instead of silently falling back to a per-instance
counter.

Migrations run before traffic is deployed using `pto-direct-url`. Never run
`prisma migrate deploy` from every application container startup.

Verify the deployed service:

```bash
gcloud run services describe pto-api \
  --region=us-central1 \
  --format='value(status.url)'

curl -fsS https://<cloud-run-host>/health
curl -fsS https://<cloud-run-host>/ready
```

`/health` verifies process liveness. `/ready` verifies database reachability.

## 6. Deploy Firebase Hosting

The committed `firebase.json` points Hosting at `frontend/dist` and provides
the SPA fallback and security headers. Its CSP contains a Cloud Run origin
placeholder; always render `firebase.deploy.json` with the exact deployed API
origin before publishing.

The frontend build must receive the Cloud Run origin:

```bash
VITE_API_BASE_URL=https://<cloud-run-host> npm run build -w frontend
CLOUD_RUN_ORIGIN=https://<cloud-run-host> node bin/render-firebase-config.mjs
npx --yes firebase-tools@15.26.0 deploy \
  --config firebase.deploy.json \
  --only hosting \
  --project <firebase-project-id> \
  --non-interactive
```

The production API client already sends `credentials: 'include'`. The
backend must use:

```text
CORS_ORIGIN=https://<firebase-project>.web.app
COOKIE_SECURE=true
COOKIE_SAME_SITE=none
COOKIE_DOMAIN=
```

The backend rejects state-changing requests whose `Origin` or `Referer` does
not match `CORS_ORIGIN`. This is required because `SameSite=None` is needed
when the default Firebase and Cloud Run hostnames are different sites.

If custom domains are added later, use an application domain and API domain
under the same parent domain, then reevaluate whether `COOKIE_SAME_SITE=lax`
is sufficient. Keep the Origin check enabled.

## 7. First-Time Application Bootstrap

Do not run the development seed in production. After the first migration,
run the bootstrap command from a trusted machine or a one-off container using
the direct database URL:

```bash
DATABASE_URL='<supabase-direct-or-session-url>' \
LEAD_EMAIL='lead@yourcompany.com' \
LEAD_NAME='Team Lead' \
APP_PUBLIC_BASE_URL='https://<firebase-project>.web.app' \
  npm run db:bootstrap -w backend
```

Open the one-time setup URL printed by the command and set the lead password.
The command is idempotent. It does not print or store a password.

Optional holiday presets can be loaded after bootstrap:

```bash
DATABASE_URL='<supabase-direct-or-session-url>' \
LEAD_EMAIL='lead@yourcompany.com' \
  npm run db:seed-holidays -w backend -- --all
```

## 8. Releasing a Version

Production deploys follow a tag-based release model. The main pipeline
(`deploy.yml`) runs only when a semver tag is pushed; the three targeted
workflows stay `workflow_dispatch` only.

### Cutting a release ("ship v1.2.0")

```bash
git checkout master && git pull
git tag -a v1.2.0 -m "Release v1.2.0"
git push origin v1.2.0
```

What happens:

1. `CI` runs on the tag push (it also runs on `tags: ['v*.*.*']`).
2. `Deploy production` runs in parallel, but its first step is
   `Verify CI succeeded for this commit`, which polls for the CI run
   (up to 6 × 15 s) before doing anything else.
3. After the gate passes, the deploy starts: image build + push
   (`pto-api:v1.2.0`), Prisma migrations, Cloud Run rollout, Firebase
   Hosting publish, and the cross-origin smoke test.

The tag is rejected with a clear `::error::` if it does not match
`^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`. A
typo (`v1.0`, `v1`) silently falls through GitHub's tag filter, so the
explicit validation is defensive.

### Picking the right workflow

| Action | Workflow |
|---|---|
| Cutting a release (`ship v1.2.0`) | push tag `v1.2.0` → `deploy.yml` |
| Rotating a secret | `deploy-secrets.yml` (manual) |
| Backend-only hotfix between releases | `deploy-backend.yml` (manual, with image tag) |
| UI / copy change between releases | `deploy-frontend.yml` (manual) |
| Re-running a failed deploy | re-dispatch the original workflow (manual path) |

### Tag-based image traceability

The Docker image is tagged with the git tag, not the commit SHA:

```text
${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${GCP_ARTIFACT_REGISTRY_REPOSITORY}/pto-api:v1.2.0
```

Listing revisions and listing Artifact Registry images both reference the
same human-readable tag. The Cloud Run revision name keeps the existing
suffix convention (`pto-api-00042-abc`); the `abc` portion is the short
commit SHA at the time of the tag.

### Why a separate workflow for each surface

- **Secrete rotation only** (the canonical case from the recent
  `pto-rate-limit-redis-url` swap): the image does not change, no
  migration is needed, and the frontend bundle is identical. A full
  pipeline is wasteful. `deploy-secrets.yml` only runs
  `gcloud run services update` with the same `--update-env-vars` and
  `--update-secrets` flags as the main pipeline, and finishes in under
  60 seconds on a warm cache.
- **Backend-only hotfix** (e.g. a Prisma migration between releases):
  `deploy-backend.yml` reuses an existing Artifact Registry image
  (built by a prior `deploy.yml` push or by a local build) and only
  runs the migrations + Cloud Run rollout.
- **Frontend-only change** (e.g. a copy fix in a Vite component):
  `deploy-frontend.yml` resolves the current Cloud Run service URL
  dynamically via `gcloud run services describe`, builds the SPA, and
  publishes to Firebase Hosting. No backend rebuild.

### Concurrency and rollback

All four workflows use `cancel-in-progress: false` with their own
concurrency group (`production-deploy`, `production-deploy-secrets`,
`-backend`, `-frontend`). The first run to claim a group blocks
subsequent runs in the same group, so there is never more than one
deploy per surface in flight.

#### Finding a previous revision

List revisions newest first; the most recent ready revision is the live one:

```bash
gcloud run revisions list \
  --service=pto-api \
  --region=us-central1 \
  --format='table(metadata.name,status.conditions[0].status,metadata.creationTimestamp)'
```

A revision's name looks like `pto-api-00042-abc`. The `abc` portion is the
short commit SHA — cross-reference it with the commit history to find the
exact commit you want to roll back to.

#### Rolling traffic back

Move 100 % of traffic to an older revision. Cloud Run keeps the previous
revision's container image around, so this is a label switch, not an image
rebuild:

```bash
gcloud run services update-traffic pto-api \
  --region=us-central1 \
  --to-revisions=pto-api-00041-abc=100
```

Note that rollback restores the previous revision's image, not the
previous tag. Verify the rollback with `/health` and `/ready` against
the service URL, then check Cloud Logging for the new revision's startup
logs.

#### Migrations are forward-only

`prisma migrate deploy` is run once before each new revision. Database
migrations are forward-only: rolling back application code requires that the
previous revision's schema is compatible with the current database state. If
the previous revision expected an older schema, roll forward with a new
migration rather than rolling back the code.

If a migration is partially applied and the application is in a broken state,
do not roll back the Cloud Run revision. The correct recovery path is the
encrypted backup restore documented in
[`docs/database-backups.md`](database-backups.md), applied to a disposable
target first and then promoted.

## 9. Monitoring and Cost Controls

- Keep Cloud Run minimum instances at `0` unless cold-start latency becomes a
  real problem.
- Keep a maximum instance limit until Supabase connection usage is measured.
- Monitor Cloud Run request count, latency, container restarts, and logs.
- Monitor Supabase database size and connection usage.
- Configure a Google Cloud budget alert.
- Remember that Artifact Registry, Cloud Storage, network egress, and usage
  above free quotas can still incur charges.

## 10. Backups

Supabase Free does not provide downloadable managed backups. The repository
contains a scheduled encrypted logical backup workflow and a separate restore
runbook in [`docs/database-backups.md`](database-backups.md).

Do not store backups on Cloud Run local disk. Cloud Run storage is ephemeral.

## 11. Cutover and Disaster Recovery Drill

After the first deployment and on a quarterly cadence, run the
production cutover + DR drill checklist in
[`docs/cutover-drill.md`](cutover-drill.md). It exercises every step
the cutover ticket will require: clean-schema migrations, the
`db:bootstrap` lead, end-to-end Firebase-origin critical journeys,
Cloud Run autoscaling verification, a backup restore into a disposable
target, and a Cloud Run revision rollback. Fill the log template at
the end of the runbook and attach it to the closing issue.
