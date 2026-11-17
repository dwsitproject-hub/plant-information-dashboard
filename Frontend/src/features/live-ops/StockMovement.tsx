import { useEffect, useMemo, useState } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useRepository } from '../../data/OperationsContext.tsx'
import type { TankHistory } from '../../data/repository.ts'
import { commoditySources, commodityStock } from '../../domain/commodityStock.ts'
import { formatDay } from '../../domain/format.ts'
import { movementStats, periodStart, type DayValue, type MovementStats } from '../../domain/movement.ts'
import type { TankLive } from '../../domain/types.ts'
import { useLocale } from '../../i18n/LocaleContext.tsx'
import { useMass } from './massUnit.ts'
import { commodityQuantitySeries } from './quantitySeries.ts'
import { Sparkline } from './Sparkline.tsx'

const DAYS = 30
const TOTAL = '__total__'

interface Row {
  key: string
  label: string
  series: DayValue[]
  stats: MovementStats | null
}

function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template)
}

function shortDay(iso: string): string {
  const [, month, day] = iso.split('-')
  return month && day ? `${Number(day)}/${Number(month)}` : iso
}

/**
 * Commodity Stock Movement on the Tank & Stock Dashboard: the total stock and each commodity's stock over
 * the 30 days ending on the dashboard day. Commodities are the same groups as the cards above, built from
 * the same tanks, so the two sections always agree.
 */
