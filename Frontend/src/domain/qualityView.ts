import { LAB_CODE_TO_VARIANCE_KEY, VARIANCE_FLOOR, VARIANCE_THRESHOLD } from './qualityVariance.ts'

/**
 * Quality figures for the stock screens (Tank & Stock Dashboard, Stock Overview).
 *
 * Which parameters a product shows comes from its limits on Master > Commodities: FFA and M&I always,
 * plus every parameter the product has a limit for. A product with no limits shows FFA, M&I and colour.
 * A figure is judged against those limits, and compared with the same tanks as of the day before.
 */

export type Severity = 'reject' | 'watch'

export interface SpecLimit {
  code: string
  label?: string
  unit?: string
  bound: 'max' | 'min'
  limit: number | null
  severity: Severity
}

export interface SpecHit {
  code?: string
  bound: 'max' | 'min'
  limit: number | null
  value: number | string
  severity: Severity
}

export interface CodeValue {
  code: string
  value: number | null
}

/** One tank's result in the shape these helpers read. `before` is the same tank as of the day before. */
export interface QualitySample {
  tankId: string
  parameters: CodeValue[]
  limits: SpecLimit[]
  breaches: SpecHit[]
  before: CodeValue[] | null
}

export interface LabDisplay {
  label: string
  digits: number
  unit: string
}

export const LAB_DISPLAY: Record<string, LabDisplay> = {
  FFA: { label: 'FFA', digits: 3, unit: '%' },
  MI: { label: 'M&I', digits: 3, unit: '%' },
  COLOR_R: { label: 'R', digits: 1, unit: '' },
  COLOR_Y: { label: 'Y', digits: 1, unit: '' },
  IV: { label: 'IV', digits: 2, unit: '' },
  PV: { label: 'PV', digits: 2, unit: '' },
  ANV: { label: 'AnV', digits: 2, unit: '' },
  TOTOX: { label: 'Totox', digits: 2, unit: '' },
  DOBI: { label: 'DOBI', digits: 2, unit: '' },
  CAROTENE: { label: 'Carotene', digits: 0, unit: 'ppm' },
  SMP: { label: 'SMP', digits: 1, unit: '°C' },
  CP: { label: 'Cloud', digits: 1, unit: '°C' },
  P: { label: 'P', digits: 1, unit: 'ppm' },
}

const ORDER = ['FFA', 'MI', 'COLOR_R', 'COLOR_Y', 'IV', 'PV', 'ANV', 'TOTOX', 'DOBI', 'CAROTENE', 'SMP', 'CP', 'P']
const ALWAYS = ['FFA', 'MI']
const DEFAULT_CODES = ['FFA', 'MI', 'COLOR_R', 'COLOR_Y']

export function displayOf(code: string): LabDisplay {
  return LAB_DISPLAY[code] ?? { label: code, digits: 2, unit: '' }
}

/**
 * The parameters to show for a set of results of one product: FFA, M&I and every parameter with a limit.
 * Odour has no number, so it is judged but not listed as a figure.
 */
export function codesFor(samples: QualitySample[]): string[] {
  const limited = new Set(samples.flatMap((sample) => sample.limits.map((limit) => limit.code)).filter((code) => code in LAB_DISPLAY))
  if (limited.size === 0) return DEFAULT_CODES
  const codes = new Set([...ALWAYS, ...limited])
  return ORDER.filter((code) => codes.has(code))
}

export interface Judgement {
  status: Severity | null
  /** The limit broken, as "≤ 0.1" or "≥ 56". */
  limitText: string | null
}

const boundSign = (bound: 'max' | 'min') => (bound === 'max' ? '≤' : '≥')

/** A value against the limits for its parameter. A broken 'reject' limit outranks a broken 'watch' one. */
export function judge(value: number | null, limits: SpecLimit[]): Judgement {
  if (value == null) return { status: null, limitText: null }
  let found: SpecLimit | null = null
  for (const limit of limits) {
    if (limit.limit == null) continue
    const broken = limit.bound === 'max' ? value > limit.limit : value < limit.limit
    if (!broken) continue
    if (!found || (found.severity === 'watch' && limit.severity === 'reject')) found = limit
  }
  return found ? { status: found.severity, limitText: `${boundSign(found.bound)} ${found.limit}` } : { status: null, limitText: null }
}

