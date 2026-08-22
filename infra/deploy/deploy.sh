#!/usr/bin/env bash
# Deploy an exact release ref on the OCI VM.

set -Eeuo pipefail

readonly DEFAULT_INSTALL_DIR="/opt/pto-calendar"
readonly COMPOSE_FILE="docker-compose.prod.yml"
readonly HEALTH_TIMEOUT_SECONDS=120

INSTALL_DIR="${INSTALL_DIR:-${DEFAULT_INSTALL_DIR}}"

log() { printf '[deploy] %s\n' "$*" >&2; }
fail() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }

REF="${1:-}"
EXPECTED_SHA="${2:-}"
[[ -n "${REF}" ]] || fail "usage: $0 <release-ref> [expected-commit-sha]" 1
[[ "${REF}" =~ ^[A-Za-z0-9._/-]+$ && "${REF}" != -* && "${REF}" != *..* ]] ||
  fail "release ref contains unsafe characters" 1
if [[ -n "${EXPECTED_SHA}" && ! "${EXPECTED_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
  fail "expected commit must be a 40-character SHA" 1
fi

[[ -d "${INSTALL_DIR}/.git" ]] || fail "${INSTALL_DIR} is not a git checkout; run setup.sh" 1
[[ -f "${INSTALL_DIR}/.env" ]] || fail "${INSTALL_DIR}/.env is missing; run setup.sh" 1

cd "${INSTALL_DIR}"
if ! git diff --quiet HEAD || [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  fail "working tree has uncommitted or untracked changes" 2
fi

log "fetching tags"
git -C "${INSTALL_DIR}" fetch --all --tags --prune
if ! git -C "${INSTALL_DIR}" rev-parse --verify "${REF}^{commit}" >/dev/null; then
  fail "release ref ${REF} was not found" 2
fi
RESOLVED_SHA="$(git -C "${INSTALL_DIR}" rev-parse --verify "${REF}^{commit}")"
if [[ -n "${EXPECTED_SHA}" && "${RESOLVED_SHA}" != "${EXPECTED_SHA}" ]]; then
  fail "${REF} resolves to ${RESOLVED_SHA}, expected ${EXPECTED_SHA}" 2
fi
log "checking out ${REF} (${RESOLVED_SHA})"
git -C "${INSTALL_DIR}" checkout --detach "${REF}"

log "building and starting ${COMPOSE_FILE}"
docker compose --env-file "${INSTALL_DIR}/.env" -f "${INSTALL_DIR}/${COMPOSE_FILE}" \
  up -d --build --remove-orphans || fail "docker compose up failed" 3

HOST="$(awk -F= '$1 == "HOST" { print substr($0, length($1) + 2); exit }' "${INSTALL_DIR}/.env")"
[[ -n "${HOST}" ]] || fail "HOST is missing from ${INSTALL_DIR}/.env" 1

log "waiting for https://${HOST}/health and /ready"
healthy=0
for _ in $(seq 1 "${HEALTH_TIMEOUT_SECONDS}"); do
  if curl -kfsS --max-time 5 --resolve "${HOST}:443:127.0.0.1" "https://${HOST}/health" >/dev/null &&
    curl -kfsS --max-time 5 --resolve "${HOST}:443:127.0.0.1" "https://${HOST}/ready" >/dev/null; then
    healthy=1
    break
  fi
  sleep 1
done
[[ "${healthy}" -eq 1 ]] || fail "OCI stack did not become healthy within ${HEALTH_TIMEOUT_SECONDS}s" 4

docker image prune -f >/dev/null 2>&1 || true
log "deploy of ${REF} (${RESOLVED_SHA}) is healthy at https://${HOST}"
