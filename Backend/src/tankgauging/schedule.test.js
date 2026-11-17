import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchArchiveTankData, parseArchiveConfig, parseArchivePoints } from './client.js'
import { archiveParamFor, cleanValues, nearestPoint, toRoundUnit, writeArchiveRounds } from './archive.js'
import { isStale, lastRoundDue } from './live.js'
import { roundSlots } from './rounds.js'
import { afterAttempt, dueRounds, retryPolicy } from './schedule.js'
import { summariseSite } from '../domain/portfolio.js'

const reply = (body, status = 200) => ({ ok: status < 300, status, text: async () => body, headers: { getSetCookie: () => [] } })

// Shapes taken from live units (DATATYPE=18 and 29), with made-up numbers.
const archivePoints = (id, points, unit = 'Ton') =>
  JSON.stringify({
    parameterlist: points.map(([value, iso, status = 'INIT']) => ({
      id,
      value,
      valueString: `+${value}`,
      unit,
      timestamp: new Date(iso).getTime() / 1000,
      localtimestamp: new Date(iso).getTime() / 1000 + 8 * 3600,
      statusId: 675,
      statusString: status,
    })),
  })

test('an archive call names the tank, the parameter and the window in Unix seconds', async () => {
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(String(url))
    return reply('{"parameterlist": []}')
  }
  const window = { tankId: 3, paramId: 730, from: '2026-11-01T06:20:00Z', to: '2026-11-01T06:40:00Z', fetchImpl, cookie: '' }
  await fetchArchiveTankData({ ...window, baseUrl: 'http://unit.test' })
  const direct = new URL(urls[0])
  assert.equal(direct.pathname, '/GWTHandler.esp')
  assert.equal(direct.searchParams.get('DATATYPE'), '18')
  assert.equal(direct.searchParams.get('ID'), '3')
  assert.equal(direct.searchParams.get('PARAMID'), '730')
  assert.equal(direct.searchParams.get('STARTTIME'), String(Date.parse('2026-11-01T06:20:00Z') / 1000))
  assert.equal(direct.searchParams.get('ENDTIME'), String(Date.parse('2026-11-01T06:40:00Z') / 1000))

  await fetchArchiveTankData({ ...window, baseUrl: 'http://gateway.test', tunnelIp: '192.168.5.1' })
  const tunnel = new URL(urls[1])
  assert.equal(tunnel.pathname, '/WebServerTunnel.esp', 'a unit behind a gateway is reached through its tunnel')
  assert.equal(tunnel.searchParams.get('URL'), 'GWTHandler.esp')
  assert.equal(tunnel.searchParams.get('REMOTEIP'), '192.168.5.1')
  assert.equal(tunnel.searchParams.get('DATATYPE'), '18')
})

test('archive replies parse into points and archived parameter ids', () => {
  const points = parseArchivePoints(archivePoints(730, [[2827.249, '2026-11-17T03:10:00Z']]))
  assert.equal(points.length, 1)
  assert.equal(points[0].value, 2827.249)
  assert.equal(points[0].at.toISOString(), '2026-11-17T03:10:00.000Z', 'timestamp is UTC; localtimestamp is ignored')
  assert.deepEqual(parseArchivePoints('not json'), [])
  const config = parseArchiveConfig(JSON.stringify({ archiveConfiguration: { tanks: [{ id: 1, parameters: [{ id: 622 }, { id: 729 }, { id: 726 }] }] } }))
  assert.deepEqual([...config.get(1)], [622, 729, 726])
})

test('a tank is read under the ids it archives, total mass first, product mass otherwise', () => {
  assert.equal(archiveParamFor([730, 729], new Set([622, 730])), 730)
  assert.equal(archiveParamFor([730, 729], new Set([622, 729])), 729)
  assert.equal(archiveParamFor([717, 726], new Set([622])), null)
  assert.equal(archiveParamFor([730, 729], null), 730, 'a unit that does not say gets the usual id')
})

test('archived values come in the round units, and a strange unit is not guessed', () => {
  assert.equal(toRoundUnit('volumeLitre', { value: 210.3, unit: 'm³' }), 210300)
  assert.equal(toRoundUnit('volumeLitre', { value: 210316, unit: 'L' }), 210316)
  assert.equal(toRoundUnit('massTon', { value: 4673.639, unit: 'Ton' }), 4673.639)
  assert.equal(toRoundUnit('massTon', { value: 5000, unit: 'kg' }), 5)
  assert.equal(toRoundUnit('levelMm', { value: 867, unit: 'mm' }), 867)
  assert.equal(toRoundUnit('volumeLitre', { value: 1, unit: 'bbl' }), null)
  assert.deepEqual(cleanValues({ massTon: -1, densityKgM3: -1, volumeLitre: 5, levelMm: 1 }), { massTon: null, densityKgM3: null, volumeLitre: 5, levelMm: 1 })
})

