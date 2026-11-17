#!/usr/bin/env bash
# PID production release on ONE server (Docs/Guide/PRODUCTION-DEPLOYMENT.md §7, §8, §12).
# Production runs a release TAG - a commit that passed staging - never "whatever main is".
#
#   /opt/pid/src/deploy/production/release.sh be v1.0.0      # BE 172.28.80.51 first
#   /opt/pid/src/deploy/production/release.sh fe v1.0.0      # then FE 172.28.80.50
#   ... be v1.0.0 --skip-migrate   leave the database schema alone
#
# Guarded: refuses when the checkout has local edits, a settings file still holds FILL_ values, or the
# tag does not exist; keeps the running image as :prev (instant rollback, guide §12); builds on this
# server; (BE) applies the migrations BEFORE the new container starts; recreates the container
# (--force-recreate: Compose compares image names, so a plain `up -d` after a rebuild keeps the old
# code) and checks it.
set -euo pipefail
ROLE="${1:-}"; TAG="${2:-}"
case "$ROLE" in be|fe) ;; *) echo "usage: release.sh be|fe <release tag> [--skip-migrate]" >&2; exit 2 ;; esac
[ -n "$TAG" ] && [ "${TAG#--}" = "$TAG" ] || { echo "usage: release.sh $ROLE <release tag, e.g. v1.0.0> [--skip-migrate]" >&2; exit 2; }
shift 2
MIGRATE=1
for arg in "$@"; do
  case "$arg" in
    --skip-migrate) MIGRATE=0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

RUN="${PID_RUN_DIR:-/opt/pid}"
SRC="$RUN/src"
DC="$SRC/deploy/production/dc.sh $ROLE"
stop() { echo "STOP - $*" >&2; exit 1; }

# ── the filled-in runtime files must exist and be complete ──
need_filled() {
  [ -f "$RUN/$1" ] || stop "$RUN/$1 is missing (guide: copy it from deploy/production)"
  if grep -nE '^[^#]*FILL_' "$RUN/$1"; then stop "fill in the FILL_ values above in $RUN/$1"; fi
}
need_filled .env
if [ "$ROLE" = be ]; then
  need_filled production.env
  need_filled secrets.production.env
  [ "$(stat -c %a "$RUN/secrets.production.env")" = 600 ] || stop "chmod 600 $RUN/secrets.production.env"
fi

# ── code: the release tag, in a checkout without local edits ──
[ -z "$(git -C "$SRC" status --porcelain --untracked-files=no)" ] || { git -C "$SRC" status -sb; stop "the code in $SRC has local changes"; }
git -C "$SRC" fetch --tags --force origin
git -C "$SRC" rev-parse -q --verify "refs/tags/$TAG" >/dev/null || stop "release tag $TAG does not exist on GitHub (git tag -a $TAG <commit> -m $TAG && git push origin $TAG)"
git -C "$SRC" -c advice.detachedHead=false checkout -q "$TAG"
SHA=$(git -C "$SRC" rev-parse --short HEAD)
echo "Releasing $TAG ($SHA: $(git -C "$SRC" log -1 --format=%s | cut -c1-70))"

# ── build, keeping the running image for a rollback ──
if [ "$ROLE" = be ]; then
  IMAGE=pid-api; CONTAINER=pid-api
  docker image inspect "$IMAGE:production" >/dev/null 2>&1 && docker tag "$IMAGE:production" "$IMAGE:prev"
  docker build -t "$IMAGE:production" "$SRC/Backend"
  if [ "$MIGRATE" = 1 ]; then
    # With the NEW image, before the new container starts: the code never runs on an old schema.
    # Migrations only add (tables, columns, indexes), so the running container is unaffected.
    echo "Applying database migrations..."
    $DC run --rm --no-deps pid-api npm run migrate
  fi
else
  IMAGE=pid-web; CONTAINER=pid-web
  docker image inspect "$IMAGE:production" >/dev/null 2>&1 && docker tag "$IMAGE:production" "$IMAGE:prev"
  docker build --build-arg VITE_DATA_SOURCE=api --build-arg VITE_API_URL=/api/v1 --build-arg "VITE_GIT_SHA=$SHA" \
    -t "$IMAGE:production" "$SRC/Frontend"
fi
$DC up -d --force-recreate

# ── check ──
status=starting
for _ in $(seq 1 45); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo missing)
  [ "$status" = healthy ] && break
  sleep 2
done
echo "Container $CONTAINER: $status"
if [ "$ROLE" = be ]; then
  BIND=$(grep -sE '^PID_API_BIND=' "$RUN/.env" | cut -d= -f2); BIND="${BIND:-172.28.80.51:3011}"
  curl -sS "http://$BIND/api/v1/health/ready" && echo
else
  BIND=$(grep -sE '^PID_WEB_BIND=' "$RUN/.env" | cut -d= -f2); BIND="${BIND:-172.28.80.50:3091}"
  curl -fsS "http://$BIND/healthz"
  curl -sS "http://$BIND/api/v1/health/ready" && echo
fi
[ "$status" = healthy ] || { docker logs --tail 40 "$CONTAINER" >&2; stop "$CONTAINER is not healthy (rollback: guide §12)"; }
echo "$CONTAINER is running $TAG. Instant rollback: docker tag $IMAGE:prev $IMAGE:production && $DC up -d --force-recreate"
