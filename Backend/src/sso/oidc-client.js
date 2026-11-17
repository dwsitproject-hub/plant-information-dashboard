import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose'

const jwksByUri = new Map()
let discoveryCache = null
let discoveryAt = 0
const DISCOVERY_TTL_MS = 5 * 60 * 1000

// A Hub that does not answer must fail the sign-in in seconds, not hang it.
const OIDC_TIMEOUT_MS = 10_000

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(OIDC_TIMEOUT_MS) })
  if (!response.ok) {
    throw new Error(`OIDC HTTP ${response.status}`)
  }
  return response.json()
}

export async function getDiscoveryDocument(discoveryUrl) {
  const now = Date.now()
  if (discoveryCache && now - discoveryAt < DISCOVERY_TTL_MS) return discoveryCache
  const document = await fetchJson(discoveryUrl)
  discoveryCache = document
  discoveryAt = now
  return document
}

export async function exchangeAuthorizationCode({ tokenEndpoint, code, redirectUri, clientId, codeVerifier }) {
  return fetchJson(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    }),
  })
}

export async function validateIdToken({ idToken, issuer, audience, jwksUri }) {
  const header = decodeProtectedHeader(idToken)
  if (header.alg !== 'RS256') {
    const error = new Error('Unsupported id_token alg')
    error.statusCode = 401
    throw error
  }
  // One key set per URI: jose caches the Hub's keys inside it, so they are not fetched on every sign-in.
  if (!jwksByUri.has(jwksUri)) jwksByUri.set(jwksUri, createRemoteJWKSet(new URL(jwksUri), { timeoutDuration: OIDC_TIMEOUT_MS }))
  const jwks = jwksByUri.get(jwksUri)
  const { payload } = await jwtVerify(idToken, jwks, { issuer, audience })
  if (!payload?.sub || typeof payload.sub !== 'string') {
    const error = new Error('id_token sub is required')
    error.statusCode = 401
    throw error
  }
  return payload
}
