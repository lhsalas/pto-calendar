#!/usr/bin/env bash
# First-time provisioning for the PTO Calendar OCI Always Free VM.
#
# Idempotent. Running it on a fresh Ubuntu 22.04 aarch64 instance installs
# Docker + git, creates the unprivileged `deploy` user (member of the docker
# group, no sudo), clones the repo to /opt/pto-calendar, writes /opt/pto-calendar/.env
# with a random SESSION_SECRET and the operator-supplied public-host values,
# brings up docker-compose.prod.yml, polls /health, then runs the team-lead
# `db:bootstrap` step against the running backend image.
#
# Re-running on an existing install performs `git pull` and `docker compose up
# -d --build` instead of cloning, and skips the bootstrap step (the team lead
# already has credentials).
#
# Required env vars:
#   HOST          public hostname (e.g. pto.example.com)
#   ACME_EMAIL    Let's Encrypt registration email
#   DB_PASSWORD   Postgres password (any printable ASCII; will be %-escaped only if required)
#   LEAD_EMAIL    team-lead bootstrap email
#   CORS_ORIGIN   SPA origin (https://HOST)
#
# Optional env vars (sensible defaults shown):
#   REPO_URL      git URL to clone (default: https://github.com/lhsalas/pto-calendar.git)
#   INSTALL_DIR   install path (default: /opt/pto-calendar)
#   DB_USER       Postgres user (default: pto)
#   DB_NAME       Postgres database (default: pto)
#   LEAD_NAME     team-lead display name (default: Team Lead)
#   LEAD_COLOR_CODE  team-lead chip color (default: #3B82F6)
#
# Usage:
#   sudo bash setup.sh
#
# Exit codes:
#   0   success
#   1   required env var missing or invalid input
#   2   apt/docker install failed
#   3   compose up failed or /health never went 200
#   4   bootstrap failed (operator should retry via ./infra/deploy/deploy.sh)

set -Eeuo pipefail

readonly DEFAULTS_REPO_URL="https://github.com/lhsalas/pto-calendar.git"
readonly DEFAULTS_INSTALL_DIR="/opt/pto-calendar"
readonly DEFAULTS_DB_USER="pto"
readonly DEFAULTS_DB_NAME="pto"
readonly DEFAULTS_LEAD_NAME="Team Lead"
readonly DEFAULTS_LEAD_COLOR_CODE="#3B82F6"
readonly HEALTH_TIMEOUT_SECONDS=60
readonly COMPOSE_FILE="docker-compose.prod.yml"

log() { printf '[setup] %s\n' "$*" >&2; }
fail() { printf '[setup] ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    fail "required env var $name is not set; export it before running (see script header)"
  fi
}

# --- 0. Preflight -----------------------------------------------------------
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  fail "must be run as root (sudo bash $0)"
fi

if [[ ! -f /etc/os-release ]] || ! grep -q '^ID=ubuntu' /etc/os-release; then
  fail "this script targets Ubuntu; /etc/os-release does not report ID=ubuntu"
fi
. /etc/os-release
if [[ "${VERSION_ID:-}" != "22.04" ]]; then
  log "WARNING: VERSION_ID=${VERSION_ID:-unknown}, expected 22.04"
fi

require_env HOST
require_env ACME_EMAIL
require_env DB_PASSWORD
require_env LEAD_EMAIL
require_env CORS_ORIGIN

REPO_URL="${REPO_URL:-$DEFAULTS_REPO_URL}"
INSTALL_DIR="${INSTALL_DIR:-$DEFAULTS_INSTALL_DIR}"
DB_USER="${DB_USER:-$DEFAULTS_DB_USER}"
DB_NAME="${DB_NAME:-$DEFAULTS_DB_NAME}"
LEAD_NAME="${LEAD_NAME:-$DEFAULTS_LEAD_NAME}"
LEAD_COLOR_CODE="${LEAD_COLOR_CODE:-$DEFAULTS_LEAD_COLOR_CODE}"

# Validate inputs (hostnames + URLs must look sane to fail fast on typos).
[[ "${HOST}" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ ]] \
  || fail "HOST='${HOST}' is not a bare hostname (no scheme, no slash, no trailing dot)"
