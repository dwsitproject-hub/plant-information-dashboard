# Architecture Review Findings: Plant Information Dashboard

Scope: branch `sit` at `ed63d97`, reviewed 2026-11-17 before the production release. Evidence comes from the code, configs and docs, and from read-only checks on the local QA stack: `pid-qa-db` (EXPLAIN ANALYZE, catalog queries) and the API on 127.0.0.1:3010 (unauthenticated probes only). The frontend production build was written to a scratch directory, and one backend image was built and then deleted. No repository file outside `qa/architecture/` was changed.

How to read the fields:
- **Severity.** High: blocks or seriously risks go-live. Medium: fix before go-live or in the first hardening sprint. Low: plan it.
- **Effort.** S is under a day, M is 1 to 3 days, L is more than 3 days or a refactor.
- **Quick fix.** Yes means it is low risk, local and can be done now.

## Summary table

| ID | Viewpoint | Sev | Title | Effort | Quick fix |
|---|---|---|---|---|---|
| AR-01 | Observability / API | High | Global error handler logs nothing; malformed JSON returns 500 | S | Yes |
| AR-02 | Performance | High | Point-in-time screens load the full sounding and certificate history of each site, twice per site, every 60 s | M | No |
| AR-03 | Deployability | High | Node 20 runtime is end-of-life; base images are floating tags | S | Yes (with regression run) |
| AR-04 | Security / Config | High | Production-unsafe defaults: plain HTTP, `COOKIE_SECURE=false`, legacy SSO bridge on, staging origin baked in, no CSP/HSTS | S | Yes |
| AR-05 | Reliability | Medium | Health check ignores the DB; no container HEALTHCHECK; no graceful shutdown | S | Yes |
| AR-06 | Reliability | Medium | DB pool and outbound OIDC calls have no limits or timeouts | S | Yes |
| AR-07 | Reliability | Medium | Unhandled async rejection path can stop the API process | S | Yes |
| AR-08 | Deployability | Medium | Migrations run after new code is live; no pre-deploy backup; images built on the host | M | Partly (reorder is S) |
| AR-09 | Observability | Medium | No access log, no audit trail of admin actions, no metrics or alerting, unbounded container logs | M | No |
| AR-10 | Data | Medium | Missing site_id and FK indexes on site-scoped tables; duplicate index on soundings | S | Yes |
| AR-11 | Data / Security | Medium | Username and email unique by case, but login matches case-insensitively with LIMIT 1 | S | Yes |
| AR-12 | Data | Medium | Retention moves growth instead of bounding it (purge log, submission history) | S-M | Partly |
| AR-13 | Performance | Medium | 781 kB main chunk carries 399 kB of Bekasi calibration JSON; gzip is off in nginx | S / M | Yes (gzip) / No (bundle) |
| AR-14 | Structure | Medium | Stock and quality logic duplicated in frontend and backend; calibration edits stored only in browser localStorage | M-L | No |
| AR-15 | Structure | Medium | Routes hold data access and domain assembly; portfolio router imports another router | L | No |
| AR-16 | API | Medium | Inconsistent error model and validation; no pagination; date filters applied in JS | M | No |
| AR-17 | Security | Medium | Encryption key for stored credentials falls back to JWT_SECRET; decrypt failures are swallowed | S | Yes |
| AR-18 | Security | Medium | One DB role for migrations and runtime (QA uses superuser) | S-M | No |
| AR-19 | Security | Medium | Session design: no revocation, cookie and JWT lifetimes not tied, per-username lockout, state held in memory | M | Partly |
| AR-20 | Performance | Medium | 5 RBAC queries per request; N+1 in live points; parallel site fan-out on a default pool | S-M | Partly |
| AR-21 | Maintainability | Low | TypeScript strict off (compiles clean with `--strict`); 62 lint warnings; no frontend tests; no API tests | S / M | Yes (strict) |
| AR-22 | Docs / Ops | Low | Docs drift from code; no production runbook or backup policy | S-M | No |
| AR-23 | Structure | Low | Dead schema and dead code paths shipped | S-M | No |
| AR-24 | Ops | Low | Scheduler and ingest coupled to the API container and to root SSH from a desk PC | M | No |
| AR-25 | Security / Structure | Low | Authorization written four different ways; `/master/org` open to any signed-in user | S-M | No |
| AR-26 | Mixed | Low | Smaller consistency issues: DATE parsing per process, migration hygiene, no React error boundary or fetch abort, optional OIDC nonce | S | Yes |

