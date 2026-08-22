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

The Cloud Run/Firebase/Supabase path is preserved as a manual fallback in
[`gcp-firebase-deploy.md`](gcp-firebase-deploy.md). The deferred custom-domain
option is documented in
[`gcp-firebase-custom-domain.md`](gcp-firebase-custom-domain.md).

## 1. Provision the OCI VM

### Compute and storage

- Shape: `VM.Standard.A1.Flex`, preferably 2 OCPUs and 12 GB RAM.
- Image: Ubuntu 22.04 LTS or 24.04 LTS, ARM64/aarch64.
- Boot volume: 50 GB or larger according to the expected database and image
  cache size.
- Reserve the public IP. Do not use an ephemeral IP for a TLS production host.
- Add the tag `pto.role = production` to the instance. The dynamic group
  policy granted to this tag is what allows the VM to call Object Storage
  via the instance principal.
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
| `DB_PASSWORD` | A new URL-safe password for the local PostgreSQL role |
| `SESSION_SECRET` | The exact existing Cloud Run secret, including key-rotation order |
| `RATE_LIMIT_REDIS_URL` | The existing Upstash `rediss://` connection URL |
| `BACKUP_ENCRYPTION_KEY` | A strong key stored separately from the VM |
| `OCI_BACKUP_BUCKET` | Private OCI Object Storage bucket name |
| `OCI_OBJECT_STORAGE_NAMESPACE` | OCI tenancy Object Storage namespace |
| `OCI_REGION` | Region containing the bucket and VM |

The existing `SESSION_SECRET` can be reused. It preserves cryptographic
compatibility for any cookie that is presented to the new service, although a
host-only cookie created for the Cloud Run hostname will not be sent to the OCI
hostname. Users should therefore expect to log in again after the hostname
changes. Their database accounts and password hashes are preserved.

For the Supabase-to-OCI migration, skip bootstrap so no temporary user is
created:

```bash
export HOST=pto.example.com
export CORS_ORIGIN=https://pto.example.com
export ACME_EMAIL=ops@example.com
export RELEASE_REF=v1.1.0
export DB_PASSWORD="$(openssl rand -hex 24)"
export SESSION_SECRET='<copied-from-cloud-run-secret-manager>'
export RATE_LIMIT_REDIS_URL='rediss://<upstash-connection-url>'
export BACKUP_ENCRYPTION_KEY='<strong-key-from-secure-vault>'
export OCI_BACKUP_BUCKET=pto-calendar-backups
export OCI_OBJECT_STORAGE_NAMESPACE=<object-storage-namespace>
export OCI_REGION=<oci-region>
export SKIP_BOOTSTRAP=true

sudo -E bash /tmp/setup.sh
```

`setup.sh` installs Docker Engine and Compose, creates the unprivileged
`deploy` user, checks out the exact release, writes `/opt/pto-calendar/.env`
with mode `0600`, builds the stack, enables the encrypted backup timer, and
waits for `/health` and `/ready`.

The normal production runtime is the slim image. The Compose `bootstrap`
profile intentionally uses the build stage because the runtime image does not
contain `tsx` or the TypeScript source used by `db:bootstrap`.

For a brand-new database instead of a migration, set `SKIP_BOOTSTRAP=false`

```bash
sudo -E bash /tmp/setup.sh
```

Do not run the development seed in production.

## 3. Deploying releases

The OCI deployment workflow is `.github/workflows/deploy-oci.yml`. It runs for
semver tag pushes when the repository variable
`OCI_PRODUCTION_DEPLOY_ENABLED=true`. It checks that CI succeeded for the
exact commit, then connects over SSH with a pinned known-hosts file and runs
the ref-aware deploy script as `deploy`.

Configure these production repository values:

| Variable or secret | Purpose |
|---|---|
| `OCI_PRODUCTION_DEPLOY_ENABLED` | Explicit OCI deployment switch |
| `OCI_HOST` | OCI public hostname |
| `OCI_DEPLOY_USER` | Usually `deploy` |
| `OCI_KNOWN_HOSTS` | Pinned SSH host key entry |
| `OCI_SSH_PRIVATE_KEY` | Dedicated deploy key |

The three GCP workflows remain manual-only and are gated by
`GCP_FALLBACK_DEPLOY_ENABLED`. This prevents a release tag from deploying to
both platforms.

Deploy a release manually on the VM:

```bash
ssh deploy@pto.example.com
cd /opt/pto-calendar
./infra/deploy/deploy.sh v1.1.0
```

`deploy.sh` fetches tags, validates the ref and optional expected commit,
checks for a clean tree, builds the current ARM64 images, runs migrations,
pull or deploy a moving branch.

