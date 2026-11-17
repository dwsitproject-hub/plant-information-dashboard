# Plant Information Dashboard production deployment

The Plant Information Dashboard (PID) shows tank stock, quality and production for the plants. Production is
built the same way as staging ([STAGING-3-SERVER-DEPLOY-RUNBOOK.md](STAGING-3-SERVER-DEPLOY-RUNBOOK.md)): a web
container on the frontend server, the API on the backend server, an ApsaraDB PostgreSQL database, sign-in
through the production DWS Hub. Production starts from a **copy of the staging database** and is reached at
**http://172.28.80.50:3091** until a domain and HTTPS exist (§11).

```
 Browser ──http──> 172.28.80.50:3091  pid-web (nginx: pages, /api and /auth proxy)
    │                       │
    │                       └──http──> 172.28.80.51:3011  pid-api (Node API)
    │                                      ├── ApsaraDB PostgreSQL (production PID database)
    │                                      ├── TankVision gauges 172.16.250.15/.16, 172.16.11.77 (Bontang),
    │                                      │   172.16.11.28 (Tanjung Pura gateway)   - cron, every 5 min
    │                                      ├── dwshub.kpndomain.com (Hub OIDC, via 172.28.80.50:443)
    │                                      └── DataHub production API (company / site master data)
    └──https──> dwshub.kpndomain.com (sign-in)

 Logsheet PC (site office) ──ssh/scp root──> 172.28.80.51 /opt/pid/src/staging-inbox ──docker exec──> pid-api
```

| | FE server 172.28.80.50 (ECS-App) | BE server 172.28.80.51 (ECS-DB) |
|---|---|---|
| Container | `pid-web` (image `pid-web:production`) | `pid-api` (image `pid-api:production`) |
| Port | `172.28.80.50:3091` → 80 | `172.28.80.51:3011` → 3010 |
| Compose file | `deploy/production/fe.compose.yml` | `deploy/production/be.compose.yml` |
| Settings | `/opt/pid/.env` | `/opt/pid/.env`, `/opt/pid/production.env`, `/opt/pid/secrets.production.env` |
| Deploy command | `/opt/pid/src/deploy/production/release.sh fe v1.0.0` | `/opt/pid/src/deploy/production/release.sh be v1.0.0` |
| Code | `/opt/pid/src`, at a release tag | `/opt/pid/src`, at a release tag |
| Also | (later) host nginx vhost `pid.kpndomain.com` | `/etc/cron.d/pid-production`, `/etc/logrotate.d/pid-production` |

Do the sections in order. Sections 2–6 are one-time preparation; section 7 onwards is the deployment itself.

Conventions: every command block names the machine it runs on ("PuTTY on 172.28.80.51 (BE)", "workstation",
"DMS"). Passwords and keys go into files with `nano`, never on a command line or in chat. Values to replace are
written `FILL_…`; edit them before pressing Enter.

---

## 1. Ports

| Server | Host ports already taken (docker ps, 17 Nov 2026) | PID uses |
|---|---|---|
| FE 172.28.80.50 | 80, 443 (host nginx), 1818, 2001, 3001, 3002, 3010, 3020, 3040, 3042, 3050, 3070, 3080, 3081, 3100, 3150, 3160, 8000, 8080, 8081, 8090, 8443, 9999 | **3091**, on 172.28.80.50 only |
| BE 172.28.80.51 | 3000, 3003, 4000, 4001, 4100, 4150, 4160, 5000, 5001, 5003, 5010, 5050, 5070, 5433, 5434, 8001, 8091, 13000 | **3011**, on 172.28.80.51 only |

The same numbers as staging. Only HOST ports clash: `0.0.0.0:3160->80/tcp` takes 3160, while `3000/tcp` with
no `->` is a port inside a container and takes nothing. `docker ps` cannot see services installed on the host,
so the preflight (§5) also checks with `ss`:

