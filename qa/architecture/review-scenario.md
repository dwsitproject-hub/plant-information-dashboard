# Architecture Review Scenario: Plant Information Dashboard

Branch `sit` at `ed63d97`, executed 2026-11-17. Finding IDs (AR-xx) refer to `findings.md`.

**Method.** Static review of the code, configs and docs, plus read-only checks on the local QA stack:
- `pid-qa-db`: EXPLAIN ANALYZE, `pg_indexes`, `pg_constraint`, `pg_stat_user_tables`, `pg_roles`.
- API on 127.0.0.1:3010: unauthenticated probes only.
- Frontend: production build into a scratch directory.
- Backend: one image built and then removed. `npm test`, `oxlint`, `tsc` and `tsc --strict` were run.

No login was attempted and no data was changed.

**Result scale.** Pass means every criterion is met. Partial means some criteria are met or the gaps are fixable within the release. Fail means a core criterion is not met and the risk matters for production.

## Scorecard

| # | Viewpoint | Result | Main findings |
|---|---|---|---|
| 1 | Structure and modularity | Partial | AR-14, AR-15, AR-23, AR-25 |
| 2 | Data architecture | Partial | AR-10, AR-11, AR-12, AR-26 |
| 3 | API design | Partial | AR-01, AR-16, AR-20 |
| 4 | Security architecture | Partial | AR-04, AR-17, AR-18, AR-19, AR-25 |
| 5 | Reliability and resilience | Partial | AR-05, AR-06, AR-07, AR-24 |
| 6 | Performance and scalability | Fail | AR-02, AR-13, AR-20 |
| 7 | Observability and operations | Fail | AR-01, AR-09, AR-22 |
| 8 | Deployability and configuration | Partial | AR-03, AR-04, AR-08 |
| 9 | Maintainability and testability | Partial | AR-21, AR-14 |
| 10 | Production readiness | Partial (conditional go) | High: AR-01 to AR-04 |

---

## 1. Structure and modularity

| ID | Criterion (pass condition) | How checked | Result | Evidence |
|---|---|---|---|---|
| 1.1 | Routes only parse, authorize and shape. Data access and domain logic sit in separate layers. | Read all `Backend/src/routes/*.js`, `domain/*` | Fail | `routes/operations.js` (622 lines) holds SQL and assembly. `routes/portfolio.js:11` imports from another router. There is no service or repository layer (AR-15). |
| 1.2 | No business rule is implemented twice (frontend and backend). | Compared `Frontend/src/domain/*` with `Backend/src/domain/*` and `qualityRules.js` | Fail | Stock calculation is in `tankStock.ts` and `stock.js`. Presentation is in `present.ts` and `present.js`. QC verdicts are in `qc.ts`/`qualityView.ts` and `qualityRules.js`. `QuantityHistoryDialog.tsx:22` uses bundled Bekasi profiles (AR-14). |
| 1.3 | No file over about 600 lines without a good reason; complexity hot spots are known. | `wc -l` on all tracked sources | Partial | Largest files: `messages.ts` 2,671 (i18n data, acceptable), `StockOverviewPage.tsx` 720, `parse-logsheets.mjs` 707, `operations.js` 622, `UsersPage.tsx` 619, `admin.js` 598. |
| 1.4 | No dead code or unused schema in the release. | Grepped table names in `src` and `scripts`; QA row counts | Fail | 6 tables have no reference. `lab_results` is seed-only. The local mock mode and its 495 kB chunk ship with API builds (AR-23). |
| 1.5 | Patterns are consistent: one way to authorize, transact, validate and fetch. | Read the routers | Partial | Authorization is written 4 ways (AR-25). Transaction boilerplate repeats 5x in `admin.js`. The frontend has a single `api()` helper (good: only 3 files call `fetch`). |
| 1.6 | Ingest and ETL code is separated from the SPA. | Package layout | Partial | About 5,500 lines of ingest scripts sit in `Frontend/scripts`. The SPA `package.json` carries `nodemailer` and `xlsx` for them (AR-23). |

