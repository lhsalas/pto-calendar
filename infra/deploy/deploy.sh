#!/usr/bin/env bash
# Ref-aware deploy for the PTO Calendar OCI prod VM.
#
# Runs `git fetch --all --tags && git checkout <ref> && docker compose up -d --build`
# inside /opt/pto-calendar, then polls https://${HOST}/health until 200.
#
# Used by both manual invocation and the GitHub Actions deploy workflow:
#   ./deploy.sh            # deploy latest main (default)
#   ./deploy.sh v1.2.3     # deploy a tagged release
#   ./deploy.sh feat/foo   # deploy a branch tip
#
# Requires:
#   - /opt/pto-calendar/.env must exist (created by setup.sh)
#   - HOST variable is read from that .env
#
# Exit codes:
#   0   success
#   1   install dir or .env missing (run setup.sh first)
#   2   git checkout failed (ref doesn't exist locally, network, dirty tree)
#   3   docker compose up failed
#   4   /health never returned 200 within HEALTH_TIMEOUT_SECONDS

set -Eeuo pipefail

readonly DEFAULTS_INSTALL_DIR="/opt/pto-calendar"
readonly DEFAULTS_HEALTH_TIMEOUT_SECONDS=60
readonly COMPOSE_FILE="docker-compose.prod.yml"

INSTALL_DIR="${INSTALL_DIR:-$DEFAULTS_INSTALL_DIR}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-$DEFAULTS_HEALTH_TIMEOUT_SECONDS}"

log() { printf '[deploy] %s\n' "$*" >&2; }
fail() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }

if [[ ! -d "${INSTALL_DIR}" ]]; then
  fail "${INSTALL_DIR} does not exist; run infra/deploy/setup.sh first" 1
fi
if [[ ! -f "${INSTALL_DIR}/.env" ]]; then
  fail "${INSTALL_DIR}/.env does not exist; run infra/deploy/setup.sh first" 1
fi

# HOST is sourced from the install .env (the only place it lives).
# shellcheck disable=SC1090
HOST="$(grep -E '^HOST=' "${INSTALL_DIR}/.env" | head -n1 | cut -d= -f2-)"
if [[ -z "${HOST}" ]]; then
  fail "HOST is not set in ${INSTALL_DIR}/.env; re-run setup.sh" 1
fi

REF="${1:-main}"
log "deploying ref='${REF}' (health probe will hit https://${HOST}/health)"

cd "${INSTALL_DIR}"

# Verify the working tree is clean (uncommitted edits block safe deploys).
if ! git diff --quiet HEAD 2>/dev/null; then
  fail "working tree has uncommitted changes in ${INSTALL_DIR}; commit or stash first" 2
fi

# Fetch + checkout. For a tag like v1.2.3 we fetch tags; for a branch we fetch
# the remote. Detached checkout is fine for tags; branches stay attached.
log "git fetch --all --tags"
sudo -u deploy -H git fetch --all --tags 2>&1 | sed 's/^/[deploy-git] /' >&2

log "git checkout ${REF}"
if ! sudo -u deploy -H git checkout "${REF}" 2>&1 | sed 's/^/[deploy-git] /' >&2; then
  fail "git checkout '${REF}' failed; verify the ref exists and the working tree is clean" 2
fi

# Pull fast-forward for branch refs (no-op for tags / detached HEAD).
if git symbolic-ref --quiet HEAD >/dev/null; then
  log "git pull --ff-only"
  sudo -u deploy -H git pull --ff-only 2>&1 | sed 's/^/[deploy-git] /' >&2 || \
    log "git pull --ff-only failed (likely non-FF); continuing at checked-out tip"
fi

# Use the deploy user's docker group membership for compose.
log "docker compose -f ${COMPOSE_FILE} up -d --build"
if ! sudo -u deploy -H docker compose -f "${COMPOSE_FILE}" up -d --build \
    2>&1 | sed 's/^/[deploy-compose] /' >&2; then
  fail "docker compose up failed; inspect compose output above" 3
fi

# Prune dangling images from the previous build. -f skips the confirmation
# prompt that would otherwise require a TTY.
log "docker image prune -f"
sudo -u deploy -H docker image prune -f 2>&1 | sed 's/^/[deploy-prune] /' >&2 || true

# Poll https://${HOST}/health. Caddy fronts everything so a 200 here means
# TLS is live, nginx is up, and the backend answered.
log "polling https://${HOST}/health (up to ${HEALTH_TIMEOUT_SECONDS}s)"
ready=0
for _ in $(seq 1 "${HEALTH_TIMEOUT_SECONDS}"); do
  if curl -fsS -o /dev/null --max-time 5 "https://${HOST}/health"; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "${ready}" -ne 1 ]]; then
  fail "https://${HOST}/health never returned 200 within ${HEALTH_TIMEOUT_SECONDS}s" 4
fi
log "deploy of ${REF} healthy at https://${HOST}"
