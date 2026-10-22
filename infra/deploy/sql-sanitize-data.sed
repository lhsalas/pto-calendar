# Target-incompatible statements to remove from a restored data dump.
#
# Shared by the production OCI restore (infra/deploy/restore-oci.sh), the
# generic disposable restore (bin/restore-backup.mjs), and the backup roundtrip
# integration test, so the three cannot drift apart.
#
# A data dump carries far fewer source-specific statements than a schema dump,
# but it still contains the `transaction_timeout` setting that a PostgreSQL 17
# pg_dump client emits even when the server is PostgreSQL 16.
#
# Apply with: sed -E -f <this file> data.sql
/^[[:space:]]*SET transaction_timeout[[:space:]]*=/d