## 2. Data architecture

| ID | Criterion | How checked | Result | Evidence |
|---|---|---|---|---|
| 2.1 | Primary keys, FKs and natural-key uniqueness on all fact tables. | Read the migrations; `pg_constraint` | Pass | Business-key uniques exist, for example `soundings (tank_id, recorded_on, round_index)`, `storage_certificates (tank_id, snapshot_on, revision)`, `logsheet_submissions (definition_id, business_key)`. Composite FKs keep plant and site consistent (`003_refinery_quality.sql:5-21`). |
| 2.2 | Every column used in hot predicates is indexed; no duplicate indexes. | `pg_indexes`, EXPLAIN on QA | Fail | There is no `site_id` index on `storage_certificates`, `logistics_events`, `analytics_movements`, `vessel_tickets`, `truck_batches` or `gate_movements` (seq scans seen). 56 FKs have no index. `soundings` has a duplicate index on `(site_id, recorded_on)` (AR-10). |
| 2.3 | Heavy queries are bounded and use indexes (stock history, portfolio, soundings, labs, gauge samples). | EXPLAIN ANALYZE of the 7 heavy queries | Partial | Range history uses `soundings_site_recorded_idx` (0.1 ms). One tank's history uses the unique index (0.18 ms). Gauge samples use `(tank_id, sampled_at DESC)`. But `loadSiteTanks` and `certificateLabs` read the whole site history: a seq scan of 2,407 rows and 1,472 rows (AR-02). |
| 2.4 | Case-insensitive identity is enforced in the schema. | `pg_indexes` on `users`; `verifyPassword` | Fail | Login uses `LOWER()` with `LIMIT 1`, but the uniques are case-sensitive and there is no LOWER index (AR-11). |
| 2.5 | Migrations are transactional, ordered, idempotent and locked; CI proves it. | `scripts/migrate.js`, `ci.yml` | Pass | They use an advisory lock, a per-file transaction with the `schema_migrations` row, and CI applies them twice. Minor gaps: duplicate `005_` prefix and no checksum (AR-26). |
| 2.6 | Migrations are safe for live deploys (backward compatible, ordered before code). | Deploy script | Partial | Migrate runs after `up -d` and is opt-in (AR-08). There are no down migrations, and the rollback documentation says so. |
| 2.7 | Data growth is bounded by a documented retention policy. | `purge.js`, cron guide, row counts | Partial | Samples: archived at 30 d and deleted 7 d later, run daily. But the purge log gets 2 rows per sample forever, `submission_history` keeps every payload, and there is no retention for `datahub_sync_items` or `round_runs` (AR-12). Soundings are kept by design. |
| 2.8 | Timezones: business dates in the site timezone; instants as `timestamptz`; no UTC-date bugs. | Grep `toISOString().slice`, `localDate`, type parsers | Pass | `sites.timezone`, `localDate(now, tz)`, noon-UTC day arithmetic everywhere, `DATE` parsed as text in the API. A minor inconsistency in scripts is AR-26. |

## 3. API design

| ID | Criterion | How checked | Result | Evidence |
|---|---|---|---|---|
| 3.1 | Versioned, resource-oriented paths. | Route list (63 handlers) | Pass | Everything is under `/api/v1/...`, site-scoped as `/sites/:siteId/...`. SSO is under `/auth` (unversioned, acceptable). |
| 3.2 | One error envelope and correct status codes (4xx for client faults). | Code review; probe with malformed JSON | Fail | Malformed JSON gives 500. Bodies mix codes and sentences. 400s are chosen by regex on message text (AR-01, AR-16). |
| 3.3 | Input validated at the edge (params, query, body). | Code review | Partial | IDs, dates and roles are validated in admin, stock-history and utility, but not in QC date filters or `live/tanks?on=`. There is no schema library (AR-16). |
| 3.4 | Lists are paginated or capped; history endpoints require a range. | Code review | Fail | Only `/admin/datahub/runs` caps results. `tanks/:tankId/soundings`, `labs`, `live/logistics` and the QC lists are unbounded (AR-02, AR-16). |
| 3.5 | No N+1 query patterns; aggregation done in SQL. | Code review | Partial | `livePoint` runs a query per gauged tank. `analytics/movements` counts in JS. `requireAuth` runs 5 queries per request (AR-20). |
| 3.6 | Payload size proportional to the view. | Code review | Partial | `/snapshot` returns every data date of the site. `loadGaugedTanks` returns `raw_payload` JSONB per tank. The rest is proportional. |

