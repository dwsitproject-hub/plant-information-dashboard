import pg from 'pg'

const { Pool } = pg

pg.types.setTypeParser(1082, (value) => value)

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

// An idle client can fail when the database restarts or the network drops. Without a listener
// that 'error' event is thrown and stops the process. The pool drops the client and makes a new one.
pool.on('error', (error) => {
  console.error('pg.pool.idle_client_error', error?.message ?? error)
})

export async function query(text, params) {
  return pool.query(text, params)
}
