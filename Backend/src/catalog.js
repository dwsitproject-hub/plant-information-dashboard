import { query } from './db.js'
import { massToKg } from './domain/stock.js'

let cached = null
let cachedAt = 0
// Calibration changes rarely, but a capacity loaded by a script must show up without a restart.
const TTL_MS = 5 * 60 * 1000

function num(value) {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Calibration profiles keyed by tank id (tanks.id), which is unique across sites.
 * A tank code such as T01 repeats from site to site, so it must not be the key.
 */
export async function loadCatalog() {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached
  const profiles = await query(`
    SELECT t.id AS tank_pk, t.code AS tank_code, p.*
    FROM tank_profiles p
    JOIN tanks t ON t.id = p.tank_id
  `)
  const volumes = await query(`
    SELECT t.id AS tank_pk, v.height_m, v.volume_litre
    FROM tank_volume_points v
    JOIN tanks t ON t.id = v.tank_id
    ORDER BY t.id, v.height_m
  `)
  const bands = await query(`
    SELECT t.id AS tank_pk, b.low_mm, b.high_mm, b.offset_mm
    FROM tank_ring_bands b
    JOIN tanks t ON t.id = b.tank_id
    ORDER BY b.id
  `)
  const rings = await query(`
    SELECT t.id AS tank_pk, r.ring_index, r.volume_litre
    FROM tank_ring_volumes r
    JOIN tanks t ON t.id = r.tank_id
    ORDER BY t.id, r.ring_index
  `)
  const density = await query(`SELECT density_group, temp_c, density FROM density_points ORDER BY density_group, temp_c`)

  const byTank = new Map()
  for (const row of profiles.rows) {
    byTank.set(row.tank_pk, {
      tankId: row.tank_code,
      capacityKg: massToKg(num(row.capacity), row.capacity_unit),
      bottomStockKg: massToKg(num(row.bottom_stock), row.capacity_unit),
      dipOffsetMm: num(row.dip_offset_mm) ?? 0,
      tableTempC: num(row.table_temp_c),
      ullageLkMm: num(row.ullage_lk_mm),
      ullageLbMm: num(row.ullage_lb_mm),
      densityGroup: row.density_group,
      volumeApprox: row.volume_approx,
      volume: [],
      ringVolumes: [],
      ringBands: [],
    })
  }
  for (const row of volumes.rows) {
    byTank.get(row.tank_pk)?.volume.push([num(row.height_m), num(row.volume_litre)])
  }
  for (const row of bands.rows) {
    byTank.get(row.tank_pk)?.ringBands.push([num(row.low_mm), num(row.high_mm), num(row.offset_mm)])
  }
  for (const row of rings.rows) {
    const profile = byTank.get(row.tank_pk)
    if (!profile) continue
    profile.ringVolumes[row.ring_index - 1] = num(row.volume_litre)
  }
  const tables = {}
  for (const row of density.rows) {
    if (!tables[row.density_group]) tables[row.density_group] = []
    tables[row.density_group].push([num(row.temp_c), num(row.density)])
  }
  cached = { profiles: byTank, tables }
  cachedAt = Date.now()
  return cached
}

export function clearCatalog() {
  cached = null
  cachedAt = 0
}

/** Tank code to tank id for one site. */
export async function tankIdsByCode(siteId) {
  const result = await query(
    `SELECT t.id, t.code FROM tanks t JOIN plants p ON p.id = t.plant_id WHERE p.site_id = $1`,
    [siteId],
  )
  return new Map(result.rows.map((row) => [row.code, row.id]))
}
