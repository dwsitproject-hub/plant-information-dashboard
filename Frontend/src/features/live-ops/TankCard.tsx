import type { ReactNode } from 'react'
import { useLocale } from '../../i18n/LocaleContext.tsx'
import type { TankLive } from '../../domain/types.ts'
import { sourceOfTanks } from '../../domain/dataSource.ts'
import { formatDay, formatMeasure, levelPercent, tankLabel } from '../../domain/format.ts'
import { qualityFor } from '../../domain/qualityView.ts'
import { ChangeArrow } from './QualityChips.tsx'
import { useQualityTitle } from './qualityTitle.ts'
import { labMetric, tankSample } from './tankQuality.ts'
import { SourceBadge } from '../dataSource/SourceBadge.tsx'
import { useMass } from './massUnit.ts'
import type { HistoryMetric } from './quantitySeries.ts'
import { fillTone, isCritical, isEmptyTank, isTempAnomaly } from './tankAlerts.ts'
import { TankVessel } from './TankVessel.tsx'

/**
 * One tank as a drum with its figures inside it: quantity in the middle, temperature and fill at the top,
 * level and empty space at the bottom. Each figure appears once. Lab values show under the drum only when
 * there is something to show.
 */
export function TankCard({
  tank,
  before,
  averageTemperature,
  referenceDay,
  hasLabData = true,
  onHistory,
}: {
  tank: TankLive
  averageTemperature: number | null
  /** The same tank as of yesterday, for the change since yesterday. */
  before?: TankLive
  
  /** The day the screen is showing. A reading from another day says so in the header. */
  referenceDay?: string | null
  /** False for a site with no lab results: the lab row is left out. */
  hasLabData?: boolean
  onHistory: (tankId: string, metric: HistoryMetric) => void
}) {
  const { t, locale } = useLocale()
  const mass = useMass()
  const numbers = locale === 'id' ? 'id-ID' : 'en-US'
  const empty = isEmptyTank(tank)
  const noData = !empty && tank.quantityKg == null
  const quarantined = tank.quality?.storageVerdict === 'quarantine'
  const hot = isTempAnomaly(tank.temperatureC, averageTemperature)
  const critical = isCritical(tank, averageTemperature)
  const stale = tank.quality?.ageDays != null && tank.quality.ageDays > 7
  const gauge = sourceOfTanks([tank]) === 'atg'
  const status = tank.operationalStatus && tank.operationalStatus !== '—' && tank.operationalStatus !== 'EMPTY' ? tank.operationalStatus : ''
  const otherDay = tank.recordedOn && referenceDay && tank.recordedOn !== referenceDay ? formatDay(tank.recordedOn, locale) : ''

  const number = (value: number, digits: number) => new Intl.NumberFormat(numbers, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value)
  // Tonnes with two decimals under 100 and one above, kilograms whole, so the figure fits the drum.
  const quantityText = (kg: number) => (mass.unit === 'kg' ? number(Math.round(kg), 0) : number(kg / 1000, Math.abs(kg) >= 100_000 ? 1 : 2))
  const wholeText = (kg: number) => `${mass.unit === 'kg' ? number(Math.round(kg), 0) : number(Math.round(kg / 1000), 0)} ${mass.symbol}`
  const percent = tank.fillRatio == null ? null : tank.fillRatio * 100
  const capacityLine = tank.capacityKg == null ? t.capacityNotSet : t.capacityOf.replace('{cap}', wholeText(tank.capacityKg))
  const emptySpaceKg = tank.emptySpaceKg

  // The product's parameters (Master > Commodities), coloured by its limits, with the change since yesterday.
  const qualityTitle = useQualityTitle()
  const slots = qualityFor([tankSample(tank, before)]).map((view) => ({
    view,
    key: view.code,
    metric: labMetric(view.code) as HistoryMetric,
    value: view.value,
  }))
  const hasLabValue = slots.some((slot) => slot.value != null)
  const varianceCount = slots.filter((slot) => slot.view.change).length
  const outOfSpec = slots.some((slot) => slot.view.status === 'reject')
  const analysed = tank.quality?.analysisDate ? formatDay(tank.quality.analysisDate, locale) : ''
  const analysedShort = analysed.replace(/\s\d{4}$/, '')
  const labOld = stale || tank.quality?.retestRequired === true
  const ageTitle = stale && tank.quality?.analysisDate
    ? t.qualityAge.replace('{age}', String(tank.quality.ageDays)).replace('{day}', formatDay(tank.quality.analysisDate, locale))
    : undefined
  const showLabRow = hasLabData && (hasLabValue || tank.quality?.retestRequired || quarantined || outOfSpec)

  return (
    <article className={[
      'tank-card',
      empty ? 'tank-card--empty' : '',
      quarantined || outOfSpec ? 'tank-card--quarantine' : '',
      critical && !empty ? 'tank-card--critical' : '',
    ].filter(Boolean).join(' ')}>
      <header className="tank-card__head">
        <strong>{tankLabel(tank.tankId)}</strong>
        <span className="tank-card__product">{tank.productName || '—'}</span>
        {gauge ? <SourceBadge source="atg" compact /> : status ? <span className="tank-card__status" title={tank.recordedOn ? formatDay(tank.recordedOn, locale) : undefined}>{status}</span> : null}
        {otherDay ? <span className="tank-card__status tank-card__status--old">{otherDay}</span> : null}
      </header>

      <TankVessel
        percent={barPercent(tank)}
        tone={empty || noData ? 'empty' : quarantined ? 'quarantine' : fillTone(tank.fillRatio)}
        label={`${tankLabel(tank.tankId)} ${percent == null ? '' : `${percent.toFixed(1)}%`}`}
      >
        <div className="drum__row drum__row--top">
          {tank.temperatureC == null
            ? <span />
            : <Pill title={t.tempAxis} alert={hot} onClick={() => onHistory(tank.tankId, 'temperature')}>{formatMeasure(tank.temperatureC, 1)} °C</Pill>}
          {percent == null || noData
            ? <span />
            : <Pill title={t.tankLevelPct} alert={tank.fillRatio != null && tank.fillRatio > 0.95} onClick={() => onHistory(tank.tankId, 'levelTank')}>{empty ? '0' : number(percent, 1)}%</Pill>}
        </div>

        <div className="drum__plate">
          {empty || noData
            ? <span className="drum__word">{empty ? t.tankEmptyWord : t.tankNoDataWord}</span>
            : (
              <button type="button" className="drum__quantity" title={t.quantity} onClick={() => onHistory(tank.tankId, 'quantity')}>
                {quantityText(tank.quantityKg ?? 0)}<small>{mass.symbol}</small>
              </button>
            )}
          <span className={tank.capacityKg == null ? 'drum__capacity drum__capacity--unset' : 'drum__capacity'}>{noData && tank.capacityKg == null ? '' : capacityLine}</span>
        </div>

        <div className="drum__row drum__row--bottom">
          {tank.soundingLevelM == null || noData
            ? <span />
            : <Pill title={t.levelAxis} onClick={() => onHistory(tank.tankId, 'level')}>{formatMeasure(tank.soundingLevelM, 2)} m</Pill>}
          {/* An empty tank's empty space is its whole capacity, which the plate already shows. */}
          {emptySpaceKg == null || noData || empty
            ? <span />
            : <Pill title={t.emptySpace} onClick={() => onHistory(tank.tankId, 'emptySpace')}>{t.tankEmptyWord} {wholeText(emptySpaceKg)}</Pill>}
        </div>
      </TankVessel>

      {showLabRow && (
        <div className="tank-lab">
          <div className="tank-lab__cap">
            <span className={labOld ? 'tank-lab__date tank-lab__date--old' : 'tank-lab__date'} title={ageTitle ?? analysed}>
              {t.labShort}{analysedShort ? ` · ${analysedShort}` : ''}
            </span>
            <span className="tank-lab__badges">
              {tank.quality?.retestRequired && <span className="badge badge--warning">{t.retest}</span>}
              {quarantined && <span className="badge badge--danger">QUARANTINE</span>}
              {varianceCount > 0 && <span className="badge badge--variance" title={t.qualityChangedFlag}>{t.qualityChangedFlag}</span>}
            </span>
          </div>
          <div className="tank-lab__grid">
            {slots.map((slot) => slot.value == null
              ? (
                <span key={slot.key} className="tank-lab__cell tank-lab__cell--missing">
                  <small>{slot.view.label}</small>
                  <b>–</b>
                </span>
              )
              : (
                <button
                  key={slot.key}
                  type="button"
                  className={[
                    'tank-lab__cell',
                    slot.view.status ? `tank-lab__cell--${slot.view.status}` : '',
                    slot.view.change ? 'tank-lab__cell--changed' : '',
                  ].filter(Boolean).join(' ')}
                  title={[qualityTitle(slot.view, 1), analysed, ageTitle].filter(Boolean).join('\n')}
                  onClick={() => onHistory(tank.tankId, slot.metric)}
                >
                  <small>{slot.view.label}</small>
                  <b>
                    {formatMeasure(slot.value, slot.view.digits)}
                    {slot.view.unit === '%' && <u>%</u>}
                    {slot.view.change ? <ChangeArrow pctChange={slot.view.change.pctChange} /> : null}
                  </b>
                </button>
              ))}
          </div>
        </div>
      )}
    </article>
  )
}

/** A figure on the glass: a small white pill that stays readable over the liquid or the empty part. */
function Pill({ children, title, alert = false, onClick }: { children: ReactNode; title: string; alert?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={alert ? 'drum__pill drum__pill--alert' : 'drum__pill'} title={title} onClick={onClick}>
      {children}
    </button>
  )
}

function barPercent(tank: TankLive): number {
  if (tank.fillRatio == null) return levelPercent(tank.soundingLevelM)
  return Math.min(100, Math.max(0, tank.fillRatio * 100))
}
