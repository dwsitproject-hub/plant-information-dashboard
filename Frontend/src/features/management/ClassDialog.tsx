import { useCallback } from 'react'
import { api } from '../../data/api.ts'
import { productOf, type CommodityClass, type PortfolioSite } from '../../domain/management.ts'
import { sampleOf } from '../../domain/qualityView.ts'
import type { SoundingPoint } from '../../domain/types.ts'
import { CommodityTrendDialog, type TrendTank } from '../live-ops/CommodityTrendDialog.tsx'
import { useClassLabel } from './parts.tsx'

interface HistoryRow {
  recordedOn: string
  roundIndex: number
  quantityKg: number | null
  capacityKg: number | null
  fillRatio: number | null
  emptySpaceKg?: number | null
  loadableKg?: number | null
  operationalStatus?: string | null
  levelM: number | null
  temperatureC: number | null
}

/** The portfolio history in the shape the commodity dialog reads. The server has already worked out stock. */
function toPoint(row: HistoryRow): SoundingPoint {
  return {
    roundIndex: row.roundIndex,
    recordedOn: row.recordedOn,
    soundingLevelM: row.levelM,
    temperatureC: row.temperatureC,
    operationalStatus: row.operationalStatus ?? '',
    capacityKg: row.capacityKg,
    quantityKg: row.quantityKg,
    emptySpaceKg: row.emptySpaceKg ?? null,
    loadableKg: row.loadableKg ?? null,
    fillRatio: row.fillRatio,
    storageVerdict: 'spec-pending',
  }
}

/**
 * The same dialog as a commodity card on the Tank & Stock Dashboard, for one class (or one product of it)
 * at one site: the stock over time, and each tank with its quality on the chosen day.
 */
export function ClassDialog({
  site,
  code,
  product,
  onClose,
}: {
  site: PortfolioSite | null
  code: CommodityClass | null
  product?: string | null
  onClose: () => void
}) {
  const label = useClassLabel()
  const siteId = site?.id ?? ''
  const loadHistory = useCallback(
    async (tankId: string) => {
      const rows = await api<HistoryRow[]>(`/api/v1/portfolio/sites/${encodeURIComponent(siteId)}/tanks/${encodeURIComponent(tankId)}/history`)
      return rows.map(toPoint)
    },
    [siteId],
  )
  const tanks = site && code
    ? site.tanks.filter((tank) => tank.commodityClass === code && tank.capacityKg != null && (!product || productOf(tank) === product))
    : []
  const sources: TrendTank[] = tanks.map((tank) => ({
    tankId: tank.tankId,
    quantityKg: tank.quantityKg,
    operationalStatus: '',
    productName: productOf(tank),
    sample: sampleOf(tank.tankId, tank.quality ?? null, tank.quality?.before ?? null),
  }))
  const temperatures = tanks.map((tank) => tank.temperatureC).filter((value): value is number => value != null)
  const averageTemperature = temperatures.length ? temperatures.reduce((sum, value) => sum + value, 0) / temperatures.length : null
  const title = site && code ? `${product ?? label(code)} · ${site.name}` : ''
  return (
    <CommodityTrendDialog
      code={site && code ? `${site.id}|${code}|${product ?? ''}` : null}
      title={title}
      sources={sources}
      day={site?.day ?? ''}
      averageTemperature={averageTemperature}
      hasLabData={tanks.some((tank) => tank.quality)}
      showProduct={!product && new Set(sources.map((tank) => tank.productName)).size > 1}
      loadHistory={loadHistory}
      onClose={onClose}
    />
  )
}
