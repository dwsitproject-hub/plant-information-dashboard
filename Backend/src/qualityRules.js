/**
 * Storage quality specs per site and commodity, kept in quality_rules (scope 'storage').
 *
 * Each rule is one bound on one lab parameter: FFA max 0.1, IV min 56, and so on. A 'reject' rule
 * that a result breaks puts the tank in quarantine; a 'watch' rule only flags the figure. A commodity
 * with no rules at a site stays "spec pending" there, so one site never inherits another's limits.
 */

/** The parameters a spec can bound. `field` is the name the storage rows and screens use. */
export const SPEC_PARAMETERS = [
  { code: 'lab.ffa', lab: 'FFA', field: 'ffa', label: 'FFA', unit: '%' },
  { code: 'lab.moisture', lab: 'MI', field: 'moisture', label: 'M&I', unit: '%' },
  { code: 'lab.color_r', lab: 'COLOR_R', field: 'colorR', label: 'Colour R (Lovibond)', unit: '' },
  { code: 'lab.color_y', lab: 'COLOR_Y', field: 'colorY', label: 'Colour Y (Lovibond)', unit: '' },
  { code: 'lab.iv', lab: 'IV', field: 'iv', label: 'IV', unit: '' },
  { code: 'lab.pv', lab: 'PV', field: 'pv', label: 'PV', unit: 'meq/kg' },
  { code: 'lab.anv', lab: 'ANV', field: 'anv', label: 'AnV', unit: '' },
  { code: 'lab.totox', lab: 'TOTOX', field: 'totox', label: 'Totox', unit: '' },
  { code: 'lab.smp', lab: 'SMP', field: 'smp', label: 'Slip melting point', unit: '°C' },
  { code: 'lab.cloud_point', lab: 'CP', field: 'cloudPoint', label: 'Cloud point', unit: '°C' },
  { code: 'lab.carotene', lab: 'CAROTENE', field: 'carotene', label: 'β-Carotene', unit: 'ppm' },
  { code: 'lab.phosphorus', lab: 'P', field: 'phosphorus', label: 'Phosphorus', unit: 'ppm' },
  { code: 'lab.dobi', lab: 'DOBI', field: 'dobi', label: 'DOBI', unit: '' },
  // Odour is written as a tick or a cross. Its rule has no number: the result must pass.
  { code: 'lab.odor', lab: 'ODOR', field: 'odor', label: 'Odour', unit: '', kind: 'pass' },
]

const BY_CODE = new Map(SPEC_PARAMETERS.map((parameter) => [parameter.code, parameter]))
const BOUNDS = new Set(['max', 'min'])
const SEVERITIES = new Set(['reject', 'watch'])

/**
 * Starting limits, from common palm-oil trade specifications (PORAM-style) and this site's own CPO
 * contract header. They are a starting point for QC to review on the Commodities page, not a standard.
 */
export const DEFAULT_STORAGE_SPECS = {
  cpo: [
    ['lab.ffa', 'max', 5, 'reject'],
    ['lab.moisture', 'max', 0.5, 'reject'],
    ['lab.dobi', 'min', 2, 'reject'],
    ['lab.iv', 'min', 50, 'watch'],
    ['lab.iv', 'max', 55, 'watch'],
    ['lab.carotene', 'min', 500, 'watch'],
  ],
  rpo: [
    ['lab.ffa', 'max', 0.1, 'reject'],
    ['lab.moisture', 'max', 0.1, 'reject'],
    ['lab.color_r', 'max', 3, 'reject'],
    ['lab.iv', 'min', 50, 'reject'],
    ['lab.iv', 'max', 55, 'reject'],
    ['lab.smp', 'min', 33, 'reject'],
    ['lab.smp', 'max', 39, 'reject'],
    ['lab.pv', 'max', 2, 'watch'],
    ['lab.odor', 'max', null, 'reject'],
  ],
  olein: [
    ['lab.ffa', 'max', 0.1, 'reject'],
    ['lab.moisture', 'max', 0.1, 'reject'],
    ['lab.color_r', 'max', 3, 'reject'],
    ['lab.iv', 'min', 56, 'reject'],
    ['lab.cloud_point', 'max', 10, 'reject'],
    ['lab.pv', 'max', 2, 'watch'],
    ['lab.odor', 'max', null, 'reject'],
  ],
  rps: [
    ['lab.ffa', 'max', 0.2, 'reject'],
    ['lab.moisture', 'max', 0.15, 'reject'],
    ['lab.color_r', 'max', 3, 'reject'],
    ['lab.iv', 'max', 48, 'reject'],
    ['lab.smp', 'min', 44, 'reject'],
    ['lab.odor', 'max', null, 'reject'],
  ],
  pfad: [
    ['lab.ffa', 'min', 70, 'reject'],
    ['lab.moisture', 'max', 1, 'reject'],
    ['lab.odor', 'max', null, 'reject'],
  ],
}

