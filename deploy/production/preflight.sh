#!/usr/bin/env bash
# PID (Plant Information Dashboard) production preflight - READ-ONLY, changes nothing.
#
#   bash /opt/pid/src/deploy/production/preflight.sh be     # on 172.28.80.51
#   bash /opt/pid/src/deploy/production/preflight.sh fe     # on 172.28.80.50
#
# Reports what Docs/Guide/PRODUCTION-DEPLOYMENT.md needs before anything is installed on a host other
# applications share: is the app's port free (ss also sees host services that docker ps cannot), a /24
# for PID_SUBNET that collides with no Docker network, route, this LAN or the NAS, the NAS mounts other
# apps use (listed, never touched - PID has no NAS mount), and the outbound paths (database, gauges,
# Hub). Every line starts with OK / WARN / FAIL / INFO; paste the whole output back for review.
#
# Settings (environment, all optional): PORTS, RDS_HOST (the production database host, once known),
# STAGING_RDS_HOST, GAUGES, HUB_HOST_IP, TCP_CHECKS, URL_CHECKS, APP_HOST.
set -u
ROLE="${1:-}"
case "$ROLE" in be|fe) ;; *) echo "usage: preflight.sh be|fe"; exit 2 ;; esac
APP=pid
NAS=no
APP_HOST="${APP_HOST:-pid.kpndomain.com}"
HUB_HOST_IP="${HUB_HOST_IP:-172.28.80.50}"
RDS_HOST="${RDS_HOST:-}"
STAGING_RDS_HOST="${STAGING_RDS_HOST:-pgm-d9jx9o06qae8gf3h.pgsql.ap-southeast-5.rds.aliyuncs.com}"
# TankVision gauge units: Bontang (3) and the Tanjung Pura gateway.
GAUGES="${GAUGES:-172.16.250.15:80 172.16.250.16:80 172.16.11.77:80 172.16.11.28:80}"
if [ "$ROLE" = be ]; then
  PORTS="${PORTS:-3011}"
  TCP_CHECKS="${TCP_CHECKS:-${RDS_HOST:+$RDS_HOST:5432 }$STAGING_RDS_HOST:5432 $GAUGES $HUB_HOST_IP:443 github.com:22 registry.npmjs.org:443 registry-1.docker.io:443}"
  URL_CHECKS="${URL_CHECKS:-https://registry.npmjs.org/}"
else
  PORTS="${PORTS:-3091}"
  TCP_CHECKS="${TCP_CHECKS:-172.28.80.51:22 github.com:22 registry.npmjs.org:443 registry-1.docker.io:443}"
  URL_CHECKS="${URL_CHECKS:-https://registry.npmjs.org/}"
fi
UP=$(echo "$APP" | tr '[:lower:]' '[:upper:]')
PORTS="${PORTS:-}"
NAS="${NAS:-no}"
NAS_IP="${NAS_IP:-172.30.1.94}"
NAS_FOLDER="${NAS_FOLDER:-APPs/$UP}"
NAS_MOUNT="${NAS_MOUNT:-/mnt/$APP-nas}"
TCP_CHECKS="${TCP_CHECKS:-}"
URL_CHECKS="${URL_CHECKS:-}"
APP_HOST="${APP_HOST:-$APP.kpndomain.com}"

say() { printf '%-5s %s\n' "$1" "$2"; }
have() { command -v "$1" >/dev/null 2>&1; }
tcp() { timeout 6 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }

echo "== $APP production preflight on $(hostname) ($(hostname -I 2>/dev/null | awk '{print $1}')) $(date '+%F %T')"
for t in docker ss ip python3 curl findmnt; do have "$t" && say OK "tool $t" || say FAIL "tool $t missing"; done
docker compose version >/dev/null 2>&1 && say OK "docker compose v2 $(docker compose version --short 2>/dev/null)" || say FAIL "docker compose v2 missing"
say INFO "disk free: / $(df -h / | awk 'NR==2{print $4}'), /var/lib/docker $(df -h /var/lib/docker 2>/dev/null | awk 'NR==2{print $4}')"