/** All the limits on one parameter, written out: "≤ 0.1" or "50 – 55". */
export function rangeText(limits: SpecLimit[], code: string): string | null {
  const own = limits.filter((limit) => limit.code === code && limit.limit != null)
  const min = own.find((limit) => limit.bound === 'min')
  const max = own.find((limit) => limit.bound === 'max')
  if (min && max) return `${min.limit} – ${max.limit}`
  if (max) return `≤ ${max.limit}`
  if (min) return `≥ ${min.limit}`
  return null
}

export interface DayChange {
  previous: number
  /** Signed fraction, 0.2 for +20%. */
  pctChange: number
}

/**
 * A move since yesterday large enough to point out: 15% or more, and more than the parameter's noise
 * floor (the same rule as the variance alerts on QC Storage).
 */
export function dayChange(code: string, now: number | null, before: number | null): DayChange | null {
  if (now == null || before == null) return null
  const delta = now - before
  const floor = VARIANCE_FLOOR[LAB_CODE_TO_VARIANCE_KEY[code] ?? code] ?? 0
  if (Math.abs(delta) < floor) return null
  const pctChange = before === 0 ? (delta === 0 ? 0 : Infinity) : delta / Math.abs(before)
  if (Math.abs(pctChange) < VARIANCE_THRESHOLD) return null
  return { previous: before, pctChange }
}

export interface ParamView {
  code: string
  label: string
  unit: string
  digits: number
  /** The tank's value, or the average over the tanks that have one. */
  value: number | null
  /** How many results the value is made of. */
  count: number
  status: Severity | null
  limitText: string | null
  range: string | null
  /** Tanks whose own result breaks a limit on this parameter (a group can hide one bad tank). */
  rejectTanks: number
  watchTanks: number
  change: DayChange | null
}

const valueOf = (list: CodeValue[] | null | undefined, code: string) => list?.find((item) => item.code === code)?.value ?? null

function mean(values: Array<number | null>): number | null {
  const nums = values.filter((value): value is number => value != null && Number.isFinite(value))
  return nums.length === 0 ? null : nums.reduce((sum, value) => sum + value, 0) / nums.length
}

/**
 * The figures for a group of results of one product: each parameter's average, judged against the
 * product's limits, with how many single tanks break a limit, and the change from the same tanks'
 * average as of yesterday. With one sample it is that tank's own result.
 */
export function qualityFor(samples: QualitySample[], codes = codesFor(samples)): ParamView[] {
  return codes.map((code) => {
    const display = displayOf(code)
    const limits = samples.flatMap((sample) => sample.limits).filter((limit) => limit.code === code)
    // Today's tanks that also had a result yesterday, so a tank that just arrived does not read as a change.
    const pairs = samples.filter((sample) => valueOf(sample.parameters, code) != null)
    const value = mean(pairs.map((sample) => valueOf(sample.parameters, code)))
    const compared = pairs.filter((sample) => valueOf(sample.before, code) != null)
    const before = compared.length > 0 ? mean(compared.map((sample) => valueOf(sample.before, code))) : null
    const now = compared.length > 0 ? mean(compared.map((sample) => valueOf(sample.parameters, code))) : null
    const hits = (severity: Severity) => samples.filter((sample) => sample.breaches.some((hit) => hit.code === code && hit.severity === severity)).length
    const rejectTanks = hits('reject')
    const watchTanks = hits('watch')
    const own = judge(value, limits)
    // One tank out of spec marks the figure, even when the average is inside the limits.
    const status: Severity | null = own.status === 'reject' || rejectTanks > 0 ? 'reject' : own.status === 'watch' || watchTanks > 0 ? 'watch' : null
    return {
      code,
      label: display.label,
      unit: display.unit,
      digits: display.digits,
      value,
      count: pairs.length,
      status,
      limitText: own.limitText,
      range: rangeText(limits, code),
      rejectTanks,
      watchTanks,
      change: dayChange(code, now, before),
    }
  })
}

/** Odour, the one pass/fail check: how many tanks failed it today. */
export function odourFailures(samples: QualitySample[]): number {
  return samples.filter((sample) => sample.breaches.some((hit) => hit.code === 'ODOR' && hit.severity === 'reject')).length
}