Quick, low-risk fixes that can be done now: AR-01, AR-03, AR-04, AR-05, AR-06, AR-07, AR-10, AR-11, AR-13 (gzip), AR-17, AR-20 (the N+1 part), AR-21 (strict), AR-26, and the migrate reorder in AR-08.

Larger work to plan: AR-02, AR-08 (pipeline), AR-09, AR-12, AR-13 (bundle), AR-14, AR-15, AR-16, AR-18, AR-19, AR-22, AR-23, AR-24, AR-25.

---

### AR-01 Global error handler logs nothing; malformed JSON returns 500 (High, Observability / API)
- **Evidence.**
  - `Backend/src/index.js:44-49`: the final error middleware returns `500` and never calls `console.error`, so failures leave no trace in production.
  - The handler ignores `error.status` and `error.type`. Probe: `POST /api/v1/auth/password` with body `{bad` returned `500 {"error":"Expected property name or '}' in JSON at position 1 ..."}`. A client mistake becomes a 500, and outside `NODE_ENV=production` the parser message is echoed.
  - The whole backend `src` has only 7 `console.*` calls outside tests.
- **Impact.** Production incidents cannot be diagnosed, and 4xx/5xx statistics are wrong.
- **Recommendation.** Log `{method, path, status, userId, stack}` as JSON. Map `entity.parse.failed` and any `err.status` from 400 to 499 to a 4xx (`invalid_json`). Keep the generic 5xx message in production. Add `app.disable('x-powered-by')`.
- **Effort** S. **Quick fix** yes.

### AR-02 Point-in-time screens load the full history of each site (High, Performance)
- **Evidence.**
  - `Backend/src/routes/operations.js:234-243`: `loadSiteTanks` selects every sounding of the site with no date predicate, plus every certificate and parameter (`certificateLabs`, `:106-131`). It then picks one day in JS.
  - `routes/portfolio.js:38-39` calls it twice per site for all sites, and `:121` calls it again for `/portfolio/movement`.
  - `Frontend/src/features/management/StockOverviewPage.tsx:35,75` refreshes every 60 s per open tab.
  - Other unbounded reads: `/snapshot` (`operations.js:183-222`), `/analytics/summary` (`:534-545`), `/tanks/:tankId/soundings` (`:516`, no range), `loadTankLabs` (`:478-479`: all site certificates, filtered in JS), `qc.js:74,138,207` (from/to filtering in JS).
  - On QA, both queries are seq scans returning everything: 2,407 soundings in 1.8 ms and 1,472 certificate rows. The cost grows linearly: about 730 rows per gauged tank per year at 2 rounds/day. At 5 sites x 40 tanks, one refresh moves about 2 x 29k rows per site after a year, every 60 s per tab.
- **Impact.** Unbounded latency and CPU growth on the shared API host. The management page degrades first.
- **Recommendation.**
  1. Query only the needed days: `MAX(recorded_on)`, then `recorded_on IN (day, day-1)`.
  2. Get the latest certificate per tank with `DISTINCT ON`.
  3. Push filters into SQL, including `qc.js` and a tank predicate in `loadTankLabs`.
  4. Add a 30 to 60 s per-site cache or a "latest stock" table.
  5. Cap history ranges.
- **Effort** M. **Quick fix** no.

### AR-03 Node 20 runtime is end-of-life; floating base images (High, Deployability)
- **Evidence.** `Backend/Dockerfile:1` (`node:20-alpine`; the built image runs v20.20.2), `Frontend/Dockerfile:4`, and `.github/workflows/ci.yml` (`node-version: 20`). Node 20 reached end-of-life on 2026-04-30. `Frontend/Dockerfile:22 nginx:alpine` and the other tags float.
- **Impact.** An unpatched runtime at go-live and non-reproducible builds.
- **Recommendation.** Move to Node 22 or 24 LTS in both Dockerfiles, CI and `engines`. Pin nginx and node tags (digest preferred). Re-run the tests and regression.
- **Effort** S. **Quick fix** yes.

