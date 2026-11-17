/**
 * Calendar days in requests. A shape check alone lets 2026-02-30 through to the database, which then fails
 * the request with a 500; these check the day really exists.
 */

/** Whether the text is a real day as YYYY-MM-DD. */
export function isCalendarDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** A day as YYYY-MM-DD, or null when the text is not a real day. */
export function calendarDay(value) {
  return isCalendarDay(value) ? value : null
}

const DAY_PARAMS = ['from', 'to', 'date', 'on', 'day']

/**
 * Middleware: a day given in the query string must be a real day, or the request is refused with 400
 * `invalid_date` (naming the parameter). Absent or empty parameters are left to the route.
 */
export function rejectBadDays(req, res, next) {
  for (const name of DAY_PARAMS) {
    const value = req.query?.[name]
    if (value === undefined || value === '') continue
    if (!isCalendarDay(value)) return res.status(400).json({ error: 'invalid_date', parameter: name })
  }
  next()
}
