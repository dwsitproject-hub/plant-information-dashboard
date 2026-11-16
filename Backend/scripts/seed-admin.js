/**
 * One-off staging bootstrap: ensure user "admin" exists with the Administrator role.
 * Run after migrations or pg_restore when APP_ENV is not dev:
 *
 *   SEED_ADMIN_PASSWORD='<at least 12 characters>' npm run seed:admin
 *   docker compose ... exec -T -e SEED_ADMIN_PASSWORD pid-api npm run seed:admin
 *
 * The password comes only from SEED_ADMIN_PASSWORD (APP_ENV=dev falls back to the local dev password).
 * An existing admin keeps its password and active flag. Pass --reset-password to overwrite the password
 * and reactivate the account.
 */
import 'dotenv/config'
import bcrypt from 'bcryptjs'
import pg from 'pg'
import { SITE_ID } from '../src/scope.js'

const MIN_LENGTH = 12
const isDev = (process.env.APP_ENV || '') === 'dev'
const resetPassword = process.argv.includes('--reset-password')

function seedPassword() {
  const given = process.env.SEED_ADMIN_PASSWORD
  if (given) {
    if (!isDev && given.length < MIN_LENGTH) {
      throw new Error(`SEED_ADMIN_PASSWORD must be at least ${MIN_LENGTH} characters outside APP_ENV=dev.`)
    }
    return given
  }
  if (isDev) return 'admin123'
  throw new Error('Set SEED_ADMIN_PASSWORD. Outside APP_ENV=dev there is no default admin password.')
}

let password
try {
  password = seedPassword()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const siteId = SITE_ID

const client = await pool.connect()
try {
  await client.query('BEGIN')

  const adminRole = await client.query(
    `SELECT id FROM roles WHERE name = 'Administrator' AND is_system_role = TRUE LIMIT 1`,
  )
  if (adminRole.rowCount === 0) {
    throw new Error('Administrator role missing — run npm run seed or restore a dump with roles first.')
  }

  const existing = await client.query(`SELECT id FROM users WHERE username = 'admin' LIMIT 1`)
  let userId
  let outcome
  if (existing.rowCount === 0) {
    const created = await client.query(
      `INSERT INTO users (username, display_name, password_hash, is_active)
       VALUES ('admin','Administrator',$1,TRUE)
       RETURNING id`,
      [bcrypt.hashSync(password, 10)],
    )
    userId = created.rows[0].id
    outcome = 'created'
  } else if (resetPassword) {
    userId = existing.rows[0].id
    await client.query(
      `UPDATE users SET password_hash = $1, is_active = TRUE, deleted_at = NULL, updated_at = NOW() WHERE id = $2`,
      [bcrypt.hashSync(password, 10), userId],
    )
    outcome = 'password reset and account reactivated'
  } else {
    userId = existing.rows[0].id
    outcome = 'already exists; password and active flag left unchanged (use --reset-password to overwrite)'
  }

  await client.query(
    `INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [userId, adminRole.rows[0].id],
  )

  const site = await client.query(`SELECT id FROM sites WHERE id = $1 LIMIT 1`, [siteId])
  if (site.rowCount > 0) {
    await client.query(
      `INSERT INTO user_sites (user_id, site_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [userId, siteId],
    )
  }

  await client.query('COMMIT')
  console.log(`Admin user "admin": ${outcome}.`)
} catch (error) {
  await client.query('ROLLBACK')
  console.error(error)
  process.exitCode = 1
} finally {
  client.release()
  await pool.end()
}
