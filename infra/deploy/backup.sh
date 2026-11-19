#!/usr/bin/env bash
# Dump the OCI PostgreSQL container, encrypt the archive, and upload it to
# private OCI Object Storage using instance-principal authentication.

set -Eeuo pipefail

readonly DEFAULT_INSTALL_DIR="/opt/pto-calendar"
readonly DEFAULT_BACKUP_DIR="/opt/backups"
readonly COMPOSE_FILE="docker-compose.prod.yml"
# The owner/date exclusion constraint of #257 needs btree_gist, and a
# public-only schema dump omits the extension declaration. Both names are
# fixed constants: they are never taken from the environment.
readonly REQUIRED_EXTENSION="btree_gist"
readonly OVERLAP_CONSTRAINT="pto_requests_no_owner_overlap"
# How long the exporter may take to hand back the snapshot. The bound keeps a
# stuck session from hanging the backup.
readonly SNAPSHOT_READ_TIMEOUT_SECONDS=30

INSTALL_DIR="${INSTALL_DIR:-${DEFAULT_INSTALL_DIR}}"
BACKUP_DIR="${BACKUP_DIR:-${DEFAULT_BACKUP_DIR}}"

log() { printf '[backup] %s\n' "$*" >&2; }
fail() { printf '[backup] ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }

[[ -f "${INSTALL_DIR}/.env" ]] || fail "${INSTALL_DIR}/.env is missing; run setup.sh" 1
read_env() {
  local key="$1"
  awk -F= -v key="${key}" '$1 == key { print substr($0, length($1) + 2); exit }' "${INSTALL_DIR}/.env"
}

DB_USER="$(read_env DB_USER)"; DB_USER="${DB_USER:-pto}"
DB_NAME="$(read_env DB_NAME)"; DB_NAME="${DB_NAME:-pto}"
BACKUP_KEY="$(read_env BACKUP_ENCRYPTION_KEY)"
BUCKET="$(read_env OCI_BACKUP_BUCKET)"
NAMESPACE="$(read_env OCI_OBJECT_STORAGE_NAMESPACE)"
REGION="$(read_env OCI_REGION)"
[[ -n "${BACKUP_KEY}" && -n "${BUCKET}" && -n "${NAMESPACE}" && -n "${REGION}" ]] ||
  fail "backup configuration is incomplete in ${INSTALL_DIR}/.env" 1
[[ "${#BACKUP_KEY}" -ge 32 ]] || fail "BACKUP_ENCRYPTION_KEY is too short" 1
UNIQUE_CHARS="$(printf '%s' "${BACKUP_KEY}" | LC_ALL=C fold -w1 | sort -u | wc -l)"
[[ "${UNIQUE_CHARS}" -ge 16 ]] || fail "BACKUP_ENCRYPTION_KEY lacks character diversity" 1
case "${BACKUP_KEY}" in
  replace-me*|change-me*|password*|secret*) fail "BACKUP_ENCRYPTION_KEY is a placeholder" 1 ;;
esac

for tool in docker gpg tar sha256sum oci; do
  command -v "${tool}" >/dev/null 2>&1 || fail "${tool} is required" 2
done

umask 077
install -d -m 0700 "${BACKUP_DIR}"
WORKDIR="$(mktemp -d "${BACKUP_DIR}/.pto-backup.XXXXXX")"

# The snapshot exporter is a session of our own: it is closed and rolled back
# on success, on every failure and on every signal, so no transaction is left
# open and no other process is touched.
# Bash manages SNAPSHOT_PID itself and may unset it asynchronously.
EXPORTER_PID=""
SNAPSHOT_ID=""
SNAPSHOT_EXTENSION_PRESENT=""
SNAPSHOT_CONSTRAINT_PRESENT=""
BACKUP_COMPLETE=false
close_snapshot() {
  if [[ -n "${EXPORTER_PID}" ]]; then
    if [[ -v 'SNAPSHOT[1]' ]]; then
      # EOF disconnects psql and rolls back its read-only transaction.
      # Closing the pipe works even if the child exits before cleanup.
      local snapshot_input="${SNAPSHOT[1]}"
      exec {snapshot_input}>&-
    fi
    wait "${EXPORTER_PID}" 2>/dev/null || true
    EXPORTER_PID=""
  fi
  return 0
}
cleanup() {
  local status=$?
  close_snapshot
  rm -rf "${WORKDIR}"
  # A signal invokes this same cleanup and must never resume the upload.
  if [[ "${BACKUP_COMPLETE}" == "false" && "${status}" == "0" ]]; then status=1; fi
  exit "${status}"
}
trap cleanup EXIT INT TERM

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="pto-${STAMP}"
SCHEMA="${WORKDIR}/schema.sql"
DATA="${WORKDIR}/data.sql"
ARCHIVE="${WORKDIR}/${BASE}.tar.gz"
ENCRYPTED="${WORKDIR}/${BASE}.tar.gz.gpg"
CHECKSUM="${ENCRYPTED}.sha256"
PASSPHRASE="${WORKDIR}/passphrase"