### AR-04 Production-unsafe defaults and transport (High, Security / Configuration)
- **Evidence.**
  - `docker-compose.backend-api-only.yml:34` defaults `COOKIE_SECURE` to `false`; `:37` defaults `SSO_LEGACY_BRIDGE_ENABLED` to `true`, while the code default is `false` (`sso/oidc-config.js:16`); `:35` defaults `APP_PUBLIC_ORIGIN` to the staging IP; `:19-20` publishes the API on all interfaces (only the cloud security group restricts it).
  - Staging is plain HTTP (runbook line 3). There is no HSTS or CSP.
  - `location = /index.html` (`nginx.alicloud-app.conf:53-58`) has its own `add_header`, so `X-Frame-Options` (`:23`) is not sent on the HTML.
- **Impact.** Cookies and SSO tokens could travel in clear text, the legacy bridge could stay on in production by default, and there is no clickjacking or CSP protection.
- **Recommendation.** Make production fail closed (`COOKIE_SECURE`/`APP_PUBLIC_ORIGIN` with `:?`, bridge default `false`); terminate TLS with HSTS at the host nginx; bind the API to the private IP; add a CSP with `frame-ancestors` on the `index.html` location, and helmet on the API.
- **Effort** S. **Quick fix** yes.

### AR-05 Shallow health check, no container healthcheck, no graceful shutdown (Medium, Reliability)
- **Evidence.** `index.js:28-30`: health does not touch the DB, so the deploy gate (`deploy-staging-api.sh:70-89`) passes with a broken `DATABASE_URL`. No HEALTHCHECK in either Dockerfile or compose file. `index.js:51` has no SIGTERM handler, and Node runs as PID 1 without `init`; Docker SIGKILLs after 10 s, cutting in-flight requests, polls and syncs. The dev compose uses `sh -c` (`:53`), which does not forward signals.
- **Recommendation.** Add `/health/ready` (`SELECT 1`, 2 s) for the deploy gate and the compose healthcheck. Add `init: true`. On SIGTERM: `server.close()`, then `pool.end()`.
- **Effort** S. **Quick fix** yes.

### AR-06 DB pool and outbound calls have no limits or timeouts (Medium, Reliability)
- **Evidence.** `db.js:7-9` uses the defaults: `max` 10, no `connectionTimeoutMillis`, no `statement_timeout`, no `application_name`. Scripts create their own pools (`run-tank-gauging-poll.js:22`, `migrate.js:11`). `sso/oidc-client.js:8` calls `fetch` without a timeout, and `:45` creates a new JWKS set on every login. DataHub (10 s) and gauges (15 s) do have timeouts.
- **Impact.** A slow RDS or Hub turns into hung requests up to nginx's 120 s and an exhausted pool.
- **Recommendation.** One shared pool factory with `max`, `connectionTimeoutMillis: 5000`, `idleTimeoutMillis`, `statement_timeout: 30000` and `application_name`. `AbortSignal.timeout(10000)` on OIDC calls; cache the JWKS set per URI.
- **Effort** S. **Quick fix** yes.

### AR-07 Unhandled async rejection path can stop the API (Medium, Reliability)
- **Evidence.** `routes/datahub.js:131` awaits `getEffectiveConfig(pool)` outside the `try`. Express 4 does not forward rejected promises, so on Node 15 and later a DB error there ends the process. The hazard is known (`tank-gauging.js:30-31` comment) but nothing enforces the rule, and there is no `unhandledRejection` handler.
- **Impact.** One transient DB error on an admin action restarts the API and clears in-memory state: throttle, replay guard, cache.
- **Recommendation.** Move the await into the try. Wrap every route in an `asyncHandler` (or move to Express 5). Add a process-level handler that logs.
- **Effort** S. **Quick fix** yes.

