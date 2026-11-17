/** Stock movement over a period: where a series started and ended, and its high and low. */

export interface DayValue {
  day: string
  value: number | null
}

export interface MovementStats {
  start: number
  startDay: string
  end: number
  endDay: string
  change: number
  /** Change as a fraction of the start. Null when the start is zero. */
  pct: number | null
  high: number
  highDay: string
  low: number
  lowDay: string
  /** Days in the period that have a reading. */
  measured: number
}

/** The movement of a daily series: first reading to last, with the high and low between. Null with no reading. */
export function movementStats(series: DayValue[]): MovementStats | null {
  const measured = series.filter((point): point is { day: string; value: number } => point.value != null)
  if (measured.length === 0) return null
  const first = measured[0]
  const last = measured[measured.length - 1]
  let high = first
  let low = first
  for (const point of measured) {
    if (point.value > high.value) high = point
    if (point.value < low.value) low = point
  }
  return {
    start: first.value,
    startDay: first.day,
    end: last.value,
    endDay: last.day,
    change: last.value - first.value,
    pct: first.value === 0 ? null : (last.value - first.value) / first.value,
    high: high.value,
    highDay: high.day,
    low: low.value,
    lowDay: low.day,
    measured: measured.length,
  }
}

/** The first day of a period of `days` days that ends on `end`. */
export function periodStart(end: string, days: number): string {
  const date = new Date(`${end}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() - (days - 1))
  return date.toISOString().slice(0, 10)
}
