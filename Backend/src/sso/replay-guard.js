import crypto from 'node:crypto'

/**
 * Remembers Hub bridge tokens already used, until they expire, so each signs in once.
 * Kept in memory: correct for the single API container this app runs. With several API
 * instances, move this to a shared store.
 */
export class HubTokenReplayGuard {
  constructor({ now = () => Date.now(), maxEntries = 10_000 } = {}) {
    this.now = now
    this.maxEntries = maxEntries
    this.used = new Map()
  }

  /** Returns true the first time a token is seen before it expires, false on any repeat. */
  claim(token, expSeconds) {
    const nowMs = this.now()
    this.prune(nowMs)
    const key = crypto.createHash('sha256').update(String(token)).digest('hex')
    if (this.used.has(key)) return false
    if (this.used.size >= this.maxEntries) {
      // Never grow without bound; the oldest entry is the closest to expiring anyway.
      this.used.delete(this.used.keys().next().value)
    }
    this.used.set(key, expSeconds * 1000)
    return true
  }

  prune(nowMs) {
    for (const [key, expiresAt] of this.used) {
      if (expiresAt <= nowMs) this.used.delete(key)
    }
  }
}
