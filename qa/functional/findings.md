# Functional test findings: Plant Information Dashboard

Run 2026-11-17. Code under test: `sit` @ ed63d97 (the QA API on :3010 was running that commit). File:line references are to that commit.

## Summary

| | Designed | Executed | Pass | Fail | Blocked |
|---|---|---|---|---|---|
| API (`api-suite.mjs` → `results.json`) | 131 | 131 | 116 | 15 | 0 |
| UI (browser → `ui-results.json`) | 28 | 28 | 23 | 5 | 0 |
| Total | 159 | 159 | 139 | 20 | 0 |

The 20 failing scenarios map to 14 findings: 3 Medium, 11 Low. No Critical or High.

Existing checks (logs in `qa/functional/checks/`): backend `npm test` 86/86 pass; frontend `npx tsc -b` exit 0; `npm run lint` 0 errors, 61 warnings; `npm run build` OK with a warning that `index-*.js` is 781 kB.

These work well: login and the throttle (10 failures → 429; other accounts unaffected); a session ends as soon as the user is deactivated; the role and permission model incl. delegated admins (cannot grant Administrator or rights they lack, cannot change their own roles, cannot manage an Administrator); per-site access and per-site modules take effect at once; commodity spec validation in API and UI; Stock Overview total = sum of sites = sum of commodity classes, and the last movement point = the overview total; gauge source validation; secrets never returned.

## Findings

### F-01 (Medium): impossible or malformed dates in query strings return HTTP 500 with the database error
- **Scenarios:** FT-OPS-07, FT-QC-07, FT-UT-03, FT-UT-04.
- **Reproduction:** `GET /api/v1/sites/bekasi/stock-history?from=2026-02-30&to=2026-03-01` → `500 {"error":"date/time field value out of range: \"2026-02-30\""}`; `GET /sites/bekasi/qc/refinery?from=garbage` → `500 {"error":"invalid input syntax for type date: \"garbage\""}` (also `/qc/refinery/ledger?to=2026-02-30`, `/qc/refinery/hourly?date=bad`); `GET /sites/bekasi/utility?from=2026-13-01&to=2026-13-05` → 500; `GET /sites/bekasi/utility/day?form=F%2FUTI-010&date=2026-02-30` → 500.
- **Expected:** 400 `invalid_range` / `invalid_date`.
- **Code:** `operations.js:498-509` (`isoDay` checks the shape only); `qc.js:283-284` (`::date` casts on the raw query string; reached from `:328`, `:341`, `:365`, `:377`); `utility.js:29`, `:56`, `:173`, `:313-314`.
- **Fix:** a shared `parseDay()` that checks the date is a real calendar day; 400 when not. Map Postgres class-22 errors to 400 as a safety net.

### F-02 (Medium): a non-admin master-sites editor can change the timezone and activation of sites they do not hold
- **Scenario:** FT-MD-15.
- **Reproduction:** as `qa-ft-master` (master-sites edit; holds bekasi and qa-ft-site, not qa-ft-site2): `PUT /api/v1/master/org/sites/qa-ft-site2 {"timezone":"Asia/Makassar"}` → 200; `PUT /api/v1/master/org/activation {"entityType":"site","id":"qa-ft-site2","activated":false}` → 200. The database then shows the new timezone and `is_activated=false`.
- **Expected:** 403/404, as for commodity specs, tank gauging and site modules, which limit a non-admin to sites they hold. Switching a site off removes it from every user's session.
- **Code:** `master.js:163-190` (`setActivation`) and `master.js:195-209` (`PUT /org/sites/:id`) check only the page permission.
- **Fix:** for a non-admin, require the site to be in `req.sessionUser.sites`; require Administrator to switch a company on or off.

### F-03 (Low): a malformed JSON body returns 500
- **Scenario:** FT-AUTH-08. `POST /api/v1/auth/login` with body `{"username":` → `500 {"error":"Unexpected end of JSON input"}`. Expected 400 `invalid_json`.
- **Code:** `index.js:44-49`. **Fix:** honour `error.type==='entity.parse.failed'` and any 4xx `error.status`.

### F-04 (Low): `roleIds`/`siteIds` of the wrong type return 500
- **Scenarios:** FT-USER-07, FT-USER-08. `POST /api/v1/admin/users {..., "roleIds":"1"}` → `500 {"error":"((intermediate value) ?? []).map is not a function"}`; `"siteIds":{"a":1}` the same.
- **Code:** `admin.js:424-425` (POST), `admin.js:476-477` (PUT). **Fix:** `Array.isArray` check, 400.

### F-05 (Low): `isActive:"false"` (a string) is treated as active
- **Scenario:** FT-USER-10. `PUT /api/v1/admin/users/<id> {"isActive":"false",...}` → 200, `is_active` stays true.
- **Code:** `admin.js:440`, `admin.js:469`. **Fix:** accept only a boolean; otherwise 400.

### F-06 (Low): e-mail is not validated
- **Scenario:** FT-USER-09. `POST /admin/users {...,"email":"not-an-email"}` → 201.
- **Code:** `admin.js:440`, `admin.js:496`. **Fix:** basic format check, 400 `invalid_email`.