export function hasOutOfSpec(views: ParamView[]): boolean {
  return views.some((view) => view.status === 'reject')
}

export function hasChange(views: ParamView[]): boolean {
  return views.some((view) => view.change != null)
}

/** The shape every screen's tanks are turned into. `quality` may be missing or partial. */
export function sampleOf(
  tankId: string,
  quality: { parameters?: CodeValue[]; limits?: SpecLimit[]; breaches?: SpecHit[] } | null | undefined,
  before: CodeValue[] | null | undefined,
): QualitySample {
  return {
    tankId,
    parameters: quality?.parameters ?? [],
    limits: quality?.limits ?? [],
    breaches: quality?.breaches ?? [],
    before: before ?? null,
  }
}

/* ------------------------------------------------------------------ quality over time */

export interface LabPointLike {
  analysisDate: string | null
  snapshotOn: string | null
  parameters: CodeValue[]
}

/** The calendar day before an ISO day. */
export function previousDay(day: string): string {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

/** A tank's lab values on a day: its latest result analysed on or before that day. */
export function valuesAsOf(points: LabPointLike[], day: string): CodeValue[] | null {
  let found: LabPointLike | null = null
  let foundDay = ''
  for (const point of points) {
    const when = point.analysisDate ?? point.snapshotOn
    if (!when || when > day) continue
    if (!found || when >= foundDay) {
      found = point
      foundDay = when
    }
  }
  return found ? found.parameters : null
}

/** The limits a set of values breaks, in the shape a sample carries. */
export function breachesOf(values: CodeValue[], limits: SpecLimit[]): SpecHit[] {
  const hits: SpecHit[] = []
  for (const item of values) {
    const own = limits.filter((limit) => limit.code === item.code)
    const judged = judge(item.value, own)
    if (!judged.status || item.value == null) continue
    const broken = own.find((limit) => limit.severity === judged.status && limit.limit != null && (limit.bound === 'max' ? (item.value as number) > limit.limit : (item.value as number) < limit.limit))
    if (broken) hits.push({ code: item.code, bound: broken.bound, limit: broken.limit, value: item.value, severity: broken.severity })
  }
  return hits
}

export interface TankLabs {
  tankId: string
  limits: SpecLimit[]
  labs: LabPointLike[]
}

/**
 * The average quality of a product on each day: every tank's result as of that day, averaged per
 * parameter, judged against the product's limits, and compared with the day before.
 * `holds(tankId, day)` says whether a tank held stock that day; tanks that did not are left out.
 */
export function dailyQuality(
  tanks: TankLabs[],
  days: string[],
  codes: string[],
  holds: (tankId: string, day: string) => boolean = () => true,
): Map<string, ParamView[]> {
  const result = new Map<string, ParamView[]>()
  for (const day of days) {
    const samples: QualitySample[] = []
    for (const tank of tanks) {
      if (!holds(tank.tankId, day)) continue
      const now = valuesAsOf(tank.labs, day)
      if (!now) continue
      samples.push({
        tankId: tank.tankId,
        parameters: now,
        limits: tank.limits,
        breaches: breachesOf(now, tank.limits),
        before: valuesAsOf(tank.labs, previousDay(day)),
      })
    }
    if (samples.length > 0) result.set(day, qualityFor(samples, codes))
  }
  return result
}

/** Each parameter's average over the days given, judged against the limits. */
export function periodQuality(daily: Map<string, ParamView[]>, codes: string[], limits: SpecLimit[]): ParamView[] {
  return codes.map((code) => {
    const display = displayOf(code)
    const values = [...daily.values()]
      .map((views) => views.find((view) => view.code === code)?.value ?? null)
      .filter((value): value is number => value != null)
    const value = values.length ? values.reduce((sum, item) => sum + item, 0) / values.length : null
    const own = limits.filter((limit) => limit.code === code)
    const judged = judge(value, own)
    return {
      code,
      label: display.label,
      unit: display.unit,
      digits: display.digits,
      value,
      count: values.length,
      status: judged.status,
      limitText: judged.limitText,
      range: rangeText(own, code),
      rejectTanks: 0,
      watchTanks: 0,
      change: null,
    }
  })
}