### AR-08 Deploy order, backups and build provenance (Medium, Deployability)
- **Evidence.** `deploy-staging-api.sh:84-96` runs `up -d` (new code live), then the health wait, then `migrate`, and only if `RUN_MIGRATE=1`. No snapshot or `pg_dump` is taken before migrating. Rollback does not reverse migrations (`:118`), and there are no down scripts. Images are built on each host from `git pull` (`build --no-cache`), with no registry or versioned tag. Dev migrates on start and staging does not.
- **Impact.** Schema and code skew during deploys, no tested restore point, and non-reproducible releases.
- **Recommendation.** 1) Run `compose run --rm pid-api npm run migrate` before `up`, by default. 2) Take an automatic RDS snapshot or `pg_dump` first. 3) Keep migrations expand/contract compatible. 4) Build once in CI and push `:<sha>` to ACR. 5) Document RPO/RTO and test a restore.
- **Effort** M. **Quick fix** partly (the reorder is S).

### AR-09 Observability and audit gaps (Medium, Observability)
- **Evidence.** No access log or request id (`index.js`), no metrics, no alerts. The poller's exit code 1 (`run-tank-gauging-poll.js:11,32`) goes to `/var/log/pid-tank-gauging-poll.log` (`TANK-GAUGING-POLLER-CRON.md:80-82`) with no logrotate and no alert. No audit table: user, role, activation, module, spec, gauge-source and DataHub-apply changes record at most `updated_by` on a few config tables; `users`, `roles` and `role_permissions` keep no history. Compose sets no `logging:` options, so json-file logs grow without bound on shared hosts.
- **Impact.** No one can answer who granted Administrator, failed rounds go unnoticed, and there is no performance baseline.
- **Recommendation.** 1) Structured JSON logs (request id, user, route, status, ms). 2) An `audit_log` table written in the same transaction as each admin change. 3) Docker log rotation (10 MB x 5) and logrotate for the cron logs. 4) Turn poller failures into an alert.
- **Effort** M.

### AR-10 Missing indexes on site-scoped tables; duplicate index (Medium, Data)
- **Evidence.** No `site_id` index on `storage_certificates`, `logistics_events`, `analytics_movements`, `vessel_tickets`, `truck_batches` or `gate_movements` (EXPLAIN shows seq scans with `Filter: site_id`). 56 single-column FKs have no index, including `soundings.submission_id`, `storage_certificates.submission_id`, `user_sites.site_id` and `user_roles.role_id`. `soundings_site_day` (`001_foundation.sql:490`) and `soundings_site_recorded_idx` (`004_sounding_and_certificate.sql:12`) are identical.
- **Impact.** Linear scans as data grows, slower ingest, and heavy deletes during site reloads.
- **Recommendation.** `017_indexes.sql` with `CREATE INDEX IF NOT EXISTS`: `storage_certificates (site_id, tank_id, analysis_date)`, `logistics_events (site_id, sampled_on)`, `site_id` on the other four tables, `submission_id` on soundings and certificates, `user_sites (site_id)`, `user_roles (role_id)`. Then drop `soundings_site_day`.
- **Effort** S. **Quick fix** yes.

### AR-11 Case-insensitive login over case-sensitive uniqueness (Medium, Data / Security)
- **Evidence.** `access.js:219-226` matches `LOWER(username)=LOWER($1) OR LOWER(email)=LOWER($1) LIMIT 1`. The uniques are case-sensitive (`users_username_key`, `users_email_key`), with no LOWER index. `Admin` and `admin` can coexist, and login then picks an arbitrary row. SSO (`resolve-user.js:32-38`) refuses an ambiguous email; password login does not. EXPLAIN shows a seq scan.
- **Recommendation.** Check for duplicates, then add `UNIQUE (LOWER(username))` and `UNIQUE (LOWER(email)) WHERE email IS NOT NULL`. Normalise on write.
- **Effort** S. **Quick fix** yes.

