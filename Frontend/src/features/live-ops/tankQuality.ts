import type { TankLive } from '../../domain/types.ts'
import { sampleOf, type QualitySample } from '../../domain/qualityView.ts'
import type { HistoryMetric } from './quantitySeries.ts'

/** A Tank & Stock tank as a quality sample, with the same tank as of yesterday when there is one. */
export function tankSample(tank: TankLive, before?: TankLive | null): QualitySample {
  return sampleOf(tank.tankId, tank.quality ?? null, before?.quality?.parameters ?? null)
}

/** The history chart for a lab parameter. FFA, M&I and colour keep their own names. */
export function labMetric(code: string): HistoryMetric {
  if (code === 'FFA') return 'ffa'
  if (code === 'MI') return 'moisture'
  if (code === 'COLOR_R') return 'colorR'
  if (code === 'COLOR_Y') return 'colorY'
  return `lab:${code}`
}
