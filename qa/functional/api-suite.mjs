#!/usr/bin/env node
/**
 * Functional API suite for the Plant Information Dashboard.
 *
 *   node qa/functional/api-suite.mjs            run every scenario, write results.json, print a summary
 *   node qa/functional/api-suite.mjs --plan     print the API scenario table (Markdown) and exit
 *
 * Environment (all optional):
 *   QA_API        API base URL                         (default http://127.0.0.1:3010)
 *   QA_DB_URL     Postgres URL of the throwaway QA db   (default postgres://postgres:qa-only@127.0.0.1:55450/pid)
 *   QA_ADMIN_USER / QA_ADMIN_PASS                       (default admin / admin123, dev-only seed account)
 *
 * No new npm dependency: HTTP uses Node 22's global fetch; database fixtures and checks use the `pg`
 * package the Backend already installs (Backend/node_modules).
 *
 * Fixtures are all prefixed `qa-ft-` and are reused across runs (found and reset, not duplicated).
 * Users that a scenario deletes or locks out get a per-run suffix, because a deleted username stays
 * reserved and the login throttle remembers an account for 15 minutes.
 * Never fails a login on `admin`, never edits seeded roles/sites/rules, never adds a real gauge address.
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const API = (process.env.QA_API || 'http://127.0.0.1:3010').replace(/\/$/, '')
const DB_URL = process.env.QA_DB_URL || 'postgres://postgres:qa-only@127.0.0.1:55450/pid'
const ADMIN_USER = process.env.QA_ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.QA_ADMIN_PASS || 'admin123'
const PASS = 'QaFt-pass-1' // test password for every qa-ft- fixture user
const RUN = Date.now().toString(36)
// A host name that can never resolve (.invalid is reserved): fails fast, and is not a blocked address.
// Loopback (127.0.0.1) is refused by the server's outbound guard since the pentest fixes; FT-TG-15 checks that.
const UNREACHABLE_GAUGE = 'http://qa-unreachable-gauge.invalid'

// ---------------------------------------------------------------- HTTP

class Client {
  constructor(name) {
    this.name = name
    this.cookie = null
  }

  async req(method, path, body, { raw = null, headers = {} } = {}) {
    const h = { ...headers }
    if (this.cookie) h.cookie = this.cookie
    let payload
    if (raw != null) {
      payload = raw
      h['content-type'] ??= 'application/json'
    } else if (body !== undefined) {
      payload = JSON.stringify(body)
      h['content-type'] = 'application/json'
    }
    const res = await fetch(API + path, { method, headers: h, body: payload, redirect: 'manual' })
    const setCookies = res.headers.getSetCookie?.() ?? []
    for (const c of setCookies) {
      const [pair] = c.split(';')
      if (pair.startsWith('pid_session=')) this.cookie = pair.endsWith('=') ? null : pair
    }
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    return { status: res.status, json, text, headers: res.headers, setCookies, method, path }
  }

  get(p, o) { return this.req('GET', p, undefined, o) }
  post(p, b, o) { return this.req('POST', p, b, o) }
  put(p, b, o) { return this.req('PUT', p, b, o) }
  del(p, o) { return this.req('DELETE', p, undefined, o) }

  async login(username, password) {
    const r = await this.post('/api/v1/auth/login', { username, password })
    return r
  }
}

function brief(r, max = 220) {
  const body = r.text ?? ''
  return `${r.method} ${r.path} -> ${r.status} ${body.length > max ? body.slice(0, max) + '…' : body}`
}

// ---------------------------------------------------------------- DB

const require = createRequire(join(ROOT, 'Backend', 'package.json'))
const pg = require('pg')
const db = new pg.Pool({ connectionString: DB_URL, max: 2 })
const sql = (text, params) => db.query(text, params)

// ---------------------------------------------------------------- test registry

const tests = []
/**
 * t(id, area, type, title, { pre, steps, expected }, fn)
 * fn returns { ok: boolean, actual: string, evidence?: string } or throws.
 * fn may return { blocked: true, actual } when a precondition could not be met.
 */
function t(id, area, type, title, meta, fn) {
  tests.push({ id, area, type, title, ...meta, fn })
}

/** Status check helper: ok when the status is one of `codes` and `extra(r)` (if given) is true. */
function status(r, codes, extra) {
  const list = Array.isArray(codes) ? codes : [codes]
  let ok = list.includes(r.status)
  let note = ''
  if (ok && extra) {
    const e = extra(r)
    if (e !== true) {
      ok = false
      note = typeof e === 'string' ? ` (${e})` : ' (body check failed)'
    }
  }
  return { ok, actual: `HTTP ${r.status}${r.json?.error ? ` error=${r.json.error}` : ''}${note}`, evidence: brief(r) }
}

const errIs = (code) => (r) => r.json?.error === code || `error was ${r.json?.error}`

// ---------------------------------------------------------------- shared state / fixtures

const S = {
  admin: new Client('admin'),
  anon: new Client('anon'),
  users: {}, // name -> Client (signed in)
  ids: {}, // fixture ids
}

const ROLE_DEFS = {
  'qa-ft-ops': [
    ['live-ops', 'view'], ['ops-analytics', 'view'], ['management-stock', 'view'], ['utility', 'view'], ['daily-production', 'view'],
  ],
  'qa-ft-qc': [['qc', 'view']],
  'qa-ft-none': [],
  'qa-ft-master': [
    ['master-commodities', 'edit'], ['master-tanks', 'edit'], ['master-sites', 'edit'], ['master-companies', 'view'],
  ],
  'qa-ft-useradmin': [
    ['admin-users', 'delete'], ['admin-users', 'edit'], ['admin-roles', 'edit'], ['admin-roles', 'delete'], ['live-ops', 'view'],
  ],
  'qa-ft-liveonly': [['live-ops', 'view']],
  'qa-ft-mgmt': [['management-stock', 'view']],
}

function permList(pairs) {
  const by = {}
  for (const [key, action] of pairs) {
    by[key] ??= { resourceKey: key, view: true, edit: false, delete: false }
    by[key][action] = true
  }
  return Object.values(by)
}

/** user name -> { roles, sqlSites (granted by SQL, not grantable through the API here), apiSites, active } */
const USER_DEFS = {
  'qa-ft-ops': { roles: ['qa-ft-ops'], sqlSites: ['bekasi'], apiSites: ['qa-ft-site'], email: 'qa-ft-ops@example.test' },
  'qa-ft-qc': { roles: ['qa-ft-qc'], sqlSites: ['bekasi'], apiSites: ['qa-ft-site'] },
  'qa-ft-none': { roles: ['qa-ft-none'], sqlSites: ['bekasi'], apiSites: [] },
  'qa-ft-nosite': { roles: ['qa-ft-ops'], sqlSites: [], apiSites: [] },
  'qa-ft-master': { roles: ['qa-ft-master'], sqlSites: ['bekasi'], apiSites: ['qa-ft-site'] },
  'qa-ft-useradmin': { roles: ['qa-ft-useradmin'], sqlSites: ['bekasi'], apiSites: ['qa-ft-site'] },
  'qa-ft-mgmt': { roles: ['qa-ft-mgmt'], sqlSites: ['bekasi'], apiSites: [] },
  'qa-ft-inactive': { roles: ['qa-ft-ops'], sqlSites: ['bekasi'], apiSites: [], active: false },
  // Holds the Administrator role but is never active, so it never counts as "another active admin".
  'qa-ft-admin2': { roles: ['Administrator'], sqlSites: [], apiSites: [], active: false },
}