## 4. Supabase to OCI database migration

Perform this once during a scheduled maintenance window.

### 4.1 Verify the source

Before the final export, record the following from Supabase:

```sql
SELECT MAX(migration_name) FROM _prisma_migrations;
SELECT COUNT(*) FROM users;
SELECT COUNT(*) FROM pto_requests;
SELECT COUNT(*) FROM holidays;
SELECT COUNT(*) FROM audit_logs;
```

Confirm that the source migration list is not ahead of the release being
deployed to OCI. The current release includes the `session_version` migration.

### 4.2 Create and validate the encrypted backup

The existing Supabase backup workflow uses the GCS bucket and encryption flow.
Before relying on it, repair the database URL secret so it contains the
IPv4-compatible Supabase pooler URL. The current direct endpoint fails on
GitHub-hosted runners without IPv6. Then run the workflow manually and verify
that it completes.

The trusted-workstation equivalent is:

```bash
DATABASE_URL='<supabase-direct-or-ipv4-pooler-url>' \
BACKUP_BUCKET='<gcs-backup-bucket>' \
ENCRYPTION_KEY='<backup-key>' \
  node bin/backup-db.mjs --label supabase-oci-cutover
```

The generated archive contains `schema.sql` and `data.sql`, is encrypted with
AES-256, and has a `.sha256` checksum. Restore it into disposable PostgreSQL
using `bin/restore-backup.mjs` before using it for the production target.
Compare all four row counts and the migration table after the disposable
restore.

Keep the final encrypted archive and checksum outside the VM until the OCI
deployment has been accepted.

### 4.3 Freeze writes and prepare OCI

Freeze the Cloud Run application before the final export. The repository does
not provide a read-only application mode, so use a controlled platform-level
maintenance step that blocks Cloud Run invocation, and record how to reverse
it. Keep Cloud Run, Firebase, and Supabase intact for rollback.

On OCI, start PostgreSQL and verify its health. Do not run `db:seed` or
`db:bootstrap`. The restore target is the PostgreSQL container from
`docker-compose.prod.yml`, database `pto`.

Copy only the encrypted archive and checksum to the VM:

```bash
scp pto-<timestamp>.tar.gz.gpg pto-<timestamp>.tar.gz.gpg.sha256 \
  deploy@pto.example.com:/home/deploy/
```

### 4.4 Restore into the PostgreSQL container

Run the dedicated production restore command as `deploy`:

```bash
ssh deploy@pto.example.com
cd /home/deploy
/opt/pto-calendar/infra/deploy/restore-oci.sh \
  --archive pto-<timestamp>.tar.gz.gpg \
  --confirm-production-target
```

The command verifies the checksum, decrypts into a restricted temporary
directory, rejects archive paths other than `schema.sql` and `data.sql`, stops
the application, creates an encrypted pre-restore backup, drops the target
`public` schema, and applies both files through:

```bash
docker compose -f /opt/pto-calendar/docker-compose.prod.yml exec -T db psql ...
```

It then runs `prisma migrate deploy`, starts the application, and checks
`/health` and `/ready`. It leaves the application stopped if any destructive
step fails. Do not pass `--allow-disposable-target`; that flag is reserved for
the generic disposable restore tool.

After restore, compare the source and target row counts, verify
`_prisma_migrations`, log in with a restored account, and test PTO create,
edit, delete, team-lead authorization, CSRF rejection, and session-version
revocation.

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

Keep `BACKUP_ENCRYPTION_KEY` in a separate password vault. Losing the VM and
the key together makes the encrypted backups unrecoverable.

## 6. Disaster recovery and rollback

### Application rollback

Before OCI accepts writes, point DNS back to the previous Firebase/Cloud Run
path or send users to its preserved URL. Re-enable the old Cloud Run service if
the maintenance freeze was implemented through IAM.

After OCI accepts writes, do not switch back to Cloud Run while Supabase is
stale. Freeze writes, create an encrypted OCI backup, restore or synchronize it
into Supabase after a disposable validation, and only then route traffic back.

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

Keep the current Cloud Run/Firebase/Supabase deployment available for the
rollback window. Retire it only after OCI backups and at least one restore drill
have passed.

## 7. Release and recovery tags

`v1.0.0` is an immutable historical OCI snapshot from before the later Cloud
Run migration and security/runtime fixes. The current pre-OCI GCP/Firebase
state is preserved as the non-release tag `pre-oci-master-20260822`.

After the OCI implementation is merged, tested, and deployed, create an
annotated release tag such as:

```bash
git checkout master
git pull --ff-only
git tag -a v1.1.0 -m "OCI production deployment and recovery flow"
git push origin v1.1.0
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