log "dumping public schema and data from the db container"
cd "${INSTALL_DIR}"

# Both dumps must come from the same point in time. A schema dump taken before
# the #257 migration and a data dump taken after it leave the data with a
# finished migration marker and the schema without the constraint that
# migration installed: such an archive restores as if the guard were in place
# while it is not. One exported snapshot removes the transition, because both
# dumps then read the very same database state.
#
# The exporter is a dedicated read-only, repeatable-read session of our own.
# It exports the snapshot and reads the extension and the constraint state
# inside the same transaction, so the decisions below match the dumped state.
# A backup taken between the DDL commit and Prisma finishing its ledger row
# is unsafe too. Check the actual table/constraint and its milestone in this
# same snapshot. Only booleans and a fixed state label come back with the ID.
# The restore workflow must also back up genuinely empty targets. Discover
# the ledger before referencing it and reject unknown nonempty state.
open_snapshot() {
  local snapshot_id extension_present constraint_present migration_state
  coproc SNAPSHOT { exec docker compose --env-file "${INSTALL_DIR}/.env" \
    -f "${INSTALL_DIR}/${COMPOSE_FILE}" exec -T db \
    psql -X -U "${DB_USER}" -d "${DB_NAME}" -qAt -v ON_ERROR_STOP=1; }
  EXPORTER_PID=$!
  [[ -v 'SNAPSHOT[0]' && -v 'SNAPSHOT[1]' ]] || fail "the snapshot exporter could not start" 2
  if ! cat >&"${SNAPSHOT[1]}" <<'SQL'
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '20s';
SELECT pg_catalog.to_regclass('public._prisma_migrations') IS NOT NULL AS has_ledger
\gset
\if :has_ledger
SELECT CASE
         WHEN EXISTS (SELECT 1 FROM public._prisma_migrations
                      WHERE migration_name = '20261119120000_enforce_pto_non_overlap'
                        AND rolled_back_at IS NULL AND finished_at IS NULL) THEN 'pending'
         WHEN EXISTS (SELECT 1 FROM public._prisma_migrations
                      WHERE migration_name = '20261119120000_enforce_pto_non_overlap'
                        AND rolled_back_at IS NULL AND finished_at IS NOT NULL) THEN 'applied'
         ELSE 'absent'
       END AS migration_state
\gset
\else
SELECT CASE WHEN EXISTS (
         SELECT 1 FROM pg_catalog.pg_namespace AS n
         WHERE n.nspname = 'public'
           AND NOT EXISTS (
             SELECT 1 FROM pg_catalog.pg_depend AS d
             WHERE d.refclassid = 'pg_catalog.pg_namespace'::pg_catalog.regclass
               AND d.refobjid = n.oid
           )
       ) THEN 'empty'
       ELSE 'no_ledger'
       END AS migration_state
\gset
\endif
SELECT pg_catalog.pg_export_snapshot(),
       EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'btree_gist'),
       EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
               WHERE conname = 'pto_requests_no_owner_overlap' AND contype = 'x'
                 AND conrelid = pg_catalog.to_regclass('public.pto_requests')),
       :'migration_state';
SQL
  then
    fail "could not start the database snapshot transaction" 2
  fi
  if ! IFS='|' read -r -t "${SNAPSHOT_READ_TIMEOUT_SECONDS}" snapshot_id extension_present \
    constraint_present migration_state <&"${SNAPSHOT[0]}"; then
    fail "could not read a database snapshot (startup timeout or database error)" 2
  fi
  [[ "${snapshot_id}" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9]+$ ]] ||
    fail "the exported snapshot identifier is not a canonical PostgreSQL snapshot" 2
  case "${extension_present}" in
    t|f) ;;
    *) fail "unexpected extension state in the exported snapshot" 2 ;;
  esac
  case "${constraint_present}" in
    t|f) ;;
    *) fail "unexpected constraint state in the exported snapshot" 2 ;;
  esac
  case "${migration_state}:${constraint_present}" in
    empty:f|absent:f|applied:t) ;;
    no_ledger:*) fail "no Prisma ledger and public is not an empty schema; refusing to upload" 2 ;;
    pending:*) fail "the PTO overlap migration is unfinished; retry the backup after migration recovery or completion" 2 ;;
    *) fail "the PTO overlap constraint and the migration history disagree; refusing to upload" 2 ;;
  esac
  SNAPSHOT_ID="${snapshot_id}"
  SNAPSHOT_EXTENSION_PRESENT="${extension_present}"
  SNAPSHOT_CONSTRAINT_PRESENT="${constraint_present}"
}

# An exported snapshot is only usable while its exporting session is alive.
assert_exporter_alive() {
  [[ -n "${EXPORTER_PID}" ]] || fail "the snapshot exporter is not running" 2
  kill -0 "${EXPORTER_PID}" 2>/dev/null ||
    fail "the snapshot exporter stopped before the dumps finished" 2
}

