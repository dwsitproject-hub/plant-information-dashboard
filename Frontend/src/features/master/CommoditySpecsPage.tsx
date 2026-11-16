import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Trash2, X } from 'lucide-react'
import { api, ApiError } from '../../data/api.ts'
import { useActiveSite } from '../../data/ActiveSiteContext.tsx'
import { useAuth } from '../../data/AuthContext.tsx'
import { formatDay } from '../../domain/format.ts'
import { useLocale } from '../../i18n/LocaleContext.tsx'

type Bound = 'max' | 'min'
type Severity = 'reject' | 'watch'

interface CommodityRow {
  id: string
  code: string
  name: string
  ruleCount: number
  rejectCount: number
  watchCount: number
  updatedAt: string | null
  aliases: string[]
}

interface SpecParameter {
  code: string
  label: string
  unit: string
  kind: 'number' | 'pass'
}

interface SpecRule {
  parameterCode: string
  bound: Bound
  limit: number | null
  severity: Severity
}

/** One editor row. The limit is kept as typed so a half-written number is not lost. */
interface DraftRule {
  key: number
  parameterCode: string
  bound: Bound
  limit: string
  severity: Severity
}

interface SpecsResponse {
  site: { id: string; name: string }
  commodity: { id: string; code: string; name: string }
  parameters: SpecParameter[]
  rules: Array<SpecRule & { updatedAt?: string | null }>
}

function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template)
}

let nextKey = 1
const draftOf = (rule: SpecRule): DraftRule => ({
  key: nextKey++,
  parameterCode: rule.parameterCode,
  bound: rule.bound,
  limit: rule.limit == null ? '' : String(rule.limit),
  severity: rule.severity,
})

function errorText(t: ReturnType<typeof useLocale>['t'], code: string): string {
  if (code === 'unknown_parameter') return t.specsErrUnknownParameter
  if (code === 'limit_required') return t.specsErrLimitRequired
  if (code === 'duplicate_rule') return t.specsErrDuplicate
  if (code === 'min_above_max') return t.specsErrMinAboveMax
  if (code === 'site_not_found') return t.specsErrSite
  if (code === 'forbidden') return t.accessDeniedBody
  if (code === 'invalid_bound' || code === 'invalid_severity' || code === 'invalid_rules') return t.specsErrInvalid
  return t.requestFailed
}

/**
 * Master > Commodities with each oil's storage quality limits for the active site.
 * QC Storage and Live Ops judge every result against these limits.
 */
