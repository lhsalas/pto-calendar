# Supabase Database Backups

## Backup Decision

Supabase automatically backs up Pro, Team, and Enterprise projects. The
retention is plan-dependent. Supabase Free projects do not provide downloadable
managed backups, so this application uses external logical backups.

The repository workflow `.github/workflows/database-backup.yml` runs daily at
03:00 UTC and can also be started manually. It:

1. Dumps the `public` schema with the Supabase CLI.
2. Dumps public data separately using `--data-only --use-copy`.
3. Archives and encrypts both files with AES-256.
4. Uploads the encrypted archive and checksum to a private Google Cloud
   Storage bucket.

The bucket lifecycle file in `infra/gcp/backup-lifecycle.json` deletes objects
after 30 days. Change the retention only after confirming the storage cost and
recovery requirement.

## One-Time GCP Setup

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

The backup service account needs Secret Manager access to those two secrets
and object-create access to the bucket. GitHub Actions authenticates through
Workload Identity Federation.

## Manual Backup

Install the Supabase CLI, then run:

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
not directly over production:

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
```

Apply the schema and data to the disposable target using `psql`:

```bash
psql "$TARGET_DATABASE_URL" --single-transaction --file schema.sql
psql "$TARGET_DATABASE_URL" --single-transaction --file data.sql
```

After restoring:

- Confirm the Prisma migration table is present.
- Confirm users, PTO requests, holidays, and audit logs exist.
- Run `GET /ready` against the restored application.
- Log in with a restored account.
- Confirm a PTO create/edit/delete operation and authorization rules.
- Record the restore date, archive timestamp, and elapsed recovery time.

Do not run `prisma migrate reset` against a restored production database.
Pending migrations can be applied with `prisma migrate deploy` after verifying
that the restored schema is the expected version.

## Retention and Recovery

The default policy keeps 30 encrypted daily archives. This gives an expected
maximum backup age of approximately 24 hours, excluding workflow failures.
Review the Actions run history after every restore drill and investigate any
missed scheduled run.

If the database is business-critical, upgrade Supabase to a paid plan for
managed daily backups. Point-in-time recovery is a separate paid capability.
Supabase Free projects may also be paused after prolonged low activity, so
availability requirements should be reviewed separately from backup retention.
