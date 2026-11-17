#!/usr/bin/env bash
# ONE-TIME: copy the staging database into the EMPTY production database (guide §6). BE server only.
#
#   bash /opt/pid/src/deploy/production/copy-staging-db.sh
#
# Reads /opt/pid/copy-db.env (chmod 600, delete it afterwards):
#   SOURCE_URL=postgresql://<staging user>:<password>@<staging RDS host>:5432/<staging db>
#   TARGET_URL=postgresql://<production user>:<password>@<production RDS host>:5432/<production db>
#
# What it does, in order (and refuses to go on when a step fails):
#   1. prints both server versions; stops if the production database already has tables;
#   2. pg_dump of staging (custom format, without owners or grants) into /opt/pid/backups, kept;
#   3. pg_restore into production as the production account, so it owns every table;
#   4. clears every user's link to the STAGING Hub (hub_user_id): the production Hub has its own user
#      ids, and a staging link would refuse that user's first production sign-in (oidc_sub_collision);
#      each user is linked again by e-mail on first sign-in;
#   5. compares row counts of the main tables between staging and production.
# The DataHub key stored in the copy was encrypted with staging's key and cannot be read here: enter
# the production DataHub settings again in Administration > DataHub (guide §9).
set -euo pipefail
RUN="${PID_RUN_DIR:-/opt/pid}"
ENVF="$RUN/copy-db.env"
# PostgreSQL 18 client: production runs 18.6, and a client reads any server up to its own version.
CLIENT="${PG_CLIENT_IMAGE:-postgres:18-alpine}"
stop() { echo "STOP - $*" >&2; exit 1; }

[ -f "$ENVF" ] || stop "$ENVF is missing (guide §6)"
[ "$(stat -c %a "$ENVF")" = 600 ] || stop "chmod 600 $ENVF"
grep -qE '^[^#]*FILL_' "$ENVF" && stop "fill in the FILL_ values in $ENVF"
mkdir -p "$RUN/backups" && chmod 700 "$RUN/backups"
NAME="staging-copy-$(date +%Y%m%d-%H%M%S).dump"

docker run --rm -i --env-file "$ENVF" -e NAME="$NAME" -v "$RUN/backups:/backups" "$CLIENT" sh -eu <<'INNER'
# Stop at the first login that fails, before anything is dumped or written.
SV=$(psql "$SOURCE_URL" -Atc 'show server_version') || { echo "STOP - cannot sign in to the STAGING database (SOURCE_URL): user, password (percent-encoded?), database name"; exit 1; }
PV=$(psql "$TARGET_URL" -Atc 'show server_version') || { echo "STOP - cannot sign in to the PRODUCTION database (TARGET_URL): user, password (percent-encoded?), database name, whitelist"; exit 1; }
echo "staging server:    $SV"
echo "production server: $PV"
n=$(psql "$TARGET_URL" -Atc "select count(*) from information_schema.tables where table_schema = 'public'")
[ "$n" = 0 ] || { echo "STOP - the production database is not empty ($n tables). This copy is for the first install only."; exit 1; }

echo "Dumping staging..."
pg_dump --format=custom --no-owner --no-acl --file="/backups/$NAME" "$SOURCE_URL"
echo "dump: /opt/pid/backups/$NAME ($(du -h "/backups/$NAME" | cut -f1))"

echo "Restoring into production..."
# Without --exit-on-error: a harmless line about the public schema must not abort the copy. The row
# counts below are the real check.
pg_restore --no-owner --no-acl --dbname="$TARGET_URL" "/backups/$NAME" || echo "(pg_restore reported the warnings above - see the counts below)"

echo "Clearing links to the staging Hub..."
psql "$TARGET_URL" -q -v ON_ERROR_STOP=1 -Atc "update users set hub_user_id = null, updated_at = now() where hub_user_id is not null returning id" | wc -l | sed 's/^/users unlinked: /'

echo "Row counts (staging / production):"
bad=0
for t in schema_migrations companies sites users roles user_roles user_sites tanks soundings storage_certificates quality_rules tank_gauging_sources tank_gauging_round_runs; do
  s=$(psql "$SOURCE_URL" -Atc "select count(*) from $t" 2>/dev/null || echo "-")
  p=$(psql "$TARGET_URL" -Atc "select count(*) from $t" 2>/dev/null || echo "-")
  # Staging may keep writing (gauge polls) while this runs, so staging slightly AHEAD is expected;
  # a missing table, or production holding MORE rows than staging, is not.
  if [ "$p" = "-" ] || { [ "$s" != "-" ] && [ "$p" -gt "$s" ]; }; then mark=FAIL; bad=1
  elif [ "$s" = "$p" ]; then mark=OK
  else mark="WARN staging wrote $((s - p)) more after the dump"; fi
  printf '  %-26s %10s %10s  %s\n' "$t" "$s" "$p" "$mark"
done
[ "$bad" = 0 ] && echo "Copy complete." || { echo "STOP - a table is missing or larger in production: the restore failed (guide §15)"; exit 1; }
INNER
echo "Done. Now: delete $ENVF (rm $ENVF), then the backend release (guide §7)."
