# OCI Production Cutover and Recovery Drill

Use this checklist for the Supabase-to-OCI migration and for later recovery
drills. The procedure keeps the current Cloud Run/Firebase/Supabase deployment
available until the OCI path is verified.

## Preconditions

- [ ] The OCI VM is ARM64 Ubuntu 22.04 with a reserved public IP.
- [ ] DNS for the production hostname can be pointed to the OCI IP.
- [ ] OCI Object Storage bucket, instance-principal policy, and lifecycle are
      configured.
- [ ] Upstash `rediss://` connectivity has been tested from the VM.
- [ ] The exact release tag and commit SHA are recorded.
- [ ] The current Cloud Run, Firebase, and Supabase deployment is healthy.
- [ ] The Cloud Run backup URL uses an IPv4-compatible Supabase pooler endpoint.
- [ ] A successful encrypted Supabase backup and disposable restore are
      available.

## Source Database Record

Record these values before the final backup:

| Field | Value |
|---|---|
| Date/time UTC | |
| Operator | |
| Supabase project reference | |
| Source migration version | |
| Users | |
| PTO requests | |
| Holidays | |
| Audit logs | |
| Backup archive | |
| Backup checksum verified | yes / no |

## Cutover

1. [ ] Announce the maintenance window and stop new application writes.
2. [ ] Confirm the old Cloud Run API is blocked or in the documented
       maintenance state.
3. [ ] Run the final Supabase logical backup and record its archive name.
4. [ ] Verify its checksum and encryption without leaving plaintext outside a
       restricted temporary directory.
5. [ ] Confirm the final source counts and migration version.
6. [ ] Provision the OCI VM using the exact release ref and `SKIP_BOOTSTRAP=true`.
7. [ ] Start only the OCI PostgreSQL and supporting services needed for restore.
8. [ ] Copy the encrypted archive and checksum to the VM.
9. [ ] Run `restore-oci.sh --confirm-production-target` as `deploy`.
10. [ ] Confirm the restore-created pre-restore backup exists in OCI Object
        Storage.
11. [ ] Confirm target counts and migration version match the source.
12. [ ] Confirm `/health` and `/ready` return `200`.
13. [ ] Confirm the session cookie is secure, HTTP-only, SameSite=Lax, and
        host-only.
14. [ ] Confirm login works with a restored user.
15. [ ] Confirm session persistence after a browser reload.
16. [ ] Confirm PTO create, edit, and delete operations.
17. [ ] Confirm team-lead authorization and member restrictions.
18. [ ] Confirm a state-changing request from an untrusted origin returns
        `403 CSRF_REJECTED`.
19. [ ] Confirm Upstash-backed login and global rate limiting respond as
        expected.
20. [ ] Confirm Caddy TLS, HSTS, CSP, and response security headers.
21. [ ] Point the production DNS record to the OCI reserved IP.
22. [ ] Repeat the browser smoke test through the public hostname.
23. [ ] Re-enable normal traffic only after the public smoke test passes.

## Post-Cutover Observation

Keep the old Cloud Run/Firebase/Supabase deployment intact during the selected
rollback window. Observe:

- [ ] Caddy certificate renewal and error logs.
- [ ] Application request logs and request IDs.
- [ ] PostgreSQL volume growth and container restarts.
- [ ] Upstash quota and connection errors.
- [ ] The first scheduled OCI backup.
- [ ] A successful backup download, checksum verification, and disposable
      restore.

## Rollback

- [ ] If OCI has accepted no writes, freeze traffic and point DNS back to the
      previous production endpoint.
- [ ] If OCI has accepted writes, freeze traffic and back up OCI first. Do not
      route the old application to stale Supabase data.
- [ ] Restore or synchronize the OCI backup into Supabase after disposable
      validation before routing traffic back.
- [ ] Re-enable the old Cloud Run invocation path only after the database source
      is current.
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
| First OCI backup | |
| Rollback tested | yes / no |
| Failures and remediation | |
| Follow-up issue | |