const num = (value) => {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** An odour mark that means the sample failed. A tick, blank or anything else does not. */
function odourFailed(value) {
  const text = String(value ?? '').trim().toLowerCase()
  return ['✗', '✘', 'x', 'fail', 'failed', 'no', 'tidak', 'nok', 'not ok'].includes(text)
}

function odourRecorded(value) {
  const text = String(value ?? '').trim()
  return text !== '' && text !== '-' && text !== '—'
}

function ruleFromRow(row) {
  return {
    parameterCode: row.parameter_code,
    bound: row.bound,
    limit: num(row.limit_value),
    severity: row.severity,
  }
}

/** Storage rules for one site, by commodity id. */
export async function loadStorageRules(db, siteId) {
  const result = await db.query(
    `SELECT commodity_id, parameter_code, bound, limit_value, severity
     FROM quality_rules WHERE site_id = $1 AND scope = 'storage'
     ORDER BY commodity_id, parameter_code, bound`,
    [siteId],
  )
  const byCommodity = new Map()
  for (const row of result.rows) {
    if (!byCommodity.has(row.commodity_id)) byCommodity.set(row.commodity_id, [])
    byCommodity.get(row.commodity_id).push(ruleFromRow(row))
  }
  return byCommodity
}

/**
 * A commodity's limits in the short codes the tank screens use (FFA, MI, COLOR_R, ...), so a screen can
 * show which parameters matter for that product and judge an average against them.
 */
export function limitsFor(rules) {
  return (rules ?? []).flatMap((rule) => {
    const parameter = BY_CODE.get(rule.parameterCode)
    if (!parameter) return []
    return [{ code: parameter.lab, label: parameter.label, unit: parameter.unit, bound: rule.bound, limit: rule.limit, severity: rule.severity }]
  })
}

/** Values keyed by field name (ffa, iv, odor, ...) from certificate tests keyed by canonical code. */
export function valuesFromTests(tests, odor = null) {
  const values = { odor }
  for (const test of tests ?? []) {
    const parameter = BY_CODE.get(test.canonical_code)
    if (parameter && parameter.kind !== 'pass') values[parameter.field] = num(test.numeric_value)
  }
  return values
}

/**
 * Judge one storage result against its commodity's rules.
 * - No rules, or no result for any ruled parameter: 'spec-pending'.
 * - Any 'reject' rule broken: 'quarantine'. Otherwise 'pass'; broken 'watch' rules are still listed.
 * A parameter with no result is not judged; it is neither a pass nor a breach.
 */
export function evaluateStorage(rules, values) {
  if (!rules || rules.length === 0) return { verdict: 'spec-pending', breaches: [] }
  const breaches = []
  let judged = 0
  for (const rule of rules) {
    const parameter = BY_CODE.get(rule.parameterCode)
    if (!parameter) continue
    if (parameter.kind === 'pass') {
      const value = values?.[parameter.field]
      if (!odourRecorded(value)) continue
      judged += 1
      if (odourFailed(value)) {
        breaches.push({ field: parameter.field, code: parameter.lab, parameterCode: rule.parameterCode, bound: rule.bound, limit: null, value, severity: rule.severity })
      }
      continue
    }
    const value = num(values?.[parameter.field])
    if (value == null || rule.limit == null) continue
    judged += 1
    const broken = rule.bound === 'max' ? value > rule.limit : value < rule.limit
    if (broken) {
      breaches.push({ field: parameter.field, code: parameter.lab, parameterCode: rule.parameterCode, bound: rule.bound, limit: rule.limit, value, severity: rule.severity })
    }
  }
  if (judged === 0) return { verdict: 'spec-pending', breaches: [] }
  return { verdict: breaches.some((breach) => breach.severity === 'reject') ? 'quarantine' : 'pass', breaches }
}

/**
 * Check and normalise a rule list from the editor. Returns { rules } or { error } with an error code
 * the screen translates.
 */
export function normaliseRules(input) {
  if (!Array.isArray(input)) return { error: 'invalid_rules' }
  const rules = []
  const seen = new Set()
  for (const raw of input) {
    const parameter = BY_CODE.get(raw?.parameterCode)
    if (!parameter) return { error: 'unknown_parameter' }
    const severity = raw?.severity ?? 'reject'
    if (!SEVERITIES.has(severity)) return { error: 'invalid_severity' }
    if (parameter.kind === 'pass') {
      const key = `${parameter.code}|max`
      if (seen.has(key)) return { error: 'duplicate_rule' }
      seen.add(key)
      rules.push({ parameterCode: parameter.code, bound: 'max', limit: null, severity })
      continue
    }
    if (!BOUNDS.has(raw?.bound)) return { error: 'invalid_bound' }
    const limit = num(raw?.limit)
    if (limit == null) return { error: 'limit_required' }
    const key = `${parameter.code}|${raw.bound}`
    if (seen.has(key)) return { error: 'duplicate_rule' }
    seen.add(key)
    rules.push({ parameterCode: parameter.code, bound: raw.bound, limit, severity })
  }
  // A minimum above the maximum for the same parameter can never pass.
  for (const rule of rules) {
    if (rule.bound !== 'min') continue
    const max = rules.find((other) => other.parameterCode === rule.parameterCode && other.bound === 'max')
    if (max && max.limit != null && rule.limit > max.limit) return { error: 'min_above_max' }
  }
  return { rules }
}

/** Replace one commodity's storage rules at one site. Runs inside the caller's transaction. */
export async function replaceStorageRules(client, siteId, commodityId, rules, userId) {
  await client.query(
    `DELETE FROM quality_rules WHERE site_id = $1 AND commodity_id = $2 AND scope = 'storage'`,
    [siteId, commodityId],
  )
  for (const rule of rules) {
    await client.query(
      `INSERT INTO quality_rules (site_id, commodity_id, scope, parameter_code, bound, limit_value, severity, updated_by, updated_at)
       VALUES ($1, $2, 'storage', $3, $4, $5, $6, $7, NOW())`,
      [siteId, commodityId, rule.parameterCode, rule.bound, rule.limit, rule.severity, userId ?? null],
    )
  }
}

/** Insert the starting limits for a site where a commodity has no storage rule yet. */
export async function seedDefaultStorageSpecs(client, siteId) {
  for (const [commodityId, rules] of Object.entries(DEFAULT_STORAGE_SPECS)) {
    const exists = await client.query('SELECT 1 FROM commodities WHERE id = $1', [commodityId])
    if (exists.rowCount === 0) continue
    const has = await client.query(
      `SELECT 1 FROM quality_rules WHERE site_id = $1 AND commodity_id = $2 AND scope = 'storage' LIMIT 1`,
      [siteId, commodityId],
    )
    if (has.rowCount > 0) continue
    for (const [parameterCode, bound, limit, severity] of rules) {
      await client.query(
        `INSERT INTO quality_rules (site_id, commodity_id, scope, parameter_code, bound, limit_value, severity)
         VALUES ($1, $2, 'storage', $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [siteId, commodityId, parameterCode, bound, limit, severity],
      )
    }
  }
}
