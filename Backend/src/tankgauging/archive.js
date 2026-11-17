/**
 * Daily rounds from the gauge's own archive.
 *
 * A TankVision unit records each tank's level, temperature, density, volume and mass every five minutes
 * and keeps months of it. A round can therefore be saved at its exact time even when the poll that should
 * have taken it ran late, failed, or never ran. The scheduled poll uses this for a round it could not fill
 * from a fresh reading, and scripts/backfill-tank-gauging.js uses it for past days.
 *
 * Worked out from the TankVision historical trend page; undocumented, so treat it as brittle:
 * - DATATYPE=29 lists what each tank archives. DATATYPE=18 returns one parameter of one tank between two
 *   Unix times. A list of parameters is ignored, so it is one call per value.
 * - A unit behind a gateway (Tanjung Pura) is reached through the gateway's WebServerTunnel.esp by its own
 *   address. Those units archive Product Mass (729) and Gross Observed Volume (726) instead of Total Mass
 *   (730) and Total Observed Volume (717); on the live units the masses are the same figure.
 */
import {
  fetchArchiveConfig,
  fetchArchiveTankData,
  fetchTankMeta,
  openSession,
  parseArchiveConfig,
  parseArchivePoints,
  parseTankMetaResponse,
  trimBaseUrl,
} from './client.js'
import { hasEvidence, insertRound, isBadStatus } from './rounds.js'
import { resolveEnabledSources } from './sources.js'

/** Each round value and the parameter ids it may be archived under, preferred first. Level and mass come first. */
export const ARCHIVE_PARAMS = [
  { field: 'levelMm', ids: [622] },
  { field: 'massTon', ids: [730, 729] },
  { field: 'temperatureC', ids: [625] },
  { field: 'densityKgM3', ids: [628] },
  { field: 'volumeLitre', ids: [717, 726] },
]

/** The id to ask for: the first one the tank archives, or the usual id when the unit did not say. */
export function archiveParamFor(ids, archived) {
  if (!archived || archived.size === 0) return ids[0]
  return ids.find((id) => archived.has(id)) ?? null
}

/** A point's value in the round's unit (mm, t, °C, kg/m³, L). A unit it does not recognise is not guessed. */
export function toRoundUnit(field, point) {
  const unit = String(point.unit ?? '').toLowerCase().replace('³', '3').trim()
  const value = point.value
  if (field === 'levelMm') return unit === 'mm' || unit === '' ? value : unit === 'm' ? value * 1000 : null
  if (field === 'massTon') return ['ton', 'tonne', 't', ''].includes(unit) ? value : unit === 'kg' ? value / 1000 : null
  if (field === 'volumeLitre') return ['l', 'lt', 'ltr', ''].includes(unit) ? value : unit === 'm3' || unit === 'kl' ? value * 1000 : null
  return value
}

/** The archived point nearest the round time, within the tolerance, that the unit does not mark as bad. */
export function nearestPoint(points, target, toleranceMin) {
  const limit = toleranceMin * 60_000
  let best = null
  for (const point of points) {
    if (isBadStatus(point.status)) continue
    const gap = Math.abs(point.at.getTime() - target.getTime())
    if (gap > limit) continue
    if (!best || gap < best.gap) best = { point, gap }
  }
  return best?.point ?? null
}

/** The same checks a live sample gets: no negative mass or volume, no zero density. */
export function cleanValues(values) {
  const out = { ...values }
  if (out.massTon != null && out.massTon < 0) out.massTon = null
  if (out.densityKgM3 != null && out.densityKgM3 <= 0) out.densityKgM3 = null
  if (out.volumeLitre != null && out.volumeLitre < 0) out.volumeLitre = null
  return out
}

/**
 * Save rounds from the archive for the given tanks and rounds. Tanks that already have the round are
 * left alone (the insert keeps the existing row). Never throws for one gauge: its failure is returned.
 *
 * @param {import('pg').Pool} db
 * @param {string} siteId
 * @param {Array<{ tankId: string, plantId: string, slot: { date: string, roundIndex: number, target: Date } }>} wanted
 * @param {{ toleranceMin?: number, fetchImpl?: typeof fetch, timeoutMs?: number, onProgress?: (event: object) => void }} [opts]
 * @returns {Promise<{ written: number, missing: number, requests: number, errors: string[] }>}
 */
export async function writeArchiveRounds(db, siteId, wanted, opts = {}) {
  const totals = { written: 0, missing: 0, requests: 0, errors: [] }
  if (wanted.length === 0) return totals
  const toleranceMin = opts.toleranceMin ?? 30
  const tankIds = [...new Set(wanted.map((item) => item.tankId))]

  const links = await db.query(
    `SELECT tank_id, source_base_url, source_unit_name, external_tank_id
     FROM tank_gauging_tank_map WHERE site_id = $1 AND tank_id = ANY($2::text[])`,
    [siteId, tankIds],
  )
  const linkByTank = new Map(links.rows.map((row) => [row.tank_id, row]))
  const products = await db.query('SELECT tank_id, product_name FROM tank_gauging_latest WHERE tank_id = ANY($1::text[])', [tankIds])
  const productByTank = new Map(products.rows.map((row) => [row.tank_id, row.product_name]))
  const sources = await resolveEnabledSources(db, { siteId })
  const sourceByBase = new Map(sources.map((source) => [trimBaseUrl(source.baseUrl), source]))

  // A tank no gauge holds any more cannot be read back.
  const bySource = new Map()
  for (const item of wanted) {
    const link = linkByTank.get(item.tankId)
    const source = link ? sourceByBase.get(trimBaseUrl(link.source_base_url)) : null
    if (!source) {
      totals.missing += 1
      continue
    }
    if (!bySource.has(source)) bySource.set(source, [])
    bySource.get(source).push({ ...item, link })
  }

  // The gauges are separate hosts, so they are read side by side; each one is read one call at a time.
  const results = await Promise.all(
    [...bySource.entries()].map(([source, items]) => readSource(db, siteId, source, items, { ...opts, toleranceMin, productByTank })),
  )
  for (const result of results) {
    totals.written += result.written
    totals.missing += result.missing
    totals.requests += result.requests
    totals.errors.push(...result.errors)
  }
  return totals
}

