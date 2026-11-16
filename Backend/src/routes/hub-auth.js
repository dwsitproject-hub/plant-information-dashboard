import express, { Router } from 'express'
import jwt from 'jsonwebtoken'
import { signSession } from '../access.js'
import { exchangeAuthorizationCode, getDiscoveryDocument, validateIdToken } from '../sso/oidc-client.js'
import { getOidcConfig, oidcConfigError } from '../sso/oidc-config.js'
import {
  clearOidcFlowCookie,
  createFlowValues,
  createPkcePair,
  nonceMatches,
  readOidcFlowCookie,
  setOidcFlowCookie,
  verifierForCallback,
} from '../sso/oidc-flow.js'
import { HubTokenReplayGuard } from '../sso/replay-guard.js'
import { appPublicOrigin, redirectToSsoError } from '../sso/public-origin.js'
import { resolveHubUser } from '../sso/resolve-user.js'

const router = Router()
const urlencoded = express.urlencoded({ extended: false })
const hubTokens = new HubTokenReplayGuard()

/** The Hub's tokens live 60 seconds by default. Anything issued longer ago than this is refused. */
const HUB_TOKEN_MAX_AGE_SECONDS = 300

router.get('/sso/status', (_req, res) => {
  const config = getOidcConfig()
  res.json({
    oidcEnabled: config.enabled,
    legacyBridgeEnabled: config.legacyBridgeEnabled,
  })
})

router.get('/oidc/start', async (req, res) => {
  const config = getOidcConfig()
  if (!config.enabled) return redirectToSsoError(res, 'oidc_disabled')
  if (oidcConfigError(config)) return redirectToSsoError(res, 'oidc_not_configured')

  // Inside an iframe the flow cookie may be dropped as third-party. Restart at the top level first,
  // so the cookie is set in the same browsing context that will receive the callback.
  const accept = req.get('Accept') || ''
  const secFetchDest = (req.get('Sec-Fetch-Dest') || '').toLowerCase()
  if (accept.includes('text/html') && secFetchDest === 'iframe') {
    return sendBreakout(res, absoluteRequestUrl(req))
  }

  try {
    const discovery = await getDiscoveryDocument(config.discoveryUrl)
    if (!discovery?.authorization_endpoint) return redirectToSsoError(res, 'oidc_sign_in_failed')
    const { verifier, challenge, method } = createPkcePair()
    const { state, nonce } = createFlowValues()
    setOidcFlowCookie(res, { state, verifier, nonce })
    const authUrl = new URL(discovery.authorization_endpoint)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('client_id', config.clientId)
    authUrl.searchParams.set('redirect_uri', config.redirectUri)
    authUrl.searchParams.set('scope', config.scopes)
    authUrl.searchParams.set('state', state)
    authUrl.searchParams.set('nonce', nonce)
    authUrl.searchParams.set('code_challenge', challenge)
    authUrl.searchParams.set('code_challenge_method', method)
    if (accept.includes('text/html')) return sendBreakout(res, authUrl.toString())
    return res.redirect(302, authUrl.toString())
  } catch (error) {
    console.error('oidc.start.failure', error instanceof Error ? error.message : 'failed')
    return redirectToSsoError(res, 'oidc_sign_in_failed')
  }
})

