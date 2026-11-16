import { formatMeasure } from '../../domain/format.ts'
import { formatVariancePct } from '../../domain/qualityVariance.ts'
import { hasChange, hasOutOfSpec, type ParamView } from '../../domain/qualityView.ts'
import { useLocale } from '../../i18n/LocaleContext.tsx'
import { fill, useQualityTitle } from './qualityTitle.ts'

/** Arrow for a figure that moved since yesterday. */
export function ChangeArrow({ pctChange }: { pctChange: number }) {
  return (
    <span className={pctChange >= 0 ? 'num-variance-arrow num-variance-arrow--up' : 'num-variance-arrow num-variance-arrow--down'} aria-hidden="true">
      {pctChange >= 0 ? '▲' : '▼'}
    </span>
  )
}

/**
 * The quality figures of a product as small chips. Red: outside a limit that puts stock out of spec.
 * Amber: outside a watch limit. Shaded with an arrow: moved since yesterday.
 */
export function QualityChips({ views, tanks = 1, onPick }: { views: ParamView[]; tanks?: number; onPick?: (code: string) => void }) {
  const { t } = useLocale()
  const title = useQualityTitle()
  return (
    <span className="q-chips">
      {views.map((view) => {
        const className = [
          'q-chip',
          view.value == null ? 'q-chip--empty' : '',
          view.status ? `q-chip--${view.status}` : '',
          view.change ? 'q-chip--changed' : '',
        ].filter(Boolean).join(' ')
        const body = (
          <>
            <small>{view.label}</small>
            <b>{view.value == null ? '–' : formatMeasure(view.value, view.digits)}</b>
            {view.change ? <ChangeArrow pctChange={view.change.pctChange} /> : null}
          </>
        )
        const label = title(view, tanks)
        return onPick && view.value != null ? (
          <button
            key={view.code}
            type="button"
            className={className}
            title={label}
            aria-label={label.replaceAll('\n', '. ')}
            onClick={(event) => {
              event.stopPropagation()
              onPick(view.code)
            }}
          >
            {body}
          </button>
        ) : (
          <span key={view.code} className={className} title={view.value == null ? t.labNoResult : label}>
            {body}
          </span>
        )
      })}
    </span>
  )
}

/** Short flags for a card: out of spec, odour failed, changed since yesterday. */
export function QualityFlags({ views, odourFailed = 0, tanks = 1 }: { views: ParamView[]; odourFailed?: number; tanks?: number }) {
  const { t } = useLocale()
  const out = views.filter((view) => view.status === 'reject')
  const changed = views.filter((view) => view.change)
  if (!hasOutOfSpec(views) && odourFailed === 0 && !hasChange(views)) return null
  const outTitle = [
    ...out.map((view) => `${view.label}: ${view.rejectTanks > 0 && tanks > 1 ? fill(t.qualityOutTanks, { n: view.rejectTanks, total: tanks }) : t.outOfSpec}`),
    ...(odourFailed > 0 ? [fill(t.qualityOdourFailed, { n: odourFailed })] : []),
  ].join('\n')
  return (
    <span className="q-flags">
      {out.length > 0 || odourFailed > 0 ? <span className="badge badge--danger" title={outTitle}>{t.outOfSpec}</span> : null}
      {changed.length > 0 ? (
        <span className="badge badge--variance" title={changed.map((view) => `${view.label} ${formatVariancePct(view.change?.pctChange ?? 0)}`).join('\n')}>
          {t.qualityChangedFlag}
        </span>
      ) : null}
    </span>
  )
}
