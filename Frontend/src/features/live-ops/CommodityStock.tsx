import { useState } from 'react'
import { ChevronRight, Thermometer } from 'lucide-react'
import type { CommodityStockRow, StockGroup } from '../../domain/commodityStock.ts'
import { commoditySources, commodityStock } from '../../domain/commodityStock.ts'
import type { TankLive } from '../../domain/types.ts'
import { formatMeasure } from '../../domain/format.ts'
import { hasChange, hasOutOfSpec, odourFailures, qualityFor, type QualitySample } from '../../domain/qualityView.ts'
import { useMass } from './massUnit.ts'
import { useLocale } from '../../i18n/LocaleContext.tsx'
import { CommodityTrendDialog, type TrendTank } from './CommodityTrendDialog.tsx'
import { LiveBadge } from './LiveBadge.tsx'
import { QualityChips, QualityFlags } from './QualityChips.tsx'
import { fillTone } from './tankAlerts.ts'
import { tankSample } from './tankQuality.ts'

export function CommodityStock({
  tanks,
  before,
  day,
  averageTemperature,
  hasLabData = true,
}: {
  tanks: TankLive[]
  /** The same tanks as of yesterday, by tank id, for the change since yesterday. */
  before: Map<string, TankLive>
  day: string
  averageTemperature: number | null
  hasLabData?: boolean
}) {
  const { t } = useLocale()
  const rows = commodityStock(tanks)
  const [openCode, setOpenCode] = useState<StockGroup | null>(null)
  // Only a gauge reading taken for today is live. The newest of them says how fresh the screen is.
  const live = tanks.filter((tank) => tank.readingKind === 'live' && tank.readingAt)
  const readings = live.map((tank) => tank.readingAt as string).sort()
  const liveAt = readings.at(-1) ?? null
  // The server knows the site's round times; it marks a reading old when the last round's poll was missed.
  const liveStale = live.length > 0 && live.every((tank) => tank.stale === true)
  const sourcesOf = (code: StockGroup): TrendTank[] => commoditySources(tanks, code).map((tank) => ({
    tankId: tank.tankId,
    quantityKg: tank.quantityKg,
    operationalStatus: tank.operationalStatus,
    productName: tank.productName,
    sample: tankSample(tank, before.get(tank.tankId)),
  }))

  return (
    <section className="commodity-stock" aria-label={t.commodityStock}>
      <h2 className="card__title">
        {t.commodityStock}
        <LiveBadge readingAt={liveAt} stale={liveStale} />
      </h2>
      <ul className="commodity-grid">
        {rows.map((row) => {
          // Quality is averaged over the tanks that hold stock, the same tanks as temperature.
          const samples = commoditySources(tanks, row.code)
            .filter((tank) => tank.quantityKg != null && tank.quantityKg > 0)
            .map((tank) => tankSample(tank, before.get(tank.tankId)))
          return (
            <li key={row.code}>
              <CommodityCard row={row} samples={samples} hasLabData={hasLabData} onOpen={() => setOpenCode(row.code)} />
            </li>
          )
        })}
      </ul>
      <CommodityTrendDialog
        code={openCode}
        title={openCode ?? ''}
        sources={openCode ? sourcesOf(openCode) : []}
        day={day}
        averageTemperature={averageTemperature}
        hasLabData={hasLabData}
        onClose={() => setOpenCode(null)}
      />
    </section>
  )
}

function CommodityCard({ row, samples, hasLabData, onOpen }: { row: CommodityStockRow; samples: QualitySample[]; hasLabData: boolean; onOpen: () => void }) {
  const { t } = useLocale()
  const mass = useMass()
  const percent = row.utilization == null ? null : row.utilization * 100
  const width = percent == null ? 0 : Math.min(100, Math.max(0, percent))
  const tone = fillTone(row.utilization)
  const blank = t.unavailable
  const quantity = row.capacityKg == null
    ? blank
    : `${mass.compact(row.quantityKg)} / ${mass.compact(row.capacityKg)} ${mass.symbol}`
  const quality = hasLabData ? qualityFor(samples) : []
  const odour = odourFailures(samples)
  const withResult = samples.filter((sample) => sample.parameters.length > 0).length
  const out = hasOutOfSpec(quality) || odour > 0
  const changed = hasChange(quality)

  return (
    <button
      type="button"
      className={[
        'commodity-card',
        `commodity-card--${tone}`,
        out ? 'commodity-card--quality-out' : '',
        changed ? 'commodity-card--quality-change' : '',
      ].filter(Boolean).join(' ')}
      aria-label={`${row.code}. ${t.stockSources}`}
      disabled={row.tankCount === 0}
      onClick={onOpen}
    >
      <span className="commodity-card__head">
        <strong className="commodity-card__name">{row.code}</strong>
        <span className="commodity-card__tanks">
          {t.tanksHolding.replace('{held}', String(row.holdingTanks)).replace('{total}', String(row.tankCount))}
        </span>
        <ChevronRight className="commodity-card__go" size={16} aria-hidden="true" />
      </span>
      <span className="commodity-card__util">
        <span className="commodity-card__pct">{percent == null ? blank : `${percent.toFixed(1)}%`}</span>
        <span className="commodity-card__qty">{quantity}</span>
      </span>
      <span className="commodity-card__gauge" aria-hidden="true">
        <span className="commodity-card__gauge-fill" style={{ width: `${width}%` }} />
      </span>
      <span className="commodity-card__facts">
        <span className="commodity-card__fact">
          <Thermometer size={13} aria-hidden="true" />
          {row.avgTemperatureC == null ? blank : `${formatMeasure(row.avgTemperatureC, 1)} °C`}
        </span>
        <QualityFlags views={quality} odourFailed={odour} tanks={withResult} />
      </span>
      {hasLabData && withResult > 0 ? (
        <span className="commodity-card__quality" title={t.qualityHint}>
          <QualityChips views={quality} tanks={withResult} />
        </span>
      ) : null}
    </button>
  )
}
