/**
 * In-memory request limits per client address, so one client cannot flood the API or try passwords for
 * many accounts (the per-account lockout in loginThrottle.js does not stop that). Counts reset every
 * window. Generous on purpose: a plant office may share one address. Held in memory, so the counts are
 * per API process.
 */
export function rateLimit({ windowMs, max, code = 'too_many_requests', methods = null }) {
  const hits = new Map()
  let sweptAt = Date.now()
  return (req, res, next) => {
    if (methods && !methods.includes(req.method)) return next()
    const now = Date.now()
    if (now - sweptAt > windowMs) {
      for (const [key, entry] of hits) if (now - entry.start > windowMs) hits.delete(key)
      sweptAt = now
    }
    const key = req.ip || req.socket?.remoteAddress || 'unknown'
    const entry = hits.get(key)
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 })
      return next()
    }
    entry.count += 1
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.start + windowMs - now) / 1000)))
      return res.status(429).json({ error: code })
    }
    next()
  }
}
