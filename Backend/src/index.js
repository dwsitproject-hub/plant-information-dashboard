import 'dotenv/config'
import './asyncErrors.js'
import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import operations from './routes/operations.js'
import portfolio from './routes/portfolio.js'
import production from './routes/production.js'
import qc from './routes/qc.js'
import utility from './routes/utility.js'
import auth from './routes/auth.js'
import hubAuth from './routes/hub-auth.js'
import admin from './routes/admin.js'
import datahub from './routes/datahub.js'
import master from './routes/master.js'
import tankGauging from './routes/tank-gauging.js'
import { pool } from './db.js'
import { errorResponse } from './errors.js'
import { rateLimit } from './rateLimit.js'

const app = express()
app.disable('x-powered-by')
// The client address comes from nginx (X-Forwarded-For) when the request arrives from a private address,
// so the rate limits below count people, not the proxy. TRUST_PROXY overrides it.
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal')
const port = Number(process.env.PORT || 3010)
const origins = (process.env.CORS_ORIGIN || 'http://127.0.0.1:5173,http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

app.use(cors({ origin: origins, credentials: true }))

// The API only returns JSON and redirects: nothing in it may be framed, sniffed or used as a page.
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Cross-Origin-Resource-Policy': 'same-site',
  })
  next()
})

// Per client address: 30 sign-in attempts a minute, 600 API calls a minute.
app.use('/api/v1/auth/login', rateLimit({ windowMs: 60_000, max: Number(process.env.LOGIN_RATE_LIMIT_PER_MINUTE) || 30, code: 'too_many_sign_ins_here', methods: ['POST'] }))
app.use('/api', rateLimit({ windowMs: 60_000, max: Number(process.env.API_RATE_LIMIT_PER_MINUTE) || 600 }))
app.use(cookieParser())
app.use(express.json())

app.get('/api/v1/health', (_req, res) => {
  res.json({ ok: true, env: process.env.APP_ENV || process.env.NODE_ENV || 'dev' })
})

// Ready only when the database answers. The deploy scripts and the container healthcheck use this one.
app.get('/api/v1/health/ready', async (_req, res) => {
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('database did not answer in 3 s')), 3000)),
    ])
    res.json({ ok: true, db: 'ok' })
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'health.ready.failed', error: error?.message ?? String(error) }))
    res.status(503).json({ ok: false, db: 'unavailable' })
  }
})

app.use('/auth', hubAuth)
app.use('/api/v1/auth', auth)
app.use('/api/v1/master', master)
app.use('/api/v1/tank-gauging', tankGauging)
app.use('/api/v1/admin/datahub', datahub)
app.use('/api/v1/admin', admin)
app.use('/api/v1', portfolio)
app.use('/api/v1', operations)
app.use('/api/v1', production)
app.use('/api/v1/sites/:siteId/qc', qc)
app.use('/api/v1/sites/:siteId/utility', utility)

// Unknown API paths answer JSON, not Express's HTML page.
app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }))

app.use((error, req, res, _next) => {
  const { status, body, log } = errorResponse(error)
  if (log) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'request.failed',
      method: req.method,
      path: req.originalUrl?.split('?')[0],
      status,
      userId: req.sessionUser?.id ?? null,
      error: error?.message ?? String(error),
      code: error?.code ?? null,
      stack: error?.stack?.split(/\r?\n/).slice(0, 6).join(' | '),
    }))
  }
  if (res.headersSent) return
  res.status(status).json(body)
})

// A promise nobody awaited must not stop the API: log it, keep serving.
process.on('unhandledRejection', (reason) => {
  console.error(JSON.stringify({ level: 'error', event: 'process.unhandled_rejection', error: reason?.message ?? String(reason) }))
})

const server = app.listen(port, () => {
  console.log(`pid-api listening on ${port}`)
})

// On stop (docker stop sends SIGTERM), finish the requests in flight, close the pool, then exit.
let stopping = false
function shutdown(signal) {
  if (stopping) return
  stopping = true
  console.log(`pid-api ${signal}: closing`)
  const force = setTimeout(() => process.exit(1), 10_000)
  force.unref()
  server.close(() => {
    pool.end().finally(() => process.exit(0))
  })
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
