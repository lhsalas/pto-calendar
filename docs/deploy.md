# Production Deployment and Operations

This is the primary production runbook for the OCI Always Free VM. The
production topology is a single public HTTPS hostname backed by Caddy, nginx,
the Node/Express API, and PostgreSQL. The API uses the existing Upstash TLS
Redis store for distributed login and global rate-limit counters.

```text
Browser -> Caddy (TLS + HSTS) -> nginx (SPA + API proxy)
                              -> Node/Express + Prisma
                              -> PostgreSQL 16
                              -> Upstash Redis/Valkey (TLS)
```

OCI is the only supported production deployment. The former GCP/Firebase/
Supabase workflows and runbooks are retired; historical instructions remain in
Git history. This repository cleanup does not delete cloud resources or change
the existing Firebase-to-OCI redirect.

## 1. Provision the OCI VM

### Node.js runtime baseline

The supported Node.js patch level is pinned in `.nvmrc` and is the single
source of truth for the container base image, the CI runtime, and the
`engines.node` floor. `backend/Dockerfile` and `frontend/Dockerfile` reference
`node:<version>-alpine` by digest.

When a new Node.js 24.x security release ships, update together:

1. `.nvmrc`.
2. `MINIMUM_SUPPORTED_VERSION` in `infra/tests/node-version.mjs`.
3. The `FROM` digest in `backend/Dockerfile` and `frontend/Dockerfile`.
4. The `engines.node` floor in the root `package.json`.

`npm run node:baseline:check` fails when these drift, and the Docker smoke
job asserts the built images report at least the pinned runtime.

### Compute and storage

- Shape: `VM.Standard.A1.Flex`, preferably 2 OCPUs and 12 GB RAM.
- Image: Ubuntu 22.04 LTS or 24.04 LTS, ARM64/aarch64.
- Boot volume: 50 GB or larger according to the expected database and image
  cache size.
- Reserve the public IP. Do not use an ephemeral IP for a TLS production host.
- Add the freeform tag `ptorole = production` to the instance (the key
  cannot contain dots — OCI rejects them). The dynamic group policy granted
  to this tag is what allows the VM to call Object Storage via the
  instance principal.
- Keep the PostgreSQL Docker volume persistent. Never use `docker compose down
  -v` on the production stack.

### Network and DNS

Create a DNS `A` record for the selected custom hostname pointing to the
reserved OCI public IP. The hostname must be the same value used by `HOST` and
`CORS_ORIGIN=https://<host>`.

At the OCI VCN/security-list or NSG layer allow:

- TCP 22 from the administrator IP range only.
- TCP 80 from the Internet for ACME HTTP-01 and HTTP to HTTPS redirects.
- TCP 443 from the Internet.

Do not allow public access to ports 3000, 5432, or 6379. Docker publishes only
Caddy's ports; PostgreSQL and the application network remain internal.

Configure a host firewall as a second layer. Apply SSH hardening, disable root
password login, disable SSH password authentication, and enable unattended
security updates without locking out the administrator's key.

### OCI Object Storage

Create a private Object Storage bucket for encrypted application backups. Add
an OCI dynamic group for the VM and a policy that permits the instance
principal to create and read objects only in that bucket. Enable object version
retention or a lifecycle policy of at least 30 days.

The VM needs the OCI CLI installed, but does not need a long-lived OCI API key.
The backup script uses `--auth instance_principal`.

## 2. First-time setup

Install the OCI CLI and copy `infra/deploy/setup.sh` to the VM through a
trusted channel. Setup requires the following values. Never put them in a
commit, issue, tag, or workflow log:

| Variable | Production value |
|---|---|
| `HOST` | The OCI custom hostname without a scheme |
| `CORS_ORIGIN` | Exactly `https://$HOST` |
| `ACME_EMAIL` | Certificate notification address |
| `RELEASE_REF` | An exact release tag, for example `v1.1.0` |
| `OCI_DB_PASSWORD` | URL-safe password for the local PostgreSQL role (16-128 chars) |
| `OCI_SESSION_SECRET` | Existing session signing key from the protected recovery vault |
| `OCI_RATE_LIMIT_REDIS_URL` | GitHub repository secret; Upstash `rediss://` connection URL |
| `OCI_BACKUP_ENCRYPTION_KEY` | GitHub repository secret; strong key for `gpg --symmetric` on daily archives |
| `OCI_BACKUP_BUCKET` | Private OCI Object Storage bucket name |
| `OCI_OBJECT_STORAGE_NAMESPACE` | OCI tenancy Object Storage namespace |
| `OCI_REGION` | Region containing the bucket and VM |

`OCI_DB_PASSWORD`, `OCI_SESSION_SECRET`, `OCI_RATE_LIMIT_REDIS_URL`, and
`OCI_BACKUP_ENCRYPTION_KEY` are GitHub Actions repository secrets (Settings
→ Secrets and variables → Actions → Repository secrets). They are retained
**recovery copies**, not inputs to the deployment workflow. The live application
and backup service read `/opt/pto-calendar/.env`. Keep matching recoverable
copies in a separate password vault: GitHub does not reveal stored secret
values through its UI or API. Do not rotate or delete these values as part of
the deployment sunset.

