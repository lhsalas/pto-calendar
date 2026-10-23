# OCI Release Acceptance and Recovery Drill

Use this checklist for OCI releases and recurring recovery drills. The original
database migration is complete. Recovery uses OCI backups and known-good OCI
releases, not the retired deployment path.

## Preconditions

- [ ] The OCI VM is ARM64 Ubuntu 22.04/24.04 with a reserved public IP.
- [ ] The production hostname resolves to OCI and has a valid TLS certificate.
- [ ] OCI Object Storage bucket, instance-principal policy, and lifecycle are
      configured.
- [ ] Upstash `rediss://` connectivity has been tested from the VM.
- [ ] The exact release tag and commit SHA are recorded.
- [ ] The daily OCI backup timer has a successful scheduled run.
- [ ] A downloaded encrypted OCI archive and checksum are available.
- [ ] Backup decryption keys and runtime recovery values are recoverable
      outside the VM; the four GitHub OCI recovery copies are retained.

## Backup Source Record

Record these values for the backup used in the drill:

| Field | Value |
|---|---|
| Date/time UTC | |
| Operator | |
| OCI bucket and object path | |
| Source migration version | |
| Users | |
| PTO requests | |
| Holidays | |
| Audit logs | |
| Backup archive | |
| Backup checksum verified | yes / no |

## Release and Restore Acceptance

1. [ ] Deploy an exact CI-tested release ref; record its commit SHA.
2. [ ] Restore a downloaded archive into an isolated disposable PostgreSQL
       target using `bin/restore-backup.mjs --allow-disposable-target` as
       described in `database-backups.md`. Never point this at production.
3. [ ] Confirm checksum verification, decryption, source migration version,
       and all four table counts; compare to the recorded backup snapshot,
       not a production database that has accepted newer writes.
4. [ ] For an actual VM recovery, provision the replacement with
       `SKIP_BOOTSTRAP=true`, then use only the separate production restore
       confirmation on that explicitly selected replacement VM. Confirm its
       pre-restore backup exists in Object Storage.
5. [ ] Confirm `/health` and `/ready` return `200`.
6. [ ] Confirm the session cookie is secure, HTTP-only, SameSite=Lax, and host-only.
7. [ ] Confirm login and session persistence after a browser reload.
8. [ ] Confirm PTO CRUD, team-lead authorization, and member restrictions.
9. [ ] Confirm an untrusted origin returns `403 CSRF_REJECTED`.
10. [ ] Confirm Upstash-backed rate limiting and Caddy TLS/security headers.
11. [ ] Record restore duration, backup age, scheduled backup timestamp, and
        any failure/remediation without putting credentials in the log.

## Operational Observation

- [ ] Caddy certificate renewal and error logs.
- [ ] Application request logs and request IDs.
- [ ] PostgreSQL volume growth and container restarts.
- [ ] Upstash quota and connection errors.
- [ ] The latest scheduled OCI backup and off-VM object timestamps.
- [ ] A successful backup download, checksum verification, and disposable
      restore.

## Rollback

- [ ] For a code-only failure, deploy a known-good OCI release compatible with
      the current schema; migrations are forward-only.
- [ ] For VM/data loss, recover onto OCI from a verified encrypted backup.
- [ ] Freeze writes and back up current OCI data before any destructive restore.
- [ ] Never route users to a stale legacy database or run development seed data.
- [ ] Record the rollback reason, data state, archive, and follow-up issue.

## Drill Log

| Field | Value |
|---|---|
| OCI hostname | |
| OCI VM OCID | |
| Release tag | |
| Release commit | |
| OCI migration version | |
| Target users | |
| Target PTO requests | |
| Target holidays | |
| Target audit logs | |
| Restore archive | |
| Restore duration | |
| Latest scheduled OCI backup | |
| Rollback tested | yes / no |
| Failures and remediation | |
| Follow-up issue | |