PuTTY on each server:
```bash
ss -ltn | grep -E ':(3011|3091) '
```
Expected: prints nothing. If a port is taken, the preflight prints the first free one; put it in
`/opt/pid/.env` as `PID_API_BIND=172.28.80.51:<port>` (BE) and `PID_BACKEND_URL=http://172.28.80.51:<port>`
(FE), or `PID_WEB_BIND=172.28.80.50:<port>` (FE), and use that number wherever this guide says 3011 / 3091.

Nothing here can cut other apps off from the NAS: PID's Docker network gets a fixed subnet chosen by the
preflight (`PID_SUBNET`, outside 172.28–172.31), PID mounts nothing from the NAS, and no step restarts Docker
or touches another app's network, container or mount.

## 2. Before you start: who provides what

| Item | From | Used in |
|---|---|---|
| Production database: ApsaraDB PostgreSQL instance (same major version as staging or newer), a database and an account that owns it, 172.28.80.51 on its whitelist | Infra / DBA | §3 |
| 172.28.80.51 on the **staging** RDS whitelist, for the one-time copy (remove afterwards) | Infra / DBA | §6 |
| PID registered in the production Hub (client id) | Hub operator | §4 |
| DataHub production URL and key pair | DataHub (DHM) integrator | §9 |
| Firewall: BE → gauges, logsheet PC → BE, users → FE (table below) | Network | §5, §9 |
| A read-only GitHub deploy key per server | You (GitHub repo settings) | §5 |
| Release tag `v1.0.0` on `main` (PR `sit` → `main`, then tag) | You | §5, §12 |
| (Later) DNS `pid.kpndomain.com` → 172.28.80.50 and a certificate | Infra | §11 |

**Decisions made for this release**
- **Address:** http://172.28.80.50:3091 (private address, plain HTTP) until the domain exists. The Hub serves
  over HTTPS, so a Hub tile must open PID **in a new tab**: inside a Hub frame the browser blocks a plain-HTTP
  page (mixed content). HTTPS is a go-live item for later (§11).
- **Data:** production starts from a copy of the staging database (§6), taken at cut-over.
- **Sign-in:** production Hub OIDC only; the legacy HS256 bridge stays off. Local accounts remain.
- **Logsheets:** the site-office PC pushes files as root over SSH, as on staging (§9). That PC holds a root key
  to a shared production host: keep it locked, and remove its key from `/root/.ssh/authorized_keys` if it is
  replaced or lost.

**Network rules**

| From | To | Why |
|---|---|---|
| Users (office / VPN) | 172.28.80.50:3091 | the app |
| 172.28.80.50 (FE) | 172.28.80.51:3011 | web container → API |
| 172.28.80.51 (BE) | production RDS :5432 | database |
| 172.28.80.51 (BE) | staging RDS :5432 | one-time copy (§6), then remove |
| 172.28.80.51 (BE) | 172.16.250.15, 172.16.250.16, 172.16.11.77, 172.16.11.28 :80 | TankVision gauges (Bontang, Tanjung Pura) |
| 172.28.80.51 (BE) | 172.28.80.50:443 | Hub OIDC (dwshub.kpndomain.com) |
| 172.28.80.51 (BE) | DataHub production API | company / site sync |
| Logsheet PC | 172.28.80.51:22 | logsheet files (SSH as root) |
| Both servers | github.com:22, registry.npmjs.org:443, registry-1.docker.io:443 | code, packages, base images |

## 3. Database on ApsaraDB RDS (once)

Use an ApsaraDB PostgreSQL instance of the **same major version as staging, or newer** (a dump does not restore
into an older major version). PID needs no extensions.

1. **Whitelist** 172.28.80.51 on the instance (Whitelist settings in the RDS console).
2. **Account:** create a standard account for PID (e.g. `pid_prod`) with a strong password; keep it in the vault.
3. **Database:** create the database (e.g. `pid_prod`) with that account as its **owner**, so PID's tables
   belong to it. Do not use the instance's privileged account in the app.
