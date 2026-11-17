# Functional test plan — Plant Information Dashboard

Scope: backend API (Express + Postgres, `Backend/src/routes/*.js`) and frontend UI (React, `Frontend/src`), positive and negative cases.
Stack under test: local QA stack — API http://127.0.0.1:3010, frontend dev server http://localhost:5176, throwaway Postgres `pid-qa-db`.
Code under test: branch `sit`, commit ed63d97 (the API process was started from that commit).

Totals: **131 API scenarios** (automated in `api-suite.mjs`) + **28 UI scenarios** (run in the browser, results in `ui-results.json`).

## Test data and fixtures

| Fixture | Purpose |
|---|---|
| Company `qa-ft-co` (activated) with sites `qa-ft-site` (modules: qc only) and `qa-ft-site2` (held by no fixture user) | A site the Administrator can grant and toggle modules on; a "not held" site for cross-site edits. Created by SQL (the QA seed's company is not activated, so its sites cannot be granted through the API). |
| Roles `qa-ft-ops` (live-ops, ops-analytics, management-stock, utility, daily-production view), `qa-ft-qc` (qc view), `qa-ft-none` (no rights), `qa-ft-master` (master-commodities/tanks/sites edit, master-companies view), `qa-ft-useradmin` (admin-users + admin-roles edit/delete, live-ops view), `qa-ft-liveonly`, `qa-ft-mgmt` (management-stock only) | Permission matrix |
| Users `qa-ft-ops`, `qa-ft-qc`, `qa-ft-none`, `qa-ft-master`, `qa-ft-useradmin`, `qa-ft-mgmt` (sites bekasi [+ qa-ft-site]), `qa-ft-nosite` (no site), `qa-ft-inactive` (inactive), `qa-ft-admin2` (Administrator role, inactive so it never counts as a second active admin) | Signed-in personas; password `QaFt-pass-1` (test value, recorded in the suite) |
| Per-run users `qa-ft-*-<run>` | Users that a case deletes, locks out (throttle) or whose password it changes; soft-deleted at the end of the run |

Constraints honoured: no failed logins on `admin`; at most 1 failed login per run on the fixture `qa-ft-ops`; throttle test uses its own throwaway account; seeded roles/sites/rules are only read (edits that are refused by design are sent with the current values); gauge cases use only `http://127.0.0.1:9`.

## API scenarios

### Auth & session (API)

| ID | Title | Type | Preconditions | Steps | Expected result |
|---|---|---|---|---|---|
| FT-AUTH-01 | Health endpoint answers | Positive | API running | GET /api/v1/health | 200 {ok:true} |
| FT-AUTH-02 | Login with valid credentials sets an httpOnly session cookie and returns the session | Positive | Fixture user qa-ft-ops | POST /api/v1/auth/login {username, password} | 200, Set-Cookie pid_session HttpOnly SameSite=Lax, body has id/username/sites/permissions, no password hash |
| FT-AUTH-03 | Login is case-insensitive on the username | Positive | qa-ft-ops exists | POST login with username QA-FT-OPS | 200 |
| FT-AUTH-04 | Login with the e-mail address instead of the username | Positive | qa-ft-ops has e-mail qa-ft-ops@example.test | POST login with username=qa-ft-ops@example.test | 200, username qa-ft-ops |
| FT-AUTH-05 | Login with a wrong password | Negative | qa-ft-ops exists | POST login with wrong password (1 failure on a fixture account) | 401 invalid_credentials, no cookie |
| FT-AUTH-06 | Login for an unknown user | Negative | - | POST login username=qa-ft-nobody-mwk8kwy6 | 401 invalid_credentials (same answer as a wrong password) |
| FT-AUTH-07 | Login with missing username or password | Negative | - | POST login {} ; POST login {username:"qa-ft-ops"} | 400 invalid_credentials for both |
| FT-AUTH-08 | Login with a malformed JSON body | Negative | - | POST /api/v1/auth/login with body '{"username":' (invalid JSON) | 400 (client error), not a 500 |
| FT-AUTH-09 | Login for a deactivated user | Negative | qa-ft-inactive (isActive=false) | POST login qa-ft-inactive with its correct password | 401 |
| FT-AUTH-10 | GET /auth/me returns the signed-in session | Positive | Signed in as qa-ft-ops | GET /api/v1/auth/me | 200 with sites bekasi + qa-ft-site and their modules |
| FT-AUTH-11 | GET /auth/me without a session | Negative | - | GET /api/v1/auth/me with no cookie | 401 unauthenticated |
| FT-AUTH-12 | GET /auth/me with a tampered token | Negative | - | GET /api/v1/auth/me with cookie pid_session=<valid token with altered signature> | 401 |
| FT-AUTH-13 | Logout clears the session cookie | Positive | Fresh login as qa-ft-ops | POST /api/v1/auth/logout, then GET /auth/me with the client cookie jar | 204, Set-Cookie clears pid_session, /me then 401 |
| FT-AUTH-14 | A session ends when the user is deactivated | Negative | Throwaway user qa-ft-deact-mwk8kwy6 signed in | Admin PUT /admin/users/:id isActive=false; user GET /auth/me | /me 401 right after deactivation |
| FT-AUTH-15 | Login throttle locks an account after 10 failures, even for the right password | Negative | Throwaway user qa-ft-lock-mwk8kwy6 | 10x POST login with a wrong password, then POST login with the right one; then log in another account | Failures 1-10 -> 401; 11th (correct password) -> 429 too_many_attempts; other accounts unaffected |
| FT-AUTH-16 | Change password: missing, short, same and wrong current password | Negative | Throwaway user qa-ft-pw-mwk8kwy6 signed in | PUT /auth/password with {} ; {currentPassword} ; newPassword "abc" ; new == current ; wrong current | 400 current_password_required, 400 new_password_required, 400 password_short, 400 same_password, 401 bad_current_password |
| FT-AUTH-17 | Change password, then sign in with the new password only | Positive | FT-AUTH-16 user | PUT /auth/password {currentPassword, newPassword}; login old; login new | 204; old password 401; new password 200 |
| FT-AUTH-18 | SSO status endpoint | Positive | - | GET /auth/sso/status | 200 {oidcEnabled:boolean, legacyBridgeEnabled:boolean} |
| FT-AUTH-19 | Hub bridge without a token redirects to the SSO error page | Negative | - | POST /auth/hub (form, no token) | 302 to /sso-error?… |
| FT-AUTH-20 | Unknown API path | Negative | - | GET /api/v1/does-not-exist (signed in) | 404 |
| FT-AUTH-21 | Every protected route group refuses an anonymous caller | Negative | - | GET without cookie: /sites, /sites/bekasi/live/tanks, /portfolio/stock, /sites/bekasi/qc/storage, /sites/bekasi/utility, /sites/bekasi/production, /master/commodities?siteId=bekasi, /tank-gauging/sites/bekasi/overview, /admin/users, /admin/datahub/config | 401 for each |

### Users & roles (API)

| ID | Title | Type | Preconditions | Steps | Expected result |
|---|---|---|---|---|---|
| FT-ROLE-01 | List roles with counts | Positive | Admin | GET /admin/roles | 200, includes Administrator (system) and qa-ft-ops with viewCount 5 |
| FT-ROLE-02 | Permission catalogue lists every page key | Positive | Admin | GET /admin/permissions | 200, 19 keys incl. management-stock, admin-datahub |
| FT-ROLE-03 | Create a role; edit/delete imply view | Positive | Admin | POST /admin/roles {name:qa-ft-tmp-<run>, permissions:[{resourceKey:qc, edit:true}, {resourceKey:utility, delete:true}, {resourceKey:"no-such-page", view:true}]}; GET /admin/roles/:id | 201; qc = view+edit, utility = view+delete, unknown key ignored |
| FT-ROLE-04 | Create a role with a duplicate name | Negative | qa-ft-ops role exists | POST /admin/roles {name:"qa-ft-ops"} | 409 role_name_taken |
| FT-ROLE-05 | Create a role without a name | Negative | Admin | POST /admin/roles {name:"   "} | 400 role_name_required |
| FT-ROLE-06 | Get a role by a non-numeric and a nonexistent id | Negative | Admin | GET /admin/roles/abc ; GET /admin/roles/999999 | 400 ; 404 |
| FT-ROLE-07 | Rename and re-permission a role | Positive | FT-ROLE-03 role | PUT /admin/roles/:id {name:qa-ft-tmp-<run>-b, permissions:[{resourceKey:qc,view:true}]} | 200; GET shows new name and qc view only |
| FT-ROLE-08 | Delete a system role and a role in use | Negative | Administrator is a system role; qa-ft-ops is held by users | DELETE /admin/roles/<Administrator> ; DELETE /admin/roles/<qa-ft-ops> | 409 system_role ; 409 role_in_use |
| FT-ROLE-09 | Delete an unused role; deleting it again is 404 | Positive | FT-ROLE-03 role | DELETE /admin/roles/:id twice | 204 then 404 |
| FT-ROLE-10 | A user without admin rights cannot read roles or users | Negative | qa-ft-ops (no admin-* rights) | GET /admin/roles ; GET /admin/users ; POST /admin/roles | 403 forbidden each |
| FT-USER-01 | List and read users | Positive | Admin | GET /admin/users ; GET /admin/users/<qa-ft-ops> | 200; qa-ft-ops has role qa-ft-ops and sites bekasi + qa-ft-site; no password data |
| FT-USER-02 | Get a nonexistent user and a non-numeric id | Negative | Admin | GET /admin/users/999999 ; GET /admin/users/abc | 404 ; 400 |
| FT-USER-03 | Create a user with a role and an activated site | Positive | Admin; qa-ft-site is activated and its company too | POST /admin/users {username:qa-ft-new-mwk8kwy6, password, roleIds:[qa-ft-liveonly], siteIds:[qa-ft-site]}; new user logs in | 201 {id, siteCount:1}; login 200 with site qa-ft-site |
| FT-USER-04 | Create a user: missing username, missing password, short password | Negative | Admin | POST /admin/users {password} ; {username} ; {username, password:"12345"} | 400 username_required ; 400 password_required ; 400 password_short |
| FT-USER-05 | Create a user with a duplicate username or e-mail | Negative | FT-USER-03 user | POST same username ; POST new username with the same e-mail | 409 username_taken ; 409 email_taken |
| FT-USER-06 | Create a user with a nonexistent role id | Negative | Admin | POST /admin/users {…, roleIds:[999999]} | 400, no user created |
| FT-USER-07 | Create a user with roleIds of the wrong type (string instead of array) | Negative | Admin | POST /admin/users {username, password, roleIds:"1"} | 400 validation error (not a 500) |
| FT-USER-08 | Create a user with siteIds of the wrong type (object) | Negative | Admin | POST /admin/users {username, password, siteIds:{a:1}} | 400 validation error (not a 500) |
| FT-USER-09 | Create a user with an invalid e-mail address | Negative | Admin | POST /admin/users {username, password, email:"not-an-email-<run>"} | 400 invalid e-mail |
| FT-USER-10 | Update a user with isActive as the string "false" | Negative | FT-USER-03 user | PUT /admin/users/:id {isActive:"false", roleIds, siteIds} | 400 (wrong type) or the user deactivated; never silently left active |
| FT-USER-11 | Update a user: display name, password reset, roles | Positive | FT-USER-03 user | PUT /admin/users/:id {displayName:"Renamed", password:"QaFt-reset-3", roleIds:[qa-ft-liveonly], siteIds:[qa-ft-site]}; login with new password | 200 {siteCount:1}; login 200 |
| FT-USER-12 | Update a user: short password, nonexistent id, non-numeric id | Negative | FT-USER-03 user | PUT /admin/users/:id {password:"123"} ; PUT /admin/users/999999 ; PUT /admin/users/abc | 400 password_short ; 404 ; 400 |
| FT-USER-13 | Administrator cannot deactivate or delete their own account | Negative | Admin signed in | PUT /admin/users/<self> {isActive:false} ; DELETE /admin/users/<self> | 400 self_deactivate ; 400 self_delete (nothing changed) |
| FT-USER-14 | Delete a user: hidden from the list, cannot sign in, second delete is 404 | Positive | FT-USER-03 user | DELETE /admin/users/:id ; GET /admin/users ; login ; DELETE again | 204; not listed; login 401; 404 |
| FT-USER-15 | A deleted user's username can be used again | Negative | FT-USER-14 deleted user | POST /admin/users with the deleted username | 201 (deleted users are hidden everywhere, so their name should be free) — or a message that says the name belongs to a deleted user |
| FT-USER-16 | An activated site of a non-activated company is not grantable | Negative | QA seed: bekasi activated, company prc-general-ho-jakarta not activated | GET /admin/sites as admin | 200; list contains qa-ft-site and not bekasi (documents the QA-seed state used by the other cases) |
| FT-USER-17 | Delegated admin creates a user with a role inside their own rights, only on sites they hold | Positive | qa-ft-useradmin holds admin-users/admin-roles + live-ops view, sites bekasi + qa-ft-site | POST /admin/users {username:qa-ft-sub-mwk8kwy6, roleIds:[qa-ft-liveonly], siteIds:[qa-ft-site, qa-other]} | 201, siteCount 1 (qa-other silently not granted) |
| FT-USER-18 | Delegated admin cannot grant the Administrator role or a role with rights they lack | Negative | qa-ft-useradmin | POST /admin/users roleIds:[Administrator] ; roleIds:[qa-ft-master] | 403 cannot_grant_role for both, no user created |
| FT-USER-19 | Delegated admin cannot change their own roles | Negative | qa-ft-useradmin | PUT /admin/users/<self> roleIds:[qa-ft-useradmin, qa-ft-liveonly] | 403 cannot_change_own_roles |
| FT-USER-20 | Delegated admin cannot manage a user holding the Administrator role | Negative | qa-ft-admin2 holds Administrator (inactive) | PUT /admin/users/<qa-ft-admin2> with its current data + new password ; DELETE /admin/users/<qa-ft-admin2> | 403 cannot_manage_user for both |
| FT-USER-21 | Delegated admin cannot create a role holding rights they lack, nor edit a system role | Negative | qa-ft-useradmin | POST /admin/roles {permissions:[master-tanks edit]} ; PUT /admin/roles/<Viewer> with Viewer's current data | 403 cannot_grant_permission ; 403 system_role |
| FT-USER-22 | Delegated admin lists only the sites they may grant, and deletes the user they created | Positive | FT-USER-17 user | GET /admin/sites ; DELETE /admin/users/<sub> | sites = [qa-ft-site]; 204 |
| FT-DH-01 | DataHub configuration and runs are readable by the Administrator, without secrets | Positive | Admin | GET /admin/datahub/config ; GET /admin/datahub/runs | 200 ; 200; no plain secret fields |

### Site access & modules (API)

| ID | Title | Type | Preconditions | Steps | Expected result |
|---|---|---|---|---|---|
| FT-SITE-01 | Site list holds only the sites a user has | Positive | qa-ft-ops holds bekasi + qa-ft-site; qa-ft-nosite holds none | GET /api/v1/sites as each | qa-ft-ops: [bekasi, qa-ft-site]; qa-ft-nosite: [] |
| FT-SITE-02 | Site detail for a held site | Positive | Admin holds bekasi | GET /api/v1/sites/bekasi | 200 {siteName:Bekasi, timezone:Asia/Jakarta} |
| FT-SITE-03 | Any site route for a site the user does not hold, or that does not exist | Negative | qa-ft-ops does not hold qa-other | GET /sites/qa-other ; /sites/qa-other/live/tanks ; /sites/qa-other/qc/storage ; /sites/nope/snapshot | 403 forbidden for each (no data leak) |
| FT-SITE-04 | Site module matrix | Positive | Admin | GET /admin/site-modules | 200, modules = [live-ops, qc, utility, daily-production]; qa-ft-site shows [qc] |
| FT-SITE-05 | Set site modules with invalid input | Negative | Admin | PUT /admin/site-modules/qa-ft-site {modules:["qc","bogus"]} ; {modules:"qc"} ; PUT /admin/site-modules/no-such-site {modules:[]} | 400 invalid_modules ; 400 invalid_modules ; 404 site_not_found |
| FT-SITE-06 | Pages of a module that is off for the site are refused | Negative | qa-ft-site modules = [qc]; qa-ft-ops holds qa-ft-site with live-ops/utility/production rights | GET /sites/qa-ft-site/live/tanks ; /utility ; /production ; /stock-history?from=…&to=… | 403 module_not_enabled for each |
| FT-SITE-07 | Switching a module on takes effect at once, switching it off blocks again | Positive | qa-ft-site modules = [qc] | PUT modules [qc, live-ops]; qa-ft-ops GET live/tanks + /auth/me; PUT modules [] ; qa-ft-qc GET qc/storage; restore [qc] | PUT 200; live/tanks 200 []; /me lists live-ops; after [] qc/storage 403 module_not_enabled |
| FT-SITE-08 | Module settings need master-sites rights | Negative | qa-ft-ops has no master-sites right | GET /admin/site-modules ; PUT /admin/site-modules/qa-ft-site | 403 ; 403 |
| FT-SITE-09 | A user with a site but no page rights sees no operational data | Negative | qa-ft-none holds bekasi, role with no rights | GET /auth/me ; /sites/bekasi/snapshot ; /live/tanks ; /qc/storage ; /utility ; /production ; /portfolio/stock ; /master/commodities?siteId=bekasi ; /tank-gauging/sites/bekasi/overview ; /admin/datahub/config | /me 200 with empty permissions; every other call 403 |

### Master data & commodity specs (API)

| ID | Title | Type | Preconditions | Steps | Expected result |
|---|---|---|---|---|---|
| FT-MD-01 | Organisation tree | Positive | Signed in | GET /master/org | 200 with companies, sites (bekasi, qa-other, qa-ft-site), plants |
| FT-MD-02 | Commodity list for a site with rule counts | Positive | Admin | GET /master/commodities?siteId=bekasi | 200, 9 commodities, cpo has ruleCount 6 |
| FT-MD-03 | Commodity list without a site, or for an unknown site | Negative | Admin | GET /master/commodities ; ?siteId=no-such-site | 400 or 404 site_not_found for both |
| FT-MD-04 | Read one commodity's storage specs and the parameter catalogue | Positive | Admin | GET /master/commodities/cpo/specs?siteId=bekasi | 200, 14 parameters (incl. lab.odor kind pass), rules list |
| FT-MD-05 | Specs of a nonexistent commodity | Negative | Admin | GET /master/commodities/nope/specs?siteId=bekasi ; PUT same | 404 not_found for both |
| FT-MD-06 | Save a commodity's storage specs and read them back | Positive | Admin; qa-ft-site has no rules | PUT /master/commodities/cpo/specs?siteId=qa-ft-site {rules:[ffa max 5 reject, iv min 50 watch, iv max 55 watch, odour reject, moisture max "0.5" (string)]} | 200; 5 rules stored in quality_rules for qa-ft-site/cpo; odour limit null; "0.5" stored as 0.5; list ruleCount 5, rejectCount 3 |
| FT-MD-07 | Spec validation: every invalid input is refused and nothing is changed | Negative | FT-MD-06 rules saved | PUT specs with: rules not array; unknown parameter; severity "fatal"; bound "between"; limit missing; limit "abc"; duplicate ffa max; iv min 60 > iv max 55 | 400 with invalid_rules, unknown_parameter, invalid_severity, invalid_bound, limit_required, limit_required, duplicate_rule, min_above_max; DB still 5 rules |
| FT-MD-08 | Spec limit boundaries: negative, zero and non-finite limits | Negative | Admin | PUT specs pfad on qa-ft-site {rules:[cloud point max -1]} ; {ffa max "1e309"} ; {ffa min 0}; then clear | Negative limit accepted 200 (cloud point can be below 0 °C); 1e309 (Infinity) refused 400 limit_required; 0 accepted 200 |
| FT-MD-09 | Clearing all rules leaves the commodity spec-pending | Positive | FT-MD-06 rules | PUT specs cpo qa-ft-site {rules:[]} | 200 {rules:[]}; DB 0 rows |
| FT-MD-10 | Non-admin cannot read or edit specs of a site they do not hold; viewer cannot edit | Negative | qa-ft-master holds bekasi + qa-ft-site (not qa-other); qa-ft-ops has no master-commodities right | qa-ft-master GET specs ?siteId=qa-other ; PUT ?siteId=qa-other ; qa-ft-ops PUT ?siteId=qa-ft-site | 404 site_not_found ; 404 site_not_found ; 403 forbidden |
| FT-MD-11 | Non-admin master editor saves specs on a site they hold | Positive | qa-ft-master holds qa-ft-site | PUT /master/commodities/rpo/specs?siteId=qa-ft-site {rules:[ffa max 0.1]} ; then clear | 200, 1 rule; clear 200 |
| FT-MD-12 | Change a site timezone | Positive | Admin | PUT /master/org/sites/qa-ft-site {timezone:"Asia/Makassar"}; restore Asia/Jakarta | 200 {ok:true}; DB updated |
| FT-MD-13 | Site timezone: invalid zone, empty, unknown site | Negative | Admin | PUT /master/org/sites/qa-ft-site {timezone:"Mars/Olympus"} ; {timezone:""} ; PUT /master/org/sites/no-such-site {timezone:"Asia/Jakarta"} | 400 invalid_timezone ; 400 invalid_timezone ; 404 |
| FT-MD-14 | Activation rules: company with an active site, site of an inactive company, bad input | Negative | qa-ft-co (on) with qa-ft-site and qa-ft-site2 (on) | PUT /master/org/activation {company qa-ft-co off} ; {sites qa-ft-site, qa-ft-site2 off} + {company off} + {site qa-ft-site on} ; {entityType:"plant"} ; {site no-such on}; restore | 409 company_has_active_sites ; site-on under an off company 409 company_not_activated ; 400 invalid_request ; 404 |
| FT-MD-15 | A non-admin master-sites editor cannot change a site they do not hold | Negative | qa-ft-master has master-sites edit and holds bekasi + qa-ft-site, NOT qa-ft-site2 (fixture site, same activated company) | qa-ft-master PUT /master/org/sites/qa-ft-site2 {timezone:"Asia/Makassar"} ; PUT /master/org/activation {entityType:"site", id:"qa-ft-site2", activated:false}; check DB; restore | 403/404 for both and qa-ft-site2 unchanged — as for commodity specs, tank gauging and site modules, a non-admin may act only on sites they hold |
| FT-MD-16 | Org changes need master rights | Negative | qa-ft-ops (no master rights) | PUT /master/org/sites/qa-ft-site ; PUT /master/org/activation | 403 ; 403 |

### Tank & Stock (live-ops) (API)

| ID | Title | Type | Preconditions | Steps | Expected result |
|---|---|---|---|---|---|
| FT-OPS-01 | Snapshot of a site with logsheet data | Positive | bekasi has soundings 2026-07-22..2026-10-20 | GET /sites/bekasi/snapshot | 200, soundingAsOf 2026-10-20, soundingDates sorted, hasLabData true |
| FT-OPS-02 | Tanks of the latest day | Positive | bekasi | GET /sites/bekasi/live/tanks | 200, one row per tank, all recordedOn = 2026-10-20 or no reading; quantity <= capacity |
| FT-OPS-03 | Tanks of a chosen earlier day | Positive | bekasi | GET /sites/bekasi/live/tanks?on=2026-10-01 | 200, rows recordedOn 2026-10-01 |
| FT-OPS-04 | Tanks for a malformed day | Negative | bekasi | GET /sites/bekasi/live/tanks?on=garbage ; ?on=2026-02-30 | 400 invalid date (not 200 with recordedOn "garbage") |
| FT-OPS-05 | Stock history between two days (Commodity Stock Movement) | Positive | bekasi | GET /sites/bekasi/stock-history?from=2026-10-01&to=2026-10-20 | 200, [{tankId, points}] and every point between the two days |
| FT-OPS-06 | Stock history: missing range, reversed range, wrong format | Negative | bekasi | GET stock-history (no params) ; ?from=2026-10-20&to=2026-10-01 ; ?from=20261001&to=20261020 | 400 invalid_range for each |
| FT-OPS-07 | Stock history with an impossible calendar date | Negative | bekasi | GET /sites/bekasi/stock-history?from=2026-02-30&to=2026-03-01 ; ?from=2026-10-01&to=2026-13-01 | 400 invalid_range (not a 500 with a database error) |
| FT-OPS-08 | One tank's sounding history and labs | Positive | bekasi T04 | GET /sites/bekasi/tanks/T04/soundings ; /tanks/T04/labs | 200, soundings ordered by day; labs list with storageVerdict |
| FT-OPS-09 | History of a tank that does not exist | Negative | bekasi | GET /sites/bekasi/tanks/NOPE/soundings ; /labs | 200 [] or 404 for both (no error) |
| FT-OPS-10 | Logistics, analytics summary and movements | Positive | bekasi | GET /sites/bekasi/live/logistics ; /analytics/summary ; /analytics/summary?tankId=T04 ; /analytics/movements | 200 each; summary approvalRate in [0,1]; with tankId approvalRate null |
| FT-OPS-11 | Live-ops data needs live-ops or ops-analytics view | Negative | qa-ft-qc holds bekasi with qc right only | GET /sites/bekasi/live/tanks ; /snapshot ; /stock-history?… ; /tanks/T04/soundings | 403 forbidden each |
| FT-OPS-12 | A live-ops viewer reads the dashboard of a held site | Positive | qa-ft-ops holds bekasi | GET /sites/bekasi/live/tanks | 200, same tank count as for the Administrator |

### Stock Overview / portfolio (API)

| ID | Title | Type | Preconditions | Steps | Expected result |
|---|---|---|---|---|---|
| FT-PF-01 | Portfolio totals equal the sum of the sites and of the commodity classes | Positive | Admin holds bekasi (live-ops on) | GET /portfolio/stock | 200; portfolio.quantityKg = Σ sites.quantityKg; per site Σ classes.quantityKg = site.quantityKg; tanksTotal = Σ counts |
| FT-PF-02 | Stock movement ends on the same figure as the overview total | Positive | bekasi | GET /portfolio/movement ; GET /portfolio/stock | movement site.to = overview site.day and the last series point = overview site.quantityKg; class series sum to the total on each day |
| FT-PF-03 | Movement period length follows ?days within 7..92 | Positive | bekasi | GET /portfolio/movement?days=7 ; ?days=1000 ; ?days=3 ; ?days=abc | days 7 (7 points), 92, 7, 30 (default) respectively |
| FT-PF-04 | Overview lists only held sites with the Tank farm module on | Positive | qa-ft-ops holds bekasi (live-ops on) + qa-ft-site (live-ops off) | GET /portfolio/stock ; /portfolio/movement as qa-ft-ops | sites = [bekasi] in both |
| FT-PF-05 | A management-only user reads the overview and tank history, but not the operational pages | Positive | qa-ft-mgmt has management-stock only, holds bekasi | GET /portfolio/stock ; /portfolio/sites/bekasi/tanks/T04/history ; /portfolio/sites/bekasi/tanks/T04/labs ; /sites/bekasi/live/tanks | 200 ; 200 ; 200 ; 403 |
| FT-PF-06 | Overview tank history of a site not held or without the module | Negative | qa-ft-ops: qa-other not held; qa-ft-site has live-ops off | GET /portfolio/sites/qa-other/tanks/T04/history ; /portfolio/sites/qa-ft-site/tanks/T04/labs | 403 ; 403 |
| FT-PF-07 | Overview needs the management-stock right | Negative | qa-ft-qc lacks management-stock | GET /portfolio/stock ; /portfolio/movement | 403 ; 403 |
| FT-PF-08 | A user with the right but no site gets an empty overview | Positive | qa-ft-nosite (management-stock, no sites) | GET /portfolio/stock | 200, sites [], portfolio totals 0 / sitesTotal 0 |

### QC (API)

| ID | Title | Type | Preconditions | Steps | Expected result |
|---|---|---|---|---|---|
| FT-QC-01 | Storage certificates with verdicts | Positive | bekasi: 225 certificates 2026-10-02..2026-10-20 | GET /sites/bekasi/qc/storage | 200, rows with verdict in {pass, quarantine, spec-pending} |
| FT-QC-02 | Storage filtered by date range | Positive | bekasi | GET /sites/bekasi/qc/storage?from=2026-10-10&to=2026-10-12 | 200, every snapshotOn within the range, fewer rows than unfiltered |
| FT-QC-03 | Vessels, trucks and oil movements | Positive | bekasi | GET /qc/vessels ; /qc/trucks ; /qc/movements | 200 each; vessels have samples arrays; trucks have rows; movements {periodStart, rows} |
| FT-QC-04 | Refinery snapshot, history and ledger | Positive | bekasi refinery days to 2026-10-20 | GET /qc/refinery ; /qc/refinery/history ; /qc/refinery/ledger | 200 each; history has oils[] and points[] |
| FT-QC-05 | Refinery hourly sheet of a day with data | Positive | bekasi refinery day 2026-10-20 with finished oil RPO/RBDPO | GET /qc/refinery/hourly?date=2026-10-20&oil=RPO%2FRBDPO (as the Refinery history dialog calls it) | 200 {productionDate, oil, points[]} |
| FT-QC-06 | Refinery hourly without a date, without an oil, or for a day with no data | Negative | bekasi | GET /qc/refinery/hourly ; ?date=2026-10-20 (no oil) ; ?date=2020-01-01&oil=CPO | 400 or 404 for the missing parameters; 404 for no data |
| FT-QC-07 | Refinery endpoints with a malformed date filter | Negative | bekasi | GET /qc/refinery?from=garbage ; /qc/refinery/ledger?to=2026-02-30 ; /qc/refinery/hourly?date=bad | 400 for each (not a 500 with a database message) |
| FT-QC-08 | Storage/vessel filters with a malformed date | Negative | bekasi | GET /qc/storage?from=garbage ; /qc/vessels?to=abc | 400 (invalid date) — not 200 with silently empty/unfiltered rows |
| FT-QC-09 | QC needs the qc right | Negative | qa-ft-ops lacks qc | GET /sites/bekasi/qc/storage ; /qc/refinery | 403 ; 403 |
| FT-QC-10 | A QC user on an empty site gets empty lists, not errors | Positive | qa-ft-qc holds qa-ft-site (qc on, no data) | GET /sites/qa-ft-site/qc/storage ; /vessels ; /trucks ; /movements ; /refinery/ledger | 200 each with empty data |
| FT-QC-11 | Storage verdict follows the commodity spec of the site | Positive | bekasi pfad tank T04 lab FFA ≈ 86.27 with pfad rule FFA min 70 (reject) | GET /qc/storage; find a pfad row; check verdict against the stored rules | Rows with commodityId pfad and FFA >= 70 are not quarantined for FFA |

### Utility (API)

| ID | Title | Type | Preconditions | Steps | Expected result |
|---|---|---|---|---|---|
| FT-UT-01 | Utility board lists all forms | Positive | bekasi (utility on) | GET /sites/bekasi/utility | 200, 13 forms, from <= to |
| FT-UT-02 | Utility board with an explicit and a reversed range | Positive | bekasi | GET /utility?from=2026-10-01&to=2026-10-20 ; ?from=2026-10-20&to=2026-10-01 | 200 with from/to as given; reversed range is swapped |
| FT-UT-03 | Utility board with an impossible calendar date | Negative | bekasi | GET /utility?from=2026-13-01&to=2026-13-05 | 400 (or the default range) — not a 500 |
| FT-UT-04 | Utility day: missing parameters, unknown form/day, impossible date | Negative | bekasi | GET /utility/day ; ?form=F/UTI-010&date=2020-01-01 ; ?form=F/UTI-010&date=2026-02-30 | 400 form_and_date_required ; 404 ; 400 (not 500) |
| FT-UT-05 | Utility needs the right, a held site and the module | Negative | qa-ft-qc lacks utility; qa-ft-ops holds qa-ft-site (utility off) and not qa-other | qa-ft-qc GET /sites/bekasi/utility ; qa-ft-ops GET /sites/qa-ft-site/utility ; qa-ft-ops GET /sites/qa-other/utility | 403 forbidden ; 403 module_not_enabled ; 403 |

### Production (API)

| ID | Title | Type | Preconditions | Steps | Expected result |
|---|---|---|---|---|---|
| FT-PR-01 | Daily production days of a site | Positive | bekasi (daily-production on) | GET /sites/bekasi/production | 200 {days: []} (QA seed has no production days) |
| FT-PR-02 | Production needs the right, a held site and the module | Negative | qa-ft-qc lacks daily-production; qa-ft-ops: qa-ft-site module off; qa-other not held | qa-ft-qc GET /sites/bekasi/production ; qa-ft-ops GET /sites/qa-ft-site/production ; qa-ft-ops GET /sites/qa-other/production | 403 ; 403 module_not_enabled ; 403 |

### Tank gauging (API)

| ID | Title | Type | Preconditions | Steps | Expected result |
|---|---|---|---|---|---|
| FT-TG-01 | Tank gauging overview of a site | Positive | Admin; bekasi | GET /tank-gauging/sites/bekasi/overview | 200 {site, sources[], settings {roundTimes, toleranceMin, retryMinutes, maxRetries}, rounds[], tanks[]} |
| FT-TG-02 | Overview of an unknown site, and without master-tanks rights | Negative | - | Admin GET /tank-gauging/sites/no-such/overview ; qa-ft-ops GET /tank-gauging/sites/bekasi/overview ; qa-ft-master GET /tank-gauging/sites/qa-other/overview | 404 ; 403 ; 404 (not held) |
| FT-TG-03 | Save daily round times and tolerance | Positive | qa-ft-site | PUT /tank-gauging/sites/qa-ft-site/settings {roundTimes:"14:30, 6:30", toleranceMin:45} | 200 {roundTimes:["06:30","14:30"], toleranceMin:45}; overview shows them |
| FT-TG-04 | Daily rounds validation: empty, out-of-range times, tolerance bounds | Negative | qa-ft-site | PUT settings {roundTimes:""} ; {roundTimes:"25:00"} ; {roundTimes:"06:30", toleranceMin:0} ; 241 ; 30.5 ; "" | 400 each, settings unchanged (06:30,14:30 / 45) |
| FT-TG-05 | Daily rounds with one valid and one invalid time | Negative | qa-ft-site settings 06:30,14:30 | PUT settings {roundTimes:"06:30, 99:99, noon", toleranceMin:30} | 400 naming the invalid entries — not silently saved as ["06:30"] |
| FT-TG-06 | Daily rounds with a non-number tolerance (boolean) | Negative | qa-ft-site | PUT settings {roundTimes:"06:30", toleranceMin:true} | 400 (not saved as 1 minute) |
| FT-TG-07 | Add a gauge source (unreachable test address); secrets are never returned | Positive | qa-ft-site, no sources | POST /tank-gauging/sites/qa-ft-site/sources {baseUrl:"http://127.0.0.1:9/index.esp", label:"qa-ft gauge", authType:"basic", authUser:"u", secret:"qa-ft-secret"} ; GET overview | 201, baseUrl normalised to http://127.0.0.1:9 (index.esp stripped), secretConfigured true, no secret in any response |
| FT-TG-08 | Gauge source validation: duplicate, missing/invalid/non-http URL, auth rules | Negative | FT-TG-07 source | POST same baseUrl ; {} ; {baseUrl:"not a url"} ; {baseUrl:"ftp://127.0.0.1:9"} ; {baseUrl, authType:"basic"} (no user) ; {authType:"cookie"} (no secret) ; {authType:"magic"} | 409 source_exists ; 400 ×6 |
| FT-TG-09 | Edit a source; blank secret keeps the stored one; switch to no auth | Positive | FT-TG-07 source | PUT /tank-gauging/sources/:id {label:"qa-ft renamed", secret:""} ; PUT {authType:"none"} | 200 label changed, secretConfigured still true ; 200 secretConfigured false |
| FT-TG-10 | Test connection to an unreachable gauge | Negative | FT-TG-07 source at http://127.0.0.1:9 | POST /tank-gauging/sources/:id/test | 200 {ok:false, tankCount:0, error:<message>} within a few seconds |
| FT-TG-11 | Poll a site whose only gauge is unreachable | Negative | qa-ft-site with the unreachable source | POST /tank-gauging/sites/qa-ft-site/poll | 200 {ok:false, sources:[{error}]}; source last_poll_ok false |
| FT-TG-12 | Source routes with a bad id, someone else's source, or without edit rights | Negative | FT-TG-07 source on qa-ft-site | PUT /tank-gauging/sources/999999 ; PUT /tank-gauging/sources/abc ; qa-ft-ops PUT /tank-gauging/sources/:id ; qa-ft-ops PUT /tank-gauging/sites/qa-ft-site/settings | 404 ; 404 ; 403 ; 403 |
| FT-TG-13 | Delete a source; deleting it again is 404 | Positive | FT-TG-07 source | DELETE /tank-gauging/sources/:id twice | 204 then 404 |
| FT-TG-14 | Poll a site with no enabled source is skipped | Positive | qa-ft-site with no source | POST /tank-gauging/sites/qa-ft-site/poll | 200 {skipped:true, reason:"no_enabled_sources_for_site"} |

## UI scenarios

### Frontend navigation & rendering (UI)

| ID | Title | Type | Preconditions | Steps | Expected result |
|---|---|---|---|---|---|
| FT-UI-01 | Visiting a protected page while signed out redirects to the sign-in page | Negative | Signed out | Open http://localhost:5176/ | / redirects to /login with the sign-in form |
| FT-UI-05 | Deep link is restored after sign-in | Positive | Signed out | Open /management -> redirected to /login; sign in | Signed out, open /management -> /login; after signing in, land on /management |
| FT-UI-17 | Unknown URL shows a not-found page | Negative | Signed in | Open /this-page-does-not-exist | A 'page not found' message inside the app shell with a way back |
| FT-UI-27 | Dev-server proxy to the API | Positive | Dev server on 5176 | Open http://localhost:5176/api/v1/health | http://localhost:5176/api/v1/health answers {ok:true} |
| FT-UI-28 | No JavaScript errors on any page | Positive | Whole browser session | read_console_messages (errors) after the run | read_console_messages shows no uncaught errors or React errors across the session |

### Auth & session (UI)

| ID | Title | Type | Preconditions | Steps | Expected result |
|---|---|---|---|---|---|
| FT-UI-02 | Sign-in with empty fields | Negative | On /login | Click Sign In with both fields empty | Inline message asking for username and password; no request succeeds |
| FT-UI-03 | Sign-in with a wrong password | Negative | Fixture user qa-ft-ops | Enter qa-ft-ops and a wrong password, press Enter | Message 'Invalid username or password.', stays on /login |
| FT-UI-04 | Sign-in as Administrator lands on Tank & Stock Dashboard with Bekasi data | Positive | admin / admin123 (dev seed) | Sign in; wait for data; read console errors | Redirect to /, KPIs, commodity cards and tank table for Bekasi 20 Oct 2026; no console errors |
| FT-UI-26 | Sign out | Positive | Signed in | User menu -> Sign out; open /management | Sign out returns to /login; protected pages then redirect to /login |

### Tank & Stock (live-ops) (UI)

| ID | Title | Type | Preconditions | Steps | Expected result |
|---|---|---|---|---|---|
| FT-UI-06 | Commodity card dialog (CPO) | Positive | Admin on Bekasi | Click the CPO commodity card; review dialog; press Escape | Clicking the CPO card opens a dialog with quantity chart, average quality in period, and the tanks in this stock; Escape closes it |
| FT-UI-07 | Commodity Stock Movement section on Tank & Stock | Positive | Admin on Bekasi | Scroll to Commodity Stock Movement; compare latest total with Stock Overview; click "Show CPO on the chart" | Section shows the last 30 days; the latest All-commodities figure equals the current total; choosing a commodity switches the chart |
| FT-UI-08 | Day picker loads an earlier day | Positive | Admin on Bekasi | Open the Day picker; choose 15 Oct 2026 | Choosing 15 Oct 2026 reloads KPIs and cards for that day |
| FT-UI-16 | Ops analytics renders | Positive | Admin | Open /ops-analytics | /ops-analytics shows tank picker and level/temperature chart |

### Stock Overview / portfolio (UI)

| ID | Title | Type | Preconditions | Steps | Expected result |
|---|---|---|---|---|---|
| FT-UI-09 | Stock Overview renders totals and movement | Positive | Admin (management-stock) | Open /management; read KPIs, attention, By site and movement | Stock, capacity, fill, tanks reporting, attention list, By site table and Commodity Stock Movement agree with the API |
| FT-UI-10 | Stock Overview: By commodity view | Positive | Admin | On /management click the By commodity tab | Tab switches to per-commodity rows and the URL keeps the view |
| FT-UI-11 | Per-commodity figures agree between Tank & Stock and Stock Overview for the same day | Positive | Admin, Bekasi 20 Oct 2026 | Compare each commodity card on / with the By commodity row on /management | Same day (20 Oct 2026): a commodity's capacity, tank count and fill are the same on both pages |

### QC (UI)

| ID | Title | Type | Preconditions | Steps | Expected result |
|---|---|---|---|---|---|
| FT-UI-12 | QC pages render with data | Positive | Admin (qc) | Open /qc, /qc/storage, /qc/vessel, /qc/truck, /qc/movements, /qc/refinery | /qc, /qc/storage, /qc/vessel, /qc/truck, /qc/movements, /qc/refinery render without console errors |
| FT-UI-13 | Oil in and out with no data shows a readable empty state | Negative | Admin; no oil-movement data in QA seed | Open /qc/movements | An empty state such as 'No movements in this period' with no broken sentence |

### Utility (UI)

| ID | Title | Type | Preconditions | Steps | Expected result |
|---|---|---|---|---|---|
| FT-UI-14 | Utility pages render | Positive | Admin (utility) | Open /utility and its five sub-pages | /utility, /boiler, /coal, /water, /effluent, /loader render (QA seed has no utility days) with empty states |

### Production (UI)

| ID | Title | Type | Preconditions | Steps | Expected result |
|---|---|---|---|---|---|
| FT-UI-15 | Daily production pages render | Positive | Admin (daily-production) | Open /daily-production and /daily-production/refinery-500 | /daily-production and a plant section page render with empty data |

### Master data & commodity specs (UI)

| ID | Title | Type | Preconditions | Steps | Expected result |
|---|---|---|---|---|---|
| FT-UI-18 | Master Commodities list and Edit limits dialog | Positive | Admin (master-commodities edit) | Open /master/commodities; click Edit limits on PMF | List per site with limit counts and aliases; Edit limits opens the editor |
| FT-UI-19 | Commodity spec editor validation | Negative | PMF editor on Bekasi (PMF has no limits) | Add limit, Save with empty limit; type abc, Save; set limit 1, add FFA Max 5, Save; change second row to Min, Save; Cancel; check DB | Empty limit, non-number limit, duplicate FFA Max, and FFA Min above Max are each refused with a message; nothing saved |

### Tank gauging (UI)

| ID | Title | Type | Preconditions | Steps | Expected result |
|---|---|---|---|---|---|
| FT-UI-20 | Tank gauging Daily rounds validation | Negative | Admin (master-tanks edit); site QA FT Site selected | Round times 25:00, Save; round times 06:30, 14:30 with Match within 0, Save | Round time 25:00 and tolerance 0 are refused with a message |
| FT-UI-21 | Tank gauging Daily rounds with one valid and two invalid times | Negative | QA FT Site selected | Round times "06:30, 99:99, noon", Match within 30, Save; check DB | '06:30, 99:99, noon' is refused naming the invalid entries |

### Users & roles (UI)

| ID | Title | Type | Preconditions | Steps | Expected result |
|---|---|---|---|---|---|
| FT-UI-22 | Administration and master pages render for the Administrator | Positive | Admin | Open each admin/master page listed | /admin/users, /admin/roles, /admin/site-modules, /admin/datahub, /master, /master/sites, /master/tank-farm render without console errors |

### Site access & modules (UI)

| ID | Title | Type | Preconditions | Steps | Expected result |
|---|---|---|---|---|---|
| FT-UI-23 | Non-admin menu shows only permitted pages | Positive | qa-ft-ops signed in | Read the sidebar | qa-ft-ops (live-ops, ops-analytics, management-stock, utility, daily-production view) sees Stock Overview, Tank & Stock, Utility, Daily Production; no QC, Master or Admin entries |
| FT-UI-24 | Non-admin opening a forbidden page by URL | Negative | qa-ft-ops signed in | Open /qc/storage, /master/commodities, /admin/users by URL | /qc/storage, /master/commodities, /admin/users show 'Access denied' and load no data |
| FT-UI-25 | Non-admin switches to a site where their modules are off | Negative | qa-ft-ops holds Bekasi + QA FT Site (QA FT Site modules = qc only) | Site switcher -> QA FT Site; then back to Bekasi | On QA FT Site (only qc on; user lacks qc) the landing page explains the module is off and the menu shrinks |

## Existing automated checks

| Check | Command |
|---|---|
| Backend unit tests | `cd Backend && npm test` |
| Frontend type check | `cd Frontend && npx tsc -b` |
| Frontend lint | `cd Frontend && npm run lint` |
| Frontend production build | `cd Frontend && npm run build` |

## How to re-run

```
node qa/functional/api-suite.mjs          # runs all API scenarios, writes qa/functional/results.json
node qa/functional/api-suite.mjs --plan   # prints the API scenario tables above
```
