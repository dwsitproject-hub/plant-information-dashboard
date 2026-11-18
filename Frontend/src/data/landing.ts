/**
 * Whether this tab has already shown its start page since sign-in. The start page for a management user
 * is Stock Overview, but Tank & Stock lives at the same address as the start page (/), so the redirect
 * must happen only on arrival: afterwards a management user can still open Tank & Stock from the menu,
 * and reloading it keeps them there. Kept per tab (sessionStorage); cleared on sign-in and sign-out.
 */
const KEY = 'pid.landed'

export function hasLanded(): boolean {
  try {
    return window.sessionStorage.getItem(KEY) === '1'
  } catch {
    return true // storage blocked: never redirect, so no one is locked out of a page
  }
}

export function markLanded(): void {
  try {
    window.sessionStorage.setItem(KEY, '1')
  } catch {
    // storage blocked: nothing to remember
  }
}

export function resetLanding(): void {
  try {
    window.sessionStorage.removeItem(KEY)
  } catch {
    // storage blocked: nothing to forget
  }
}
