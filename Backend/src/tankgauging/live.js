/**
 * The live view of a gauged site: each tank's latest reading and what the gauge says about the tank.
 * Live Ops shows this for today and the daily rounds for earlier days, so a site shows data as soon as
 * it is polled and does not wait for a round time.
 */
import { hasEvidence, roundStatus, roundValues } from './rounds.js'

const num = (value) => {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Every gauged tank of a site with its latest reading and detail. Tanks never polled have empty readings. */
export async function loadGaugedTanks(db, siteId) {
  const result = await db.query(
    `SELECT t.id, t.code, t.name, t.stock_group, t.sort_order,
            l.product_name, l.level_mm, l.temperature_c, l.total_mass, l.observed_density_kg_m3,
            l.total_observed_volume, l.status_text, l.raw_payload, l.fetched_at, l.recorded_at,
            i.max_capacity_litre, i.tank_state, i.tank_height_mm,
            d.density AS ref_density_kg_m3,
            EXISTS (SELECT 1 FROM tank_gauging_tank_map m WHERE m.tank_id = t.id) AS linked
     FROM tanks t
     JOIN plants p ON p.id = t.plant_id
     LEFT JOIN tank_gauging_latest l ON l.tank_id = t.id
     LEFT JOIN tank_gauging_info i ON i.tank_id = t.id
     LEFT JOIN LATERAL (
       SELECT s.observed_density_kg_m3 AS density FROM tank_gauging_samples s
       WHERE s.tank_id = t.id AND s.observed_density_kg_m3 > 0
       ORDER BY s.sampled_at DESC LIMIT 1
     ) d ON TRUE
     WHERE p.site_id = $1 AND t.source = 'atg'
     ORDER BY t.sort_order, t.code`,
    [siteId],
  )
  return withReferenceDensity(result.rows)
}

/**
 * A tank whose gauge is faulty has no density to turn its litre capacity into kg. It uses the last good
 * density it reported, or, when it never had one, the average of the other tanks in its product group.
 * A tank with neither stays without a kg capacity.
 */
export function withReferenceDensity(rows) {
  const byGroup = new Map()
  for (const row of rows) {
    const d = num(row.ref_density_kg_m3)
    if (d == null || d <= 0 || !row.stock_group) continue
    const entry = byGroup.get(row.stock_group) ?? { sum: 0, n: 0 }
    entry.sum += d
    entry.n += 1
    byGroup.set(row.stock_group, entry)
  }
  for (const row of rows) {
    const own = num(row.ref_density_kg_m3)
    if (own != null && own > 0) continue
    const entry = row.stock_group ? byGroup.get(row.stock_group) : null
    row.ref_density_kg_m3 = entry ? entry.sum / entry.n : null
  }
  return rows
}

/** The newest time any gauged tank of the site was read, or null when none was. */
export function newestReading(rows) {
  const times = rows.map((row) => row.fetched_at).filter(Boolean).map((value) => new Date(value).getTime())
  return times.length ? new Date(Math.max(...times)) : null
}

/** Minutes after which a gauge reading no longer counts as live. */
export function staleAfterMinutes(env = process.env) {
  const n = Number(env.TANK_GAUGING_STALE_MINUTES)
  return Number.isFinite(n) && n > 0 ? n : 120
}

/**
 * A reading is stale when it was fetched long ago, for example because the poller stopped.
 * The gauge's own timestamp is not used: it may be the time a value last changed, which is old for
 * a tank that is simply standing still, and plant gauge clocks are not always set.
 */
export function isStale(row, now = new Date(), minutes = staleAfterMinutes()) {
  const fetched = row.fetched_at ? new Date(row.fetched_at).getTime() : NaN
  if (!Number.isFinite(fetched)) return true
  return now.getTime() - fetched > minutes * 60_000
}

/**
 * A sounding in the shape Live Ops already reads, made from the latest reading.
 * A reading with nothing trustworthy in it shows as NO DATA with blank figures. So does a tank no longer
 * linked to a gauge, and a reading older than the stale limit, so neither keeps counting in stock.
 */
export function liveSounding(row, recordedOn, now = new Date()) {
  const values = roundValues(row)
  const usable = hasEvidence(values) && row.linked !== false && !isStale(row, now)
  return {
    roundIndex: 0,
    recordedOn,
    tankId: row.code,
    productName: row.product_name ?? '',
    soundingLevelM: usable && values.levelMm != null ? values.levelMm / 1000 : null,
    temperatureC: usable ? values.temperatureC : null,
    operationalStatus: usable ? roundStatus(values) : 'NO DATA',
    massKg: usable && values.massTon != null ? values.massTon * 1000 : null,
    densityKgM3: usable ? values.densityKgM3 : null,
    volumeLitre: usable ? values.volumeLitre : null,
    tankPk: row.id,
  }
}

/** What Live Ops needs to know about a gauged tank beyond its reading. */
export function gaugeMeta(row, kind, readingAt) {
  return {
    stockGroup: row.stock_group ?? null,
    readingKind: kind,
    readingAt: readingAt ? new Date(readingAt).toISOString() : null,
    capacityLitre: num(row.max_capacity_litre),
    tankState: row.tank_state ?? null,
  }
}
