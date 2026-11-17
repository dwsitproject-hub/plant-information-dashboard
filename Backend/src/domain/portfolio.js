/**
 * The management view of tanks and stock: one summary per site, built from the same tank rows Live Ops
 * shows, so the two always agree. Pure functions only, so they can be tested without a database.
 */
import { COMMODITY_CLASSES, commodityClassOf } from './commodityClass.js'

export const NEAR_FULL = 0.9
/** Above this a tank holds more than it should, which points at a wrong capacity or reading. */
export const OVER_FULL = 1.02
const LIVE_STALE_MINUTES = 60
const ROUNDS_STALE_DAYS = 2
const STATUSES = ['ok', 'near-full', 'over', 'empty', 'no-data']

/**
 * ok, near-full, over (more than full, check the data), empty, or no-data (the gauge or logsheet gave
 * nothing usable). A tank with no data is never counted as empty.
 */
export function tankStatus(tank, nearFull = NEAR_FULL) {
  if (tank.quantityKg == null) return 'no-data'
  if (tank.operationalStatus === 'Empty' || tank.quantityKg <= 0) return 'empty'
  if (tank.fillRatio != null && tank.fillRatio > OVER_FULL) return 'over'
  if (tank.fillRatio != null && tank.fillRatio >= nearFull) return 'near-full'
  return 'ok'
}

/**
 * A spare slot on a gauge (no product, no capacity, no reading) is not a tank in use. It would only add
 * "no data" noise, so the overview leaves it out. A tank with a faulty gauge still has a capacity or a
 * product, so it stays.
 */
export function isInUse(tank) {
  return (
    tank.capacityKg != null ||
    tank.quantityKg != null ||
    Boolean(tank.productName && String(tank.productName).trim()) ||
    Boolean(tank.stockGroup)
  )
}

/** Where a tank's figures come from: the tank gauging system (ATG) or the operators' logsheets. */
export function sourceOf(tank) {
  return tank.readingKind === 'live' || tank.readingKind === 'round' ? 'atg' : 'logsheet'
}

/**
 * The lab result a management card needs: parameter values, the product's limits and which it breaks.
 * `before` is the same tank as of the day before, so a card can show a change since yesterday.
 */
export function slimQuality(quality, before = null) {
  if (!quality) return null
  const values = (list) => (list ?? []).map((item) => ({ code: item.code, value: item.value }))
  return {
    analysisDate: quality.analysisDate ?? null,
    verdict: quality.storageVerdict ?? 'spec-pending',
    parameters: values(quality.parameters),
    limits: quality.limits ?? [],
    breaches: (quality.breaches ?? []).map((item) => ({ code: item.code, bound: item.bound, limit: item.limit, value: item.value, severity: item.severity })),
    before: before ? values(before.parameters) : null,
  }
}

export function slimTank(tank, nearFull = NEAR_FULL, previous = null) {
  return {
    quality: slimQuality(tank.quality, previous?.quality ?? null),
    tankId: tank.tankId,
    source: sourceOf(tank),
    productName: tank.productName ?? '',
    stockGroup: tank.stockGroup ?? null,
    commodityClass: commodityClassOf(tank.productName, tank.stockGroup),
    quantityKg: tank.quantityKg ?? null,
    capacityKg: tank.capacityKg ?? null,
    fillRatio: tank.fillRatio ?? null,
    temperatureC: tank.temperatureC ?? null,
    status: tankStatus(tank, nearFull),
    readingAt: tank.readingAt ?? null,
  }
}

function emptyTotals() {
  return { quantityKg: 0, filledKg: 0, capacityKg: 0, capacityTotalKg: 0, tanks: 0, reporting: 0 }
}

function emptyCounts() {
  return Object.fromEntries(STATUSES.map((status) => [status, 0]))
}

