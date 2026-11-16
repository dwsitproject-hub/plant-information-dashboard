export class ApiError extends Error {
  code: string

  constructor(code: string) {
    super(code)
    this.code = code
  }
}

/** The API base every screen uses. Relative by default, so the sign-in cookie is same-origin. */
export function apiBase(): string {
  return (import.meta.env.VITE_API_URL || '/api/v1').replace(/\/$/, '')
}

/** Screens write paths as `/api/v1/...`; they are sent to VITE_API_URL when it says otherwise. */
export function apiUrl(path: string): string {
  return path.startsWith('/api/v1/') || path === '/api/v1' ? `${apiBase()}${path.slice('/api/v1'.length)}` : path
}

export const SESSION_EXPIRED_EVENT = 'pid:session-expired'

/**
 * Tell the app the session is gone (expired, or the account was turned off). AuthContext listens and
 * clears the user, so the route guard sends the person to the sign-in page instead of leaving every
 * screen failing quietly.
 */
export function notifySessionExpired(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(apiUrl(path), { ...options, headers, credentials: 'include' })
  if (response.status === 204) return undefined as T
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const code = typeof body.error === 'string' ? body.error : 'request_failed'
    // A wrong password on the sign-in form is 401 too, but says invalid_credentials.
    if (response.status === 401 && code === 'unauthenticated') notifySessionExpired()
    throw new ApiError(code)
  }
  return body as T
}
