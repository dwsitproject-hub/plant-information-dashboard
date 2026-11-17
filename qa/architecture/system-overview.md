# Plant Information Dashboard: System Overview

Branch `sit`, reviewed 2026-11-17 for the production release. This page describes the system as the code and configuration show it, not as the specs intend it. Where the docs disagree with the code, the code is described (see AR-24 in `findings.md`).

## 1. Purpose

The dashboard shows plant operations for palm-oil refining and storage sites: tank stock (Live Ops), the management Stock Overview across sites, storage/vessel/truck quality control, daily production, refinery quality and utilities. Data comes from three kinds of sources:

- **Operator logsheets** in Logsheet Builder: tank soundings, lab certificates, oil movement, production, utility forms.
- **Tank gauging units** (TankVision / NXA ATG) at gauged sites such as Bontang and Tanjung Pura, read over HTTP.
- **DataHub**, the group master-data service: companies, sites and plants.

## 2. Components

| Component | Technology | Location | Responsibility |
|---|---|---|---|
| SPA | React 19, Vite 8, TypeScript 6, react-router 7, recharts | `Frontend/src` | Screens. Data access goes through `src/data/api.ts` (fetch with cookie and a session-expired event) and `src/data/createRepository.ts`, which picks `httpRepository` (`VITE_DATA_SOURCE=api`) or a lazily loaded `localRepository` that reads bundled JSON mock data. Routes are code-split with `React.lazy` (`App.tsx:18-58`). |
| Web tier | nginx (`nginx:alpine`) | `Frontend/Dockerfile`, `nginx.conf`, `nginx.alicloud-app.conf` | Serves the SPA and reverse-proxies `/api/` and `/auth/` to the API (120 s read timeout). |
| API | Node 20, Express 4, `pg`, `jsonwebtoken`, `jose`, `bcryptjs` | `Backend/src/index.js` | REST under `/api/v1` and SSO under `/auth`. Routers: `auth`, `admin`, `master`, `operations`, `portfolio`, `production`, `qc`, `utility`, `tank-gauging`, `datahub`, `hub-auth`. |
| Domain logic | Plain JS modules | `Backend/src/domain/*`, `qualityRules.js`, `refineryQuality.js`, `productionReport.js` | Stock from gauge mass or calibration tables (`stock.js`), presentation and verdicts (`present.js`), portfolio summaries (`portfolio.js`), lab parameters. Much of the data access and assembly also lives in route files (`routes/operations.js` `loadSiteTanks`, `loadSiteHistory`, `certificateLabs`). |
| Access control | JWT cookie and DB-backed RBAC | `Backend/src/access.js` | `pid_session` HttpOnly cookie (HS256 JWT, 8 h). Each request reloads the user, sites, site modules, admin flag and page rights from the DB (`requireAuth`). Page rights are view/edit/delete per page key. Sites are scoped through `user_sites` and `site_modules`. |
| SSO | OIDC code flow with PKCE, plus a legacy Hub bridge | `Backend/src/sso/*`, `routes/hub-auth.js` | OIDC: `/auth/oidc/start` and `/auth/oidc/callback` (RS256 id_token, state, nonce, PKCE). Legacy: `POST /auth/hub` with an HS256 shared-secret token, single use, 300 s max age. Both map the Hub user to a local user by `hub_user_id` or email. |
| Tank gauging | Poller and archive reader | `Backend/src/tankgauging/*`, `scripts/run-tank-gauging-poll.js`, `backfill-tank-gauging.js`, `purge-tank-gauging-samples.js` | Host cron runs every 5 min. Each daily round time (default 06:30 and 14:30, site timezone) is polled once and retried every 20 min, up to 6 times. Readings go to `tank_gauging_latest` and `tank_gauging_samples` and become daily rounds in `soundings`. A gap is filled from the gauge archive. A PG advisory lock prevents overlapping runs. |
| DataHub sync | Signed HTTP client, staged review | `Backend/src/datahub/*`, `routes/datahub.js` | An admin pulls companies and sites into `datahub_sync_runs` and `datahub_sync_items`, reviews them, then applies. Keys are encrypted at rest (AES-256-GCM). |
| Logsheet ingest | Node scripts | `Frontend/scripts/sync-*.mjs` (dedicated Windows PC), `Backend/scripts/ingest-*.js`, `upsert-*.js`, `apply-staging-inbox.sh` | Scheduled tasks on a dedicated PC pull Logsheet Builder, write JSON to an outbox, `scp` it to the API host's `staging-inbox`, then `docker exec pid-api node scripts/<ingest>.js < file`. |
| Database | PostgreSQL 16 (ApsaraDB RDS in staging) | `Backend/migrations/001..016`, runner `scripts/migrate.js` | About 70 tables: org and master data, RBAC, logsheet submissions, soundings, certificates, logistics, production, utility, refinery quality, tank gauging, DataHub. Forward-only SQL migrations run in a transaction under an advisory lock. |

## 3. Main data flows

