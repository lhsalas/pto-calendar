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
cleanup() { rm -rf "${WORKDIR}"; }
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

# The extension is a database-level object, so the source decides whether the
# schema dump mentions it. The query is fixed and returns only a boolean; no
# row data, secret or connection detail is read or logged.
probe_extension() {
  local raw
  raw="$(docker compose --env-file "${INSTALL_DIR}/.env" -f "${INSTALL_DIR}/${COMPOSE_FILE}" \
    exec -T db psql -X -U "${DB_USER}" -d "${DB_NAME}" -tAc \
    "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist');")" ||
    fail "could not read the extension state of ${DB_NAME}" 2
  raw="${raw//[[:space:]]/}"
  case "${raw}" in
    t) return 0 ;;
    f) return 1 ;;
    *) fail "unexpected extension probe result for ${DB_NAME}" 2 ;;
  esac
}

SCHEMA_DUMP_ARGS=(--schema-only --schema=public --no-owner --no-acl)
if probe_extension; then
  # The source has btree_gist, so the dump must carry the declaration: the
  # exclusion constraint cannot be applied on a target without it.
  SCHEMA_DUMP_ARGS+=(--extension="${REQUIRED_EXTENSION}")
  log "the source database has ${REQUIRED_EXTENSION}; including it in the schema dump"
fi

docker compose --env-file "${INSTALL_DIR}/.env" -f "${INSTALL_DIR}/${COMPOSE_FILE}" exec -T db \
  pg_dump -U "${DB_USER}" -d "${DB_NAME}" "${SCHEMA_DUMP_ARGS[@]}" > "${SCHEMA}"
docker compose --env-file "${INSTALL_DIR}/.env" -f "${INSTALL_DIR}/${COMPOSE_FILE}" exec -T db \
  pg_dump -U "${DB_USER}" -d "${DB_NAME}" --data-only --schema=public --no-owner --no-acl > "${DATA}"
[[ -s "${SCHEMA}" && -s "${DATA}" ]] || fail "database dump produced an empty file" 2

# A schema dump that carries the exclusion constraint without the extension
# cannot be applied on a target: the constraint needs btree_gist. That happens
# when the schema changed between the probe and the dump, so the backup fails
# closed instead of uploading an archive that cannot be restored.
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
