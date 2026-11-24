#!/usr/bin/env bash
# Put PID's vhost (http://pid.kpndomain.com) into the FE server's SHARED host nginx without disturbing
# the other applications' sites. Guide §11.
#
# PuTTY on 172.28.80.50 (FE), as root:
#   /opt/pid/src/deploy/production/nginx/install-host-vhost.sh --check    checks only, changes nothing
#   /opt/pid/src/deploy/production/nginx/install-host-vhost.sh            check, install, reload, compare
#   /opt/pid/src/deploy/production/nginx/install-host-vhost.sh --remove   take it out again (rollback)
#
# What it guarantees:
# - Stops before any change if nginx -t already fails, if another site already claims pid.kpndomain.com,
#   or if the other sites listen on port 80 in a form this vhost would not match.
# - Never reloads a configuration that fails nginx -t: PID's file is put back as it was (or removed) first.
# - Asks every other site name (http and https) and an unknown name for its status code before and after,
#   and prints any difference. It never touches another site's file, never restarts nginx (reload only).
set -uo pipefail

APP_HOST="${APP_HOST:-pid.kpndomain.com}"
FE_IP="${FE_IP:-172.28.80.50}"
WEB="${WEB:-172.28.80.50:3091}"
SRC="$(cd "$(dirname "$0")" && pwd)/host-vhost-pid.conf"
DEST="${DEST:-/etc/nginx/conf.d/pid.conf}"
STATE=/var/tmp/pid-host-vhost
MODE="${1:-install}"
UNKNOWN=pid-vhost-check.invalid

say()  { printf '%-5s %s\n' "$1" "$2"; }
stop() { say STOP "$1"; exit 1; }
conf() { nginx -T 2>/dev/null; }
# The whole configuration as one statement per line (comments dropped, file markers kept), so a site
# written as `server { listen 80; server_name a; }` on one line reads the same as a multi-line one.
stmts() {
  conf | sed '/^# configuration file /!s/#.*//' | tr ';{}' '\n\n\n' \
    | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; /^$/d'
}
server_names() { stmts | sed -n 's/^server_name[[:space:]]\{1,\}//p' | tr ' \t' '\n\n' | grep -v '^$'; }

case "$MODE" in install|--check|--remove) ;; *) stop "usage: $0 [--check|--remove]";; esac
[ "$(id -u)" = 0 ] || stop "run as root"
command -v nginx >/dev/null || stop "no nginx on this host"
systemctl is-active --quiet nginx || stop "the host nginx is not running - leaving it alone"
[ -f "$SRC" ] || stop "missing $SRC"
mkdir -p "$STATE"

# Every exact site name the host nginx serves, except PID's (wildcards, regexes and _ cannot be asked for).
names() { server_names | grep -vE '^_$|^~|[*$]' | grep -vxF "$APP_HOST" | sort -u; }
probe() {
  local n="$1" h s
  h=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "Host: $n" "http://$FE_IP/")
  s=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$n:443:$FE_IP" "https://$n/")
  echo "$n http=$h https=$s"
}
probe_all() { { names; echo "$UNKNOWN"; } | while read -r n; do probe "$n"; done; }
compare() {
  local changed
  changed=$(diff "$STATE/before.txt" "$STATE/after.txt" | sed -n 's/^> //p')
  if [ -z "$changed" ]; then
    say OK "all $(wc -l < "$STATE/after.txt") other site names answer exactly as before (http and https, plus an unknown name)"
  else
    say WARN "these answered differently after the change (before -> after):"
    echo "$changed" | while read -r line; do
      n="${line%% *}"; echo "        $(grep -m1 -F "$n " "$STATE/before.txt")  ->  $line"
    done
    say WARN "a site that was simply down or slow can flip on its own: run --check a minute later. If it is"
    say WARN "caused by this change, roll back now: $0 --remove"
  fi
}
restore() {
  if [ -f "$STATE/pid.conf.prev" ]; then cp -p "$STATE/pid.conf.prev" "$DEST"; else rm -f "$DEST"; fi
}

echo "== PID host nginx vhost ($MODE) - $(hostname) $(date '+%F %T')"
nginx -t >/dev/null 2>&1 || stop "nginx -t ALREADY fails before any change (not PID's file) - tell the server owner; nothing was done"
say OK "nginx -t passes as the server is now"

if [ "$MODE" = --remove ]; then
  [ -f "$DEST" ] || stop "$DEST is not there - nothing to remove"
  probe_all > "$STATE/before.txt"
  cp -p "$DEST" "$STATE/pid.conf.removed" && rm -f "$DEST"
  if ! nginx -t >/dev/null 2>&1; then
    cp -p "$STATE/pid.conf.removed" "$DEST"; stop "nginx -t fails without the file (?) - put it back, not reloaded"
  fi
  systemctl reload nginx && say OK "removed $DEST (copy in $STATE/pid.conf.removed) and reloaded"
  sleep 2; probe_all > "$STATE/after.txt"; compare
  exit 0
fi

