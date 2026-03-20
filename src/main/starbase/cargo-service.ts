import type Database from 'better-sqlite3'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type { SupplyRouteService } from './supply-route-service'
import type { ConfigService } from './config-service'

type CargoRow = {
  id: number
  crew_id: string | null
  mission_id: number | null
  sector_id: string
  type: string | null
  manifest: string | null
  verified: number
  created_at: string
}

type ProduceCargoOpts = {
  crewId?: string
  missionId?: number
  sectorId: string
  type?: string
  manifest?: string
}

type ProduceRecoveredCargoOpts = {
  crewId: string
  missionId: number
  sectorId: string
  title: string
  contentMarkdown: string
  summary: string
  sourceKinds: string[]
  fingerprint?: string | null
  classification?: string | null
  starbaseId: string
}

type ListCargoFilter = {
  sectorId?: string
  crewId?: string
  type?: string
  verified?: boolean
}

const FAILED_STATUSES = ['error', 'lost', 'timeout', 'failed', 'failed-verification', 'escalated']

export class CargoService {
  constructor(
    private db: Database.Database,
    private supplyRouteService: SupplyRouteService,
    private configService: ConfigService
  ) {}

  produceCargo(opts: ProduceCargoOpts): CargoRow {
    let verified = 1

    if (opts.missionId != null) {
      const mission = this.db
        .prepare('SELECT status FROM missions WHERE id = ?')
        .get(opts.missionId) as { status: string } | undefined

      if (mission && FAILED_STATUSES.includes(mission.status)) {
        verified = 0
      }
    }

    const result = this.db
      .prepare(
        `INSERT INTO cargo (crew_id, mission_id, sector_id, type, manifest, verified)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        opts.crewId ?? null,
        opts.missionId ?? null,
        opts.sectorId,
        opts.type ?? null,
        opts.manifest ?? null,
        verified
      )

    return this.db
      .prepare('SELECT * FROM cargo WHERE id = ?')
      .get(result.lastInsertRowid) as CargoRow
  }

  async produceRecoveredCargo(opts: ProduceRecoveredCargoOpts): Promise<CargoRow> {
    const cargoDir = join(
      process.env.HOME ?? '~',
      '.fleet',
      'starbases',
      `starbase-${opts.starbaseId}`,
      'cargo',
      opts.sectorId,
      String(opts.missionId),
    )

    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const filePath = join(cargoDir, `recovered-${ts}.md`)

    let manifest: string
    try {
      await mkdir(cargoDir, { recursive: true })
      await writeFile(filePath, opts.contentMarkdown, 'utf-8')
      manifest = JSON.stringify({
        title: opts.title,
        path: filePath,
        summary: opts.summary,
        sourceKinds: opts.sourceKinds,
        originalCrewId: opts.crewId,
        missionId: opts.missionId,
        fingerprint: opts.fingerprint ?? null,
        classification: opts.classification ?? null,
        recoveredBy: 'first-officer',
      })
    } catch {
      manifest = JSON.stringify({
        title: opts.title,
        content: opts.contentMarkdown,
        summary: opts.summary,
        sourceKinds: opts.sourceKinds,
        originalCrewId: opts.crewId,
        missionId: opts.missionId,
        fingerprint: opts.fingerprint ?? null,
        classification: opts.classification ?? null,
        recoveredBy: 'first-officer',
      })
    }

    return this.produceCargo({
      crewId: opts.crewId,
      missionId: opts.missionId,
      sectorId: opts.sectorId,
      type: 'recovered_cargo',
      manifest,
    })
  }

  getCargo(id: number): CargoRow | undefined {
    return this.db.prepare('SELECT * FROM cargo WHERE id = ?').get(id) as CargoRow | undefined
  }

  listCargo(filter?: ListCargoFilter): CargoRow[] {
    let sql = 'SELECT * FROM cargo WHERE 1=1'
    const params: unknown[] = []

    if (filter?.sectorId) {
      sql += ' AND sector_id = ?'
      params.push(filter.sectorId)
    }
    if (filter?.crewId) {
      sql += ' AND crew_id = ?'
      params.push(filter.crewId)
    }
    if (filter?.type) {
      sql += ' AND type = ?'
      params.push(filter.type)
    }
    if (filter?.verified !== undefined) {
      sql += ' AND verified = ?'
      params.push(filter.verified ? 1 : 0)
    }

    sql += ' ORDER BY created_at ASC, id ASC'
    return this.db.prepare(sql).all(...params) as CargoRow[]
  }

  getUndelivered(sectorId: string): CargoRow[] {
    // Get upstream sectors via supply routes
    const upstreamRoutes = this.supplyRouteService.getUpstream(sectorId)
    if (upstreamRoutes.length === 0) return []

    const upstreamSectorIds = upstreamRoutes.map((r) => r.upstream_sector_id)

    // Find the last deployment time in this sector (latest completed crew)
    const lastDeployment = this.db
      .prepare(
        `SELECT MAX(updated_at) as last_deploy
         FROM crew
         WHERE sector_id = ? AND status = 'complete'`
      )
      .get(sectorId) as { last_deploy: string | null }

    const forwardFailed = this.configService.get('forward_failed_cargo') as boolean | undefined

    // Build query for cargo from upstream sectors
    const placeholders = upstreamSectorIds.map(() => '?').join(', ')
    let sql = `SELECT * FROM cargo WHERE sector_id IN (${placeholders})`
    const params: unknown[] = [...upstreamSectorIds]

    // Only cargo produced after last deployment
    if (lastDeployment?.last_deploy) {
      sql += ' AND created_at > ?'
      params.push(lastDeployment.last_deploy)
    }

    // Filter out unverified cargo unless forward_failed_cargo is enabled
    if (!forwardFailed) {
      sql += ' AND verified = 1'
    }

    sql += ' ORDER BY created_at ASC, id ASC'
    return this.db.prepare(sql).all(...params) as CargoRow[]
  }

  cleanup(olderThanDays: number = 14): number {
    const result = this.db
      .prepare(`DELETE FROM cargo WHERE created_at < datetime('now', ?)`)
      .run(`-${olderThanDays} days`)

    return result.changes
  }
}
