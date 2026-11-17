import pg from 'pg'

const { Pool } = pg

pg.types.setTypeParser(1082, (value) => value)

const int = (value, fallback) => {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

// Limits so a slow or unreachable database fails a request in seconds instead of hanging it until the
// proxy gives up, and a runaway query cannot hold a connection. PG_POOL_MAX and PG_STATEMENT_TIMEOUT_MS
// override the defaults.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: int(process.env.PG_POOL_MAX, 10),
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: int(process.env.PG_STATEMENT_TIMEOUT_MS, 30_000),
  application_name: 'pid-api',
})

// An idle client can fail when the database restarts or the network drops. Without a listener
// that 'error' event is thrown and stops the process. The pool drops the client and makes a new one.
pool.on('error', (error) => {
  console.error('pg.pool.idle_client_error', error?.message ?? error)
})

export async function query(text, params) {
  return pool.query(text, params)
}
