import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'

export const OIDC_FLOW_COOKIE = 'pid_oidc_flow'

function cookieFlags() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    path: '/',
  }
}

function b64url(input) {
  return input.toString('base64url')
}

export function createPkcePair() {
  const verifier = b64url(crypto.randomBytes(32))
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge, method: 'S256' }
}

/**
 * The `state` and `nonce` sent to the identity provider are plain random values.
 * The PKCE verifier never leaves this server except inside the signed, httpOnly flow cookie,
 * so a callback only completes in the browser that started the sign-in.
 */
export function createFlowValues() {
  return {
    state: b64url(crypto.randomBytes(24)),
    nonce: b64url(crypto.randomBytes(24)),
  }
}

export function setOidcFlowCookie(res, payload) {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET is required')
  const token = jwt.sign({ ...payload, type: 'oidc_flow' }, secret, { algorithm: 'HS256', expiresIn: '10m' })
  res.cookie(OIDC_FLOW_COOKIE, token, { ...cookieFlags(), maxAge: 10 * 60 * 1000 })
}

export function readOidcFlowCookie(req) {
  const secret = process.env.JWT_SECRET
  const token = req.cookies?.[OIDC_FLOW_COOKIE]
  if (!secret || !token) return null
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] })
    if (decoded?.type !== 'oidc_flow') return null
    return decoded
  } catch {
    return null
  }
}

/**
 * The verifier to use for this callback, or null. The `state` returned by the provider must equal
 * the one stored in this browser's flow cookie; there is no fallback without the cookie.
 */
export function verifierForCallback(flow, state) {
  if (!flow || typeof state !== 'string' || !state) return null
  if (typeof flow.state !== 'string' || typeof flow.verifier !== 'string' || !flow.verifier) return null
  const expected = Buffer.from(flow.state)
  const given = Buffer.from(state)
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null
  return flow.verifier
}

/**
 * A sign-in PID restarted itself carries this prefix on its `state`, so a second unmatched callback is
 * recognised and shown as an error instead of restarting again (no loop when cookies are blocked).
 */
export const RESTART_STATE_PREFIX = 'r.'

/**
 * What to do with a callback whose state matches no sign-in this browser started. The DWS Hub, in strict
 * OIDC mode, launches an app from its tile by sending the browser straight to the app's callback with a
 * code and state the Hub made up; PID never started that sign-in, so the state cannot match. Restarting
 * PID's own sign-in then finishes at once (the user is signed in to the Hub) and the Hub's code is never
 * used. A callback for a sign-in PID already restarted is an error.
 * @returns {'restart'|'fail'}
 */
export function unmatchedCallback(state) {
  return typeof state === 'string' && state.startsWith(RESTART_STATE_PREFIX) ? 'fail' : 'restart'
}

/** A nonce in the id_token must match the one this browser sent. A provider that echoes none is accepted. */
export function nonceMatches(flow, claims) {
  if (claims?.nonce == null) return true
  return typeof flow?.nonce === 'string' && claims.nonce === flow.nonce
}

export function clearOidcFlowCookie(res) {
  res.clearCookie(OIDC_FLOW_COOKIE, cookieFlags())
}
