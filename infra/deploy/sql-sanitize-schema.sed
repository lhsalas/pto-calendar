# Target-incompatible statements to remove from a restored schema dump.
#
# Shared by the production OCI restore (infra/deploy/restore-oci.sh), the
# generic disposable restore (bin/restore-backup.mjs), and the backup roundtrip
# integration test, so the three cannot drift apart.
#
# The rules remove statements that reference the *source* database:
#   - role switches and ownership changes for roles the target does not have;
#   - default-privilege changes for the source's roles;
#   - GRANT/REVOKE for source roles and large objects;
#   - `transaction_timeout`, a PostgreSQL 17 setting that a newer pg_dump
#     client emits even when the server is PostgreSQL 16.
#
# Apply with: sed -E -f <this file> schema.sql
/^[[:space:]]*SET ROLE /d
/^[[:space:]]*ALTER .* OWNER TO /d
/^[[:space:]]*ALTER DEFAULT PRIVILEGES /d
/^[[:space:]]*(GRANT|REVOKE) /d
/^[[:space:]]*SET transaction_timeout[[:space:]]*=/d