## 4. Security architecture (design level)

| ID | Criterion | How checked | Result | Evidence |
|---|---|---|---|---|
| 4.1 | Server-side authn on every non-public route; authz by page right and site. | Router guards (`router.use`), `access.js` | Pass | Every router applies `requireAuth`. Site and module scoping is in middleware. Rights reload per request. Only `/master/org` lacks a page right (AR-25). |
| 4.2 | Privilege escalation through role administration is prevented. | `canGrantRole`, `checkRoleChange`, tests | Pass | Grants are limited to the granter's own rights. Only an Administrator can grant the Administrator role. The last active admin is protected. Covered by `security.test.js`. |
| 4.3 | Session: HttpOnly, Secure, SameSite cookie; bounded lifetime; revocable. | `access.js:115-129`, compose | Partial | HttpOnly and SameSite=Lax are set. `Secure` defaults off. There is no revocation, and the maxAge is not tied to the JWT lifetime (AR-04, AR-19). |
| 4.4 | Secrets only in environment or secret store; none in the image or repo; encrypted at rest when stored. | `.dockerignore`, `.gitignore`, `datahub/config.js` | Partial | Secrets are not in images, and `.env` is ignored. Stored credentials use AES-GCM, but the key falls back to `JWT_SECRET` (AR-17). The staging RDS hostname is committed in the example env (low). |
| 4.5 | SSO: PKCE, state, nonce, issuer, audience and alg checks; replay protection. | `sso/*`, `hub-auth.js` | Pass | All present. The nonce is optional, and the legacy bridge trusts an unverified email (AR-26, low). |
| 4.6 | Least privilege: containers non-root; DB role without DDL at runtime. | Built the image (`id`); `pg_roles`; compose | Partial | The API runs as `node`. The web container is stock nginx (root master). The DB uses one role for DDL and DML, and QA uses the superuser (AR-18). |
| 4.7 | Network exposure minimal; TLS end to end; security headers. | Compose ports, runbook SG table, nginx confs | Partial | The security group restricts :3011 to the APP host and RDS to the API host. Traffic is plain HTTP. The API binds 0.0.0.0. There is no CSP or HSTS, and XFO is missing on `index.html` (AR-04). |
| 4.8 | Brute-force protection that cannot be turned against users. | `loginThrottle.js` | Partial | Present (10 failures / 15 min), but per username only (targeted lockout) and in memory (AR-19). |

## 5. Reliability and resilience

