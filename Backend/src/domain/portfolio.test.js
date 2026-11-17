import test from 'node:test'
import assert from 'node:assert/strict'
import { commodityClassOf } from './commodityClass.js'
import { daysBetween, isInUse, movementSeries, sameTankDelta, slimQuality, sourceOf, summarisePortfolio, summariseSite, tankStatus } from './portfolio.js'

test('products from every site land in the same few classes', () => {
  const expected = {
    CPO: 'cpo', CPKO: 'cpko', 'CRUDE PALM OIL': 'cpo',
    RBDPO: 'refined', RBDPL: 'refined', OLEIN: 'refined', 'IV 64': 'refined', RPS: 'refined', PMF: 'refined', RBDPKO: 'refined',
    PFAD: 'pfad', PKFAD: 'pkfad', POME: 'pome', RPOME: 'rpome', LIMBAH: 'limbah', SLUDGE: 'sludge',
    FAME: 'fame', FAME_SAMPLE: 'fame', 'FAME ENZYM 3': 'fame',
    CG: 'glycerin', 'CRUDE GLYCERIN': 'glycerin', FM: 'glycerin', 'FATTY MATTER': 'glycerin', 'FM DAILY': 'glycerin',
    METHANOL: 'chemical', 'METHANOL 3': 'chemical', 'CAUSTIC SODA': 'chemical', NAOH: 'chemical', SODIUM: 'chemical', HCL: 'chemical', 'SM PURE 6': 'chemical',
    '': 'other', '-': 'other', MYSTERY: 'other',
  }
  for (const [name, code] of Object.entries(expected)) assert.equal(commodityClassOf(name), code, name)
})

test('RPOME and POME are their own classes, not refined palm oil, and a missing product falls back to the gauge group', () => {
  assert.equal(commodityClassOf('RPOME'), 'rpome')
  assert.equal(commodityClassOf('POME'), 'pome')
  assert.equal(commodityClassOf('CPO'), 'cpo')
  assert.equal(commodityClassOf('', 'RBDPO'), 'refined')
  assert.equal(commodityClassOf(null, 'FAME_DAILY'), 'fame')
})

const tank = (id, quantityKg, capacityKg, extra = {}) => ({
  tankId: id,
  productName: extra.productName ?? 'CPO',
  quantityKg,
  capacityKg,
  fillRatio: quantityKg != null && capacityKg ? quantityKg / capacityKg : null,
  operationalStatus: extra.operationalStatus ?? 'ATG',
  readingAt: extra.readingAt ?? null,
  ...extra,
})

test('a tank is ok, near-full, over, empty or without data, and no data is never empty', () => {
  assert.equal(tankStatus(tank('a', 500, 1000)), 'ok')
  assert.equal(tankStatus(tank('a', 900, 1000)), 'near-full')
  assert.equal(tankStatus(tank('a', 1000, 1000)), 'near-full')
  assert.equal(tankStatus(tank('a', 1100, 1000)), 'over')
  assert.equal(tankStatus(tank('a', 0, 1000)), 'empty')
  assert.equal(tankStatus(tank('a', 60, 1000, { operationalStatus: 'Empty' })), 'empty')
  assert.equal(tankStatus(tank('a', null, 1000)), 'no-data')
  assert.equal(tankStatus(tank('a', 950, 1000), 0.95), 'near-full')
  assert.equal(tankStatus(tank('a', 940, 1000), 0.95), 'ok')
})

const NOW = new Date('2026-11-10T03:00:00Z')
const site = { id: 'bontang', name: 'BONTANG', timezone: 'Asia/Makassar' }

