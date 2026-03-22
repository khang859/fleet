import { dirname, join, basename, resolve } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { RuntimeBootstrapArgs, RuntimeEvent } from '../shared/starbase-runtime';
import { EventBus } from './event-bus';
import { StarbaseDB } from './starbase/db';
import { SectorService } from './starbase/sector-service';
import { ConfigService } from './starbase/config-service';
import { MissionService } from './starbase/mission-service';
import { WorktreeManager } from './starbase/worktree-manager';
import { CrewService } from './starbase/crew-service';
import { CommsService } from './starbase/comms-service';
import { runReconciliation } from './starbase/reconciliation';
import { FirstOfficer } from './starbase/first-officer';
import { Navigator } from './starbase/navigator';
import { Lockfile } from './starbase/lockfile';
import { SupplyRouteService } from './starbase/supply-route-service';
import { CargoService } from './starbase/cargo-service';
import { RetentionService } from './starbase/retention-service';
import { ProtocolService } from './starbase/protocol-service';
import { ShipsLog } from './starbase/ships-log';
import type { StarbaseRuntimeStatus } from '../shared/ipc-api';
import { CodedError, toError } from './errors';

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function toStringRecord(r: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) {
    if (typeof v === 'string') result[k] = v;
  }
  return result;
}

type RuntimeDeps = {
  starbaseDb: StarbaseDB;
  sectorService: SectorService;
  configService: ConfigService;
  missionService: MissionService;
  crewService: CrewService;
  commsService: CommsService;
  supplyRouteService: SupplyRouteService;
  cargoService: CargoService;
  retentionService: RetentionService;
  protocolService: ProtocolService;
  shipsLog: ShipsLog;
  firstOfficer: FirstOfficer;
  navigator: Navigator;
  lockfile: Lockfile | null;
};

const RUNTIME_TRACE_FILE = '/tmp/fleet-starbase-runtime.log';

function trace(message: string, extra?: unknown): void {
  const suffix = extra === undefined ? '' : ` ${JSON.stringify(extra)}`;
  try {
    appendFileSync(
      RUNTIME_TRACE_FILE,
      `[${new Date().toISOString()} pid=${process.pid}] core ${message}${suffix}\n`,
      'utf8'
    );
  } catch {
    // Ignore trace write failures.
  }
}

export class StarbaseRuntimeCore {
  private deps: RuntimeDeps | null = null;
  private eventBus = new EventBus();
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private status: StarbaseRuntimeStatus = { state: 'starting' };
  private emitEvent: ((event: RuntimeEvent) => void) | null = null;
  private workspacePath = '';

  setEventSink(emitEvent: (event: RuntimeEvent) => void): void {
    this.emitEvent = emitEvent;
  }

  getStatus(): StarbaseRuntimeStatus {
    return this.status;
  }

