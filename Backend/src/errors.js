/**
 * How a failed request is answered. A client mistake is a 4xx with a short code; anything else is a 500
 * with no internals in the body (the log has them).
 *
 * - Malformed JSON body -> 400 invalid_json; body too large -> 413 payload_too_large.
 * - An error carrying a 4xx `status` (thrown on purpose) -> that status, with its `code` or message.
 * - A database "data exception" (class 22: a date like 2026-02-30, text where a number belongs, a value out
 *   of range) -> 400 invalid_input. Routes should validate first; this is the safety net.
 * - A unique violation that reached here -> 409 conflict.
 */
export function errorResponse(error) {
  if (error?.type === 'entity.parse.failed') return { status: 400, body: { error: 'invalid_json' }, log: false }
  if (error?.type === 'entity.too.large') return { status: 413, body: { error: 'payload_too_large' }, log: false }
  const status = Number(error?.status ?? error?.statusCode)
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return { status, body: { error: error.code && typeof error.code === 'string' ? error.code : error.message || 'bad_request' }, log: false }
  }
  const pgCode = typeof error?.code === 'string' ? error.code : ''
  if (pgCode.startsWith('22')) return { status: 400, body: { error: 'invalid_input' }, log: true }
  if (pgCode === '23505') return { status: 409, body: { error: 'conflict' }, log: true }
  return { status: 500, body: { error: 'request_failed' }, log: true }
}
