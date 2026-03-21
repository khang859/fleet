import { dirname, join, basename, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { RuntimeBootstrapArgs, RuntimeEvent } from '../shared/starbase-runtime'
import { EventBus } from './event-bus'
import { StarbaseDB } from './starbase/db'
import { SectorService } from './starbase/sector-service'
import { ConfigService } from './starbase/config-service'
import { MissionService } from './starbase/mission-service'
import { WorktreeManager } from './starbase/worktree-manager'
import { CrewService } from './starbase/crew-service'
import { CommsService } from './starbase/comms-service'
import { runReconciliation } from './starbase/reconciliation'
import { FirstOfficer } from './starbase/first-officer'
import { Navigator } from './starbase/navigator'
import { Lockfile } from './starbase/lockfile'
import { SupplyRouteService } from './starbase/supply-route-service'
import { CargoService } from './starbase/cargo-service'
import { RetentionService } from './starbase/retention-service'
import { ProtocolService } from './starbase/protocol-service'
import { ShipsLog } from './starbase/ships-log'
import type { StarbaseRuntimeStatus } from '../shared/ipc-api'

type RuntimeDeps = {
  starbaseDb: StarbaseDB
  sectorService: SectorService
  configService: ConfigService
  missionService: MissionService
  crewService: CrewService
  commsService: CommsService
  supplyRouteService: SupplyRouteService
  cargoService: CargoService
  retentionService: RetentionService
  protocolService: ProtocolService
  shipsLog: ShipsLog
  firstOfficer: FirstOfficer
  navigator: Navigator
  lockfile: Lockfile | null
}

export class StarbaseRuntimeCore {
  private deps: RuntimeDeps | null = null
  private eventBus = new EventBus()
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null
  private status: StarbaseRuntimeStatus = { state: 'starting' }
  private emitEvent: ((event: RuntimeEvent) => void) | null = null
  private workspacePath = ''

  setEventSink(emitEvent: (event: RuntimeEvent) => void): void {
    this.emitEvent = emitEvent
  }

  getStatus(): StarbaseRuntimeStatus {
    return this.status
  }

  async invoke(method: string, args?: unknown): Promise<unknown> {
    switch (method) {
      case 'runtime.bootstrap':
        return this.bootstrap(args as RuntimeBootstrapArgs)
      case 'runtime.getStatus':
        return this.status
      case 'runtime.getAdmiralBootstrapData':
        return this.getAdmiralBootstrapData()

      case 'sector.listVisible':
        return this.requireDeps().sectorService.listVisibleSectors()
      case 'sector.get':
        return this.requireDeps().sectorService.getSector(args as string)
      case 'sector.add':
        return this.requireDeps().sectorService.addSector(args as Parameters<SectorService['addSector']>[0])
      case 'sector.remove':
        return this.requireDeps().sectorService.removeSector(args as string)
      case 'sector.update': {
        const { sectorId, fields } = args as { sectorId: string; fields: Record<string, unknown> }
        return this.requireDeps().sectorService.updateSector(sectorId, fields)
      }

      case 'config.get':
        return this.requireDeps().configService.get(args as string)
      case 'config.getAll':
        return this.requireDeps().configService.getAll()
      case 'config.set': {
        const { key, value } = args as { key: string; value: unknown }
        return this.requireDeps().configService.set(key, value)
      }

      case 'mission.add':
        return this.requireDeps().missionService.addMission(args as Parameters<MissionService['addMission']>[0])
      case 'mission.list':
        return this.requireDeps().missionService.listMissions(args as Parameters<MissionService['listMissions']>[0])
      case 'mission.get':
        return this.requireDeps().missionService.getMission(args as number)
      case 'mission.update': {
        const { missionId, fields } = args as { missionId: number; fields: Record<string, string> }
        return this.requireDeps().missionService.updateMission(missionId, fields)
      }
      case 'mission.setStatus': {
        const { missionId, status } = args as { missionId: number; status: string }
        return this.requireDeps().missionService.setStatus(missionId, status)
      }
      case 'mission.resetForRequeue':
        return this.requireDeps().missionService.resetForRequeue(args as number)
      case 'mission.abort':
        return this.requireDeps().missionService.abortMission(args as number)
      case 'mission.setReviewVerdict': {
        const { missionId, verdict, notes } = args as { missionId: number; verdict: string; notes: string }
        return this.requireDeps().missionService.setReviewVerdict(missionId, verdict, notes)
      }
      case 'mission.getDependencies':
        return this.requireDeps().missionService.getDependencies(args as number)

      case 'crew.deploy':
        return this.requireDeps().crewService.deployCrew(args as Parameters<CrewService['deployCrew']>[0])
      case 'crew.recall':
        return this.requireDeps().crewService.recallCrew(args as string)
      case 'crew.list':
        return this.requireDeps().crewService.listCrew(args as Parameters<CrewService['listCrew']>[0])
      case 'crew.status':
        return this.requireDeps().crewService.getCrewStatus(args as string)
      case 'crew.observe':
        return this.requireDeps().crewService.observeCrew(args as string)
      case 'crew.message': {
        const { crewId, message } = args as { crewId: string; message: string }
        return this.requireDeps().crewService.messageCrew(crewId, message)
      }

      case 'comms.getUnread':
        return this.requireDeps().commsService.getUnread(args as string)
      case 'comms.getUnreadByExecution':
        return this.requireDeps().commsService.getUnreadByExecution(args as string)
      case 'comms.getRecent':
        return this.requireDeps().commsService.getRecent(args as Parameters<CommsService['getRecent']>[0])
      case 'comms.markRead':
        return this.requireDeps().commsService.markRead(args as number)
      case 'comms.resolve': {
        const { id, response } = args as { id: number; response: string }
        return this.requireDeps().commsService.resolve(id, response)
      }
      case 'comms.delete':
        return this.requireDeps().commsService.delete(args as number)
      case 'comms.markAllRead':
        return this.requireDeps().commsService.markAllRead(args as Parameters<CommsService['markAllRead']>[0])
      case 'comms.clear':
        return this.requireDeps().commsService.clear(args as Parameters<CommsService['clear']>[0])
      case 'comms.getTransmission':
        return this.requireDeps().commsService.getTransmission(args as number)
      case 'comms.send':
        return this.requireDeps().commsService.send(args as Parameters<CommsService['send']>[0])

      case 'supplyRoute.list':
        return this.requireDeps().supplyRouteService.listRoutes(args as Parameters<SupplyRouteService['listRoutes']>[0])
      case 'supplyRoute.add':
        return this.requireDeps().supplyRouteService.addRoute(args as Parameters<SupplyRouteService['addRoute']>[0])
      case 'supplyRoute.remove':
        return this.requireDeps().supplyRouteService.removeRoute(args as number)
      case 'supplyRoute.graph':
        return this.requireDeps().supplyRouteService.getGraph()

      case 'cargo.list':
        return this.requireDeps().cargoService.listCargo(args as Parameters<CargoService['listCargo']>[0])
      case 'cargo.get':
        return this.requireDeps().cargoService.getCargo(args as number)
      case 'cargo.produce':
        return this.requireDeps().cargoService.produceCargo(args as Parameters<CargoService['produceCargo']>[0])
      case 'cargo.getUndelivered':
        return this.requireDeps().cargoService.getUndelivered(args as string)

      case 'retention.stats':
        return this.requireDeps().retentionService.getStats()
      case 'retention.cleanup':
        return this.requireDeps().retentionService.cleanup()
      case 'retention.vacuum':
        return this.requireDeps().retentionService.vacuum()

      case 'shipsLog.query':
        return this.requireDeps().shipsLog.query(args as Parameters<ShipsLog['query']>[0])
      case 'shipsLog.combined': {
        const limit = (args as { limit?: number } | undefined)?.limit ?? 200
        return this.requireDeps().starbaseDb
          .getDb()
          .prepare(`
            SELECT 'ships_log' as source, id, crew_id as actor, NULL as target, event_type as eventType, detail, created_at as timestamp
            FROM ships_log
            UNION ALL
            SELECT 'comms', id, from_crew, to_crew, type, payload, created_at
            FROM comms WHERE type NOT IN ('memo', 'hailing-memo')
            ORDER BY timestamp ASC LIMIT ?
          `)
          .all(limit)
      }

      case 'protocol.list':
        return this.requireDeps().protocolService.listProtocols()
      case 'protocol.getBySlug':
        return this.requireDeps().protocolService.getProtocolBySlug(args as string)
      case 'protocol.listSteps':
        return this.requireDeps().protocolService.listSteps(args as string)
      case 'protocol.setEnabled': {
        const { slug, enabled } = args as { slug: string; enabled: boolean }
        return this.requireDeps().protocolService.setProtocolEnabled(slug, enabled)
      }
      case 'protocol.listExecutions':
        return this.requireDeps().protocolService.listExecutions(args as string | undefined)
      case 'protocol.getExecution':
        return this.requireDeps().protocolService.getExecution(args as string)
      case 'protocol.advanceStep': {
        const { id, step } = args as { id: string; step: number }
        return this.requireDeps().protocolService.advanceStep(id, step)
      }
      case 'protocol.updateExecutionStatus': {
        const { id, status } = args as { id: string; status: string }
        return this.requireDeps().protocolService.updateExecutionStatus(id, status)
      }
      case 'protocol.updateExecutionContext': {
        const { id, context } = args as { id: string; context: string }
        return this.requireDeps().protocolService.updateExecutionContext(id, context)
      }

      case 'memo.list':
        return this.listMemos()
      case 'memo.read':
        return this.markMemoRead(args as number)
      case 'memo.dismiss':
        return this.dismissMemo(args as number)
      case 'memo.content':
        return this.getMemoContent(args as string)

      case 'starbase.snapshot':
        return this.buildSnapshot()
      case 'starbase.logEntry':
        return this.getRecentLogEntry()

      default: {
        const error = new Error(`Unknown runtime method: ${method}`) as Error & { code?: string }
        error.code = 'NOT_FOUND'
        throw error
      }
    }
  }

  private async bootstrap(args: RuntimeBootstrapArgs): Promise<void> {
    if (this.deps) {
      return
    }

    this.setStatus({ state: 'starting' })
    this.workspacePath = args.workspacePath

    let localStarbaseDb: StarbaseDB | null = null
    let localLockfile: Lockfile | null = null

    try {
      localStarbaseDb = new StarbaseDB(args.workspacePath)
      localStarbaseDb.open()

      const sectorService = new SectorService(localStarbaseDb.getDb(), args.workspacePath, this.eventBus)
      const configService = new ConfigService(localStarbaseDb.getDb())
      const supplyRouteService = new SupplyRouteService(localStarbaseDb.getDb())
      const cargoService = new CargoService(localStarbaseDb.getDb(), supplyRouteService, configService)
      const retentionService = new RetentionService(
        localStarbaseDb.getDb(),
        configService,
        localStarbaseDb.getDbPath()
      )
      const missionService = new MissionService(localStarbaseDb.getDb(), this.eventBus)

      const worktreeBasePath = join(dirname(localStarbaseDb.getDbPath()), 'worktrees')
      const worktreeManager = new WorktreeManager(worktreeBasePath)
      const maxConcurrent = configService.get('max_concurrent_worktrees') as number
      worktreeManager.configure(localStarbaseDb.getDb(), maxConcurrent)

      const crewService = new CrewService({
        db: localStarbaseDb.getDb(),
        starbaseId: localStarbaseDb.getStarbaseId(),
        sectorService,
        missionService,
        configService,
        worktreeManager,
        eventBus: this.eventBus,
        crewEnv: args.env,
      })

      const commsService = new CommsService(localStarbaseDb.getDb(), this.eventBus)
      commsService.setRateLimit(configService.get('comms_rate_limit_per_min') as number)

      const protocolService = new ProtocolService(localStarbaseDb.getDb())
      const firstOfficer = new FirstOfficer({
        db: localStarbaseDb.getDb(),
        configService,
        missionService,
        crewService,
        cargoService,
        eventBus: this.eventBus,
        starbaseId: localStarbaseDb.getStarbaseId(),
        crewEnv: args.env,
        fleetBinDir: args.fleetBinPath,
      })
      const navigator = new Navigator({
        db: localStarbaseDb.getDb(),
        configService,
        eventBus: this.eventBus,
        starbaseId: localStarbaseDb.getStarbaseId(),
        crewEnv: args.env,
        fleetBinDir: args.fleetBinPath,
      })
      const shipsLog = new ShipsLog(localStarbaseDb.getDb())

      const basePath = dirname(localStarbaseDb.getDbPath())
      localLockfile = new Lockfile(basePath, localStarbaseDb.getStarbaseId())
      const lockResult = localLockfile.acquire()
      if (lockResult === 'acquired') {
        await runReconciliation({
          db: localStarbaseDb.getDb(),
          starbaseId: localStarbaseDb.getStarbaseId(),
          worktreeBasePath,
        })
        firstOfficer.reconcile()
        navigator.reconcile()
        mkdirSync(
          join(
            process.env.HOME ?? '~',
            '.fleet',
            'starbases',
            `starbase-${localStarbaseDb.getStarbaseId()}`,
            'first-officer',
            'memos'
          ),
          { recursive: true }
        )
      }

      this.deps = {
        starbaseDb: localStarbaseDb,
        sectorService,
        configService,
        missionService,
        crewService,
        commsService,
        supplyRouteService,
        cargoService,
        retentionService,
        protocolService,
        shipsLog,
        firstOfficer,
        navigator,
        lockfile: localLockfile,
      }

      this.eventBus.on('starbase-changed', () => {
        this.scheduleSnapshot()
      })
      this.scheduleSnapshot()
      this.setStatus({ state: 'ready' })
    } catch (error) {
      try {
        localLockfile?.release()
      } catch {
        // Ignore cleanup errors.
      }
      try {
        localStarbaseDb?.close()
      } catch {
        // Ignore cleanup errors.
      }
      const message = error instanceof Error ? error.message : String(error)
      this.setStatus({ state: 'error', error: message })
      throw error
    }
  }

  private requireDeps(): RuntimeDeps {
    if (!this.deps) {
      throw new Error('Starbase runtime not ready')
    }
    return this.deps
  }

  private setStatus(status: StarbaseRuntimeStatus): void {
    this.status = status
    this.emitEvent?.({ event: 'runtime.status', payload: status })
  }

  private scheduleSnapshot(): void {
    if (this.snapshotTimer) return
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null
      const snapshot = this.buildSnapshot()
      this.emitEvent?.({ event: 'starbase.snapshot', payload: snapshot })
      const recentEntry = this.getRecentLogEntry()
      if (recentEntry) {
        this.emitEvent?.({ event: 'starbase.log-entry', payload: recentEntry })
      }
    }, 25)
  }

  private buildSnapshot(): unknown {
    const deps = this.requireDeps()
    const unreadComms = deps.commsService.getUnread('admiral')
    return {
      crew: deps.crewService.listCrew(),
      missions: deps.missionService.listMissions(),
      sectors: deps.sectorService.listVisibleSectors(),
      unreadCount: unreadComms.length,
      firstOfficer: {
        status: deps.firstOfficer.getStatus(),
        statusText: deps.firstOfficer.getStatusText(),
        unreadMemos: this.getUnreadMemoCount(),
      },
    }
  }

  private getUnreadMemoCount(): number {
    return (
      this.requireDeps()
        .starbaseDb
        .getDb()
        .prepare(
          "SELECT COUNT(*) as cnt FROM comms WHERE type IN ('memo', 'hailing-memo') AND to_crew = 'admiral' AND read = 0"
        )
        .get() as { cnt: number }
    ).cnt
  }

  private getRecentLogEntry(): unknown {
    return this.requireDeps()
      .starbaseDb
      .getDb()
      .prepare(`
        SELECT 'ships_log' as source, id, crew_id as actor, NULL as target, event_type as eventType, detail, created_at as timestamp FROM ships_log
        UNION ALL
        SELECT 'comms', id, from_crew, to_crew, type, payload, created_at FROM comms WHERE type NOT IN ('memo', 'hailing-memo')
        ORDER BY timestamp DESC LIMIT 1
      `)
      .get()
  }

  private getAdmiralBootstrapData(): {
    starbaseId: string
    starbaseName: string
    sectors: Array<{ name: string; root_path: string; stack?: string; base_branch?: string }>
  } {
    const deps = this.requireDeps()
    return {
      starbaseId: deps.starbaseDb.getStarbaseId(),
      starbaseName:
        (deps.configService.get('starbase_name') as string | undefined) ??
        basename(this.workspacePath) ??
        'Starbase',
      sectors: deps.sectorService.listVisibleSectors().map((sector) => ({
        name: sector.name,
        root_path: sector.root_path,
        stack: sector.stack ?? undefined,
        base_branch: sector.base_branch ?? undefined,
      })),
    }
  }

  private listMemos(): unknown[] {
    return this.requireDeps()
      .starbaseDb
      .getDb()
      .prepare(
        "SELECT id, from_crew as crew_id, mission_id, type as event_type, payload, read, created_at FROM comms WHERE type IN ('memo', 'hailing-memo') ORDER BY created_at DESC"
      )
      .all()
      .map((row: any) => {
        try {
          const payload = JSON.parse(row.payload ?? '{}') as { filePath?: string; summary?: string }
          return {
            ...row,
            file_path: payload.filePath ?? '',
            status: row.read ? 'read' : 'unread',
            summary: payload.summary ?? '',
          }
        } catch {
          return { ...row, file_path: '', status: row.read ? 'read' : 'unread', summary: '' }
        }
      })
  }

  private markMemoRead(id: number): void {
    this.requireDeps().starbaseDb.getDb().prepare('UPDATE comms SET read = 1 WHERE id = ?').run(id)
    this.eventBus.emit('starbase-changed', { type: 'starbase-changed' })
  }

  private dismissMemo(id: number): void {
    this.requireDeps().starbaseDb.getDb().prepare('DELETE FROM comms WHERE id = ?').run(id)
    this.eventBus.emit('starbase-changed', { type: 'starbase-changed' })
  }

  private async getMemoContent(filePath: string): Promise<string | null> {
    const allowedBase = join(process.env.HOME ?? '~', '.fleet', 'starbases')
    const resolved = resolve(filePath)
    if (!resolved.startsWith(allowedBase) || !resolved.includes('first-officer/memos/')) {
      return null
    }
    try {
      return await readFile(resolved, 'utf-8')
    } catch {
      return null
    }
  }
}
