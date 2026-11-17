/**
 * The scheduled gauge poll.
 *
 * Cron starts it every few minutes. It polls a site only when one of the site's round times (Master >
 * Tank gauging > Daily rounds, in the site's own timezone) has passed and that round is not done yet.
 * An attempt that fails (a gauge does not answer, or its archive cannot be read) is tried again every
 * 20 minutes, up to 6 more times; after that the round is marked failed. Each round's attempts are kept
 * in tank_gauging_round_runs and shown on the Tank gauging page.
 *
 * An attempt reads every gauge of the site (the latest reading, which Live Ops shows for today), then
 * saves the round for each tank: from that reading when it is within the tolerance of the round time,
 * otherwise from the gauge's own archive at the round time. A retry an hour late still saves the value
 * at the round time, not the value an hour later.
 */
import { writeArchiveRounds } from './archive.js'
import { acquireLock, pollSource, releaseLock } from './poll.js'
import { addDays, dayText, loadRoundSettings, localDate, roundSlots, writeRounds } from './rounds.js'
import { resolveEnabledSources } from './sources.js'

/** Retry spacing and count, from TANK_GAUGING_RETRY_MINUTES (20) and TANK_GAUGING_MAX_RETRIES (6). */
export function retryPolicy(env = process.env) {
  const minutes = Number(env.TANK_GAUGING_RETRY_MINUTES)
  const retries = Number(env.TANK_GAUGING_MAX_RETRIES)
  return {
    retryMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 20,
    maxRetries: Number.isInteger(retries) && retries >= 0 ? retries : 6,
  }
}

const slotKey = (date, roundIndex) => `${date}|${roundIndex}`

/**
 * The rounds to attempt now: passed, and either never tried or waiting for a retry that is due.
 * A round that worked, or that used up its retries, is left alone.
 */
export function dueRounds(slots, runs, now) {
  return slots.filter((slot) => {
    const run = runs.get(slotKey(slot.date, slot.roundIndex))
    if (!run) return true
    if (run.status !== 'retrying') return false
    return run.next_attempt_at != null && new Date(run.next_attempt_at) <= now
  })
}

/** A round's state after one more attempt. The first attempt plus `maxRetries` retries, then failed. */
export function afterAttempt(run, ok, now, policy = retryPolicy()) {
  const attempts = (run?.attempts ?? 0) + 1
  if (ok) return { attempts, status: 'ok', nextAttemptAt: null }
  if (attempts > policy.maxRetries) return { attempts, status: 'failed', nextAttemptAt: null }
  return { attempts, status: 'retrying', nextAttemptAt: new Date(now.getTime() + policy.retryMinutes * 60_000) }
}

/** Poll a site's gauges and save the given rounds. Never throws: a failure is returned. */
export async function attemptRounds(db, siteId, slots, opts = {}) {
  const now = opts.now ?? new Date()
  const errors = []
  let written = 0
  let missing = 0
  try {
    const sources = await resolveEnabledSources(db, { siteId })
    for (const source of sources) {
      const poll = await pollSource(db, source, opts)
      if (!poll.ok) errors.push(`${source.label || poll.sourceBaseUrl}: ${poll.error}`)
    }
    const fromSamples = await writeRounds(db, siteId, now, { slots })
    const { toleranceMin } = await loadRoundSettings(db, siteId)
    const fromArchive = await writeArchiveRounds(db, siteId, fromSamples.missingTanks, { toleranceMin, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs })
    written = fromSamples.written + fromArchive.written
    missing = fromArchive.missing
    errors.push(...fromArchive.errors)
  } catch (error) {
    errors.push(error?.message || String(error))
  }
  return { ok: errors.length === 0, written, missing, errors }
}

/** How many of the site's gauged tanks have each round now, whichever attempt saved it. */
async function roundCounts(db, siteId, slots) {
  const tanks = await db.query(
    `SELECT COUNT(*)::int AS n FROM tanks t JOIN plants p ON p.id = t.plant_id WHERE p.site_id = $1 AND t.source = 'atg'`,
    [siteId],
  )
  const saved = await db.query(
    `SELECT s.recorded_on, s.round_index, COUNT(*)::int AS n
     FROM soundings s JOIN tanks t ON t.id = s.tank_id
     WHERE s.site_id = $1 AND t.source = 'atg' AND s.recorded_on = ANY($2::date[])
     GROUP BY s.recorded_on, s.round_index`,
    [siteId, [...new Set(slots.map((slot) => slot.date))]],
  )
  const bySlot = new Map(saved.rows.map((row) => [slotKey(dayText(row.recorded_on), row.round_index), row.n]))
  return { total: tanks.rows[0]?.n ?? 0, bySlot }
}