[[ "${ACME_EMAIL}" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] \
  || fail "ACME_EMAIL='${ACME_EMAIL}' is not an email address"
[[ "${LEAD_EMAIL}" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] \
  || fail "LEAD_EMAIL='${LEAD_EMAIL}' is not an email address"
[[ "${CORS_ORIGIN}" =~ ^https?://[a-zA-Z0-9.-]+(:[0-9]+)?$ ]] \
  || fail "CORS_ORIGIN='${CORS_ORIGIN}' must be http(s)://host[:port]"

log "targeting host=${HOST} install_dir=${INSTALL_DIR} repo=${REPO_URL}"

# --- 1. Install apt packages + Docker --------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "installing docker engine + compose plugin"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg git openssl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu %s stable\n' \
    "$(dpkg --print-architecture)" "${VERSION_CODENAME}" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y --no-install-recommends \
    docker-ce docker-ce-cli containerd.io docker-compose-plugin \
    || fail "docker apt install failed" 2
  log "docker installed: $(docker --version)"
else
  log "docker already present: $(docker --version)"
fi

if ! docker compose version >/dev/null 2>&1; then
  fail "docker compose plugin not found; install docker-compose-plugin and re-run"
fi

# --- 2. Create deploy user (idempotent) -------------------------------------
if id -u deploy >/dev/null 2>&1; then
  log "user deploy already exists (uid=$(id -u deploy))"
else
  log "creating user deploy"
  useradd -m -s /bin/bash deploy
fi
usermod -aG docker deploy
install -d -m 0700 -o deploy -g deploy /home/deploy/.ssh
touch /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 0600 /home/deploy/.ssh/authorized_keys

# --- 3. Clone or pull repo --------------------------------------------------
if [[ -d "${INSTALL_DIR}/.git" ]]; then
  log "repo already present at ${INSTALL_DIR}; pulling latest"
  sudo -u deploy -H bash -c "cd '${INSTALL_DIR}' && git fetch --all --tags && git reset --hard origin/master"
else
  log "cloning ${REPO_URL} to ${INSTALL_DIR}"
  install -d -o deploy -g deploy "$(dirname "${INSTALL_DIR}")"
  sudo -u deploy -H bash -c "git clone '${REPO_URL}' '${INSTALL_DIR}'"
fi
chown -R deploy:deploy "${INSTALL_DIR}"

# --- 4. Write /opt/pto-calendar/.env ---------------------------------------
ENV_FILE="${INSTALL_DIR}/.env"
# Preserve an existing SESSION_SECRET so re-running doesn't invalidate
# sessions; only rotate on first install.
if [[ -f "${ENV_FILE}" ]] && grep -q '^SESSION_SECRET=' "${ENV_FILE}"; then
  log "SESSION_SECRET already present in ${ENV_FILE}; preserving"
  SESSION_SECRET="$(grep -E '^SESSION_SECRET=' "${ENV_FILE}" | head -n1 | cut -d= -f2-)"
else
  SESSION_SECRET="$(openssl rand -base64 48)"
  log "generated new SESSION_SECRET (48 random bytes, base64)"
fi

cat > "${ENV_FILE}.tmp" <<EOF
# Generated by infra/deploy/setup.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Do not commit. Re-running setup.sh preserves SESSION_SECRET (rotating it
# invalidates all active sessions).
HOST=${HOST}
ACME_EMAIL=${ACME_EMAIL}
CORS_ORIGIN=${CORS_ORIGIN}
DB_PASSWORD=${DB_PASSWORD}
DB_USER=${DB_USER}
DB_NAME=${DB_NAME}
LEAD_EMAIL=${LEAD_EMAIL}
LEAD_NAME=${LEAD_NAME}
LEAD_COLOR_CODE=${LEAD_COLOR_CODE}
SESSION_SECRET=${SESSION_SECRET}
EOF
chmod 0600 "${ENV_FILE}.tmp"
chown deploy:deploy "${ENV_FILE}.tmp"
mv "${ENV_FILE}.tmp" "${ENV_FILE}"

# --- 5. docker compose up ---------------------------------------------------
log "bringing up ${COMPOSE_FILE}"
cd "${INSTALL_DIR}"
sudo -u deploy -H bash -c "cd '${INSTALL_DIR}' && docker compose -f ${COMPOSE_FILE} up -d --build" \
  || fail "docker compose up failed; inspect output above" 3

# --- 6. Poll /health --------------------------------------------------------
log "polling http://localhost/health (up to ${HEALTH_TIMEOUT_SECONDS}s)"
ready=0
for _ in $(seq 1 "${HEALTH_TIMEOUT_SECONDS}"); do
  if curl -fsS -o /dev/null http://localhost/health; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "${ready}" -ne 1 ]]; then
  fail "http://localhost/health never returned 200 within ${HEALTH_TIMEOUT_SECONDS}s" 3
fi
log "stack is healthy"

# --- 7. db:bootstrap (first install only) -----------------------------------
# Idempotent bootstrap.ts: if the lead already has a password, this is a no-op.
# We always run it so re-running setup.sh after a partial install recovers the
# setup link if the operator never completed the first-time flow.
log "running db:bootstrap for ${LEAD_EMAIL}"
if ! sudo -u deploy -H bash -c "cd '${INSTALL_DIR}' \
  && docker compose -f ${COMPOSE_FILE} run --rm --no-deps \
       -e LEAD_EMAIL='${LEAD_EMAIL}' \
       -e LEAD_NAME='${LEAD_NAME}' \
       -e LEAD_COLOR_CODE='${LEAD_COLOR_CODE}' \
       -e APP_PUBLIC_BASE_URL='${CORS_ORIGIN}' \
       backend npx tsx backend/prisma/bootstrap.ts"; then
  fail "db:bootstrap failed; inspect the output above and retry once fixed" 4
fi

log "done."
log ""
log "Next steps for the operator:"
log "  1. Copy the /setup-account?token=... link printed above and open it in a browser."
log "  2. Set the team-lead password."
log "  3. SSH in as 'deploy' for day-to-day operations (the user is in the docker group)."
log "  4. See docs/deploy.md for backup verification, SESSION_SECRET rotation, and disaster recovery."
