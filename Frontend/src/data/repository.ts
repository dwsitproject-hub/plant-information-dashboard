import type {
  AnalyticsSummary,
  LabHistoryPoint,
  LogisticsVehicle,
  MovementTotal,
  SiteContext,
  SnapshotMeta,
  SoundingPoint,
  TankLive,
} from '../domain/types.ts'

/** One tank's readings over time, keyed by its tank code. */
export interface TankHistory {
  tankId: string
  points: SoundingPoint[]
}

/**
 * The only door between screens and data.
 *
 * LocalOperationsRepository serves the mock from parsed logsheets.
 * HttpOperationsRepository calls the same paths on Express:
 *
 *   GET /api/site
 *   GET /api/site/snapshot
 *   GET /api/live/tanks
 *   GET /api/live/logistics
 *   GET /api/tanks/:tankId/soundings
 *   GET /api/tanks/:tankId/labs
 *   GET /api/analytics/summary?tankId=
 *   GET /api/analytics/movements
 *
 * Screens keep using these methods when the backend arrives.
 */
export interface OperationsRepository {
  /** Point the repository at another site. Screens then read that site. */
  setSiteId?(siteId: string): void
  getSnapshotMeta(): Promise<SnapshotMeta>
  getSite(): Promise<SiteContext>
  getLiveTanks(on?: string | null, range?: { start: string; end: string }): Promise<TankLive[]>
  getLiveLogistics(): Promise<LogisticsVehicle[]>
  getSoundingHistory(tankId: string): Promise<SoundingPoint[]>
  getLabHistory(tankId: string): Promise<LabHistoryPoint[]>
  /** Every tank's daily readings between two days (inclusive), for the stock movement view. */
  getStockHistory(from: string, to: string): Promise<TankHistory[]>
  getMovementSummary(): Promise<MovementTotal[]>
  getAnalyticsSummary(tankId: string | null): Promise<AnalyticsSummary>
}