open_snapshot
log "using PostgreSQL snapshot for the schema and data dumps"

SCHEMA_DUMP_ARGS=(--schema-only --schema=public --no-owner --no-acl)
if [[ "${SNAPSHOT_EXTENSION_PRESENT}" == "t" ]]; then
  # The source has btree_gist, so the dump must carry the declaration: the
  # exclusion constraint cannot be applied on a target without it.
  SCHEMA_DUMP_ARGS+=(--extension="${REQUIRED_EXTENSION}")
  log "the snapshot has ${REQUIRED_EXTENSION}; including it in the schema dump"
fi

assert_exporter_alive
docker compose --env-file "${INSTALL_DIR}/.env" -f "${INSTALL_DIR}/${COMPOSE_FILE}" exec -T db \
  pg_dump -U "${DB_USER}" -d "${DB_NAME}" "${SCHEMA_DUMP_ARGS[@]}" \
  --snapshot="${SNAPSHOT_ID}" > "${SCHEMA}"
assert_exporter_alive
docker compose --env-file "${INSTALL_DIR}/.env" -f "${INSTALL_DIR}/${COMPOSE_FILE}" exec -T db \
  pg_dump -U "${DB_USER}" -d "${DB_NAME}" --data-only --schema=public --no-owner --no-acl \
  --snapshot="${SNAPSHOT_ID}" > "${DATA}"
assert_exporter_alive
[[ -s "${SCHEMA}" && -s "${DATA}" ]] || fail "database dump produced an empty file" 2
close_snapshot

# The dumped state must be the state the snapshot reported. A mismatch means
# the dumps did not come from the exported snapshot, and such an archive must
# never be uploaded.
if [[ "${SNAPSHOT_CONSTRAINT_PRESENT}" == "t" ]]; then
  grep -Eq "^[[:space:]]+ADD CONSTRAINT ${OVERLAP_CONSTRAINT}[[:space:]]+EXCLUDE" "${SCHEMA}" ||
    fail "the schema dump does not contain the constraint the snapshot had" 2
elif grep -Eq "^[[:space:]]+ADD CONSTRAINT ${OVERLAP_CONSTRAINT}[[:space:]]+EXCLUDE" "${SCHEMA}"; then
  fail "the schema dump contains a constraint the snapshot did not have" 2
fi
if [[ "${SNAPSHOT_EXTENSION_PRESENT}" == "t" ]]; then
  grep -q "^CREATE EXTENSION IF NOT EXISTS ${REQUIRED_EXTENSION} WITH SCHEMA public;" "${SCHEMA}" ||
    fail "the schema dump does not contain the extension the snapshot had" 2
fi

# A schema dump that carries the exclusion constraint without the extension
# cannot be applied on a target: the constraint needs btree_gist. The backup
# fails closed instead of uploading an archive that cannot be restored.
if grep -Eq "^[[:space:]]+ADD CONSTRAINT ${OVERLAP_CONSTRAINT}[[:space:]]+EXCLUDE" "${SCHEMA}" &&
  ! grep -q "^CREATE EXTENSION IF NOT EXISTS ${REQUIRED_EXTENSION} WITH SCHEMA public;" "${SCHEMA}"; then
  fail "the schema dump has ${OVERLAP_CONSTRAINT} but no ${REQUIRED_EXTENSION} extension; refusing to upload a backup that cannot be restored" 2
fi

tar -C "${WORKDIR}" -czf "${ARCHIVE}" schema.sql data.sql
rm -f "${SCHEMA}" "${DATA}"
printf '%s' "${BACKUP_KEY}" > "${PASSPHRASE}"
chmod 600 "${PASSPHRASE}"
gpg --batch --yes --no-tty --symmetric --cipher-algo AES256 --compress-algo none \
  --passphrase-file "${PASSPHRASE}" --output "${ENCRYPTED}" "${ARCHIVE}"
rm -f "${PASSPHRASE}" "${ARCHIVE}"
(cd "${WORKDIR}" && sha256sum "$(basename "${ENCRYPTED}")" > "$(basename "${CHECKSUM}")")
chmod 600 "${ENCRYPTED}" "${CHECKSUM}"

OBJECT="pto/$(basename "${ENCRYPTED}")"
log "uploading encrypted backup to OCI Object Storage"
oci os object put --auth instance_principal --region "${REGION}" \
  --namespace-name "${NAMESPACE}" --bucket-name "${BUCKET}" \
  --name "${OBJECT}" --file "${ENCRYPTED}" --force >/dev/null
oci os object put --auth instance_principal --region "${REGION}" \
  --namespace-name "${NAMESPACE}" --bucket-name "${BUCKET}" \
  --name "${OBJECT}.sha256" --file "${CHECKSUM}" --force >/dev/null
log "backup uploaded: oci://${NAMESPACE}/${BUCKET}/${OBJECT}"
BACKUP_COMPLETE=true