test('the nearest good archived point within the tolerance is used', () => {
  const target = new Date('2026-11-01T22:30:00Z')
  const points = parseArchivePoints(
    archivePoints(622, [
      [100, '2026-11-01T22:21:00Z'],
      [101, '2026-11-01T22:29:00Z', 'NO DATA'],
      [102, '2026-11-01T22:33:00Z'],
      [103, '2026-11-01T23:30:00Z'],
    ]),
  )
  assert.equal(nearestPoint(points, target, 30).value, 102, 'a value the unit marks as no data is skipped')
  assert.equal(nearestPoint(points, target, 2), null)
})

test('the schedule attempts a passed round once, then retries every 20 minutes up to 6 times', () => {
  const policy = { retryMinutes: 20, maxRetries: 6 }
  const slots = roundSlots(['2026-11-17'], ['06:30', '14:30'], 'Asia/Makassar', new Date('2026-11-16T22:40:00Z'))
  assert.equal(slots.length, 1, 'only 06:30 has passed at 06:40 Bontang time')

  const now = new Date('2026-11-16T22:40:00Z')
  assert.equal(dueRounds(slots, new Map(), now).length, 1, 'never tried: due')

  let run = null
  const states = []
  for (let i = 0; i < 7; i += 1) {
    const state = afterAttempt(run, false, now, policy)
    states.push(state.status)
    run = { attempts: state.attempts, status: state.status, next_attempt_at: state.nextAttemptAt }
  }
  assert.deepEqual(states, ['retrying', 'retrying', 'retrying', 'retrying', 'retrying', 'retrying', 'failed'], 'the first try and 6 retries')
  assert.equal(afterAttempt(null, false, now, policy).nextAttemptAt.toISOString(), '2026-11-16T23:00:00.000Z')
  assert.equal(afterAttempt({ attempts: 3 }, true, now, policy).status, 'ok')

  const key = '2026-11-17|1'
  const waiting = new Map([[key, { status: 'retrying', next_attempt_at: '2026-11-16T23:00:00Z' }]])
  assert.equal(dueRounds(slots, waiting, now).length, 0, 'a retry waits for its time')
  assert.equal(dueRounds(slots, waiting, new Date('2026-11-16T23:01:00Z')).length, 1)
  assert.equal(dueRounds(slots, new Map([[key, { status: 'ok' }]]), now).length, 0)
  assert.equal(dueRounds(slots, new Map([[key, { status: 'failed' }]]), now).length, 0, 'a round out of retries is left alone')

  assert.deepEqual(retryPolicy({}), { retryMinutes: 20, maxRetries: 6 })
  assert.deepEqual(retryPolicy({ TANK_GAUGING_RETRY_MINUTES: '10', TANK_GAUGING_MAX_RETRIES: '3' }), { retryMinutes: 10, maxRetries: 3 })
})

test('a gauge reading is old only when the last round time passed without a poll', () => {
  const times = ['06:30', '14:30']
  // 12:00 in Bontang: the last round was 06:30 today.
  const due = lastRoundDue('Asia/Makassar', times, new Date('2026-11-17T04:00:00Z'))
  assert.equal(due.toISOString(), '2026-11-16T22:30:00.000Z')
  const now = new Date('2026-11-17T04:00:00Z')
  assert.equal(isStale({ fetched_at: '2026-11-16T22:35:00Z', stale_before: due }, now), false, 'read at 06:35, five hours ago, still current')
  assert.equal(isStale({ fetched_at: '2026-11-16T06:35:00Z', stale_before: due }, now), true, 'the 06:30 poll did not get through')
  // 06:45: the 06:30 poll still has its grace time, so yesterday's 14:30 reading is not old yet.
  assert.equal(lastRoundDue('Asia/Makassar', times, new Date('2026-11-16T22:45:00Z')).toISOString(), '2026-11-16T06:30:00.000Z')
})

test('a gauged site is stale when every tank says its last round was missed', () => {
  const site = { id: 'bontang', name: 'BONTANG', timezone: 'Asia/Makassar' }
  const tank = (id, stale) => ({ tankId: id, quantityKg: 100, capacityKg: 1000, readingKind: 'live', readingAt: '2026-11-16T22:35:00Z', stale })
  const now = new Date('2026-11-17T04:00:00Z')
  assert.equal(summariseSite(site, [tank('1', false), tank('2', false)], { day: '2026-11-17', live: true, now }).stale, false, 'five hours old but on schedule')
  assert.equal(summariseSite(site, [tank('1', true), tank('2', true)], { day: '2026-11-17', live: true, now }).stale, true)
})

