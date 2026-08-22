# Database Backups and Migration

This document covers the one-time Supabase-to-OCI migration and the ongoing
OCI PostgreSQL backup flow. The Supabase backup workflow remains available for
the GCP/Firebase fallback path.

## Backup Decision

Supabase automatically backs up Pro, Team, and Enterprise projects. The
retention is plan-dependent. Supabase Free projects do not provide downloadable
managed backups, so this application uses external logical backups.

The repository workflow `.github/workflows/database-backup.yml` is the
Supabase-source backup flow. It currently runs on the repository's configured
weekly schedule and can also be started manually. Before the OCI cutover,
update the `pto-backup-db-url` secret to an IPv4-compatible Supabase pooler URL:
the direct `db.<project>.supabase.co` endpoint fails on runners without IPv6.
The workflow:

1. Dumps the `public` schema with the Supabase CLI.
2. Dumps public data separately using `--data-only --use-copy`.
3. Archives and encrypts both files with AES-256.
4. Uploads the encrypted archive and checksum to a private Google Cloud
   Storage bucket.

The bucket lifecycle file in `infra/gcp/backup-lifecycle.json` deletes objects
after 30 days. Change the retention only after confirming the storage cost and
recovery requirement.

## Operator Scripts

The same flow is available locally through two helper scripts so operators do
not have to remember the exact invocation:

- `bin/backup-db.mjs` — dump, encrypt, upload. Mirrors the GitHub Actions
  workflow. Requires `DATABASE_URL`, `BACKUP_BUCKET`, `ENCRYPTION_KEY` env vars
  plus `supabase` (preferred) or `pg_dump`, `gpg`, `tar`, `sha256sum`, and
  `gcloud` on `PATH`.
- `bin/restore-backup.mjs` — download, verify, decrypt, apply. Requires
  `BACKUP_BUCKET`, `TARGET_DATABASE_URL`, `ENCRYPTION_KEY` env vars plus
  `gpg`, `tar`, `sha256sum`, `gcloud`, and `psql` on `PATH`. It also requires
  the explicit `--allow-disposable-target` confirmation flag.

Both scripts mask secrets where GitHub Actions does, set `umask 077` on the
working directory, and never echo secret values back to the terminal.
They reject encryption keys shorter than 32 characters, low-diversity keys, and
common placeholder prefixes. Failed child processes throw through the top-level
cleanup path so temporary plaintext, decrypted archives, and passphrases are
removed before exit.

## One-Time GCP Setup for the Supabase Source

Create a private bucket in the same region as the Cloud Run service:

```bash
gcloud storage buckets create gs://<backup-bucket> \
  --project=<gcp-project-id> \
  --location=<gcp-region> \
  --uniform-bucket-level-access

gcloud storage buckets update gs://<backup-bucket> \
  --lifecycle-file=infra/gcp/backup-lifecycle.json
```

Enable public access prevention and grant the backup service account only:

- Object Creator for scheduled uploads.
- Object Viewer for restore operations.

Create these Secret Manager entries:

- `pto-backup-db-url`: direct Supabase URL when the runner supports IPv6, or
  the shared pooler session URL otherwise.
- `pto-backup-encryption-key`: a high-entropy passphrase stored only in Secret
  Manager.

Generate a key from random bytes rather than a human phrase:

```bash
openssl rand -base64 32
```

The backup service account needs Secret Manager access to those two secrets
and object-create access to the bucket. GitHub Actions authenticates through
Workload Identity Federation.

## OCI Object Storage Backups

After the cutover, OCI is the source of truth. The VM's
`infra/deploy/backup.sh` script dumps the public schema and data from the
PostgreSQL container, encrypts the archive with AES-256, and uploads the
archive and checksum to a private OCI Object Storage bucket using instance
principal authentication.

The required runtime values are stored in the VM's mode `0600` `.env` file:

- `BACKUP_ENCRYPTION_KEY`
- `OCI_BACKUP_BUCKET`
- `OCI_OBJECT_STORAGE_NAMESPACE`
- `OCI_REGION`

The encryption key must also be stored in an external password vault. A VM
local copy alone is not a recovery plan. The Object Storage bucket should have
private access, a retention policy of at least 30 days, and no public
pre-authenticated URL.

The systemd timer runs the backup daily at 03:00 UTC and uses `Persistent=true`
so a missed run is attempted after the VM returns. Check it with:

```bash
sudo systemctl list-timers pto-calendar-backup.timer
sudo journalctl -u pto-calendar-backup.service --since today
```

## Manual Backup

Install the Supabase CLI, then run the helper script:

```bash
DATABASE_URL='<supabase-direct-or-session-url>' \
BACKUP_BUCKET='<backup-bucket>' \
ENCRYPTION_KEY='<passphrase>' \
  node bin/backup-db.mjs [--label <suffix>] [--keep-local]
```

Or invoke `supabase db dump` and the GPG flow manually:

