import { useEffect, useMemo, useState } from 'react'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../../data/api.ts'
import { formatDay } from '../../domain/format.ts'
import { formatTonnes, type CommodityClass } from '../../domain/management.ts'
import { movementStats, type MovementStats } from '../../domain/movement.ts'
import { useLocale } from '../../i18n/LocaleContext.tsx'
import { Sparkline } from '../live-ops/Sparkline.tsx'
import { useClassLabel } from './parts.tsx'

interface MovementPoint {
  day: string
  quantityKg: number | null
  tanks: number
}

interface SiteMovementRow {
  id: string
  name: string
  from: string
  to: string
  series: MovementPoint[]
  classes: Array<{ code: CommodityClass; series: MovementPoint[] }>
}

interface MovementPayload {
  days: number
  sites: SiteMovementRow[]
  failed: Array<{ id: string; name: string }>
}

/** One colour per site line, in the order the sites are listed. */
const SITE_COLOURS = ['#114C5A', '#2a78d6', '#d9822b', '#0f7a55', '#8e44ad', '#c0392b', '#7f8c8d']

function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template)
}

function shortDay(iso: string): string {
  const [, month, day] = iso.split('-')
  return month && day ? `${Number(day)}/${Number(month)}` : iso
}

const toDayValues = (series: MovementPoint[]) => series.map((point) => ({ day: point.day, value: point.quantityKg }))

/**
 * Commodity Stock Movement on the Stock Overview: each site's total stock per day over the last 30 days,
 * one line per site, with where each started and ended and the commodity classes that moved most.
 */