For a replacement VM that will restore an existing OCI backup, skip bootstrap
so no temporary user is created:

```bash
export HOST=pto.example.com
export CORS_ORIGIN=https://pto.example.com
export ACME_EMAIL=ops@example.com
export RELEASE_REF=v1.1.0
export OCI_SESSION_SECRET='<session signing key from recovery vault>'
export OCI_RATE_LIMIT_REDIS_URL='<Upstash TLS URL from recovery vault>'
export OCI_BACKUP_ENCRYPTION_KEY='<archive encryption key from recovery vault>'
export OCI_DB_PASSWORD='<database password from recovery vault>'
export OCI_BACKUP_BUCKET=pto-calendar-backups
export OCI_OBJECT_STORAGE_NAMESPACE=<object-storage-namespace>
export OCI_REGION=<oci-region>
export SKIP_BOOTSTRAP=true

sudo -E bash /tmp/setup.sh
```

`setup.sh` installs Docker Engine and Compose, creates the unprivileged
`deploy` user, makes a home-installed OCI CLI available to the backup service,
checks out the exact release, writes `/opt/pto-calendar/.env` with mode `0600`,
builds the stack, enables the encrypted backup timer, and waits for `/health`
and `/ready`.

The normal production runtime is the slim image. The Compose `bootstrap`
profile intentionally uses the build stage because the runtime image does not
contain `tsx` or the TypeScript source used by `db:bootstrap`.

For a brand-new database, set `SKIP_BOOTSTRAP=false` and provide `LEAD_EMAIL`

```bash
sudo -E bash /tmp/setup.sh
```

Do not run the development seed in production.

## 3. Deploying releases

The OCI deployment workflow is `.github/workflows/deploy-oci.yml`. It is
gated by `OCI_PRODUCTION_DEPLOY_ENABLED=true` and triggers from two
sources:

- `workflow_run: workflows: [CI], types: [completed]` — fires when the CI
  workflow finishes for any push event. The job filters to tag pushes
  (`refs/tags/v*` or bare `v*.*.*`) and `conclusion=success`; if the filter
  fails the job exits 0 with a `::notice::` so non-tag events do not block
  the queue.
- `workflow_dispatch` — manual deployment. The job still polls the CI check
  runs API for up to 5 minutes (20 × 15 s) before failing.

Because `workflow_run` runs only after CI completes, the deploy never races
the CI gate. The CI itself triggers on the same tag push, runs all eleven
checks, and on success hands off to the OCI deploy via the `workflow_run`
event.

Configure these production repository values:

| Variable or secret | Type | Purpose |
|---|---|---|
| `OCI_PRODUCTION_DEPLOY_ENABLED` | variable | Explicit OCI deployment switch |
| `OCI_HOST` | variable | OCI public hostname (used by HTTP smoke tests and Caddy/CORS) |
| `OCI_DEPLOY_USER` | variable | Usually `deploy`; set to `ubuntu` for the first-time setup.sh run |
| `OCI_KNOWN_HOSTS` | secret | Pinned SSH host key entry |
| `OCI_SSH_HOST` | secret | OCI reserved public IP used to open the SSH connection |
| `OCI_SSH_PRIVATE_KEY` | secret | Dedicated deploy key (private) |

`OCI_HOST` and `OCI_SSH_HOST` are intentionally separate: the production
hostname points at the reserved IP via DNS and is reachable on ports 80 and
443 only, while the deploy workflow SSHes directly to the IP. This keeps the
TLS termination path simple and avoids depending on DNS for the deploy.

There is no direct tag-push trigger in `deploy-oci.yml`: only successful tag
CI or a manually requested, CI-verified ref can deploy. Ordinary master/PR
CI completion does not deploy production.

Deploy a release manually on the VM:

```bash
ssh deploy@<reserved-public-ip>
cd /opt/pto-calendar
./infra/deploy/deploy.sh v1.1.0
```

`deploy.sh` fetches tags, validates the ref and optional expected commit,
checks for a clean tree, builds the current ARM64 images, runs migrations,
restarts the application, and verifies health/readiness. Prefer an immutable
release tag or commit for repeatable recovery.

## 4. Production acceptance

OCI is the source of truth; the one-time database migration is complete.
For every release or recovery, record the exact commit and migration version,
then verify `/health`, `/ready`, login/session persistence, PTO CRUD, team-lead
authorization, CSRF rejection, and the secure host-only SameSite=Lax cookie.

Verify the daily backup timer and an encrypted off-VM archive, and perform a
disposable restore before relying on the recovery path. Use
[`cutover-drill.md`](cutover-drill.md) to record evidence and
[`database-backups.md`](database-backups.md) for the separate disposable and
explicitly confirmed production restore procedures. Do not run development
seed data or bootstrap existing users during recovery.

## 5. Backups and restore

The OCI backup flow is encrypted and off-VM:

- `infra/deploy/backup.sh` dumps the public schema and data from the PostgreSQL
  container.