function addTank(totals, tank) {
  totals.tanks += 1
  if (tank.capacityKg != null) totals.capacityTotalKg += tank.capacityKg
  if (tank.quantityKg != null) {
    totals.reporting += 1
    // Stock counts every tank that reports, with or without a capacity in the master data.
    totals.quantityKg += tank.quantityKg
  }
  // Fill and free space use only the tanks that have both, so a tank with no data does not drag it down
  // and a tank with no capacity does not push it up.
  if (tank.quantityKg != null && tank.capacityKg != null) {
    totals.filledKg += tank.quantityKg
    totals.capacityKg += tank.capacityKg
  }
}

const fillOf = (totals) => (totals.capacityKg > 0 ? totals.filledKg / totals.capacityKg : null)

/** Total stock of the tanks that report in both lists, to compare one day with another like for like. */
export function sameTankDelta(now, before) {
  const earlier = new Map(before.filter((t) => t.quantityKg != null).map((t) => [t.tankId, t.quantityKg]))
  let current = 0
  let previous = 0
  let used = 0
  const reporting = now.filter((t) => t.quantityKg != null).length
  for (const tank of now) {
    if (tank.quantityKg == null || !earlier.has(tank.tankId)) continue
    current += tank.quantityKg
    previous += earlier.get(tank.tankId)
    used += 1
  }
  // Less than half the tanks to compare means the change would mislead.
  if (used === 0 || used < reporting / 2) return null
  return { deltaKg: current - previous, tanks: used }
}

/**
 * @param {{ id: string, name: string, companyName?: string, timezone: string }} site
 * @param {object[]} tanks the rows Live Ops shows for the site
 * @param {{ day: string|null, live: boolean, now?: Date, previous?: object[]|null, nearFull?: number }} context
 */
export function summariseSite(site, tanks, context) {
  const nearFull = context.nearFull ?? NEAR_FULL
  const now = context.now ?? new Date()
  const used = tanks.filter(isInUse)
  const before = new Map((context.previous ?? []).map((tank) => [tank.tankId, tank]))
  const slim = used.map((tank) => slimTank(tank, nearFull, before.get(tank.tankId) ?? null))

  const total = emptyTotals()
  const byClass = new Map(COMMODITY_CLASSES.map((code) => [code, emptyTotals()]))
  const counts = emptyCounts()
  for (const tank of slim) {
    addTank(total, tank)
    addTank(byClass.get(tank.commodityClass), tank)
    counts[tank.status] += 1
  }

  const times = slim.map((t) => (t.readingAt ? new Date(t.readingAt).getTime() : null)).filter((n) => n != null)
  const newest = times.length ? new Date(Math.max(...times)) : null
  const ageMinutes = context.live && newest ? Math.round((now.getTime() - newest.getTime()) / 60000) : null
  const ageDays =
    !context.live && context.day ? Math.floor((now.getTime() - new Date(`${context.day}T12:00:00Z`).getTime()) / 86400000) : null
  // A gauged site is read at its round times, so its tanks say themselves whether the last round's poll
  // got through. Anything else live falls back to the age of the newest reading.
  const gauged = used.filter((tank) => tank.readingKind === 'live' && typeof tank.stale === 'boolean')
  const liveStale = newest == null || (gauged.length > 0 ? gauged.every((tank) => tank.stale) : ageMinutes > LIVE_STALE_MINUTES)
  const stale = context.live ? liveStale : ageDays == null || ageDays >= ROUNDS_STALE_DAYS

  const change = context.previous ? sameTankDelta(used, context.previous) : null

  return {
    id: site.id,
    name: site.name,
    companyName: site.companyName ?? null,
    timezone: site.timezone,
    kind: context.live ? 'live' : 'rounds',
    // A site read by a gauge system says so on its tanks. Anything else is filled from logsheets.
    source: used.some((tank) => sourceOf(tank) === 'atg') ? 'atg' : 'logsheet',
    day: context.day ?? null,
    asOf: context.live ? (newest ? newest.toISOString() : null) : (context.day ?? null),
    ageMinutes,
    ageDays,
    stale,
    quantityKg: total.quantityKg,
    filledKg: total.filledKg,
    capacityKg: total.capacityKg,
    capacityTotalKg: total.capacityTotalKg,
    fillRatio: fillOf(total),
    tanksTotal: total.tanks,
    tanksReporting: total.reporting,
    counts,
    changeKg: change?.deltaKg ?? null,
    changeTanks: change?.tanks ?? null,
    classes: COMMODITY_CLASSES.map((code) => {
      const t = byClass.get(code)
      return {
        code,
        quantityKg: t.quantityKg,
        filledKg: t.filledKg,
        capacityKg: t.capacityKg,
        capacityTotalKg: t.capacityTotalKg,
        fillRatio: fillOf(t),
        tanks: t.tanks,
        reporting: t.reporting,
      }
    }).filter((row) => row.tanks > 0),
    tanks: slim,
  }
}

