#!/usr/bin/env bash
# Daily pg_dump for the PTO Calendar OCI prod VM.
#
# Reads DB credentials from /opt/pto-calendar/.env (variable references only;
# no literal passwords), runs `docker compose exec -T db pg_dump`, gzips to
# /opt/backups/pto-YYYYMMDD.sql.gz, then prunes dumps older than 7 days.
#
# Invoked by infra/db/backup.timer (systemd, daily 03:00 UTC) or manually:
#   ./backup.sh
#
# Exit codes:
#   0   success (including the no-op case where a dump for today already exists)
#   1   .env missing or DB vars unset
#   2   docker compose exec / pg_dump failed
#   3   gzip or rotation failed

set -Eeuo pipefail

readonly DEFAULTS_INSTALL_DIR="/opt/pto-calendar"
readonly DEFAULTS_BACKUP_DIR="/opt/backups"
readonly DEFAULTS_RETENTION_DAYS=7

INSTALL_DIR="${INSTALL_DIR:-$DEFAULTS_INSTALL_DIR}"
BACKUP_DIR="${BACKUP_DIR:-$DEFAULTS_BACKUP_DIR}"
RETENTION_DAYS="${RETENTION_DAYS:-$DEFAULTS_RETENTION_DAYS}"

log() { printf '[backup] %s\n' "$*" >&2; }
fail() { printf '[backup] ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }

if [[ ! -f "${INSTALL_DIR}/.env" ]]; then
  fail "${INSTALL_DIR}/.env missing; run infra/deploy/setup.sh first" 1
fi

# Read vars via grep (not `source`) so the script only pulls the keys it needs
# and an unrelated line break in .env can't execute arbitrary code.
read_env() {
  local key="$1"
  grep -E "^${key}=" "${INSTALL_DIR}/.env" | head -n1 | cut -d= -f2-
}
DB_USER="$(read_env DB_USER)"; DB_USER="${DB_USER:-pto}"
DB_NAME="$(read_env DB_NAME)"; DB_NAME="${DB_NAME:-pto}"
DB_PASSWORD="$(read_env DB_PASSWORD)"
if [[ -z "${DB_PASSWORD}" ]]; then
  fail "DB_PASSWORD is empty in ${INSTALL_DIR}/.env" 1
fi

# DATABASE_URL is passed to pg_dump via env so pg_dump doesn't need a
# .pgpass file inside the container.
DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@db:5432/${DB_NAME}?schema=public"

install -d -m 0700 "${BACKUP_DIR}"

TODAY="$(date -u +%Y%m%d)"
DEST="${BACKUP_DIR}/pto-${TODAY}.sql.gz"

if [[ -s "${DEST}" ]]; then
  log "${DEST} already exists and is non-empty; skipping (idempotent)"
  exit 0
fi

TMP="$(mktemp "${BACKUP_DIR}/.pto-${TODAY}.sql.gz.XXXXXX")"
trap 'rm -f "${TMP}"' EXIT

log "dumping ${DB_NAME} from compose service 'db' -> ${DEST}"
cd "${INSTALL_DIR}"
if ! sudo -u deploy -H bash -c "\
  DATABASE_URL='${DATABASE_URL}' \
  docker compose -f docker-compose.prod.yml exec -T db \
    pg_dump -U '${DB_USER}' -d '${DB_NAME}' --no-owner --no-acl" \
    | gzip > "${TMP}"; then
  fail "pg_dump failed; inspect compose output above" 2
fi

# A zero-byte gzip file means pg_dump silently produced nothing.
if [[ ! -s "${TMP}" ]]; then
  fail "pg_dump produced an empty stream; aborting" 2
fi

mv "${TMP}" "${DEST}"
chmod 0600 "${DEST}"
trap - EXIT
log "wrote $(du -h "${DEST}" | cut -f1) to ${DEST}"

log "pruning dumps older than ${RETENTION_DAYS} days from ${BACKUP_DIR}"
find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'pto-*.sql.gz' -mtime +"${RETENTION_DAYS}" -delete -print \
  | sed 's/^/[backup-prune] /' >&2 \
  || fail "find/rm failed during retention prune" 3

log "backup complete"