4. **Check** (DMS, logged in as the new account):
   ```sql
   select current_user, current_database(), version();
   ```
   Expected: the new account, the new database, and a PostgreSQL version not older than staging's.
5. **Backups:** turn on automatic backups (daily, 7 days or more). The nightly dump in §13 is in addition.
6. **SSL** is optional inside the VPC. If it is enforced, add `?sslmode=require` to `DATABASE_URL`.

## 4. DWS Hub registration (once, in the production Hub)

**Issuer check** - the preflight on the BE server (§5) prints `Hub OIDC discovery answers; issuer = …`. That
value goes into `OIDC_ISSUER` byte for byte.

Ask the Hub operator to register PID with:

| Field | Value |
|---|---|
| Application | Plant Information Dashboard |
| Client type | Public client, PKCE (S256), no client secret |
| Redirect URI | `http://172.28.80.50:3091/auth/oidc/callback` (byte-exact) |
| Scopes | `openid profile email` |
| Tile / launch URL | `http://172.28.80.50:3091/` - **open in a new tab** (see §2) |

They return the **client id** → `OIDC_CLIENT_ID` (§7). When the domain and HTTPS arrive (§11), the redirect URI
changes and the registration must be updated.

PID does not use the Hub SDK. Sentinel registration (repository `dwsitproject-hub/plant-information-dashboard`,
branch `main`) is optional and does not affect the deployment.

## 5. The code on each server (once per server)

Production runs a tagged release, not whatever `main` is at. Each server needs its **own** read-only deploy key
(GitHub refuses a key already used elsewhere), reached through an SSH alias so other apps' `git pull` is untouched.

PuTTY on each server (172.28.80.51, then 172.28.80.50):
```bash
ssh-keygen -t ed25519 -N '' -C "pid-prod-$(hostname)" -f /root/.ssh/pid_deploy_key && cat /root/.ssh/pid_deploy_key.pub
```
Add the printed key in GitHub: repository settings → Deploy keys → Add, **read access only**, title
`pid-prod-<server>`. Then:
```bash
grep -q '^Host github-pid$' /root/.ssh/config 2>/dev/null || printf '\nHost github-pid\n  HostName github.com\n  User git\n  IdentityFile /root/.ssh/pid_deploy_key\n  IdentitiesOnly yes\n' >> /root/.ssh/config
```
```bash
ssh -o StrictHostKeyChecking=accept-new -T github-pid; mkdir -p /opt/pid && git clone git@github-pid:dwsitproject-hub/plant-information-dashboard.git /opt/pid/src && git -C /opt/pid/src -c advice.detachedHead=false checkout v1.0.0 && git -C /opt/pid/src log --oneline -1
```
Expected: `Hi dwsitproject-hub/plant-information-dashboard! You've successfully authenticated…`, then the
release commit. (If the clone failed half way, `rm -rf /opt/pid/src` before retrying.)

**Preflight** (read-only). PuTTY on 172.28.80.51:
```bash
RDS_HOST=FILL_PRODUCTION_RDS_HOST bash /opt/pid/src/deploy/production/preflight.sh be
```
PuTTY on 172.28.80.50:
```bash
bash /opt/pid/src/deploy/production/preflight.sh fe
```
Paste both outputs back for review. What matters:

| Line | Must be | If not |
|---|---|---|
| `port 3011 is free` / `port 3091 is free` | OK | use the free port it prints (§1) |
| `suggested subnet for pid_net: …` | OK | goes into `/opt/pid/.env` as `PID_SUBNET` on THAT server |
| production RDS `:5432 reachable` | OK | RDS whitelist (§3) |
| staging RDS `:5432 reachable` (BE) | OK | staging whitelist (§2), needed for §6 only |
| gauges `172.16.x.x:80 reachable` (BE) | OK | firewall BE → gauges |
| `Hub OIDC discovery answers; issuer = …` (BE) | OK | Hub reachable via 172.28.80.50:443? |
| `no container named pid-api` / `pid-web yet` | OK | another deployment already uses the name: stop and ask |
| `a Docker network holds a 172.30/31 range` | WARN is a known pre-existing risk of other apps | report to their owners; do not change their networks |