### AR-12 Retention moves growth instead of bounding it (Medium, Data)
- **Evidence.** `tankgauging/purge.js:33-34,50-51` writes a purge-log row for each archived sample and again for each deleted one; the log is never purged. `submission_history` stores every ingest payload (`ingestOilMovement.js:94`, `ingestProduction.js:40`) with no retention. No retention for `datahub_sync_items` or `tank_gauging_round_runs`. Soundings are kept forever by design.
- **Recommendation.** Log purge batches as aggregates, or purge the log after N days. Define and enforce retention per table in the daily job.
- **Effort** S-M. **Quick fix** partly.

### AR-13 Frontend bundle carries seed data; gzip is off (Medium, Performance)
- **Evidence.** `vite build`: `index` 781 kB (276.6 kB gzip), `localRepository` 495 kB, `CartesianChart` 339 kB, `QcContext` 207 kB; 66 assets, 5.5 MB in total. The main chunk contains `tankCalibration.json` (399 kB), pulled in by `domain/tankStock.ts:1` -> `data/CalibrationContext.tsx:12` -> `App.tsx:68` for every route, although the API computes stock server-side. `QcContext.tsx:3` statically imports `qc.json` (216 kB) even in API mode. Neither nginx config enables gzip.
- **Impact.** About 2.6 MB of JS sent uncompressed on first load over plant WANs.
- **Recommendation.** Now: `gzip on;` with `gzip_types` for JS, CSS, JSON and SVG in both configs. Planned: load calibration and QC mock JSON with dynamic `import()` only in local mode or on the calibration pages.
- **Effort** S / M. **Quick fix** gzip yes.

### AR-14 Duplicated domain logic and a second calibration source of truth (Medium, Structure)
- **Evidence.** Stock logic exists twice (`Frontend/src/domain/tankStock.ts` and `Backend/src/domain/stock.js`), as does presentation (`present.ts` and `present.js`) and QC verdicts (`qc.ts`/`qualityView.ts` and `qualityRules.js`): 3,104 lines of frontend domain code. `CalibrationContext.tsx:14` keeps calibration edits in `localStorage`, which the server never sees. `QuantityHistoryDialog.tsx:22` uses the bundled Bekasi `bottomStockKg` by tank code for any site. The TSD documents a nonexistent `DELETE /calibration/tanks/:tankId`.
- **Impact.** Screens can disagree, calibration edits stay invisible to everyone else, and every rule change must be made twice.
- **Recommendation.** Make the API the single owner of stock and verdict computation. Build calibration CRUD over `tank_profiles` or make the page read-only. Remove bundled profiles from API mode and fix the dialog lookup.
- **Effort** M-L.

### AR-15 Layering: routes own data access and domain assembly (Medium, Structure)
- **Evidence.** `routes/operations.js` (622 lines) holds the SQL and assembly and exports loaders that `routes/portfolio.js:11` imports from a router. `routes/admin.js` (598 lines) repeats BEGIN/ROLLBACK/COMMIT boilerplate five times. No service or repository layer; the assembly code is untested.
- **Recommendation.** Extract `services/siteStock.js` and `repositories/*`; keep routes thin; add a `withTransaction(fn)` helper. Plan together with AR-02.
- **Effort** L.

### AR-16 API error model, validation and pagination are inconsistent (Medium, API design)
- **Evidence.** Error bodies mix codes and sentences (`{"error":"invalid_range"}`, `{"error":"Site not found"}`, `{"error":"DataHub is not configured."}`). Errors become 400 by regex on message text (`datahub.js:76`, `tank-gauging.js:48`). No schema validation: dates are checked in some places (`operations.js:498-501`, utility `ISO`) but not others (`qc.js:43-44`, `live/tanks?on=`). Malformed JSON returns 500 (AR-01). No pagination or caps except `/admin/datahub/runs`. `/analytics/movements` counts in JS instead of `GROUP BY`.
- **Recommendation.** One envelope `{error: code, message?, details?}` with an `HttpError` class, schema validation middleware, `limit`/range caps, and filters and aggregates in SQL.
- **Effort** M.

