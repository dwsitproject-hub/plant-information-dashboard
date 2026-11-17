#!/usr/bin/env bash
# Nightly logical backup of the PID production database (guide §13), on the BE server, in addition to
# the RDS automatic backups. Reads DATABASE_URL from /opt/pid/secrets.production.env.
#
#   /opt/pid/src/deploy/production/backup.sh      -> /opt/pid/backups/pid-<timestamp>.dump, newest 14 kept
#   cron: /etc/cron.d/pid-production (guide §9)
set -euo pipefail
RUN="${PID_RUN_DIR:-/opt/pid}"
DIR="${BACKUP_DIR:-$RUN/backups}"
KEEP="${KEEP:-14}"
CLIENT="${PG_CLIENT_IMAGE:-postgres:18-alpine}"   # production runs PostgreSQL 18
NAME="pid-$(date +%Y%m%d-%H%M%S).dump"
mkdir -p "$DIR" && chmod 700 "$DIR"
docker run --rm --env-file "$RUN/secrets.production.env" -v "$DIR:/backups" "$CLIENT" \
  sh -euc 'pg_dump --format=custom --no-owner --no-acl --file="/backups/$0" "$DATABASE_URL"' "$NAME"
chmod 600 "$DIR/$NAME"
echo "$(date -Is) backup written: $DIR/$NAME ($(du -h "$DIR/$NAME" | cut -f1))"
ls -1 "$DIR"/pid-2*.dump 2>/dev/null | sort | head -n "-$KEEP" | xargs -r rm -f
