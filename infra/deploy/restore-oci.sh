#!/usr/bin/env bash
# Restore an encrypted logical backup into the OCI PostgreSQL container.
#
# This is intentionally separate from bin/restore-backup.mjs, whose production
# safeguard is disposable-target-only. The explicit confirmation below is
# required before this script can drop the OCI public schema.

set -Eeuo pipefail

readonly DEFAULT_INSTALL_DIR="/opt/pto-calendar"
readonly COMPOSE_FILE="docker-compose.prod.yml"

INSTALL_DIR="${INSTALL_DIR:-${DEFAULT_INSTALL_DIR}}"
ARCHIVE=""
CONFIRMED=false

log() { printf '[restore-oci] %s\n' "$*" >&2; }
fail() { printf '[restore-oci] ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }

usage() {
  printf 'Usage: %s --archive /path/to/pto-*.tar.gz.gpg --confirm-production-target\n' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --archive)
      [[ $# -ge 2 ]] || fail "--archive requires a path" 1
      ARCHIVE="$2"
      shift 2
      ;;
    --confirm-production-target)
      CONFIRMED=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1" 1
      ;;
  esac
done

[[ "${CONFIRMED}" == true ]] || fail "refusing production restore without --confirm-production-target" 1
[[ -n "${ARCHIVE}" ]] || fail "--archive is required" 1
[[ "$(basename "${ARCHIVE}")" == "${ARCHIVE}" ]] || fail "archive must be a basename in the current directory" 1
[[ "${ARCHIVE}" =~ ^pto-[A-Za-z0-9._-]+\.tar\.gz\.gpg$ ]] || fail "archive name is invalid" 1
[[ -f "${ARCHIVE}" && -s "${ARCHIVE}" ]] || fail "archive is missing or empty" 1
CHECKSUM="${ARCHIVE}.sha256"
[[ -f "${CHECKSUM}" && -s "${CHECKSUM}" ]] || fail "checksum is missing or empty" 1
[[ -f "${INSTALL_DIR}/.env" ]] || fail "${INSTALL_DIR}/.env is missing" 1

read_env() {
  local key="$1"
  awk -F= -v key="${key}" '$1 == key { print substr($0, length($1) + 2); exit }' "${INSTALL_DIR}/.env"
}
DB_USER="$(read_env DB_USER)"; DB_USER="${DB_USER:-pto}"
DB_NAME="$(read_env DB_NAME)"; DB_NAME="${DB_NAME:-pto}"
BACKUP_KEY="$(read_env BACKUP_ENCRYPTION_KEY)"
[[ -n "${BACKUP_KEY}" && "${#BACKUP_KEY}" -ge 32 ]] || fail "backup key is missing or too short" 1
UNIQUE_CHARS="$(printf '%s' "${BACKUP_KEY}" | LC_ALL=C fold -w1 | sort -u | wc -l)"
[[ "${UNIQUE_CHARS}" -ge 16 ]] || fail "backup key lacks character diversity" 1
case "${BACKUP_KEY}" in
  replace-me*|change-me*|password*|secret*) fail "backup key is a placeholder" 1 ;;
esac

for tool in docker gpg tar sha256sum curl; do
  command -v "${tool}" >/dev/null 2>&1 || fail "${tool} is required" 2
done

umask 077
WORKDIR="$(mktemp -d)"
cleanup() { rm -rf "${WORKDIR}"; }
trap cleanup EXIT INT TERM
cp -- "${ARCHIVE}" "${WORKDIR}/${ARCHIVE}"
cp -- "${CHECKSUM}" "${WORKDIR}/${CHECKSUM}"
(cd "${WORKDIR}" && sha256sum --check --strict "${CHECKSUM}") || fail "checksum verification failed" 3

PASSPHRASE="${WORKDIR}/passphrase"
DECRYPTED="${WORKDIR}/${ARCHIVE%.gpg}"
printf '%s' "${BACKUP_KEY}" > "${PASSPHRASE}"
chmod 600 "${PASSPHRASE}"
gpg --batch --yes --no-tty --decrypt --passphrase-file "${PASSPHRASE}" \
  --output "${DECRYPTED}" "${WORKDIR}/${ARCHIVE}"
rm -f "${PASSPHRASE}" "${WORKDIR}/${ARCHIVE}" "${WORKDIR}/${CHECKSUM}"

mapfile -t MANIFEST < <(tar -tvzf "${DECRYPTED}")
[[ "${#MANIFEST[@]}" -eq 2 ]] || fail "archive must contain exactly schema.sql and data.sql" 2
has_schema=false
has_data=false
for entry in "${MANIFEST[@]}"; do
  [[ "${entry:0:1}" == '-' ]] || fail "archive contains a non-regular file" 2
  member="${entry##* }"
  case "${member}" in
    schema.sql) has_schema=true ;;
    data.sql) has_data=true ;;
    *) fail "archive contains unexpected paths" 2 ;;
  esac
