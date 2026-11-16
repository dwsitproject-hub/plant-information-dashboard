import { Router } from 'express'
import { pool, query } from '../db.js'
import { requireAuth, requirePermission } from '../access.js'
import { SPEC_PARAMETERS, normaliseRules, replaceStorageRules } from '../qualityRules.js'

const router = Router()
router.use(requireAuth)

/** The Administrator may use any site; anyone else only the sites they hold. */
async function specSite(req) {
  const siteId = String(req.query.siteId ?? '').trim()
  if (!siteId) return null
  const site = await query('SELECT id, name FROM sites WHERE id = $1', [siteId])
  if (!site.rows[0]) return null
  if (req.sessionUser.isAdministrator === true) return site.rows[0]
  return req.sessionUser.sites.some((held) => held.id === siteId) ? site.rows[0] : null
}

// Commodities with how many storage limits each has at the chosen site.
router.get('/commodities', requirePermission('master-commodities', 'view'), async (req, res, next) => {
  try {
    const site = await specSite(req)
    if (!site) return res.status(404).json({ error: 'site_not_found' })
    const result = await query(
      `SELECT c.id, c.code, c.name,
              COUNT(q.id)::int AS rule_count,
              COUNT(q.id) FILTER (WHERE q.severity = 'reject')::int AS reject_count,
              COUNT(q.id) FILTER (WHERE q.severity = 'watch')::int AS watch_count,
              MAX(q.updated_at) AS updated_at,
              COALESCE((SELECT array_agg(a.source_text ORDER BY a.source_text)
                        FROM commodity_aliases a WHERE a.commodity_id = c.id AND a.site_id = $1), '{}') AS aliases
       FROM commodities c
       LEFT JOIN quality_rules q ON q.commodity_id = c.id AND q.site_id = $1 AND q.scope = 'storage'
       GROUP BY c.id, c.code, c.name
       ORDER BY c.code`,
      [site.id],
    )
    res.json({
      site: { id: site.id, name: site.name },
      commodities: result.rows.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        ruleCount: row.rule_count,
        rejectCount: row.reject_count,
        watchCount: row.watch_count,
        updatedAt: row.updated_at,
        aliases: row.aliases ?? [],
      })),
    })
  } catch (error) {
    next(error)
  }
})

async function commodityOf(id) {
  const result = await query('SELECT id, code, name FROM commodities WHERE id = $1', [id])
  return result.rows[0] ?? null
}

async function specsOf(siteId, commodityId) {
  const result = await query(
    `SELECT parameter_code, bound, limit_value, severity, updated_at
     FROM quality_rules WHERE site_id = $1 AND commodity_id = $2 AND scope = 'storage'`,
    [siteId, commodityId],
  )
  const order = new Map(SPEC_PARAMETERS.map((parameter, index) => [parameter.code, index]))
  return result.rows
    .map((row) => ({
      parameterCode: row.parameter_code,
      bound: row.bound,
      limit: row.limit_value == null ? null : Number(row.limit_value),
      severity: row.severity,
      updatedAt: row.updated_at,
    }))
    .sort((a, b) => (order.get(a.parameterCode) ?? 99) - (order.get(b.parameterCode) ?? 99) || (a.bound === 'min' ? -1 : 1))
}

// One commodity's storage limits at the chosen site, and the parameters a limit can use.
router.get('/commodities/:id/specs', requirePermission('master-commodities', 'view'), async (req, res, next) => {
  try {
    const site = await specSite(req)
    if (!site) return res.status(404).json({ error: 'site_not_found' })
    const commodity = await commodityOf(req.params.id)
    if (!commodity) return res.status(404).json({ error: 'not_found' })
    res.json({
      site: { id: site.id, name: site.name },
      commodity,
      parameters: SPEC_PARAMETERS.map(({ code, label, unit, kind }) => ({ code, label, unit, kind: kind ?? 'number' })),
      rules: await specsOf(site.id, commodity.id),
    })
  } catch (error) {
    next(error)
  }
})