- It creates an AES-256 encrypted archive and checksum with restrictive file
  permissions.
- It uploads both objects to private OCI Object Storage using an instance
  principal.
- `pto-calendar-backup.timer` runs daily at 03:00 UTC and catches up after
  downtime.
- Temporary plaintext files and passphrase files are removed on success and
  failure.

Run a backup manually:

```bash
ssh deploy@pto.example.com
/opt/pto-calendar/infra/deploy/backup.sh
```

List the timer and inspect its latest result:

```bash
sudo systemctl list-timers pto-calendar-backup.timer
sudo journalctl -u pto-calendar-backup.service --since today
```

For a restore drill, download an encrypted OCI Object Storage archive, copy it
to a disposable VM or isolated PostgreSQL target, and use the same validation
steps. Never run the production restore command against a disposable target or
the disposable restore command against production.

Keep `OCI_BACKUP_ENCRYPTION_KEY`, `OCI_SESSION_SECRET`, `OCI_DB_PASSWORD`,
and `OCI_RATE_LIMIT_REDIS_URL` in GitHub repository secrets and mirror them
into a separate password vault. Losing the VM and the key together makes the
encrypted backups unrecoverable; losing `OCI_SESSION_SECRET` invalidates
every browser session; losing `OCI_DB_PASSWORD` requires recovering
`/opt/pto-calendar/.env` from backup or restoring the database into a new
container with a fresh password.

## 6. Disaster recovery and rollback

### Application rollback

For a code-only problem, deploy a known-good OCI release tag if its Prisma
schema is compatible with the current database. Migrations are forward-only;
do not deploy `v1.0.0` against the current schema because it predates
`session_version`.

### VM recovery

1. Provision a replacement ARM64 OCI VM with the same network and hostname.
2. Install the OCI CLI and configure instance-principal Object Storage access.
3. Run `setup.sh` with the known release tag and the preserved secrets.
4. Restore the latest encrypted OCI backup with `restore-oci.sh`.
5. Verify `/health`, `/ready`, login, authorization, and PTO CRUD.
6. Repoint the reserved IP or DNS record if the original VM cannot be reused.

Recovery stays on OCI. Legacy services are not a supported rollback target:
their database may be stale. Do not route production traffic back to them.

## 7. Release and recovery tags

`v1.0.0` is an immutable historical OCI snapshot from before the later Cloud
Run migration and security/runtime fixes. The current pre-OCI GCP/Firebase
state is preserved as the non-release tag `pre-oci-master-20260822`.

After a change is merged and tested, create a new annotated release tag
(choose the next unused version; never move an existing tag):

```bash
git checkout master
git pull --ff-only
git tag -a vX.Y.Z -m "Describe the tested release"
git push origin vX.Y.Z
```

Protect release tags in GitHub. The OCI workflow deploys the exact tag after
the matching CI run succeeds.

## 8. Monitoring checklist

- Check Caddy certificate renewal and HTTPS responses.
- Check `/health` and `/ready` separately.
- Check PostgreSQL volume usage and Docker image cache usage.
- Check Upstash usage and rate-limit errors.
- Check backup timer status and Object Storage object timestamps.
- Review application logs for request IDs without exposing cookies, tokens, or
  passwords.
- Run a disposable restore drill at least quarterly and after backup-script
  changes.

## 9. GitHub configuration retirement

The repository retirement is tracked in #223, following the local-archive
restore helper in #224. Operational GitHub cleanup is tracked separately in
#222. Before deleting configuration, record successful scheduled OCI backups
and the operator's prior successful OCI restore, merge the workflow retirement,
and confirm no legacy
jobs are queued or running. Verify the OCI deploy path and public probes.

Remove only these obsolete **repository secrets**:

- `GCP_BACKUP_SERVICE_ACCOUNT`
- `GCP_DEPLOY_SERVICE_ACCOUNT`
- `GCP_WORKLOAD_IDENTITY_PROVIDER`

Remove only these obsolete **repository variables**:

- `BACKUP_BUCKET`, `FIREBASE_PROJECT_ID`, `FIREBASE_SITE_ORIGIN`
- `GCP_ARTIFACT_REGISTRY_REPOSITORY`, `GCP_BACKUP_DB_URL_SECRET`
- `GCP_BACKUP_ENCRYPTION_KEY_SECRET`, `GCP_DATABASE_URL_SECRET`
- `GCP_DIRECT_URL_SECRET`, `GCP_FALLBACK_DEPLOY_ENABLED`, `GCP_PROJECT_ID`
- `GCP_RATE_LIMIT_REDIS_URL_SECRET`, `GCP_REGION`
- `GCP_RUNTIME_SERVICE_ACCOUNT`, `GCP_SESSION_SECRET_SECRET`

Retain all six OCI workflow inputs from section 3 and all four recovery secrets
from section 2. Re-inventory names only: expect seven repository secrets and
three variables unless unrelated entries were added. Preserve environment
settings and unrelated configuration. Deleting GitHub entries does not revoke
Google IAM, delete cloud secrets/archives, or alter the Firebase redirect;
cloud teardown requires a separate approved task.