test('a site adds up stock, capacity and fill on the tanks that have both, and counts the rest', () => {
  const tanks = [
    tank('1', 400, 1000, { readingAt: '2026-11-10T02:55:00Z' }),
    tank('2', 950, 1000, { readingAt: '2026-11-10T02:56:00Z' }),
    tank('3', null, 2000, { readingAt: '2026-11-10T02:50:00Z' }),
    tank('4', 100, null, { readingAt: '2026-11-10T02:50:00Z' }),
    tank('5', 0, 500, { productName: 'FAME', readingAt: '2026-11-10T02:50:00Z' }),
  ]
  const s = summariseSite(site, tanks, { day: '2026-11-10', live: true, now: NOW })
  assert.equal(s.quantityKg, 1350, 'tanks without a capacity or a reading are left out of fill')
  assert.equal(s.capacityKg, 2500)
  assert.equal(s.capacityTotalKg, 4500, 'total capacity still includes the tank with no data')
  assert.ok(Math.abs(s.fillRatio - 0.54) < 1e-9)
  assert.equal(s.tanksTotal, 5)
  assert.equal(s.tanksReporting, 4)
  assert.deepEqual(s.counts, { ok: 2, 'near-full': 1, over: 0, empty: 1, 'no-data': 1 })
  assert.deepEqual(s.classes.map((c) => c.code), ['cpo', 'fame'])
  assert.equal(s.kind, 'live')
  assert.equal(s.stale, false)
  assert.equal(s.ageMinutes, 4)
})

test('a live site is stale after an hour, a rounds site after two days', () => {
  const old = summariseSite(site, [tank('1', 1, 10, { readingAt: '2026-11-10T01:00:00Z' })], { day: '2026-11-10', live: true, now: NOW })
  assert.equal(old.stale, true)
  const rounds = summariseSite(site, [tank('1', 1, 10)], { day: '2026-10-13', live: false, now: NOW })
  assert.equal(rounds.stale, true)
  assert.equal(rounds.kind, 'rounds')
  assert.equal(rounds.asOf, '2026-10-13')
  const fresh = summariseSite(site, [tank('1', 1, 10)], { day: '2026-11-09', live: false, now: NOW })
  assert.equal(fresh.stale, false)
})

test('the change since yesterday compares the same tanks, and is left out when too few match', () => {
  const now = [tank('1', 500, 1000), tank('2', 300, 1000), tank('3', 200, 1000), tank('4', 100, 1000)]
  const before = [tank('1', 450, 1000), tank('2', 320, 1000), tank('3', 200, 1000), tank('9', 999, 1000)]
  assert.deepEqual(sameTankDelta(now, before), { deltaKg: 30, tanks: 3 })
  assert.equal(sameTankDelta(now, [tank('1', 450, 1000)]), null, 'one matching tank out of four is not a fair change')
  assert.equal(sameTankDelta(now, []), null)
})

test('the portfolio totals the sites and lists what needs attention', () => {
  const a = summariseSite(site, [tank('1', 950, 1000, { readingAt: '2026-11-10T02:55:00Z' }), tank('2', 0, 1000, { readingAt: '2026-11-10T02:55:00Z' })], { day: '2026-11-10', live: true, now: NOW })
  const b = summariseSite({ id: 'bekasi', name: 'BEKASI', timezone: 'Asia/Jakarta' }, [tank('T1', null, 1000), tank('T2', 500, 1000)], { day: '2026-10-13', live: false, now: NOW })
  const p = summarisePortfolio([a, b])
  assert.equal(p.quantityKg, 1450)
  assert.equal(p.capacityKg, 3000)
  assert.equal(p.tanksTotal, 4)
  assert.equal(p.tanksReporting, 3)
  assert.equal(p.sitesTotal, 2)
  assert.equal(p.sitesFresh, 1)
  const kinds = Object.fromEntries(p.attention.map((item) => [item.kind, item.count]))
  assert.deepEqual(kinds, { 'near-full': 1, empty: 1, 'no-data': 1, stale: 1 })
  assert.deepEqual(p.attention.find((i) => i.kind === 'near-full').tanks, [{ siteId: 'bontang', tankId: '1' }])
  assert.deepEqual(p.attention.find((i) => i.kind === 'stale').sites, ['bekasi'])
})

test('a spare gauge slot is not a tank in use, but a faulty tank with a capacity is', () => {
  assert.equal(isInUse(tank('Tank-8', null, null, { productName: '' })), false)
  assert.equal(isInUse(tank('5101', null, 5000000, { productName: 'CPO' })), true)
  assert.equal(isInUse(tank('3101', null, 3000000, { productName: '' })), true, 'a capacity alone is enough')
  assert.equal(isInUse(tank('X', null, null, { productName: '', stockGroup: 'CPO' })), true)
  const s = summariseSite(site, [tank('1', 500, 1000), tank('Tank-8', null, null, { productName: '' })], { day: '2026-11-10', live: true, now: NOW })
  assert.equal(s.tanksTotal, 1)
  assert.equal(s.counts['no-data'], 0)
  assert.deepEqual(s.tanks.map((x) => x.tankId), ['1'])
})