done
[[ "${has_schema}" == true && "${has_data}" == true ]] ||
  fail "archive must contain schema.sql and data.sql" 2
tar -xzf "${DECRYPTED}" -C "${WORKDIR}" \
  --no-same-owner --no-same-permissions --no-overwrite-dir
rm -f "${DECRYPTED}"
[[ -s "${WORKDIR}/schema.sql" && -s "${WORKDIR}/data.sql" ]] || fail "archive files are missing or empty" 2

# Supabase dumps can contain ownership and ACL statements for roles that exist
# only in Supabase. The OCI database intentionally creates only DB_USER, so
# omit source-role metadata while retaining the actual schema DDL.
TARGET_SCHEMA="${WORKDIR}/schema-target.sql"
sed -E \
  -e '/^[[:space:]]*SET ROLE /d' \
  -e '/^[[:space:]]*ALTER .* OWNER TO /d' \
  -e '/^[[:space:]]*ALTER DEFAULT PRIVILEGES /d' \
  -e '/^[[:space:]]*(GRANT|REVOKE) /d' \
  -e '/^[[:space:]]*SET transaction_timeout[[:space:]]*=/d' \
  "${WORKDIR}/schema.sql" > "${TARGET_SCHEMA}"
[[ -s "${TARGET_SCHEMA}" ]] || fail "target schema is empty after removing source-role metadata" 2
TARGET_DATA="${WORKDIR}/data-target.sql"
sed -E \
  -e '/^[[:space:]]*SET transaction_timeout[[:space:]]*=/d' \
  "${WORKDIR}/data.sql" > "${TARGET_DATA}"
[[ -s "${TARGET_DATA}" ]] || fail "target data is empty after removing unsupported session metadata" 2

log "stopping application containers before destructive restore"
docker compose --env-file "${INSTALL_DIR}/.env" -f "${INSTALL_DIR}/${COMPOSE_FILE}" \
  stop caddy nginx backend >/dev/null || true

log "ensuring the target public schema exists for the pre-restore backup"
docker compose --env-file "${INSTALL_DIR}/.env" -f "${INSTALL_DIR}/${COMPOSE_FILE}" exec -T db \
  psql -U "${DB_USER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1 -q \
  -c 'CREATE SCHEMA IF NOT EXISTS public;'
log "creating an encrypted pre-restore backup"
"${INSTALL_DIR}/infra/deploy/backup.sh"

log "dropping public schema in the OCI PostgreSQL container"
docker compose --env-file "${INSTALL_DIR}/.env" -f "${INSTALL_DIR}/${COMPOSE_FILE}" exec -T db \
  psql -U "${DB_USER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1 -q \
  -c 'DROP SCHEMA public CASCADE;'
log "applying schema and data"
docker compose --env-file "${INSTALL_DIR}/.env" -f "${INSTALL_DIR}/${COMPOSE_FILE}" exec -T db \
  psql -U "${DB_USER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1 -q --single-transaction -f - < "${TARGET_SCHEMA}"
docker compose --env-file "${INSTALL_DIR}/.env" -f "${INSTALL_DIR}/${COMPOSE_FILE}" exec -T db \
  psql -U "${DB_USER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1 -q --single-transaction -f - < "${TARGET_DATA}"

log "checking Prisma migration state"
docker compose --env-file "${INSTALL_DIR}/.env" -f "${INSTALL_DIR}/${COMPOSE_FILE}" \
  run --rm --no-deps migrate
log "starting application containers"
docker compose --env-file "${INSTALL_DIR}/.env" -f "${INSTALL_DIR}/${COMPOSE_FILE}" \
  up -d backend nginx caddy >/dev/null

HOST="$(read_env HOST)"
[[ -n "${HOST}" ]] || fail "HOST is missing from ${INSTALL_DIR}/.env" 1
for _ in $(seq 1 120); do
  if curl -kfsS --max-time 5 --resolve "${HOST}:443:127.0.0.1" "https://${HOST}/health" >/dev/null &&
    curl -kfsS --max-time 5 --resolve "${HOST}:443:127.0.0.1" "https://${HOST}/ready" >/dev/null; then
    log "restore complete and application is healthy at https://${HOST}"
    exit 0
  fi
  sleep 1
done
fail "application did not become healthy after restore" 4
