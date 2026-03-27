import { createServer, type Server, type Socket } from 'node:net';
import { mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import type { CrewService } from './starbase/crew-service';
import type { MissionService } from './starbase/mission-service';
import type { CommsService } from './starbase/comms-service';
import type { SectorService } from './starbase/sector-service';
import type { CargoService } from './starbase/cargo-service';
import type { SupplyRouteService } from './starbase/supply-route-service';
import type { ConfigService } from './starbase/config-service';
import type { ShipsLog } from './starbase/ships-log';
import type { ProtocolService } from './starbase/protocol-service';
import type { ImageService } from './image-service';
import type { ImageProviderSettings } from '../shared/types';
import { CodedError } from './errors';

export interface ServiceRegistry {
  crewService: CrewService;
  missionService: MissionService;
  commsService: CommsService;
  sectorService: SectorService;
  cargoService: CargoService;
  supplyRouteService: SupplyRouteService;
  configService: ConfigService;
  shipsLog: ShipsLog;
  protocolService: ProtocolService;
}

/** Wrap every method's return type in Promise (idempotent for already-async methods). */
type Promisified<T> = {
  [M in keyof T]: T[M] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : T[M];
};

/**
 * Async subset of ServiceRegistry for use by socket runtime proxies.
 * Each service only exposes the methods the socket dispatch actually calls,
 * and all return types are wrapped in Promise.
 */
export type AsyncServiceRegistry = {
  crewService: Promisified<
    Pick<
      ServiceRegistry['crewService'],
      'listCrew' | 'deployCrew' | 'recallCrew' | 'getCrewStatus' | 'observeCrew' | 'messageCrew'
    >
  >;
  missionService: Promisified<
    Pick<
      ServiceRegistry['missionService'],
      | 'addMission'
      | 'listMissions'
      | 'getMission'
      | 'updateMission'
      | 'setStatus'
      | 'resetForRequeue'
      | 'abortMission'
      | 'setReviewVerdict'
      | 'getDependencies'
    >
  >;
  commsService: Promisified<
    Pick<
      ServiceRegistry['commsService'],
      | 'getUnreadByExecution'
      | 'getRecent'
      | 'markRead'
      | 'send'
      | 'delete'
      | 'clear'
      | 'markAllRead'
      | 'getTransmission'
      | 'getUnread'
      | 'resolve'
    >
  >;
  sectorService: Promisified<
    Pick<
      ServiceRegistry['sectorService'],
      'listVisibleSectors' | 'getSector' | 'addSector' | 'removeSector'
    >
  >;
  cargoService: Promisified<
    Pick<
      ServiceRegistry['cargoService'],
      'listCargo' | 'getCargo' | 'produceCargo' | 'getUndelivered'
    >
  >;
  supplyRouteService: Promisified<
    Pick<ServiceRegistry['supplyRouteService'], 'listRoutes' | 'addRoute' | 'removeRoute'>
  >;
  configService: Promisified<Pick<ServiceRegistry['configService'], 'get' | 'set'>>;
  shipsLog: Promisified<Pick<ServiceRegistry['shipsLog'], 'query'>>;
  protocolService: Promisified<
    Pick<
      ServiceRegistry['protocolService'],
      | 'listProtocols'
      | 'getProtocolBySlug'
      | 'listSteps'
      | 'setProtocolEnabled'
      | 'listExecutions'
      | 'getExecution'
      | 'advanceStep'
      | 'updateExecutionStatus'
      | 'updateExecutionContext'
    >
  >;
};

type Request = {
  id?: string;
  command: string;
  args?: Record<string, unknown>;
};

function toStr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function isRequest(v: unknown): v is Request {
  return (
    v != null &&
    typeof v === 'object' &&
    'command' in v &&
    typeof (v as { command?: unknown }).command === 'string'
  );
}

type SuccessResponse = {
  id?: string;
  ok: true;
  data: unknown;
};

type ErrorResponse = {
  id?: string;
  ok: false;
  error: string;
  code?: string;
};

type Response = SuccessResponse | ErrorResponse;

/** Strip ANSI escape codes from a string */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * SocketServer — Unix socket server for Fleet CLI command dispatch.
 *
 * Listens on a given socket path, accepts newline-delimited JSON requests,
 * routes commands to service methods, and returns JSON responses.
 * Emits 'state-change' events for mutating commands.
 */
export class SocketServer extends EventEmitter {
  private server: Server | null = null;
  private clients = new Set<Socket>();
  private startTime: number | null = null;

  constructor(
    private socketPath: string,
    private services: ServiceRegistry | AsyncServiceRegistry,
    private imageService?: ImageService
  ) {
    super();
  }

  async start(): Promise<void> {
    // Ensure parent directory exists
    mkdirSync(dirname(this.socketPath), { recursive: true });

    // Clean up stale socket file
    try {
      unlinkSync(this.socketPath);
    } catch {
      // Ignore — file may not exist
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        this.clients.add(socket);
        let buffer = '';

        socket.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) continue;
            void this.handleLine(socket, line);
          }
        });

        socket.on('close', () => {
          this.clients.delete(socket);
        });

        socket.on('error', () => {
          this.clients.delete(socket);
        });
      });

      this.server.on('close', () => {
        this.emit('server-close');
      });

      // Use once for startup error — detaches after first fire so it doesn't linger
      this.server.once('error', reject);

      this.server.listen(this.socketPath, () => {
        // Remove startup error handler and attach permanent one for post-startup errors
        this.server?.off('error', reject);
        this.server?.on('error', (err) => {
          this.emit('server-error', err);
        });
        this.startTime = Date.now();
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          try {
            unlinkSync(this.socketPath);
          } catch {
            // Ignore — file may already be gone
          }
          resolve();
        });
        this.server = null;
      } else {
        resolve();
      }
    });
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let req: Request;

    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRequest(parsed)) {
        this.sendResponse(socket, { ok: false, error: 'Invalid request' });
        return;
      }
      req = parsed;
    } catch {
      this.sendResponse(socket, { ok: false, error: 'Invalid JSON' });
      return;
    }

    try {
      const data = await this.dispatch(req.command, req.args ?? {});
      this.sendResponse(socket, { id: req.id, ok: true, data });
    } catch (err) {
      const coded =
        err instanceof CodedError
          ? err
          : err instanceof Error
            ? new CodedError(err.message, 'UNKNOWN')
            : new CodedError(String(err), 'UNKNOWN');
      this.sendResponse(socket, { id: req.id, ok: false, error: coded.message, code: coded.code });
    }
  }

  private sendResponse(socket: Socket, response: Response): void {
    if (!socket.destroyed) {
      socket.write(JSON.stringify(response) + '\n');
    }
  }

  private async dispatch(command: string, args: Record<string, unknown>): Promise<unknown> {
    const {
      sectorService,
      missionService,
      commsService,
      crewService,
      cargoService,
      supplyRouteService,
      configService,
      shipsLog,
      protocolService
    } = this.services;

    switch (command) {
      case 'ping':
        return { pong: true, uptime: this.startTime ? (Date.now() - this.startTime) / 1000 : 0 };

      // ── Sectors ──────────────────────────────────────────────────────────────
      case 'sector.list':
        return sectorService.listVisibleSectors();

      case 'sector.info': {
        const rawSectorId = args.id ?? args.sectorId ?? args.name;
        if (typeof rawSectorId !== 'string' || !rawSectorId) {
          throw new CodedError(
            'sector.info requires a sector ID.\n' + 'Usage: fleet sectors show <sector-id>',
            'BAD_REQUEST'
          );
        }
        const sector = await sectorService.getSector(rawSectorId);
        if (!sector) {
          throw new CodedError(`Sector not found: ${rawSectorId}`, 'NOT_FOUND');
        }
        return sector;
      }

      case 'sector.add': {
        const path = args.path ?? args.id;
        if (typeof path !== 'string' || !path) {
          throw new CodedError(
            'sector.add requires --path <path>.\n' +
              'Usage: fleet sectors add --path /path/to/repo',
            'BAD_REQUEST'
          );
        }
        return sectorService.addSector({
          path,
          name: typeof args.name === 'string' ? args.name : undefined,
          description: typeof args.description === 'string' ? args.description : undefined,
          baseBranch: typeof args.baseBranch === 'string' ? args.baseBranch : undefined,
          mergeStrategy: typeof args.mergeStrategy === 'string' ? args.mergeStrategy : undefined
        });
      }

      case 'sector.remove': {
        const rawSectorId = args.id ?? args.sectorId ?? args.name;
        if (typeof rawSectorId !== 'string' || !rawSectorId) {
          throw new CodedError(
            'sector.remove requires a sector ID.\n' + 'Usage: fleet sectors remove <sector-id>',
            'BAD_REQUEST'
          );
        }
        await sectorService.removeSector(rawSectorId);
        return null;
      }

      // ── Missions ─────────────────────────────────────────────────────────────
      case 'mission.create': {
        const rawSector = args.sector ?? args.sectorId;
        const sectorId = typeof rawSector === 'string' ? rawSector : undefined;
        const summary = typeof args.summary === 'string' ? args.summary : undefined;
        const prompt = typeof args.prompt === 'string' ? args.prompt : undefined;
        const type = typeof args.type === 'string' ? args.type : undefined;
        const VALID_MISSION_TYPES = ['code', 'research', 'review', 'architect', 'repair'];
        const rawPrBranch = args['pr-branch'];
        const prBranch = typeof rawPrBranch === 'string' ? rawPrBranch : undefined;
        const rawOriginalMissionId = args['original-mission-id'];
        const originalMissionId =
          rawOriginalMissionId != null ? Number(rawOriginalMissionId) : undefined;

        if (!sectorId) {
          throw new CodedError('mission.create requires --sector <id>', 'BAD_REQUEST');
        }
        if (!type) {
          throw new CodedError(
            'mission.create requires --type <code|research|review|architect|repair>.\n' +
              'Mission types:\n' +
              '  code      — produces git commits (code changes, bug fixes, features)\n' +
              '  research  — produces documentation artifacts (investigation, analysis, no git changes expected)\n' +
              '  review    — reviews a PR branch and produces a VERDICT (approved, changes-requested, escalated)\n' +
              '  architect — analyzes the codebase and produces an implementation blueprint (no git changes)\n' +
              '  repair    — fixes CI failures or review comments on an existing PR branch (requires --pr-branch)\n' +
              'Usage: fleet missions add --sector <id> --type <code|research|review|architect|repair> --summary "short title" --prompt "detailed instructions"',
            'BAD_REQUEST'
          );
        }
        if (!VALID_MISSION_TYPES.includes(type)) {
          throw new CodedError(
            `Invalid mission type "${type}". Must be "code", "research", "review", "architect", or "repair".\n` +
              'Mission types:\n' +
              '  code      — produces git commits (code changes, bug fixes, features)\n' +
              '  research  — produces documentation artifacts (investigation, analysis, no git changes expected)\n' +
              '  review    — reviews a PR branch and produces a VERDICT (approved, changes-requested, escalated)\n' +
              '  architect — analyzes the codebase and produces an implementation blueprint (no git changes)\n' +
              '  repair    — fixes CI failures or review comments on an existing PR branch (requires --pr-branch)',
            'BAD_REQUEST'
          );
        }
        if (type === 'repair' && !prBranch) {
          throw new CodedError(
            'mission.create with type "repair" requires --pr-branch <branch-name>.\n' +
              'Usage: fleet missions add --type repair --pr-branch <branch> --sector <id> --summary "..." --prompt "..."',
            'BAD_REQUEST'
          );
        }
        if (!prompt || prompt.trim().length === 0) {
          throw new CodedError(
            'mission.create requires a non-empty --prompt.\n' +
              'Usage: fleet missions add --sector <id> --type <code|research|review|architect|repair> --summary "short title" --prompt "detailed instructions"',
            'BAD_REQUEST'
          );
        }
        if (!summary || summary.trim().length === 0) {
          throw new CodedError(
            'mission.create requires a non-empty --summary.\n' +
              'Usage: fleet missions add --sector <id> --type <code|research|review|architect|repair> --summary "short title" --prompt "detailed instructions"',
            'BAD_REQUEST'
          );
        }

        // Parse --depends-on (may be a single string or array of strings)
        const rawDeps = args['depends-on'];
        const dependsOnMissionIds: number[] =
          rawDeps == null
            ? []
            : (Array.isArray(rawDeps) ? rawDeps : [rawDeps])
                .map(Number)
                .filter((n) => !isNaN(n) && n > 0);

        // Validate each dependency ID exists
        for (const depId of dependsOnMissionIds) {
          const dep = await missionService.getMission(depId);
          if (!dep) {
            throw new CodedError(
              `Cannot link dependency: mission ${depId} does not exist.`,
              'BAD_REQUEST'
            );
          }
        }

        const mission = await missionService.addMission({
          sectorId,
          summary,
          prompt,
          dependsOnMissionIds,
          type,
          prBranch,
          originalMissionId
        });

        const nudge =
          type === 'code' && dependsOnMissionIds.length === 0
            ? 'Tip: Consider attaching a research mission to provide context before this code mission runs. Use --depends-on <research-mission-id> to link one. Skip this for trivial changes.'
            : undefined;

        this.emit('state-change', 'mission:changed', { mission });
        return nudge
          ? { ...mission, dependencies: dependsOnMissionIds, nudge }
          : { ...mission, dependencies: dependsOnMissionIds };
      }

      case 'mission.list':
        return missionService.listMissions({
          sectorId: typeof args.sectorId === 'string' ? args.sectorId : undefined,
          status: typeof args.status === 'string' ? args.status : undefined
        });

      case 'mission.status': {
        const rawId = args.id ?? args.missionId;
        if (rawId == null) {
          throw new CodedError(
            'mission.status requires a mission ID.\n' + 'Usage: fleet missions show <mission-id>',
            'BAD_REQUEST'
          );
        }
        const mission = await missionService.getMission(Number(rawId));
        if (!mission) {
          throw new CodedError(`Mission not found: ${toStr(rawId)}`, 'NOT_FOUND');
        }
        return mission;
      }

      case 'mission.update': {
        const rawId = args.id ?? args.missionId;
        if (rawId == null) {
          throw new CodedError(
            'mission.update requires a mission ID.\n' +
              'Usage: fleet missions update <mission-id> --status <status> [--prompt "..."] [--summary "..."]',
            'BAD_REQUEST'
          );
        }
        const id = Number(rawId);
        const existing = await missionService.getMission(id);
        if (!existing) {
          throw new CodedError(`Mission not found: ${toStr(rawId)}`, 'NOT_FOUND');
        }

        // Update editable fields (prompt, summary, etc.)
        const fields: Record<string, string> = {};
        if (typeof args.prompt === 'string') fields.prompt = args.prompt;
        if (typeof args.summary === 'string') fields.summary = args.summary;
        if (Object.keys(fields).length > 0) {
          await missionService.updateMission(id, fields);
        }

        if (typeof args.status === 'string') {
          const newStatus = args.status;
          await missionService.setStatus(id, newStatus);
          // When re-queuing a mission, reset crew assignment so autoDeployNext() picks it up
          if (newStatus === 'queued') {
            await missionService.resetForRequeue(id);
          }
          this.emit('state-change', 'mission:changed', { id });
        }
        return missionService.getMission(id);
      }

      case 'mission.cancel': {
        const rawId = args.id ?? args.missionId;
        if (rawId == null) {
          throw new CodedError(
            'mission.cancel requires a mission ID.\n' + 'Usage: fleet missions cancel <mission-id>',
            'BAD_REQUEST'
          );
        }
        const id = Number(rawId);
        const existing = await missionService.getMission(id);
        if (!existing) {
          throw new CodedError(`Mission not found: ${toStr(rawId)}`, 'NOT_FOUND');
        }
        await missionService.abortMission(id);
        this.emit('state-change', 'mission:changed', { id });
        return null;
      }

      case 'mission.verdict': {
        const rawId = args.id ?? args.missionId;
        if (rawId == null) {
          throw new CodedError(
            'mission.verdict requires a mission ID.\n' +
              'Usage: fleet missions verdict <mission-id> --verdict <approved|changes-requested|escalated> --notes "..."',
            'BAD_REQUEST'
          );
        }
        const id = typeof rawId === 'string' ? parseInt(rawId, 10) : Number(rawId);
        const verdict = typeof args.verdict === 'string' ? args.verdict : '';
        const notes = typeof args.notes === 'string' ? args.notes : '';

        if (!verdict || !['approved', 'changes-requested', 'escalated'].includes(verdict)) {
          throw new CodedError(
            'Invalid verdict. Must be one of: approved, changes-requested, escalated',
            'BAD_REQUEST'
          );
        }

        await missionService.setReviewVerdict(id, verdict, notes);
        if (verdict === 'approved') {
          await missionService.setStatus(id, 'completed');
          const mission = await missionService.getMission(id);
          await commsService.send({
            from: 'admiral',
            to: 'admiral',
            type: 'mission_approved',
            payload: JSON.stringify({
              missionId: id,
              summary: mission?.summary ?? '',
              pr_branch: mission?.pr_branch ?? null
            })
          });
        } else {
          await missionService.setStatus(id, verdict);
        }
        this.emit('state-change', 'mission:changed', { id });
        return missionService.getMission(id);
      }

      // ── Crew ─────────────────────────────────────────────────────────────────
      case 'crew.list':
        return crewService.listCrew();

      case 'crew.deploy': {
        const rawMission = args.mission ?? args.missionId;
        if (rawMission == null) {
          throw new CodedError(
            'crew.deploy requires --mission <id>. Create a mission first with: fleet missions add --sector <id> --summary "..." --prompt "..."',
            'BAD_REQUEST'
          );
        }

        const missionId = Number(rawMission);
        if (Number.isNaN(missionId) || missionId <= 0) {
          throw new CodedError(
            `Invalid mission ID: "${toStr(rawMission)}". --mission must be a numeric mission ID.\n` +
              'Create a mission first:\n' +
              '  fleet missions add --sector <id> --summary "..." --prompt "..."\n' +
              'Then deploy:\n' +
              '  fleet crew deploy --sector <id> --mission <mission-id>',
            'BAD_REQUEST'
          );
        }

        const mission = await missionService.getMission(missionId);
        if (!mission) {
          throw new CodedError(`Mission not found: ${missionId}`, 'NOT_FOUND');
        }

        const prompt = mission.prompt;
        if (!prompt || prompt.trim().length === 0) {
          throw new CodedError(
            `Mission ${missionId} has an empty prompt. Update it first:\n` +
              `  fleet missions update ${missionId} --prompt "..."`,
            'BAD_REQUEST'
          );
        }

        // Check all dependencies via junction table
        const allDeps = await missionService.getDependencies(missionId);
        const blockedDeps = allDeps.filter(
          (dep) =>
            ![
              'completed',
              'done',
              'failed',
              'aborted',
              'failed-verification',
              'escalated',
              'approved'
            ].includes(dep.status)
        );
        if (blockedDeps.length > 0) {
          const depList = blockedDeps.map((d) => `#${d.id} (${d.status})`).join(', ');
          throw new Error(
            `Cannot deploy: mission ${missionId} depends on mission(s) ${depList} which have not reached a terminal state.`
          );
        }

        // Guard: reject if mission already has a crew assigned or is already active
        if (
          mission.crew_id != null ||
          mission.status === 'active' ||
          mission.status === 'deploying'
        ) {
          throw new CodedError(
            `Mission ${missionId} already has a crew assigned (status: ${mission.status}). ` +
              'Recall the existing crew before deploying a new one.',
            'CONFLICT'
          );
        }

        const deploySectorId = args.sector ?? args.sectorId ?? mission.sector_id;
        if (typeof deploySectorId !== 'string') {
          throw new CodedError('crew.deploy requires a valid sector ID', 'BAD_REQUEST');
        }
        const result = await crewService.deployCrew({
          sectorId: deploySectorId,
          prompt,
          missionId,
          type: typeof args.type === 'string' ? args.type : undefined,
          prBranch: mission.pr_branch ?? undefined
        });
        this.emit('state-change', 'crew:changed', result);
        return result;
      }

      case 'crew.recall': {
        const rawCrewId = args.id ?? args.crewId;
        if (typeof rawCrewId !== 'string' || !rawCrewId) {
          throw new CodedError(
            'crew.recall requires a crew ID.\n' +
              'Usage: fleet crew recall <crew-id>\n' +
              'List crew: fleet crew list',
            'BAD_REQUEST'
          );
        }
        await crewService.recallCrew(rawCrewId);
        this.emit('state-change', 'crew:changed', { crewId: rawCrewId, status: 'recalled' });
        return null;
      }

      case 'crew.info': {
        const rawCrewId = args.id ?? args.crewId;
        if (typeof rawCrewId !== 'string' || !rawCrewId) {
          throw new CodedError(
            'crew.info requires a crew ID.\n' +
              'Usage: fleet crew info <crew-id>\n' +
              'List crew: fleet crew list',
            'BAD_REQUEST'
          );
        }
        const info = await crewService.getCrewStatus(rawCrewId);
        if (!info) {
          throw new CodedError(`Crew not found: ${rawCrewId}`, 'NOT_FOUND');
        }
        return info;
      }

      case 'crew.observe': {
        const rawCrewId = args.id ?? args.crewId;
        if (typeof rawCrewId !== 'string' || !rawCrewId) {
          throw new CodedError(
            'crew.observe requires a crew ID.\n' +
              'Usage: fleet crew observe <crew-id>\n' +
              'List crew: fleet crew list',
            'BAD_REQUEST'
          );
        }
        const raw = await crewService.observeCrew(rawCrewId);
        return stripAnsi(raw);
      }

      case 'crew.message': {
        const rawCrewId = args.id ?? args.crewId;
        const rawMessage = args.message ?? args.text;
        const crewId = typeof rawCrewId === 'string' ? rawCrewId : undefined;
        const message = typeof rawMessage === 'string' ? rawMessage : undefined;
        if (!crewId) {
          throw new CodedError(
            'crew.message requires a crew ID.\n' +
              'Usage: fleet crew message <crew-id> --message "..."\n' +
              'List crew: fleet crew list',
            'BAD_REQUEST'
          );
        }
        if (!message || message.trim().length === 0) {
          throw new CodedError(
            'crew.message requires a non-empty --message.\n' +
              'Usage: fleet crew message <crew-id> --message "your message here"',
            'BAD_REQUEST'
          );
        }
        const sent = await crewService.messageCrew(crewId, message);
        if (!sent) {
          throw new CodedError(
            `Crew not active: ${crewId}. Only active crew can receive messages.\n` +
              'Check crew status: fleet crew info ' +
              crewId,
            'NOT_FOUND'
          );
        }
        this.emit('state-change', 'crew:changed', { crewId });
        return { sent: true };
      }

      // ── Comms ─────────────────────────────────────────────────────────────────
      case 'comms.list': {
        // if executionId arg provided, use getUnreadByExecution
        if (typeof args.execution === 'string' && args.execution) {
          return commsService.getUnreadByExecution(args.execution);
        }
        // fall through to existing getRecent logic
        const rows = commsService.getRecent({
          crewId: typeof args.crewId === 'string' ? args.crewId : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          type: typeof args.type === 'string' ? args.type : undefined,
          from: typeof args.from === 'string' ? args.from : undefined,
          unread: typeof args.unread === 'boolean' ? args.unread : undefined
        });
        return rows;
      }

      case 'comms.read': {
        const rawId = args.id ?? args.transmissionId;
        if (rawId == null) {
          throw new CodedError(
            'comms.read requires a transmission ID.\n' +
              'Usage: fleet comms read <transmission-id>\n' +
              'List transmissions: fleet comms inbox',
            'BAD_REQUEST'
          );
        }
        const transmissionId = Number(rawId);
        const changed = await commsService.markRead(transmissionId);
        if (changed) this.emit('state-change', 'comms:changed', { id: transmissionId });
        return null;
      }

      case 'comms.send': {
        const to = typeof args.to === 'string' ? args.to : undefined;
        if (!to) {
          throw new CodedError(
            'comms.send requires --to <crew-id|admiral>.\n' +
              'Usage: fleet comms send --to <crew-id> --message "..."',
            'BAD_REQUEST'
          );
        }
        const rawPayload = args.message ?? args.payload;
        const payload = typeof rawPayload === 'string' ? rawPayload : undefined;
        if (!payload || payload.trim().length === 0) {
          throw new CodedError(
            'comms.send requires a non-empty --message.\n' +
              'Usage: fleet comms send --to <crew-id> --message "your message"',
            'BAD_REQUEST'
          );
        }
        const from = typeof args.from === 'string' ? args.from : 'admiral';
        const msgType = typeof args.type === 'string' ? args.type : 'directive';
        const id = await commsService.send({
          from,
          to,
          type: msgType,
          payload
        });
        this.emit('state-change', 'comms:changed', { id });

        // Auto-inject into active crew's Claude Code process if target is a live crew
        let injected = false;
        if (to !== 'admiral') {
          injected = await crewService.messageCrew(to, payload);
        }

        return { id, injected };
      }

      case 'comms.delete': {
        const rawId = args.id ?? args.transmissionId;
        if (rawId == null) {
          throw new CodedError(
            'comms.delete requires a transmission ID.\n' +
              'Usage: fleet comms delete --id <transmission-id>\n' +
              'List transmissions: fleet comms inbox',
            'BAD_REQUEST'
          );
        }
        const transmissionId = Number(rawId);
        const deleted = await commsService.delete(transmissionId);
        if (deleted) this.emit('state-change', 'comms:changed', {});
        return { deleted };
      }

      case 'comms.clear': {
        const count = await commsService.clear(
          typeof args.crew === 'string' ? { crewId: args.crew } : undefined
        );
        if (count > 0) this.emit('state-change', 'comms:changed', {});
        return { deleted: count };
      }

      case 'comms.read-all': {
        const count = await commsService.markAllRead(
          typeof args.crew === 'string' ? { crewId: args.crew } : undefined
        );
        if (count > 0) this.emit('state-change', 'comms:changed', {});
        return { marked: count };
      }

      case 'comms.info': {
        const rawId = args.id ?? args.transmissionId;
        if (rawId == null) {
          throw new CodedError(
            'comms.info requires a transmission ID.\n' +
              'Usage: fleet comms show <transmission-id>\n' +
              'List transmissions: fleet comms inbox',
            'BAD_REQUEST'
          );
        }
        const transmissionId = Number(rawId);
        const transmission = await commsService.getTransmission(transmissionId);
        if (!transmission) {
          throw new CodedError(`Transmission not found: ${transmissionId}`, 'NOT_FOUND');
        }
        return transmission;
      }

      case 'comms.check': {
        const unread = await commsService.getUnread('admiral');
        return { unread: unread.length };
      }

      // ── Cargo ─────────────────────────────────────────────────────────────────
      case 'cargo.list':
        return cargoService.listCargo({
          sectorId: typeof args.sectorId === 'string' ? args.sectorId : undefined,
          crewId: typeof args.crewId === 'string' ? args.crewId : undefined,
          type: typeof args.type === 'string' ? args.type : undefined,
          verified: typeof args.verified === 'boolean' ? args.verified : undefined
        });

      case 'cargo.inspect': {
        const rawId = args.cargoId ?? args.id;
        if (rawId == null) {
          throw new CodedError(
            'cargo.inspect requires a cargo ID.\n' +
              'Usage: fleet cargo show <cargo-id>\n' +
              'List cargo: fleet cargo list',
            'BAD_REQUEST'
          );
        }
        const cargo = await cargoService.getCargo(Number(rawId));
        if (!cargo) {
          throw new CodedError(`Cargo not found: ${toStr(rawId)}`, 'NOT_FOUND');
        }
        return cargo;
      }

      case 'cargo.produce': {
        const rawCargoSector = args.sector ?? args.sectorId;
        const cargoSectorId = typeof rawCargoSector === 'string' ? rawCargoSector : undefined;
        const cargoType = typeof args.type === 'string' ? args.type : undefined;
        const cargoPath = typeof args.path === 'string' ? args.path : undefined;
        if (!cargoSectorId || !cargoType || !cargoPath) {
          throw new CodedError(
            'cargo.produce requires --sector <sector-id>, --type <type>, and --path <path>.\n' +
              'Usage: fleet cargo produce --sector <sector-id> --type <type> --path <path>',
            'BAD_REQUEST'
          );
        }
        return cargoService.produceCargo({
          sectorId: cargoSectorId,
          type: cargoType,
          manifest: cargoPath
        });
      }

      case 'cargo.pending': {
        const rawPendingSector = args.sector ?? args.sectorId;
        if (typeof rawPendingSector !== 'string' || !rawPendingSector) {
          throw new CodedError(
            'cargo.pending requires --sector <sector-id>.\n' +
              'Usage: fleet cargo pending --sector <sector-id>',
            'BAD_REQUEST'
          );
        }
        return cargoService.getUndelivered(rawPendingSector);
      }

      // ── Supply Routes ─────────────────────────────────────────────────────────
      case 'supply-route.list':
        return supplyRouteService.listRoutes();

      case 'supply-route.add': {
        const rawFrom = args.from ?? args.fromSector;
        const rawTo = args.to ?? args.toSector;
        const fromSector = typeof rawFrom === 'string' ? rawFrom : undefined;
        const toSector = typeof rawTo === 'string' ? rawTo : undefined;
        if (!fromSector || !toSector) {
          throw new CodedError(
            'supply-route.add requires --from <sector-id> and --to <sector-id>.\n' +
              'Usage: fleet supply-route add --from <sector-id> --to <sector-id>',
            'BAD_REQUEST'
          );
        }
        return supplyRouteService.addRoute({
          upstreamSectorId: fromSector,
          downstreamSectorId: toSector,
          relationship: typeof args.relationship === 'string' ? args.relationship : undefined
        });
      }

      case 'supply-route.remove': {
        const rawId = args.routeId ?? args.id;
        if (rawId == null) {
          throw new CodedError(
            'supply-route.remove requires a route ID.\n' +
              'Usage: fleet supply-route remove <route-id>\n' +
              'List routes: fleet supply-route list',
            'BAD_REQUEST'
          );
        }
        await supplyRouteService.removeRoute(Number(rawId));
        return null;
      }

      // ── Config ────────────────────────────────────────────────────────────────
      case 'config.get': {
        if (typeof args.key !== 'string' || !args.key) {
          throw new CodedError(
            'config.get requires --key <key>.\n' + 'Usage: fleet config get --key <config-key>',
            'BAD_REQUEST'
          );
        }
        return configService.get(args.key);
      }

      case 'config.set': {
        if (typeof args.key !== 'string' || !args.key) {
          throw new CodedError(
            'config.set requires --key <key> and --value <value>.\n' +
              'Usage: fleet config set --key <config-key> --value <value>',
            'BAD_REQUEST'
          );
        }
        if (args.value === undefined) {
          throw new CodedError(
            'config.set requires --value <value>.\n' +
              'Usage: fleet config set --key <config-key> --value <value>',
            'BAD_REQUEST'
          );
        }
        await configService.set(args.key, args.value);
        return null;
      }

      // ── Log ───────────────────────────────────────────────────────────────────
      case 'log.show': {
        const limit = typeof args.limit === 'number' ? args.limit : 50;
        const crewFilter = typeof args.crew === 'string' ? args.crew : undefined;
        return shipsLog.query({ crewId: crewFilter, limit });
      }

      // ── File Open ──────────────────────────────────────────────────────────────
      case 'file.open': {
        if (!Array.isArray(args.files) || args.files.length === 0) {
          throw new CodedError('file.open requires a non-empty files array', 'BAD_REQUEST');
        }
        const files = args.files.filter(
          (f): f is Record<string, unknown> => f != null && typeof f === 'object'
        );
        const payload = {
          files: files.map((f) => {
            const filePath = typeof f.path === 'string' ? f.path : '';
            const paneType: 'file' | 'image' = f.paneType === 'image' ? 'image' : 'file';
            return {
              path: filePath,
              paneType,
              label: filePath.split('/').pop() ?? filePath
            };
          })
        };
        this.emit('file-open', payload);
        return { fileCount: files.length };
      }

      // ── Protocols ─────────────────────────────────────────────────────────────
      case 'protocol.list':
        return protocolService.listProtocols();

      case 'protocol.show': {
        const rawSlug = args.id ?? args.slug;
        if (typeof rawSlug !== 'string')
          throw new CodedError('protocol.show requires a slug', 'BAD_REQUEST');
        const p = await protocolService.getProtocolBySlug(rawSlug);
        if (!p) {
          throw new CodedError(`Protocol not found: ${rawSlug}`, 'NOT_FOUND');
        }
        const steps = await protocolService.listSteps(p.id);
        return { ...p, steps };
      }

      case 'protocol.enable': {
        const rawSlug = args.id ?? args.slug;
        if (typeof rawSlug !== 'string')
          throw new CodedError('protocol.enable requires a slug', 'BAD_REQUEST');
        await protocolService.setProtocolEnabled(rawSlug, true);
        return { slug: rawSlug, enabled: true };
      }

      case 'protocol.disable': {
        const rawSlug = args.id ?? args.slug;
        if (typeof rawSlug !== 'string')
          throw new CodedError('protocol.disable requires a slug', 'BAD_REQUEST');
        await protocolService.setProtocolEnabled(rawSlug, false);
        return { slug: rawSlug, enabled: false };
      }

      // ── Executions ────────────────────────────────────────────────────────────
      case 'execution.list':
        return protocolService.listExecutions(
          typeof args.status === 'string' ? args.status : undefined
        );

      case 'execution.show': {
        if (typeof args.id !== 'string')
          throw new CodedError('execution.show requires an execution ID', 'BAD_REQUEST');
        const exec = await protocolService.getExecution(args.id);
        if (!exec) {
          throw new CodedError(`Execution not found: ${args.id}`, 'NOT_FOUND');
        }
        return exec;
      }

      case 'execution.update': {
        if (typeof args.id !== 'string')
          throw new CodedError('execution.update requires an execution ID', 'BAD_REQUEST');
        const execId = args.id;
        const exec = await protocolService.getExecution(execId);
        if (!exec) {
          throw new CodedError(`Execution not found: ${execId}`, 'NOT_FOUND');
        }
        if (args.step !== undefined) {
          const fromStep = args.from !== undefined ? Number(args.from) : undefined;
          await protocolService.advanceStep(execId, Number(args.step), fromStep);
        }
        if (typeof args.status === 'string') {
          await protocolService.updateExecutionStatus(execId, args.status);
        }
        if (typeof args.context === 'string') {
          await protocolService.updateExecutionContext(execId, args.context);
        }
        return protocolService.getExecution(execId);
      }

      // ── Images ──────────────────────────────────────────────────────────────
      case 'image.generate': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        const prompt = typeof args.prompt === 'string' ? args.prompt : undefined;
        if (!prompt) throw new CodedError('image.generate requires a prompt', 'BAD_REQUEST');
        const result = this.imageService.generate({
          prompt,
          provider: typeof args.provider === 'string' ? args.provider : undefined,
          model: typeof args.model === 'string' ? args.model : undefined,
          resolution: typeof args.resolution === 'string' ? args.resolution : undefined,
          aspectRatio:
            typeof args.aspectRatio === 'string'
              ? args.aspectRatio
              : typeof args['aspect-ratio'] === 'string'
                ? String(args['aspect-ratio'])
                : undefined,
          outputFormat: typeof args.format === 'string' ? args.format : undefined,
          numImages: typeof args['num-images'] === 'string' ? Number(args['num-images']) : undefined
        });
        this.emit('state-change', 'image:changed', { id: result.id });
        return result;
      }

      case 'image.edit': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        const editPrompt = typeof args.prompt === 'string' ? args.prompt : undefined;
        if (!editPrompt) throw new CodedError('image.edit requires a prompt', 'BAD_REQUEST');
        const rawImages = args.images;
        const images = Array.isArray(rawImages)
          ? rawImages.filter((x): x is string => typeof x === 'string')
          : typeof rawImages === 'string'
            ? [rawImages]
            : [];
        if (images.length === 0)
          throw new CodedError('image.edit requires --images', 'BAD_REQUEST');
        const editResult = this.imageService.edit({
          prompt: editPrompt,
          images,
          provider: typeof args.provider === 'string' ? args.provider : undefined,
          model: typeof args.model === 'string' ? args.model : undefined,
          resolution: typeof args.resolution === 'string' ? args.resolution : undefined,
          aspectRatio:
            typeof args.aspectRatio === 'string'
              ? args.aspectRatio
              : typeof args['aspect-ratio'] === 'string'
                ? String(args['aspect-ratio'])
                : undefined,
          outputFormat: typeof args.format === 'string' ? args.format : undefined,
          numImages: typeof args['num-images'] === 'string' ? Number(args['num-images']) : undefined
        });
        this.emit('state-change', 'image:changed', { id: editResult.id });
        return editResult;
      }

      case 'image.status': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        const statusId = typeof args.id === 'string' ? args.id : undefined;
        if (!statusId) throw new CodedError('image.status requires an id', 'BAD_REQUEST');
        const meta = this.imageService.getStatus(statusId);
        if (!meta) throw new CodedError(`Generation not found: ${statusId}`, 'NOT_FOUND');
        return meta;
      }

      case 'image.list': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        return this.imageService.list();
      }

      case 'image.retry': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        const retryId = typeof args.id === 'string' ? args.id : undefined;
        if (!retryId) throw new CodedError('image.retry requires an id', 'BAD_REQUEST');
        const retryResult = this.imageService.retry(retryId);
        this.emit('state-change', 'image:changed', { id: retryResult.id });
        return retryResult;
      }

      case 'image.delete': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        const deleteId = typeof args.id === 'string' ? args.id : undefined;
        if (!deleteId) throw new CodedError('image.delete requires an id', 'BAD_REQUEST');
        this.imageService.delete(deleteId);
        this.emit('state-change', 'image:changed', { id: deleteId });
        return { deleted: true };
      }

      case 'image.config.get': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        const settings = this.imageService.getSettings();
        const redacted = { ...settings, providers: { ...settings.providers } };
        for (const [key, val] of Object.entries(redacted.providers)) {
          redacted.providers[key] = {
            ...val,
            apiKey: val.apiKey ? `${val.apiKey.slice(0, 4)}***` : ''
          };
        }
        return redacted;
      }

      case 'image.config.set': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        const providerId = typeof args.provider === 'string' ? args.provider : undefined;
        const providerKey = providerId ?? this.imageService.getSettings().defaultProvider;
        const providerUpdate: Partial<ImageProviderSettings> = {};
        if (typeof args['api-key'] === 'string') providerUpdate.apiKey = args['api-key'];
        if (typeof args['default-model'] === 'string')
          providerUpdate.defaultModel = args['default-model'];
        if (typeof args['default-resolution'] === 'string')
          providerUpdate.defaultResolution = args['default-resolution'];
        if (typeof args['default-output-format'] === 'string')
          providerUpdate.defaultOutputFormat = args['default-output-format'];
        if (typeof args['default-aspect-ratio'] === 'string')
          providerUpdate.defaultAspectRatio = args['default-aspect-ratio'];
        if (Object.keys(providerUpdate).length > 0) {
          this.imageService.updateSettings({ providers: { [providerKey]: providerUpdate } });
        }
        this.emit('state-change', 'image:changed', {});
        return { updated: true };
      }

      default: {
        throw new CodedError(`Unknown command: ${command}`, 'NOT_FOUND');
      }
    }
  }
}