| ID | Criterion | How checked | Result | Evidence |
|---|---|---|---|---|
| 5.1 | Every outbound call (DataHub, gauges, Hub OIDC) has a timeout and bounded retries. | Grep `AbortSignal`, timeouts | Partial | DataHub has 10 s and gauges 15 s with a 204 retry. Hub OIDC fetch and JWKS have no timeout (AR-06). |
| 5.2 | Scheduler: no overlap, idempotent, retries persisted, gaps recoverable. | `schedule.js`, `poll.js`, `rounds.js`, tests | Pass | Advisory lock, per-slot upsert, `round_runs` state, archive fallback at the round time, backfill script, unit tests. |
| 5.3 | Failure of one site or source does not fail the whole request or run. | `portfolio.js` per-site try/catch; `attemptRounds` | Pass | Failures are isolated per site (`failed[]` in the payload) and per source (`errors[]`). |
| 5.4 | DB pool sized, with acquire and statement timeouts; idle errors handled. | `db.js` | Partial | The idle-error handler is present. Pool size and timeouts are defaults (AR-06). |
| 5.5 | Process survives transient errors; no unhandled-rejection exits. | Review of async handlers | Partial | Most handlers use try/next. `datahub.js:131` awaits outside the try, and there is no process-level handler (AR-07). |
| 5.6 | Graceful shutdown (SIGTERM drains requests and closes the pool). | `index.js`, Dockerfile, compose | Fail | No signal handler. Node runs as PID 1 without init (AR-05). |
| 5.7 | Liveness and readiness health checks used by the deploy and the platform. | `/api/v1/health` probe; Dockerfiles | Partial | The health endpoint exists and is used by the deploy gate, but it does not check the DB, and there is no Docker HEALTHCHECK (AR-05). |

## 6. Performance and scalability

| ID | Criterion | How checked | Result | Evidence |
|---|---|---|---|---|
| 6.1 | Point-in-time endpoints read a bounded amount of data, independent of history length. | Code review and EXPLAIN | Fail | `loadSiteTanks` and `certificateLabs` read the full site history. The portfolio calls them twice per site, and the page polls every 60 s (AR-02). |
| 6.2 | Expensive cross-site endpoints use caching or concurrency limits. | `portfolio.js`, `catalog.js` | Partial | The calibration catalog has a 5-minute TTL cache. Portfolio results have no cache, and the fan-out is unbounded (AR-20). |
| 6.3 | Per-request overhead is small (auth, session). | `requireAuth` | Partial | 5 queries per request (AR-20). |
| 6.4 | Initial JS under about 300 kB gzip, no seed or mock data in API builds, compression on. | `vite build` output; nginx confs | Fail | Main chunk 781 kB (277 kB gzip) including 399 kB of calibration JSON. The QC chunk carries `qc.json`. gzip is off (AR-13). |
| 6.5 | Routes are code-split; charts are loaded lazily. | `App.tsx` | Pass | Every page uses `React.lazy`. Recharts is in a separate 339 kB chunk. |
| 6.6 | No rendering hot spots with unbounded intervals or re-renders. | Grep `setInterval`, lint | Partial | Intervals are cleaned up. 14 `set-state-in-effect` warnings cause extra renders. Large pages: StockOverview 720 lines and `Cards.tsx` 597 (AR-21). |

## 7. Observability and operations

| ID | Criterion | How checked | Result | Evidence |
|---|---|---|---|---|
| 7.1 | Unexpected errors are logged with context. | `index.js:44-49`; count of `console.*` calls | Fail | The error handler does not log. There are 7 log statements in all of `src` (AR-01). |
| 7.2 | Structured access logs with a request id. | `index.js` | Fail | None (AR-09). |
| 7.3 | Audit trail for security-relevant admin actions. | Migrations, `admin.js` | Fail | No audit table. Only `updated_by` on a few config tables (AR-09). |
| 7.4 | Metrics and alerting for scheduler failures and API health. | Cron guide, poller | Fail | The exit code is written to a log file. No alert, no metrics, no logrotate (AR-09). |
| 7.5 | Runbooks and docs match the code. | Compared TSD, DATABASE-DESIGN and README with the code | Partial | The staging runbook and cron guide are good and current. TSD and DATABASE-DESIGN are stale. There is no production runbook (AR-22). |
| 7.6 | Operational state visible in the app. | Tank gauging page API (`round_runs`, `last_poll_*`), DataHub run history | Pass | Round attempts, last poll result, error, and sync runs are stored and shown. |

## 8. Deployability and configuration

