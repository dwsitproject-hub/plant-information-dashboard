import type { DayValue } from '../../domain/movement.ts'

/**
 * A small trend line for a table row. Days without a reading are skipped, so the line joins the readings
 * either side instead of dropping to zero.
 */
export function Sparkline({ series, width = 96, height = 24, tone = 'flat' }: { series: DayValue[]; width?: number; height?: number; tone?: 'up' | 'down' | 'flat' }) {
  const measured = series
    .map((point, index) => ({ index, value: point.value }))
    .filter((point): point is { index: number; value: number } => point.value != null)
  if (measured.length < 2) return <svg className="sparkline" width={width} height={height} aria-hidden="true" />
  const values = measured.map((point) => point.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const step = series.length > 1 ? (width - 4) / (series.length - 1) : 0
  const points = measured
    .map((point) => `${(2 + point.index * step).toFixed(1)},${(height - 3 - ((point.value - min) / span) * (height - 6)).toFixed(1)}`)
    .join(' ')
  const last = measured[measured.length - 1]
  return (
    <svg className={`sparkline sparkline--${tone}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline points={points} fill="none" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={2 + last.index * step} cy={height - 3 - ((last.value - min) / span) * (height - 6)} r="2" />
    </svg>
  )
}
