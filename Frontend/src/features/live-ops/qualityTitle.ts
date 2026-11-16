import { formatMeasure } from '../../domain/format.ts'
import { formatVariancePct } from '../../domain/qualityVariance.ts'
import type { ParamView } from '../../domain/qualityView.ts'
import { useLocale } from '../../i18n/LocaleContext.tsx'

export function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template)
}

/** The tooltip of one figure: what it is, its limits, which tanks break them, and the change since yesterday. */
export function useQualityTitle() {
  const { t } = useLocale()
  return (view: ParamView, tanks: number): string => {
    const lines = [`${view.label} ${view.value == null ? t.unavailable : formatMeasure(view.value, view.digits)}${view.unit}`]
    if (tanks > 1 && view.count > 0) lines.push(fill(t.qualityAverageOf, { n: view.count }))
    if (view.range) lines.push(fill(t.qualityLimit, { range: view.range }))
    if (view.rejectTanks > 0) lines.push(tanks > 1 ? fill(t.qualityOutTanks, { n: view.rejectTanks, total: tanks }) : t.outOfSpec)
    else if (view.watchTanks > 0) lines.push(tanks > 1 ? fill(t.qualityWatchTanks, { n: view.watchTanks, total: tanks }) : t.specsEffectWatch)
    else if (view.status === 'reject') lines.push(t.qualityAverageOut)
    if (view.change) {
      lines.push(fill(t.qualityChange, {
        pct: formatVariancePct(view.change.pctChange),
        previous: formatMeasure(view.change.previous, view.digits),
      }))
    }
    return lines.join('\n')
  }
}

