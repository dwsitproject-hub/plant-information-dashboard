/**
 * Slows password guessing. After `maxFailures` wrong passwords for one account within `windowMs`,
 * that account refuses password checks until the window has passed. Keyed by account name, not IP,
 * because every request reaches the API through the same nginx address.
 *
 * Kept in memory: correct for the single API container this app runs, and reset by a restart.
 */
export class LoginThrottle {
  constructor({ maxFailures = 10, windowMs = 15 * 60 * 1000, now = () => Date.now(), maxEntries = 10_000 } = {}) {
    this.maxFailures = maxFailures
    this.windowMs = windowMs
    this.now = now
    this.maxEntries = maxEntries
    this.failures = new Map()
  }

  key(name) {
    return String(name ?? '').trim().toLowerCase()
  }

  entry(name) {
    const key = this.key(name)
    const found = this.failures.get(key)
    if (found && this.now() - found.firstAt >= this.windowMs) {
      this.failures.delete(key)
      return { key, found: null }
    }
    return { key, found }
  }

  /** True when this account may try a password now. */
  allowed(name) {
    const { found } = this.entry(name)
    return !found || found.count < this.maxFailures
  }

  fail(name) {
    const { key, found } = this.entry(name)
    if (found) {
      found.count += 1
      return
    }
    if (this.failures.size >= this.maxEntries) this.prune()
    if (this.failures.size >= this.maxEntries) this.failures.delete(this.failures.keys().next().value)
    this.failures.set(key, { count: 1, firstAt: this.now() })
  }

  succeed(name) {
    this.failures.delete(this.key(name))
  }

  prune() {
    const now = this.now()
    for (const [key, value] of this.failures) {
      if (now - value.firstAt >= this.windowMs) this.failures.delete(key)
    }
  }
}

export const loginThrottle = new LoginThrottle()