```bash
supabase db dump \
  --db-url "$SUPABASE_DB_URL" \
  --schema public \
  --file schema.sql

supabase db dump \
  --db-url "$SUPABASE_DB_URL" \
  --schema public \
  --data-only \
  --use-copy \
  --file data.sql

tar -czf pto-$(date -u +%Y%m%dT%H%M%SZ).tar.gz schema.sql data.sql
```

The default Supabase CLI dump is schema-only. The second command is required
to include application data. The current application stores its data in the
`public` schema and does not use Supabase Storage objects.

Protect local dump files because they contain names, email addresses, PTO
notes, audit data, and password hashes. Delete plaintext files after creating
an encrypted archive.

## Restore Drill

Restore into a new Supabase project or a disposable local PostgreSQL instance,
not directly over production. The helper script downloads, verifies, decrypts,
and applies the archive:

```bash
BACKUP_BUCKET='<backup-bucket>' \
TARGET_DATABASE_URL='<disposable-target-url>' \
ENCRYPTION_KEY='<passphrase>' \
  node bin/restore-backup.mjs \
    --archive pto-20260810T030000Z.tar.gz.gpg \
    --allow-disposable-target
```

The manual equivalent:

```bash
gcloud storage cp \
  gs://<backup-bucket>/pto/pto-<timestamp>.tar.gz.gpg \
  gs://<backup-bucket>/pto/pto-<timestamp>.tar.gz.gpg.sha256 \
  .

sha256sum --check pto-<timestamp>.tar.gz.gpg.sha256
gpg --decrypt \
  --output pto-<timestamp>.tar.gz \
  pto-<timestamp>.tar.gz.gpg
tar -xzf pto-<timestamp>.tar.gz

# Drop the public schema so the dump's CREATE SCHEMA public can run.
psql "$TARGET_DATABASE_URL" -c 'DROP SCHEMA public CASCADE;'
psql "$TARGET_DATABASE_URL" --variable=ON_ERROR_STOP=1 --file schema.sql
psql "$TARGET_DATABASE_URL" --variable=ON_ERROR_STOP=1 --file data.sql
```

The drop step is required because the pg_dump output includes
`CREATE SCHEMA public;`. `psql` is required (not `prisma db execute`) because
the dump uses psql meta-commands like `\restrict`.

### Restore drill log

Fill in and attach to the OCI migration/recovery ticket (`#166`):

| Field | Value |
| --- | --- |
| Date | |
| Operator | |
| Archive timestamp (UTC) | |
| Source archive path | `gs://<bucket>/pto/pto-<timestamp>.tar.gz.gpg` |
| Target database | |
| Schema version (`SELECT MAX(migration_name) FROM _prisma_migrations;`) | |
| User count (`SELECT COUNT(*) FROM users;`) | |
| PTO request count (`SELECT COUNT(*) FROM pto_requests;`) | |
| Holiday count (`SELECT COUNT(*) FROM holidays;`) | |
| Audit log count (`SELECT COUNT(*) FROM audit_logs;`) | |
| `GET /ready` against restored app | |
| Login test account | |
| PTO create + edit + delete | |
| Authorization rule (`member cannot modify team_lead PTO`) | |
| Elapsed recovery time (start → last validation) | |
| Backup age (archive timestamp → drill start) | |

After restoring:

- Confirm the Prisma migration table is present.
- Confirm users, PTO requests, holidays, and audit logs exist.
- Run `GET /ready` against the restored application.
- Log in with a restored account.
- Confirm a PTO create/edit/delete operation and authorization rules.

Do not run `prisma migrate reset` against a restored production database.
Pending migrations can be applied with `prisma migrate deploy` after verifying
that the restored schema is the expected version.

## Supabase-to-OCI Production Restore

The generic `bin/restore-backup.mjs` command intentionally refuses production
targets and must remain disposable-target-only. For the OCI production target,
copy the encrypted Supabase archive and checksum to the VM and run:

```bash
ssh deploy@<oci-host>
cd /home/deploy
/opt/pto-calendar/infra/deploy/restore-oci.sh \
  --archive pto-<timestamp>.tar.gz.gpg \
  --confirm-production-target
```

The OCI-specific command validates the archive and checksum, stops the
application, creates a pre-restore backup, drops only the target `public`
schema, and applies `schema.sql` and `data.sql` through
`docker compose exec -T db psql`. It then verifies Prisma migrations and
starts the application. It never runs the development seed or overwrites the
restored users.

## Retention and Recovery

The OCI policy keeps at least 30 encrypted daily archives in Object Storage.
This gives an expected maximum backup age of approximately 24 hours, excluding
workflow or VM failures. Review the systemd journal and Object Storage object
timestamps after every scheduled run and investigate any missed backup.

If the database is business-critical, upgrade Supabase to a paid plan for
managed daily backups. Point-in-time recovery is a separate paid capability.
Supabase Free projects may also be paused after prolonged low activity, so
availability requirements should be reviewed separately from backup retention.
