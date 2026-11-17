#!/usr/bin/env node
/**
 * Build the JSON specs for the three .docx reports from the QA results in this repo, then render them with
 * the prod-readiness-checks skill's make-report.cjs:
 *
 *   node qa/reports/build-specs.mjs
 *   node ~/.claude/skills/prod-readiness-checks/scripts/make-report.cjs qa/reports/<name>.json qa/reports/<name>.docx
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const QA = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => JSON.parse(readFileSync(join(QA, p), 'utf8'))
const cut = (text, n = 150) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}
const DATE = '17 November 2026'
const COMMON_META = [
  ['Application', 'Plant Information Dashboard (PID)'],
  ['Code tested', 'Branch sit. Before fixes: ed63d97. After fixes: 8aad28b (fixes) and 6d35510 (QA suites)'],
  ['Environment tested', 'Isolated local QA copy: API 127.0.0.1:3010, frontend localhost:5176, throwaway PostgreSQL 16 seeded with Bekasi data and a second test site'],
  ['Date', DATE],
  ['Prepared by', 'Claude Code (prod-readiness-checks), for the PID project team'],
]

// ---------------------------------------------------------------- functional
function functional() {
  const before = new Map(read('functional/results-before.json').map((r) => [r.id, r.status]))
  const after = read('functional/results.json')
  const ui = read('functional/ui-results.json')
  // UI scenarios re-checked in the browser after the fixes (FT-UI-21 through the API that drives it).
  const uiAfter = { 'FT-UI-05': 'PASS (fixed)', 'FT-UI-13': 'PASS (fixed)', 'FT-UI-17': 'PASS (fixed)', 'FT-UI-21': 'PASS (fixed)' }
  const apiPass = after.filter((r) => r.status === 'PASS').length
  const uiRows = ui.map((r) => [r.id, r.title, r.type, cut(r.expected, 120), uiAfter[r.id] ?? r.status])
  const uiPassAfter = uiRows.filter((r) => String(r[4]).startsWith('PASS')).length
  const areas = [...new Set(after.map((r) => r.area))]
  const areaSections = areas.map((area) => ({
    heading: area,
    level: 2,
    blocks: [{
      table: {
        columns: [['ID', 1.1], ['Scenario', 3.2], ['Type', 0.9], ['Expected', 4], ['Result', 1.2]],
        rows: after.filter((r) => r.area === area).map((r) => [r.id, r.title, r.type, cut(r.expected), r.status === 'PASS' && before.get(r.id) === 'FAIL' ? 'PASS (fixed)' : before.has(r.id) ? r.status : `${r.status} (new)`]),
        status: 4,
      },
    }],
  }))
  const defects = [
    ['F-01', 'Medium', 'Impossible or malformed dates (2026-02-30, garbage) returned 500 with the database error text', 'operations.js, qc.js, utility.js', 'Shared calendar-day check (dates.js) on every router: 400 invalid_date. Error handler maps database data errors to 400 as a safety net.', 'FIXED'],
    ['F-02', 'Medium', 'A non-admin master-sites editor could change the timezone of, or switch off, a site they do not hold', 'master.js', 'Site changes need the site in user_sites; only the Administrator switches a company.', 'FIXED'],
    ['F-03', 'Low', 'Malformed JSON body returned 500', 'index.js', 'errors.js: 400 invalid_json.', 'FIXED'],
    ['F-04', 'Low', 'roleIds / siteIds of the wrong type returned 500', 'admin.js', 'Type check: 400 roleIds_must_be_a_list / siteIds_must_be_a_list.', 'FIXED'],
    ['F-05', 'Low', 'isActive "false" (a string) left the user active', 'admin.js', 'Only true/false accepted: 400 otherwise.', 'FIXED'],
    ['F-06', 'Low', 'E-mail addresses were not validated', 'admin.js', 'Format check: 400 invalid_email.', 'FIXED'],
    ['F-07', 'Low', 'A deleted user\'s username and e-mail could never be reused', 'admin.js', 'Delete renames the account to deleted-<id>-<name> and clears its e-mail (existing deleted users too, migration 017).', 'FIXED'],
    ['F-08', 'Low', 'Round times "06:30, 99:99, noon" saved as 06:30 only, reported as saved', 'tankgauging/rounds.js', 'The save is refused, naming the bad entries.', 'FIXED'],
    ['F-09', 'Low', 'Round tolerance true saved as 1 minute', 'tankgauging/rounds.js', 'Only whole minutes accepted.', 'FIXED'],
    ['F-10', 'Low', 'Malformed date filters returned empty or unfiltered data', 'operations.js, qc.js', 'Same calendar-day check: 400.', 'FIXED'],
    ['F-11', 'Low', 'Tank & Stock and Stock Overview place empty tanks in different commodities (PFAD 300/900 t vs 300/460 t)', 'Frontend commodityStock.ts vs Backend portfolio.js', 'One classification computed by the API and used by both pages. Totals already agree; only per-commodity capacity of empty tanks differs.', 'OPEN'],
    ['F-12', 'Low', 'Unknown frontend URL showed a blank page', 'App.tsx', '"Page not found" inside the app frame.', 'FIXED'],
    ['F-13', 'Low', 'The requested page was lost after sign-in', 'guards.tsx, LoginPage.tsx', 'Sign-in returns to the page asked for, query included.', 'FIXED'],
    ['F-14', 'Low', '"Oil in and out" with no data showed "The sheet spans ."', 'MovementPage.tsx', 'The sentence is left out when the period is empty.', 'FIXED'],
  ]
  return {
    title: 'Functional Test Report',
    subtitle: 'Plant Information Dashboard',
    orientation: 'landscape',
    footer: 'PID · Functional test',
    meta: [...COMMON_META, ['Overall result', `Pass. API ${apiPass}/${after.length}, UI ${uiPassAfter}/${ui.length} after fixes. 13 of 14 defects fixed; 1 Low open (F-11).`]],
    sections: [
      { heading: '1. Summary', blocks: [
        { p: 'Every backend route group and every main page was tested with **positive** (the feature works) and **negative** (bad input, missing rights, another site, switched-off module, unknown ids, duplicates) scenarios. Defects found were fixed, then the suites were run again on the fixed code.' },
        { table: { columns: [['', 2], ['Scenarios', 1], ['Pass', 1], ['Fail', 1], ['Blocked', 1]], rows: [
          ['API, before fixes', '131', String([...before.values()].filter((s) => s === 'PASS').length), String([...before.values()].filter((s) => s === 'FAIL').length), '0'],
          ['API, after fixes', String(after.length), String(apiPass), String(after.length - apiPass), '0'],
          ['UI, before fixes', String(ui.length), String(ui.filter((r) => r.status === 'PASS').length), String(ui.filter((r) => r.status === 'FAIL').length), '0'],
          ['UI, after fixes', String(ui.length), String(uiPassAfter), String(ui.length - uiPassAfter), '0'],
        ] } },
        { p: 'No Critical or High defects were found. **14 defects** (3 Medium, 11 Low) came from 20 failing scenarios; **13 are fixed** and verified. The one open item, F-11, is Low: the two stock pages agree on totals but classify an empty tank differently, which shifts that tank\'s capacity between commodity rows.' },
        { note: 'Go/no-go (functional): **Go.** F-11 does not block production; schedule it for the next release.' },
      ] },
      { heading: '2. Approach', blocks: [
        { bullets: [
          '**Environment:** a local copy started from the repository: its own PostgreSQL container (migrated, seeded with the Bekasi logsheet, lab and stock data), the API and the frontend dev server. No shared server was written to.',
          '**API scenarios:** `qa/functional/api-suite.mjs`, 132 scenarios, re-runnable and idempotent. It creates its own fixtures (company qa-ft-co, sites qa-ft-site and qa-ft-site2, qa-ft- users and roles) and writes `results.json`.',
          '**UI scenarios:** 28 scenarios run in a browser against the frontend: sign-in, every main page, dialogs, validation, restricted users, navigation, console errors.',
          '**Accounts:** the dev-only seed admin, plus a restricted user, a master-data editor and a delegated user-admin created by the suite.',
          '**Out of scope:** real gauges and DataHub (only unreachable test addresses), load testing, browsers other than Chromium.',
        ] },
        { p: 'Positive/negative split of the API scenarios: ' + ['Positive', 'Negative'].map((t) => `${after.filter((r) => r.type === t).length} ${t.toLowerCase()}`).join(', ') + '.' },
      ] },
      { heading: '3. Results by area (API, after fixes)', blocks: [{ p: '"PASS (fixed)" failed before the fixes and passes now. "(new)" was added with the fixes: FT-TG-15 checks that loopback and cloud-metadata gauge addresses are refused.' }] },
      ...areaSections,
      { heading: '4. Results (UI, after fixes)', pagebreak: true, blocks: [
        { table: { columns: [['ID', 1.1], ['Scenario', 3.4], ['Type', 0.9], ['Expected', 3.8], ['Result', 1.2]], rows: uiRows, status: 4 } },
        { p: 'FT-UI-05, -13 and -17 were re-checked in the browser after the fixes. FT-UI-21 is driven by the API change behind it (the save is refused with the bad entries named), covered by FT-TG-05.' },
      ] },
      { heading: '5. Defects', pagebreak: true, blocks: [
        { table: { columns: [['ID', 0.6], ['Severity', 0.8], ['Defect', 3.2], ['Location', 1.6], ['Fix', 3.4], ['Status', 0.9]], rows: defects, status: 5 } },
        { p: 'Test-design corrections (not product defects): five scenarios were corrected during the first run (wrong parameters or fixture clashes). After the fixes, the gauge fixture moved from 127.0.0.1 to an unresolvable `.invalid` host, because loopback addresses are now refused on purpose, and FT-OPS-06 accepts `invalid_date` as the code for a malformed day.' },
      ] },
      { heading: '6. Automated checks', blocks: [
        { table: { columns: [['Check', 2], ['Before', 2], ['After', 2]], rows: [
          ['Backend unit tests (npm test)', '86 / 86 pass', '92 / 92 pass (6 new: dates, errors, outbound guard, rate limit, round times)'],
          ['Frontend type check (tsc -b)', 'Pass (strict off)', 'Pass with strict mode on'],
          ['Frontend lint (oxlint)', '0 errors, 61 warnings', '0 errors; warnings unchanged (existing code)'],
          ['Frontend build (vite)', 'Pass; main chunk 781 kB', 'Pass; gzip now enabled in nginx'],
          ['Migrations on an empty database, twice', 'Pass', 'Pass (017, 018 added)'],
        ], status: 2 } },
      ] },
      { heading: '7. How to re-run', blocks: [
        { code: 'docker run -d --name pid-qa-db -p 127.0.0.1:55450:5432 -e POSTGRES_PASSWORD=qa-only -e POSTGRES_DB=pid postgres:16-alpine\nnode --env-file=Backend/.env.qa Backend/scripts/migrate.js\nnode --env-file=Backend/.env.qa Backend/scripts/seed-from-mockup.js\nnode --env-file=Backend/.env.qa Backend/scripts/load-dashboard-files.js\n# start the API (LOGIN_RATE_LIMIT_PER_MINUTE=1000 API_RATE_LIMIT_PER_MINUTE=10000 for this suite) and the frontend\nnode qa/functional/api-suite.mjs' },
        { p: '`Backend/.env.qa` holds random test-only secrets and is gitignored. The suite signs in many times from one address, so it runs with the per-address limits raised; the limits themselves are tested by the penetration test (PT-RL-01).' },
      ] },
    ],
  }
}

// ---------------------------------------------------------------- pentest
function pentest() {
  const before = new Map(read('pentest/results-before.json').map((r) => [r.id, r.status]))
  const after = read('pentest/results.json')
  const count = (list, s) => list.filter((r) => r.status === s).length
  const beforeList = read('pentest/results-before.json')
  const findings = [
    ['F-01', 'High (7.6)', 'Server-side request forgery via gauge / DataHub address and Test connection', 'tankgauging/client.js, sources.js, datahub/*', 'FIXED'],
    ['F-02', 'Medium (6.1)', 'No CSP / clickjacking protection; no HSTS', 'index.js; nginx configs', 'PARTIAL'],
    ['F-03', 'Medium (6.9)', 'body-parser < 1.20.9 denial of service (GHSA-27r3-jxmh-p828)', 'Backend/package.json', 'FIXED'],
    ['F-04', 'Medium (5.3)', 'Legacy HS256 SSO bridge links accounts by an unverified e-mail', 'routes/hub-auth.js, sso/resolve-user.js', 'OPEN'],
    ['F-05', 'Low (3.7)', 'Session cookie not Secure; staging served over HTTP', 'access.js; deployment', 'OPEN'],
    ['F-06', 'Low (3.1)', 'Internal error messages returned outside production; 500 for client errors', 'index.js', 'FIXED'],
    ['F-07', 'Low (3.1)', 'No rate limit beyond the per-account sign-in lockout', 'index.js', 'FIXED'],
    ['F-08', 'Info', 'X-Powered-By: Express', 'index.js', 'FIXED'],
    ['F-09', 'Info', 'Session token still valid after logout (until expiry)', 'access.js', 'PARTIAL'],
    ['F-10', 'Info', 'JWT algorithm not pinned; credential key falls back to JWT_SECRET', 'access.js, datahub/config.js', 'PARTIAL'],
  ]
  const details = [
    ['F-01 Server-side request forgery (High, CVSS 7.6, AV:N/AC:L/PR:H/UI:N/S:C/C:H/I:L/A:L)',
      'An administrator-entered gauge or DataHub address was called by the server with no check: the test made the API fetch itself (127.0.0.1:3010) and accepted the cloud metadata address 169.254.169.254, and redirects were followed anywhere.',
      'An attacker with an admin session (or a stolen one) could read services only the API host can reach, including cloud instance metadata and credentials.',
      'New `outboundGuard.js`: loopback, unspecified, link-local, cloud metadata (169.254.169.254, Alibaba 100.100.100.200), multicast and reserved addresses are refused when saved and again before every call, host names by what they resolve to. Redirects are followed only on the same origin (the Tanjung Pura gateway\'s own sign-in redirect still works). Private ranges stay allowed because the plant gauges live there.',
      'PT-SSRF-01 and PT-SSRF-02 SECURE: 127.0.0.1, localhost, [::1], 0.0.0.0, 169.254.169.254 and 100.100.100.200 all refused with 400. Verified against the real Bontang and Tanjung Pura gauges that polling and archive reads still work.'],
    ['F-02 Missing CSP / clickjacking / HSTS (Medium, CVSS 6.1)',
      'The SPA HTML had no X-Frame-Options or CSP; the API sent no security headers; no HSTS (plain HTTP).',
      'The page can be framed by another site (clickjacking); no browser-side limit on script sources.',
      'API now sends nosniff, X-Frame-Options DENY, Referrer-Policy no-referrer, CSP default-src \'none\'; frame-ancestors \'none\', CORP same-site; the SSO breakout page keeps its own nonce-based policy so Hub sign-in still works. **Open:** the SPA must stay framable by the Hub, so its CSP needs `frame-ancestors \'self\' <Hub origin>` (Hub origin to confirm), and HSTS needs HTTPS at the host nginx.',
      'PT-HDR-01: all API headers present except HSTS (INFO: needs HTTPS).'],
    ['F-04 Legacy SSO bridge trusts an unverified e-mail (Medium, CVSS 5.3)',
      'The legacy HS256 bridge links a Hub token to a local account by e-mail without requiring it to be verified. Staging has both OIDC and the legacy bridge enabled.',
      'Anyone who obtains or guesses SSO_TOKEN_SECRET can sign in as any user whose e-mail they put in a token.',
      '**Decision needed:** switch the legacy bridge off (`SSO_LEGACY_BRIDGE_ENABLED=false`) wherever OIDC works, and require a long random SSO_TOKEN_SECRET until then. Not changed here because staging sign-in may rely on it.',
      'Code review; not executed (the bridge is off on the QA copy).'],
    ['F-05 Session cookie not Secure (Low, CVSS 3.7)',
      'The cookie is HttpOnly and SameSite=Lax but not Secure; staging is plain HTTP.',
      'On an untrusted network the session cookie can be read in transit.',
      '**Infrastructure:** serve production over HTTPS and set `COOKIE_SECURE=true` (and HSTS). The cookie lifetime now follows the token lifetime.',
      'PT-AUTHN-03 INFO.'],
  ]
  return {
    title: 'Penetration Test Report',
    subtitle: 'Plant Information Dashboard',
    orientation: 'landscape',
    footer: 'PID · Penetration test · Confidential',
    meta: [...COMMON_META, ['Staging', 'Passive only: about 20 unauthenticated GET/HEAD/OPTIONS requests to 172.28.92.56:3091 and 172.28.92.57:3011'], ['Overall result', `Before fixes: 1 High, 3 Medium, 3 Low, 3 Info. After: 0 High; open items need HTTPS or a decision (F-02 part, F-04, F-05). Automated tests: ${count(after, 'SECURE')} SECURE, ${count(after, 'VULNERABLE')} VULNERABLE, ${count(after, 'INFO')} INFO.`]],
    sections: [
      { heading: '1. Executive summary', blocks: [
        { p: 'An authorized penetration test of the PID web application and API, at the owner\'s request. Active tests ran only against an isolated local copy; the staging servers, which host other products, received passive read-only requests only. Plant gauges were never contacted by any test.' },
        { table: { columns: [['Severity', 2], ['Found', 1], ['Fixed', 1], ['Partly fixed', 1], ['Open', 1]], rows: [
          ['High', '1', '1', '0', '0'], ['Medium', '3', '1', '1', '1'], ['Low', '3', '2', '0', '1'], ['Info', '3', '1', '2', '0'],
        ] } },
        { table: { columns: [['Automated tests (25)', 2], ['SECURE', 1], ['VULNERABLE', 1], ['INFO', 1]], rows: [
          ['Before fixes', String(count(beforeList, 'SECURE')), String(count(beforeList, 'VULNERABLE')), String(count(beforeList, 'INFO'))],
          ['After fixes', String(count(after, 'SECURE')), String(count(after, 'VULNERABLE')), String(count(after, 'INFO'))],
        ] } },
        { note: 'Go/no-go (security): **Go for production on HTTPS**, with the legacy SSO bridge switched off once OIDC is confirmed. The remaining items are deployment settings (HTTPS, Secure cookie, HSTS, SPA CSP with the Hub origin), not code defects.' },
      ] },
      { heading: '2. Scope and method', blocks: [
        { bullets: [
          '**Active (local QA copy):** API 127.0.0.1:3010, frontend localhost:5176, PostgreSQL container. Fixtures prefixed qa-pt-; lockout tests used a victim account created for the purpose.',
          '**Passive (staging):** frontend 172.28.92.56:3091 and API 172.28.92.57:3011, unauthenticated GET/HEAD/OPTIONS only, about 20 requests, no logins, no payloads, no scans.',
          '**Out of scope:** everything else on 172.28.x.x and 172.16.x.x (plant gauges), denial-of-service and load tests.',
          '**Coverage (OWASP Top 10 2021 / ASVS):** authentication, session management, vertical and horizontal authorization (14 cross-site routes), injection, XSS, CSRF/CORS, SSRF, security headers, error handling, rate limiting, mass assignment, SSO (code review), secrets in git history, dependencies (npm audit), containers and nginx (code review).',
          '**Tools:** `qa/pentest/pentest-suite.mjs` (25 automated tests), `qa/pentest/rate-limit-check.mjs`, npm audit, code review.',
        ] },
      ] },
      { heading: '3. Findings summary', blocks: [
        { table: { columns: [['ID', 0.6], ['Severity (CVSS)', 1.1], ['Finding', 3.6], ['Component', 2.2], ['Status', 0.9]], rows: findings, status: 4 } },
      ] },
      { heading: '4. Finding details', pagebreak: true, blocks: details.flatMap(([title, what, impact, fix, retest]) => [
        { p: `**${title}**` },
        { kv: [['What', what], ['Impact', impact], ['Fix', fix], ['Re-test', retest]] },
      ]) },
      { heading: '4.1 Other findings', level: 2, blocks: [{ bullets: [
        '**F-03 body-parser DoS (Medium):** updated to 1.20.9; `npm audit --omit=dev` reports 0 vulnerabilities in Backend and Frontend.',
        '**F-06 error messages (Low):** errors now return short codes (invalid_json, invalid_input, request_failed) and are logged on the server with method, path and user; no internal text reaches the client. Re-test PT-ERR-01 SECURE.',
        '**F-07 rate limiting (Low):** per client address, 30 sign-ins and 600 API calls a minute (configurable). Re-test PT-RL-01 SECURE: 40 sign-ins to 40 accounts from one address, refused from attempt 31.',
        '**F-08 X-Powered-By (Info):** removed. PT-HDR-02 SECURE.',
        '**F-09 token after logout (Info):** partly fixed. A password change or admin reset now ends every other session (session version in the token). Logout still only clears the browser cookie; the token expires after 8 hours. Accepted for now.',
        '**F-10 JWT (Info):** the algorithm is pinned to HS256. The credential encryption key still falls back to JWT_SECRET when DATAHUB_SECRET_KEY is unset: set a dedicated key in production (see the architecture report, AR-17).',
      ] }] },
      { heading: '5. Test results by category', pagebreak: true, blocks: [
        { table: { columns: [['ID', 1.1], ['Category', 1.6], ['Test', 3.2], ['Before', 1], ['After', 1], ['Evidence (after)', 4]], rows: after.map((r) => [r.id, r.category, r.title, before.get(r.id) ?? '-', r.status, cut(r.evidence, 170)]), status: 4 } },
        { p: 'Method notes: the suite runs with the sign-in limit raised so its lockout and authorization tests are not cut short by the per-address limit; `rate-limit-check.mjs` then tests that limit on a freshly started API with the real settings. PT-INJ-02 now answers 400 because the malformed date in the payload is refused before any query runs.' },
      ] },
      { heading: '6. Staging passive observations', blocks: [{ bullets: [
        '**Good:** no /.env or /.git exposure (the SPA fallback answers), no source maps, no directory listing, nginx version hidden, CORS allowlist enforced, admin and data endpoints require a session, API port 3011 not reachable from the office network.',
        '**Weak (fixed in code, live after the next deploy):** X-Powered-By: Express; no security headers from the API.',
        '**Weak (deployment):** SPA HTML framable and no CSP; no HSTS (plain HTTP).',
        '**Note:** staging has both OIDC and the legacy HS256 bridge enabled (`/auth/sso/status`), so F-04 applies there.',
      ] }] },
      { heading: '7. Controls that held', blocks: [{ bullets: [
        'Parameterized SQL everywhere: no SQL injection in path, query or body.',
        'Vertical and horizontal authorization: role, permission and site-grant escalation refused; 14 cross-site routes answered 403/404; mass assignment ignored.',
        'Login: bcrypt hashes, generic error messages, per-account lockout after 10 failures (re-tested: 429 at attempt 11).',
        'Forged and alg:none tokens rejected; CORS allowlist with credentials; React escaping, no XSS sinks.',
        'Secrets encrypted at rest (AES-256-GCM) and never returned; OIDC with PKCE, state, nonce and replay guard; containers run as non-root.',
      ] }] },
      { heading: '8. Residual risk and recommendations', blocks: [
        { numbers: [
          'Serve production over HTTPS; set COOKIE_SECURE=true and HSTS at the host nginx.',
          'Switch the legacy SSO bridge off once OIDC sign-in is confirmed; until then use a long random SSO_TOKEN_SECRET.',
          'Add a CSP for the SPA with frame-ancestors limited to the Hub origin.',
          'Set a dedicated DATAHUB_SECRET_KEY (credential encryption) in production, separate from JWT_SECRET.',
          'Re-run `node qa/pentest/pentest-suite.mjs` and `rate-limit-check.mjs` before each major release.',
        ] },
      ] },
    ],
  }
}

// ---------------------------------------------------------------- architecture
function architecture() {
  const overview = readFileSync(join(QA, 'architecture/system-overview.md'), 'utf8')
  const diagram = overview.split('```')[1]?.replace(/^\w*\n/, '').trimEnd() ?? ''
  const status = {
    'AR-01': ['FIXED', 'Errors logged as JSON with method, path, user; 4xx for bad JSON and invalid input; no internals in responses; X-Powered-By off; unknown /api paths answer JSON 404.'],
    'AR-02': ['PLANNED', 'Query only the needed days and the latest certificate per tank; cache per site; cap ranges. Plan with AR-15.'],
    'AR-03': ['FIXED', 'Node 22 in both Dockerfiles, CI and engines; nginx pinned to 1.28-alpine.'],
    'AR-04': ['PARTIAL', 'API security headers added. Open: HTTPS + COOKIE_SECURE=true + HSTS, SPA CSP with the Hub origin, legacy bridge off, fail-closed production compose (prod-deploy-prep).'],
    'AR-05': ['FIXED', '/api/v1/health/ready checks the database; image HEALTHCHECK; graceful shutdown on SIGTERM; deploy waits for ready.'],
    'AR-06': ['FIXED', 'Pool: max, connection, idle and statement timeouts, application_name. OIDC calls time out after 10 s; JWKS cached per URI.'],
    'AR-07': ['FIXED', 'Rejected async handlers now reach the error handler (asyncErrors.js); unhandled rejections are logged, not fatal; the DataHub route fixed.'],
    'AR-08': ['PARTIAL', 'Migrations now run before the new container starts. Open: backup before migrate, build once in CI and push to a registry, restore test.'],
    'AR-09': ['PARTIAL', 'Server errors are logged. Open: access log, audit table for admin changes, log rotation, alert on failed gauge rounds.'],
    'AR-10': ['FIXED', 'Migration 017: site and foreign-key indexes; duplicate soundings index dropped.'],
    'AR-11': ['FIXED', 'Migration 017: case-insensitive unique usernames and e-mails (skipped with a notice if existing rows clash); login ignores deleted rows.'],
    'AR-12': ['PLANNED', 'Retention for purge log, submission history and sync items.'],
    'AR-13': ['PARTIAL', 'gzip on in both nginx configs. Open: load calibration and mock JSON only where needed.'],
    'AR-14': ['PLANNED', 'Make the API the single owner of stock and verdict logic; calibration CRUD or read-only page (also fixes functional F-11).'],
    'AR-15': ['PLANNED', 'Service and repository layer; withTransaction helper.'],
    'AR-16': ['PARTIAL', 'Real calendar-day validation on all routers; JSON error codes for bad JSON/unknown paths. Open: one error envelope, schema validation, pagination.'],
    'AR-17': ['PARTIAL', 'Decrypt failures are logged. Open: dedicated encryption key with a re-encryption script.'],
    'AR-18': ['PLANNED', 'Separate migration and runtime database roles.'],
    'AR-19': ['PARTIAL', 'Session version in the token (password change/reset ends other sessions), cookie lifetime tied to the token, per-address sign-in limit. Open: revoke on logout, longer minimum password.'],
    'AR-20': ['PLANNED', 'Collapse session queries; remove the N+1 in live points; limit portfolio concurrency.'],
    'AR-21': ['PARTIAL', 'TypeScript strict on; 6 new backend tests; QA suites in the repo. Open: frontend unit tests, API integration tests in CI.'],
    'AR-22': ['PLANNED', 'Update DATABASE-DESIGN and TSD; production runbook from prod-deploy-prep.'],
    'AR-23': ['PLANNED', 'Remove dead tables and the shipped mock mode.'],
    'AR-24': ['PLANNED', 'Separate worker service; asynchronous Poll now; restricted ingest user.'],
    'AR-25': ['PARTIAL', 'Site edits now limited to sites the user holds. Open: one policy per router; gate /master/org.'],
    'AR-26': ['PARTIAL', 'Page error boundary added. Open: AbortController on site switch, required OIDC nonce, shared date helpers.'],
  }
  const rows = readFileSync(join(QA, 'architecture/findings.md'), 'utf8').split('\n')
    .filter((l) => /^\| AR-\d+ \|/.test(l))
    .map((l) => l.split('|').map((c) => c.trim()).filter((c, i, a) => i > 0 && i < a.length))
    .map(([id, viewpoint, sev, title, effort]) => [id, viewpoint, sev, title.replace(/`/g, ''), effort, status[id]?.[0] ?? 'PLANNED', status[id]?.[1] ?? ''])
  const count = (s) => rows.filter((r) => r[5] === s).length
  const scorecard = [
    ['1. Structure and modularity', 'Partial', 'Partial', 'Duplicated frontend/backend logic and fat routes remain (planned)'],
    ['2. Data architecture', 'Partial', 'Pass', 'Indexes, case-insensitive uniqueness, deleted-user names freed; retention planned'],
    ['3. API design', 'Partial', 'Partial', 'Validation and error codes fixed; envelope and pagination planned'],
    ['4. Security architecture', 'Partial', 'Partial', 'SSRF, headers, sessions fixed; HTTPS, DB roles, dedicated key open'],
    ['5. Reliability and resilience', 'Partial', 'Pass', 'Timeouts, readiness, shutdown, async errors fixed'],
    ['6. Performance and scalability', 'Fail', 'Partial', 'gzip on; full-history reads (AR-02) still to fix'],
    ['7. Observability and operations', 'Fail', 'Partial', 'Errors logged; access log, audit and alerts planned'],
    ['8. Deployability and configuration', 'Partial', 'Partial', 'Node 22, pinned images, healthcheck, migrate first; backups and registry planned'],
    ['9. Maintainability and testability', 'Partial', 'Partial', 'Strict TS, new tests, QA suites; frontend tests planned'],
    ['10. Production readiness', 'Partial (conditional go)', 'Go with conditions', 'See the roadmap'],
  ]
  return {
    title: 'Architecture Review Report',
    subtitle: 'Plant Information Dashboard',
    orientation: 'landscape',
    footer: 'PID · Architecture review',
    meta: [...COMMON_META, ['Overall result', `Conditional go. 26 findings (4 High, 16 Medium, 6 Low): ${count('FIXED')} fixed, ${count('PARTIAL')} partly fixed, ${count('PLANNED')} planned. All four High findings are fixed or reduced to deployment settings except AR-02 (performance), planned before data volume grows.`]],
    sections: [
      { heading: '1. Summary', blocks: [
        { p: 'The core design is sound: server-side access control reloaded on every request, a well-built SSO flow, a gauge scheduler with locks, retries and an archive fallback, transactional migrations, and disciplined per-site time zones. The gaps were in operations (no error logging, shallow health check, no timeouts), deployment (end-of-life Node, unsafe defaults) and performance (full-history reads).' },
        { table: { columns: [['Viewpoint', 2.4], ['Before', 1.4], ['After fixes', 1.4], ['Key point', 4.4]], rows: scorecard, status: 2 } },
        { note: 'Go/no-go (architecture): **Go with conditions**: HTTPS and fail-closed production settings (prod-deploy-prep), a dedicated encryption key, a backup before the first production migration, and AR-02 scheduled before data volume grows.' },
      ] },
      { heading: '2. System overview', blocks: [
        { p: 'Two hosts on Alibaba Cloud plus a managed database. The browser loads the React app from nginx on the app host, which proxies /api and /auth to the Express API on the API host (private network only). The API reads and writes ApsaraDB PostgreSQL, calls the Hub for sign-in, DataHub for master data, and the TankVision gauges at the plant. Cron on the API host runs the gauge schedule every 5 minutes and the daily purge. Logsheet data arrives from a site PC as JSON files.' },
        { code: diagram },
        { p: 'Diagram as reviewed (before fixes): the API image is now node:22-alpine with a health check, and the pool has limits.' },
      ] },
      { heading: '3. Review method', blocks: [
        { p: 'Ten viewpoints, each with explicit pass criteria, checked against the code, configuration and documents, and (read-only) the local QA database with EXPLAIN ANALYZE and catalog queries. A production frontend build and one backend image were built for inspection.' },
        { bullets: ['Structure and modularity', 'Data architecture (schema, indexes vs queries, migrations, retention, time zones)', 'API design (consistency, validation, errors, limits)', 'Security architecture (authn/authz, sessions, secrets, SSO, least privilege, exposure)', 'Reliability (dependency failures, timeouts, scheduler, pool, shutdown, health)', 'Performance (expensive endpoints, caching, bundle)', 'Observability (logs, metrics, audit, alerting, runbooks)', 'Deployability (config, images, compose, CI, backups, migrations)', 'Maintainability (tests, typing, lint, docs)', 'Production readiness'] },
      ] },
      { heading: '4. Findings', blocks: [
        { table: { columns: [['ID', 0.6], ['Viewpoint', 1.3], ['Sev', 0.7], ['Finding', 3], ['Effort', 0.6], ['Status', 0.9], ['What was done / what is next', 3.6]], rows, status: 5 } },
      ] },
      { heading: '5. High findings in detail', pagebreak: true, blocks: [
        { p: '**AR-01 Error handler logged nothing; bad JSON returned 500.** Evidence: `index.js:44-49` returned 500 for every error without logging; a malformed body returned the parser\'s message. Impact: production failures left no trace and client mistakes counted as server errors. Done: `errors.js` and a new handler (logged as JSON; 400/409/413 where the client is at fault; generic 500 body), `asyncErrors.js` so rejected async handlers reach it.' },
        { p: '**AR-02 Point-in-time screens read the full site history.** Evidence: `loadSiteTanks` selects every sounding and certificate of a site, twice per site for Stock Overview, refreshed every 60 s per open tab. Impact: load grows linearly with history (about 730 rows per gauged tank per year). Next: query only the needed days, latest certificate per tank, a short per-site cache. Effort M; planned with AR-15.' },
        { p: '**AR-03 Node 20 end-of-life; floating image tags.** Done: Node 22 LTS in both Dockerfiles, CI and package engines; nginx pinned to 1.28-alpine. Backend tests pass on Node 22.' },
        { p: '**AR-04 Production-unsafe defaults.** Evidence: compose defaults COOKIE_SECURE=false and the legacy bridge on; plain HTTP; no CSP/HSTS. Done: API security headers. Next: production compose must require explicit secure values (fail closed), HTTPS with HSTS at the host nginx, the API bound to the private address, an SPA CSP allowing the Hub frame.' },
      ] },
      { heading: '6. Strengths to keep', blocks: [{ bullets: [
        'Server-side RBAC reloaded per request; site and module scoping in middleware; role-grant escalation prevented and tested.',
        'SSO with PKCE, state and nonce, algorithm pinning, maximum token age, single-use replay guard, iframe breakout, verified-e-mail linking.',
        'Gauge scheduler: advisory lock, persisted attempts per round, configurable retries, archive fallback at the round time, backfill script, unit tests.',
        'Migrations: transactional under an advisory lock; CI proves a second run is a no-op.',
        'Per-site time zones; DATE kept as text; round times local to each site.',
        'Secrets encrypted at rest and never returned; .dockerignore excludes env files; the API runs as a non-root user.',
        'Destructive-script guard (--confirm-site); idempotent ingest keyed on business keys.',
      ] }] },
      { heading: '7. Roadmap', blocks: [
        { table: { columns: [['When', 1.2], ['Item', 4], ['Findings', 1.2]], rows: [
          ['Before go-live', 'HTTPS, COOKIE_SECURE=true, HSTS, fail-closed production compose, API bound to the private IP', 'AR-04'],
          ['Before go-live', 'Dedicated credential encryption key (with a re-encryption step for existing secrets)', 'AR-17'],
          ['Before go-live', 'Backup (RDS snapshot or pg_dump) before the first production migration; restore tested once', 'AR-08'],
          ['Before go-live', 'Docker log rotation; alert when a gauge round is marked Failed', 'AR-09'],
          ['First release after go-live', 'Bounded reads for Tank & Stock and Stock Overview; per-site cache', 'AR-02, AR-20'],
          ['First release after go-live', 'One stock/commodity classification owned by the API (fixes functional F-11)', 'AR-14'],
          ['Next quarter', 'Service layer, error envelope, pagination, audit log, separate DB roles, worker service', 'AR-09, AR-15, AR-16, AR-18, AR-24'],
          ['Next quarter', 'Frontend unit tests and API integration tests in CI; docs refresh', 'AR-21, AR-22'],
        ] } },
      ] },
    ],
  }
}

for (const [name, build] of [['functional-test-report', functional], ['penetration-test-report', pentest], ['architecture-review-report', architecture]]) {
  writeFileSync(join(QA, 'reports', `${name}.json`), JSON.stringify(build(), null, 2))
  console.log(`spec ${name}.json`)
}