### F-07 (Low): a deleted user's username and e-mail stay reserved
- **Scenario:** FT-USER-15. Create a user, delete it (204), create again with the same username → `409 username_taken` (same for e-mail).
- **Code:** `admin.js:537` (soft delete) with the `users_username_key` / `users_email_key` unique constraints. **Fix:** partial unique indexes `WHERE deleted_at IS NULL` (lower-cased).

### F-08 (Low): round times silently drop invalid entries
- **Scenarios:** FT-TG-05 (API), FT-UI-21 (UI). `PUT /api/v1/tank-gauging/sites/qa-ft-site/settings {"roundTimes":"06:30, 99:99, noon","toleranceMin":30}` → `200 {"roundTimes":["06:30"]}`; the UI says "Round times saved." A typo such as "06:30, 1430" quietly removes the afternoon round.
- **Code:** `tankgauging/rounds.js:13-20`, `:68-74`. **Fix:** reject the request if any non-blank part is not HH:MM.

### F-09 (Low): tolerance accepts a boolean
- **Scenario:** FT-TG-06. `{"roundTimes":"06:30","toleranceMin":true}` → 200, stored as 1. **Code:** `rounds.js:75-76`. **Fix:** check the type first.

### F-10 (Low): malformed date filters are silently accepted
- **Scenarios:** FT-OPS-04, FT-QC-08. `GET /sites/bekasi/live/tanks?on=garbage` → 200 with `recordedOn:"garbage"` and no readings (also `?on=2026-02-30`); `GET /qc/storage?from=garbage` → 200, empty; `GET /qc/vessels?to=abc` → 200, unfiltered (string comparison).
- **Code:** `operations.js:312`; `qc.js:18-23`, `:43-44`, `:111-112`, `:175-176`. **Fix:** the `parseDay()` from F-01, 400.

### F-11 (Low): the two stock pages classify empty tanks differently
- **Scenario:** FT-UI-11. Bekasi, 20 Oct 2026: Tank & Stock PFAD card "2 of 3 tanks, 33.3%, 300 / 900 t"; Stock Overview → By commodity "PFAD 300 / 460 t, 65.2%, 2 tanks" plus "Other 0 / 1,690 t, 3 tanks". The difference is empty tank T.16 (440 t, last lab result PFAD). Total stock (7,290 t) agrees.
- **Code:** `Frontend/src/domain/commodityStock.ts:92-95` (fixed `REPORT_TANKS` map at `:22`) vs `Backend/src/domain/portfolio.js:69` (`commodityClassOf` returns "other" for an empty tank). **Fix:** one classification, returned by the API, used by both pages.

### F-12 (Low): an unknown frontend URL renders a blank page
- **Scenario:** FT-UI-17. `/this-page-does-not-exist` is empty; console warns `No routes matched location`. **Code:** `App.tsx:72-152` (no `*` route). **Fix:** a "not found" route inside `AppShell`.

### F-13 (Low): the requested page is lost after sign-in
- **Scenario:** FT-UI-05. Signed out, open `/management` → `/login` → after sign-in you land on `/`. Also breaks the Stock Overview "Copy link" for signed-out users.
- **Code:** `guards.tsx:15` saves `state.from`, but `LoginPage.tsx:68` always navigates to `/`. **Fix:** go to `state.from` when it is an in-app path.

### F-14 (Low): "Oil in and out" shows a broken sentence when there is no data
- **Scenario:** FT-UI-13. `/qc/movements` on Bekasi shows "…The sheet spans ." **Code:** `MovementPage.tsx:57` (`gatePeriodNote`). **Fix:** leave the sentence out when the period is empty.

## Test-design issues fixed (not product defects)

| Scenario | What was wrong | Fix |
|---|---|---|
| FT-QC-05 | Called `/qc/refinery/hourly` without `oil`, which the endpoint requires and the UI always sends. | Added `&oil=RPO%2FRBDPO`; the missing-oil case is a negative in FT-QC-06. |
| FT-MD-08 | Expected negative spec limits to be refused, but cloud point can be below 0 °C. | Negative limits accepted, `1e309` refused. |
| FT-MD-15 | Used `qa-other`, whose company is switched off, so a 409 hid the real check. | Uses fixture `qa-ft-site2` and checks the database. |
| FT-USER-09 | A fixed e-mail clashed with the previous run's deleted user (that clash is F-07). | E-mail unique per run. |
| FT-MD-14 | The new active site `qa-ft-site2` blocked switching its company off. | Both fixture sites switched off first, then restored. |

## Observations (no finding raised)
- **QA seed:** company `prc-general-ho-jakarta` is switched off while its sites bekasi and qa-other are switched on (a state the API would refuse), so `/admin/sites` and the Site modules page leave out Bekasi; the suite grants Bekasi directly in the database.
- **Fill level differs by design:** Tank & Stock shows 29.4% against all capacity; Stock Overview 29.7% against the capacity of tanks with a reading (footnote explains).
- **Unknown `/api` paths** return Express's HTML 404 page, not JSON.
- **Error text leaks outside production** in 500 responses.
- **Daily rounds error placement:** shown at the top of the Tank gauging page, not next to Save.
- **`/admin` page:** a user with no admin rights can open it and sees an empty menu.
- **Stock Overview tiles** count up from 0 t and can briefly show 0 in a background tab.