## 6. Data from staging (once, at cut-over, BE server)

PID has no NAS files. This slot is the database copy: production starts with staging's users, roles, sites,
specs, logsheet history and gauge history.

1. **Pause staging's writers** so the copy is consistent: on the logsheet PC, disable its scheduled task for
   the cut-over; on the staging API host (172.28.92.57), comment out the gauge poll line in
   `/etc/cron.d/pid-tank-gauging` (`nano`, put `#` in front of the `*/5` line).
2. **Connection file.** PuTTY on 172.28.80.51:
   ```bash
   cp /opt/pid/src/deploy/production/copy-db.env.example /opt/pid/copy-db.env && chmod 600 /opt/pid/copy-db.env && nano /opt/pid/copy-db.env
   ```
   Fill `SOURCE_URL` (the staging database, from staging's `Backend/.env`) and `TARGET_URL` (the production
   database from §3). Percent-encode passwords with `# @ : / ? %`.
3. **Copy:**
   ```bash
   bash /opt/pid/src/deploy/production/copy-staging-db.sh
   ```
   It prints both server versions, refuses if production already has tables, dumps staging to
   `/opt/pid/backups/staging-copy-<time>.dump` (kept), restores into production, clears every user's link to
   the **staging** Hub (production Hub ids differ; each user re-links by e-mail at first sign-in), and compares
   row counts. Expected ending: the count table with `OK` (or `WARN staging wrote … more` for gauge tables if a
   poll ran) and `Copy complete.`
4. **Clean up:** `rm /opt/pid/copy-db.env`, and ask Infra to remove 172.28.80.51 from the staging whitelist.
5. Staging stays a test system. Re-enable its gauge cron line when production polls (§9).

The copy carries staging's DataHub settings, encrypted with staging's key: production cannot read them. Enter
the production DataHub settings again in §9.

## 7. Backend (BE server 172.28.80.51)

PuTTY on 172.28.80.51:
```bash
cd /opt/pid && cp src/deploy/production/compose.env.example .env && cp src/deploy/production/production.env production.env && cp src/deploy/production/secrets.production.env.example secrets.production.env && chmod 600 secrets.production.env
```
Two random values for the secrets (copy each into the vault and into the file):
```bash
openssl rand -hex 32; openssl rand -hex 32
```
```bash
nano /opt/pid/.env
```
```bash
nano /opt/pid/production.env
```
```bash
nano /opt/pid/secrets.production.env
```

| File | Setting | Value |
|---|---|---|
| `.env` | `PID_SUBNET` | the BE preflight's suggested subnet |
| `production.env` | `OIDC_ISSUER` | the issuer the preflight printed (§4) |
| `production.env` | `OIDC_CLIENT_ID` | from the Hub registration (§4) |
| `production.env` | everything else | as shipped: address http://172.28.80.50:3091, `COOKIE_SECURE=false` (HTTP), `TRUST_PROXY=172.28.80.50`, OIDC on, legacy bridge off |
| `secrets.production.env` | `DATABASE_URL` | `postgresql://<account>:<password>@<RDS host>:5432/<database>` from §3 |
| `secrets.production.env` | `JWT_SECRET` | first random value; **not** staging's |
| `secrets.production.env` | `DATAHUB_SECRET_KEY` | second random value |

Keep a copy of the three secrets in the password vault. Then:
```bash
/opt/pid/src/deploy/production/release.sh be v1.0.0
```
In order it: refuses if a `FILL_` value is left or the checkout has local edits, checks out the tag, builds
`pid-api:production` (keeping any running image as `:prev`), applies migrations with the new image **before**
starting it (after §6 they print `skip …` up to the latest), recreates the container, waits for it to be healthy.
Expected ending:
```
Container pid-api: healthy
{"ok":true,"db":"ok"}
pid-api is running v1.0.0. Instant rollback: ...
```