# ── ports: ss sees host services too; docker ps -a sees stopped containers' reservations ──
LISTEN=$(ss -ltnH 2>/dev/null | awk '{print $4}' | sed -E 's/.*:([0-9]+)$/\1/' | sort -n | uniq)
RESERVED=$(docker ps -a --format '{{.Ports}}' | grep -oE ':[0-9]+->' | tr -d ':->' | sort -n | uniq)
say INFO "listening: $(echo $LISTEN)"
say INFO "published by containers (incl. stopped): $(echo $RESERVED)"
for P in $(echo "$PORTS" | tr ',' ' '); do
  if echo "$LISTEN $RESERVED" | tr ' ' '\n' | grep -qx "$P"; then
    for q in $(seq "$P" $((P + 60))); do
      echo "$LISTEN $RESERVED" | tr ' ' '\n' | grep -qx "$q" || { say FAIL "port $P is taken - first free at or above it: $q"; break; }
    done
  else
    say OK "port $P is free"
  fi
done

# ── docker networks, and a subnet for the app that collides with nothing ──
SUBNETS=$(docker network ls -q 2>/dev/null | xargs -r docker network inspect --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null)
say INFO "docker networks:"; echo "$SUBNETS" | sed 's/^/        /'
docker network inspect "${APP}_net" >/dev/null 2>&1 && say INFO "${APP}_net exists: $(docker network inspect "${APP}_net" --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}') - keep that value"
SUGGEST=$(NAS_IP="$NAS_IP" SUBNETS="$SUBNETS" ROUTES="$(ip -4 route show | awk '{print $1}' | grep -E '^[0-9]')" ADDRS="$(ip -4 -o addr show | awk '{print $4}')" python3 - <<'PY'
import ipaddress, os
taken = []
for tok in (os.environ["SUBNETS"] + " " + os.environ["ROUTES"] + " " + os.environ["ADDRS"]).split():
    try:
        taken.append(ipaddress.ip_network(tok, strict=False))
    except ValueError:
        pass
fence = [ipaddress.ip_network(x) for x in ("172.28.0.0/16", "172.29.0.0/16", "172.30.0.0/16", "172.31.0.0/16")]
fence.append(ipaddress.ip_network(os.environ["NAS_IP"] + "/16", strict=False))
def candidates():
    # Docker's usual pool first (172.17-172.27), then 172.16.x, then 192.168.32.x
    # and up. On the production hosts (12 Nov 2026) other apps already hold
    # every 172.17-172.31 /16 and 192.168.0-31, so the later ranges are the
    # only free ones there. Any of them must also be unused by the company's
    # office / VPN networks - the host would route replies to those users into
    # the bridge - which only infra can confirm.
    for second in range(27, 16, -1):
        for third in range(250, 0, -1):
            yield f"172.{second}.{third}.0/24"
    for third in range(250, 0, -1):
        yield f"172.16.{third}.0/24"
    for third in range(250, 31, -1):
        yield f"192.168.{third}.0/24"
for c in candidates():
    cand = ipaddress.ip_network(c)
    if not any(cand.overlaps(t) for t in taken + fence):
        print(cand)
        raise SystemExit
print("NONE")
PY
)
[ "$SUGGEST" = NONE ] && say FAIL "no free /24 in 172.16-172.27 or 192.168.32-250 - choose by hand" || say OK "suggested subnet for ${APP}_net: $SUGGEST"
case "$SUGGEST" in 172.1[7-9].*|172.2[0-7].*|NONE) ;; *) say WARN "$SUGGEST is outside Docker's usual pool - confirm with infra that the office / VPN networks do not use it";; esac
echo "$SUBNETS" | grep -Eq ' 172\.3[01]\.' && say WARN "a Docker network holds a 172.30/31 range - the NAS may be shadowed for every app on this host"

# ── NAS: list what exists, never touch it ──
say INFO "NAS mounts already on this host (other apps - leave them alone):"
findmnt -rn -t cifs,smb3,nfs,nfs4 -o TARGET,SOURCE,OPTIONS 2>/dev/null | sed 's/^/        /'
if [ "$NAS" = yes ]; then
  R=$(ip route get "$NAS_IP" 2>/dev/null | head -1)
  case "$R" in
    *" dev br-"*|*" dev docker"*) say FAIL "route to the NAS goes into a Docker bridge: $R" ;;
    "") say FAIL "no route to the NAS $NAS_IP" ;;
    *) say OK "route to the NAS: $R" ;;
  esac
  tcp "$NAS_IP" 445 && say OK "NAS $NAS_IP:445 reachable" || say FAIL "NAS $NAS_IP:445 not reachable"
  if findmnt -rn "$NAS_MOUNT" >/dev/null 2>&1; then say OK "$NAS_MOUNT mounted: $(findmnt -rn -o SOURCE,FSTYPE "$NAS_MOUNT")"
  elif [ -e "$NAS_MOUNT" ]; then say WARN "$NAS_MOUNT exists but is NOT a mount (a local folder)"
  else say INFO "$NAS_MOUNT not created yet (mount //$NAS_IP/$NAS_FOLDER there)"; fi
  have mount.cifs && say OK "cifs-utils present" || say INFO "cifs-utils missing (apt-get install -y cifs-utils smbclient)"