async function readSource(db, siteId, source, items, opts) {
  const result = { written: 0, missing: 0, requests: 0, errors: [] }
  const base = trimBaseUrl(source.baseUrl)
  const label = source.label || base
  const fetchOpts = { baseUrl: base, auth: source.auth, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs }
  let units
  try {
    fetchOpts.cookie = await openSession(base, fetchOpts)
    const metaRes = await fetchTankMeta(fetchOpts)
    result.requests += 1
    if (!metaRes.ok) throw new Error(`tank list HTTP ${metaRes.status}`)
    units = parseTankMetaResponse(metaRes.text).units.filter((unit) => unit.tanks.length > 0)
    if (units.length === 0) throw new Error('the tank list has no tanks')
  } catch (error) {
    result.missing += items.length
    result.errors.push(`${label}: ${error?.message || String(error)}`)
    return result
  }

  // A gateway answers for each of its units separately, so its units are read side by side (about four
  // times faster at Tanjung Pura). Within a unit, one call at a time.
  const behindGateway = units.length > 1
  const unitByName = new Map(units.map((unit) => [unit.name, unit]))
  const byUnit = new Map()
  for (const item of items) {
    const unit = unitByName.get(item.link.source_unit_name) ?? (units.length === 1 ? units[0] : null)
    if (!unit || (behindGateway && !unit.ipAddress)) {
      result.missing += 1
      continue
    }
    if (!byUnit.has(unit)) byUnit.set(unit, [])
    byUnit.get(unit).push(item)
  }
  const parts = await Promise.all(
    [...byUnit.entries()].map(([unit, unitItems]) =>
      readUnit(db, siteId, { ...fetchOpts, tunnelIp: behindGateway ? unit.ipAddress : undefined }, `${label} ${unit.name}`.trim(), unitItems, opts),
    ),
  )
  for (const part of parts) {
    result.written += part.written
    result.missing += part.missing
    result.requests += part.requests
    result.errors.push(...part.errors)
  }
  return result
}

async function readUnit(db, siteId, callOpts, label, items, opts) {
  const result = { written: 0, missing: 0, requests: 0, errors: [] }
  let index = 0
  try {
    const config = await fetchArchiveConfig(callOpts)
    result.requests += 1
    const archivedByTank = config.ok ? parseArchiveConfig(config.text) : new Map()

    // Tank by tank, oldest round first.
    items.sort((a, b) => a.tankId.localeCompare(b.tankId) || a.slot.target - b.slot.target)
    let consecutiveFailures = 0
    for (; index < items.length; index += 1) {
      const item = items[index]
      const archived = archivedByTank.get(Number(item.link.external_tank_id)) ?? null
      const target = item.slot.target
      const from = new Date(target.getTime() - opts.toleranceMin * 60_000)
      const to = new Date(target.getTime() + opts.toleranceMin * 60_000)
      const values = { levelMm: null, massTon: null, temperatureC: null, densityKgM3: null, volumeLitre: null }
      let sampledAt = null
      let failure = null
      for (const { field, ids } of ARCHIVE_PARAMS) {
        // No level and no mass means the gauge had nothing for this tank then; the rest would not help.
        if (field === 'temperatureC' && values.levelMm == null && values.massTon == null) break
        const paramId = archiveParamFor(ids, archived)
        if (paramId == null) continue
        const res = await fetchArchiveTankData({ ...callOpts, tankId: item.link.external_tank_id, paramId, from, to })
        result.requests += 1
        if (!res.ok) {
          failure = `archive HTTP ${res.status}`
          break
        }
        const point = nearestPoint(parseArchivePoints(res.text), target, opts.toleranceMin)
        if (!point) continue
        values[field] = toRoundUnit(field, point)
        if (field === 'massTon' || (field === 'levelMm' && !sampledAt)) sampledAt = point.at
      }
      if (failure) {
        result.missing += 1
        consecutiveFailures += 1
        result.errors.push(`${label}: tank ${item.link.external_tank_id} (${item.slot.date} round ${item.slot.roundIndex}): ${failure}`)
        // A unit that stops answering would fail every tank in turn. Stop on it after a few in a row.
        if (consecutiveFailures >= 3) {
          const left = items.length - index - 1
          result.missing += left
          result.errors.push(`${label}: stopped after 3 failures in a row, ${left} rounds not read`)
          break
        }
        continue
      }
      consecutiveFailures = 0
      const clean = cleanValues(values)
      if (!hasEvidence(clean)) {
        result.missing += 1
        opts.onProgress?.({ siteId, source: label, tankId: item.tankId, slot: item.slot, written: false })
        continue
      }
      const saved = await insertRound(db, {
        siteId,
        plantId: item.plantId,
        tankId: item.tankId,
        date: item.slot.date,
        roundIndex: item.slot.roundIndex,
        productName: opts.productByTank?.get(item.tankId) ?? '',
        values: clean,
        sampledAt: sampledAt ?? target,
      })
      result.written += saved
      opts.onProgress?.({ siteId, source: label, tankId: item.tankId, slot: item.slot, written: saved > 0 })
    }
  } catch (error) {
    // Everything from the round that failed onwards was not read.
    result.missing += items.length - index
    result.errors.push(`${label}: ${error?.message || String(error)}`)
  }
  return result
}