  async invoke(method: string, args?: unknown): Promise<unknown> {
    trace('invoke', { method });
    switch (method) {
      case 'runtime.bootstrap': {
        if (!isRecord(args))
          throw new CodedError('bootstrap args must be an object', 'BAD_REQUEST');
        if (typeof args.workspacePath !== 'string')
          throw new CodedError('workspacePath required', 'BAD_REQUEST');
        if (typeof args.fleetBinPath !== 'string')
          throw new CodedError('fleetBinPath required', 'BAD_REQUEST');
        if (!isRecord(args.env)) throw new CodedError('env required', 'BAD_REQUEST');
        return this.bootstrap({
          workspacePath: args.workspacePath,
          fleetBinPath: args.fleetBinPath,
          env: toStringRecord(args.env)
        });
      }
      case 'runtime.getStatus':
        return this.status;
      case 'runtime.getAdmiralBootstrapData':
        return this.getAdmiralBootstrapData();

      case 'sector.listVisible':
        return this.requireDeps().sectorService.listVisibleSectors();
      case 'sector.get': {
        if (typeof args !== 'string')
          throw new CodedError('sector ID must be a string', 'BAD_REQUEST');
        return this.requireDeps().sectorService.getSector(args);
      }
      case 'sector.add': {
        if (!isRecord(args)) throw new CodedError('args must be an object', 'BAD_REQUEST');
        if (typeof args.path !== 'string') throw new CodedError('path required', 'BAD_REQUEST');
        return this.requireDeps().sectorService.addSector({
          path: args.path,
          name: typeof args.name === 'string' ? args.name : undefined,
          description: typeof args.description === 'string' ? args.description : undefined,
          baseBranch: typeof args.baseBranch === 'string' ? args.baseBranch : undefined,
          mergeStrategy: typeof args.mergeStrategy === 'string' ? args.mergeStrategy : undefined
        });
      }
      case 'sector.remove': {
        if (typeof args !== 'string')
          throw new CodedError('sector ID must be a string', 'BAD_REQUEST');
        this.requireDeps().sectorService.removeSector(args);
        return;
      }
      case 'sector.update': {
        if (!isRecord(args)) throw new CodedError('args must be an object', 'BAD_REQUEST');
        const sectorId = args.sectorId;
        const fields = args.fields;
        if (typeof sectorId !== 'string') throw new CodedError('sectorId required', 'BAD_REQUEST');
        if (!isRecord(fields)) throw new CodedError('fields required', 'BAD_REQUEST');
        this.requireDeps().sectorService.updateSector(sectorId, toStringRecord(fields));
        return;
      }

      case 'config.get': {
        if (typeof args !== 'string')
          throw new CodedError('config key must be a string', 'BAD_REQUEST');
        return this.requireDeps().configService.get(args);
      }
      case 'config.getAll':
        return this.requireDeps().configService.getAll();
      case 'config.set': {
        if (!isRecord(args)) throw new CodedError('args must be an object', 'BAD_REQUEST');
        const key = args.key;
        if (typeof key !== 'string') throw new CodedError('key required', 'BAD_REQUEST');
        this.requireDeps().configService.set(key, args.value);
        return;
      }

      case 'mission.add': {
        if (!isRecord(args)) throw new CodedError('args must be an object', 'BAD_REQUEST');
        if (typeof args.sectorId !== 'string')
          throw new CodedError('sectorId required', 'BAD_REQUEST');
        if (typeof args.summary !== 'string')
          throw new CodedError('summary required', 'BAD_REQUEST');
        if (typeof args.prompt !== 'string') throw new CodedError('prompt required', 'BAD_REQUEST');
        return this.requireDeps().missionService.addMission({
          sectorId: args.sectorId,
          summary: args.summary,
          prompt: args.prompt,
          acceptanceCriteria:
            typeof args.acceptanceCriteria === 'string' ? args.acceptanceCriteria : undefined,
          priority: typeof args.priority === 'number' ? args.priority : undefined,
          dependsOnMissionIds: Array.isArray(args.dependsOnMissionIds)
            ? args.dependsOnMissionIds.filter((v): v is number => typeof v === 'number')
            : undefined,
          type: typeof args.type === 'string' ? args.type : undefined,
          prBranch: typeof args.prBranch === 'string' ? args.prBranch : undefined
        });
      }
      case 'mission.list': {
        if (args != null && !isRecord(args))
          throw new CodedError('filter must be an object', 'BAD_REQUEST');
        const filter = isRecord(args)
          ? {
              sectorId: typeof args.sectorId === 'string' ? args.sectorId : undefined,
              status: typeof args.status === 'string' ? args.status : undefined
            }
          : undefined;
        return this.requireDeps().missionService.listMissions(filter);
      }
      case 'mission.get': {
        if (typeof args !== 'number')
          throw new CodedError('mission ID must be a number', 'BAD_REQUEST');
        return this.requireDeps().missionService.getMission(args);
      }
      case 'mission.update': {
        if (!isRecord(args)) throw new CodedError('args must be an object', 'BAD_REQUEST');
        const missionId = args.missionId;
        const fields = args.fields;
        if (typeof missionId !== 'number')
          throw new CodedError('missionId required', 'BAD_REQUEST');
        if (!isRecord(fields)) throw new CodedError('fields required', 'BAD_REQUEST');
        this.requireDeps().missionService.updateMission(missionId, toStringRecord(fields));
        return;
      }
      case 'mission.setStatus': {
        if (!isRecord(args)) throw new CodedError('args must be an object', 'BAD_REQUEST');
        const missionId = args.missionId;
        const status = args.status;
        if (typeof missionId !== 'number')
          throw new CodedError('missionId required', 'BAD_REQUEST');
        if (typeof status !== 'string') throw new CodedError('status required', 'BAD_REQUEST');
        this.requireDeps().missionService.setStatus(missionId, status);
        return;
      }
      case 'mission.resetForRequeue': {
        if (typeof args !== 'number')
          throw new CodedError('mission ID must be a number', 'BAD_REQUEST');
        this.requireDeps().missionService.resetForRequeue(args);
        return;
      }
      case 'mission.abort': {
        if (typeof args !== 'number')
          throw new CodedError('mission ID must be a number', 'BAD_REQUEST');
        this.requireDeps().missionService.abortMission(args);
        return;
      }
      case 'mission.setReviewVerdict': {
        if (!isRecord(args)) throw new CodedError('args must be an object', 'BAD_REQUEST');
        const missionId = args.missionId;
        const verdict = args.verdict;
        const notes = args.notes;
        if (typeof missionId !== 'number')
          throw new CodedError('missionId required', 'BAD_REQUEST');
        if (typeof verdict !== 'string') throw new CodedError('verdict required', 'BAD_REQUEST');
        if (typeof notes !== 'string') throw new CodedError('notes required', 'BAD_REQUEST');
        this.requireDeps().missionService.setReviewVerdict(missionId, verdict, notes);
        return;
      }
      case 'mission.getDependencies': {
        if (typeof args !== 'number')
          throw new CodedError('mission ID must be a number', 'BAD_REQUEST');
        return this.requireDeps().missionService.getDependencies(args);
      }

      case 'crew.deploy': {
        if (!isRecord(args)) throw new CodedError('args must be an object', 'BAD_REQUEST');
        if (typeof args.sectorId !== 'string')
          throw new CodedError('sectorId required', 'BAD_REQUEST');
        if (typeof args.prompt !== 'string') throw new CodedError('prompt required', 'BAD_REQUEST');
        if (typeof args.missionId !== 'number')
          throw new CodedError('missionId required', 'BAD_REQUEST');
        return this.requireDeps().crewService.deployCrew({
          sectorId: args.sectorId,
          prompt: args.prompt,
          missionId: args.missionId,
          type: typeof args.type === 'string' ? args.type : undefined,
          prBranch: typeof args.prBranch === 'string' ? args.prBranch : undefined
        });
      }
      case 'crew.recall': {
        if (typeof args !== 'string')
          throw new CodedError('crew ID must be a string', 'BAD_REQUEST');
        this.requireDeps().crewService.recallCrew(args);
        return;
      }
      case 'crew.list': {
        if (args != null && !isRecord(args))
          throw new CodedError('filter must be an object', 'BAD_REQUEST');
        const filter = isRecord(args)
          ? {
              sectorId: typeof args.sectorId === 'string' ? args.sectorId : undefined
            }
          : undefined;
        return this.requireDeps().crewService.listCrew(filter);
      }
      case 'crew.status': {
        if (typeof args !== 'string')
          throw new CodedError('crew ID must be a string', 'BAD_REQUEST');
        return this.requireDeps().crewService.getCrewStatus(args);
      }
      case 'crew.observe': {
        if (typeof args !== 'string')
          throw new CodedError('crew ID must be a string', 'BAD_REQUEST');
        return this.requireDeps().crewService.observeCrew(args);
      }
      case 'crew.message': {
        if (!isRecord(args)) throw new CodedError('args must be an object', 'BAD_REQUEST');
        const crewId = args.crewId;
        const message = args.message;
        if (typeof crewId !== 'string') throw new CodedError('crewId required', 'BAD_REQUEST');
        if (typeof message !== 'string') throw new CodedError('message required', 'BAD_REQUEST');
        return this.requireDeps().crewService.messageCrew(crewId, message);
      }

      case 'comms.getUnread': {
        if (typeof args !== 'string')
          throw new CodedError('crew ID must be a string', 'BAD_REQUEST');
        return this.requireDeps().commsService.getUnread(args);
      }
      case 'comms.getUnreadByExecution': {
        if (typeof args !== 'string')
          throw new CodedError('execution ID must be a string', 'BAD_REQUEST');
        return this.requireDeps().commsService.getUnreadByExecution(args);
      }
      case 'comms.getRecent': {
        if (args != null && !isRecord(args))
          throw new CodedError('opts must be an object', 'BAD_REQUEST');
        const opts = isRecord(args)
          ? {
              crewId: typeof args.crewId === 'string' ? args.crewId : undefined,
              limit: typeof args.limit === 'number' ? args.limit : undefined,
              type: typeof args.type === 'string' ? args.type : undefined,
              from: typeof args.from === 'string' ? args.from : undefined,
              unread: typeof args.unread === 'boolean' ? args.unread : undefined
            }
          : undefined;
        return this.requireDeps().commsService.getRecent(opts);
      }
      case 'comms.markRead': {
        if (typeof args !== 'number')
          throw new CodedError('transmission ID must be a number', 'BAD_REQUEST');
        return this.requireDeps().commsService.markRead(args);
      }
      case 'comms.resolve': {
        if (!isRecord(args)) throw new CodedError('args must be an object', 'BAD_REQUEST');
        const id = args.id;
        const response = args.response;
        if (typeof id !== 'number') throw new CodedError('id required', 'BAD_REQUEST');
        if (typeof response !== 'string') throw new CodedError('response required', 'BAD_REQUEST');
        return this.requireDeps().commsService.resolve(id, response);
      }
      case 'comms.delete': {
        if (typeof args !== 'number')
          throw new CodedError('transmission ID must be a number', 'BAD_REQUEST');
        return this.requireDeps().commsService.delete(args);
      }
      case 'comms.markAllRead': {
        if (args != null && !isRecord(args))
          throw new CodedError('opts must be an object', 'BAD_REQUEST');
        const opts = isRecord(args)
          ? {
              crewId: typeof args.crewId === 'string' ? args.crewId : undefined
            }
          : undefined;
        return this.requireDeps().commsService.markAllRead(opts);
      }
      case 'comms.clear': {
        if (args != null && !isRecord(args))
          throw new CodedError('opts must be an object', 'BAD_REQUEST');
        const opts = isRecord(args)
          ? {
              crewId: typeof args.crewId === 'string' ? args.crewId : undefined
            }
          : undefined;
        return this.requireDeps().commsService.clear(opts);
      }
      case 'comms.getTransmission': {
        if (typeof args !== 'number')
          throw new CodedError('transmission ID must be a number', 'BAD_REQUEST');
        return this.requireDeps().commsService.getTransmission(args);
      }
      case 'comms.send': {
        if (!isRecord(args)) throw new CodedError('args must be an object', 'BAD_REQUEST');
        if (typeof args.from !== 'string') throw new CodedError('from required', 'BAD_REQUEST');
        if (typeof args.to !== 'string') throw new CodedError('to required', 'BAD_REQUEST');
        if (typeof args.type !== 'string') throw new CodedError('type required', 'BAD_REQUEST');
        if (typeof args.payload !== 'string')
          throw new CodedError('payload required', 'BAD_REQUEST');
        return this.requireDeps().commsService.send({
          from: args.from,
          to: args.to,
          type: args.type,
          payload: args.payload,
          threadId: typeof args.threadId === 'string' ? args.threadId : undefined,
          inReplyTo: typeof args.inReplyTo === 'number' ? args.inReplyTo : undefined,
          missionId: typeof args.missionId === 'number' ? args.missionId : undefined,
          executionId: typeof args.executionId === 'string' ? args.executionId : undefined
        });
      }

      case 'supplyRoute.list': {
        if (args != null && !isRecord(args))
          throw new CodedError('opts must be an object', 'BAD_REQUEST');
        const opts = isRecord(args)
          ? {
              sectorId: typeof args.sectorId === 'string' ? args.sectorId : undefined
            }
          : undefined;
        return this.requireDeps().supplyRouteService.listRoutes(opts);
      }
      case 'supplyRoute.add': {
        if (!isRecord(args)) throw new CodedError('args must be an object', 'BAD_REQUEST');
        if (typeof args.upstreamSectorId !== 'string')
          throw new CodedError('upstreamSectorId required', 'BAD_REQUEST');
        if (typeof args.downstreamSectorId !== 'string')
          throw new CodedError('downstreamSectorId required', 'BAD_REQUEST');
        return this.requireDeps().supplyRouteService.addRoute({
          upstreamSectorId: args.upstreamSectorId,
          downstreamSectorId: args.downstreamSectorId,
          relationship: typeof args.relationship === 'string' ? args.relationship : undefined
        });
      }
      case 'supplyRoute.remove': {
        if (typeof args !== 'number')
          throw new CodedError('route ID must be a number', 'BAD_REQUEST');
        this.requireDeps().supplyRouteService.removeRoute(args);
        return;
      }
      case 'supplyRoute.graph':
        return this.requireDeps().supplyRouteService.getGraph();

      case 'cargo.list': {
        if (args != null && !isRecord(args))
          throw new CodedError('filter must be an object', 'BAD_REQUEST');
        const filter = isRecord(args)
          ? {
              sectorId: typeof args.sectorId === 'string' ? args.sectorId : undefined,
              crewId: typeof args.crewId === 'string' ? args.crewId : undefined,
              type: typeof args.type === 'string' ? args.type : undefined,
              verified: typeof args.verified === 'boolean' ? args.verified : undefined
            }
          : undefined;
        return this.requireDeps().cargoService.listCargo(filter);
      }
      case 'cargo.get': {
        if (typeof args !== 'number')
          throw new CodedError('cargo ID must be a number', 'BAD_REQUEST');
        return this.requireDeps().cargoService.getCargo(args);
      }
      case 'cargo.produce': {
        if (!isRecord(args)) throw new CodedError('args must be an object', 'BAD_REQUEST');
        if (typeof args.sectorId !== 'string')
          throw new CodedError('sectorId required', 'BAD_REQUEST');
        return this.requireDeps().cargoService.produceCargo({
          sectorId: args.sectorId,
          crewId: typeof args.crewId === 'string' ? args.crewId : undefined,
          missionId: typeof args.missionId === 'number' ? args.missionId : undefined,
          type: typeof args.type === 'string' ? args.type : undefined,
          manifest: typeof args.manifest === 'string' ? args.manifest : undefined
        });
      }
      case 'cargo.getUndelivered': {
        if (typeof args !== 'string')
          throw new CodedError('sector ID must be a string', 'BAD_REQUEST');
        return this.requireDeps().cargoService.getUndelivered(args);
      }

      case 'retention.stats':
        return this.requireDeps().retentionService.getStats();
      case 'retention.cleanup':
        return this.requireDeps().retentionService.cleanup();
      case 'retention.vacuum': {
        this.requireDeps().retentionService.vacuum();
        return;
      }

      case 'shipsLog.query': {
        if (args != null && !isRecord(args))
          throw new CodedError('opts must be an object', 'BAD_REQUEST');
        const opts = isRecord(args)
          ? {
              crewId: typeof args.crewId === 'string' ? args.crewId : undefined,
              eventType: typeof args.eventType === 'string' ? args.eventType : undefined,
              since: typeof args.since === 'string' ? args.since : undefined,
              limit: typeof args.limit === 'number' ? args.limit : undefined
            }
          : {};
        return this.requireDeps().shipsLog.query(opts);
      }
      case 'shipsLog.combined': {
        const limit = isRecord(args) && typeof args.limit === 'number' ? args.limit : 200;
        return this.requireDeps()
          .starbaseDb.getDb()
          .prepare(
            `
            SELECT 'ships_log' as source, id, crew_id as actor, NULL as target, event_type as eventType, detail, created_at as timestamp
            FROM ships_log
            UNION ALL
            SELECT 'comms', id, from_crew, to_crew, type, payload, created_at
            FROM comms WHERE type NOT IN ('memo', 'hailing-memo')
            ORDER BY timestamp ASC LIMIT ?
          `
          )
          .all(limit);
      }

      case 'protocol.list':
        return this.requireDeps().protocolService.listProtocols();
      case 'protocol.getBySlug': {
        if (typeof args !== 'string') throw new CodedError('slug must be a string', 'BAD_REQUEST');
        return this.requireDeps().protocolService.getProtocolBySlug(args);
      }
      case 'protocol.listSteps': {
        if (typeof args !== 'string')
          throw new CodedError('protocol ID must be a string', 'BAD_REQUEST');
        return this.requireDeps().protocolService.listSteps(args);
      }
      case 'protocol.setEnabled': {
        if (!isRecord(args)) throw new CodedError('args must be an object', 'BAD_REQUEST');
        const slug = args.slug;
        const enabled = args.enabled;
        if (typeof slug !== 'string') throw new CodedError('slug required', 'BAD_REQUEST');
        if (typeof enabled !== 'boolean') throw new CodedError('enabled required', 'BAD_REQUEST');
        this.requireDeps().protocolService.setProtocolEnabled(slug, enabled);
        return;
      }
      case 'protocol.listExecutions': {
        if (args != null && typeof args !== 'string')
          throw new CodedError('status filter must be a string', 'BAD_REQUEST');
        return this.requireDeps().protocolService.listExecutions(args ?? undefined);
      }
      case 'protocol.getExecution': {
        if (typeof args !== 'string')
          throw new CodedError('execution ID must be a string', 'BAD_REQUEST');
        return this.requireDeps().protocolService.getExecution(args);
      }
      case 'protocol.advanceStep': {
        if (!isRecord(args)) throw new CodedError('args must be an object', 'BAD_REQUEST');
        const id = args.id;
        const step = args.step;
        if (typeof id !== 'string') throw new CodedError('id required', 'BAD_REQUEST');
        if (typeof step !== 'number') throw new CodedError('step required', 'BAD_REQUEST');
        const fromStep = typeof args.fromStep === 'number' ? args.fromStep : undefined;
        this.requireDeps().protocolService.advanceStep(id, step, fromStep);
        return;
      }
      case 'protocol.updateExecutionStatus': {
        if (!isRecord(args)) throw new CodedError('args must be an object', 'BAD_REQUEST');
        const id = args.id;
        const status = args.status;
        if (typeof id !== 'string') throw new CodedError('id required', 'BAD_REQUEST');
        if (typeof status !== 'string') throw new CodedError('status required', 'BAD_REQUEST');
        this.requireDeps().protocolService.updateExecutionStatus(id, status);
        return;
      }
      case 'protocol.updateExecutionContext': {
        if (!isRecord(args)) throw new CodedError('args must be an object', 'BAD_REQUEST');
        const id = args.id;
        const context = args.context;
        if (typeof id !== 'string') throw new CodedError('id required', 'BAD_REQUEST');
        if (typeof context !== 'string') throw new CodedError('context required', 'BAD_REQUEST');
        this.requireDeps().protocolService.updateExecutionContext(id, context);
        return;
      }

      case 'memo.list':
        return this.listMemos();
      case 'memo.read': {
        if (typeof args !== 'number')
          throw new CodedError('memo ID must be a number', 'BAD_REQUEST');
        this.markMemoRead(args);
        return;
      }
      case 'memo.dismiss': {
        if (typeof args !== 'number')
          throw new CodedError('memo ID must be a number', 'BAD_REQUEST');
        this.dismissMemo(args);
        return;
      }
      case 'memo.content': {
        if (typeof args !== 'string')
          throw new CodedError('file path must be a string', 'BAD_REQUEST');
        return this.getMemoContent(args);
      }

      case 'starbase.snapshot':
        return this.buildSnapshot();
      case 'starbase.logEntry':
        return this.getRecentLogEntry();

      default: {
        throw new CodedError(`Unknown runtime method: ${method}`, 'NOT_FOUND');
      }
    }
  }

