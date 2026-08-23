#!/usr/bin/env bash
# First-time provisioning for the PTO Calendar OCI Always Free VM.
#
# This script deliberately deploys an explicit release ref. It never silently
# turns a moving branch into production. Run it as root on an Ubuntu 22.04 or
# 24.04 ARM64 VM after DNS, the OCI CLI, and the required secret values are
# ready. The VM must carry the freeform tag `ptorole=production` (no dot) so
# the dynamic group `pto-calendar-vm` matches the instance and the IAM
# policy can grant Object Storage access via the instance principal.

set -Eeuo pipefail

readonly DEFAULT_REPO_URL="https://github.com/lhsalas/pto-calendar.git"
readonly DEFAULT_INSTALL_DIR="/opt/pto-calendar"
readonly DEFAULT_DB_USER="pto"
readonly DEFAULT_DB_NAME="pto"
readonly DEFAULT_LEAD_NAME="Team Lead"
readonly DEFAULT_LEAD_COLOR_CODE="#3B82F6"
readonly HEALTH_TIMEOUT_SECONDS=120
readonly COMPOSE_FILE="docker-compose.prod.yml"

log() { printf '[setup] %s\n' "$*" >&2; }
fail() { printf '[setup] ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    fail "required environment variable ${name} is not set"
  fi
}

require_tool() {
  local name="$1"
  if ! command -v "${name}" >/dev/null 2>&1; then
    fail "${name} is required; install it before running setup.sh"
  fi
}

valid_env_value() {
  [[ "$1" != *$'\n'* && "$1" != *$'\r'* ]]
}

require_strong_key() {
  local name="$1"
  local value="$2"
  valid_env_value "${value}" || fail "${name} must not contain a newline"
  [[ "${#value}" -ge 32 ]] || fail "${name} must be at least 32 characters"
  local unique
  unique="$(printf '%s' "${value}" | LC_ALL=C fold -w1 | sort -u | wc -l)"
  [[ "${unique}" -ge 16 ]] || fail "${name} must contain at least 16 unique characters"
  case "${value}" in
    replace-me*|change-me*|password*|secret*)
      fail "${name} must not use a placeholder or password prefix"
      ;;
  esac
}

read_env() {
  local file="$1"
  local key="$2"
  if [[ ! -f "${file}" ]]; then
    return 0
  fi
  awk -v key="${key}" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' "${file}"
}

existing_or_input() {
  local name="$1"
  local file="$2"
  local input="${!name:-}"
  if [[ -n "${input}" ]]; then
    printf '%s' "${input}"
  else
    read_env "${file}" "${name}"
  fi
}

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  fail "must be run as root (use sudo -E bash setup.sh)"
fi

require_tool awk
require_tool openssl
require_tool sudo

if [[ ! -f /etc/os-release ]]; then
  fail "/etc/os-release is missing"
fi
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == ubuntu ]] || fail "this script targets Ubuntu"
if [[ "${VERSION_ID:-}" != "22.04" && "${VERSION_ID:-}" != "24.04" ]]; then
  log "WARNING: Ubuntu ${VERSION_ID:-unknown}; 22.04 or 24.04 is the supported image"
fi
[[ "$(dpkg --print-architecture)" == arm64 ]] || fail "OCI A1 deployment requires an ARM64 VM"

require_env HOST
require_env ACME_EMAIL
require_env RELEASE_REF
require_env CORS_ORIGIN
require_env RATE_LIMIT_REDIS_URL
require_env SESSION_SECRET
require_env BACKUP_ENCRYPTION_KEY
require_env OCI_BACKUP_BUCKET
require_env OCI_OBJECT_STORAGE_NAMESPACE
require_env OCI_REGION

REPO_URL="${REPO_URL:-${DEFAULT_REPO_URL}}"
INSTALL_DIR="${INSTALL_DIR:-${DEFAULT_INSTALL_DIR}}"
DB_USER="${DB_USER:-${DEFAULT_DB_USER}}"
DB_NAME="${DB_NAME:-${DEFAULT_DB_NAME}}"
LEAD_NAME="${LEAD_NAME:-${DEFAULT_LEAD_NAME}}"
LEAD_COLOR_CODE="${LEAD_COLOR_CODE:-${DEFAULT_LEAD_COLOR_CODE}}"
SKIP_BOOTSTRAP="${SKIP_BOOTSTRAP:-false}"

