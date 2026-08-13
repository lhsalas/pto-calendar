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
| `GCP_RUNTIME_SERVICE_ACCOUNT` | `pto-runtime@my-project.iam.gserviceaccount.com` |

Set repository secrets:

- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_DEPLOY_SERVICE_ACCOUNT`
- `GCP_BACKUP_SERVICE_ACCOUNT`

The `Deploy production` workflow runs after the `CI` workflow succeeds on
`master`, or manually through `workflow_dispatch`. It builds
`backend/Dockerfile`, pushes an immutable image, applies migrations once, and
deploys Cloud Run.

## 5. Deploy the Backend

The workflow configures the service with:

- Container port `3000`.
- Request-based billing.
- Minimum instances `0`.
- Maximum instances `3` initially.
- Public invocation, because the application performs its own cookie-session
  authentication.
- `TRUST_PROXY_HOPS=1`.
- `COOKIE_SECURE=true` and `COOKIE_SAME_SITE=none`.
- Exact `CORS_ORIGIN` equal to the Firebase production origin.

Cloud Run injects `PORT`; the application listens on that value. A cold start
after inactivity is expected with minimum instances set to zero.

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
the SPA fallback and security headers.

The frontend build must receive the Cloud Run origin:

```bash
VITE_API_BASE_URL=https://<cloud-run-host> npm run build -w frontend
npx firebase-tools deploy \
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

## 8. Release and Rollback

Push to `master` after the normal CI gates pass. The deployment workflow uses
the tested commit SHA as the container tag.

For a rollback, move Cloud Run traffic to the previous revision. Database
migrations are forward-only; only roll back application code when the previous
revision remains compatible with the current schema.

```bash
gcloud run services update-traffic pto-api \
  --region=us-central1 \
  --to-revisions=pto-api-<previous-revision>=100
```

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