## 8. Frontend (FE server 172.28.80.50)

PuTTY on 172.28.80.50:
```bash
mkdir -p /opt/pid && cp /opt/pid/src/deploy/production/compose.env.example /opt/pid/.env && nano /opt/pid/.env
```
Set `PID_SUBNET` to the FE preflight's suggested subnet. Then:
```bash
/opt/pid/src/deploy/production/release.sh fe v1.0.0
```
It builds `pid-web:production` (the pages for the API at `/api/v1`), starts it with the production nginx config
(`deploy/production/nginx/pid-web.conf.template`, proxying to 172.28.80.51:3011), and checks it. Expected ending:
```
Container pid-web: healthy
ok
{"ok":true,"db":"ok"}
pid-web is running v1.0.0. ...
```
Users now open **http://172.28.80.50:3091**. The host nginx vhost (`nginx/host-vhost-pid.conf`) waits for the
domain (§11); nothing changes in the host nginx now.

## 9. First sign-in, admins and the first data load

1. **Sign in** at http://172.28.80.50:3091 with a local Administrator account from staging (same password as
   on staging).
2. **Users** (Administration → Users): deactivate staging-only test accounts; check each real user's roles and
   sites. Users signing in through the Hub are linked by e-mail the first time.
3. **Hub sign-in:** sign out, open http://172.28.80.50:3091, choose sign-in with the Hub, and confirm you land
   back signed in. (On failure the page says which step failed: §15.)
4. **DataHub** (Administration → DataHub): enter the production URL and key pair, save, run a company and a site
   sync, and check the site list. The copied staging settings cannot be read here (§6).
5. **Gauges** (Master → Tank gauging, Bontang and Tanjung Pura): each gauge system → **Test connection** →
   tanks listed. Check Daily rounds (06:30, 14:30).
6. **Schedule** - PuTTY on 172.28.80.51:
   ```bash
   cp /opt/pid/src/deploy/production/cron.pid-production /etc/cron.d/pid-production && chmod 644 /etc/cron.d/pid-production && cp /opt/pid/src/deploy/production/logrotate.pid-production /etc/logrotate.d/pid-production
   ```
   After 5 minutes: `tail -n 3 /var/log/pid-tank-gauging-poll.log` shows `nothing due` or a JSON summary. Now
   re-enable the staging gauge cron line (§6 step 5).
7. **Gauge history since the copy:** the schedule fills yesterday and today itself; for anything older (if the
   cut-over took more than a day):
   ```bash
   /opt/pid/src/deploy/production/dc.sh be exec -d pid-api sh -c "node scripts/backfill-tank-gauging.js --sites=bontang,tanjung-pura --days=7 --apply > /app/backups/gauge-backfill.log 2>&1"
   ```
8. **Logsheet PC** (site office): install its key for root on the BE server, then point it at production.
   On the PC (PowerShell):
   ```powershell
   Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@172.28.80.51 "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
   ```
   ```powershell
   ssh -o BatchMode=yes root@172.28.80.51 "docker exec pid-api node -e 'console.log(1)'"
   ```
   Expected: `1` with no password prompt. Then in `Frontend/.env.staging-push` on the PC set
   `STAGING_SSH_HOST=172.28.80.51` and `STAGING_REPO=/opt/pid/src` (keep `STAGING_SSH_USER=root`), and
   re-enable its scheduled task. Days pushed to staging after the copy: resend them from the PC's sent folder
   ([STAGING-LOGSHEET-HANDOFF.md](STAGING-LOGSHEET-HANDOFF.md), "Resend without downloading"). Files land in
   `/opt/pid/src/staging-inbox` and are loaded into `pid-api` straight away.

## 10. Go-live checks