router.get('/oidc/callback', async (req, res) => {
  const accept = req.get('Accept') || ''
  const secFetchDest = (req.get('Sec-Fetch-Dest') || '').toLowerCase()
  if (accept.includes('text/html') && secFetchDest === 'iframe') {
    return sendBreakout(res, absoluteRequestUrl(req))
  }

  const config = getOidcConfig()
  if (!config.enabled) return fail(res, 'oidc_disabled')
  if (oidcConfigError(config)) return fail(res, 'oidc_not_configured')

  try {
    const code = typeof req.query?.code === 'string' ? req.query.code : ''
    const state = typeof req.query?.state === 'string' ? req.query.state : ''
    const flow = readOidcFlowCookie(req)
    const codeVerifier = verifierForCallback(flow, state)
    if (!codeVerifier) return fail(res, 'invalid_state')
    if (!code) return fail(res, 'missing_code')

    const discovery = await getDiscoveryDocument(config.discoveryUrl)
    if (!discovery?.token_endpoint || !discovery?.jwks_uri) return fail(res, 'oidc_sign_in_failed')
    const tokenSet = await exchangeAuthorizationCode({
      tokenEndpoint: discovery.token_endpoint,
      code,
      redirectUri: config.redirectUri,
      clientId: config.clientId,
      codeVerifier,
    })
    if (!tokenSet?.id_token || typeof tokenSet.id_token !== 'string') return fail(res, 'missing_id_token')

    const claims = await validateIdToken({
      idToken: tokenSet.id_token,
      issuer: config.issuer,
      audience: config.clientId,
      jwksUri: discovery.jwks_uri,
    })
    if (!nonceMatches(flow, claims)) return fail(res, 'invalid_state')
    const resolved = await resolveHubUser({
      hubUserId: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : '',
      requireVerifiedEmail: true,
      emailVerified: claims.email_verified === true,
    })
    if (resolved.error) return fail(res, resolved.error)

    signSession(res, resolved.userId)
    clearOidcFlowCookie(res)
    return res.redirect(302, `${appPublicOrigin()}/`)
  } catch (error) {
    console.error('oidc.callback.failure', error instanceof Error ? error.message : 'failed')
    return fail(res, 'oidc_sign_in_failed')
  }
})

router.post('/hub', urlencoded, async (req, res) => {
  const config = getOidcConfig()
  if (!config.legacyBridgeEnabled) return redirectToSsoError(res, 'legacy_bridge_disabled')
  const secret = process.env.SSO_TOKEN_SECRET
  if (!secret) return redirectToSsoError(res, 'sso_not_configured')

  const token = req.body?.token
  if (!token || typeof token !== 'string') return redirectToSsoError(res, 'missing_token')

  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      clockTolerance: 0,
      maxAge: HUB_TOKEN_MAX_AGE_SECONDS,
    })
    // The contract requires exp; jsonwebtoken only enforces it when present.
    if (typeof payload?.exp !== 'number') return redirectToSsoError(res, 'invalid_token')
    // A Hub token signs in once. A second POST of the same token is refused until it expires.
    if (!hubTokens.claim(token, payload.exp)) return redirectToSsoError(res, 'invalid_token')
    const resolved = await resolveHubUser({
      hubUserId: payload.user_id,
      email: payload.email,
      requireVerifiedEmail: false,
      emailVerified: false,
    })
    if (resolved.error) return redirectToSsoError(res, resolved.error)
    signSession(res, resolved.userId)
    return res.redirect(302, `${appPublicOrigin()}/`)
  } catch (error) {
    if (error?.name === 'TokenExpiredError' || error?.name === 'JsonWebTokenError' || error?.name === 'NotBeforeError') {
      return redirectToSsoError(res, 'invalid_token')
    }
    console.error('legacy-hub.failure', error instanceof Error ? error.message : 'failed')
    return redirectToSsoError(res, 'sign_on_failed')
  }
})

function fail(res, code) {
  clearOidcFlowCookie(res)
  return redirectToSsoError(res, code)
}

function absoluteRequestUrl(req) {
  const host = (req.get('x-forwarded-host') || req.get('host') || 'localhost:3010').split(',')[0].trim()
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim()
  return `${proto}://${host}${req.originalUrl}`
}

function sendBreakout(res, target) {
  const safeJs = JSON.stringify(target)
  const href = escapeHtmlAttr(target)
  return res.status(200).type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Continue sign-in</title></head><body>
<script>try{window.top.location.replace(${safeJs});}catch(e){window.location.replace(${safeJs});}</script>
<noscript><p><a href="${href}" target="_top">Continue sign-in</a></p></noscript>
</body></html>`)
}

function escapeHtmlAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/'/g, '&#39;')
}

export default router
