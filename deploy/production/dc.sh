#!/usr/bin/env bash
# Docker Compose for PID's production containers. The compose files stay in the checkout; everything
# filled in on the server is read from /opt/pid (.env, production.env, secrets.production.env).
#
#   /opt/pid/src/deploy/production/dc.sh be ps          # on 172.28.80.51
#   /opt/pid/src/deploy/production/dc.sh fe logs -f     # on 172.28.80.50
set -euo pipefail
ROLE="${1:-}"
case "$ROLE" in be|fe) shift ;; *) echo "usage: dc.sh be|fe <docker compose command...>" >&2; exit 2 ;; esac
RUN="${PID_RUN_DIR:-/opt/pid}"
HERE="$(cd "$(dirname "$0")" && pwd)"
exec docker compose --project-directory "$RUN" -f "$HERE/$ROLE.compose.yml" "$@"