/** Everything across the sites: totals, and what needs attention, grouped so the screen can list it briefly. */
export function summarisePortfolio(sites, nearFull = NEAR_FULL) {
  const total = emptyTotals()
  const counts = emptyCounts()
  let changeKg = 0
  let changeSites = 0
  for (const site of sites) {
    total.quantityKg += site.quantityKg
    total.filledKg += site.filledKg
    total.capacityKg += site.capacityKg
    total.capacityTotalKg += site.capacityTotalKg
    total.tanks += site.tanksTotal
    total.reporting += site.tanksReporting
    for (const key of STATUSES) counts[key] += site.counts[key]
    if (site.changeKg != null) {
      changeKg += site.changeKg
      changeSites += 1
    }
  }
  const attention = []
  for (const kind of ['near-full', 'over', 'empty', 'no-data']) {
    const tanks = sites.flatMap((site) =>
      site.tanks.filter((t) => t.status === kind).map((t) => ({ siteId: site.id, tankId: t.tankId })),
    )
    if (tanks.length) attention.push({ kind, count: tanks.length, tanks })
  }
  const staleSites = sites.filter((site) => site.stale)
  if (staleSites.length) attention.push({ kind: 'stale', count: staleSites.length, sites: staleSites.map((site) => site.id) })
  return {
    nearFull,
    quantityKg: total.quantityKg,
    filledKg: total.filledKg,
    capacityKg: total.capacityKg,
    capacityTotalKg: total.capacityTotalKg,
    fillRatio: fillOf(total),
    tanksTotal: total.tanks,
    tanksReporting: total.reporting,
    sitesTotal: sites.length,
    sitesFresh: sites.length - staleSites.length,
    counts,
    changeKg: changeSites > 0 ? changeKg : null,
    changeSites,
    attention,
  }
}

/** Every day from `from` to `to`, inclusive, as YYYY-MM-DD. */
export function daysBetween(from, to) {
  const days = []
  const cursor = new Date(`${from}T12:00:00Z`)
  const end = new Date(`${to}T12:00:00Z`)
  while (cursor <= end && days.length < 400) {
    days.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return days
}

/**
 * Daily stock totals for a site's tanks: the whole site, and each group given by `groupOf(tankId)`.
 * A tank counts with its last reading of the day. A day with no reading from any tank stays null, not
 * zero, so a chart shows a gap instead of a drop to empty.
 *
 * @param {Array<{ tankId: string, points: Array<{ recordedOn: string, quantityKg: number|null }> }>} histories
 */
export function movementSeries(histories, days, groupOf = () => null) {
  const lastByDay = histories.map((history) => {
    const byDay = new Map()
    for (const point of history.points) {
      if (point.recordedOn && point.quantityKg != null) byDay.set(point.recordedOn, point.quantityKg)
    }
    return { tankId: history.tankId, group: groupOf(history.tankId), byDay }
  })
  const groups = [...new Set(lastByDay.map((tank) => tank.group).filter(Boolean))]
  const seriesFor = (tanks) => days.map((day) => {
    let total = 0
    let tanksCounted = 0
    for (const tank of tanks) {
      const value = tank.byDay.get(day)
      if (value == null) continue
      total += value
      tanksCounted += 1
    }
    return { day, quantityKg: tanksCounted > 0 ? total : null, tanks: tanksCounted }
  })
  return {
    total: seriesFor(lastByDay),
    groups: groups.map((code) => ({ code, series: seriesFor(lastByDay.filter((tank) => tank.group === code)) })),
  }
}