test('a site says whether its figures come from a gauge system or from logsheets', () => {
  assert.equal(sourceOf(tank('1', 1, 10, { readingKind: 'live' })), 'atg')
  assert.equal(sourceOf(tank('1', 1, 10, { readingKind: 'round' })), 'atg')
  assert.equal(sourceOf(tank('1', 1, 10)), 'logsheet')
  const gauged = summariseSite(site, [tank('1', 1, 10, { readingKind: 'live' })], { day: '2026-11-10', live: true, now: NOW })
  assert.equal(gauged.source, 'atg')
  assert.equal(gauged.tanks[0].source, 'atg')
  const sheet = summariseSite(site, [tank('T1', 1, 10)], { day: '2026-11-09', live: false, now: NOW })
  assert.equal(sheet.source, 'logsheet')
})

test('a management tank carries its lab result, limits, breaches and yesterday', () => {
  const quality = {
    analysisDate: '2026-11-16',
    storageVerdict: 'quarantine',
    parameters: [{ code: 'FFA', label: 'FFA', value: 0.19, unit: '%' }, { code: 'IV', label: 'IV', value: 52.3, unit: '' }],
    limits: [{ code: 'FFA', bound: 'max', limit: 0.1, severity: 'reject' }],
    breaches: [{ field: 'ffa', code: 'FFA', parameterCode: 'lab.ffa', bound: 'max', limit: 0.1, value: 0.19, severity: 'reject' }],
  }
  const before = { parameters: [{ code: 'FFA', label: 'FFA', value: 0.07, unit: '%' }] }
  const slim = slimQuality(quality, before)
  assert.equal(slim.verdict, 'quarantine')
  assert.deepEqual(slim.parameters, [{ code: 'FFA', value: 0.19 }, { code: 'IV', value: 52.3 }])
  assert.deepEqual(slim.limits, quality.limits)
  assert.deepEqual(slim.breaches, [{ code: 'FFA', bound: 'max', limit: 0.1, value: 0.19, severity: 'reject' }])
  assert.deepEqual(slim.before, [{ code: 'FFA', value: 0.07 }])
  assert.equal(slimQuality(null), null)

  const s = summariseSite(site, [tank('T03', 500, 1000, { quality })], { day: '2026-11-16', live: false, now: NOW, previous: [tank('T03', 480, 1000, { quality: before })] })
  assert.deepEqual(s.tanks[0].quality.before, [{ code: 'FFA', value: 0.07 }])
})

test('daily movement totals sum each tank once per day and leave empty days empty', () => {
  const days = daysBetween('2026-11-14', '2026-11-17')
  assert.deepEqual(days, ['2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17'])
  const histories = [
    { tankId: 'A', points: [
      { recordedOn: '2026-11-14', quantityKg: 100 },
      { recordedOn: '2026-11-15', quantityKg: 110 },
      { recordedOn: '2026-11-15', quantityKg: 120 },
      { recordedOn: '2026-11-17', quantityKg: null },
    ] },
    { tankId: 'B', points: [{ recordedOn: '2026-11-14', quantityKg: 50 }, { recordedOn: '2026-11-17', quantityKg: 70 }] },
  ]
  const series = movementSeries(histories, days, (tankId) => (tankId === 'A' ? 'cpo' : 'refined'))
  assert.deepEqual(series.total.map((point) => point.quantityKg), [150, 120, null, 70], 'the last reading of a day counts; a blank day stays null')
  assert.deepEqual(series.total.map((point) => point.tanks), [2, 1, 0, 1])
  assert.deepEqual(series.groups.map((group) => group.code), ['cpo', 'refined'])
  assert.deepEqual(series.groups[0].series.map((point) => point.quantityKg), [100, 120, null, null])
})