```
                        +------------------------- Browser (SPA) -------------------------+
                        |  React pages -> data/api.ts (fetch, cookie pid_session)         |
                        +-------------------------------+---------------------------------+
                                                        | HTTP :3091 (staging, plain HTTP)
   APP host 172.28.92.56                                v
   +--------------------------------------------------------------------------------------+
   | pid-web (nginx:alpine)   /            -> SPA static files (index.html no-cache)       |
   |                          /assets/     -> immutable, 1 y                               |
   |                          /api/, /auth/ -> proxy_pass 172.28.92.57:3011 (120 s)        |
   +---------------------------------------+----------------------------------------------+
                                           | VPC, SG: only APP host may reach :3011
   API host 172.28.92.57                   v
   +--------------------------------------------------------------------------------------+
   | pid-api (node:20-alpine, user node, Express 4, pg Pool defaults)                     |
   |   requireAuth -> 5 RBAC queries/request -> routes -> (domain/*, catalog cache 5 min)  |
   |   /auth/oidc/* <---> Hub OIDC provider (discovery, token, JWKS)                       |
   |   /auth/hub    <---  Hub legacy bridge POST (HS256 shared secret)                     |
   |   admin/datahub ---> DataHub (signed requests, 10 s timeout)                          |
   |   tank-gauging "Poll now" ---> TankVision units (15 s timeout)                        |
   |                                                                                       |
   |   host cron (root) --docker compose exec--> node scripts/run-tank-gauging-poll.js     |
   |                    (every 5 min)            node scripts/purge-tank-gauging-samples.js |
   |                                                 |                                     |
   |   staging-inbox/*.json <--scp-- dedicated PC     +--> TankVision units (round, archive)|
   |   apply-staging-inbox.sh --docker exec--> node scripts/ingest-*.js                    |
   +---------------------------------------+----------------------------------------------+
                                           | 5432, SG: only API host
                                           v
                       ApsaraDB RDS PostgreSQL (single app role: DDL + DML)

   Dedicated Windows PC (site office)
     Task Scheduler -> Frontend/scripts/sync-*.mjs -> Logsheet Builder (HTTPS, login)
                    -> outbox JSON -> push-staging.mjs (ssh/scp as root) -> API host inbox
```

### 3.1 Read path for a point-in-time view (Live Ops / Stock Overview)
1. `GET /api/v1/portfolio/stock`: for each site the user holds with the `live-ops` module, run in parallel (`Promise.all`).
2. `loadSiteTanks(site)` reads **all** soundings and **all** storage certificates of the site, the gauged tanks with their latest reading, the calibration catalog (5-min in-process cache) and the tank profiles. It picks the day in JS (today live for gauged sites, otherwise the latest logsheet day) and computes stock per tank.
3. The same function runs a second time for the day before, to show "change since yesterday".
4. `domain/portfolio.js` summarises per site and across the portfolio. The SPA re-requests every 60 s while the page is open.

### 3.2 Gauge round path
Cron starts `run-tank-gauging-poll.js`. It takes advisory lock 930932, works out which round slots are due (yesterday and today, site timezone), polls each enabled source, and writes rounds from samples within tolerance of the round time. Missing tanks are read from the unit's archive at the round time. The attempt outcome is upserted into `tank_gauging_round_runs` (`retrying`, `ok` or `failed`). The exit code is 1 when an attempt failed, but nothing alerts on it. A daily purge archives samples after 30 days and deletes them 7 days later, logging each row in `tank_gauging_purge_log`.

### 3.3 Logsheet ingest path
Logsheet Builder sends forms to the dedicated PC's scheduled tasks (`Frontend/scripts`), which write payloads to the outbox. Those go by `scp` to `/opt/plant-information-dashboard/staging-inbox`. `apply-staging-inbox.sh` pipes each file to an allowlisted ingest script inside the API container. Ingest upserts on business keys (`logsheet_submissions (definition_id, business_key)`, `soundings (tank_id, recorded_on, round_index)`), so re-sending a file is idempotent.

### 3.4 Sign-in
- Local: `POST /api/v1/auth/login` (bcrypt, per-username throttle of 10 failures in 15 min, in memory) sets the `pid_session` cookie.
- OIDC: PKCE, state and nonce are kept in a short-lived flow cookie. The id_token is validated against the Hub JWKS. The user is mapped by `hub_user_id` or a verified email.
- Legacy: the Hub POSTs a 60 s HS256 token, accepted only once.

## 4. Deployment topology

| Environment | Web | API | DB | How deployed |
|---|---|---|---|---|
| Dev | Vite 5176 (proxy to 3010) | `docker-compose.dev.yml` `pid-api` (migrates on start) | `pid-db` postgres:16-alpine on 127.0.0.1:5437 | `docker compose up --build` |
| SIT / staging | `docker-compose.app.yml` on 172.28.92.56:3091 | `docker-compose.backend-api-only.yml` on 172.28.92.57:3011 | ApsaraDB RDS | `deploy-staging-frontend.sh` / `deploy-staging-api.sh`: git pull on the host, `docker compose build --no-cache`, `up -d`, wait for `/api/v1/health`, then `migrate` if `RUN_MIGRATE=1`. Rollback means checking out the previous SHA and rebuilding (migrations are not reversed). |
| Production (planned) | Shared Alibaba Cloud servers, host-nginx vhost in front | Same images | ApsaraDB RDS | Not yet in the repo. |

CI (`.github/workflows/ci.yml`) runs the backend unit tests (86 pure tests), applies migrations twice to an empty Postgres 16 to prove idempotency, and loads the dev seed. For the frontend it runs `oxlint` and the production build. CI builds no images, runs no API or integration tests, has no frontend tests, and runs no dependency audit.

## 5. Key design choices worth keeping

- RBAC is reloaded from the DB on every request, so deactivating a user or changing a role takes effect immediately.
- Site scoping is enforced in middleware (`requireSiteAccess`, `requireSiteModule`). Role grants are checked against the granting user's own rights (`canGrantRole`).
- Business dates are kept as `DATE` text in the site's timezone. Day arithmetic uses the noon-UTC technique, so no off-by-one across time zones.
- The gauge scheduler records each round attempt. It is idempotent per round slot, protected by an advisory lock, and its retries persist across process restarts.
- Migrations are transactional, take an advisory lock, and CI checks that a second run changes nothing.
- External credentials (DataHub keys, gauge passwords) are encrypted at rest and never returned to the browser.