fi

# ── outbound ──
for hp in $TCP_CHECKS; do
  h="${hp%:*}"; p="${hp##*:}"
  tcp "$h" "$p" && say OK "$hp reachable" || say FAIL "$hp NOT reachable (firewall / whitelist / DNS)"
done
for u in $URL_CHECKS; do
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$u"); [ "$c" != 000 ] && say OK "$u -> HTTP $c" || say FAIL "$u unreachable"
done

# ── front proxy (meaningful on the web server) ──
OWNER=$(ss -ltnpH '( sport = :80 )' 2>/dev/null | head -1)
case "$OWNER" in
  *nginx*) say INFO "port 80: host nginx (shared front door) - add a vhost, nginx -t before reload" ;;
  *docker-proxy*) say INFO "port 80: a container - the vhost goes into that container's config" ;;
  "") say INFO "nothing on port 80 on this server" ;;
esac
if have nginx; then
  nginx -T 2>/dev/null | grep -q "server_name.*$APP_HOST" && say WARN "a server block for $APP_HOST already exists" || say INFO "no server block for $APP_HOST yet"
fi
getent hosts "$APP_HOST" >/dev/null && say INFO "$APP_HOST resolves to $(getent hosts "$APP_HOST" | awk '{print $1}')" || say INFO "$APP_HOST does not resolve here yet"
[ -d "/opt/$APP/src/.git" ] && say INFO "checkout: $(git -C /opt/$APP/src log --oneline -1 2>/dev/null); $(git -C /opt/$APP/src status -sb 2>/dev/null | head -1)"

# ── PID specifics ──
if [ "$ROLE" = be ]; then
  [ -z "$RDS_HOST" ] && say INFO "RDS_HOST not set - rerun with RDS_HOST=<production database host> once it exists"
  D=$(curl -s --max-time 8 --resolve "dwshub.kpndomain.com:443:$HUB_HOST_IP" https://dwshub.kpndomain.com/api/sso/.well-known/openid-configuration)
  ISS=$(printf '%s' "$D" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("issuer",""))' 2>/dev/null)
  [ -n "$ISS" ] && say OK "Hub OIDC discovery answers; issuer = $ISS  (OIDC_ISSUER, byte for byte)" || say FAIL "Hub OIDC discovery not readable via $HUB_HOST_IP:443"
  getent hosts dwshub.kpndomain.com >/dev/null && say INFO "dwshub.kpndomain.com resolves here to $(getent hosts dwshub.kpndomain.com | awk '{print $1}') (the container pins it to $HUB_HOST_IP anyway)" || say INFO "dwshub.kpndomain.com does not resolve here (fine: the container pins it to $HUB_HOST_IP)"
  docker ps -a --format '{{.Names}}' | grep -qx pid-api && say WARN "a container named pid-api already exists on this host: $(docker ps -a --filter name=^pid-api$ --format '{{.Image}} {{.Status}}')" || say OK "no container named pid-api yet"
  [ -f /etc/cron.d/pid-production ] && say INFO "/etc/cron.d/pid-production exists" || say INFO "/etc/cron.d/pid-production not installed yet (guide §9)"
  grep -q 'ssh-' /root/.ssh/authorized_keys 2>/dev/null && say INFO "root authorized_keys holds $(grep -c 'ssh-' /root/.ssh/authorized_keys) keys (the logsheet PC's is added in guide §9)"
else
  docker ps -a --format '{{.Names}}' | grep -qx pid-web && say WARN "a container named pid-web already exists on this host" || say OK "no container named pid-web yet"
  tcp 172.28.80.51 3011 && say OK "BE 172.28.80.51:3011 answers (the API is up)" || say INFO "BE 172.28.80.51:3011 not answering yet (expected before the backend release)"
  if have openssl; then
    SAN=$(echo | timeout 6 openssl s_client -connect 127.0.0.1:443 -servername dwshub.kpndomain.com 2>/dev/null | openssl x509 -noout -ext subjectAltName 2>/dev/null | tr -d '\n' | sed 's/  */ /g')
    [ -n "$SAN" ] && say INFO "host nginx certificate for dwshub covers: $SAN  (does it cover $APP_HOST? decides HTTPS later, guide §11)" || say INFO "could not read the host nginx certificate on 443"
  fi
fi
echo "== done"
