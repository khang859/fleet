import { createServer, Server, Socket } from 'node:net';
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

type Request = {
  id?: string;
  command: string;
  args: Record<string, unknown>;
};

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
    private services: ServiceRegistry,
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
            this.handleLine(socket, line);
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
        this.server!.off('error', reject);
        this.server!.on('error', (err) => {
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
      req = JSON.parse(line);
    } catch {
      this.sendResponse(socket, { ok: false, error: 'Invalid JSON' });
      return;
    }

    try {
      const data = await this.dispatch(req.command, req.args ?? {});
      this.sendResponse(socket, { id: req.id, ok: true, data });
    } catch (err) {
      const coded = err instanceof CodedError ? err : (err instanceof Error ? new CodedError(err.message, 'UNKNOWN') : new CodedError(String(err), 'UNKNOWN'));
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
      protocolService,
    } = this.services;

    switch (command) {
      case 'ping':
        return { pong: true, uptime: this.startTime ? (Date.now() - this.startTime) / 1000 : 0 };

      // ── Sectors ──────────────────────────────────────────────────────────────
      case 'sector.list':
        return sectorService.listVisibleSectors();

      case 'sector.info': {
        const sectorId = (args.id ?? args.sectorId ?? args.name) as string | undefined;
        if (!sectorId) {
          throw new CodedError('sector.info requires a sector ID.\n' +
            'Usage: fleet sectors show <sector-id>', 'BAD_REQUEST')
        }
        const sector = await sectorService.getSector(sectorId);
        if (!sector) {
          throw new CodedError(`Sector not found: ${sectorId}`, 'NOT_FOUND')
        }
        return sector;
      }

      case 'sector.add': {
        const path = (args.path ?? args.id) as string | undefined;
        if (!path) {
          throw new CodedError('sector.add requires --path <path>.\n' +
            'Usage: fleet sectors add --path /path/to/repo', 'BAD_REQUEST')
        }
        return sectorService.addSector(args as Parameters<SectorService['addSector']>[0]);
      }

      case 'sector.remove': {
        const sectorId = (args.id ?? args.sectorId ?? args.name) as string | undefined;
        if (!sectorId) {
          throw new CodedError('sector.remove requires a sector ID.\n' +
            'Usage: fleet sectors remove <sector-id>', 'BAD_REQUEST')
        }
        sectorService.removeSector(sectorId);
        return null;
      }

      // ── Missions ─────────────────────────────────────────────────────────────
      case 'mission.create': {
        const sectorId = (args.sector ?? args.sectorId) as string;
        const summary = args.summary as string | undefined;
        const prompt = args.prompt as string | undefined;
        const type = args.type as string | undefined;
        const VALID_MISSION_TYPES = ['code', 'research', 'review'];
        const prBranch = args['pr-branch'] as string | undefined;

        if (!sectorId) {
          throw new CodedError('mission.create requires --sector <id>', 'BAD_REQUEST')
        }
        if (!type) {
          throw new CodedError('mission.create requires --type <code|research|review>.\n' +
            'Mission types:\n' +
            '  code     — produces git commits (code changes, bug fixes, features)\n' +
            '  research — produces documentation artifacts (investigation, analysis, no git changes expected)\n' +
            '  review   — reviews a PR branch and produces a VERDICT (approved, changes-requested, escalated)\n' +
            'Usage: fleet missions add --sector <id> --type <code|research|review> --summary "short title" --prompt "detailed instructions"', 'BAD_REQUEST')
        }
        if (!VALID_MISSION_TYPES.includes(type)) {
          throw new CodedError(`Invalid mission type "${type}". Must be "code", "research", or "review".\n` +
            'Mission types:\n' +
            '  code     — produces git commits (code changes, bug fixes, features)\n' +
            '  research — produces documentation artifacts (investigation, analysis, no git changes expected)\n' +
            '  review   — reviews a PR branch and produces a VERDICT (approved, changes-requested, escalated)', 'BAD_REQUEST')
        }
        if (!prompt || prompt.trim().length === 0) {
          throw new CodedError('mission.create requires a non-empty --prompt.\n' +
            'Usage: fleet missions add --sector <id> --type <code|research|review> --summary "short title" --prompt "detailed instructions"', 'BAD_REQUEST')
        }
        if (!summary || summary.trim().length === 0) {
          throw new CodedError('mission.create requires a non-empty --summary.\n' +
            'Usage: fleet missions add --sector <id> --type <code|research|review> --summary "short title" --prompt "detailed instructions"', 'BAD_REQUEST')
        }

        // Parse --depends-on (may be a single string or array of strings)
        const rawDeps = args['depends-on']
        const dependsOnMissionIds: number[] = rawDeps == null
          ? []
          : (Array.isArray(rawDeps) ? rawDeps : [rawDeps])
              .map(Number)
              .filter(n => !isNaN(n) && n > 0)

        // Validate each dependency ID exists
        for (const depId of dependsOnMissionIds) {
          const dep = await missionService.getMission(depId)
          if (!dep) {
            throw new CodedError(`Cannot link dependency: mission ${depId} does not exist.`, 'BAD_REQUEST')
          }
        }

        const mission = await missionService.addMission({
          sectorId,
          summary,
          prompt,
          dependsOnMissionIds,
          type,
          prBranch,
        });

        const nudge = type === 'code' && dependsOnMissionIds.length === 0
          ? 'Tip: Consider attaching a research mission to provide context before this code mission runs. Use --depends-on <research-mission-id> to link one. Skip this for trivial changes.'
          : undefined

        this.emit('state-change', 'mission:changed', { mission });
        return nudge ? { ...mission, dependencies: dependsOnMissionIds, nudge } : { ...mission, dependencies: dependsOnMissionIds }
      }

      case 'mission.list':
        return missionService.listMissions(args as Parameters<MissionService['listMissions']>[0]);

      case 'mission.status': {
        const rawId = args.id ?? args.missionId;
        if (rawId == null) {
          throw new CodedError('mission.status requires a mission ID.\n' +
            'Usage: fleet missions show <mission-id>', 'BAD_REQUEST')
        }
        const mission = await missionService.getMission(Number(rawId));
        if (!mission) {
          throw new CodedError(`Mission not found: ${rawId}`, 'NOT_FOUND')
        }
        return mission;
      }

      case 'mission.update': {
        const rawId = args.id ?? args.missionId;
        if (rawId == null) {
          throw new CodedError('mission.update requires a mission ID.\n' +
            'Usage: fleet missions update <mission-id> --status <status> [--prompt "..."] [--summary "..."]', 'BAD_REQUEST')
        }
        const id = Number(rawId);
        const existing = await missionService.getMission(id);
        if (!existing) {
          throw new CodedError(`Mission not found: ${rawId}`, 'NOT_FOUND')
        }

        // Update editable fields (prompt, summary, etc.)
        const fields: Record<string, string> = {};
        if (args.prompt) fields.prompt = args.prompt as string;
        if (args.summary) fields.summary = args.summary as string;
        if (Object.keys(fields).length > 0) {
          await missionService.updateMission(id, fields);
        }

        if (args.status) {
          const newStatus = args.status as string;
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
          throw new CodedError('mission.cancel requires a mission ID.\n' +
            'Usage: fleet missions cancel <mission-id>', 'BAD_REQUEST')
        }
        const id = Number(rawId);
        const existing = await missionService.getMission(id);
        if (!existing) {
          throw new CodedError(`Mission not found: ${rawId}`, 'NOT_FOUND')
        }
        await missionService.abortMission(id);
        this.emit('state-change', 'mission:changed', { id });
        return null;
      }

      case 'mission.verdict': {
        const rawId = args.id ?? args.missionId;
        if (rawId == null) {
          throw new CodedError('mission.verdict requires a mission ID.\n' +
            'Usage: fleet missions verdict <mission-id> --verdict <approved|changes-requested|escalated> --notes "..."', 'BAD_REQUEST')
        }
        const id = typeof rawId === 'string' ? parseInt(rawId, 10) : (rawId as number);
        const verdict = args.verdict as string;
        const notes = (args.notes as string) ?? '';

        if (!verdict || !['approved', 'changes-requested', 'escalated'].includes(verdict)) {
          throw new CodedError('Invalid verdict. Must be one of: approved, changes-requested, escalated', 'BAD_REQUEST')
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
              pr_branch: mission?.pr_branch ?? null,
            }),
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
          throw new CodedError('crew.deploy requires --mission <id>. Create a mission first with: fleet missions add --sector <id> --summary "..." --prompt "..."', 'BAD_REQUEST')
        }

        const missionId = Number(rawMission);
        if (Number.isNaN(missionId) || missionId <= 0) {
          throw new CodedError(`Invalid mission ID: "${rawMission}". --mission must be a numeric mission ID.\n` +
            'Create a mission first:\n' +
            '  fleet missions add --sector <id> --summary "..." --prompt "..."\n' +
            'Then deploy:\n' +
            '  fleet crew deploy --sector <id> --mission <mission-id>', 'BAD_REQUEST')
        }

        const mission = await missionService.getMission(missionId);
        if (!mission) {
          throw new CodedError(`Mission not found: ${missionId}`, 'NOT_FOUND')
        }

        const prompt = mission.prompt;
        if (!prompt || prompt.trim().length === 0) {
          throw new CodedError(`Mission ${missionId} has an empty prompt. Update it first:\n` +
            `  fleet missions update ${missionId} --prompt "..."`, 'BAD_REQUEST')
        }

        // Check all dependencies via junction table
        const allDeps = await missionService.getDependencies(missionId);
        const blockedDeps = allDeps.filter(
          dep => !['completed', 'done', 'failed', 'aborted', 'failed-verification', 'escalated', 'approved'].includes(dep.status)
        )
        if (blockedDeps.length > 0) {
          const depList = blockedDeps.map(d => `#${d.id} (${d.status})`).join(', ')
          throw new Error(
            `Cannot deploy: mission ${missionId} depends on mission(s) ${depList} which have not reached a terminal state.`
          )
        }

        // Guard: reject if mission already has a crew assigned or is already active
        if (mission.crew_id != null || mission.status === 'active' || mission.status === 'deploying') {
          throw new CodedError(`Mission ${missionId} already has a crew assigned (status: ${mission.status}). ` +
            'Recall the existing crew before deploying a new one.', 'CONFLICT')
        }

        const result = await crewService.deployCrew({
          sectorId: (args.sector ?? args.sectorId ?? mission.sector_id) as string,
          prompt,
          missionId,
          type: args.type as string | undefined,
          prBranch: mission.pr_branch ?? undefined,
        });
        this.emit('state-change', 'crew:changed', result);
        return result;
      }

      case 'crew.recall': {
        const crewId = (args.id ?? args.crewId) as string | undefined;
        if (!crewId) {
          throw new CodedError('crew.recall requires a crew ID.\n' +
            'Usage: fleet crew recall <crew-id>\n' +
            'List crew: fleet crew list', 'BAD_REQUEST')
        }
        crewService.recallCrew(crewId);
        this.emit('state-change', 'crew:changed', { crewId, status: 'recalled' });
        return null;
      }

      case 'crew.info': {
        const crewId = (args.id ?? args.crewId) as string | undefined;
        if (!crewId) {
          throw new CodedError('crew.info requires a crew ID.\n' +
            'Usage: fleet crew info <crew-id>\n' +
            'List crew: fleet crew list', 'BAD_REQUEST')
        }
        const info = await crewService.getCrewStatus(crewId);
        if (!info) {
          throw new CodedError(`Crew not found: ${crewId}`, 'NOT_FOUND')
        }
        return info;
      }

      case 'crew.observe': {
        const crewId = (args.id ?? args.crewId) as string | undefined;
        if (!crewId) {
          throw new CodedError('crew.observe requires a crew ID.\n' +
            'Usage: fleet crew observe <crew-id>\n' +
            'List crew: fleet crew list', 'BAD_REQUEST')
        }
        const raw = await crewService.observeCrew(crewId);
        return stripAnsi(raw);
      }

      case 'crew.message': {
        const crewId = (args.id ?? args.crewId) as string | undefined;
        const message = (args.message ?? args.text) as string | undefined;
        if (!crewId) {
          throw new CodedError('crew.message requires a crew ID.\n' +
            'Usage: fleet crew message <crew-id> --message "..."\n' +
            'List crew: fleet crew list', 'BAD_REQUEST')
        }
        if (!message || message.trim().length === 0) {
          throw new CodedError('crew.message requires a non-empty --message.\n' +
            'Usage: fleet crew message <crew-id> --message "your message here"', 'BAD_REQUEST')
        }
        const sent = await crewService.messageCrew(crewId, message);
        if (!sent) {
          throw new CodedError(`Crew not active: ${crewId}. Only active crew can receive messages.\n` +
            'Check crew status: fleet crew info ' + crewId, 'NOT_FOUND')
        }
        this.emit('state-change', 'crew:changed', { crewId });
        return { sent: true };
      }

      // ── Comms ─────────────────────────────────────────────────────────────────
      case 'comms.list': {
        // if executionId arg provided, use getUnreadByExecution
        const executionId = args.execution as string | undefined;
        if (executionId) {
          return commsService.getUnreadByExecution(executionId);
        }
        // fall through to existing getRecent logic
        const rows = commsService.getRecent(args as Parameters<CommsService['getRecent']>[0]);
        return rows;
      }

      case 'comms.read': {
        const rawId = args.id ?? args.transmissionId;
        if (rawId == null) {
          throw new CodedError('comms.read requires a transmission ID.\n' +
            'Usage: fleet comms read <transmission-id>\n' +
            'List transmissions: fleet comms inbox', 'BAD_REQUEST')
        }
        const transmissionId = Number(rawId);
        const changed = await commsService.markRead(transmissionId);
        if (changed) this.emit('state-change', 'comms:changed', { id: transmissionId });
        return null;
      }

      case 'comms.send': {
        const to = args.to as string | undefined;
        if (!to) {
          throw new CodedError('comms.send requires --to <crew-id|admiral>.\n' +
            'Usage: fleet comms send --to <crew-id> --message "..."', 'BAD_REQUEST')
        }
        const payload = (args.message ?? args.payload) as string | undefined;
        if (!payload || payload.trim().length === 0) {
          throw new CodedError('comms.send requires a non-empty --message.\n' +
            'Usage: fleet comms send --to <crew-id> --message "your message"', 'BAD_REQUEST')
        }
        const id = await commsService.send({
          from: (args.from ?? 'admiral') as string,
          to,
          type: (args.type ?? 'directive') as string,
          payload,
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
          throw new CodedError('comms.delete requires a transmission ID.\n' +
            'Usage: fleet comms delete --id <transmission-id>\n' +
            'List transmissions: fleet comms inbox', 'BAD_REQUEST')
        }
        const transmissionId = Number(rawId);
        const deleted = await commsService.delete(transmissionId);
        if (deleted) this.emit('state-change', 'comms:changed', {});
        return { deleted };
      }

      case 'comms.clear': {
        const count = await commsService.clear(
          args.crew ? { crewId: args.crew as string } : undefined,
        );
        if (count > 0) this.emit('state-change', 'comms:changed', {});
        return { deleted: count };
      }

      case 'comms.read-all': {
        const count = await commsService.markAllRead(
          args.crew ? { crewId: args.crew as string } : undefined,
        );
        if (count > 0) this.emit('state-change', 'comms:changed', {});
        return { marked: count };
      }

      case 'comms.info': {
        const rawId = args.id ?? args.transmissionId;
        if (rawId == null) {
          throw new CodedError('comms.info requires a transmission ID.\n' +
            'Usage: fleet comms show <transmission-id>\n' +
            'List transmissions: fleet comms inbox', 'BAD_REQUEST')
        }
        const transmissionId = Number(rawId);
        const transmission = await commsService.getTransmission(transmissionId);
        if (!transmission) {
          throw new CodedError(`Transmission not found: ${transmissionId}`, 'NOT_FOUND')
        }
        return transmission;
      }

      case 'comms.check': {
        const unread = await commsService.getUnread('admiral');
        return { unread: unread.length };
      }

      // ── Cargo ─────────────────────────────────────────────────────────────────
      case 'cargo.list':
        return cargoService.listCargo(args as Parameters<CargoService['listCargo']>[0]);

      case 'cargo.inspect': {
        const rawId = args.cargoId ?? args.id;
        if (rawId == null) {
          throw new CodedError('cargo.inspect requires a cargo ID.\n' +
            'Usage: fleet cargo show <cargo-id>\n' +
            'List cargo: fleet cargo list', 'BAD_REQUEST')
        }
        const cargo = await cargoService.getCargo(Number(rawId));
        if (!cargo) {
          throw new CodedError(`Cargo not found: ${rawId}`, 'NOT_FOUND')
        }
        return cargo;
      }

      case 'cargo.produce': {
        const sectorId = (args.sector ?? args.sectorId) as string | undefined;
        if (!sectorId || !args.type || !args.path) {
          throw new CodedError('cargo.produce requires --sector <sector-id>, --type <type>, and --path <path>.\n' +
            'Usage: fleet cargo produce --sector <sector-id> --type <type> --path <path>', 'BAD_REQUEST')
        }
        return cargoService.produceCargo({
          sectorId,
          type: args.type as string,
          manifest: args.path as string,
        });
      }

      case 'cargo.pending': {
        const sectorId = (args.sector ?? args.sectorId) as string | undefined;
        if (!sectorId) {
          throw new CodedError('cargo.pending requires --sector <sector-id>.\n' +
            'Usage: fleet cargo pending --sector <sector-id>', 'BAD_REQUEST')
        }
        return cargoService.getUndelivered(sectorId);
      }

      // ── Supply Routes ─────────────────────────────────────────────────────────
      case 'supply-route.list':
        return supplyRouteService.listRoutes();

      case 'supply-route.add': {
        const fromSector = (args.from ?? args.fromSector) as string | undefined;
        const toSector = (args.to ?? args.toSector) as string | undefined;
        if (!fromSector || !toSector) {
          throw new CodedError('supply-route.add requires --from <sector-id> and --to <sector-id>.\n' +
            'Usage: fleet supply-route add --from <sector-id> --to <sector-id>', 'BAD_REQUEST')
        }
        return supplyRouteService.addRoute(
          args as Parameters<SupplyRouteService['addRoute']>[0],
        );
      }

      case 'supply-route.remove': {
        const rawId = args.routeId ?? args.id;
        if (rawId == null) {
          throw new CodedError('supply-route.remove requires a route ID.\n' +
            'Usage: fleet supply-route remove <route-id>\n' +
            'List routes: fleet supply-route list', 'BAD_REQUEST')
        }
        supplyRouteService.removeRoute(Number(rawId));
        return null;
      }

      // ── Config ────────────────────────────────────────────────────────────────
      case 'config.get': {
        if (!args.key) {
          throw new CodedError('config.get requires --key <key>.\n' +
            'Usage: fleet config get --key <config-key>', 'BAD_REQUEST')
        }
        return configService.get(args.key as string);
      }

      case 'config.set': {
        if (!args.key) {
          throw new CodedError('config.set requires --key <key> and --value <value>.\n' +
            'Usage: fleet config set --key <config-key> --value <value>', 'BAD_REQUEST')
        }
        if (args.value === undefined) {
          throw new CodedError('config.set requires --value <value>.\n' +
            'Usage: fleet config set --key <config-key> --value <value>', 'BAD_REQUEST')
        }
        configService.set(args.key as string, args.value);
        return null;
      }

      // ── Log ───────────────────────────────────────────────────────────────────
      case 'log.show': {
        const limit = (args.limit as number) ?? 50;
        const crewFilter = args.crew as string | undefined;
        return shipsLog.query({ crewId: crewFilter, limit });
      }

      // ── File Open ──────────────────────────────────────────────────────────────
      case 'file.open': {
        const files = args.files as Array<{ path: string; paneType: 'file' | 'image' }>;
        if (!files || !Array.isArray(files) || files.length === 0) {
          throw new CodedError('file.open requires a non-empty files array', 'BAD_REQUEST')
        }
        const payload = {
          files: files.map((f) => ({
            path: f.path,
            paneType: f.paneType,
            label: f.path.split('/').pop() ?? f.path,
          })),
        };
        this.emit('file-open', payload);
        return { fileCount: files.length };
      }

      // ── Protocols ─────────────────────────────────────────────────────────────
      case 'protocol.list':
        return protocolService.listProtocols();

      case 'protocol.show': {
        const slug = (args.id ?? args.slug) as string;
        const p = await protocolService.getProtocolBySlug(slug);
        if (!p) {
          throw new CodedError(`Protocol not found: ${slug}`, 'NOT_FOUND')
        }
        const steps = await protocolService.listSteps(p.id);
        return { ...p, steps };
      }

      case 'protocol.enable': {
        const slug = (args.id ?? args.slug) as string;
        protocolService.setProtocolEnabled(slug, true);
        return { slug, enabled: true };
      }

      case 'protocol.disable': {
        const slug = (args.id ?? args.slug) as string;
        protocolService.setProtocolEnabled(slug, false);
        return { slug, enabled: false };
      }

      // ── Executions ────────────────────────────────────────────────────────────
      case 'execution.list':
        return protocolService.listExecutions(args.status as string | undefined);

      case 'execution.show': {
        const exec = await protocolService.getExecution(args.id as string);
        if (!exec) {
          throw new CodedError(`Execution not found: ${args.id}`, 'NOT_FOUND')
        }
        return exec;
      }

      case 'execution.update': {
        const exec = await protocolService.getExecution(args.id as string);
        if (!exec) {
          throw new CodedError(`Execution not found: ${args.id}`, 'NOT_FOUND')
        }
        if (args.step !== undefined) {
          await protocolService.advanceStep(args.id as string, Number(args.step));
        }
        if (args.status !== undefined) {
          await protocolService.updateExecutionStatus(args.id as string, args.status as string);
        }
        if (args.context !== undefined) {
          await protocolService.updateExecutionContext(args.id as string, args.context as string);
        }
        return protocolService.getExecution(args.id as string);
      }

      default: {
        throw new CodedError(`Unknown command: ${command}`, 'NOT_FOUND')
      }
    }
  }
}