### AR-17 Credential-encryption key coupled to JWT_SECRET (Medium, Security)
- **Evidence.** `datahub/config.js:9-12` derives the AES-256-GCM key from `sha256(DATAHUB_SECRET_KEY || JWT_SECRET)`. `DATAHUB_SECRET_KEY` is in no `.env*.example`, so in practice `JWT_SECRET` also encrypts DataHub keys and gauge passwords (`tankgauging/sources.js:4,26-31`). `sources.js:28-30` swallows decrypt failures.
- **Impact.** Rotating `JWT_SECRET` silently breaks every stored credential, and one leaked secret compromises both sessions and stored credentials.
- **Recommendation.** Require a dedicated `DATA_ENCRYPTION_KEY` outside dev (fail at startup if missing). Log decrypt failures. Document rotation with a re-encryption script.
- **Effort** S. **Quick fix** yes.

### AR-18 One database role for migrations and runtime (Medium, Security)
- **Evidence.** `docker-compose.backend-api-only.yml:30`: the same `POSTGRES_USER` runs the API and `npm run migrate`. QA connects as the superuser `postgres`. No doc describes the RDS grants.
- **Impact.** A compromise of the API process can alter or drop the schema.
- **Recommendation.** `pid_owner` (DDL, migrate only) and `pid_app` (DML and sequence usage), with default privileges.
- **Effort** S-M.

### AR-19 Session design limits (Medium, Security)
- **Evidence.** The JWT lifetime follows `JWT_EXPIRES_IN`, but the cookie `maxAge` is hard-coded to 8 h (`access.js:115-124`). Logout only clears the cookie (`auth.js:27-30`), and a password change does not invalidate other sessions (`auth.js:58-61`); deactivation is immediate. `loginThrottle.js:9` locks per username, which enables a targeted lockout of the admin. The throttle and the SSO replay guard are held in memory. The minimum password length is 6 (`auth.js:42`, `admin.js:423,475`).
- **Recommendation.** `users.session_version` in the JWT, bumped on password change or sign-out-everywhere; tie the cookie `maxAge` to the JWT lifetime; throttle by username + IP with progressive delay; minimum 10-12 characters; move in-memory state to the DB if the API scales out.
- **Effort** M. **Quick fix** partly.

### AR-20 Per-request query cost and N+1 patterns (Medium, Performance)
- **Evidence.** `requireAuth` (`access.js:130-142`) calls `loadSession` (`:46-113`): 5 sequential queries on every request. `livePoint` (`operations.js:422-424`) queries per gauged tank and is called in loops at `:451` and `:471`. `portfolio.js:33-50` and `:115-141` run unbounded `Promise.all` over sites against a pool of 10.
- **Recommendation.** Collapse `loadSession` into one query or cache it per user for 30-60 s. Load gauge profiles once per site. Limit portfolio concurrency to about 3.
- **Effort** S-M. **Quick fix** partly (the N+1 is S).

### AR-21 Typing, lint and tests (Low, Maintainability)
- **Evidence.** `Frontend/tsconfig.app.json` has no `strict`, yet `tsc --strict` gives 0 errors. `oxlint`: 0 errors and 62 warnings. 0 frontend test files. Backend: 86/86 unit tests on pure modules, but no route or integration tests. CI builds no images and runs no audit.
- **Recommendation.** Enable `strict` now; add Vitest for `src/domain`; add a supertest suite against the CI Postgres covering auth, site scoping and portfolio; add `docker build` and `npm audit` to CI.
- **Effort** S / M. **Quick fix** strict yes.

### AR-22 Documentation drift; no production runbook (Low, Docs / Ops)
- **Evidence.** `DATABASE-DESIGN.md:7` covers only `001`, while 16 migrations exist (73 tables). The TSD documents a nonexistent calibration API and says OIDC is out of release, but it is built. `README.md` is 2 lines. No production runbook, backup/restore procedure, RPO/RTO, alert guide or secret-rotation procedure. `Docs/_parse_log.js` is a stray script.
- **Recommendation.** Regenerate DATABASE-DESIGN, update the TSD API table, and write a production runbook (expected from `prod-deploy-prep`).
- **Effort** S-M.