# ── checks (all modes) ──
OTHERS=$(stmts | awk -v h="$APP_HOST" -v me="$DEST" '
  /^# configuration file /{f=$4; sub(/:$/,"",f)}
  $1=="server_name"{for(i=2;i<=NF;i++) if($i==h && f!=me) print f}' | sort -u)
[ -n "$OTHERS" ] && stop "$APP_HOST is already declared in: $OTHERS - two blocks for one name; find out whose it is first"
say OK "no other site declares $APP_HOST"

# How the other sites listen on port 80. A block listening on a specific address (172.28.80.50:80) wins
# that address outright, and a plain `listen 80;` block is then never consulted for it.
L80=$(stmts | sed -n 's/^listen[[:space:]]\{1,\}\([^ ]*\).*/\1/p' | grep -E '(^|:)80$' | sort | uniq -c)
say INFO "port-80 listen forms in use (count form): $(echo $L80)"
SPECIFIC=$(echo "$L80" | awk '{print $2}' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:80$' | grep -v '^0\.0\.0\.0:80$')
[ -n "$SPECIFIC" ] && stop "other sites listen on $(echo $SPECIFIC) - change 'listen 80;' in host-vhost-pid.conf to the same address, commit, then run this again"
echo "$L80" | grep -q '\[::\]:80' && say INFO "other sites also listen on IPv6 [::]:80; PID's vhost is IPv4 only (its DNS record is IPv4) - fine"
DEF=$(stmts | grep -E '^listen[[:space:]]+([^ ]*:)?80[[:space:]].*default_server' | head -1)
say INFO "port-80 default server: ${DEF:-none declared (the first block read takes unknown names)} - PID never becomes it"
WILD=$(server_names | grep -E '^(\*\.kpndomain\.com|\.kpndomain\.com|~)' | sort -u)
[ -n "$WILD" ] && say INFO "wildcard/regex names elsewhere: $(echo $WILD) - an exact name wins over them, so they keep every other subdomain"

R=$(getent hosts "$APP_HOST" | awk '{print $1}' | head -1)
case "$R" in
  "$FE_IP") say OK "$APP_HOST resolves to $FE_IP" ;;
  "") say WARN "$APP_HOST does not resolve here yet (DNS) - the vhost works as soon as it does" ;;
  *) say WARN "$APP_HOST resolves to $R, not $FE_IP - ask infra to point it at $FE_IP" ;;
esac
for d in kpndomain.com www.kpndomain.com; do
  H=$(curl -sI --max-time 6 "https://$d/" 2>/dev/null | grep -i '^strict-transport-security' | tr -d '\r')
  case "$H" in
    *[Ii]nclude[Ss]ub[Dd]omains*) say WARN "https://$d sends '$H': browsers that opened it will refuse http://$APP_HOST (they switch to https) - PID then needs HTTPS (guide §11.2)" ;;
    "") say OK "https://$d sends no HSTS for subdomains (or is not reachable from here)" ;;
    *) say OK "https://$d HSTS has no includeSubDomains" ;;
  esac
done
if curl -fsS --max-time 5 "http://$WEB/healthz" >/dev/null; then say OK "pid-web answers on $WEB"
elif [ "$MODE" = --check ]; then say WARN "pid-web does not answer on $WEB yet - deploy the frontend (guide §8) before installing"
else stop "pid-web does not answer on $WEB - deploy the frontend first (guide §8)"; fi

[ "$MODE" = --check ] && { say INFO "--check: nothing changed. Run without --check to install."; exit 0; }

# ── install ──
say INFO "asking every other site for its answer first ($(names | wc -l) names)..."
probe_all > "$STATE/before.txt"
rm -f "$STATE/pid.conf.prev"; [ -f "$DEST" ] && cp -p "$DEST" "$STATE/pid.conf.prev"
cp "$SRC" "$DEST" && chmod 644 "$DEST"
if ! nginx -t; then
  restore; stop "nginx -t failed with PID's file - put back as it was, nginx NOT reloaded, nothing changed for anyone"
fi
if ! conf | grep -qF "# configuration file $DEST:"; then
  restore; stop "this nginx does not read $(dirname "$DEST")/*.conf - rerun with DEST=<the folder the other vhosts are in>/pid.conf (removed again; nothing changed)"
fi
if ! systemctl reload nginx; then
  restore; nginx -t >/dev/null 2>&1 && systemctl reload nginx
  stop "reload failed - put back as it was"
fi
say OK "installed $DEST and reloaded nginx (reload keeps serving; no site went down)"
sleep 2
probe_all > "$STATE/after.txt"
compare
P=$(curl -s --max-time 5 -H "Host: $APP_HOST" "http://$FE_IP/healthz")
[ "$P" = ok ] && say OK "http://$APP_HOST/healthz -> ok (through the host nginx)" || say FAIL "http://$APP_HOST/healthz through the host nginx said '$P' - roll back with $0 --remove and send this output"
curl -s --max-time 8 -H "Host: $APP_HOST" "http://$FE_IP/api/v1/health/ready"; echo
echo "== done"