async function saveRun(db, siteId, slot, state, counts, errors, now) {
  const written = counts.bySlot.get(slotKey(slot.date, slot.roundIndex)) ?? 0
  await db.query(
    `INSERT INTO tank_gauging_round_runs (
       site_id, recorded_on, round_index, target_at, status, attempts, first_attempt_at, last_attempt_at,
       next_attempt_at, written, missing, last_error
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11)
     ON CONFLICT (site_id, recorded_on, round_index) DO UPDATE SET
       status = EXCLUDED.status, attempts = EXCLUDED.attempts, last_attempt_at = EXCLUDED.last_attempt_at,
       next_attempt_at = EXCLUDED.next_attempt_at, written = EXCLUDED.written, missing = EXCLUDED.missing,
       last_error = EXCLUDED.last_error`,
    [
      siteId,
      slot.date,
      slot.roundIndex,
      slot.target,
      state.status,
      state.attempts,
      now,
      state.nextAttemptAt,
      written,
      Math.max(0, counts.total - written),
      errors.length ? errors.join('; ').slice(0, 2000) : null,
    ],
  )
}

/**
 * One tick of the schedule: attempt every site whose round is due.
 * @param {import('pg').Pool} db
 * @param {{ siteId?: string, now?: Date, fetchImpl?: typeof fetch, skipLock?: boolean, policy?: { retryMinutes: number, maxRetries: number } }} [opts]
 */
export async function runScheduledPolls(db, opts = {}) {
  let lock = null
  if (!opts.skipLock) {
    lock = await acquireLock(db)
    if (!lock) return { skipped: true, reason: 'lock_not_acquired' }
  }
  try {
    const now = opts.now ?? new Date()
    const policy = opts.policy ?? retryPolicy()
    const sources = await resolveEnabledSources(db, { siteId: opts.siteId })
    const siteIds = [...new Set(sources.map((source) => source.siteId))]
    const sites = []
    for (const siteId of siteIds) {
      const site = await db.query('SELECT timezone FROM sites WHERE id = $1', [siteId])
      const timeZone = site.rows[0]?.timezone
      if (!timeZone) continue
      const { roundTimes } = await loadRoundSettings(db, siteId)
      const today = localDate(now, timeZone)
      // Yesterday and today. A round missed for longer is filled with scripts/backfill-tank-gauging.js.
      const slots = roundSlots([addDays(today, -1), today], roundTimes, timeZone, now)
      const runRows = await db.query(
        'SELECT recorded_on, round_index, status, attempts, next_attempt_at FROM tank_gauging_round_runs WHERE site_id = $1 AND recorded_on = ANY($2::date[])',
        [siteId, [addDays(today, -1), today]],
      )
      // A pool of its own (the cron script) returns DATE columns as Dates, the API's pool as text.
      const runs = new Map(runRows.rows.map((row) => [slotKey(dayText(row.recorded_on), row.round_index), row]))
      const due = dueRounds(slots, runs, now)
      if (due.length === 0) {
        sites.push({ siteId, due: 0 })
        continue
      }
      const outcome = await attemptRounds(db, siteId, due, { ...opts, now })
      const counts = await roundCounts(db, siteId, due)
      const rounds = []
      for (const slot of due) {
        const run = runs.get(slotKey(slot.date, slot.roundIndex)) ?? null
        const state = afterAttempt(run, outcome.ok, now, policy)
        await saveRun(db, siteId, slot, state, counts, outcome.errors, now)
        const saved = counts.bySlot.get(slotKey(slot.date, slot.roundIndex)) ?? 0
        rounds.push({ date: slot.date, round: slot.roundIndex, time: slot.time, ...state, tanksSaved: saved, tanksWithout: Math.max(0, counts.total - saved) })
      }
      sites.push({ siteId, due: due.length, ok: outcome.ok, written: outcome.written, missing: outcome.missing, errors: outcome.errors, rounds })
    }
    const attempted = sites.filter((site) => site.due > 0)
    return { skipped: false, attempted: attempted.length, ok: attempted.every((site) => site.ok), sites }
  } finally {
    if (lock) await releaseLock(lock)
  }
}