export function StockMovement({ tanks, day }: { tanks: TankLive[]; day: string }) {
  const { t, locale } = useLocale()
  const mass = useMass()
  const repository = useRepository()
  const from = day ? periodStart(day, DAYS) : ''
  const [loaded, setLoaded] = useState<{ key: string; histories: TankHistory[] } | null>(null)
  const [failed, setFailed] = useState(false)
  const [selected, setSelected] = useState<string>(TOTAL)
  const key = `${from}|${day}`

  useEffect(() => {
    if (!day) return
    let active = true
    repository
      .getStockHistory(from, day)
      .then((histories) => {
        if (!active) return
        setLoaded({ key, histories })
        setFailed(false)
      })
      .catch(() => {
        if (active) setFailed(true)
      })
    return () => {
      active = false
    }
  }, [repository, from, day, key])

  const rows = useMemo<Row[]>(() => {
    const histories = loaded?.key === key ? loaded.histories : []
    if (histories.length === 0) return []
    const byTank = new Map(histories.map((history) => [history.tankId, history]))
    const groups = commodityStock(tanks).filter((row) => row.tankCount > 0).map((row) => row.code)
    const pick = (ids: string[]) => ids.flatMap((id) => (byTank.has(id) ? [byTank.get(id) as TankHistory] : []))
    const groupRows = groups.map((code) => {
      const series = commodityQuantitySeries(pick(commoditySources(tanks, code).map((tank) => tank.tankId)), from, day)
      return { key: code, label: code, series, stats: movementStats(series) }
    })
    const allIds = [...new Set(groups.flatMap((code) => commoditySources(tanks, code).map((tank) => tank.tankId)))]
    const totalSeries = commodityQuantitySeries(pick(allIds), from, day)
    return [
      { key: TOTAL, label: t.movementAll, series: totalSeries, stats: movementStats(totalSeries) },
      ...groupRows.sort((a, b) => (b.stats?.end ?? -1) - (a.stats?.end ?? -1)),
    ]
  }, [loaded, key, tanks, from, day, t.movementAll])

  const chosen = rows.find((row) => row.key === selected) ?? rows[0]
  const pct = (stats: MovementStats | null) => (stats?.pct == null ? '—' : `${stats.pct >= 0 ? '+' : ''}${(stats.pct * 100).toFixed(1)}%`)
  const signed = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${mass.amount(Math.abs(value))}`
  const toneOf = (stats: MovementStats | null): 'up' | 'down' | 'flat' => (!stats || stats.change === 0 ? 'flat' : stats.change > 0 ? 'up' : 'down')

  return (
    <section className="commodity-stock stock-movement" aria-label={t.stockMovement}>
      <div className="section-head">
        <div>
          <h2 className="card__title">{t.stockMovement}</h2>
          <p className="stock-movement__blurb">
            {day ? `${formatDay(from, locale)} – ${formatDay(day, locale)}. ` : ''}{t.stockMovementBlurb}
          </p>
        </div>
      </div>
      {failed ? <p className="page-error" role="alert">{t.loadFailed}</p> : null}
      {!failed && loaded?.key !== key ? <p className="page-note">{t.loading}</p> : null}
      {loaded?.key === key && !rows.some((row) => row.stats) ? <p className="empty">{t.movementNoData}</p> : null}
      {chosen?.stats ? (
        <div className="stock-movement__chart">
          <p className="stock-movement__chosen">
            <strong>{chosen.label}</strong>
            <span>{signed(chosen.stats.change)} {mass.symbol} ({pct(chosen.stats)})</span>
          </p>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chosen.series} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
              <CartesianGrid stroke="#E0E0E0" vertical={false} />
              <XAxis dataKey="day" tickFormatter={shortDay} tick={{ fontSize: 11 }} interval={Math.max(0, Math.ceil(chosen.series.length / 7) - 1)} height={22} />
              <YAxis tick={{ fontSize: 11 }} width={72} tickFormatter={(value: number) => mass.axis(value)} domain={['auto', 'auto']} />
              <Tooltip
                formatter={(value) => [`${mass.amount(Number(value))} ${mass.symbol}`, chosen.label]}
                labelFormatter={(label) => formatDay(String(label), locale)}
              />
              <Line type="monotone" dataKey="value" stroke="#114C5A" strokeWidth={2} dot={{ r: 2.5 }} connectNulls isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
          <p className="stock-movement__note">{t.movementGapNote}</p>
        </div>
      ) : null}
      {rows.length > 0 ? (
        <div className="prod-scroll">
          <table className="prod-table stock-movement__table">
            <thead>
              <tr>
                <th>{t.commodity}</th>
                <th className="num">{t.movementStart} ({mass.symbol})</th>
                <th className="num">{t.movementLatest} ({mass.symbol})</th>
                <th className="num">{t.movementChange} ({mass.symbol})</th>
                <th className="num">%</th>
                <th className="num">{t.movementHigh}</th>
                <th className="num">{t.movementLow}</th>
                <th>{t.movementTrend}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const stats = row.stats
                const tone = toneOf(stats)
                return (
                  <tr
                    key={row.key}
                    className={[
                      row.key === TOTAL ? 'stock-movement__total' : '',
                      chosen?.key === row.key ? 'stock-movement__row--on' : '',
                    ].filter(Boolean).join(' ') || undefined}
                  >
                    <td>
                      <button
                        type="button"
                        className="prod-plant-link"
                        aria-pressed={chosen?.key === row.key}
                        title={fill(t.movementShowOnChart, { name: row.label })}
                        disabled={!stats}
                        onClick={() => setSelected(row.key)}
                      >
                        {row.label}
                      </button>
                    </td>
                    <td className="num" title={stats ? formatDay(stats.startDay, locale) : undefined}>{stats ? mass.amount(stats.start) : '—'}</td>
                    <td className="num" title={stats ? formatDay(stats.endDay, locale) : undefined}>{stats ? mass.amount(stats.end) : '—'}</td>
                    <td className={`num stock-movement__change stock-movement__change--${tone}`}>{stats ? signed(stats.change) : '—'}</td>
                    <td className={`num stock-movement__change stock-movement__change--${tone}`}>{pct(stats)}</td>
                    <td className="num" title={stats ? fill(t.movementOnDay, { value: mass.amount(stats.high), day: formatDay(stats.highDay, locale) }) : undefined}>{stats ? mass.compact(stats.high) : '—'}</td>
                    <td className="num" title={stats ? fill(t.movementOnDay, { value: mass.amount(stats.low), day: formatDay(stats.lowDay, locale) }) : undefined}>{stats ? mass.compact(stats.low) : '—'}</td>
                    <td><Sparkline series={row.series} tone={tone} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  )
}