// Replace one commodity's storage limits at the chosen site.
router.put('/commodities/:id/specs', requirePermission('master-commodities', 'edit'), async (req, res, next) => {
  const client = await pool.connect()
  try {
    const site = await specSite(req)
    if (!site) return res.status(404).json({ error: 'site_not_found' })
    const commodity = await commodityOf(req.params.id)
    if (!commodity) return res.status(404).json({ error: 'not_found' })
    const checked = normaliseRules(req.body?.rules)
    if (checked.error) return res.status(400).json({ error: checked.error })
    await client.query('BEGIN')
    await replaceStorageRules(client, site.id, commodity.id, checked.rules, req.sessionUser.id)
    await client.query('COMMIT')
    res.json({ rules: await specsOf(site.id, commodity.id) })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    next(error)
  } finally {
    client.release()
  }
})

// Company, Site and Plant as stored in the database. DataHub fills these through the admin sync.
router.get('/org', async (_req, res, next) => {
  try {
    const [companies, sites, plants] = await Promise.all([
      query(`SELECT id, code, name, short_name, country, hub_code, is_active, is_activated FROM companies ORDER BY name`),
      query(`SELECT id, company_id, name, timezone, address, hub_code, is_active, is_activated FROM sites ORDER BY name`),
      query(`SELECT id, site_id, name, hub_code, is_active FROM plants ORDER BY name`),
    ])
    res.json({
      companies: companies.rows.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        shortName: row.short_name,
        country: row.country,
        hubCode: row.hub_code,
        isActive: row.is_active !== false,
        isActivated: row.is_activated === true,
      })),
      sites: sites.rows.map((row) => ({
        id: row.id,
        companyId: row.company_id,
        name: row.name,
        timezone: row.timezone,
        address: row.address,
        hubCode: row.hub_code,
        isActive: row.is_active !== false,
        isActivated: row.is_activated === true,
      })),
      plants: plants.rows.map((row) => ({
        id: row.id,
        siteId: row.site_id,
        name: row.name,
        hubCode: row.hub_code,
        isActive: row.is_active !== false,
      })),
    })
  } catch (error) {
    next(error)
  }
})

// Switch a company or site on or off for this application.
// A site needs its company on. A company with a site that is on cannot be switched off.
async function setActivation(req, res, next) {
  try {
    const { entityType, id, activated } = req.body ?? {}
    if (!['company', 'site'].includes(entityType) || !id || typeof activated !== 'boolean') {
      return res.status(400).json({ error: 'invalid_request' })
    }
    const page = entityType === 'company' ? 'master-companies' : 'master-sites'
    if (!req.sessionUser?.permissions?.[page]?.edit) return res.status(403).json({ error: 'forbidden' })

    if (entityType === 'site') {
      const site = await query('SELECT s.id, c.is_activated AS company_on FROM sites s JOIN companies c ON c.id = s.company_id WHERE s.id = $1', [id])
      if (site.rows.length === 0) return res.status(404).json({ error: 'not_found' })
      if (activated && !site.rows[0].company_on) return res.status(409).json({ error: 'company_not_activated' })
      await query('UPDATE sites SET is_activated = $2, updated_at = NOW() WHERE id = $1', [id, activated])
    } else {
      const company = await query('SELECT id FROM companies WHERE id = $1', [id])
      if (company.rows.length === 0) return res.status(404).json({ error: 'not_found' })
      if (!activated) {
        const open = await query('SELECT 1 FROM sites WHERE company_id = $1 AND is_activated LIMIT 1', [id])
        if (open.rows.length) return res.status(409).json({ error: 'company_has_active_sites' })
      }
      await query('UPDATE companies SET is_activated = $2, updated_at = NOW() WHERE id = $1', [id, activated])
    }
    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
}

router.put('/org/activation', setActivation)

// Timezone is local to this application. DataHub has no timezone field.
router.put('/org/sites/:id', async (req, res, next) => {
  try {
    if (!req.sessionUser?.permissions?.['master-sites']?.edit) return res.status(403).json({ error: 'forbidden' })
    const timezone = String(req.body?.timezone ?? '').trim()
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone })
    } catch {
      return res.status(400).json({ error: 'invalid_timezone' })
    }
    const result = await query('UPDATE sites SET timezone = $2, updated_at = NOW() WHERE id = $1 RETURNING id', [req.params.id, timezone])
    if (result.rows.length === 0) return res.status(404).json({ error: 'not_found' })
    res.json({ ok: true, timezone })
  } catch (error) {
    next(error)
  }
})

export default router