### AR-23 Dead schema and dead code paths (Low, Structure)
- **Evidence.** No code references `production_measures`, `utility_measures`, `checklist_results`, `field_map_versions`, `field_map_rows`, `supporting_materials`. `lab_results` is only written and deleted by seed and loader scripts. The local mock mode ships `localRepository` (495 kB), `logsheets.json`, `qc.json` and `refineryQuality.json`. About 5,500 lines of ingest scripts live in `Frontend/scripts`, and the SPA `package.json` carries `nodemailer` for them.
- **Recommendation.** Decide the future of local mode. Drop unused tables with a contract migration. Move the ingest scripts into their own package.
- **Effort** S-M.

### AR-24 Scheduler and ingest coupling (Low, Operations)
- **Evidence.** Root cron runs `docker compose exec pid-api ...` every 5 min, so the poller depends on the API container's lifecycle. "Poll now" runs synchronously inside an HTTP request (`tank-gauging.js:193-199`), bounded only by nginx's 120 s. Ingest is pushed from a desk PC over SSH as root with `StrictHostKeyChecking=accept-new` (`push-staging.mjs:12`).
- **Recommendation.** A separate `pid-worker` service; asynchronous "Poll now" (202); an unprivileged, restricted inbox user or an HTTPS ingest endpoint.
- **Effort** M.

### AR-25 Authorization implemented four ways (Low, Security / Structure)
- **Evidence.** Router middleware (`qc.js:10`, `operations.js:144-151`, `portfolio.js:15`), inline checks (`master.js:170,197`), a local helper (`utility.js:46-52`), and a different Administrator rule in `tank-gauging.js:23-28`. `GET /master/org` (`master.js:120`) needs only `requireAuth`, so any signed-in user can list every company, site and plant. Permission keys are duplicated as string literals between the frontend and `access.js:5-25`.
- **Recommendation.** One declared policy per router with an explicit Administrator rule; gate `/master/org` behind a `master-*` view right; a route-table test asserting every route is guarded.
- **Effort** S-M.

### AR-26 Smaller consistency issues (Low)
- **DATE parsing differs per process.** `db.js:5` gives the API text dates, but scripts' own pools get `Date` objects; compensated ad hoc (`schedule.js`, `dayText`). Fix with the AR-06 pool factory.
- **Migration hygiene.** Two files share the `005_` prefix; no checksum in `schema_migrations`.
- **Frontend resilience.** No React error boundary, and no `AbortController`, so a stale response can overwrite a newer site switch.
- **OIDC nonce.** Optional (`sso/oidc-flow.js:71-73`). The legacy bridge links by an unverified email (`hub-auth.js:143-148`). Require the nonce, and disable the bridge once OIDC is live.
- **Date helpers.** Day arithmetic is duplicated in at least 5 places.
- Effort S. Quick fix yes.

---

## Strengths worth keeping
1. Server-side RBAC reloaded per request, so deactivation and role changes apply at once. Site and module scoping live in middleware. Role-grant escalation is prevented (`canGrantRole`) and tested.
2. SSO: PKCE, state and nonce in a flow cookie, RS256 and HS256 pinning, max token age, a single-use replay guard, iframe breakout, and verified-email linking with collision checks.
3. Gauge scheduler: advisory lock, persisted per-round attempts (`tank_gauging_round_runs`), configurable retries, an archive fallback at the round time, a backfill script, and unit tests.
4. Migrations: transactional, under an advisory lock, with CI proving a second run is a no-op.
5. Timezone discipline: per-site timezone, `DATE` as text, noon-UTC arithmetic, round times local to the site.
6. Secrets encrypted at rest and never returned to the browser. `.dockerignore` excludes `.env` and dumps. The API runs as non-root `node` (209 MB image).
7. Outbound timeouts on DataHub (10 s) and gauges (15 s).
8. Destructive-script guard (`scripts/guard.js --confirm-site`).
9. Pure, tested domain modules. Lazy route splitting. One API helper with a session-expired event.
10. Idempotent ingest keyed on business keys, so pushes can be retried safely.