export function SiteMovement() {
  const { t, locale } = useLocale()
  const label = useClassLabel()
  const [data, setData] = useState<MovementPayload | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    api<MovementPayload>('/api/v1/portfolio/movement?days=30')
      .then((body) => {
        if (active) setData(body)
      })
      .catch(() => {
        if (active) setFailed(true)
      })
    return () => {
      active = false
    }
  }, [])

  const rows = useMemo(() => (data?.sites ?? []).map((site, index) => {
    const stats = movementStats(toDayValues(site.series))
    const moves = site.classes
      .map((cls) => ({ code: cls.code, stats: movementStats(toDayValues(cls.series)) }))
      .filter((cls): cls is { code: CommodityClass; stats: MovementStats } => cls.stats != null && cls.stats.change !== 0)
      .sort((a, b) => Math.abs(b.stats.change) - Math.abs(a.stats.change))
      .slice(0, 3)
    return { site, stats, moves, colour: SITE_COLOURS[index % SITE_COLOURS.length] }
  }), [data])

  // One row per day across all sites; a site's own "today" can differ by its time zone.
  const chartData = useMemo(() => {
    const byDay = new Map<string, Record<string, number | string | null>>()
    for (const { site } of rows) {
      for (const point of site.series) {
        const entry = byDay.get(point.day) ?? { day: point.day }
        entry[site.id] = point.quantityKg
        byDay.set(point.day, entry)
      }
    }
    return [...byDay.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)))
  }, [rows])

  const tonnes = (kg: number) => formatTonnes(kg, locale)
  const signed = (kg: number) => `${kg > 0 ? '+' : kg < 0 ? '−' : ''}${tonnes(Math.abs(kg))}`
  const pct = (stats: MovementStats | null) => (stats?.pct == null ? '—' : `${stats.pct >= 0 ? '+' : ''}${(stats.pct * 100).toFixed(1)}%`)
  const toneOf = (stats: MovementStats | null): 'up' | 'down' | 'flat' => (!stats || stats.change === 0 ? 'flat' : stats.change > 0 ? 'up' : 'down')
  // Sites can end on different days (a logsheet site on its latest entered day), so show the whole span.
  const span = rows.length
    ? {
        from: rows.map((row) => row.site.from).sort()[0],
        to: rows.map((row) => row.site.to).sort().at(-1) as string,
      }
    : null

  return (
    <section className="mg-attention mg-movement" aria-label={t.stockMovement}>
      <h2>{t.stockMovement}</h2>
      <p className="mg-muted mg-movement__blurb">
        {span ? `${formatDay(span.from, locale)} – ${formatDay(span.to, locale)}. ` : ''}{t.stockMovementSitesBlurb}
      </p>
      {failed ? <p className="mg-alert" role="alert">{t.loadFailed}</p> : null}
      {!data && !failed ? <p className="mg-muted">{t.loading}</p> : null}
      {data?.failed.map((site) => <p key={site.id} className="mg-alert" role="status">{fill(t.mgSiteFailed, { site: site.name })}</p>)}
      {data && rows.every((row) => !row.stats) ? <p className="mg-muted">{t.movementNoData}</p> : null}
      {rows.some((row) => row.stats) ? (
        <>
          <div className="mg-movement__chart">
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartData} margin={{ top: 8, right: 12, left: 8, bottom: 0 }}>
                <CartesianGrid stroke="#E0E0E0" vertical={false} />
                <XAxis dataKey="day" tickFormatter={shortDay} tick={{ fontSize: 11 }} interval={Math.max(0, Math.ceil(chartData.length / 7) - 1)} height={22} />
                <YAxis tick={{ fontSize: 11 }} width={64} tickFormatter={(value: number) => tonnes(value)} />
                <Tooltip
                  formatter={(value, name) => [`${tonnes(Number(value))} t`, rows.find((row) => row.site.id === name)?.site.name ?? String(name)]}
                  labelFormatter={(value) => formatDay(String(value), locale)}
                />
                <Legend formatter={(value) => rows.find((row) => row.site.id === value)?.site.name ?? value} wrapperStyle={{ fontSize: 12 }} />
                {rows.map((row) => (
                  <Line key={row.site.id} type="monotone" dataKey={row.site.id} stroke={row.colour} strokeWidth={2} dot={{ r: 2 }} connectNulls isAnimationActive={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
            <p className="mg-muted mg-movement__note">{t.movementGapNote}</p>
          </div>
          <div className="mg-table-wrap">
            <table className="mg-table mg-movement__table">
              <thead>
                <tr>
                  <th>{t.mgColSite}</th>
                  <th className="num">{t.movementStart} (t)</th>
                  <th className="num">{t.movementLatest} (t)</th>
                  <th className="num">{t.movementChange} (t)</th>
                  <th className="num">%</th>
                  <th className="num">{t.movementHigh}</th>
                  <th className="num">{t.movementLow}</th>
                  <th>{t.movementTopMoves}</th>
                  <th>{t.movementTrend}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ site, stats, moves, colour }) => {
                  const tone = toneOf(stats)
                  return (
                    <tr key={site.id}>
                      <td>
                        <span className="mg-movement__site">
                          <i className="mg-dot" style={{ background: colour }} aria-hidden="true" />
                          {site.name}
                        </span>
                      </td>
                      <td className="num" title={stats ? formatDay(stats.startDay, locale) : undefined}>{stats ? tonnes(stats.start) : '—'}</td>
                      <td className="num" title={stats ? formatDay(stats.endDay, locale) : undefined}>{stats ? tonnes(stats.end) : '—'}</td>
                      <td className={`num mg-movement__change mg-movement__change--${tone}`}>{stats ? signed(stats.change) : '—'}</td>
                      <td className={`num mg-movement__change mg-movement__change--${tone}`}>{pct(stats)}</td>
                      <td className="num" title={stats ? fill(t.movementOnDay, { value: `${tonnes(stats.high)} t`, day: formatDay(stats.highDay, locale) }) : undefined}>{stats ? tonnes(stats.high) : '—'}</td>
                      <td className="num" title={stats ? fill(t.movementOnDay, { value: `${tonnes(stats.low)} t`, day: formatDay(stats.lowDay, locale) }) : undefined}>{stats ? tonnes(stats.low) : '—'}</td>
                      <td>
                        <span className="mg-movement__moves">
                          {moves.length === 0 ? <span className="mg-muted">—</span> : moves.map((move) => (
                            <span key={move.code} className={`mg-movement__move mg-movement__change--${toneOf(move.stats)}`}>
                              <i className={`mg-dot mg-c--${move.code}`} aria-hidden="true" />
                              {label(move.code)} {signed(move.stats.change)} t
                            </span>
                          ))}
                        </span>
                      </td>
                      <td><Sparkline series={toDayValues(site.series)} tone={tone} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  )
}
