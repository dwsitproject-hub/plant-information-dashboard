/**
 * The management Stock Overview. One call returns every site the user holds with the Tank farm module on,
 * built from the same tank rows Live Ops shows. Needs the management-stock right, not Live Ops, so a
 * management role does not have to be given the operational pages.
 */
import { Router } from 'express'
import { requireAuth, requirePermission } from '../access.js'
import { commodityClassOf } from '../domain/commodityClass.js'
import { NEAR_FULL, daysBetween, movementSeries, summarisePortfolio, summariseSite } from '../domain/portfolio.js'
import { localDate } from '../tankgauging/rounds.js'
import { loadSiteHistory, loadSiteTanks, loadTankHistory, loadTankLabs, siteOf } from './operations.js'

const router = Router()

router.use('/portfolio', requireAuth, requirePermission('management-stock', 'view'))

function dayBefore(day) {
  if (!day) return null
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

/** The sites this user may see here: held by them, and with the Tank farm module on. */
function visibleSites(user) {
  return (user.sites ?? []).filter((site) => site.modules?.includes('live-ops'))
}

router.get('/portfolio/stock', async (req, res, next) => {
  try {
    const nearFull = NEAR_FULL
    const held = visibleSites(req.sessionUser)
    const settled = await Promise.all(
      held.map(async (held) => {
        try {
          const site = await siteOf(held.id)
          if (!site) return null
          const current = await loadSiteTanks(site)
          const before = current.day ? await loadSiteTanks(site, dayBefore(current.day)) : null
          return summariseSite(
            { id: site.id, name: site.name, companyName: site.company_name, timezone: site.timezone },
            current.tanks,
            { day: current.day, live: current.live, previous: before?.tanks ?? null, nearFull },
          )
        } catch (error) {
          console.error(`portfolio: site ${held.id} failed`, error)
          return { id: held.id, name: held.name, error: true }
        }
      }),
    )
    const sites = settled.filter((site) => site && !site.error).sort((a, b) => b.quantityKg - a.quantityKg)
    const failed = settled.filter((site) => site?.error).map((site) => ({ id: site.id, name: site.name }))
    res.json({ generatedAt: new Date().toISOString(), portfolio: summarisePortfolio(sites, nearFull), sites, failed })
  } catch (error) {
    next(error)
  }
})

router.get('/portfolio/sites/:siteId/tanks/:tankId/history', async (req, res, next) => {
  try {
    if (!visibleSites(req.sessionUser).some((site) => site.id === req.params.siteId)) {
      return res.status(403).json({ error: 'forbidden' })
    }
    const points = await loadTankHistory(req.params.siteId, req.params.tankId)
    res.json(
      points.map((point) => ({
        recordedOn: point.recordedOn,
        roundIndex: point.roundIndex,
        // Worked out on the server for gauge and manual points alike, so logsheet tanks have a history too.
        quantityKg: point.quantityKg,
        capacityKg: point.capacityKg,
        fillRatio: point.fillRatio,
        // The commodity dialog's tank table reads these too.
        emptySpaceKg: point.emptySpaceKg,
        loadableKg: point.loadableKg,
        operationalStatus: point.operationalStatus,
        levelM: point.soundingLevelM,
        temperatureC: point.temperatureC,
      })),
    )
  } catch (error) {
    next(error)
  }
})

// One tank's lab results over time, for the quality line of the commodity dialog.
router.get('/portfolio/sites/:siteId/tanks/:tankId/labs', async (req, res, next) => {
  try {
    if (!visibleSites(req.sessionUser).some((site) => site.id === req.params.siteId)) {
      return res.status(403).json({ error: 'forbidden' })
    }
    const site = await siteOf(req.params.siteId)
    if (!site) return res.status(404).json({ error: 'not_found' })
    res.json(await loadTankLabs(site, req.params.tankId))
  } catch (error) {
    next(error)
  }
})

/** The day `days - 1` days before `to`, so the range holds `days` days. */
function rangeStart(to, days) {
  const date = new Date(`${to}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() - (days - 1))
  return date.toISOString().slice(0, 10)
}

/**
 * Commodity Stock Movement on the Stock Overview: each site's total stock per day over the last month,
 * and per commodity class. A site's "today" is its own local date.
 */
router.get('/portfolio/movement', async (req, res, next) => {
  try {
    const days = Math.min(92, Math.max(7, Number(req.query.days) || 30))
    const held = visibleSites(req.sessionUser)
    const settled = await Promise.all(
      held.map(async (held) => {
        try {
          const site = await siteOf(held.id)
          if (!site) return null
          const to = localDate(new Date(), site.timezone)
          const from = rangeStart(to, days)
          // A tank's class follows the product it holds now, as on the rest of the overview.
          const { tanks } = await loadSiteTanks(site)
          const classOf = new Map(tanks.map((tank) => [tank.tankId, commodityClassOf(tank.productName, tank.stockGroup)]))
          const series = movementSeries(await loadSiteHistory(site, from, to), daysBetween(from, to), (tankId) => classOf.get(tankId) ?? 'other')
          return {
            id: site.id,
            name: site.name,
            from,
            to,
            series: series.total,
            classes: series.groups,
          }
        } catch (error) {
          console.error(`portfolio movement: site ${held.id} failed`, error)
          return { id: held.id, name: held.name, error: true }
        }
      }),
    )
    res.json({
      days,
      sites: settled.filter((site) => site && !site.error),
      failed: settled.filter((site) => site?.error).map((site) => ({ id: site.id, name: site.name })),
    })
  } catch (error) {
    next(error)
  }
})

export default router
