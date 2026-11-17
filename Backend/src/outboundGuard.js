/**
 * Guard for requests the server makes to addresses an administrator typed in (gauge systems, DataHub).
 * Without it, "Test connection" or a poll could be pointed at the API host itself or at the cloud
 * metadata service and read what answers there (server-side request forgery).
 *
 * Private ranges (10/8, 172.16/12, 192.168/16) stay allowed: the plant gauges live there. Refused:
 * loopback, unspecified, link-local (incl. 169.254.169.254), the Alibaba Cloud metadata address
 * 100.100.100.200, multicast, reserved and broadcast ranges, and their IPv6 counterparts. A host name is
 * checked by what it resolves to. OUTBOUND_ALLOW_LOOPBACK=true allows loopback, for local development only.
 */
import dns from 'node:dns/promises'
import net from 'node:net'

const METADATA = new Set(['169.254.169.254', '100.100.100.200', '100.100.100.201'])

function v4Blocked(ip) {
  const [a, b] = ip.split('.').map(Number)
  if (METADATA.has(ip)) return 'a cloud metadata address'
  if (a === 0) return 'an unspecified address'
  if (a === 127) return process.env.OUTBOUND_ALLOW_LOOPBACK === 'true' ? null : 'a loopback address'
  if (a === 169 && b === 254) return 'a link-local address'
  if (a >= 224) return 'a multicast or reserved address'
  return null
}

function v6Blocked(ip) {
  const lower = ip.toLowerCase()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (mapped) return v4Blocked(mapped[1])
  if (lower === '::') return 'an unspecified address'
  if (lower === '::1') return process.env.OUTBOUND_ALLOW_LOOPBACK === 'true' ? null : 'a loopback address'
  if (/^fe[89ab]/.test(lower)) return 'a link-local address'
  if (lower.startsWith('ff')) return 'a multicast address'
  return null
}

/** Why an IP address may not be called, or null when it may. */
export function blockedReason(ip) {
  const kind = net.isIP(ip)
  if (kind === 4) return v4Blocked(ip)
  if (kind === 6) return v6Blocked(ip)
  return 'not an IP address'
}

function refuse(host, reason) {
  const error = new Error(`${host} is ${reason}; the server does not call it`)
  error.status = 400
  error.code = 'blocked_address'
  return error
}

/** Synchronous check of the URL itself: scheme, and the host when it is an IP literal. Throws a 400. */
export function assertAllowedUrlShape(raw) {
  const url = new URL(raw)
  if (!/^https?:$/i.test(url.protocol)) throw Object.assign(new Error('Only http and https are allowed'), { status: 400, code: 'blocked_address' })
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(host)) {
    const reason = blockedReason(host)
    if (reason) throw refuse(host, reason)
  } else if (/^localhost$/i.test(host) || /\.localhost$/i.test(host)) {
    if (process.env.OUTBOUND_ALLOW_LOOPBACK !== 'true') throw refuse(host, 'a loopback address')
  }
  return url
}

const resolved = new Map()
const RESOLVE_TTL_MS = 60_000

/**
 * Full check before a request: the URL shape, then every address the host name resolves to. A name that
 * does not resolve is let through (the request itself will fail); one that resolves to a refused address
 * throws a 400. Results are kept for a minute, since a poll makes many calls to one host.
 */
export async function assertAllowedUrl(raw) {
  const url = assertAllowedUrlShape(raw)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(host)) return url
  const cached = resolved.get(host)
  let addresses = cached && Date.now() - cached.at < RESOLVE_TTL_MS ? cached.addresses : null
  if (!addresses) {
    try {
      addresses = (await dns.lookup(host, { all: true })).map((entry) => entry.address)
    } catch {
      addresses = []
    }
    resolved.set(host, { addresses, at: Date.now() })
  }
  for (const address of addresses) {
    const reason = blockedReason(address)
    if (reason) throw refuse(host, `resolving to ${reason}`)
  }
  return url
}

/** A redirect target is followed only on the same origin (scheme, host and port) as the request. */
export function sameOrigin(from, location) {
  try {
    const next = new URL(location, from)
    return next.origin === new URL(from).origin ? next.toString() : null
  } catch {
    return null
  }
}