export function CommoditySpecsPage() {
  const { t, locale } = useLocale()
  const { can } = useAuth()
  const { siteId, site } = useActiveSite()
  const canEdit = can('master-commodities', 'edit')
  const [rows, setRows] = useState<CommodityRow[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    api<{ commodities: CommodityRow[] }>(`/api/v1/master/commodities?siteId=${encodeURIComponent(siteId)}`)
      .then((body) => {
        if (!active) return
        setRows(body.commodities)
        setListError(null)
      })
      .catch((error: unknown) => {
        if (active) setListError(errorText(t, error instanceof ApiError ? error.code : ''))
      })
    return () => {
      active = false
    }
  }, [siteId, reload, t])

  const siteName = site?.name ?? siteId

  return (
    <div className="page um">
      <Link className="master-back" to="/master">{t.backToMaster}</Link>
      <header className="um-header">
        <div>
          <h1 className="page-title">{`${t.masterDash} ${t.commodities}`}</h1>
          <p className="um-subtitle">{t.specsBlurb}</p>
        </div>
        <span className="site-pill">
          <span className="site-pill__dot" aria-hidden="true" />
          {t.specsSite} {siteName}
        </span>
      </header>

      {notice ? (
        <div className="um-banner um-banner--ok" role="status">
          <span>{notice}</span>
          <button type="button" className="um-icon-btn" aria-label={t.close} onClick={() => setNotice(null)}><X size={14} /></button>
        </div>
      ) : null}
      {listError ? <p className="page-error" role="alert">{listError}</p> : null}

      <section className="um-card">
        {!rows ? (
          !listError ? <div className="um-empty"><p>{t.loading}</p></div> : null
        ) : (
          <div className="um-table-wrap">
            <table className="um-table">
              <thead>
                <tr>
                  <th>{t.code}</th>
                  <th>{t.recordName}</th>
                  <th>{t.specsTitle}</th>
                  <th aria-label={t.specsEdit} />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className={openId === row.id ? 'spec-row--open' : undefined}>
                    <td><span className="um-code um-code--chip">{row.code}</span></td>
                    <td>
                      <span className="um-user__text">
                        <strong>{row.name}</strong>
                        {row.aliases.length > 0 ? (
                          <span className="um-muted">{fill(t.specsReadAs, { aliases: row.aliases.join(', ') })}</span>
                        ) : null}
                      </span>
                    </td>
                    <td>
                      {row.ruleCount === 0 ? (
                        <span className="um-chip um-chip--more">{t.specsNone}</span>
                      ) : (
                        <span className="spec-counts">
                          <span className="um-chip um-chip--role">{fill(t.specsLimitsCount, { n: row.ruleCount })}</span>
                          {row.updatedAt ? (
                            <span className="um-muted">{fill(t.specsUpdated, { day: formatDay(row.updatedAt.slice(0, 10), locale) })}</span>
                          ) : null}
                        </span>
                      )}
                    </td>
                    <td className="spec-action">
                      <button
                        type="button"
                        className="btn btn--secondary"
                        aria-expanded={openId === row.id}
                        onClick={() => setOpenId(openId === row.id ? null : row.id)}
                      >
                        {canEdit ? t.specsEdit : t.specsView}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {openId ? (
        <SpecEditor
          key={`${siteId}|${openId}`}
          siteId={siteId}
          commodityId={openId}
          canEdit={canEdit}
          onClose={() => setOpenId(null)}
          onSaved={(message) => {
            setNotice(message)
            setOpenId(null)
            setReload((value) => value + 1)
          }}
        />
      ) : null}
    </div>
  )
}

function SpecEditor({
  siteId,
  commodityId,
  canEdit,
  onClose,
  onSaved,
}: {
  siteId: string
  commodityId: string
  canEdit: boolean
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const { t } = useLocale()
  const [loaded, setLoaded] = useState<SpecsResponse | null>(null)
  const [drafts, setDrafts] = useState<DraftRule[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => {
    let active = true
    api<SpecsResponse>(`/api/v1/master/commodities/${encodeURIComponent(commodityId)}/specs?siteId=${encodeURIComponent(siteId)}`)
      .then((body) => {
        if (!active) return
        setLoaded(body)
        setDrafts(body.rules.map(draftOf))
        panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
      .catch((reason: unknown) => {
        if (active) setError(errorText(t, reason instanceof ApiError ? reason.code : ''))
      })
    return () => {
      active = false
    }
  }, [siteId, commodityId, t])

  const parameters = useMemo(() => new Map((loaded?.parameters ?? []).map((parameter) => [parameter.code, parameter])), [loaded])
  const isPass = (code: string) => parameters.get(code)?.kind === 'pass'

  const update = (key: number, patch: Partial<DraftRule>) => {
    setDrafts((current) => current.map((row) => {
      if (row.key !== key) return row
      const next = { ...row, ...patch }
      // A pass/fail parameter has no number and no direction.
      if (patch.parameterCode && isPass(patch.parameterCode)) return { ...next, bound: 'max', limit: '' }
      return next
    }))
  }

  const add = () => {
    const used = new Set(drafts.map((row) => `${row.parameterCode}|${row.bound}`))
    const first = (loaded?.parameters ?? []).find((parameter) => !used.has(`${parameter.code}|max`))
    setDrafts((current) => [...current, {
      key: nextKey++,
      parameterCode: first?.code ?? '',
      bound: 'max',
      limit: '',
      severity: 'reject',
    }])
  }

  const save = async () => {
    if (!loaded) return
    setBusy(true)
    setError(null)
    try {
      await api(`/api/v1/master/commodities/${encodeURIComponent(commodityId)}/specs?siteId=${encodeURIComponent(siteId)}`, {
        method: 'PUT',
        body: JSON.stringify({
          rules: drafts.map((row) => ({
            parameterCode: row.parameterCode,
            bound: row.bound,
            limit: isPass(row.parameterCode) || row.limit.trim() === '' ? null : Number(row.limit.replace(',', '.')),
            severity: row.severity,
          })),
        }),
      })
      onSaved(fill(t.specsSaved, { name: loaded.commodity.name, site: loaded.site.name }))
    } catch (reason) {
      setError(errorText(t, reason instanceof ApiError ? reason.code : ''))
    } finally {
      setBusy(false)
    }
  }

  const title = loaded ? fill(t.specsFor, { name: `${loaded.commodity.code} · ${loaded.commodity.name}`, site: loaded.site.name }) : t.loading

  return (
    <section ref={panelRef} className="um-card spec-editor" aria-label={title}>
      <header className="spec-editor__head">
        <h2>{title}</h2>
        <button type="button" className="um-icon-btn" aria-label={t.close} onClick={onClose}><X size={16} /></button>
      </header>
      {error ? <p className="page-error" role="alert">{error}</p> : null}
      {loaded ? (
        <>
          {drafts.length === 0 ? <p className="um-muted spec-editor__empty">{t.specsEmptyEditor}</p> : (
            <div className="um-table-wrap">
              <table className="um-table spec-table">
                <thead>
                  <tr>
                    <th>{t.specsParameter}</th>
                    <th>{t.specsBound}</th>
                    <th>{t.specsLimit}</th>
                    <th>{t.specsEffect}</th>
                    {canEdit ? <th aria-label={t.specsRemove} /> : null}
                  </tr>
                </thead>
                <tbody>
                  {drafts.map((row) => {
                    const parameter = parameters.get(row.parameterCode)
                    const pass = parameter?.kind === 'pass'
                    return (
                      <tr key={row.key}>
                        <td>
                          <select
                            className="um-select um-select--compact"
                            value={row.parameterCode}
                            disabled={!canEdit}
                            aria-label={t.specsParameter}
                            onChange={(event) => update(row.key, { parameterCode: event.target.value })}
                          >
                            {loaded.parameters.map((option) => (
                              <option key={option.code} value={option.code}>
                                {option.unit ? `${option.label} (${option.unit})` : option.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          {pass ? <span className="um-muted">{t.specsMustPass}</span> : (
                            <select
                              className="um-select um-select--compact"
                              value={row.bound}
                              disabled={!canEdit}
                              aria-label={t.specsBound}
                              onChange={(event) => update(row.key, { bound: event.target.value as Bound })}
                            >
                              <option value="max">{t.specsBoundMax} (≤)</option>
                              <option value="min">{t.specsBoundMin} (≥)</option>
                            </select>
                          )}
                        </td>
                        <td>
                          {pass ? <span className="um-muted">—</span> : (
                            <input
                              className="spec-limit"
                              inputMode="decimal"
                              value={row.limit}
                              disabled={!canEdit}
                              aria-label={t.specsLimit}
                              onChange={(event) => update(row.key, { limit: event.target.value })}
                            />
                          )}
                        </td>
                        <td>
                          <select
                            className={`um-select um-select--compact spec-effect spec-effect--${row.severity}`}
                            value={row.severity}
                            disabled={!canEdit}
                            aria-label={t.specsEffect}
                            onChange={(event) => update(row.key, { severity: event.target.value as Severity })}
                          >
                            <option value="reject">{t.specsEffectReject}</option>
                            <option value="watch">{t.specsEffectWatch}</option>
                          </select>
                        </td>
                        {canEdit ? (
                          <td className="spec-action">
                            <button
                              type="button"
                              className="um-icon-btn"
                              aria-label={t.specsRemove}
                              title={t.specsRemove}
                              onClick={() => setDrafts((current) => current.filter((item) => item.key !== row.key))}
                            >
                              <Trash2 size={16} />
                            </button>
                          </td>
                        ) : null}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {canEdit ? (
            <div className="spec-editor__actions">
              <button type="button" className="btn btn--secondary" onClick={add}><Plus size={16} aria-hidden="true" /> {t.specsAdd}</button>
              <span className="spec-editor__spacer" />
              <button type="button" className="btn btn--secondary" onClick={onClose} disabled={busy}>{t.cancel}</button>
              <button type="button" className="btn btn--primary" onClick={save} disabled={busy}>{busy ? t.saving : t.specsSave}</button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