[[ "${HOST}" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] ||
  fail "HOST must be a bare public hostname"
[[ "${CORS_ORIGIN}" == "https://${HOST}" ]] ||
  fail "CORS_ORIGIN must be exactly https://${HOST}"
[[ "${ACME_EMAIL}" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] ||
  fail "ACME_EMAIL is not a valid email address"
[[ "${RELEASE_REF}" =~ ^[A-Za-z0-9._/-]+$ && "${RELEASE_REF}" != -* && "${RELEASE_REF}" != *..* ]] ||
  fail "RELEASE_REF contains unsafe characters"
[[ "${DB_USER}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fail "DB_USER is invalid"
[[ "${DB_NAME}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fail "DB_NAME is invalid"
[[ "${LEAD_NAME}" != *$'\n'* && "${LEAD_NAME}" != *$'\r'* ]] || fail "LEAD_NAME contains a newline"
[[ "${LEAD_COLOR_CODE}" =~ ^#[0-9A-Fa-f]{6}$ ]] || fail "LEAD_COLOR_CODE is invalid"
[[ "${SKIP_BOOTSTRAP}" == true || "${SKIP_BOOTSTRAP}" == false ]] ||
  fail "SKIP_BOOTSTRAP must be true or false"
if [[ "${SKIP_BOOTSTRAP}" == false ]]; then
  require_env LEAD_EMAIL
  [[ "${LEAD_EMAIL}" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] ||
    fail "LEAD_EMAIL is not a valid email address"
fi

valid_env_value "${RATE_LIMIT_REDIS_URL}" || fail "RATE_LIMIT_REDIS_URL contains a newline"
[[ "${RATE_LIMIT_REDIS_URL}" == rediss://* ]] ||
  fail "RATE_LIMIT_REDIS_URL must be an Upstash TLS URL beginning with rediss://"
require_strong_key SESSION_SECRET "${SESSION_SECRET}"
require_strong_key BACKUP_ENCRYPTION_KEY "${BACKUP_ENCRYPTION_KEY}"
valid_env_value "${OCI_BACKUP_BUCKET}" || fail "OCI_BACKUP_BUCKET contains a newline"
valid_env_value "${OCI_OBJECT_STORAGE_NAMESPACE}" || fail "OCI_OBJECT_STORAGE_NAMESPACE contains a newline"
valid_env_value "${OCI_REGION}" || fail "OCI_REGION contains a newline"

if [[ -f "${INSTALL_DIR}/.env" ]]; then
  DB_PASSWORD="$(existing_or_input DB_PASSWORD "${INSTALL_DIR}/.env")"
else
  require_env DB_PASSWORD
fi
valid_env_value "${DB_PASSWORD}" || fail "DB_PASSWORD contains a newline"
[[ "${DB_PASSWORD}" =~ ^[A-Za-z0-9._~-]{16,128}$ ]] ||
  fail "DB_PASSWORD must be 16-128 URL-safe characters"

require_tool systemctl
require_tool oci

# --- Install Docker ---------------------------------------------------------
if ! command -v curl >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y --no-install-recommends ca-certificates curl git gnupg openssl
fi
if ! command -v docker >/dev/null 2>&1; then
  log "installing Docker Engine and Compose plugin"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y --no-install-recommends ca-certificates curl git gnupg openssl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg |
    gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  printf 'deb [arch=arm64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu %s stable\n' \
    "${VERSION_CODENAME}" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
require_tool curl
require_tool git
require_tool docker
docker compose version >/dev/null 2>&1 || fail "Docker Compose plugin is unavailable"

# --- Harden sshd ----------------------------------------------------------
# Port 22 is open to the world because the operator's public IP is dynamic.
# Disable password authentication and root login, and limit which accounts
# may sign in so an internet-wide sshd remains safe in practice.
SSHD_DROP_IN=/etc/ssh/sshd_config.d/99-pto-calendar.conf
install -d -m 0755 /etc/ssh/sshd_config.d
cat > "${SSHD_DROP_IN}" <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AllowUsers deploy ubuntu
EOF
chmod 0644 "${SSHD_DROP_IN}"
if command -v sshd >/dev/null 2>&1; then
  if ! sshd -t -f /etc/ssh/sshd_config >/dev/null 2>&1; then
    fail "sshd config validation failed; check ${SSHD_DROP_IN}"
  fi
  systemctl reload ssh || systemctl reload sshd || true
fi

# --- Create deploy user ----------------------------------------------------
if ! id -u deploy >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash deploy
fi
usermod -aG docker deploy
install -d -m 0700 -o deploy -g deploy /home/deploy/.ssh
touch /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 0600 /home/deploy/.ssh/authorized_keys

# --- Clone and check out the exact release --------------------------------
if [[ -d "${INSTALL_DIR}/.git" ]]; then
  log "updating repository at ${INSTALL_DIR}"
  if ! git -C "${INSTALL_DIR}" diff --quiet HEAD ||
    [[ -n "$(git -C "${INSTALL_DIR}" status --porcelain --untracked-files=all)" ]]; then
    fail "${INSTALL_DIR} has uncommitted or untracked changes; refusing to overwrite it" 2
  fi
  sudo -u deploy -H git -C "${INSTALL_DIR}" fetch --all --tags --prune
else
  log "cloning ${REPO_URL} to ${INSTALL_DIR}"
  install -d -o deploy -g deploy "$(dirname "${INSTALL_DIR}")"
  sudo -u deploy -H git clone "${REPO_URL}" "${INSTALL_DIR}"
fi
chown -R deploy:deploy "${INSTALL_DIR}"
if ! sudo -u deploy -H git -C "${INSTALL_DIR}" checkout --detach "${RELEASE_REF}"; then
  fail "release ref ${RELEASE_REF} was not found" 2
fi
RESOLVED_SHA="$(git -C "${INSTALL_DIR}" rev-parse --verify "${RELEASE_REF}^{commit}")"
log "checked out ${RELEASE_REF} (${RESOLVED_SHA})"

# --- Write the runtime environment -----------------------------------------
ENV_FILE="${INSTALL_DIR}/.env"
ENV_TMP="$(mktemp "${INSTALL_DIR}/.env.tmp.XXXXXX")"
chmod 600 "${ENV_TMP}"
trap 'rm -f "${ENV_TMP}"' EXIT
{
  printf '# Generated by infra/deploy/setup.sh at %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '# Do not commit. Keep a recovery copy of the secrets outside this VM.\n'
  printf 'HOST=%s\n' "${HOST}"
  printf 'ACME_EMAIL=%s\n' "${ACME_EMAIL}"
  printf 'CORS_ORIGIN=%s\n' "${CORS_ORIGIN}"
  printf 'DB_PASSWORD=%s\n' "${DB_PASSWORD}"
  printf 'DB_USER=%s\n' "${DB_USER}"
  printf 'DB_NAME=%s\n' "${DB_NAME}"
  printf 'SESSION_SECRET=%s\n' "${SESSION_SECRET}"
  printf 'COOKIE_SECURE=true\n'
  printf 'COOKIE_SAME_SITE=lax\n'
  printf 'COOKIE_DOMAIN=\n'
  printf 'RATE_LIMIT_REDIS_URL=%s\n' "${RATE_LIMIT_REDIS_URL}"
  printf 'BACKUP_ENCRYPTION_KEY=%s\n' "${BACKUP_ENCRYPTION_KEY}"
  printf 'OCI_BACKUP_BUCKET=%s\n' "${OCI_BACKUP_BUCKET}"
  printf 'OCI_OBJECT_STORAGE_NAMESPACE=%s\n' "${OCI_OBJECT_STORAGE_NAMESPACE}"
  printf 'OCI_REGION=%s\n' "${OCI_REGION}"
  printf 'LEAD_EMAIL=%s\n' "${LEAD_EMAIL:-}"
  printf 'LEAD_NAME=%s\n' "${LEAD_NAME}"
  printf 'LEAD_COLOR_CODE=%s\n' "${LEAD_COLOR_CODE}"
} > "${ENV_TMP}"
chown deploy:deploy "${ENV_TMP}"
mv -f "${ENV_TMP}" "${ENV_FILE}"
trap - EXIT

# --- Start the stack -------------------------------------------------------
log "building and starting ${COMPOSE_FILE}"
if ! sudo -u deploy -H docker compose --env-file "${ENV_FILE}" \
  -f "${INSTALL_DIR}/${COMPOSE_FILE}" up -d --build --remove-orphans; then
  fail "docker compose up failed" 3
fi

log "waiting for HTTPS /health"
ready=0
for _ in $(seq 1 "${HEALTH_TIMEOUT_SECONDS}"); do
  if curl -kfsS --max-time 5 --resolve "${HOST}:443:127.0.0.1" "https://${HOST}/health" >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
[[ "${ready}" -eq 1 ]] || fail "https://${HOST}/health did not return 200" 3
curl -kfsS --max-time 10 --resolve "${HOST}:443:127.0.0.1" "https://${HOST}/ready" >/dev/null ||
  fail "https://${HOST}/ready did not return 200" 3

# --- Install the encrypted backup timer -----------------------------------
install -m 0644 -o root -g root "${INSTALL_DIR}/infra/db/pto-calendar-backup.service" \
  /etc/systemd/system/pto-calendar-backup.service
install -m 0644 -o root -g root "${INSTALL_DIR}/infra/db/pto-calendar-backup.timer" \
  /etc/systemd/system/pto-calendar-backup.timer
systemctl daemon-reload
systemctl enable --now pto-calendar-backup.timer

# --- Optional first-run bootstrap -----------------------------------------
if [[ "${SKIP_BOOTSTRAP}" == false ]]; then
  log "running production team-lead bootstrap"
  sudo -u deploy -H docker compose --env-file "${ENV_FILE}" --profile bootstrap \
    -f "${INSTALL_DIR}/${COMPOSE_FILE}" run --rm --no-deps bootstrap
else
  log "SKIP_BOOTSTRAP=true; leaving restored/application data untouched"
fi

log "OCI setup complete at ${INSTALL_DIR} (${RELEASE_REF})"
log "SSH day-to-day operations as deploy; keep ${ENV_FILE} and the backup key protected"
