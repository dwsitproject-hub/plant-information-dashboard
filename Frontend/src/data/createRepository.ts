import { HttpOperationsRepository } from './httpRepository.ts'
import type { OperationsRepository } from './repository.ts'

/**
 * Local mode reads the bundled logsheets (about half a megabyte of JSON). Load that module only
 * when local mode is used, so an api build never sends it to the browser up front.
 */
class LazyLocalRepository implements OperationsRepository {
  private loading: Promise<OperationsRepository> | null = null

  private repo(): Promise<OperationsRepository> {
    this.loading ??= import('./localRepository.ts').then((module) => new module.LocalOperationsRepository())
    return this.loading
  }

  async getSnapshotMeta() {
    return (await this.repo()).getSnapshotMeta()
  }

  async getSite() {
    return (await this.repo()).getSite()
  }

  async getLiveTanks(...args: Parameters<OperationsRepository['getLiveTanks']>) {
    return (await this.repo()).getLiveTanks(...args)
  }

  async getLiveLogistics() {
    return (await this.repo()).getLiveLogistics()
  }

  async getSoundingHistory(tankId: string) {
    return (await this.repo()).getSoundingHistory(tankId)
  }

  async getLabHistory(tankId: string) {
    return (await this.repo()).getLabHistory(tankId)
  }

  async getMovementSummary() {
    return (await this.repo()).getMovementSummary()
  }

  async getAnalyticsSummary(tankId: string | null) {
    return (await this.repo()).getAnalyticsSummary(tankId)
  }
}

export function createRepository(): OperationsRepository {
  const source = import.meta.env.VITE_DATA_SOURCE ?? 'local'
  if (source === 'api') {
    const baseUrl = (import.meta.env.VITE_API_URL || '/api/v1').replace(/\/$/, '')
    return new HttpOperationsRepository(baseUrl)
  }
  return new LazyLocalRepository()
}
