import { useEffect, useMemo, useRef, useState } from 'react'
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useRepository } from '../../data/OperationsContext.tsx'
import { formatDay, formatMeasure, tankLabel } from '../../domain/format.ts'
import {
  breachesOf,
  codesFor,
  dailyQuality,
  periodQuality,
  previousDay,
  qualityFor,
  valuesAsOf,
  type LabPointLike,
  type ParamView,
  type QualitySample,
} from '../../domain/qualityView.ts'
import type { LabHistoryPoint, SoundingPoint, TankLive } from '../../domain/types.ts'
import { useLocale } from '../../i18n/LocaleContext.tsx'
import { DateRangeFilter } from '../daily-production/DateRangeFilter.tsx'
import { addDays } from '../usePeriodRange.ts'
import { LevelCue } from './LevelCue.tsx'
import { useMass } from './massUnit.ts'
import { commodityDayReading, commodityQuantitySeries, type HistoryDay } from './quantitySeries.ts'
import { isOverfilled, isTempAnomaly } from './tankAlerts.ts'
import { SHOW_LOADABLE } from './columns.ts'
import { QualityChips } from './QualityChips.tsx'

/** One tank in the dialog: its stock, and its quality with yesterday's values. */
export interface TrendTank extends Pick<TankLive, 'tankId' | 'quantityKg' | 'operationalStatus'> {
  productName?: string
  sample: QualitySample
}

const DEFAULT_DAYS = 30