| # | Check | Expected |
|---|---|---|
| 1 | PuTTY BE: `curl -s http://172.28.80.51:3011/api/v1/health/ready` | `{"ok":true,"db":"ok"}` |
| 2 | PuTTY FE: `curl -s http://172.28.80.50:3091/api/v1/health/ready` | the same, through the web container |
| 3 | PuTTY BE: `curl -s -D - -o /dev/null http://172.28.80.51:3011/api/v1/health \| grep -iE 'x-frame\|powered'` | `X-Frame-Options: DENY`, no `X-Powered-By` |
| 4 | Browser: sign in locally and through the Hub | both land on the app |
| 5 | Tank & Stock: Bekasi, Bontang, Tanjung Pura | current figures; "Last reading … ago" green for the gauge sites |
| 6 | Stock Overview → Commodity Stock Movement | 30 days for each site |
| 7 | Master → Tank gauging → Daily rounds (after a round time) | the round listed as Saved |
| 8 | The next logsheet push | files under `/opt/pid/src/staging-inbox/applied`, the day visible in the app |
| 9 | `docker ps` on both servers | `pid-api` / `pid-web` healthy, and **the other applications unchanged** |

## 11. HTTPS (recommended, when the domain exists)

1. DNS `pid.kpndomain.com` → 172.28.80.50. Check the FE preflight's certificate line: if the host nginx's
   certificate covers `*.kpndomain.com`, reuse it; otherwise request one.
2. PuTTY FE: install the vhost (`nginx/host-vhost-pid.conf`) with a `listen 443 ssl` server using that
   certificate and a port-80 server that redirects; `nginx -t && systemctl reload nginx` (never skip `nginx -t`).
3. PuTTY BE, `nano /opt/pid/production.env`: `APP_PUBLIC_ORIGIN=https://pid.kpndomain.com`,
   `CORS_ORIGIN=https://pid.kpndomain.com`, `COOKIE_SECURE=true`,
   `OIDC_REDIRECT_URI=https://pid.kpndomain.com/auth/oidc/callback`; then
   `/opt/pid/src/deploy/production/dc.sh be up -d --force-recreate`.
4. Hub operator: change the redirect URI and tile URL to the HTTPS address; the tile may now open PID inside
   the Hub.
5. Add `Strict-Transport-Security` at the host nginx once HTTPS is confirmed. Everyone signs in again once.

## 12. Releasing updates and rolling back

1. Test on staging first (`sit`), then open a PR `sit` → `main` and merge it.
2. Tag the merge commit and push the tag (workstation):
   ```bash
   git fetch origin && git tag -a v1.0.1 origin/main -m "v1.0.1" && git push origin v1.0.1
   ```
3. BE first, then FE:
   ```bash
   /opt/pid/src/deploy/production/release.sh be v1.0.1
   ```
   ```bash
   /opt/pid/src/deploy/production/release.sh fe v1.0.1
   ```
**Rollback:** the instant one is the line release.sh prints (retag `:prev` and recreate), or run release.sh with
the previous tag. Migrations only add tables, columns and indexes, so the previous code runs on the newer schema;
they are not reversed.

## 13. Backup and recovery

| What | Where | How |
|---|---|---|
| Database (automatic) | ApsaraDB | RDS automatic backups (§3), point-in-time restore in the console |
| Database (nightly dump) | `/opt/pid/backups/pid-<time>.dump` on BE, 14 kept | `backup.sh`, 01:40 server time (`/etc/cron.d/pid-production`) |
| The staging copy used at cut-over | `/opt/pid/backups/staging-copy-<time>.dump` | kept from §6 |
| Settings and secrets | `/opt/pid/*.env` on both servers | password vault |
| Code | GitHub, release tags | - |

Restore a dump into an **empty** database (PuTTY BE; `TARGET_URL` in a chmod-600 file as in §6):
```bash
docker run --rm --env-file /opt/pid/copy-db.env -v /opt/pid/backups:/backups postgres:17-alpine sh -c 'pg_restore --no-owner --no-acl --dbname="$TARGET_URL" /backups/FILL_DUMP_FILE.dump'
```

