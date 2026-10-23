# OCI Database Backup and Recovery

OCI PostgreSQL is the production source of truth. Backups run on the VM and
are encrypted before upload to private OCI Object Storage. There is no GitHub
Actions database backup workflow and no GCP dependency in the restore helper.

## Backup Decision

`infra/deploy/backup.sh` dumps `public` schema and data separately, archives
them as `schema.sql` and `data.sql`, encrypts with AES-256, and uploads the
encrypted archive and checksum off-VM. The daily systemd timer replaces the
retired Supabase/GCS schedule. Keep at least 30 daily archives and verify the
bucket's actual lifecycle policy; repository cleanup does not change it.

## Operator Scripts

The supported operator scripts are:

- `infra/deploy/backup.sh` — dump, encrypt, and upload from the OCI VM using
  instance-principal authorization. Reads the VM's protected `.env` file.
- `infra/deploy/restore-oci.sh` — production restore, requiring the separate
  `--confirm-production-target` flag and a pre-restore backup.
- `bin/restore-backup.mjs` — verify, decrypt, and apply a **locally downloaded**
  encrypted archive and its adjacent `.sha256` file. Requires
  `TARGET_DATABASE_URL`, `ENCRYPTION_KEY`, and `gpg`, `tar`, `sha256sum`, and
  `psql` on `PATH`, but no cloud credentials or bucket variable. It requires
  `--allow-disposable-target` and resets the disposable target's `public`
  schema in the same transaction as the schema/data restore.

The scripts set `umask 077` on the working directory and never echo secret
values back to the terminal.
They reject encryption keys shorter than 32 characters, low-diversity keys, and
common placeholder prefixes. Failed child processes throw through the top-level
cleanup path so temporary plaintext, decrypted archives, and passphrases are
removed before exit.

## OCI Object Storage Backups

The VM's `infra/deploy/backup.sh` script dumps the public schema and data from the
PostgreSQL container, encrypts the archive with AES-256, and uploads the
archive and checksum to a private OCI Object Storage bucket using instance
principal authentication.

The required runtime values are stored in the VM's mode `0600` `.env` file:

- `BACKUP_ENCRYPTION_KEY`
- `OCI_BACKUP_BUCKET`
- `OCI_OBJECT_STORAGE_NAMESPACE`
- `OCI_REGION`

The encryption key must also be stored in an external password vault. Keep
`OCI_BACKUP_ENCRYPTION_KEY` in GitHub as a recovery copy, but do not rely on
GitHub to reveal its stored value. A VM-local copy alone is not a recovery
plan. Retain the key for every archive still in retention, including historical
archives encrypted with a different key. The Object Storage bucket should have
private access, a retention policy of at least 30 days, and no public
pre-authenticated URL.

The systemd timer runs the backup daily at 03:00 UTC and uses `Persistent=true`
so a missed run is attempted after the VM returns. Check it with:

```bash
sudo systemctl list-timers pto-calendar-backup.timer
sudo journalctl -u pto-calendar-backup.service --since today
```

## Manual Backup

Run the supported backup script on the OCI VM:

```bash
ssh deploy@<oci-host>
/opt/pto-calendar/infra/deploy/backup.sh
```

Verify the completion log and the matching archive/checksum in Object Storage.
The application stores its data in PostgreSQL's `public` schema.

Protect local dump files because they contain names, email addresses, PTO
notes, audit data, and password hashes. Delete plaintext files after creating
an encrypted archive.

## Restore Drill

Restore into an isolated disposable PostgreSQL instance, never production.
Download an encrypted archive and its matching `.sha256` file from OCI Object
Storage using the console or an authorized operator account. Change into the
download directory, then run the helper with the archive's basename:

```bash
TARGET_DATABASE_URL='<disposable-target-url>' \
ENCRYPTION_KEY='<passphrase>' \
  node /path/to/pto-calendar/bin/restore-backup.mjs \
    --archive pto-20260810T030000Z.tar.gz.gpg \
    --allow-disposable-target
```

Downloading is separate from restoring; the helper never contacts cloud
storage. It verifies the checksum before decrypting, validates archive
members, sanitizes SQL, and restores schema and data in one transaction. A SQL
failure rolls back the target schema reset. Source encrypted files are kept;
temporary plaintext and passphrases are removed on success and failure.

### Target-incompatible SQL

A dump taken from one database can reference roles and settings that the
restore target does not have. The rules that remove them live in two shared
files, `infra/deploy/sql-sanitize-schema.sed` and
`infra/deploy/sql-sanitize-data.sed`, and are applied by the production OCI
restore (`infra/deploy/restore-oci.sh`), the generic disposable restore
(`bin/restore-backup.mjs`), and the backup roundtrip integration test, so the
three cannot drift apart.

They remove source-role metadata (`SET ROLE`, `ALTER ... OWNER TO`,
`ALTER DEFAULT PRIVILEGES`, `GRANT`/`REVOKE`) and the `transaction_timeout`
setting. The last one matters because `transaction_timeout` is a PostgreSQL 17
setting: a `pg_dump` client that is newer than the server emits it even when
the server is PostgreSQL 16, and the target then fails with `unrecognized
configuration parameter "transaction_timeout"`. Keep the client and server
versions in mind when a restore fails to apply.

Use the helper rather than manually extracting or applying SQL. The target
schema reset is required because the dump includes `CREATE SCHEMA public;`.
The helper invokes `psql` because the dump uses psql meta-commands like
`\restrict`; it must not be applied with a generic SQL client.

### Restore drill log

Fill in and attach to the recovery ticket (or sunset verification in #222):

| Field | Value |
| --- | --- |
| Date | |
| Operator | |
| Archive timestamp (UTC) | |
| Source archive path | `oci://<namespace>/<bucket>/pto/pto-<timestamp>.tar.gz.gpg` |
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

## OCI Production Restore

The generic `bin/restore-backup.mjs` command requires explicit disposable-target
confirmation; it cannot determine whether a supplied URL points at production.
The operator must select an isolated disposable database. For the OCI production target,
copy the downloaded encrypted OCI archive and checksum to the VM and run from
their directory, using only the archive basename:

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

This logical-backup flow does not provide point-in-time recovery or database
high availability. Review those requirements separately. Do not delete legacy
cloud archives or their decryption keys as part of the repository/GitHub sunset.
