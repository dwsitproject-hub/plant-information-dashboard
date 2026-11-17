import assert from 'node:assert/strict'
import test from 'node:test'
import { confirmSiteReplace } from '../scripts/guard.js'
import { gaugeMeta, isStale, liveSounding, staleAfterMinutes } from './tankgauging/live.js'

test('a site reload runs freely in dev and needs the site named anywhere else', () => {
  assert.equal(confirmSiteReplace('seed', 'bekasi', [], { APP_ENV: 'dev' }).ok, true)
  assert.equal(confirmSiteReplace('seed', 'bekasi', [], { APP_ENV: 'testing' }).ok, false)
  assert.equal(confirmSiteReplace('seed', 'bekasi', [], {}).ok, false)
  assert.equal(confirmSiteReplace('seed', 'bekasi', ['--confirm-site=bontang'], { APP_ENV: 'testing' }).ok, false)
  assert.equal(confirmSiteReplace('seed', 'bekasi', ['--confirm-site=bekasi'], { APP_ENV: 'testing' }).ok, true)
  assert.match(confirmSiteReplace('seed', 'bekasi', [], {}).message, /--confirm-site=bekasi/)
})

test('the stale limit defaults to two hours and can be set', () => {
  assert.equal(staleAfterMinutes({}), 120)
  assert.equal(staleAfterMinutes({ TANK_GAUGING_STALE_MINUTES: '30' }), 30)
  assert.equal(staleAfterMinutes({ TANK_GAUGING_STALE_MINUTES: 'nope' }), 120)
})

test('a reading is stale when it was fetched too long ago, or never', () => {
  const now = new Date('2026-11-16T08:00:00Z')
  assert.equal(isStale({ fetched_at: '2026-11-16T07:30:00Z' }, now, 120), false)
  assert.equal(isStale({ fetched_at: '2026-11-16T05:30:00Z' }, now, 120), true)
  assert.equal(isStale({}, now, 120), true)
  // The gauge's own clock is not used: an old value timestamp on a still tank is normal.
  assert.equal(isStale({ fetched_at: '2026-11-16T07:59:00Z', recorded_at: '2026-11-01T00:00:00Z' }, now, 120), false)
})

const reading = (extra = {}) => ({
  id: 'bontang-t1',
  code: 'T1',
  product_name: 'CPO',
  level_mm: 5000,
  temperature_c: 40,
  total_mass: 1200,
  observed_density_kg_m3: 890,
  total_observed_volume: 1_300_000,
  raw_payload: {},
  fetched_at: '2026-11-16T07:55:00Z',
  linked: true,
  ...extra,
})

test('a linked reading counts as live stock', () => {
  const s = liveSounding(reading(), '2026-11-16')
  assert.equal(s.massKg, 1_200_000)
  assert.notEqual(s.operationalStatus, 'NO DATA')
})

test('an old reading keeps its figures; the meta says it is old', () => {
  // Staging 16 Nov 2026: the poller was hours late and every Bontang tank went blank. Keep the last
  // known stock on screen and flag its age instead.
  const old = reading({ fetched_at: '2000-01-01T00:00:00Z' })
  const s = liveSounding(old, '2026-11-16')
  assert.equal(s.massKg, 1_200_000)
  assert.notEqual(s.operationalStatus, 'NO DATA')
  assert.equal(gaugeMeta(old, 'live', old.fetched_at).stale, true)
  assert.equal(gaugeMeta(reading({ fetched_at: new Date().toISOString() }), 'live', null).stale, false)
  assert.equal(gaugeMeta(old, 'round', null).stale, false, 'a daily round is not live, so it is never stale')
})

test('a tank no longer on its gauge shows as NO DATA with no mass', () => {
  const unlinked = liveSounding(reading({ linked: false }), '2026-11-16')
  assert.equal(unlinked.operationalStatus, 'NO DATA')
  assert.equal(unlinked.massKg, null)
})