## 14. Running it day to day

- Health: `curl -s http://172.28.80.51:3011/api/v1/health/ready` (BE).
- Logs: `/opt/pid/src/deploy/production/dc.sh be logs --tail 100 pid-api` (errors are JSON lines with
  `"event":"request.failed"`), `dc.sh fe logs --tail 100 pid-web`; cron logs `/var/log/pid-*.log`.
- Gauge rounds: Master → Tank gauging → Daily rounds (Saved / Retrying / Failed); a Failed round after an
  outage: run the backfill for that day (§9 step 7, `--days=2`).
- Restart: `dc.sh be up -d --force-recreate` / `dc.sh fe up -d --force-recreate`.
- **Never on these shared hosts:** `systemctl restart docker`, edit `/etc/docker/daemon.json`,
  `docker system prune` / any prune, remove another app's network, container or volume, stop or reload the host
  nginx without `nginx -t`, or edit root's crontab for PID (PID's jobs live in `/etc/cron.d/pid-production`).

## 15. Troubleshooting

Everything in the staging guides applies, with `/opt/pid/src/deploy/production/dc.sh be|fe` in place of the
staging compose command.

| Symptom | Cause / fix |
|---|---|
| `STOP - fill in the FILL_ values above in /opt/pid/...` | edit the file named with `nano` |
| `STOP - chmod 600 /opt/pid/secrets.production.env` | run that command |
| `STOP - release tag v1.0.0 does not exist on GitHub` | tag and push it (§12 step 2) |
| `STOP - the code in /opt/pid/src has local changes` | `git -C /opt/pid/src status`; undo the edits (settings live in /opt/pid, never in src) |
| `set PID_SUBNET in /opt/pid/.env` | §7 / §8: the preflight's suggested subnet |
| `Pool overlaps with other one on this address space` | the subnet was taken since the preflight: rerun it, use the new suggestion |
| `copy-staging-db.sh`: `the production database is not empty` | the copy is for the first install only; restoring over data needs a fresh database |
| `copy-staging-db.sh`: a count `FAIL` | the restore failed: read the pg_restore errors above it (version older than staging? account not owner?) |
| `pg_dump: error: aborting because of server version mismatch` | `PG_CLIENT_IMAGE=postgres:18-alpine bash …copy-staging-db.sh` (client must be ≥ server) |
| `{"ok":false,"db":"unavailable"}` | `DATABASE_URL`, RDS whitelist, password percent-encoding |
| Hub sign-in returns to an error page `oidc_sub_collision` | the user was linked to another Hub id: Administration → Users, or `update users set hub_user_id = null where id = …` |
| Hub sign-in error `no_linked_sso_user` | no active PID user with that e-mail: create or fix the user |
| PID blank inside the Hub | mixed content (HTTPS Hub, HTTP PID): open PID in a new tab until §11 |
| Every user shares one address / sign-in `too_many_sign_ins_here` for a whole office | `TRUST_PROXY=172.28.80.50` in production.env and the web container from this release; or raise `LOGIN_RATE_LIMIT_PER_MINUTE` |
| Gauge `Test connection`: `… is a loopback address; the server does not call it` | the address is refused on purpose (server-side request forgery guard); use the gauge's own address |
| Gauge rounds `Retrying` / `Failed`, `archive HTTP …`, timeouts | network BE → gauges (§2); after it is fixed, backfill the day (§9 step 7) |
| Logsheet push `Permission denied (publickey)` | the PC's key is not in `/root/.ssh/authorized_keys` on 172.28.80.51 (§9 step 8) |
| Logsheet push loads nothing, `docker exec failed` | the container is not named `pid-api` or not running: `dc.sh be ps` |
| `curl: (56) Recv failure` right after a release | the container was still starting; release.sh waits for healthy and checks again |