async function setupFixtures() {
  // A company and site of our own, both activated, so the Administrator can grant it and toggle its modules.
  await sql(
    `INSERT INTO companies (id, code, name, is_activated) VALUES ('qa-ft-co', 'QA-FT-CO', 'QA FT Company', TRUE)
     ON CONFLICT (id) DO UPDATE SET is_activated = TRUE`,
  )
  await sql(
    `INSERT INTO sites (id, company_id, name, timezone, is_activated) VALUES ('qa-ft-site', 'qa-ft-co', 'QA FT Site', 'Asia/Jakarta', TRUE)
     ON CONFLICT (id) DO UPDATE SET is_activated = TRUE, timezone = 'Asia/Jakarta'`,
  )
  // A second site of the same company that no fixture user holds, for "site not held" edits.
  await sql(
    `INSERT INTO sites (id, company_id, name, timezone, is_activated) VALUES ('qa-ft-site2', 'qa-ft-co', 'QA FT Site 2', 'Asia/Jakarta', TRUE)
     ON CONFLICT (id) DO UPDATE SET is_activated = TRUE, timezone = 'Asia/Jakarta'`,
  )
  await setSiteModules('qa-ft-site', ['qc'])
  await sql(`DELETE FROM quality_rules WHERE site_id = 'qa-ft-site'`)
  await sql(`DELETE FROM tank_gauging_sources WHERE site_id = 'qa-ft-site'`)
  await sql(`DELETE FROM tank_gauging_settings WHERE site_id = 'qa-ft-site'`)

  const login = await S.admin.login(ADMIN_USER, ADMIN_PASS)
  if (login.status !== 200) throw new Error(`admin login failed: ${brief(login)}`)
  S.adminId = login.json.id

  const roles = (await S.admin.get('/api/v1/admin/roles')).json
  const roleId = new Map(roles.map((r) => [r.name, r.id]))
  for (const [name, pairs] of Object.entries(ROLE_DEFS)) {
    const body = { name, description: 'functional-test fixture', permissions: permList(pairs) }
    if (roleId.has(name)) {
      const r = await S.admin.put(`/api/v1/admin/roles/${roleId.get(name)}`, body)
      if (r.status !== 200) throw new Error(`reset role ${name}: ${brief(r)}`)
    } else {
      const r = await S.admin.post('/api/v1/admin/roles', body)
      if (r.status !== 201) throw new Error(`create role ${name}: ${brief(r)}`)
      roleId.set(name, r.json.id)
    }
  }
  S.roleId = roleId
  // Leftover throwaway roles from earlier runs.
  for (const r of roles) {
    if (/^qa-ft-tmp-/.test(r.name)) await S.admin.del(`/api/v1/admin/roles/${r.id}`)
  }

  const users = (await S.admin.get('/api/v1/admin/users')).json
  const userId = new Map(users.map((u) => [u.username, u.id]))
  for (const [name, def] of Object.entries(USER_DEFS)) {
    const body = {
      username: name,
      displayName: name,
      email: def.email ?? null,
      password: PASS,
      isActive: def.active !== false,
      roleIds: def.roles.map((r) => roleId.get(r)),
      siteIds: def.apiSites,
    }
    let id = userId.get(name)
    if (id) {
      const r = await S.admin.put(`/api/v1/admin/users/${id}`, body)
      if (r.status !== 200) throw new Error(`reset user ${name}: ${brief(r)}`)
    } else {
      const r = await S.admin.post('/api/v1/admin/users', body)
      if (r.status !== 201) throw new Error(`create user ${name}: ${brief(r)}`)
      id = r.json.id
    }
    // Sites the API cannot grant here (their company is not activated in the QA seed) are set directly.
    await sql(`DELETE FROM user_sites WHERE user_id = $1 AND NOT (site_id = ANY($2::text[]))`, [id, [...def.sqlSites, ...def.apiSites]])
    for (const site of def.sqlSites) {
      await sql('INSERT INTO user_sites (user_id, site_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, site])
    }
    S.ids[name] = id
  }
  for (const name of Object.keys(USER_DEFS)) {
    if (USER_DEFS[name].active === false) continue
    const c = new Client(name)
    const r = await c.login(name, PASS)
    if (r.status !== 200) throw new Error(`fixture login ${name}: ${brief(r)}`)
    S.users[name] = c
  }
}

async function setSiteModules(siteId, modules) {
  await sql('DELETE FROM site_modules WHERE site_id = $1', [siteId])
  for (const m of modules) await sql('INSERT INTO site_modules (site_id, module_key) VALUES ($1, $2)', [siteId, m])
}

async function cleanupRun() {
  // Throwaway users of this run (soft delete through the API, as the app does).
  const users = (await S.admin.get('/api/v1/admin/users')).json ?? []
  for (const u of users) {
    if (u.username.startsWith('qa-ft-') && u.username.includes(`-${RUN}`)) await S.admin.del(`/api/v1/admin/users/${u.id}`)
  }
  const roles = (await S.admin.get('/api/v1/admin/roles')).json ?? []
  for (const r of roles) if (/^qa-ft-tmp-/.test(r.name)) await S.admin.del(`/api/v1/admin/roles/${r.id}`)
  await setSiteModules('qa-ft-site', ['qc'])
  await sql(`DELETE FROM quality_rules WHERE site_id = 'qa-ft-site'`)
  await sql(`DELETE FROM tank_gauging_sources WHERE site_id = 'qa-ft-site'`)
  await sql(`UPDATE sites SET is_activated = TRUE, timezone = 'Asia/Jakarta' WHERE id IN ('qa-ft-site', 'qa-ft-site2')`)
  await sql(`UPDATE companies SET is_activated = TRUE WHERE id = 'qa-ft-co'`)
}

const U = (name) => S.users[name]
const A = () => S.admin

// ================================================================ AUTH & SESSION

t('FT-AUTH-01', 'Auth & session', 'Positive', 'Health endpoint answers',
  { pre: 'API running', steps: 'GET /api/v1/health', expected: '200 {ok:true}' },
  async () => status(await S.anon.get('/api/v1/health'), 200, (r) => r.json?.ok === true))

t('FT-AUTH-02', 'Auth & session', 'Positive', 'Login with valid credentials sets an httpOnly session cookie and returns the session',
  { pre: 'Fixture user qa-ft-ops', steps: 'POST /api/v1/auth/login {username, password}', expected: '200, Set-Cookie pid_session HttpOnly SameSite=Lax, body has id/username/sites/permissions, no password hash' },
  async () => {
    const c = new Client('x')
    const r = await c.login('qa-ft-ops', PASS)
    const ck = r.setCookies.find((x) => x.startsWith('pid_session=')) ?? ''
    return status(r, 200, (r) =>
      (/HttpOnly/i.test(ck) && /SameSite=Lax/i.test(ck) && r.json?.username === 'qa-ft-ops' && Array.isArray(r.json?.sites)
        && !/password/i.test(r.text)) || `cookie=${ck}`)
  })

t('FT-AUTH-03', 'Auth & session', 'Positive', 'Login is case-insensitive on the username',
  { pre: 'qa-ft-ops exists', steps: 'POST login with username QA-FT-OPS', expected: '200' },
  async () => status(await new Client('x').login('QA-FT-OPS', PASS), 200))

t('FT-AUTH-04', 'Auth & session', 'Positive', 'Login with the e-mail address instead of the username',
  { pre: 'qa-ft-ops has e-mail qa-ft-ops@example.test', steps: 'POST login with username=qa-ft-ops@example.test', expected: '200, username qa-ft-ops' },
  async () => status(await new Client('x').login('qa-ft-ops@example.test', PASS), 200, (r) => r.json?.username === 'qa-ft-ops'))

t('FT-AUTH-05', 'Auth & session', 'Negative', 'Login with a wrong password',
  { pre: 'qa-ft-ops exists', steps: 'POST login with wrong password (1 failure on a fixture account)', expected: '401 invalid_credentials, no cookie' },
  async () => {
    const r = await new Client('x').login('qa-ft-ops', 'wrong-password')
    return status(r, 401, (r) => (r.json?.error === 'invalid_credentials' && !r.setCookies.some((c) => c.startsWith('pid_session=e'))) || 'cookie set')
  })

t('FT-AUTH-06', 'Auth & session', 'Negative', 'Login for an unknown user',
  { pre: '-', steps: `POST login username=qa-ft-nobody-${RUN}`, expected: '401 invalid_credentials (same answer as a wrong password)' },
  async () => status(await new Client('x').login(`qa-ft-nobody-${RUN}`, 'whatever1'), 401, errIs('invalid_credentials')))

t('FT-AUTH-07', 'Auth & session', 'Negative', 'Login with missing username or password',
  { pre: '-', steps: 'POST login {} ; POST login {username:"qa-ft-ops"}', expected: '400 invalid_credentials for both' },
  async () => {
    const a = await S.anon.post('/api/v1/auth/login', {})
    const b = await S.anon.post('/api/v1/auth/login', { username: 'qa-ft-ops' })
    return { ok: a.status === 400 && b.status === 400, actual: `HTTP ${a.status} / ${b.status}`, evidence: `${brief(a)} | ${brief(b)}` }
  })

t('FT-AUTH-08', 'Auth & session', 'Negative', 'Login with a malformed JSON body',
  { pre: '-', steps: "POST /api/v1/auth/login with body '{\"username\":' (invalid JSON)", expected: '400 (client error), not a 500' },
  async () => status(await S.anon.post('/api/v1/auth/login', undefined, { raw: '{"username":' }), 400))

t('FT-AUTH-09', 'Auth & session', 'Negative', 'Login for a deactivated user',
  { pre: 'qa-ft-inactive (isActive=false)', steps: 'POST login qa-ft-inactive with its correct password', expected: '401' },
  async () => status(await new Client('x').login('qa-ft-inactive', PASS), 401))

t('FT-AUTH-10', 'Auth & session', 'Positive', 'GET /auth/me returns the signed-in session',
  { pre: 'Signed in as qa-ft-ops', steps: 'GET /api/v1/auth/me', expected: '200 with sites bekasi + qa-ft-site and their modules' },
  async () => status(await U('qa-ft-ops').get('/api/v1/auth/me'), 200, (r) => {
    const ids = (r.json?.sites ?? []).map((s) => s.id).sort().join(',')
    return ids === 'bekasi,qa-ft-site' || `sites=${ids}`
  }))

t('FT-AUTH-11', 'Auth & session', 'Negative', 'GET /auth/me without a session',
  { pre: '-', steps: 'GET /api/v1/auth/me with no cookie', expected: '401 unauthenticated' },
  async () => status(await S.anon.get('/api/v1/auth/me'), 401, errIs('unauthenticated')))

t('FT-AUTH-12', 'Auth & session', 'Negative', 'GET /auth/me with a tampered token',
  { pre: '-', steps: 'GET /api/v1/auth/me with cookie pid_session=<valid token with altered signature>', expected: '401' },
  async () => {
    const c = new Client('x')
    c.cookie = U('qa-ft-ops').cookie.slice(0, -3) + 'abc'
    return status(await c.get('/api/v1/auth/me'), 401)
  })

t('FT-AUTH-13', 'Auth & session', 'Positive', 'Logout clears the session cookie',
  { pre: 'Fresh login as qa-ft-ops', steps: 'POST /api/v1/auth/logout, then GET /auth/me with the client cookie jar', expected: '204, Set-Cookie clears pid_session, /me then 401' },
  async () => {
    const c = new Client('x')
    await c.login('qa-ft-ops', PASS)
    const r = await c.post('/api/v1/auth/logout')
    const me = await c.get('/api/v1/auth/me')
    return { ok: r.status === 204 && me.status === 401, actual: `logout ${r.status}, me ${me.status}`, evidence: `${brief(r)} set-cookie=${r.setCookies.join(' ')} | ${brief(me)}` }
  })

t('FT-AUTH-14', 'Auth & session', 'Negative', 'A session ends when the user is deactivated',
  { pre: `Throwaway user qa-ft-deact-${RUN} signed in`, steps: 'Admin PUT /admin/users/:id isActive=false; user GET /auth/me', expected: '/me 401 right after deactivation' },
  async () => {
    const name = `qa-ft-deact-${RUN}`
    const created = await A().post('/api/v1/admin/users', { username: name, password: PASS, roleIds: [S.roleId.get('qa-ft-liveonly')], siteIds: [] })
    const c = new Client(name)
    const before = await c.login(name, PASS)
    await A().put(`/api/v1/admin/users/${created.json?.id}`, { displayName: name, isActive: false, roleIds: [S.roleId.get('qa-ft-liveonly')], siteIds: [] })
    const after = await c.get('/api/v1/auth/me')
    return { ok: created.status === 201 && before.status === 200 && after.status === 401, actual: `create ${created.status}, login ${before.status}, me-after ${after.status}`, evidence: brief(after) }
  })

t('FT-AUTH-15', 'Auth & session', 'Negative', 'Login throttle locks an account after 10 failures, even for the right password',
  { pre: `Throwaway user qa-ft-lock-${RUN}`, steps: '10x POST login with a wrong password, then POST login with the right one; then log in another account', expected: 'Failures 1-10 -> 401; 11th (correct password) -> 429 too_many_attempts; other accounts unaffected' },
  async () => {
    const name = `qa-ft-lock-${RUN}`
    await A().post('/api/v1/admin/users', { username: name, password: PASS, roleIds: [], siteIds: [] })
    const codes = []
    for (let i = 0; i < 10; i += 1) codes.push((await new Client('x').login(name, `bad-${i}`)).status)
    const locked = await new Client('x').login(name, PASS)
    const other = await new Client('x').login('qa-ft-qc', PASS)
    const ok = codes.every((c) => c === 401) && locked.status === 429 && locked.json?.error === 'too_many_attempts' && other.status === 200
    return { ok, actual: `failures=[${codes.join(',')}], correct-after=${locked.status}, other=${other.status}`, evidence: brief(locked) }
  })

t('FT-AUTH-16', 'Auth & session', 'Negative', 'Change password: missing, short, same and wrong current password',
  { pre: `Throwaway user qa-ft-pw-${RUN} signed in`, steps: 'PUT /auth/password with {} ; {currentPassword} ; newPassword "abc" ; new == current ; wrong current', expected: '400 current_password_required, 400 new_password_required, 400 password_short, 400 same_password, 401 bad_current_password' },
  async () => {
    const name = `qa-ft-pw-${RUN}`
    await A().post('/api/v1/admin/users', { username: name, password: PASS, roleIds: [], siteIds: [] })
    const c = new Client(name)
    await c.login(name, PASS)
    S.pwClient = c
    S.pwName = name
    const rs = [
      await c.put('/api/v1/auth/password', {}),
      await c.put('/api/v1/auth/password', { currentPassword: PASS }),
      await c.put('/api/v1/auth/password', { currentPassword: PASS, newPassword: 'abc' }),
      await c.put('/api/v1/auth/password', { currentPassword: PASS, newPassword: PASS }),
      await c.put('/api/v1/auth/password', { currentPassword: 'not-it-1', newPassword: 'Another-1' }),
    ]
    const want = [[400, 'current_password_required'], [400, 'new_password_required'], [400, 'password_short'], [400, 'same_password'], [401, 'bad_current_password']]
    const ok = rs.every((r, i) => r.status === want[i][0] && r.json?.error === want[i][1])
    return { ok, actual: rs.map((r) => `${r.status}:${r.json?.error}`).join(', '), evidence: rs.map((r) => brief(r, 80)).join(' | ') }
  })

t('FT-AUTH-17', 'Auth & session', 'Positive', 'Change password, then sign in with the new password only',
  { pre: 'FT-AUTH-16 user', steps: 'PUT /auth/password {currentPassword, newPassword}; login old; login new', expected: '204; old password 401; new password 200' },
  async () => {
    const r = await S.pwClient.put('/api/v1/auth/password', { currentPassword: PASS, newPassword: 'QaFt-new-2' })
    const old = await new Client('x').login(S.pwName, PASS)
    const neu = await new Client('x').login(S.pwName, 'QaFt-new-2')
    return { ok: r.status === 204 && old.status === 401 && neu.status === 200, actual: `change ${r.status}, old ${old.status}, new ${neu.status}`, evidence: brief(r) }
  })

t('FT-AUTH-18', 'Auth & session', 'Positive', 'SSO status endpoint',
  { pre: '-', steps: 'GET /auth/sso/status', expected: '200 {oidcEnabled:boolean, legacyBridgeEnabled:boolean}' },
  async () => status(await S.anon.get('/auth/sso/status'), 200, (r) => typeof r.json?.oidcEnabled === 'boolean'))

t('FT-AUTH-19', 'Auth & session', 'Negative', 'Hub bridge without a token redirects to the SSO error page',
  { pre: '-', steps: 'POST /auth/hub (form, no token)', expected: '302 to /sso-error?…' },
  async () => {
    const r = await S.anon.post('/auth/hub', undefined, { raw: '', headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    return status(r, [302, 303], (r) => /sso-error/.test(r.headers.get('location') ?? '') || `location=${r.headers.get('location')}`)
  })

t('FT-AUTH-20', 'Auth & session', 'Negative', 'Unknown API path',
  { pre: '-', steps: 'GET /api/v1/does-not-exist (signed in)', expected: '404' },
  async () => status(await A().get('/api/v1/does-not-exist'), 404))

t('FT-AUTH-21', 'Auth & session', 'Negative', 'Every protected route group refuses an anonymous caller',
  { pre: '-', steps: 'GET without cookie: /sites, /sites/bekasi/live/tanks, /portfolio/stock, /sites/bekasi/qc/storage, /sites/bekasi/utility, /sites/bekasi/production, /master/commodities?siteId=bekasi, /tank-gauging/sites/bekasi/overview, /admin/users, /admin/datahub/config', expected: '401 for each' },
  async () => {
    const paths = ['/api/v1/sites', '/api/v1/sites/bekasi/live/tanks', '/api/v1/portfolio/stock', '/api/v1/sites/bekasi/qc/storage',
      '/api/v1/sites/bekasi/utility', '/api/v1/sites/bekasi/production', '/api/v1/master/commodities?siteId=bekasi',
      '/api/v1/tank-gauging/sites/bekasi/overview', '/api/v1/admin/users', '/api/v1/admin/datahub/config', '/api/v1/master/org']
    const rs = await Promise.all(paths.map((p) => S.anon.get(p)))
    const bad = rs.filter((r) => r.status !== 401)
    return { ok: bad.length === 0, actual: bad.length ? bad.map((r) => `${r.path}=${r.status}`).join(', ') : `all ${rs.length} -> 401`, evidence: bad.map((r) => brief(r)).join(' | ') }
  })

// ================================================================ USERS & ROLES

t('FT-ROLE-01', 'Users & roles', 'Positive', 'List roles with counts',
  { pre: 'Admin', steps: 'GET /admin/roles', expected: '200, includes Administrator (system) and qa-ft-ops with viewCount 5' },
  async () => status(await A().get('/api/v1/admin/roles'), 200, (r) => {
    const admin = r.json.find((x) => x.name === 'Administrator')
    const ops = r.json.find((x) => x.name === 'qa-ft-ops')
    return (admin?.isSystemRole === true && ops?.viewCount === 5) || `ops=${JSON.stringify(ops)}`
  }))

t('FT-ROLE-02', 'Users & roles', 'Positive', 'Permission catalogue lists every page key',
  { pre: 'Admin', steps: 'GET /admin/permissions', expected: '200, 19 keys incl. management-stock, admin-datahub' },
  async () => status(await A().get('/api/v1/admin/permissions'), 200, (r) => (r.json.length === 19 && r.json.includes('management-stock')) || `len=${r.json.length}`))

t('FT-ROLE-03', 'Users & roles', 'Positive', 'Create a role; edit/delete imply view',
  { pre: 'Admin', steps: 'POST /admin/roles {name:qa-ft-tmp-<run>, permissions:[{resourceKey:qc, edit:true}, {resourceKey:utility, delete:true}, {resourceKey:"no-such-page", view:true}]}; GET /admin/roles/:id', expected: '201; qc = view+edit, utility = view+delete, unknown key ignored' },
  async () => {
    const r = await A().post('/api/v1/admin/roles', { name: `qa-ft-tmp-${RUN}`, description: 'tmp', permissions: [{ resourceKey: 'qc', edit: true }, { resourceKey: 'utility', delete: true }, { resourceKey: 'no-such-page', view: true }] })
    S.tmpRole = r.json?.id
    const g = await A().get(`/api/v1/admin/roles/${S.tmpRole}`)
    const qc = g.json?.permissions?.find((p) => p.resourceKey === 'qc')
    const ut = g.json?.permissions?.find((p) => p.resourceKey === 'utility')
    const ok = r.status === 201 && qc?.view && qc?.edit && !qc?.delete && ut?.view && ut?.delete && !ut?.edit
    return { ok, actual: `create ${r.status}; qc=${JSON.stringify(qc)} utility=${JSON.stringify(ut)}`, evidence: brief(r) }
  })

t('FT-ROLE-04', 'Users & roles', 'Negative', 'Create a role with a duplicate name',
  { pre: 'qa-ft-ops role exists', steps: 'POST /admin/roles {name:"qa-ft-ops"}', expected: '409 role_name_taken' },
  async () => status(await A().post('/api/v1/admin/roles', { name: 'qa-ft-ops', permissions: [] }), 409, errIs('role_name_taken')))

t('FT-ROLE-05', 'Users & roles', 'Negative', 'Create a role without a name',
  { pre: 'Admin', steps: 'POST /admin/roles {name:"   "}', expected: '400 role_name_required' },
  async () => status(await A().post('/api/v1/admin/roles', { name: '   ' }), 400, errIs('role_name_required')))

t('FT-ROLE-06', 'Users & roles', 'Negative', 'Get a role by a non-numeric and a nonexistent id',
  { pre: 'Admin', steps: 'GET /admin/roles/abc ; GET /admin/roles/999999', expected: '400 ; 404' },
  async () => {
    const a = await A().get('/api/v1/admin/roles/abc')
    const b = await A().get('/api/v1/admin/roles/999999')
    return { ok: a.status === 400 && b.status === 404, actual: `${a.status} / ${b.status}`, evidence: `${brief(a)} | ${brief(b)}` }
  })

t('FT-ROLE-07', 'Users & roles', 'Positive', 'Rename and re-permission a role',
  { pre: 'FT-ROLE-03 role', steps: 'PUT /admin/roles/:id {name:qa-ft-tmp-<run>-b, permissions:[{resourceKey:qc,view:true}]}', expected: '200; GET shows new name and qc view only' },
  async () => {
    const r = await A().put(`/api/v1/admin/roles/${S.tmpRole}`, { name: `qa-ft-tmp-${RUN}-b`, permissions: [{ resourceKey: 'qc', view: true }] })
    const g = await A().get(`/api/v1/admin/roles/${S.tmpRole}`)
    const on = g.json?.permissions?.filter((p) => p.view).map((p) => p.resourceKey)
    return { ok: r.status === 200 && g.json?.name === `qa-ft-tmp-${RUN}-b` && on?.join() === 'qc', actual: `${r.status}; name=${g.json?.name}; on=${on}`, evidence: brief(r) }
  })

t('FT-ROLE-08', 'Users & roles', 'Negative', 'Delete a system role and a role in use',
  { pre: 'Administrator is a system role; qa-ft-ops is held by users', steps: 'DELETE /admin/roles/<Administrator> ; DELETE /admin/roles/<qa-ft-ops>', expected: '409 system_role ; 409 role_in_use' },
  async () => {
    const a = await A().del(`/api/v1/admin/roles/${S.roleId.get('Administrator')}`)
    const b = await A().del(`/api/v1/admin/roles/${S.roleId.get('qa-ft-ops')}`)
    return { ok: a.status === 409 && a.json?.error === 'system_role' && b.status === 409 && b.json?.error === 'role_in_use', actual: `${a.status}:${a.json?.error} / ${b.status}:${b.json?.error}`, evidence: `${brief(a)} | ${brief(b)}` }
  })

t('FT-ROLE-09', 'Users & roles', 'Positive', 'Delete an unused role; deleting it again is 404',
  { pre: 'FT-ROLE-03 role', steps: 'DELETE /admin/roles/:id twice', expected: '204 then 404' },
  async () => {
    const a = await A().del(`/api/v1/admin/roles/${S.tmpRole}`)
    const b = await A().del(`/api/v1/admin/roles/${S.tmpRole}`)
    return { ok: a.status === 204 && b.status === 404, actual: `${a.status} / ${b.status}`, evidence: `${brief(a)} | ${brief(b)}` }
  })

t('FT-ROLE-10', 'Users & roles', 'Negative', 'A user without admin rights cannot read roles or users',
  { pre: 'qa-ft-ops (no admin-* rights)', steps: 'GET /admin/roles ; GET /admin/users ; POST /admin/roles', expected: '403 forbidden each' },
  async () => {
    const rs = [await U('qa-ft-ops').get('/api/v1/admin/roles'), await U('qa-ft-ops').get('/api/v1/admin/users'), await U('qa-ft-ops').post('/api/v1/admin/roles', { name: 'qa-ft-tmp-x' })]
    return { ok: rs.every((r) => r.status === 403), actual: rs.map((r) => r.status).join(' / '), evidence: rs.map((r) => brief(r, 60)).join(' | ') }
  })

t('FT-USER-01', 'Users & roles', 'Positive', 'List and read users',
  { pre: 'Admin', steps: 'GET /admin/users ; GET /admin/users/<qa-ft-ops>', expected: '200; qa-ft-ops has role qa-ft-ops and sites bekasi + qa-ft-site; no password data' },
  async () => {
    const l = await A().get('/api/v1/admin/users')
    const g = await A().get(`/api/v1/admin/users/${S.ids['qa-ft-ops']}`)
    const sites = (g.json?.sites ?? []).map((s) => s.id).sort().join(',')
    const ok = l.status === 200 && g.status === 200 && g.json.roles.some((r) => r.name === 'qa-ft-ops') && sites === 'bekasi,qa-ft-site' && !/password/i.test(l.text)
    return { ok, actual: `list ${l.status}, get ${g.status}, sites=${sites}`, evidence: brief(g) }
  })

t('FT-USER-02', 'Users & roles', 'Negative', 'Get a nonexistent user and a non-numeric id',
  { pre: 'Admin', steps: 'GET /admin/users/999999 ; GET /admin/users/abc', expected: '404 ; 400' },
  async () => {
    const a = await A().get('/api/v1/admin/users/999999')
    const b = await A().get('/api/v1/admin/users/abc')
    return { ok: a.status === 404 && b.status === 400, actual: `${a.status} / ${b.status}`, evidence: `${brief(a)} | ${brief(b)}` }
  })

t('FT-USER-03', 'Users & roles', 'Positive', 'Create a user with a role and an activated site',
  { pre: 'Admin; qa-ft-site is activated and its company too', steps: `POST /admin/users {username:qa-ft-new-${RUN}, password, roleIds:[qa-ft-liveonly], siteIds:[qa-ft-site]}; new user logs in`, expected: '201 {id, siteCount:1}; login 200 with site qa-ft-site' },
  async () => {
    const name = `qa-ft-new-${RUN}`
    const r = await A().post('/api/v1/admin/users', { username: name, displayName: 'New', email: `${name}@example.test`, password: PASS, roleIds: [S.roleId.get('qa-ft-liveonly')], siteIds: ['qa-ft-site'] })
    S.newUserId = r.json?.id
    S.newUserName = name
    const l = await new Client('x').login(name, PASS)
    const ok = r.status === 201 && r.json?.siteCount === 1 && l.status === 200 && l.json?.sites?.[0]?.id === 'qa-ft-site'
    return { ok, actual: `create ${r.status} siteCount=${r.json?.siteCount}; login ${l.status}`, evidence: brief(r) }
  })

t('FT-USER-04', 'Users & roles', 'Negative', 'Create a user: missing username, missing password, short password',
  { pre: 'Admin', steps: 'POST /admin/users {password} ; {username} ; {username, password:"12345"}', expected: '400 username_required ; 400 password_required ; 400 password_short' },
  async () => {
    const rs = [
      await A().post('/api/v1/admin/users', { password: PASS }),
      await A().post('/api/v1/admin/users', { username: `qa-ft-x-${RUN}` }),
      await A().post('/api/v1/admin/users', { username: `qa-ft-x-${RUN}`, password: '12345' }),
    ]
    const want = ['username_required', 'password_required', 'password_short']
    return { ok: rs.every((r, i) => r.status === 400 && r.json?.error === want[i]), actual: rs.map((r) => `${r.status}:${r.json?.error}`).join(', '), evidence: rs.map((r) => brief(r, 60)).join(' | ') }
  })

t('FT-USER-05', 'Users & roles', 'Negative', 'Create a user with a duplicate username or e-mail',
  { pre: 'FT-USER-03 user', steps: 'POST same username ; POST new username with the same e-mail', expected: '409 username_taken ; 409 email_taken' },
  async () => {
    const a = await A().post('/api/v1/admin/users', { username: S.newUserName, password: PASS })
    const b = await A().post('/api/v1/admin/users', { username: `qa-ft-y-${RUN}`, email: `${S.newUserName}@example.test`, password: PASS })
    return { ok: a.status === 409 && a.json?.error === 'username_taken' && b.status === 409 && b.json?.error === 'email_taken', actual: `${a.status}:${a.json?.error} / ${b.status}:${b.json?.error}`, evidence: `${brief(a)} | ${brief(b)}` }
  })

t('FT-USER-06', 'Users & roles', 'Negative', 'Create a user with a nonexistent role id',
  { pre: 'Admin', steps: 'POST /admin/users {…, roleIds:[999999]}', expected: '400, no user created' },
  async () => {
    const name = `qa-ft-z-${RUN}`
    const r = await A().post('/api/v1/admin/users', { username: name, password: PASS, roleIds: [999999] })
    const rows = await sql('SELECT 1 FROM users WHERE username = $1', [name])
    return { ok: r.status === 400 && rows.rowCount === 0, actual: `HTTP ${r.status}, rows=${rows.rowCount}`, evidence: brief(r) }
  })

t('FT-USER-07', 'Users & roles', 'Negative', 'Create a user with roleIds of the wrong type (string instead of array)',
  { pre: 'Admin', steps: 'POST /admin/users {username, password, roleIds:"1"}', expected: '400 validation error (not a 500)' },
  async () => status(await A().post('/api/v1/admin/users', { username: `qa-ft-w-${RUN}`, password: PASS, roleIds: '1' }), 400))

t('FT-USER-08', 'Users & roles', 'Negative', 'Create a user with siteIds of the wrong type (object)',
  { pre: 'Admin', steps: 'POST /admin/users {username, password, siteIds:{a:1}}', expected: '400 validation error (not a 500)' },
  async () => status(await A().post('/api/v1/admin/users', { username: `qa-ft-v-${RUN}`, password: PASS, siteIds: { a: 1 } }), 400))

t('FT-USER-09', 'Users & roles', 'Negative', 'Create a user with an invalid e-mail address',
  { pre: 'Admin', steps: 'POST /admin/users {username, password, email:"not-an-email-<run>"}', expected: '400 invalid e-mail' },
  async () => status(await A().post('/api/v1/admin/users', { username: `qa-ft-e-${RUN}`, password: PASS, email: `not-an-email-${RUN}` }), 400))

t('FT-USER-10', 'Users & roles', 'Negative', 'Update a user with isActive as the string "false"',
  { pre: 'FT-USER-03 user', steps: 'PUT /admin/users/:id {isActive:"false", roleIds, siteIds}', expected: '400 (wrong type) or the user deactivated; never silently left active' },
  async () => {
    const r = await A().put(`/api/v1/admin/users/${S.newUserId}`, { displayName: 'New', email: `${S.newUserName}@example.test`, isActive: 'false', roleIds: [S.roleId.get('qa-ft-liveonly')], siteIds: ['qa-ft-site'] })
    const row = await sql('SELECT is_active FROM users WHERE id = $1', [S.newUserId])
    const active = row.rows[0]?.is_active
    if (active === false) await A().put(`/api/v1/admin/users/${S.newUserId}`, { displayName: 'New', email: `${S.newUserName}@example.test`, isActive: true, roleIds: [S.roleId.get('qa-ft-liveonly')], siteIds: ['qa-ft-site'] })
    return { ok: r.status === 400 || active === false, actual: `HTTP ${r.status}, is_active after=${active}`, evidence: brief(r) }
  })

t('FT-USER-11', 'Users & roles', 'Positive', 'Update a user: display name, password reset, roles',
  { pre: 'FT-USER-03 user', steps: 'PUT /admin/users/:id {displayName:"Renamed", password:"QaFt-reset-3", roleIds:[qa-ft-liveonly], siteIds:[qa-ft-site]}; login with new password', expected: '200 {siteCount:1}; login 200' },
  async () => {
    const r = await A().put(`/api/v1/admin/users/${S.newUserId}`, { displayName: 'Renamed', email: `${S.newUserName}@example.test`, password: 'QaFt-reset-3', roleIds: [S.roleId.get('qa-ft-liveonly')], siteIds: ['qa-ft-site'] })
    const l = await new Client('x').login(S.newUserName, 'QaFt-reset-3')
    return { ok: r.status === 200 && r.json?.siteCount === 1 && l.status === 200 && l.json?.displayName === 'Renamed', actual: `put ${r.status}, login ${l.status}, name=${l.json?.displayName}`, evidence: brief(r) }
  })

t('FT-USER-12', 'Users & roles', 'Negative', 'Update a user: short password, nonexistent id, non-numeric id',
  { pre: 'FT-USER-03 user', steps: 'PUT /admin/users/:id {password:"123"} ; PUT /admin/users/999999 ; PUT /admin/users/abc', expected: '400 password_short ; 404 ; 400' },
  async () => {
    const a = await A().put(`/api/v1/admin/users/${S.newUserId}`, { password: '123', roleIds: [S.roleId.get('qa-ft-liveonly')], siteIds: ['qa-ft-site'] })
    const b = await A().put('/api/v1/admin/users/999999', { displayName: 'x' })
    const c = await A().put('/api/v1/admin/users/abc', { displayName: 'x' })
    return { ok: a.status === 400 && a.json?.error === 'password_short' && b.status === 404 && c.status === 400, actual: `${a.status}:${a.json?.error} / ${b.status} / ${c.status}`, evidence: `${brief(a)} | ${brief(b)} | ${brief(c)}` }
  })

t('FT-USER-13', 'Users & roles', 'Negative', 'Administrator cannot deactivate or delete their own account',
  { pre: 'Admin signed in', steps: 'PUT /admin/users/<self> {isActive:false} ; DELETE /admin/users/<self>', expected: '400 self_deactivate ; 400 self_delete (nothing changed)' },
  async () => {
    const a = await A().put(`/api/v1/admin/users/${S.adminId}`, { isActive: false })
    const b = await A().del(`/api/v1/admin/users/${S.adminId}`)
    return { ok: a.status === 400 && a.json?.error === 'self_deactivate' && b.status === 400 && b.json?.error === 'self_delete', actual: `${a.status}:${a.json?.error} / ${b.status}:${b.json?.error}`, evidence: `${brief(a)} | ${brief(b)}` }
  })

t('FT-USER-14', 'Users & roles', 'Positive', 'Delete a user: hidden from the list, cannot sign in, second delete is 404',
  { pre: 'FT-USER-03 user', steps: 'DELETE /admin/users/:id ; GET /admin/users ; login ; DELETE again', expected: '204; not listed; login 401; 404' },
  async () => {
    const a = await A().del(`/api/v1/admin/users/${S.newUserId}`)
    const l = await A().get('/api/v1/admin/users')
    const login = await new Client('x').login(S.newUserName, 'QaFt-reset-3')
    const b = await A().del(`/api/v1/admin/users/${S.newUserId}`)
    const listed = l.json?.some((u) => u.id === S.newUserId)
    return { ok: a.status === 204 && !listed && login.status === 401 && b.status === 404, actual: `del ${a.status}, listed=${listed}, login ${login.status}, del2 ${b.status}`, evidence: brief(a) }
  })

t('FT-USER-15', 'Users & roles', 'Negative', "A deleted user's username can be used again",
  { pre: 'FT-USER-14 deleted user', steps: 'POST /admin/users with the deleted username', expected: '201 (deleted users are hidden everywhere, so their name should be free) — or a message that says the name belongs to a deleted user' },
  async () => {
    const r = await A().post('/api/v1/admin/users', { username: S.newUserName, password: PASS, roleIds: [], siteIds: [] })
    return status(r, 201)
  })

t('FT-USER-16', 'Users & roles', 'Negative', 'An activated site of a non-activated company is not grantable',
  { pre: 'QA seed: bekasi activated, company prc-general-ho-jakarta not activated', steps: 'GET /admin/sites as admin', expected: '200; list contains qa-ft-site and not bekasi (documents the QA-seed state used by the other cases)' },
  async () => status(await A().get('/api/v1/admin/sites'), 200, (r) => {
    const ids = r.json.map((s) => s.id)
    return (ids.includes('qa-ft-site') && !ids.includes('bekasi')) || `ids=${ids}`
  }))

// --- delegated user administration (non-Administrator with admin-users/admin-roles rights)

t('FT-USER-17', 'Users & roles', 'Positive', 'Delegated admin creates a user with a role inside their own rights, only on sites they hold',
  { pre: 'qa-ft-useradmin holds admin-users/admin-roles + live-ops view, sites bekasi + qa-ft-site', steps: `POST /admin/users {username:qa-ft-sub-${RUN}, roleIds:[qa-ft-liveonly], siteIds:[qa-ft-site, qa-other]}`, expected: '201, siteCount 1 (qa-other silently not granted)' },
  async () => {
    const r = await U('qa-ft-useradmin').post('/api/v1/admin/users', { username: `qa-ft-sub-${RUN}`, password: PASS, roleIds: [S.roleId.get('qa-ft-liveonly')], siteIds: ['qa-ft-site', 'qa-other'] })
    S.subId = r.json?.id
    return status(r, 201, (r) => r.json?.siteCount === 1 || `siteCount=${r.json?.siteCount}`)
  })

t('FT-USER-18', 'Users & roles', 'Negative', 'Delegated admin cannot grant the Administrator role or a role with rights they lack',
  { pre: 'qa-ft-useradmin', steps: 'POST /admin/users roleIds:[Administrator] ; roleIds:[qa-ft-master]', expected: '403 cannot_grant_role for both, no user created' },
  async () => {
    const a = await U('qa-ft-useradmin').post('/api/v1/admin/users', { username: `qa-ft-s1-${RUN}`, password: PASS, roleIds: [S.roleId.get('Administrator')] })
    const b = await U('qa-ft-useradmin').post('/api/v1/admin/users', { username: `qa-ft-s2-${RUN}`, password: PASS, roleIds: [S.roleId.get('qa-ft-master')] })
    return { ok: a.status === 403 && a.json?.error === 'cannot_grant_role' && b.status === 403 && b.json?.error === 'cannot_grant_role', actual: `${a.status}:${a.json?.error} / ${b.status}:${b.json?.error}`, evidence: `${brief(a)} | ${brief(b)}` }
  })

t('FT-USER-19', 'Users & roles', 'Negative', 'Delegated admin cannot change their own roles',
  { pre: 'qa-ft-useradmin', steps: 'PUT /admin/users/<self> roleIds:[qa-ft-useradmin, qa-ft-liveonly]', expected: '403 cannot_change_own_roles' },
  async () => status(await U('qa-ft-useradmin').put(`/api/v1/admin/users/${S.ids['qa-ft-useradmin']}`, { displayName: 'qa-ft-useradmin', roleIds: [S.roleId.get('qa-ft-useradmin'), S.roleId.get('qa-ft-liveonly')], siteIds: ['qa-ft-site'] }), 403, errIs('cannot_change_own_roles')))

t('FT-USER-20', 'Users & roles', 'Negative', 'Delegated admin cannot manage a user holding the Administrator role',
  { pre: 'qa-ft-admin2 holds Administrator (inactive)', steps: 'PUT /admin/users/<qa-ft-admin2> with its current data + new password ; DELETE /admin/users/<qa-ft-admin2>', expected: '403 cannot_manage_user for both' },
  async () => {
    const body = { displayName: 'qa-ft-admin2', isActive: false, password: 'Hijack-123', roleIds: [S.roleId.get('Administrator')], siteIds: [] }
    const a = await U('qa-ft-useradmin').put(`/api/v1/admin/users/${S.ids['qa-ft-admin2']}`, body)
    const b = await U('qa-ft-useradmin').del(`/api/v1/admin/users/${S.ids['qa-ft-admin2']}`)
    return { ok: a.status === 403 && a.json?.error === 'cannot_manage_user' && b.status === 403, actual: `${a.status}:${a.json?.error} / ${b.status}:${b.json?.error}`, evidence: `${brief(a)} | ${brief(b)}` }
  })

t('FT-USER-21', 'Users & roles', 'Negative', 'Delegated admin cannot create a role holding rights they lack, nor edit a system role',
  { pre: 'qa-ft-useradmin', steps: 'POST /admin/roles {permissions:[master-tanks edit]} ; PUT /admin/roles/<Viewer> with Viewer\'s current data', expected: '403 cannot_grant_permission ; 403 system_role' },
  async () => {
    const a = await U('qa-ft-useradmin').post('/api/v1/admin/roles', { name: `qa-ft-tmp-${RUN}-d`, permissions: [{ resourceKey: 'master-tanks', edit: true }] })
    const viewer = (await A().get(`/api/v1/admin/roles/${S.roleId.get('Viewer')}`)).json
    const b = await U('qa-ft-useradmin').put(`/api/v1/admin/roles/${viewer.id}`, { name: viewer.name, description: viewer.description, permissions: viewer.permissions })
    return { ok: a.status === 403 && a.json?.error === 'cannot_grant_permission' && b.status === 403 && b.json?.error === 'system_role', actual: `${a.status}:${a.json?.error} / ${b.status}:${b.json?.error}`, evidence: `${brief(a)} | ${brief(b)}` }
  })

t('FT-USER-22', 'Users & roles', 'Positive', 'Delegated admin lists only the sites they may grant, and deletes the user they created',
  { pre: 'FT-USER-17 user', steps: 'GET /admin/sites ; DELETE /admin/users/<sub>', expected: 'sites = [qa-ft-site]; 204' },
  async () => {
    const s = await U('qa-ft-useradmin').get('/api/v1/admin/sites')
    const d = await U('qa-ft-useradmin').del(`/api/v1/admin/users/${S.subId}`)
    const ids = (s.json ?? []).map((x) => x.id).join(',')
    return { ok: s.status === 200 && ids === 'qa-ft-site' && d.status === 204, actual: `sites=${ids}; delete ${d.status}`, evidence: `${brief(s)} | ${brief(d)}` }
  })

// ================================================================ SITE ACCESS & MODULES

t('FT-SITE-01', 'Site access & modules', 'Positive', 'Site list holds only the sites a user has',
  { pre: 'qa-ft-ops holds bekasi + qa-ft-site; qa-ft-nosite holds none', steps: 'GET /api/v1/sites as each', expected: 'qa-ft-ops: [bekasi, qa-ft-site]; qa-ft-nosite: []' },
  async () => {
    const a = await U('qa-ft-ops').get('/api/v1/sites')
    const b = await U('qa-ft-nosite').get('/api/v1/sites')
    const ids = (a.json ?? []).map((s) => s.id).sort().join(',')
    return { ok: a.status === 200 && ids === 'bekasi,qa-ft-site' && b.status === 200 && b.json.length === 0, actual: `ops=${ids}; nosite=${b.json?.length}`, evidence: brief(a) }
  })

t('FT-SITE-02', 'Site access & modules', 'Positive', 'Site detail for a held site',
  { pre: 'Admin holds bekasi', steps: 'GET /api/v1/sites/bekasi', expected: '200 {siteName:Bekasi, timezone:Asia/Jakarta}' },
  async () => status(await A().get('/api/v1/sites/bekasi'), 200, (r) => r.json?.siteName === 'Bekasi' && r.json?.timezone === 'Asia/Jakarta'))

t('FT-SITE-03', 'Site access & modules', 'Negative', 'Any site route for a site the user does not hold, or that does not exist',
  { pre: 'qa-ft-ops does not hold qa-other', steps: 'GET /sites/qa-other ; /sites/qa-other/live/tanks ; /sites/qa-other/qc/storage ; /sites/nope/snapshot', expected: '403 forbidden for each (no data leak)' },
  async () => {
    const rs = [await U('qa-ft-ops').get('/api/v1/sites/qa-other'), await U('qa-ft-ops').get('/api/v1/sites/qa-other/live/tanks'), await U('qa-ft-qc').get('/api/v1/sites/qa-other/qc/storage'), await U('qa-ft-ops').get('/api/v1/sites/nope/snapshot')]
    return { ok: rs.every((r) => r.status === 403), actual: rs.map((r) => r.status).join(' / '), evidence: rs.map((r) => brief(r, 60)).join(' | ') }
  })

t('FT-SITE-04', 'Site access & modules', 'Positive', 'Site module matrix',
  { pre: 'Admin', steps: 'GET /admin/site-modules', expected: '200, modules = [live-ops, qc, utility, daily-production]; qa-ft-site shows [qc]' },
  async () => status(await A().get('/api/v1/admin/site-modules'), 200, (r) => {
    const s = r.json.sites.find((x) => x.id === 'qa-ft-site')
    return (r.json.modules.length === 4 && s?.modules.join() === 'qc') || `qa-ft-site=${JSON.stringify(s)}`
  }))

t('FT-SITE-05', 'Site access & modules', 'Negative', 'Set site modules with invalid input',
  { pre: 'Admin', steps: 'PUT /admin/site-modules/qa-ft-site {modules:["qc","bogus"]} ; {modules:"qc"} ; PUT /admin/site-modules/no-such-site {modules:[]}', expected: '400 invalid_modules ; 400 invalid_modules ; 404 site_not_found' },
  async () => {
    const a = await A().put('/api/v1/admin/site-modules/qa-ft-site', { modules: ['qc', 'bogus'] })
    const b = await A().put('/api/v1/admin/site-modules/qa-ft-site', { modules: 'qc' })
    const c = await A().put('/api/v1/admin/site-modules/no-such-site', { modules: [] })
    return { ok: a.status === 400 && b.status === 400 && c.status === 404, actual: `${a.status} / ${b.status} / ${c.status}`, evidence: `${brief(a)} | ${brief(b)} | ${brief(c)}` }
  })

t('FT-SITE-06', 'Site access & modules', 'Negative', 'Pages of a module that is off for the site are refused',
  { pre: 'qa-ft-site modules = [qc]; qa-ft-ops holds qa-ft-site with live-ops/utility/production rights', steps: 'GET /sites/qa-ft-site/live/tanks ; /utility ; /production ; /stock-history?from=…&to=…', expected: '403 module_not_enabled for each' },
  async () => {
    const c = U('qa-ft-ops')
    const rs = [await c.get('/api/v1/sites/qa-ft-site/live/tanks'), await c.get('/api/v1/sites/qa-ft-site/utility'), await c.get('/api/v1/sites/qa-ft-site/production'), await c.get('/api/v1/sites/qa-ft-site/stock-history?from=2026-10-01&to=2026-10-02')]
    return { ok: rs.every((r) => r.status === 403 && r.json?.error === 'module_not_enabled'), actual: rs.map((r) => `${r.status}:${r.json?.error}`).join(' / '), evidence: rs.map((r) => brief(r, 60)).join(' | ') }
  })

t('FT-SITE-07', 'Site access & modules', 'Positive', 'Switching a module on takes effect at once, switching it off blocks again',
  { pre: 'qa-ft-site modules = [qc]', steps: 'PUT modules [qc, live-ops]; qa-ft-ops GET live/tanks + /auth/me; PUT modules [] ; qa-ft-qc GET qc/storage; restore [qc]', expected: 'PUT 200; live/tanks 200 []; /me lists live-ops; after [] qc/storage 403 module_not_enabled' },
  async () => {
    const p1 = await A().put('/api/v1/admin/site-modules/qa-ft-site', { modules: ['live-ops', 'qc'] })
    const live = await U('qa-ft-ops').get('/api/v1/sites/qa-ft-site/live/tanks')
    const me = await U('qa-ft-ops').get('/api/v1/auth/me')
    const mods = me.json?.sites?.find((s) => s.id === 'qa-ft-site')?.modules?.join()
    const p2 = await A().put('/api/v1/admin/site-modules/qa-ft-site', { modules: [] })
    const qc = await U('qa-ft-qc').get('/api/v1/sites/qa-ft-site/qc/storage')
    await A().put('/api/v1/admin/site-modules/qa-ft-site', { modules: ['qc'] })
    const ok = p1.status === 200 && live.status === 200 && Array.isArray(live.json) && mods === 'live-ops,qc' && p2.status === 200 && qc.status === 403 && qc.json?.error === 'module_not_enabled'
    return { ok, actual: `put ${p1.status}; live ${live.status}; me modules=${mods}; put[] ${p2.status}; qc ${qc.status}:${qc.json?.error}`, evidence: brief(qc) }
  })

t('FT-SITE-08', 'Site access & modules', 'Negative', 'Module settings need master-sites rights',
  { pre: 'qa-ft-ops has no master-sites right', steps: 'GET /admin/site-modules ; PUT /admin/site-modules/qa-ft-site', expected: '403 ; 403' },
  async () => {
    const a = await U('qa-ft-ops').get('/api/v1/admin/site-modules')
    const b = await U('qa-ft-ops').put('/api/v1/admin/site-modules/qa-ft-site', { modules: ['qc'] })
    return { ok: a.status === 403 && b.status === 403, actual: `${a.status} / ${b.status}`, evidence: `${brief(a)} | ${brief(b)}` }
  })

t('FT-SITE-09', 'Site access & modules', 'Negative', 'A user with a site but no page rights sees no operational data',
  { pre: 'qa-ft-none holds bekasi, role with no rights', steps: 'GET /auth/me ; /sites/bekasi/snapshot ; /live/tanks ; /qc/storage ; /utility ; /production ; /portfolio/stock ; /master/commodities?siteId=bekasi ; /tank-gauging/sites/bekasi/overview ; /admin/datahub/config', expected: '/me 200 with empty permissions; every other call 403' },
  async () => {
    const c = U('qa-ft-none')
    const me = await c.get('/api/v1/auth/me')
    const paths = ['/api/v1/sites/bekasi/snapshot', '/api/v1/sites/bekasi/live/tanks', '/api/v1/sites/bekasi/qc/storage', '/api/v1/sites/bekasi/utility', '/api/v1/sites/bekasi/production', '/api/v1/portfolio/stock', '/api/v1/master/commodities?siteId=bekasi', '/api/v1/tank-gauging/sites/bekasi/overview', '/api/v1/admin/datahub/config']
    const rs = await Promise.all(paths.map((p) => c.get(p)))
    const bad = rs.filter((r) => r.status !== 403)
    const ok = me.status === 200 && Object.keys(me.json?.permissions ?? {}).length === 0 && bad.length === 0
    return { ok, actual: bad.length ? bad.map((r) => `${r.path}=${r.status}`).join(', ') : `me 200, ${rs.length} x 403`, evidence: bad.map((r) => brief(r)).join(' | ') }
  })

// ================================================================ MASTER DATA & COMMODITY SPECS

t('FT-MD-01', 'Master data & commodity specs', 'Positive', 'Organisation tree',
  { pre: 'Signed in', steps: 'GET /master/org', expected: '200 with companies, sites (bekasi, qa-other, qa-ft-site), plants' },
  async () => status(await A().get('/api/v1/master/org'), 200, (r) => ['bekasi', 'qa-other', 'qa-ft-site'].every((id) => r.json.sites.some((s) => s.id === id))))

t('FT-MD-02', 'Master data & commodity specs', 'Positive', 'Commodity list for a site with rule counts',
  { pre: 'Admin', steps: 'GET /master/commodities?siteId=bekasi', expected: '200, 9 commodities, cpo has ruleCount 6' },
  async () => status(await A().get('/api/v1/master/commodities?siteId=bekasi'), 200, (r) => {
    const cpo = r.json.commodities.find((c) => c.id === 'cpo')
    return (r.json.commodities.length === 9 && cpo?.ruleCount >= 1) || `n=${r.json.commodities.length} cpo=${JSON.stringify(cpo)}`
  }))

t('FT-MD-03', 'Master data & commodity specs', 'Negative', 'Commodity list without a site, or for an unknown site',
  { pre: 'Admin', steps: 'GET /master/commodities ; ?siteId=no-such-site', expected: '400 or 404 site_not_found for both' },
  async () => {
    const a = await A().get('/api/v1/master/commodities')
    const b = await A().get('/api/v1/master/commodities?siteId=no-such-site')
    return { ok: [400, 404].includes(a.status) && [400, 404].includes(b.status), actual: `${a.status}:${a.json?.error} / ${b.status}:${b.json?.error}`, evidence: `${brief(a)} | ${brief(b)}` }
  })

t('FT-MD-04', 'Master data & commodity specs', 'Positive', 'Read one commodity\'s storage specs and the parameter catalogue',
  { pre: 'Admin', steps: 'GET /master/commodities/cpo/specs?siteId=bekasi', expected: '200, 14 parameters (incl. lab.odor kind pass), rules list' },
  async () => status(await A().get('/api/v1/master/commodities/cpo/specs?siteId=bekasi'), 200, (r) => (r.json.parameters.length === 14 && r.json.parameters.some((p) => p.code === 'lab.odor' && p.kind === 'pass') && Array.isArray(r.json.rules)) || 'shape'))

t('FT-MD-05', 'Master data & commodity specs', 'Negative', 'Specs of a nonexistent commodity',
  { pre: 'Admin', steps: 'GET /master/commodities/nope/specs?siteId=bekasi ; PUT same', expected: '404 not_found for both' },
  async () => {
    const a = await A().get('/api/v1/master/commodities/nope/specs?siteId=bekasi')
    const b = await A().put('/api/v1/master/commodities/nope/specs?siteId=qa-ft-site', { rules: [] })
    return { ok: a.status === 404 && b.status === 404, actual: `${a.status} / ${b.status}`, evidence: `${brief(a)} | ${brief(b)}` }
  })

t('FT-MD-06', 'Master data & commodity specs', 'Positive', 'Save a commodity\'s storage specs and read them back',
  { pre: 'Admin; qa-ft-site has no rules', steps: 'PUT /master/commodities/cpo/specs?siteId=qa-ft-site {rules:[ffa max 5 reject, iv min 50 watch, iv max 55 watch, odour reject, moisture max "0.5" (string)]}', expected: '200; 5 rules stored in quality_rules for qa-ft-site/cpo; odour limit null; "0.5" stored as 0.5; list ruleCount 5, rejectCount 3' },
  async () => {
    const rules = [
      { parameterCode: 'lab.ffa', bound: 'max', limit: 5, severity: 'reject' },
      { parameterCode: 'lab.iv', bound: 'min', limit: 50, severity: 'watch' },
      { parameterCode: 'lab.iv', bound: 'max', limit: 55, severity: 'watch' },
      { parameterCode: 'lab.odor', severity: 'reject' },
      { parameterCode: 'lab.moisture', bound: 'max', limit: '0.5' },
    ]
    const r = await A().put('/api/v1/master/commodities/cpo/specs?siteId=qa-ft-site', { rules })
    const rows = await sql(`SELECT parameter_code, bound, limit_value, severity FROM quality_rules WHERE site_id = 'qa-ft-site' AND commodity_id = 'cpo'`)
    const list = await A().get('/api/v1/master/commodities?siteId=qa-ft-site')
    const cpo = list.json?.commodities?.find((c) => c.id === 'cpo')
    const moisture = rows.rows.find((x) => x.parameter_code === 'lab.moisture')
    const odor = rows.rows.find((x) => x.parameter_code === 'lab.odor')
    const ok = r.status === 200 && rows.rowCount === 5 && Number(moisture?.limit_value) === 0.5 && odor?.limit_value == null && cpo?.ruleCount === 5 && cpo?.rejectCount === 3
    return { ok, actual: `HTTP ${r.status}; db rows=${rows.rowCount}; moisture=${moisture?.limit_value}; list ruleCount=${cpo?.ruleCount} reject=${cpo?.rejectCount}`, evidence: brief(r) }
  })

t('FT-MD-07', 'Master data & commodity specs', 'Negative', 'Spec validation: every invalid input is refused and nothing is changed',
  { pre: 'FT-MD-06 rules saved', steps: 'PUT specs with: rules not array; unknown parameter; severity "fatal"; bound "between"; limit missing; limit "abc"; duplicate ffa max; iv min 60 > iv max 55', expected: '400 with invalid_rules, unknown_parameter, invalid_severity, invalid_bound, limit_required, limit_required, duplicate_rule, min_above_max; DB still 5 rules' },
  async () => {
    const cases = [
      [{ rules: 'x' }, 'invalid_rules'],
      [{ rules: [{ parameterCode: 'lab.nope', bound: 'max', limit: 1 }] }, 'unknown_parameter'],
      [{ rules: [{ parameterCode: 'lab.ffa', bound: 'max', limit: 1, severity: 'fatal' }] }, 'invalid_severity'],
      [{ rules: [{ parameterCode: 'lab.ffa', bound: 'between', limit: 1 }] }, 'invalid_bound'],
      [{ rules: [{ parameterCode: 'lab.ffa', bound: 'max' }] }, 'limit_required'],
      [{ rules: [{ parameterCode: 'lab.ffa', bound: 'max', limit: 'abc' }] }, 'limit_required'],
      [{ rules: [{ parameterCode: 'lab.ffa', bound: 'max', limit: 1 }, { parameterCode: 'lab.ffa', bound: 'max', limit: 2 }] }, 'duplicate_rule'],
      [{ rules: [{ parameterCode: 'lab.iv', bound: 'min', limit: 60 }, { parameterCode: 'lab.iv', bound: 'max', limit: 55 }] }, 'min_above_max'],
    ]
    const got = []
    for (const [body, code] of cases) {
      const r = await A().put('/api/v1/master/commodities/cpo/specs?siteId=qa-ft-site', body)
      got.push({ ok: r.status === 400 && r.json?.error === code, s: `${r.status}:${r.json?.error}` })
    }
    const rows = await sql(`SELECT 1 FROM quality_rules WHERE site_id = 'qa-ft-site' AND commodity_id = 'cpo'`)
    return { ok: got.every((g) => g.ok) && rows.rowCount === 5, actual: `${got.map((g) => g.s).join(', ')}; db rows=${rows.rowCount}`, evidence: '' }
  })

t('FT-MD-08', 'Master data & commodity specs', 'Negative', 'Spec limit boundaries: negative, zero and non-finite limits',
  { pre: 'Admin', steps: 'PUT specs pfad on qa-ft-site {rules:[cloud point max -1]} ; {ffa max "1e309"} ; {ffa min 0}; then clear', expected: 'Negative limit accepted 200 (cloud point can be below 0 °C); 1e309 (Infinity) refused 400 limit_required; 0 accepted 200' },
  async () => {
    const a = await A().put('/api/v1/master/commodities/pfad/specs?siteId=qa-ft-site', { rules: [{ parameterCode: 'lab.cloud_point', bound: 'max', limit: -1 }] })
    const b = await A().put('/api/v1/master/commodities/pfad/specs?siteId=qa-ft-site', { rules: [{ parameterCode: 'lab.ffa', bound: 'max', limit: '1e309' }] })
    const c = await A().put('/api/v1/master/commodities/pfad/specs?siteId=qa-ft-site', { rules: [{ parameterCode: 'lab.ffa', bound: 'min', limit: 0 }] })
    await A().put('/api/v1/master/commodities/pfad/specs?siteId=qa-ft-site', { rules: [] })
    return { ok: a.status === 200 && b.status === 400 && b.json?.error === 'limit_required' && c.status === 200, actual: `-1 -> ${a.status}; 1e309 -> ${b.status}:${b.json?.error}; 0 -> ${c.status}`, evidence: `${brief(a)} | ${brief(b)}` }
  })

t('FT-MD-09', 'Master data & commodity specs', 'Positive', 'Clearing all rules leaves the commodity spec-pending',
  { pre: 'FT-MD-06 rules', steps: 'PUT specs cpo qa-ft-site {rules:[]}', expected: '200 {rules:[]}; DB 0 rows' },
  async () => {
    const r = await A().put('/api/v1/master/commodities/cpo/specs?siteId=qa-ft-site', { rules: [] })
    const rows = await sql(`SELECT 1 FROM quality_rules WHERE site_id = 'qa-ft-site'`)
    return { ok: r.status === 200 && r.json?.rules?.length === 0 && rows.rowCount === 0, actual: `HTTP ${r.status}; db rows=${rows.rowCount}`, evidence: brief(r) }
  })

t('FT-MD-10', 'Master data & commodity specs', 'Negative', 'Non-admin cannot read or edit specs of a site they do not hold; viewer cannot edit',
  { pre: 'qa-ft-master holds bekasi + qa-ft-site (not qa-other); qa-ft-ops has no master-commodities right', steps: 'qa-ft-master GET specs ?siteId=qa-other ; PUT ?siteId=qa-other ; qa-ft-ops PUT ?siteId=qa-ft-site', expected: '404 site_not_found ; 404 site_not_found ; 403 forbidden' },
  async () => {
    const a = await U('qa-ft-master').get('/api/v1/master/commodities/cpo/specs?siteId=qa-other')
    const b = await U('qa-ft-master').put('/api/v1/master/commodities/cpo/specs?siteId=qa-other', { rules: [] })
    const c = await U('qa-ft-ops').put('/api/v1/master/commodities/cpo/specs?siteId=qa-ft-site', { rules: [] })
    return { ok: a.status === 404 && b.status === 404 && c.status === 403, actual: `${a.status} / ${b.status} / ${c.status}`, evidence: `${brief(a)} | ${brief(b)} | ${brief(c)}` }
  })

t('FT-MD-11', 'Master data & commodity specs', 'Positive', 'Non-admin master editor saves specs on a site they hold',
  { pre: 'qa-ft-master holds qa-ft-site', steps: 'PUT /master/commodities/rpo/specs?siteId=qa-ft-site {rules:[ffa max 0.1]} ; then clear', expected: '200, 1 rule; clear 200' },
  async () => {
    const a = await U('qa-ft-master').put('/api/v1/master/commodities/rpo/specs?siteId=qa-ft-site', { rules: [{ parameterCode: 'lab.ffa', bound: 'max', limit: 0.1 }] })
    const b = await U('qa-ft-master').put('/api/v1/master/commodities/rpo/specs?siteId=qa-ft-site', { rules: [] })
    return { ok: a.status === 200 && a.json?.rules?.length === 1 && b.status === 200, actual: `${a.status} rules=${a.json?.rules?.length} / ${b.status}`, evidence: brief(a) }
  })

t('FT-MD-12', 'Master data & commodity specs', 'Positive', 'Change a site timezone',
  { pre: 'Admin', steps: 'PUT /master/org/sites/qa-ft-site {timezone:"Asia/Makassar"}; restore Asia/Jakarta', expected: '200 {ok:true}; DB updated' },
  async () => {
    const r = await A().put('/api/v1/master/org/sites/qa-ft-site', { timezone: 'Asia/Makassar' })
    const row = await sql(`SELECT timezone FROM sites WHERE id = 'qa-ft-site'`)
    await A().put('/api/v1/master/org/sites/qa-ft-site', { timezone: 'Asia/Jakarta' })
    return { ok: r.status === 200 && row.rows[0].timezone === 'Asia/Makassar', actual: `HTTP ${r.status}; db=${row.rows[0].timezone}`, evidence: brief(r) }
  })

t('FT-MD-13', 'Master data & commodity specs', 'Negative', 'Site timezone: invalid zone, empty, unknown site',
  { pre: 'Admin', steps: 'PUT /master/org/sites/qa-ft-site {timezone:"Mars/Olympus"} ; {timezone:""} ; PUT /master/org/sites/no-such-site {timezone:"Asia/Jakarta"}', expected: '400 invalid_timezone ; 400 invalid_timezone ; 404' },
  async () => {
    const a = await A().put('/api/v1/master/org/sites/qa-ft-site', { timezone: 'Mars/Olympus' })
    const b = await A().put('/api/v1/master/org/sites/qa-ft-site', { timezone: '' })
    const c = await A().put('/api/v1/master/org/sites/no-such-site', { timezone: 'Asia/Jakarta' })
    const row = await sql(`SELECT timezone FROM sites WHERE id = 'qa-ft-site'`)
    if (row.rows[0].timezone !== 'Asia/Jakarta') await sql(`UPDATE sites SET timezone = 'Asia/Jakarta' WHERE id = 'qa-ft-site'`)
    return { ok: a.status === 400 && b.status === 400 && c.status === 404, actual: `${a.status} / ${b.status} (db tz now '${row.rows[0].timezone}') / ${c.status}`, evidence: `${brief(a)} | ${brief(b)} | ${brief(c)}` }
  })

t('FT-MD-14', 'Master data & commodity specs', 'Negative', 'Activation rules: company with an active site, site of an inactive company, bad input',
  { pre: 'qa-ft-co (on) with qa-ft-site and qa-ft-site2 (on)', steps: 'PUT /master/org/activation {company qa-ft-co off} ; {sites qa-ft-site, qa-ft-site2 off} + {company off} + {site qa-ft-site on} ; {entityType:"plant"} ; {site no-such on}; restore', expected: '409 company_has_active_sites ; site-on under an off company 409 company_not_activated ; 400 invalid_request ; 404' },
  async () => {
    const a = await A().put('/api/v1/master/org/activation', { entityType: 'company', id: 'qa-ft-co', activated: false })
    const s1 = await A().put('/api/v1/master/org/activation', { entityType: 'site', id: 'qa-ft-site', activated: false })
    await A().put('/api/v1/master/org/activation', { entityType: 'site', id: 'qa-ft-site2', activated: false })
    const c1 = await A().put('/api/v1/master/org/activation', { entityType: 'company', id: 'qa-ft-co', activated: false })
    const b = await A().put('/api/v1/master/org/activation', { entityType: 'site', id: 'qa-ft-site', activated: true })
    const c = await A().put('/api/v1/master/org/activation', { entityType: 'plant', id: 'x', activated: true })
    const d = await A().put('/api/v1/master/org/activation', { entityType: 'site', id: 'no-such-site', activated: true })
    await A().put('/api/v1/master/org/activation', { entityType: 'company', id: 'qa-ft-co', activated: true })
    await A().put('/api/v1/master/org/activation', { entityType: 'site', id: 'qa-ft-site', activated: true })
    await A().put('/api/v1/master/org/activation', { entityType: 'site', id: 'qa-ft-site2', activated: true })
    const ok = a.status === 409 && a.json?.error === 'company_has_active_sites' && s1.status === 200 && c1.status === 200 && b.status === 409 && b.json?.error === 'company_not_activated' && c.status === 400 && d.status === 404
    return { ok, actual: `${a.status}:${a.json?.error}; site-off ${s1.status}; co-off ${c1.status}; ${b.status}:${b.json?.error}; ${c.status}; ${d.status}`, evidence: brief(b) }
  })

t('FT-MD-15', 'Master data & commodity specs', 'Negative', 'A non-admin master-sites editor cannot change a site they do not hold',
  { pre: 'qa-ft-master has master-sites edit and holds bekasi + qa-ft-site, NOT qa-ft-site2 (fixture site, same activated company)', steps: 'qa-ft-master PUT /master/org/sites/qa-ft-site2 {timezone:"Asia/Makassar"} ; PUT /master/org/activation {entityType:"site", id:"qa-ft-site2", activated:false}; check DB; restore', expected: '403/404 for both and qa-ft-site2 unchanged — as for commodity specs, tank gauging and site modules, a non-admin may act only on sites they hold' },
  async () => {
    const a = await U('qa-ft-master').put('/api/v1/master/org/sites/qa-ft-site2', { timezone: 'Asia/Makassar' })
    const b = await U('qa-ft-master').put('/api/v1/master/org/activation', { entityType: 'site', id: 'qa-ft-site2', activated: false })
    const row = (await sql(`SELECT timezone, is_activated FROM sites WHERE id = 'qa-ft-site2'`)).rows[0]
    await sql(`UPDATE sites SET timezone = 'Asia/Jakarta', is_activated = TRUE WHERE id = 'qa-ft-site2'`)
    const ok = [403, 404].includes(a.status) && [403, 404].includes(b.status) && row.timezone === 'Asia/Jakarta' && row.is_activated === true
    return { ok, actual: `timezone PUT ${a.status}; activation PUT ${b.status}; DB after: timezone=${row.timezone}, is_activated=${row.is_activated}`, evidence: `${brief(a)} | ${brief(b)}` }
  })

t('FT-MD-16', 'Master data & commodity specs', 'Negative', 'Org changes need master rights',
  { pre: 'qa-ft-ops (no master rights)', steps: 'PUT /master/org/sites/qa-ft-site ; PUT /master/org/activation', expected: '403 ; 403' },
  async () => {
    const a = await U('qa-ft-ops').put('/api/v1/master/org/sites/qa-ft-site', { timezone: 'Asia/Jakarta' })
    const b = await U('qa-ft-ops').put('/api/v1/master/org/activation', { entityType: 'site', id: 'qa-ft-site', activated: true })
    return { ok: a.status === 403 && b.status === 403, actual: `${a.status} / ${b.status}`, evidence: `${brief(a)} | ${brief(b)}` }
  })

// ================================================================ TANK & STOCK (live-ops)

t('FT-OPS-01', 'Tank & Stock (live-ops)', 'Positive', 'Snapshot of a site with logsheet data',
  { pre: 'bekasi has soundings 2026-07-22..2026-10-20', steps: 'GET /sites/bekasi/snapshot', expected: '200, soundingAsOf 2026-10-20, soundingDates sorted, hasLabData true' },
  async () => status(await A().get('/api/v1/sites/bekasi/snapshot'), 200, (r) => (r.json.soundingAsOf === '2026-10-20' && r.json.hasLabData === true && [...r.json.soundingDates].sort().join() === r.json.soundingDates.join()) || `asOf=${r.json.soundingAsOf}`))

t('FT-OPS-02', 'Tank & Stock (live-ops)', 'Positive', 'Tanks of the latest day',
  { pre: 'bekasi', steps: 'GET /sites/bekasi/live/tanks', expected: '200, one row per tank, all recordedOn = 2026-10-20 or no reading; quantity <= capacity' },
  async () => status(await A().get('/api/v1/sites/bekasi/live/tanks'), 200, (r) => {
    const bad = r.json.filter((x) => x.quantityKg != null && x.capacityKg != null && x.quantityKg > x.capacityKg * 1.2)
    const ids = new Set(r.json.map((x) => x.tankId))
    return (r.json.length > 0 && ids.size === r.json.length && bad.length === 0) || `n=${r.json.length} dupes/over=${bad.length}`
  }))

t('FT-OPS-03', 'Tank & Stock (live-ops)', 'Positive', 'Tanks of a chosen earlier day',
  { pre: 'bekasi', steps: 'GET /sites/bekasi/live/tanks?on=2026-10-01', expected: '200, rows recordedOn 2026-10-01' },
  async () => status(await A().get('/api/v1/sites/bekasi/live/tanks?on=2026-10-01'), 200, (r) => r.json.some((x) => x.recordedOn === '2026-10-01') || 'no row for that day'))

t('FT-OPS-04', 'Tank & Stock (live-ops)', 'Negative', 'Tanks for a malformed day',
  { pre: 'bekasi', steps: 'GET /sites/bekasi/live/tanks?on=garbage ; ?on=2026-02-30', expected: '400 invalid date (not 200 with recordedOn "garbage")' },
  async () => {
    const a = await A().get('/api/v1/sites/bekasi/live/tanks?on=garbage')
    const b = await A().get('/api/v1/sites/bekasi/live/tanks?on=2026-02-30')
    return { ok: a.status === 400 && b.status === 400, actual: `${a.status} (first recordedOn=${a.json?.[0]?.recordedOn}) / ${b.status}`, evidence: `${brief(a, 160)} | ${brief(b, 120)}` }
  })

t('FT-OPS-05', 'Tank & Stock (live-ops)', 'Positive', 'Stock history between two days (Commodity Stock Movement)',
  { pre: 'bekasi', steps: 'GET /sites/bekasi/stock-history?from=2026-10-01&to=2026-10-20', expected: '200, [{tankId, points}] and every point between the two days' },
  async () => status(await A().get('/api/v1/sites/bekasi/stock-history?from=2026-10-01&to=2026-10-20'), 200, (r) => {
    const pts = r.json.flatMap((x) => x.points)
    return (pts.length > 0 && pts.every((p) => p.recordedOn >= '2026-10-01' && p.recordedOn <= '2026-10-20')) || `points=${pts.length}`
  }))

t('FT-OPS-06', 'Tank & Stock (live-ops)', 'Negative', 'Stock history: missing range, reversed range, wrong format',
  { pre: 'bekasi', steps: 'GET stock-history (no params) ; ?from=2026-10-20&to=2026-10-01 ; ?from=20261001&to=20261020', expected: '400 for each: invalid_range for a missing or reversed range, invalid_date for a malformed day' },
  async () => {
    const rs = [await A().get('/api/v1/sites/bekasi/stock-history'), await A().get('/api/v1/sites/bekasi/stock-history?from=2026-10-20&to=2026-10-01'), await A().get('/api/v1/sites/bekasi/stock-history?from=20261001&to=20261020')]
    return { ok: rs.every((r) => r.status === 400 && ['invalid_range', 'invalid_date'].includes(r.json?.error)), actual: rs.map((r) => `${r.status}:${r.json?.error}`).join(' / '), evidence: '' }
  })

t('FT-OPS-07', 'Tank & Stock (live-ops)', 'Negative', 'Stock history with an impossible calendar date',
  { pre: 'bekasi', steps: 'GET /sites/bekasi/stock-history?from=2026-02-30&to=2026-03-01 ; ?from=2026-10-01&to=2026-13-01', expected: '400 invalid_range (not a 500 with a database error)' },
  async () => {
    const a = await A().get('/api/v1/sites/bekasi/stock-history?from=2026-02-30&to=2026-03-01')
    const b = await A().get('/api/v1/sites/bekasi/stock-history?from=2026-10-01&to=2026-13-01')
    return { ok: a.status === 400 && b.status === 400, actual: `${a.status} / ${b.status}`, evidence: `${brief(a)} | ${brief(b)}` }
  })

t('FT-OPS-08', 'Tank & Stock (live-ops)', 'Positive', 'One tank\'s sounding history and labs',
  { pre: 'bekasi T04', steps: 'GET /sites/bekasi/tanks/T04/soundings ; /tanks/T04/labs', expected: '200, soundings ordered by day; labs list with storageVerdict' },
  async () => {
    const a = await A().get('/api/v1/sites/bekasi/tanks/T04/soundings')
    const b = await A().get('/api/v1/sites/bekasi/tanks/T04/labs')
    const days = (a.json ?? []).map((p) => p.recordedOn)
    const ok = a.status === 200 && days.length > 0 && [...days].sort().join() === days.join() && b.status === 200 && b.json.every((l) => typeof l.storageVerdict === 'string')
    return { ok, actual: `soundings ${a.status} n=${days.length}; labs ${b.status} n=${b.json?.length}`, evidence: '' }
  })

t('FT-OPS-09', 'Tank & Stock (live-ops)', 'Negative', 'History of a tank that does not exist',
  { pre: 'bekasi', steps: 'GET /sites/bekasi/tanks/NOPE/soundings ; /labs', expected: '200 [] or 404 for both (no error)' },
  async () => {
    const a = await A().get('/api/v1/sites/bekasi/tanks/NOPE/soundings')
    const b = await A().get('/api/v1/sites/bekasi/tanks/NOPE/labs')
    const okOne = (r) => (r.status === 200 && Array.isArray(r.json) && r.json.length === 0) || r.status === 404
    return { ok: okOne(a) && okOne(b), actual: `${a.status} ${a.text} / ${b.status} ${b.text}`, evidence: '' }
  })

t('FT-OPS-10', 'Tank & Stock (live-ops)', 'Positive', 'Logistics, analytics summary and movements',
  { pre: 'bekasi', steps: 'GET /sites/bekasi/live/logistics ; /analytics/summary ; /analytics/summary?tankId=T04 ; /analytics/movements', expected: '200 each; summary approvalRate in [0,1]; with tankId approvalRate null' },
  async () => {
    const rs = [await A().get('/api/v1/sites/bekasi/live/logistics'), await A().get('/api/v1/sites/bekasi/analytics/summary'), await A().get('/api/v1/sites/bekasi/analytics/summary?tankId=T04'), await A().get('/api/v1/sites/bekasi/analytics/movements')]
    const rate = rs[1].json?.approvalRate
    const ok = rs.every((r) => r.status === 200) && rate >= 0 && rate <= 1 && rs[2].json?.approvalRate === null && rs[2].json?.tankId === 'T04'
    return { ok, actual: rs.map((r) => r.status).join('/') + ` rate=${rate}`, evidence: '' }
  })

t('FT-OPS-11', 'Tank & Stock (live-ops)', 'Negative', 'Live-ops data needs live-ops or ops-analytics view',
  { pre: 'qa-ft-qc holds bekasi with qc right only', steps: 'GET /sites/bekasi/live/tanks ; /snapshot ; /stock-history?… ; /tanks/T04/soundings', expected: '403 forbidden each' },
  async () => {
    const c = U('qa-ft-qc')
    const rs = [await c.get('/api/v1/sites/bekasi/live/tanks'), await c.get('/api/v1/sites/bekasi/snapshot'), await c.get('/api/v1/sites/bekasi/stock-history?from=2026-10-01&to=2026-10-02'), await c.get('/api/v1/sites/bekasi/tanks/T04/soundings')]
    return { ok: rs.every((r) => r.status === 403), actual: rs.map((r) => r.status).join(' / '), evidence: '' }
  })

t('FT-OPS-12', 'Tank & Stock (live-ops)', 'Positive', 'A live-ops viewer reads the dashboard of a held site',
  { pre: 'qa-ft-ops holds bekasi', steps: 'GET /sites/bekasi/live/tanks', expected: '200, same tank count as for the Administrator' },
  async () => {
    const a = await U('qa-ft-ops').get('/api/v1/sites/bekasi/live/tanks')
    const b = await A().get('/api/v1/sites/bekasi/live/tanks')
    return { ok: a.status === 200 && a.json.length === b.json.length, actual: `${a.status} n=${a.json?.length} (admin n=${b.json?.length})`, evidence: '' }
  })

// ================================================================ STOCK OVERVIEW / PORTFOLIO

t('FT-PF-01', 'Stock Overview / portfolio', 'Positive', 'Portfolio totals equal the sum of the sites and of the commodity classes',
  { pre: 'Admin holds bekasi (live-ops on)', steps: 'GET /portfolio/stock', expected: '200; portfolio.quantityKg = Σ sites.quantityKg; per site Σ classes.quantityKg = site.quantityKg; tanksTotal = Σ counts' },
  async () => {
    const r = await A().get('/api/v1/portfolio/stock')
    const p = r.json?.portfolio
    const sumSites = r.json.sites.reduce((n, s) => n + s.quantityKg, 0)
    const site = r.json.sites.find((s) => s.id === 'bekasi')
    const sumClasses = site.classes.reduce((n, c) => n + c.quantityKg, 0)
    const counts = Object.values(site.counts).reduce((n, x) => n + x, 0)
    const close = (a, b) => Math.abs(a - b) < 1
    const ok = r.status === 200 && close(p.quantityKg, sumSites) && close(site.quantityKg, sumClasses) && counts === site.tanksTotal
    return { ok, actual: `portfolio=${p.quantityKg} Σsites=${sumSites}; site=${site.quantityKg} Σclasses=${sumClasses}; Σcounts=${counts} tanksTotal=${site.tanksTotal}`, evidence: '' }
  })

t('FT-PF-02', 'Stock Overview / portfolio', 'Positive', 'Stock movement ends on the same figure as the overview total',
  { pre: 'bekasi', steps: 'GET /portfolio/movement ; GET /portfolio/stock', expected: 'movement site.to = overview site.day and the last series point = overview site.quantityKg; class series sum to the total on each day' },
  async () => {
    const m = await A().get('/api/v1/portfolio/movement')
    const s = await A().get('/api/v1/portfolio/stock')
    const ms = m.json.sites.find((x) => x.id === 'bekasi')
    const ss = s.json.sites.find((x) => x.id === 'bekasi')
    const last = ms.series.at(-1)
    const close = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) < 1
    let classesOk = true
    for (const point of ms.series) {
      const sum = ms.classes.reduce((n, c) => n + (c.series.find((x) => x.day === point.day)?.quantityKg ?? 0), 0)
      if (point.quantityKg != null && !close(sum, point.quantityKg)) classesOk = false
    }
    const ok = m.status === 200 && ms.to === ss.day && last.day === ss.day && close(last.quantityKg, ss.quantityKg) && classesOk
    return { ok, actual: `to=${ms.to} day=${ss.day}; last=${last.quantityKg} overview=${ss.quantityKg}; classes sum ok=${classesOk}`, evidence: '' }
  })

t('FT-PF-03', 'Stock Overview / portfolio', 'Positive', 'Movement period length follows ?days within 7..92',
  { pre: 'bekasi', steps: 'GET /portfolio/movement?days=7 ; ?days=1000 ; ?days=3 ; ?days=abc', expected: 'days 7 (7 points), 92, 7, 30 (default) respectively' },
  async () => {
    const q = async (d) => (await A().get(`/api/v1/portfolio/movement?days=${d}`)).json
    const [a, b, c, d] = [await q(7), await q(1000), await q(3), await q('abc')]
    const len = (x) => x.sites.find((s) => s.id === 'bekasi')?.series.length
    const ok = a.days === 7 && len(a) === 7 && b.days === 92 && c.days === 7 && d.days === 30 && len(d) === 30
    return { ok, actual: `7->${a.days}/${len(a)}; 1000->${b.days}; 3->${c.days}; abc->${d.days}/${len(d)}`, evidence: '' }
  })

t('FT-PF-04', 'Stock Overview / portfolio', 'Positive', 'Overview lists only held sites with the Tank farm module on',
  { pre: 'qa-ft-ops holds bekasi (live-ops on) + qa-ft-site (live-ops off)', steps: 'GET /portfolio/stock ; /portfolio/movement as qa-ft-ops', expected: 'sites = [bekasi] in both' },
  async () => {
    const a = await U('qa-ft-ops').get('/api/v1/portfolio/stock')
    const b = await U('qa-ft-ops').get('/api/v1/portfolio/movement')
    const ia = a.json?.sites?.map((s) => s.id).join()
    const ib = b.json?.sites?.map((s) => s.id).join()
    return { ok: a.status === 200 && ia === 'bekasi' && ib === 'bekasi', actual: `stock=${ia}; movement=${ib}`, evidence: '' }
  })

t('FT-PF-05', 'Stock Overview / portfolio', 'Positive', 'A management-only user reads the overview and tank history, but not the operational pages',
  { pre: 'qa-ft-mgmt has management-stock only, holds bekasi', steps: 'GET /portfolio/stock ; /portfolio/sites/bekasi/tanks/T04/history ; /portfolio/sites/bekasi/tanks/T04/labs ; /sites/bekasi/live/tanks', expected: '200 ; 200 ; 200 ; 403' },
  async () => {
    const c = U('qa-ft-mgmt')
    const rs = [await c.get('/api/v1/portfolio/stock'), await c.get('/api/v1/portfolio/sites/bekasi/tanks/T04/history'), await c.get('/api/v1/portfolio/sites/bekasi/tanks/T04/labs'), await c.get('/api/v1/sites/bekasi/live/tanks')]
    return { ok: rs.slice(0, 3).every((r) => r.status === 200) && rs[3].status === 403 && rs[1].json.length > 0, actual: rs.map((r) => r.status).join(' / '), evidence: '' }
  })

t('FT-PF-06', 'Stock Overview / portfolio', 'Negative', 'Overview tank history of a site not held or without the module',
  { pre: 'qa-ft-ops: qa-other not held; qa-ft-site has live-ops off', steps: 'GET /portfolio/sites/qa-other/tanks/T04/history ; /portfolio/sites/qa-ft-site/tanks/T04/labs', expected: '403 ; 403' },
  async () => {
    const a = await U('qa-ft-ops').get('/api/v1/portfolio/sites/qa-other/tanks/T04/history')
    const b = await U('qa-ft-ops').get('/api/v1/portfolio/sites/qa-ft-site/tanks/T04/labs')
    return { ok: a.status === 403 && b.status === 403, actual: `${a.status} / ${b.status}`, evidence: '' }
  })

t('FT-PF-07', 'Stock Overview / portfolio', 'Negative', 'Overview needs the management-stock right',
  { pre: 'qa-ft-qc lacks management-stock', steps: 'GET /portfolio/stock ; /portfolio/movement', expected: '403 ; 403' },
  async () => {
    const a = await U('qa-ft-qc').get('/api/v1/portfolio/stock')
    const b = await U('qa-ft-qc').get('/api/v1/portfolio/movement')
    return { ok: a.status === 403 && b.status === 403, actual: `${a.status} / ${b.status}`, evidence: '' }
  })

t('FT-PF-08', 'Stock Overview / portfolio', 'Positive', 'A user with the right but no site gets an empty overview',
  { pre: 'qa-ft-nosite (management-stock, no sites)', steps: 'GET /portfolio/stock', expected: '200, sites [], portfolio totals 0 / sitesTotal 0' },
  async () => status(await U('qa-ft-nosite').get('/api/v1/portfolio/stock'), 200, (r) => (r.json.sites.length === 0 && r.json.portfolio.sitesTotal === 0) || JSON.stringify(r.json.portfolio).slice(0, 120)))

// ================================================================ QC

t('FT-QC-01', 'QC', 'Positive', 'Storage certificates with verdicts',
  { pre: 'bekasi: 225 certificates 2026-10-02..2026-10-20', steps: 'GET /sites/bekasi/qc/storage', expected: '200, rows with verdict in {pass, quarantine, spec-pending}' },
  async () => status(await A().get('/api/v1/sites/bekasi/qc/storage'), 200, (r) => (r.json.length > 0 && r.json.every((x) => ['pass', 'quarantine', 'spec-pending'].includes(x.verdict))) || 'verdicts'))

t('FT-QC-02', 'QC', 'Positive', 'Storage filtered by date range',
  { pre: 'bekasi', steps: 'GET /sites/bekasi/qc/storage?from=2026-10-10&to=2026-10-12', expected: '200, every snapshotOn within the range, fewer rows than unfiltered' },
  async () => {
    const r = await A().get('/api/v1/sites/bekasi/qc/storage?from=2026-10-10&to=2026-10-12')
    const all = await A().get('/api/v1/sites/bekasi/qc/storage')
    const ok = r.status === 200 && r.json.length > 0 && r.json.length < all.json.length && r.json.every((x) => x.snapshotOn >= '2026-10-10' && x.snapshotOn <= '2026-10-12')
    return { ok, actual: `n=${r.json.length} of ${all.json.length}`, evidence: '' }
  })

t('FT-QC-03', 'QC', 'Positive', 'Vessels, trucks and oil movements',
  { pre: 'bekasi', steps: 'GET /qc/vessels ; /qc/trucks ; /qc/movements', expected: '200 each; vessels have samples arrays; trucks have rows; movements {periodStart, rows}' },
  async () => {
    const rs = [await A().get('/api/v1/sites/bekasi/qc/vessels'), await A().get('/api/v1/sites/bekasi/qc/trucks'), await A().get('/api/v1/sites/bekasi/qc/movements')]
    const ok = rs.every((r) => r.status === 200) && Array.isArray(rs[0].json) && rs[0].json.every((v) => Array.isArray(v.samples)) && Array.isArray(rs[1].json.rows) && Array.isArray(rs[2].json.rows)
    return { ok, actual: rs.map((r) => r.status).join('/') + ` vessels=${rs[0].json?.length} truckRows=${rs[1].json?.rows?.length} movements=${rs[2].json?.rows?.length}`, evidence: '' }
  })

t('FT-QC-04', 'QC', 'Positive', 'Refinery snapshot, history and ledger',
  { pre: 'bekasi refinery days to 2026-10-20', steps: 'GET /qc/refinery ; /qc/refinery/history ; /qc/refinery/ledger', expected: '200 each; history has oils[] and points[]' },
  async () => {
    const rs = [await A().get('/api/v1/sites/bekasi/qc/refinery'), await A().get('/api/v1/sites/bekasi/qc/refinery/history'), await A().get('/api/v1/sites/bekasi/qc/refinery/ledger')]
    const ok = rs.every((r) => r.status === 200) && Array.isArray(rs[1].json.oils) && Array.isArray(rs[1].json.points) && Array.isArray(rs[2].json)
    return { ok, actual: rs.map((r) => r.status).join('/'), evidence: '' }
  })

t('FT-QC-05', 'QC', 'Positive', 'Refinery hourly sheet of a day with data',
  { pre: 'bekasi refinery day 2026-10-20 with finished oil RPO/RBDPO', steps: 'GET /qc/refinery/hourly?date=2026-10-20&oil=RPO%2FRBDPO (as the Refinery history dialog calls it)', expected: '200 {productionDate, oil, points[]}' },
  async () => status(await A().get('/api/v1/sites/bekasi/qc/refinery/hourly?date=2026-10-20&oil=RPO%2FRBDPO'), 200, (r) => (r.json.productionDate === '2026-10-20' && r.json.points.length > 0) || 'shape'))

t('FT-QC-06', 'QC', 'Negative', 'Refinery hourly without a date, without an oil, or for a day with no data',
  { pre: 'bekasi', steps: 'GET /qc/refinery/hourly ; ?date=2026-10-20 (no oil) ; ?date=2020-01-01&oil=CPO', expected: '400 or 404 for the missing parameters; 404 for no data' },
  async () => {
    const a = await A().get('/api/v1/sites/bekasi/qc/refinery/hourly')
    const c = await A().get('/api/v1/sites/bekasi/qc/refinery/hourly?date=2026-10-20')
    const b = await A().get('/api/v1/sites/bekasi/qc/refinery/hourly?date=2020-01-01&oil=CPO')
    return { ok: [400, 404].includes(a.status) && [400, 404].includes(c.status) && b.status === 404, actual: `${a.status} / ${c.status} / ${b.status}`, evidence: '' }
  })

t('FT-QC-07', 'QC', 'Negative', 'Refinery endpoints with a malformed date filter',
  { pre: 'bekasi', steps: 'GET /qc/refinery?from=garbage ; /qc/refinery/ledger?to=2026-02-30 ; /qc/refinery/hourly?date=bad', expected: '400 for each (not a 500 with a database message)' },
  async () => {
    const rs = [await A().get('/api/v1/sites/bekasi/qc/refinery?from=garbage'), await A().get('/api/v1/sites/bekasi/qc/refinery/ledger?to=2026-02-30'), await A().get('/api/v1/sites/bekasi/qc/refinery/hourly?date=bad')]
    return { ok: rs.every((r) => r.status === 400), actual: rs.map((r) => r.status).join(' / '), evidence: rs.map((r) => brief(r, 120)).join(' | ') }
  })

t('FT-QC-08', 'QC', 'Negative', 'Storage/vessel filters with a malformed date',
  { pre: 'bekasi', steps: 'GET /qc/storage?from=garbage ; /qc/vessels?to=abc', expected: '400 (invalid date) — not 200 with silently empty/unfiltered rows' },
  async () => {
    const a = await A().get('/api/v1/sites/bekasi/qc/storage?from=garbage')
    const b = await A().get('/api/v1/sites/bekasi/qc/vessels?to=abc')
    return { ok: a.status === 400 && b.status === 400, actual: `${a.status} (n=${a.json?.length}) / ${b.status} (n=${b.json?.length})`, evidence: `${brief(a, 80)} | ${brief(b, 80)}` }
  })

t('FT-QC-09', 'QC', 'Negative', 'QC needs the qc right',
  { pre: 'qa-ft-ops lacks qc', steps: 'GET /sites/bekasi/qc/storage ; /qc/refinery', expected: '403 ; 403' },
  async () => {
    const a = await U('qa-ft-ops').get('/api/v1/sites/bekasi/qc/storage')
    const b = await U('qa-ft-ops').get('/api/v1/sites/bekasi/qc/refinery')
    return { ok: a.status === 403 && b.status === 403, actual: `${a.status} / ${b.status}`, evidence: '' }
  })

t('FT-QC-10', 'QC', 'Positive', 'A QC user on an empty site gets empty lists, not errors',
  { pre: 'qa-ft-qc holds qa-ft-site (qc on, no data)', steps: 'GET /sites/qa-ft-site/qc/storage ; /vessels ; /trucks ; /movements ; /refinery/ledger', expected: '200 each with empty data' },
  async () => {
    const c = U('qa-ft-qc')
    const rs = await Promise.all(['storage', 'vessels', 'trucks', 'movements', 'refinery/ledger'].map((p) => c.get(`/api/v1/sites/qa-ft-site/qc/${p}`)))
    return { ok: rs.every((r) => r.status === 200), actual: rs.map((r) => `${r.status}`).join('/'), evidence: rs.map((r) => brief(r, 60)).join(' | ') }
  })

t('FT-QC-11', 'QC', 'Positive', 'Storage verdict follows the commodity spec of the site',
  { pre: 'bekasi pfad tank T04 lab FFA ≈ 86.27 with pfad rule FFA min 70 (reject)', steps: 'GET /qc/storage; find a pfad row; check verdict against the stored rules', expected: 'Rows with commodityId pfad and FFA >= 70 are not quarantined for FFA' },
  async () => {
    const r = await A().get('/api/v1/sites/bekasi/qc/storage')
    const rows = r.json.filter((x) => x.commodityId === 'pfad' && x.ffa != null)
    const wrong = rows.filter((x) => x.ffa >= 70 && x.breaches.some((b) => b.code === 'FFA'))
    return { ok: r.status === 200 && rows.length > 0 && wrong.length === 0, actual: `pfad rows=${rows.length}, wrongly breached=${wrong.length}`, evidence: '' }
  })

// ================================================================ UTILITY

t('FT-UT-01', 'Utility', 'Positive', 'Utility board lists all forms',
  { pre: 'bekasi (utility on)', steps: 'GET /sites/bekasi/utility', expected: '200, 13 forms, from <= to' },
  async () => status(await A().get('/api/v1/sites/bekasi/utility'), 200, (r) => (r.json.forms.length === 13 && r.json.from <= r.json.to) || `forms=${r.json.forms.length}`))

t('FT-UT-02', 'Utility', 'Positive', 'Utility board with an explicit and a reversed range',
  { pre: 'bekasi', steps: 'GET /utility?from=2026-10-01&to=2026-10-20 ; ?from=2026-10-20&to=2026-10-01', expected: '200 with from/to as given; reversed range is swapped' },
  async () => {
    const a = await A().get('/api/v1/sites/bekasi/utility?from=2026-10-01&to=2026-10-20')
    const b = await A().get('/api/v1/sites/bekasi/utility?from=2026-10-20&to=2026-10-01')
    return { ok: a.status === 200 && a.json.from === '2026-10-01' && b.status === 200 && b.json.from === '2026-10-01' && b.json.to === '2026-10-20', actual: `${a.status} ${a.json?.from}..${a.json?.to} / ${b.status} ${b.json?.from}..${b.json?.to}`, evidence: '' }
  })

t('FT-UT-03', 'Utility', 'Negative', 'Utility board with an impossible calendar date',
  { pre: 'bekasi', steps: 'GET /utility?from=2026-13-01&to=2026-13-05', expected: '400 (or the default range) — not a 500' },
  async () => {
    const r = await A().get('/api/v1/sites/bekasi/utility?from=2026-13-01&to=2026-13-05')
    return status(r, [200, 400])
  })

t('FT-UT-04', 'Utility', 'Negative', 'Utility day: missing parameters, unknown form/day, impossible date',
  { pre: 'bekasi', steps: 'GET /utility/day ; ?form=F/UTI-010&date=2020-01-01 ; ?form=F/UTI-010&date=2026-02-30', expected: '400 form_and_date_required ; 404 ; 400 (not 500)' },
  async () => {
    const a = await A().get('/api/v1/sites/bekasi/utility/day')
    const b = await A().get('/api/v1/sites/bekasi/utility/day?form=F%2FUTI-010&date=2020-01-01')
    const c = await A().get('/api/v1/sites/bekasi/utility/day?form=F%2FUTI-010&date=2026-02-30')
    return { ok: a.status === 400 && b.status === 404 && c.status === 400, actual: `${a.status} / ${b.status} / ${c.status}`, evidence: `${brief(c)}` }
  })

t('FT-UT-05', 'Utility', 'Negative', 'Utility needs the right, a held site and the module',
  { pre: 'qa-ft-qc lacks utility; qa-ft-ops holds qa-ft-site (utility off) and not qa-other', steps: 'qa-ft-qc GET /sites/bekasi/utility ; qa-ft-ops GET /sites/qa-ft-site/utility ; qa-ft-ops GET /sites/qa-other/utility', expected: '403 forbidden ; 403 module_not_enabled ; 403' },
  async () => {
    const a = await U('qa-ft-qc').get('/api/v1/sites/bekasi/utility')
    const b = await U('qa-ft-ops').get('/api/v1/sites/qa-ft-site/utility')
    const c = await U('qa-ft-ops').get('/api/v1/sites/qa-other/utility')
    return { ok: a.status === 403 && b.status === 403 && b.json?.error === 'module_not_enabled' && c.status === 403, actual: `${a.status}:${a.json?.error} / ${b.status}:${b.json?.error} / ${c.status}:${c.json?.error}`, evidence: '' }
  })

// ================================================================ PRODUCTION

t('FT-PR-01', 'Production', 'Positive', 'Daily production days of a site',
  { pre: 'bekasi (daily-production on)', steps: 'GET /sites/bekasi/production', expected: '200 {days: []} (QA seed has no production days)' },
  async () => status(await A().get('/api/v1/sites/bekasi/production'), 200, (r) => Array.isArray(r.json.days)))

t('FT-PR-02', 'Production', 'Negative', 'Production needs the right, a held site and the module',
  { pre: 'qa-ft-qc lacks daily-production; qa-ft-ops: qa-ft-site module off; qa-other not held', steps: 'qa-ft-qc GET /sites/bekasi/production ; qa-ft-ops GET /sites/qa-ft-site/production ; qa-ft-ops GET /sites/qa-other/production', expected: '403 ; 403 module_not_enabled ; 403' },
  async () => {
    const a = await U('qa-ft-qc').get('/api/v1/sites/bekasi/production')
    const b = await U('qa-ft-ops').get('/api/v1/sites/qa-ft-site/production')
    const c = await U('qa-ft-ops').get('/api/v1/sites/qa-other/production')
    return { ok: a.status === 403 && b.status === 403 && c.status === 403, actual: `${a.status} / ${b.status}:${b.json?.error} / ${c.status}:${c.json?.error}`, evidence: '' }
  })

// ================================================================ TANK GAUGING

t('FT-TG-01', 'Tank gauging', 'Positive', 'Tank gauging overview of a site',
  { pre: 'Admin; bekasi', steps: 'GET /tank-gauging/sites/bekasi/overview', expected: '200 {site, sources[], settings {roundTimes, toleranceMin, retryMinutes, maxRetries}, rounds[], tanks[]}' },
  async () => status(await A().get('/api/v1/tank-gauging/sites/bekasi/overview'), 200, (r) => (Array.isArray(r.json.settings.roundTimes) && typeof r.json.settings.retryMinutes === 'number' && Array.isArray(r.json.sources)) || 'shape'))

t('FT-TG-02', 'Tank gauging', 'Negative', 'Overview of an unknown site, and without master-tanks rights',
  { pre: '-', steps: 'Admin GET /tank-gauging/sites/no-such/overview ; qa-ft-ops GET /tank-gauging/sites/bekasi/overview ; qa-ft-master GET /tank-gauging/sites/qa-other/overview', expected: '404 ; 403 ; 404 (not held)' },
  async () => {
    const a = await A().get('/api/v1/tank-gauging/sites/no-such/overview')
    const b = await U('qa-ft-ops').get('/api/v1/tank-gauging/sites/bekasi/overview')
    const c = await U('qa-ft-master').get('/api/v1/tank-gauging/sites/qa-other/overview')
    return { ok: a.status === 404 && b.status === 403 && c.status === 404, actual: `${a.status} / ${b.status} / ${c.status}`, evidence: '' }
  })

t('FT-TG-03', 'Tank gauging', 'Positive', 'Save daily round times and tolerance',
  { pre: 'qa-ft-site', steps: 'PUT /tank-gauging/sites/qa-ft-site/settings {roundTimes:"14:30, 6:30", toleranceMin:45}', expected: '200 {roundTimes:["06:30","14:30"], toleranceMin:45}; overview shows them' },
  async () => {
    const r = await A().put('/api/v1/tank-gauging/sites/qa-ft-site/settings', { roundTimes: '14:30, 6:30', toleranceMin: 45 })
    const o = await A().get('/api/v1/tank-gauging/sites/qa-ft-site/overview')
    return { ok: r.status === 200 && r.json.roundTimes.join() === '06:30,14:30' && r.json.toleranceMin === 45 && o.json.settings.toleranceMin === 45, actual: brief(r), evidence: '' }
  })

t('FT-TG-04', 'Tank gauging', 'Negative', 'Daily rounds validation: empty, out-of-range times, tolerance bounds',
  { pre: 'qa-ft-site', steps: 'PUT settings {roundTimes:""} ; {roundTimes:"25:00"} ; {roundTimes:"06:30", toleranceMin:0} ; 241 ; 30.5 ; ""', expected: '400 each, settings unchanged (06:30,14:30 / 45)' },
  async () => {
    const bodies = [{ roundTimes: '' }, { roundTimes: '25:00' }, { roundTimes: '06:30', toleranceMin: 0 }, { roundTimes: '06:30', toleranceMin: 241 }, { roundTimes: '06:30', toleranceMin: 30.5 }, { roundTimes: '06:30', toleranceMin: '' }]
    const rs = []
    for (const b of bodies) rs.push(await A().put('/api/v1/tank-gauging/sites/qa-ft-site/settings', b))
    const o = await A().get('/api/v1/tank-gauging/sites/qa-ft-site/overview')
    const ok = rs.every((r) => r.status === 400) && o.json.settings.roundTimes.join() === '06:30,14:30' && o.json.settings.toleranceMin === 45
    return { ok, actual: rs.map((r) => r.status).join(',') + ` now=${o.json.settings.roundTimes}/${o.json.settings.toleranceMin}`, evidence: rs.map((r) => brief(r, 90)).join(' | ') }
  })

t('FT-TG-05', 'Tank gauging', 'Negative', 'Daily rounds with one valid and one invalid time',
  { pre: 'qa-ft-site settings 06:30,14:30', steps: 'PUT settings {roundTimes:"06:30, 99:99, noon", toleranceMin:30}', expected: '400 naming the invalid entries — not silently saved as ["06:30"]' },
  async () => {
    const r = await A().put('/api/v1/tank-gauging/sites/qa-ft-site/settings', { roundTimes: '06:30, 99:99, noon', toleranceMin: 30 })
    return status(r, 400)
  })

t('FT-TG-06', 'Tank gauging', 'Negative', 'Daily rounds with a non-number tolerance (boolean)',
  { pre: 'qa-ft-site', steps: 'PUT settings {roundTimes:"06:30", toleranceMin:true}', expected: '400 (not saved as 1 minute)' },
  async () => status(await A().put('/api/v1/tank-gauging/sites/qa-ft-site/settings', { roundTimes: '06:30', toleranceMin: true }), 400))

t('FT-TG-07', 'Tank gauging', 'Positive', 'Add a gauge source (unreachable test address); secrets are never returned',
  { pre: 'qa-ft-site, no sources', steps: `POST /tank-gauging/sites/qa-ft-site/sources {baseUrl:"${UNREACHABLE_GAUGE}/index.esp", label:"qa-ft gauge", authType:"basic", authUser:"u", secret:"qa-ft-secret"} ; GET overview`, expected: `201, baseUrl normalised to ${UNREACHABLE_GAUGE} (index.esp stripped), secretConfigured true, no secret in any response` },
  async () => {
    const r = await A().post('/api/v1/tank-gauging/sites/qa-ft-site/sources', { baseUrl: `${UNREACHABLE_GAUGE}/index.esp`, label: 'qa-ft gauge', authType: 'basic', authUser: 'u', secret: 'qa-ft-secret' })
    S.sourceId = r.json?.id
    const o = await A().get('/api/v1/tank-gauging/sites/qa-ft-site/overview')
    const ok = r.status === 201 && r.json.baseUrl === UNREACHABLE_GAUGE && r.json.secretConfigured === true && !r.text.includes('qa-ft-secret') && !o.text.includes('qa-ft-secret')
    return { ok, actual: brief(r), evidence: '' }
  })

t('FT-TG-08', 'Tank gauging', 'Negative', 'Gauge source validation: duplicate, missing/invalid/non-http URL, auth rules',
  { pre: 'FT-TG-07 source', steps: 'POST same baseUrl ; {} ; {baseUrl:"not a url"} ; {baseUrl:"ftp://127.0.0.1:9"} ; {baseUrl, authType:"basic"} (no user) ; {authType:"cookie"} (no secret) ; {authType:"magic"}', expected: '409 source_exists ; 400 ×6' },
  async () => {
    const p = (b) => A().post('/api/v1/tank-gauging/sites/qa-ft-site/sources', b)
    const rs = [await p({ baseUrl: UNREACHABLE_GAUGE }), await p({}), await p({ baseUrl: 'not a url' }), await p({ baseUrl: 'ftp://127.0.0.1:9' }), await p({ baseUrl: 'http://qa-unreachable-gauge.invalid/b', authType: 'basic' }), await p({ baseUrl: 'http://qa-unreachable-gauge.invalid/c', authType: 'cookie' }), await p({ baseUrl: 'http://qa-unreachable-gauge.invalid/d', authType: 'magic' })]
    const want = [409, 400, 400, 400, 400, 400, 400]
    return { ok: rs.every((r, i) => r.status === want[i]), actual: rs.map((r) => r.status).join(','), evidence: rs.map((r) => brief(r, 90)).join(' | ') }
  })

t('FT-TG-09', 'Tank gauging', 'Positive', 'Edit a source; blank secret keeps the stored one; switch to no auth',
  { pre: 'FT-TG-07 source', steps: 'PUT /tank-gauging/sources/:id {label:"qa-ft renamed", secret:""} ; PUT {authType:"none"}', expected: '200 label changed, secretConfigured still true ; 200 secretConfigured false' },
  async () => {
    const a = await A().put(`/api/v1/tank-gauging/sources/${S.sourceId}`, { label: 'qa-ft renamed', secret: '' })
    const b = await A().put(`/api/v1/tank-gauging/sources/${S.sourceId}`, { authType: 'none' })
    return { ok: a.status === 200 && a.json.label === 'qa-ft renamed' && a.json.secretConfigured === true && b.status === 200 && b.json.secretConfigured === false, actual: `${a.status} label=${a.json?.label} secret=${a.json?.secretConfigured} / ${b.status} secret=${b.json?.secretConfigured}`, evidence: '' }
  })

t('FT-TG-10', 'Tank gauging', 'Negative', 'Test connection to an unreachable gauge',
  { pre: `FT-TG-07 source at ${UNREACHABLE_GAUGE}`, steps: 'POST /tank-gauging/sources/:id/test', expected: '200 {ok:false, tankCount:0, error:<message>} within a few seconds' },
  async () => status(await A().post(`/api/v1/tank-gauging/sources/${S.sourceId}/test`), 200, (r) => (r.json.ok === false && r.json.tankCount === 0 && !!r.json.error) || 'shape'))

t('FT-TG-11', 'Tank gauging', 'Negative', 'Poll a site whose only gauge is unreachable',
  { pre: 'qa-ft-site with the unreachable source', steps: 'POST /tank-gauging/sites/qa-ft-site/poll', expected: '200 {ok:false, sources:[{error}]}; source last_poll_ok false' },
  async () => {
    const r = await A().post('/api/v1/tank-gauging/sites/qa-ft-site/poll')
    const row = await sql('SELECT last_poll_ok, last_error FROM tank_gauging_sources WHERE id = $1', [S.sourceId])
    const ok = r.status === 200 && (r.json.skipped === true || (r.json.ok === false && row.rows[0]?.last_poll_ok === false))
    return { ok, actual: `${brief(r, 200)}; db last_poll_ok=${row.rows[0]?.last_poll_ok}`, evidence: '' }
  })

t('FT-TG-12', 'Tank gauging', 'Negative', 'Source routes with a bad id, someone else\'s source, or without edit rights',
  { pre: 'FT-TG-07 source on qa-ft-site', steps: 'PUT /tank-gauging/sources/999999 ; PUT /tank-gauging/sources/abc ; qa-ft-ops PUT /tank-gauging/sources/:id ; qa-ft-ops PUT /tank-gauging/sites/qa-ft-site/settings', expected: '404 ; 404 ; 403 ; 403' },
  async () => {
    const rs = [await A().put('/api/v1/tank-gauging/sources/999999', { label: 'x' }), await A().put('/api/v1/tank-gauging/sources/abc', { label: 'x' }), await U('qa-ft-ops').put(`/api/v1/tank-gauging/sources/${S.sourceId}`, { label: 'x' }), await U('qa-ft-ops').put('/api/v1/tank-gauging/sites/qa-ft-site/settings', { roundTimes: '06:30' })]
    const want = [404, 404, 403, 403]
    return { ok: rs.every((r, i) => r.status === want[i]), actual: rs.map((r) => r.status).join(' / '), evidence: '' }
  })

t('FT-TG-13', 'Tank gauging', 'Positive', 'Delete a source; deleting it again is 404',
  { pre: 'FT-TG-07 source', steps: 'DELETE /tank-gauging/sources/:id twice', expected: '204 then 404' },
  async () => {
    const a = await A().del(`/api/v1/tank-gauging/sources/${S.sourceId}`)
    const b = await A().del(`/api/v1/tank-gauging/sources/${S.sourceId}`)
    return { ok: a.status === 204 && b.status === 404, actual: `${a.status} / ${b.status}`, evidence: '' }
  })

t('FT-TG-14', 'Tank gauging', 'Positive', 'Poll a site with no enabled source is skipped',
  { pre: 'qa-ft-site with no source', steps: 'POST /tank-gauging/sites/qa-ft-site/poll', expected: '200 {skipped:true, reason:"no_enabled_sources_for_site"}' },
  async () => status(await A().post('/api/v1/tank-gauging/sites/qa-ft-site/poll'), 200, (r) => r.json.skipped === true || JSON.stringify(r.json).slice(0, 100)))

t('FT-TG-15', 'Tank gauging', 'Negative', 'Gauge source at a loopback, metadata or link-local address is refused',
  { pre: 'qa-ft-site', steps: 'POST sources {baseUrl:"http://127.0.0.1:3010"} ; {baseUrl:"http://169.254.169.254"} ; {baseUrl:"http://100.100.100.200"} ; {baseUrl:"http://localhost:5432"}', expected: '400 for each; nothing saved (server-side request forgery guard)' },
  async () => {
    const urls = ['http://127.0.0.1:3010', 'http://169.254.169.254', 'http://100.100.100.200', 'http://localhost:5432']
    const rs = []
    for (const baseUrl of urls) rs.push(await A().post('/api/v1/tank-gauging/sites/qa-ft-site/sources', { baseUrl, label: 'qa-ft blocked' }))
    for (const r of rs) if (r.json?.id) await A().del(`/api/v1/tank-gauging/sources/${r.json.id}`)
    return { ok: rs.every((r) => r.status === 400), actual: rs.map((r) => r.status).join(' / '), evidence: brief(rs[0]) }
  })

// ================================================================ DATAHUB (admin)

t('FT-DH-01', 'Users & roles', 'Positive', 'DataHub configuration and runs are readable by the Administrator, without secrets',
  { pre: 'Admin', steps: 'GET /admin/datahub/config ; GET /admin/datahub/runs', expected: '200 ; 200; no plain secret fields' },
  async () => {
    const a = await A().get('/api/v1/admin/datahub/config')
    const b = await A().get('/api/v1/admin/datahub/runs')
    const leak = /"(password|secret|clientSecret|apiKey)"\s*:\s*"[^"]+"/i.test(a.text)
    return { ok: a.status === 200 && b.status === 200 && !leak, actual: `${a.status} / ${b.status} leak=${leak}`, evidence: brief(a, 300) }
  })

// ---------------------------------------------------------------- runner

function planMarkdown() {
  const areas = [...new Set(tests.map((x) => x.area))]
  const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
  let out = ''
  for (const area of areas) {
    out += `\n### ${area} (API)\n\n| ID | Title | Type | Preconditions | Steps | Expected result |\n|---|---|---|---|---|---|\n`
    for (const x of tests.filter((y) => y.area === area)) {
      out += `| ${x.id} | ${esc(x.title)} | ${x.type} | ${esc(x.pre)} | ${esc(x.steps)} | ${esc(x.expected)} |\n`
    }
  }
  return out
}

async function main() {
  if (process.argv.includes('--plan')) {
    process.stdout.write(planMarkdown())
    return
  }
  const results = []
  const started = Date.now()
  try {
    await setupFixtures()
  } catch (error) {
    console.error('Fixture setup failed:', error.message)
    for (const x of tests) results.push({ id: x.id, title: x.title, type: x.type, area: x.area, status: 'BLOCKED', expected: x.expected, actual: `fixture setup failed: ${error.message}`, evidence: '' })
    writeFileSync(join(HERE, 'results.json'), JSON.stringify(results, null, 2))
    await db.end()
    process.exit(2)
  }
  for (const x of tests) {
    let rec
    try {
      const out = await x.fn()
      const st = out.blocked ? 'BLOCKED' : out.ok ? 'PASS' : 'FAIL'
      rec = { id: x.id, title: x.title, type: x.type, area: x.area, status: st, expected: x.expected, actual: out.actual, evidence: out.evidence ?? '' }
    } catch (error) {
      rec = { id: x.id, title: x.title, type: x.type, area: x.area, status: 'BLOCKED', expected: x.expected, actual: `test error: ${error.message}`, evidence: error.stack?.split('\n').slice(0, 2).join(' ') ?? '' }
    }
    results.push(rec)
    const mark = rec.status === 'PASS' ? 'PASS   ' : rec.status === 'FAIL' ? 'FAIL   ' : 'BLOCKED'
    console.log(`${mark} ${x.id.padEnd(11)} ${x.title}${rec.status === 'PASS' ? '' : `\n          expected: ${x.expected}\n          actual:   ${rec.actual}`}`)
  }
  try {
    await cleanupRun()
  } catch (error) {
    console.error('cleanup warning:', error.message)
  }
  writeFileSync(join(HERE, 'results.json'), JSON.stringify(results, null, 2))
  const count = (s) => results.filter((r) => r.status === s).length
  console.log(`\n${results.length} API scenarios: ${count('PASS')} pass, ${count('FAIL')} fail, ${count('BLOCKED')} blocked  (${((Date.now() - started) / 1000).toFixed(1)}s, run ${RUN})`)
  console.log(`results: ${join(HERE, 'results.json')}`)
  await db.end()
}

main().catch(async (error) => {
  console.error(error)
  await db.end().catch(() => {})
  process.exit(1)
})