export function CommodityTrendDialog({
  code,
  title,
  sources,
  day,
  averageTemperature,
  hasLabData = true,
  showProduct = false,
  loadHistory,
  loadLabs,
  onClose,
}: {
  /** What is open; null closes the dialog. */
  code: string | null
  /** The heading, such as "CPO" or "RBDPO · Bekasi". */
  title: string
  sources: TrendTank[]
  /** Where each tank's daily readings come from. Defaults to the active site's repository. */
  loadHistory?: (tankId: string) => Promise<SoundingPoint[]>
  /** Where each tank's lab results come from. Defaults to the active site's repository. */
  loadLabs?: (tankId: string) => Promise<LabHistoryPoint[]>
  /** Show each tank's product, for a dialog that covers several products. */
  showProduct?: boolean
  /** Dashboard day. The dialog range defaults to the 30 days ending here. */
  day: string
  averageTemperature: number | null
  hasLabData?: boolean
  onClose: () => void
}) {
  const { t, locale } = useLocale()
  const mass = useMass()
  const repository = useRepository()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [histories, setHistories] = useState<Array<{ tankId: string; points: SoundingPoint[] }>>([])
  const [loadFailed, setLoadFailed] = useState(false)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [range, setRange] = useState(() => defaultRange(day))
  const { start, end } = range
  const loadRef = useRef(loadHistory)
  const labsRef = useRef(loadLabs)
  useEffect(() => {
    loadRef.current = loadHistory
    labsRef.current = loadLabs
  }, [loadHistory, loadLabs])
  const [labs, setLabs] = useState<Map<string, LabPointLike[]>>(new Map())
  const sourceKey = sources.map((tank) => tank.tankId).join(',')
  const series = useMemo(() => {
    const ids = new Set(sourceKey ? sourceKey.split(',') : [])
    const matching = histories.filter((history) => ids.has(history.tankId))
    if (ids.size === 0 || matching.length !== ids.size) return []
    return commodityQuantitySeries(matching, start, end)
  }, [histories, sourceKey, start, end])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (code && !dialog.open) dialog.showModal()
    if (!code && dialog.open) dialog.close()
  }, [code])

  useEffect(() => {
    setSelectedDay(null)
    setHistories([])
    setLabs(new Map())
    if (code) setRange(defaultRange(day))
  }, [code, day])

  const changeRange = (nextStart: string, nextEnd: string) => {
    setRange({ start: nextStart, end: nextEnd })
    if (selectedDay && (selectedDay < nextStart || selectedDay > nextEnd)) setSelectedDay(null)
  }

  useEffect(() => {
    if (!code) return
    const ids = sourceKey ? sourceKey.split(',') : []
    let active = true
    const load = loadRef.current ?? ((tankId: string) => repository.getSoundingHistory(tankId))
    Promise.all(ids.map(async (tankId) => ({ tankId, points: await load(tankId) })))
      .then((rows) => {
        if (!active) return
        setHistories(rows)
        setLoadFailed(false)
      })
      .catch(() => {
        if (active) setLoadFailed(true)
      })
    return () => {
      active = false
    }
  }, [repository, code, sourceKey])

  // Lab results per tank, for the product's average quality on each day. A tank whose results fail to
  // load only drops out of the averages; the stock figures still show.
  useEffect(() => {
    if (!code || !hasLabData) return
    const ids = sourceKey ? sourceKey.split(',') : []
    let active = true
    const load = labsRef.current ?? ((tankId: string) => repository.getLabHistory(tankId))
    Promise.all(ids.map(async (tankId) => [tankId, await load(tankId).catch(() => [])] as const)).then((rows) => {
      if (active) setLabs(new Map(rows))
    })
    return () => {
      active = false
    }
  }, [repository, code, sourceKey, hasLabData])

  const stats = seriesStats(series)
  const historyByTank = useMemo(() => new Map(histories.map((history) => [history.tankId, history.points])), [histories])

  // The product's parameters and limits (Master > Commodities), then its average quality per day over the
  // tanks holding stock that day, and over the whole period.
  const codes = codesFor(sources.map((tank) => tank.sample))
  const limits = sources.flatMap((tank) => tank.sample.limits)
  const daily = useMemo(() => {
    if (labs.size === 0) return new Map<string, ParamView[]>()
    const tanks = sources.map((tank) => ({ tankId: tank.tankId, limits: tank.sample.limits, labs: labs.get(tank.tankId) ?? [] }))
    const holds = (tankId: string, on: string) => {
      const reading = commodityDayReading(tankId, historyByTank.get(tankId) ?? [], on)
      return reading?.quantityKg != null && reading.quantityKg > 0
    }
    return dailyQuality(tanks, series.map((point) => point.day), codes, holds)
    // codes and sources follow sourceKey and the labs loaded for them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labs, series, historyByTank, sourceKey])
  const period = periodQuality(daily, codes, limits)
  const hasPeriodQuality = period.some((view) => view.value != null)

  /** A tank's quality on the chosen day, from its lab results; today's result until they load. */
  const sampleOn = (tank: TrendTank, on: string | null): QualitySample => {
    const tankLabs = labs.get(tank.tankId)
    if (!on || !tankLabs) return tank.sample
    const now = valuesAsOf(tankLabs, on) ?? []
    return {
      tankId: tank.tankId,
      parameters: now,
      limits: tank.sample.limits,
      breaches: breachesOf(now, tank.sample.limits),
      before: valuesAsOf(tankLabs, previousDay(on)),
    }
  }
  const soundingDays = useMemo(() => [...new Set(histories.flatMap((history) => history.points.flatMap((point) => (point.recordedOn ? [point.recordedOn] : []))))], [histories])

  useEffect(() => {
    if (selectedDay || series.length === 0) return
    const latest = [...series].reverse().find((point) => point.value != null)
    if (latest) setSelectedDay(latest.day)
  }, [series, selectedDay])

  const readings = sources.map((tank) => {
    const reading = selectedDay ? commodityDayReading(tank.tankId, historyByTank.get(tank.tankId) ?? [], selectedDay) : null
    return { tank, reading }
  })
  const quantityTotal = sumKnown(readings.map((row) => row.reading?.quantityKg ?? null))
  const emptyTotal = sumKnown(readings.map((row) => row.reading?.emptySpaceKg ?? null))
  const loadableTotal = sumKnown(readings.map((row) => row.reading?.loadableKg ?? null))

  return (
    <dialog ref={dialogRef} className="stock-dialog stock-dialog--wide stock-dialog--trend" onClose={onClose}>
      {code && (
        <>
          <div className="stock-dialog__head">
            <div>
              <h2>{title} - {t.quantity}</h2>
              <p className="stock-dialog__updated">
                {t.tanksHolding.replace('{held}', String(sources.filter((tank) => tank.quantityKg != null && tank.quantityKg > 0).length)).replace('{total}', String(sources.length))}
              </p>
            </div>
            {start && end && (
              <DateRangeFilter start={start} end={end} dataDates={soundingDays} onChange={changeRange} />
            )}
          </div>
          {loadFailed ? <p className="page-error" role="alert">{t.loadFailed}</p> : null}
          <dl className="qty-stats">
            <div>
              <dt>{t.rangeAverage}</dt>
              <dd>{stats ? `${mass.amount(stats.average)} ${mass.symbol}` : t.unavailable}</dd>
            </div>
            <div>
              <dt>{t.rangeMax}</dt>
              <dd>{stats ? `${mass.amount(stats.max)} ${mass.symbol}` : t.unavailable}</dd>
            </div>
            <div>
              <dt>{t.rangeMin}</dt>
              <dd>{stats ? `${mass.amount(stats.min)} ${mass.symbol}` : t.unavailable}</dd>
            </div>
          </dl>
          {hasLabData && hasPeriodQuality ? (
            <div className="qty-quality" title={t.qualityHint}>
              <span className="qty-quality__label">{t.qualityPeriodAverage}</span>
              <QualityChips views={period} tanks={sources.length} />
            </div>
          ) : null}
          {stats
            ? (
              <CommodityChart
                series={series}
                selectedDay={selectedDay}
                onSelect={setSelectedDay}
                quality={daily}
              />
            )
            : <p className="empty">{t.unavailable}</p>}
          <ul className="qty-legend">
            <li><span className="qty-dot qty-dot--measured" aria-hidden="true" />{t.soundingDay}</li>
          </ul>
          {selectedDay && (
            <>
              <p className="stock-dialog__kicker">
                {t.stockSources}
                <span className="trend-day">{formatDay(selectedDay, locale)}</span>
              </p>
              <div className="stock-dialog__scroll">
                <table className="stock-dialog__table">
                  <thead>
                    <tr>
                      <th>{t.tank}</th>
                      {showProduct && <th>{t.commodity}</th>}
                      <th className="num">{t.levelAxis}</th>
                      <th className="num">{t.quantity} ({mass.symbol})</th>
                      <th className="num">{t.emptySpace} ({mass.symbol})</th>
                      {SHOW_LOADABLE && <th className="num">{t.loadable} ({mass.symbol})</th>}
                      <th className="num">{t.tankLevelPct}</th>
                      <th className="num">{t.tempAxis}</th>
                      {hasLabData && <th title={t.qualityHint}>{t.quality}</th>}
                      <th>{t.status}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {readings.map(({ tank, reading }) => {
                      const overfilled = isOverfilled(reading?.levelRatio)
                      const hot = isTempAnomaly(reading?.temperatureC, averageTemperature)
                      const sample = sampleOn(tank, selectedDay)
                      const quality = qualityFor([sample])
                      const outOfSpec = quality.some((view) => view.status === 'reject')
                      const status = reading?.operationalStatus || tank.operationalStatus || t.unavailable
                      return (
                        <tr key={tank.tankId} className={overfilled || hot || outOfSpec ? 'stock-dialog__row--alert' : undefined}>
                          <td>{tankLabel(tank.tankId)}</td>
                          {showProduct && <td>{tank.productName || t.unavailable}</td>}
                          <td className="num">{reading?.soundingLevelM == null ? t.unavailable : formatMeasure(reading.soundingLevelM, 3)}</td>
                          <td className="num">{reading?.quantityKg == null ? t.unavailable : mass.amount(reading.quantityKg)}</td>
                          <td className="num">{reading?.emptySpaceKg == null ? t.unavailable : mass.amount(reading.emptySpaceKg)}</td>
                          {SHOW_LOADABLE && <td className="num">{reading?.loadableKg == null ? t.unavailable : mass.amount(reading.loadableKg)}</td>}
                          <td className="num"><LevelCue ratio={reading?.levelRatio ?? null} blank={t.unavailable} /></td>
                          <td className={hot ? 'num stock-dialog__alert' : 'num'}>
                            {reading?.temperatureC == null ? t.unavailable : `${formatMeasure(reading.temperatureC, 1)} °C`}
                          </td>
                          {hasLabData && (
                            <td className="tank-quality-cell">
                              {sample.parameters.length === 0
                                ? <span className="um-muted" title={t.labNoResult}>{t.unavailable}</span>
                                : <QualityChips views={quality} />}
                            </td>
                          )}
                          <td>
                            <span className={status === 'EMPTY' ? 'badge badge--muted' : overfilled ? 'badge badge--danger' : 'badge'}>{status}</span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>{t.totalQuantity}</td>
                      {showProduct && <td />}
                      <td />
                      <td className="num">{quantityTotal == null ? t.unavailable : mass.amount(quantityTotal)}</td>
                      <td className="num">{emptyTotal == null ? t.unavailable : mass.amount(emptyTotal)}</td>
                      {SHOW_LOADABLE && <td className="num">{loadableTotal == null ? t.unavailable : mass.amount(loadableTotal)}</td>}
                      <td colSpan={(SHOW_LOADABLE ? 4 : 3) + (hasLabData ? 1 : 0)} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
          <div className="stock-dialog__actions">
            <button type="button" className="btn btn--secondary" onClick={onClose}>{t.close}</button>
          </div>
        </>
      )}
    </dialog>
  )
}

function defaultRange(day: string): { start: string; end: string } {
  if (!day) return { start: '', end: '' }
  return { start: addDays(day, -(DEFAULT_DAYS - 1)), end: day }
}

function seriesStats(series: HistoryDay[]): { average: number; max: number; min: number } | null {
  const values = series.flatMap((point) => (point.kind === 'measured' && point.value != null ? [point.value] : []))
  if (values.length === 0) return null
  const sum = values.reduce((total, value) => total + value, 0)
  return { average: sum / values.length, max: Math.max(...values), min: Math.min(...values) }
}

function CommodityChart({
  series,
  selectedDay,
  onSelect,
  quality,
}: {
  series: HistoryDay[]
  selectedDay: string | null
  onSelect: (day: string) => void
  /** The product's average quality on each day, shown in the tooltip. */
  quality: Map<string, ParamView[]>
}) {
  const { locale } = useLocale()
  const mass = useMass()
  return (
    <div className="chart-frame qty-chart">
      <ResponsiveContainer width="100%" height={168}>
        <LineChart
          data={series}
          margin={{ top: 16, right: 8, left: 8, bottom: 0 }}
          onClick={(state) => {
            const day = state?.activeLabel
            if (typeof day === 'string') onSelect(day)
          }}
        >
          <CartesianGrid stroke="#E0E0E0" vertical={false} />
          <XAxis
            dataKey="day"
            tick={(props) => <DayTick {...props} selectedDay={selectedDay} />}
            interval={Math.max(0, Math.ceil(series.length / 6) - 1)}
            height={24}
          />
          <YAxis tick={{ fontSize: 11 }} width={72} tickFormatter={(value: number) => mass.axis(value)} />
          <Tooltip content={<CommodityTooltip locale={locale} quality={quality} />} />
          {selectedDay && (
            <ReferenceLine
              x={selectedDay}
              stroke="#c2410c"
              strokeDasharray="3 3"
              label={{ value: shortDay(selectedDay), position: 'top', fill: '#c2410c', fontSize: 11, fontWeight: 700 }}
            />
          )}
          <Line
            type="monotone"
            dataKey="value"
            stroke="#114C5A"
            strokeWidth={2}
            connectNulls={false}
            isAnimationActive={false}
            dot={<CommodityDot selectedDay={selectedDay} onSelect={onSelect} />}
            activeDot={<CommodityDot selectedDay={selectedDay} onSelect={onSelect} active />}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function DayTick({
  x,
  y,
  payload,
  selectedDay,
}: {
  x?: number | string
  y?: number | string
  payload?: { value?: string }
  selectedDay?: string | null
}) {
  const day = payload?.value ?? ''
  const selected = day === selectedDay
  return (
    <text x={x} y={Number(y ?? 0) + 12} textAnchor="middle" fill={selected ? '#c2410c' : '#6b6b6b'} fontSize={11} fontWeight={selected ? 700 : 400}>
      {shortDay(day)}
    </text>
  )
}

function shortDay(iso: string): string {
  const [, month, day] = iso.split('-')
  if (!month || !day) return iso
  return `${Number(day)}/${Number(month)}`
}

function CommodityDot({
  cx,
  cy,
  payload,
  selectedDay,
  onSelect,
  active = false,
}: {
  cx?: number
  cy?: number
  payload?: HistoryDay
  selectedDay?: string | null
  onSelect?: (day: string) => void
  active?: boolean
}) {
  if (cx == null || cy == null || payload?.value == null || payload.kind === 'gap') return <g />
  const selected = payload.day === selectedDay
  return (
    <circle
      cx={cx}
      cy={cy}
      r={selected ? 6 : active ? 5 : 3.5}
      fill={selected ? '#c2410c' : '#114C5A'}
      stroke={selected ? '#ffffff' : '#114C5A'}
      strokeWidth={selected ? 2 : 1}
      style={{ cursor: 'pointer' }}
      onClick={() => onSelect?.(payload.day)}
    />
  )
}

function CommodityTooltip({
  active,
  payload,
  label,
  locale,
  quality,
}: {
  active?: boolean
  payload?: Array<{ payload?: HistoryDay }>
  label?: string | number
  locale: 'en' | 'id'
  quality?: Map<string, ParamView[]>
}) {
  const { t } = useLocale()
  const mass = useMass()
  const row = payload?.[0]?.payload
  if (!active || !row || row.value == null || row.kind === 'gap') return null
  return (
    <div className="chart-tip">
      <strong>{formatDay(label == null ? null : String(label), locale)}</strong>
      <p>{t.quantity}: {mass.amount(row.value)} {mass.symbol}</p>
      {quality?.get(row.day)?.some((view) => view.value != null) ? (
        <div className="chart-tip__quality">
          <small>{t.qualityDayAverage}</small>
          <QualityChips views={quality.get(row.day) ?? []} tanks={quality.get(row.day)?.[0]?.count ?? 1} />
        </div>
      ) : null}
    </div>
  )
}

function sumKnown(values: Array<number | null>): number | null {
  const nums = values.filter((value): value is number => value != null)
  if (nums.length === 0) return null
  return nums.reduce((sum, value) => sum + value, 0)
}
