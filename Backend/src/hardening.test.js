import test from 'node:test'
import assert from 'node:assert/strict'
import { calendarDay, isCalendarDay, rejectBadDays } from './dates.js'
import { errorResponse } from './errors.js'
import { assertAllowedUrl, assertAllowedUrlShape, blockedReason, sameOrigin } from './outboundGuard.js'
import { rateLimit } from './rateLimit.js'
import { badRoundTimes } from './tankgauging/rounds.js'

test('only real calendar days pass the date check', () => {
  assert.equal(isCalendarDay('2026-02-28'), true)
  assert.equal(isCalendarDay('2028-02-29'), true, 'leap day')
  assert.equal(isCalendarDay('2026-02-29'), false)
  assert.equal(isCalendarDay('2026-02-30'), false)
  assert.equal(isCalendarDay('2026-13-01'), false)
  assert.equal(isCalendarDay('20261001'), false)
  assert.equal(isCalendarDay('garbage'), false)
  assert.equal(calendarDay('2026-11-17'), '2026-11-17')
  assert.equal(calendarDay(['2026-11-17']), null, 'a repeated query parameter arrives as a list')
})

test('a bad day in the query string is refused before the route runs', () => {
  const run = (query) => {
    let answered = null
    let passed = false
    const res = { status: (code) => ({ json: (body) => { answered = { code, body } } }) }
    rejectBadDays({ query }, res, () => { passed = true })
    return { answered, passed }
  }
  assert.equal(run({ from: '2026-11-01', to: '2026-11-17' }).passed, true)
  assert.equal(run({ from: '' }).passed, true, 'an empty parameter is left to the route')
  assert.deepEqual(run({ to: '2026-02-30' }).answered, { code: 400, body: { error: 'invalid_date', parameter: 'to' } })
  assert.equal(run({ on: 'garbage' }).answered.code, 400)
})

test('errors become the right status without internals', () => {
  assert.deepEqual(errorResponse({ type: 'entity.parse.failed' }), { status: 400, body: { error: 'invalid_json' }, log: false })
  assert.equal(errorResponse({ code: '22008' }).status, 400)
  assert.equal(errorResponse({ code: '23505' }).status, 409)
  assert.equal(errorResponse(Object.assign(new Error('nope'), { status: 403, code: 'forbidden' })).body.error, 'forbidden')
  const boom = errorResponse(new Error('connection to 10.0.0.5 refused'))
  assert.equal(boom.status, 500)
  assert.equal(JSON.stringify(boom.body).includes('10.0.0.5'), false, 'no internal detail in the body')
})

test('the outbound guard refuses loopback, link-local and metadata, and allows the plant networks', async () => {
  for (const ip of ['127.0.0.1', '0.0.0.0', '169.254.169.254', '100.100.100.200', '224.0.0.1', '::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.ok(blockedReason(ip), `${ip} must be refused`)
  }
  for (const ip of ['172.16.250.15', '10.1.2.3', '192.168.5.1', '8.8.8.8']) assert.equal(blockedReason(ip), null, `${ip} is allowed`)
  assert.throws(() => assertAllowedUrlShape('http://127.0.0.1:3010'), { code: 'blocked_address' })
  assert.throws(() => assertAllowedUrlShape('http://localhost:5432'), { code: 'blocked_address' })
  assert.throws(() => assertAllowedUrlShape('file:///etc/passwd'))
  assert.equal(assertAllowedUrlShape('http://172.16.11.28').hostname, '172.16.11.28')
  await assert.rejects(assertAllowedUrl('http://localhost:3010'), { code: 'blocked_address' })
  // A name that does not resolve is let through: the request itself fails.
  assert.equal((await assertAllowedUrl('http://qa-unreachable-gauge.invalid')).hostname, 'qa-unreachable-gauge.invalid')
  assert.equal(sameOrigin('http://172.16.11.28/index.esp', '/logon.esp?REASON=1'), 'http://172.16.11.28/logon.esp?REASON=1')
  assert.equal(sameOrigin('http://172.16.11.28/index.esp', 'http://169.254.169.254/'), null, 'no redirect to another host')
})

test('the rate limit refuses an address after its allowance and starts again in a new window', () => {
  const limit = rateLimit({ windowMs: 60_000, max: 3, code: 'slow_down' })
  const statuses = []
  for (let i = 0; i < 5; i += 1) {
    let status = 200
    const res = { set: () => {}, status: (code) => { status = code; return { json: () => {} } } }
    limit({ ip: '10.0.0.9', method: 'POST' }, res, () => {})
    statuses.push(status)
  }
  assert.deepEqual(statuses, [200, 200, 200, 429, 429])
  let other = 200
  limit({ ip: '10.0.0.10', method: 'POST' }, { set: () => {}, status: (code) => { other = code; return { json: () => {} } } }, () => {})
  assert.equal(other, 200, 'another address has its own allowance')
})

test('round times with a bad entry are named, not dropped', () => {
  assert.deepEqual(badRoundTimes('06:30, 99:99, noon'), ['99:99', 'noon'])
  assert.deepEqual(badRoundTimes('06:30, 14:30'), [])
  assert.deepEqual(badRoundTimes('06:30, 1430'), ['1430'])
  assert.deepEqual(badRoundTimes(['06:30', '25:00']), ['25:00'])
})
