#!/usr/bin/env bash
# Staging frontend deploy — App server only.
#
# Usage (on App server):
#   export DEPLOY_BRANCH=sit
#   bash Backend/scripts/deploy-staging-frontend.sh deploy
#
# Rollback:
#   bash Backend/scripts/deploy-staging-frontend.sh rollback

set -euo pipefail

REPO_DIR="${PID_REPO_DIR:-/opt/plant-information-dashboard}"
ROLLBACK_SHA_FILE="${PID_APP_ROLLBACK_SHA_FILE:-/root/pid-staging-app-rollback-sha.txt}"
ROLLBACK_LOG_FILE="${PID_APP_ROLLBACK_LOG_FILE:-/root/pid-staging-app-rollback-log.txt}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-sit}"
DEPLOY_COMMIT="${DEPLOY_COMMIT:-}"
ENV_FILE="${PID_APP_ENV_FILE:-.env}"
COMPOSE_FILE="${PID_APP_COMPOSE:-docker-compose.app.yml}"

cd "$REPO_DIR"

port_from_env() {
  local key="$1"
  local fallback="$2"
  local value="${!key:-}"
  if [[ -z "$value" && -f "$ENV_FILE" ]]; then
    value="$(awk -F= -v k="$key" '$1==k {print $2}' "$ENV_FILE" | tail -1 | tr -d '\r')"
  fi
  echo "${value:-$fallback}"
}

# SIT publishes 3091 on the shared App host (3090 is msd-fe).
FE_PORT="$(port_from_env PID_FE_PORT 3091)"

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

require_env_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "Missing $ENV_FILE — copy .env.staging.example to .env on the app host." >&2
    exit 1
  fi
}

save_rollback_point() {
  git fetch origin
  git rev-parse HEAD | tee "$ROLLBACK_SHA_FILE"
  git log -1 --oneline | tee "$ROLLBACK_LOG_FILE"
  echo "Rollback point saved:"
  cat "$ROLLBACK_SHA_FILE"
  cat "$ROLLBACK_LOG_FILE"
}

checkout_deploy_ref() {
  git fetch origin
  git checkout "$DEPLOY_BRANCH"
  git pull origin "$DEPLOY_BRANCH"
  if [[ -n "$DEPLOY_COMMIT" ]]; then
    git checkout "$DEPLOY_COMMIT"
  fi
  git log -1 --oneline
}

# A container that was just recreated needs a few seconds before it answers. Wait for a good
# answer (curl -f fails on an error status), up to about a minute, instead of failing on the first try.
wait_for_health() {
  local url="$1"
  local tries="${HEALTH_TRIES:-30}"
  for ((i = 1; i <= tries; i++)); do
    if curl -fsS -o /dev/null "$url"; then
      return 0
    fi
    sleep 2
  done
  echo "Health check failed after $tries tries: $url" >&2
  return 1
}

rebuild_app() {
  require_env_file
  compose build --no-cache pid-web
  compose up -d
  compose ps
  wait_for_health "http://127.0.0.1:${FE_PORT}/" && echo "SPA OK"
  wait_for_health "http://127.0.0.1:${FE_PORT}/api/v1/health" && curl -fsS "http://127.0.0.1:${FE_PORT}/api/v1/health"
  echo
}

cmd_deploy() {
  echo "=== 1/3 Save rollback point (App server) ==="
  save_rollback_point
  echo "=== 2/3 Checkout ${DEPLOY_BRANCH}${DEPLOY_COMMIT:+ @ ${DEPLOY_COMMIT}} ==="
  checkout_deploy_ref
  echo "=== 3/3 Rebuild frontend (pid-web) ==="
  rebuild_app
  echo "Deploy complete. Open http://<APP_PUBLIC>:${FE_PORT}"
}

cmd_rollback() {
  local sha="${ROLLBACK_SHA:-}"
  if [[ -z "$sha" ]]; then
    if [[ ! -f "$ROLLBACK_SHA_FILE" ]]; then
      echo "Missing $ROLLBACK_SHA_FILE — set SHA manually: export ROLLBACK_SHA=<sha>" >&2
      exit 1
    fi
    sha="$(cat "$ROLLBACK_SHA_FILE")"
  fi
  echo "Rolling back App to $sha"
  git fetch origin
  git checkout "$sha"
  git log -1 --oneline
  rebuild_app
  echo "Rollback complete."
}

case "${1:-}" in
  deploy) cmd_deploy ;;
  rollback) cmd_rollback ;;
  *)
    echo "Usage: $0 deploy|rollback" >&2
    exit 1
    ;;
esac
