import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import pg from 'pg'

dotenv.config()

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.join(here, '../migrations')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

// Any fixed number; two migrate runs (for example a deploy and a manual run) wait for each other.
const LOCK_KEY = 74_210_311

/** A file that opens its own transaction commits itself; any other file is wrapped here. */
function managesOwnTransaction(sql) {
  return /^\s*BEGIN\s*;/im.test(sql)
}

const client = await pool.connect()
try {
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY])
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  const applied = await client.query('SELECT id FROM schema_migrations')
  const have = new Set(applied.rows.map((row) => row.id))
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()

  for (const file of files) {
    if (have.has(file)) {
      console.log(`skip ${file}`)
      continue
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8')
    const record = () => client.query('INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT DO NOTHING', [file])
    if (managesOwnTransaction(sql)) {
      await client.query(sql)
      await record()
    } else {
      // The file and its schema_migrations row land together, so a crash cannot leave one without the other.
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await record()
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }
    console.log(`applied ${file}`)
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {})
  client.release()
  await pool.end()
}
