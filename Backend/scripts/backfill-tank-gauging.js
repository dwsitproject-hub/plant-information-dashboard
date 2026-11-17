/**
 * Fill past daily rounds of gauged sites from the gauges' own archive, so the history charts and the
 * Commodity Stock Movement sections have the days before the poller ran. Safe to repeat: a round already
 * saved is kept, so a second run only fills what is still missing (for example after a stop).
 *
 *   node scripts/backfill-tank-gauging.js --sites=bontang,tanjung-pura --days=30           plan only
 *   node scripts/backfill-tank-gauging.js --sites=bontang,tanjung-pura --days=30 --apply   read and save
 *
 * Run it on the API host: it must reach the gauges and the database. It reads each round of each tank
 * at its round time (Master > Tank gauging > Daily rounds), up to five calls per tank and round, so 30
 * days of a 60-tank site take a few hours. It prints a line per day and site as it goes.
 * The product on a past round is the product the gauge shows now; the archive does not keep products.
 */
import dotenv from 'dotenv'
import pg from 'pg'
import { writeArchiveRounds } from '../src/tankgauging/archive.js'
import { addDays, dayText, loadRoundSettings, localDate, roundSlots } from '../src/tankgauging/rounds.js'

dotenv.config()

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null
const sites = (arg('sites') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const days = Math.min(120, Math.max(1, Number(arg('days') ?? 30) || 30))
const apply = process.argv.includes('--apply')
if (sites.length === 0 || !process.env.DATABASE_URL) {
  console.error('Usage: node scripts/backfill-tank-gauging.js --sites=bontang,tanjung-pura [--days=30] [--apply]   (DATABASE_URL must be set)')
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const minutes = (ms) => `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`

/** For one site: its round times, and the rounds still missing per day, tank by tank. */
async function planFor(siteId, now) {
  const site = await pool.query('SELECT timezone FROM sites WHERE id = $1', [siteId])
  if (!site.rows[0]) throw new Error(`Site ${siteId} does not exist`)
  const timeZone = site.rows[0].timezone
  const { roundTimes, toleranceMin } = await loadRoundSettings(pool, siteId)
  const today = localDate(now, timeZone)
  const dates = Array.from({ length: days + 1 }, (_, i) => addDays(today, i - days))
  const slots = roundSlots(dates, roundTimes, timeZone, now)
  const tanks = await pool.query(
    `SELECT t.id, t.plant_id, EXISTS (SELECT 1 FROM tank_gauging_tank_map m WHERE m.tank_id = t.id) AS linked
     FROM tanks t JOIN plants p ON p.id = t.plant_id WHERE p.site_id = $1 AND t.source = 'atg'`,
    [siteId],
  )
  const have = await pool.query(
    `SELECT tank_id, recorded_on, round_index FROM soundings
     WHERE site_id = $1 AND recorded_on BETWEEN $2::date AND $3::date`,
    [siteId, dates[0], today],
  )
  const exists = new Set(have.rows.map((row) => `${row.tank_id}|${dayText(row.recorded_on)}|${row.round_index}`))
  const linked = tanks.rows.filter((tank) => tank.linked)
  const byDay = new Map()
  for (const slot of slots) {
    const wanted = linked
      .filter((tank) => !exists.has(`${tank.id}|${slot.date}|${slot.roundIndex}`))
      .map((tank) => ({ tankId: tank.id, plantId: tank.plant_id, slot }))
    if (wanted.length === 0) continue
    byDay.set(slot.date, [...(byDay.get(slot.date) ?? []), ...wanted])
  }
  return { siteId, timeZone, roundTimes, toleranceMin, tanks: linked.length, unlinked: tanks.rows.length - linked.length, slots: slots.length, byDay }
}

try {
  const now = new Date()
  const plans = []
  for (const siteId of sites) plans.push(await planFor(siteId, now))
  for (const plan of plans) {
    const wanted = [...plan.byDay.values()].reduce((n, list) => n + list.length, 0)
    console.log(
      `${plan.siteId}: ${plan.tanks} gauged tanks (${plan.unlinked} no longer on a gauge), rounds at ${plan.roundTimes.join(', ')} ${plan.timeZone}, ` +
        `${plan.slots} rounds in the last ${days} days, ${wanted} tank rounds missing over ${plan.byDay.size} days, up to ${wanted * 5} gauge calls`,
    )
  }
  if (!apply) {
    console.log('Plan only. Add --apply to read the gauges and save the rounds.')
  } else {
    // Sites side by side (their gauges are separate), days oldest first so a stop leaves whole days behind.
    const totals = await Promise.all(
      plans.map(async (plan) => {
        const total = { written: 0, missing: 0, requests: 0, errors: 0 }
        for (const [date, wanted] of plan.byDay) {
          const started = Date.now()
          const result = await writeArchiveRounds(pool, plan.siteId, wanted, { toleranceMin: plan.toleranceMin })
          total.written += result.written
          total.missing += result.missing
          total.requests += result.requests
          total.errors += result.errors.length
          console.log(`${plan.siteId} ${date}: ${result.written} saved, ${result.missing} with no reading, ${result.requests} calls, ${minutes(Date.now() - started)}`)
          for (const error of result.errors.slice(0, 5)) console.log(`  ${error}`)
          if (result.errors.length > 5) console.log(`  … ${result.errors.length - 5} more`)
        }
        return { siteId: plan.siteId, ...total }
      }),
    )
    console.log(JSON.stringify({ done: new Date().toISOString(), sites: totals }, null, 2))
    process.exitCode = totals.some((site) => site.errors > 0) ? 1 : 0
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await pool.end()
}
