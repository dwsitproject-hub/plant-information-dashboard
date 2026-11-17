/**
 * The gauge poller. Cron starts it every 5 minutes; it does work only when a round is due.
 *
 *   node scripts/run-tank-gauging-poll.js                  the schedule: poll a site at its round times
 *                                                          (Master > Tank gauging > Daily rounds), retry a
 *                                                          failed attempt every 20 minutes, up to 6 times
 *   node scripts/run-tank-gauging-poll.js --siteId=bontang the schedule for one site
 *   node scripts/run-tank-gauging-poll.js --now            poll every gauge now, like Poll now on the page
 *   node scripts/run-tank-gauging-poll.js --now --no-rounds  poll now, save no rounds
 *
 * Prints a JSON summary. Exit code 1 when an attempt failed, so a scheduler can alert on it.
 * TANK_GAUGING_RETRY_MINUTES (20) and TANK_GAUGING_MAX_RETRIES (6) change the retries.
 */
import dotenv from 'dotenv'
import pg from 'pg'
import { runTankGaugingPoll } from '../src/tankgauging/poll.js'
import { runScheduledPolls } from '../src/tankgauging/schedule.js'

dotenv.config()

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

try {
  const siteId = arg('siteId') ?? undefined
  const result = process.argv.includes('--now')
    ? await runTankGaugingPoll(pool, { siteId, rounds: !process.argv.includes('--no-rounds') })
    : await runScheduledPolls(pool, { siteId })
  // A tick with nothing due prints one short line, so a log every 5 minutes stays readable.
  if (!result.skipped && result.attempted === 0) console.log(`${new Date().toISOString()} nothing due`)
  else console.log(JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2))
  process.exitCode = result.skipped ? 0 : result.ok ? 0 : 1
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await pool.end()
}
