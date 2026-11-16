import assert from 'node:assert/strict'
import test from 'node:test'
import { canGrantRole, normalizePermissionList, permissionsWithin } from './access.js'
import { LoginThrottle } from './loginThrottle.js'
import { HubTokenReplayGuard } from './sso/replay-guard.js'
import { nonceMatches, verifierForCallback } from './sso/oidc-flow.js'

const userManager = {
  isAdministrator: false,
  permissions: {
    'admin-users': { view: true, edit: true, delete: false },
    'live-ops': { view: true, edit: false, delete: false },
  },
}

test('edit or delete implies view, and empty entries are dropped', () => {
  assert.deepEqual(
    normalizePermissionList([
      { resourceKey: 'qc', edit: true },
      { resourceKey: 'utility' },
      { resourceKey: 'live-ops', delete: true },
      { nope: true },
    ]),
    {
      qc: { view: true, edit: true, delete: false },
      'live-ops': { view: true, edit: false, delete: true },
    },
  )
})

test('rights are within when every requested flag is held', () => {
  assert.equal(permissionsWithin({ 'live-ops': { view: true } }, userManager.permissions), true)
  assert.equal(permissionsWithin({}, userManager.permissions), true)
  assert.equal(permissionsWithin({ 'live-ops': { view: true, edit: true } }, userManager.permissions), false)
  assert.equal(permissionsWithin({ qc: { view: true } }, userManager.permissions), false)
})

test('a user manager cannot hand out the Administrator role', () => {
  const administrator = { isAdministratorRole: true, permissions: {} }
  assert.equal(canGrantRole(userManager, administrator), false)
})

test('a user manager cannot hand out a role with rights they lack', () => {
  const roleAdmin = { isAdministratorRole: false, permissions: { 'admin-roles': { view: true, edit: true } } }
  assert.equal(canGrantRole(userManager, roleAdmin), false)
})

test('a user manager can hand out a role inside their own rights', () => {
  const viewer = { isAdministratorRole: false, permissions: { 'live-ops': { view: true } } }
  assert.equal(canGrantRole(userManager, viewer), true)
})

test('an Administrator can hand out any role, and an unknown role is refused to others', () => {
  assert.equal(canGrantRole({ isAdministrator: true, permissions: {} }, { isAdministratorRole: true }), true)
  assert.equal(canGrantRole(userManager, undefined), false)
})

test('login throttle locks an account after the limit and frees it after the window', () => {
  let now = 0
  const throttle = new LoginThrottle({ maxFailures: 3, windowMs: 1000, now: () => now })
  for (let i = 0; i < 3; i += 1) {
    assert.equal(throttle.allowed('Admin'), true)
    throttle.fail('admin ')
  }
  assert.equal(throttle.allowed('ADMIN'), false)
  assert.equal(throttle.allowed('someone-else'), true)
  now = 1000
  assert.equal(throttle.allowed('admin'), true)
})

test('a successful login clears the failure count', () => {
  const throttle = new LoginThrottle({ maxFailures: 2 })
  throttle.fail('ops')
  throttle.succeed('ops')
  throttle.fail('ops')
  assert.equal(throttle.allowed('ops'), true)
})

test('a Hub token signs in once, and is forgotten after it expires', () => {
  let now = 0
  const guard = new HubTokenReplayGuard({ now: () => now })
  assert.equal(guard.claim('token-a', 60), true)
  assert.equal(guard.claim('token-a', 60), false)
  assert.equal(guard.claim('token-b', 60), true)
  now = 61_000
  guard.prune(now)
  assert.equal(guard.used.size, 0)
})

test('the OIDC callback needs the flow cookie from the same browser', () => {
  const flow = { state: 'abc123', verifier: 'v-1', nonce: 'n-1' }
  assert.equal(verifierForCallback(flow, 'abc123'), 'v-1')
  assert.equal(verifierForCallback(flow, 'abc124'), null)
  assert.equal(verifierForCallback(flow, 'abc'), null)
  assert.equal(verifierForCallback(null, 'abc123'), null)
  assert.equal(verifierForCallback({ state: 'abc123' }, 'abc123'), null)
})

test('an id_token nonce must match the flow, and a missing one is accepted', () => {
  const flow = { nonce: 'n-1' }
  assert.equal(nonceMatches(flow, { nonce: 'n-1' }), true)
  assert.equal(nonceMatches(flow, { nonce: 'n-2' }), false)
  assert.equal(nonceMatches(flow, {}), true)
  assert.equal(nonceMatches({}, { nonce: 'n-1' }), false)
})