| ID | Criterion | How checked | Result | Evidence |
|---|---|---|---|---|
| 8.1 | 12-factor config: all settings from the environment; required ones fail fast; safe defaults. | Compose files, `.env*.example` | Partial | Required variables use `:?`. Unsafe defaults: `COOKIE_SECURE=false`, legacy bridge `true`, staging `APP_PUBLIC_ORIGIN`, hard-coded upstream IP in `nginx.alicloud-app.conf:6` (AR-04). |
| 8.2 | Supported runtime, pinned base images, non-root, healthcheck, small image. | Dockerfiles; image built and inspected | Partial | Non-root API image of 209 MB. Node 20 is EOL. Tags are floating. No HEALTHCHECK (AR-03, AR-05). |
| 8.3 | Migrations run automatically before new code, with a backup first. | `deploy-staging-api.sh` | Fail | Migrations run after `up` and are opt-in. No backup step (AR-08). |
| 8.4 | Immutable, traceable artifacts (built once, promoted by tag). | Deploy scripts, CI | Fail | Built on each host from `git pull`, with no registry (AR-08). |
| 8.5 | CI covers lint, unit tests, migrations, build, images and dependency audit. | `ci.yml` | Partial | Backend: tests, migrate x2, seed. Frontend: lint and build. No image build, no audit, no integration or frontend tests (AR-21). |
| 8.6 | Backup and restore documented and tested; rollback path. | Runbooks | Partial | Rollback by SHA exists. Restore exists only as a staging dump and restore script. No production RPO/RTO or drill (AR-08, AR-22). |
| 8.7 | Log rotation and resource limits on shared hosts. | Compose files | Fail | No `logging:` options and no memory or CPU limits (AR-09). |

## 9. Maintainability and testability

| ID | Criterion | How checked | Result | Evidence |
|---|---|---|---|---|
| 9.1 | Critical domain logic has unit tests that pass. | `npm test` | Pass | 86 of 86 pass in 1.8 s: portfolio, schedule, capacity, quality rules, security helpers, DataHub. |
| 9.2 | Route, authz and SQL paths have integration tests. | Test inventory | Fail | None (AR-21). |
| 9.3 | Frontend logic has tests. | `find -name "*.test.*"` | Fail | 0 test files for 3,104 lines of `src/domain` (AR-21). |
| 9.4 | Strict typing. | `tsconfig.app.json`; `tsc --strict` | Partial | `strict` is off, yet compiles with 0 errors under `--strict` (quick win). The backend is untyped JS (AR-21). |
| 9.5 | Lint clean. | `oxlint` | Partial | 0 errors, 62 warnings (AR-21). |
| 9.6 | Code comments and docs explain intent. | Review | Pass | Comments explain the reasons consistently (for example the Express 4 rejection note, DATE parsing, round tolerance). |

## 10. Production readiness

| ID | Criterion | Result | Evidence |
|---|---|---|---|
| 10.1 | No High findings open at go-live. | Fail | AR-01 (no error logging), AR-02 (unbounded reads), AR-03 (EOL runtime), AR-04 (HTTP, insecure cookie and SSO defaults). |
| 10.2 | Quick fixes (S, low risk) applied before go-live. | Open | AR-01, 03, 04, 05, 06, 07, 10, 11, 13 (gzip), 17, 20 (N+1), 21 (strict), 26, and the migrate reorder in AR-08. |
| 10.3 | Production runbook, backups and alerting in place. | Fail | AR-08, AR-09, AR-22. Expected from `prod-deploy-prep`. |
| 10.4 | Architecture fit for the expected data volume (12 months, all sites). | Partial | Fine at QA volume. AR-02 must be addressed or tracked with a firm date, because cost grows linearly with history. |

**Verdict.** Conditional go. The core design is sound: authz model, SSO, scheduler, migrations, timezone handling. Fix the four High items and the quick fixes before production. Plan AR-02 (read-path bounding) for the first hardening sprint, with a performance check against a 12-month synthetic dataset.