test('rounds are read from the archive at the round time, through the gateway, one unit at a time', async () => {
  const target = new Date('2026-11-01T23:30:00Z') // 06:30 in Tanjung Pura
  const inserted = []
  const db = {
    async query(sql, params) {
      if (sql.includes('FROM tank_gauging_tank_map')) {
        return {
          rows: [
            { tank_id: 'tp-5101', source_base_url: 'http://gateway.test', source_unit_name: 'TS-01', external_tank_id: 1 },
            { tank_id: 'tp-3104', source_base_url: 'http://gateway.test', source_unit_name: 'TS-02', external_tank_id: 1 },
            { tank_id: 'tp-gone', source_base_url: 'http://removed.test', source_unit_name: 'TS-09', external_tank_id: 4 },
          ],
        }
      }
      if (sql.includes('FROM tank_gauging_latest')) return { rows: [{ tank_id: 'tp-5101', product_name: 'CPO' }] }
      if (sql.includes('FROM tank_gauging_sources')) return { rows: [{ id: 8, site_id: 'tanjung-pura', base_url: 'http://gateway.test', label: 'NXA_TJP_1', auth_type: 'none' }] }
      if (sql.includes('INSERT INTO soundings')) {
        inserted.push(params)
        return { rowCount: 1 }
      }
      throw new Error(`unexpected query: ${sql}`)
    },
  }
  const urls = []
  const fetchImpl = async (url) => {
    const u = new URL(String(url))
    urls.push(u)
    if (u.pathname === '/index.esp') return reply('')
    const type = u.searchParams.get('DATATYPE')
    if (type === '23') {
      return reply(
        JSON.stringify({
          leftTree: {
            localUnitInfo: [{ unitName: 'TC-01', ipAddress: '192.168.5.4' }],
            units: [
              { id: 0, name: 'TS-01', ipAddress: '192.168.5.1', tanks: [{ id: 1, name: 'TK5101' }] },
              { id: 1, name: 'TS-02', ipAddress: '192.168.5.2', tanks: [{ id: 1, name: 'TK3104' }] },
            ],
          },
        }),
      )
    }
    if (type === '29') {
      return reply(JSON.stringify({ archiveConfiguration: { tanks: [{ id: 1, parameters: [622, 625, 628, 726, 729].map((id) => ({ id })) }] } }))
    }
    const ip = u.searchParams.get('REMOTEIP')
    const param = Number(u.searchParams.get('PARAMID'))
    const at = '2026-11-01T23:27:00Z'
    if (ip === '192.168.5.2') return reply(archivePoints(param, [[0, at, 'NO DATA']]))
    const values = { 622: [16064, 'mm'], 625: [41.9, '°C'], 628: [895.7, 'kg/m³'], 726: [4626586, 'L'], 729: [4253.357, 'Ton'] }
    return reply(archivePoints(param, [[values[param][0], at]], values[param][1]))
  }
  const slot = { date: '2026-11-02', roundIndex: 1, target }
  const result = await writeArchiveRounds(
    db,
    'tanjung-pura',
    [
      { tankId: 'tp-5101', plantId: 'tp-default', slot },
      { tankId: 'tp-3104', plantId: 'tp-default', slot },
      { tankId: 'tp-gone', plantId: 'tp-default', slot },
    ],
    { toleranceMin: 30, fetchImpl },
  )
  assert.deepEqual(result.errors, [])
  assert.equal(result.written, 1)
  assert.equal(result.missing, 2, 'a tank the gauge has nothing for, and a tank on no gauge')
  const data = urls.filter((u) => u.searchParams.get('DATATYPE') === '18')
  assert.ok(data.every((u) => u.pathname === '/WebServerTunnel.esp'))
  assert.ok(data.some((u) => u.searchParams.get('PARAMID') === '729'), 'product mass where total mass is not archived')
  assert.ok(!data.some((u) => u.searchParams.get('PARAMID') === '730'))
  const ts02 = data.filter((u) => u.searchParams.get('REMOTEIP') === '192.168.5.2').map((u) => u.searchParams.get('PARAMID'))
  assert.deepEqual(ts02, ['622', '729'], 'no level and no mass: the rest is not asked for')

  const [siteId, plantId, tankId, date, roundIndex, product, levelM, temperatureC, status, massKg, density, volume, sampledAt] = inserted[0]
  assert.deepEqual([siteId, plantId, tankId, date, roundIndex, product, status], ['tanjung-pura', 'tp-default', 'tp-5101', '2026-11-02', 1, 'CPO', 'ATG'])
  assert.equal(levelM, 16.064)
  assert.equal(temperatureC, 41.9)
  assert.equal(massKg, 4253357)
  assert.equal(density, 895.7)
  assert.equal(volume, 4626586)
  assert.equal(sampledAt.toISOString(), '2026-11-01T23:27:00.000Z', 'the round keeps the time of the archived reading')
})