  private async bootstrap(args: RuntimeBootstrapArgs): Promise<void> {
    if (this.deps) {
      trace('bootstrap skipped: already initialized');
      return;
    }

    this.setStatus({ state: 'starting' });
    this.workspacePath = args.workspacePath;
    trace('bootstrap start', {
      workspacePath: args.workspacePath,
      fleetBinPath: args.fleetBinPath,
      envKeys: Object.keys(args.env).length
    });

    let localStarbaseDb: StarbaseDB | null = null;
    let localLockfile: Lockfile | null = null;

    try {
      trace('bootstrap creating db');
      localStarbaseDb = new StarbaseDB(args.workspacePath);
      localStarbaseDb.open();
      trace('bootstrap db opened', {
        dbPath: localStarbaseDb.getDbPath(),
        starbaseId: localStarbaseDb.getStarbaseId()
      });

      const sectorService = new SectorService(
        localStarbaseDb.getDb(),
        args.workspacePath,
        this.eventBus
      );
      trace('bootstrap sectorService ready');
      const configService = new ConfigService(localStarbaseDb.getDb());
      trace('bootstrap configService ready');
      const supplyRouteService = new SupplyRouteService(localStarbaseDb.getDb());
      const cargoService = new CargoService(
        localStarbaseDb.getDb(),
        supplyRouteService,
        configService
      );
      const retentionService = new RetentionService(
        localStarbaseDb.getDb(),
        configService,
        localStarbaseDb.getDbPath()
      );
      const missionService = new MissionService(localStarbaseDb.getDb(), this.eventBus);
      trace('bootstrap mission/cargo/retention ready');

      const worktreeBasePath = join(dirname(localStarbaseDb.getDbPath()), 'worktrees');
      const worktreeManager = new WorktreeManager(worktreeBasePath);
      const maxConcurrent = configService.getNumber('max_concurrent_worktrees');
      worktreeManager.configure(localStarbaseDb.getDb(), maxConcurrent);
      trace('bootstrap worktreeManager ready', { worktreeBasePath, maxConcurrent });

      const crewService = new CrewService({
        db: localStarbaseDb.getDb(),
        starbaseId: localStarbaseDb.getStarbaseId(),
        sectorService,
        missionService,
        configService,
        worktreeManager,
        eventBus: this.eventBus,
        crewEnv: args.env
      });
      trace('bootstrap crewService ready');

      const commsService = new CommsService(localStarbaseDb.getDb(), this.eventBus);
      commsService.setRateLimit(configService.getNumber('comms_rate_limit_per_min'));
      trace('bootstrap commsService ready');

      const protocolService = new ProtocolService(localStarbaseDb.getDb());
      const firstOfficer = new FirstOfficer({
        db: localStarbaseDb.getDb(),
        configService,
        missionService,
        crewService,
        cargoService,
        eventBus: this.eventBus,
        starbaseId: localStarbaseDb.getStarbaseId(),
        crewEnv: args.env,
        fleetBinDir: args.fleetBinPath
      });
      trace('bootstrap firstOfficer ready');
      const navigator = new Navigator({
        db: localStarbaseDb.getDb(),
        configService,
        eventBus: this.eventBus,
        starbaseId: localStarbaseDb.getStarbaseId(),
        crewEnv: args.env,
        fleetBinDir: args.fleetBinPath
      });
      const shipsLog = new ShipsLog(localStarbaseDb.getDb());
      trace('bootstrap navigator/shipsLog ready');

      const basePath = dirname(localStarbaseDb.getDbPath());
      localLockfile = new Lockfile(basePath, localStarbaseDb.getStarbaseId());
      const lockResult = localLockfile.acquire();
      trace('bootstrap lock result', { lockResult, basePath });
      if (lockResult === 'acquired') {
        trace('bootstrap reconciliation start');
        await runReconciliation({
          db: localStarbaseDb.getDb(),
          starbaseId: localStarbaseDb.getStarbaseId(),
          worktreeBasePath
        });
        trace('bootstrap reconciliation finished');
        firstOfficer.reconcile();
        trace('bootstrap firstOfficer reconciled');
        navigator.reconcile();
        trace('bootstrap navigator reconciled');
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
        );
        trace('bootstrap memos dir ensured');
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
        lockfile: localLockfile
      };
      trace('bootstrap deps assigned');

      this.eventBus.on('starbase-changed', () => {
        this.scheduleSnapshot();
      });
      trace('bootstrap eventBus subscribed');
      this.scheduleSnapshot();
      trace('bootstrap initial snapshot scheduled');
      this.setStatus({ state: 'ready' });
      trace('bootstrap completed');
    } catch (error) {
      const err = toError(error);
      trace('bootstrap failed', { message: err.message, stack: err.stack });
      try {
        localLockfile?.release();
      } catch {
        // Ignore cleanup errors.
      }
      try {
        localStarbaseDb?.close();
      } catch {
        // Ignore cleanup errors.
      }
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus({ state: 'error', error: message });
      throw error;
    }
  }

  private requireDeps(): RuntimeDeps {
    if (!this.deps) {
      throw new Error('Starbase runtime not ready');
    }
    return this.deps;
  }

  private setStatus(status: StarbaseRuntimeStatus): void {
    this.status = status;
    this.emitEvent?.({ event: 'runtime.status', payload: status });
  }

  private scheduleSnapshot(): void {
    if (this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      const snapshot = this.buildSnapshot();
      this.emitEvent?.({ event: 'starbase.snapshot', payload: snapshot });
      const recentEntry = this.getRecentLogEntry();
      if (recentEntry) {
        this.emitEvent?.({ event: 'starbase.log-entry', payload: recentEntry });
      }
    }, 25);
  }

  private buildSnapshot(): unknown {
    const deps = this.requireDeps();
    const unreadComms = deps.commsService.getUnread('admiral');
    return {
      crew: deps.crewService.listCrew(),
      missions: deps.missionService.listMissions(),
      sectors: deps.sectorService.listVisibleSectors(),
      unreadCount: unreadComms.length,
      firstOfficer: {
        status: deps.firstOfficer.getStatus(),
        statusText: deps.firstOfficer.getStatusText(),
        unreadMemos: this.getUnreadMemoCount()
      },
      navigator: {
        status: deps.navigator.getStatus(),
        statusText: deps.navigator.getStatusText()
      }
    };
  }

  private getUnreadMemoCount(): number {
    return (
      this.requireDeps()
        .starbaseDb.getDb()
        .prepare<
          [],
          { cnt: number }
        >("SELECT COUNT(*) as cnt FROM comms WHERE type IN ('memo', 'hailing-memo') AND to_crew = 'admiral' AND read = 0")
        .get()?.cnt ?? 0
    );
  }

  private getRecentLogEntry(): unknown {
    return this.requireDeps()
      .starbaseDb.getDb()
      .prepare(
        `
        SELECT 'ships_log' as source, id, crew_id as actor, NULL as target, event_type as eventType, detail, created_at as timestamp FROM ships_log
        UNION ALL
        SELECT 'comms', id, from_crew, to_crew, type, payload, created_at FROM comms WHERE type NOT IN ('memo', 'hailing-memo')
        ORDER BY timestamp DESC LIMIT 1
      `
      )
      .get();
  }

  private getAdmiralBootstrapData(): {
    starbaseId: string;
    starbaseName: string;
    sectors: Array<{ name: string; root_path: string; stack?: string; base_branch?: string }>;
  } {
    const deps = this.requireDeps();
    return {
      starbaseId: deps.starbaseDb.getStarbaseId(),
      starbaseName:
        deps.configService.getOptionalString('starbase_name') ?? basename(this.workspacePath),
      sectors: deps.sectorService.listVisibleSectors().map((sector) => ({
        name: sector.name,
        root_path: sector.root_path,
        stack: sector.stack ?? undefined,
        base_branch: sector.base_branch
      }))
    };
  }

  private listMemos(): unknown[] {
    type MemoRow = {
      id: number;
      crew_id: string;
      mission_id: number | null;
      event_type: string;
      payload: string | null;
      read: number;
      created_at: string;
    };
    return this.requireDeps()
      .starbaseDb.getDb()
      .prepare<[], MemoRow>(
        "SELECT id, from_crew as crew_id, mission_id, type as event_type, payload, read, created_at FROM comms WHERE type IN ('memo', 'hailing-memo') ORDER BY created_at DESC"
      )
      .all()
      .map((r) => {
        try {
          const rawPayload: unknown = JSON.parse(r.payload ?? '{}');
          const payload =
            rawPayload != null && typeof rawPayload === 'object'
              ? (rawPayload as { filePath?: string; summary?: string })
              : {};
          return {
            ...r,
            file_path: payload.filePath ?? '',
            status: r.read ? 'read' : 'unread',
            summary: payload.summary ?? ''
          };
        } catch {
          return { ...r, file_path: '', status: r.read ? 'read' : 'unread', summary: '' };
        }
      });
  }

  private markMemoRead(id: number): void {
    this.requireDeps().starbaseDb.getDb().prepare('UPDATE comms SET read = 1 WHERE id = ?').run(id);
    this.eventBus.emit('starbase-changed', { type: 'starbase-changed' });
  }

  private dismissMemo(id: number): void {
    this.requireDeps().starbaseDb.getDb().prepare('DELETE FROM comms WHERE id = ?').run(id);
    this.eventBus.emit('starbase-changed', { type: 'starbase-changed' });
  }

  private async getMemoContent(filePath: string): Promise<string | null> {
    const allowedBase = join(process.env.HOME ?? '~', '.fleet', 'starbases');
    const resolved = resolve(filePath);
    if (!resolved.startsWith(allowedBase) || !resolved.includes('first-officer/memos/')) {
      return null;
    }
    try {
      return await readFile(resolved, 'utf-8');
    } catch {
      return null;
    }
  }
}
