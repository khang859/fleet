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

export interface ServiceRegistry {
  crewService: CrewService;
  missionService: MissionService;
  commsService: CommsService;
  sectorService: SectorService;
  cargoService: CargoService;
  supplyRouteService: SupplyRouteService;
  configService: ConfigService;
  shipsLog: ShipsLog;
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

      this.server.listen(this.socketPath, () => {
        resolve();
      });

      this.server.on('error', reject);
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
      const error = err instanceof Error ? err.message : 'Unknown error';
      const code = (err as { code?: string }).code ?? undefined;
      this.sendResponse(socket, { id: req.id, ok: false, error, code });
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
    } = this.services;

    switch (command) {
      // ── Sectors ──────────────────────────────────────────────────────────────
      case 'sector.list':
        return sectorService.listSectors();

      case 'sector.info':
        return sectorService.getSector(
          (args.id ?? args.sectorId ?? args.name) as string,
        );

      case 'sector.add':
        return sectorService.addSector(args as Parameters<SectorService['addSector']>[0]);

      case 'sector.remove':
        sectorService.removeSector(
          (args.id ?? args.sectorId ?? args.name) as string,
        );
        return null;

      // ── Missions ─────────────────────────────────────────────────────────────
      case 'mission.create': {
        const mission = missionService.addMission({
          sectorId: (args.sector ?? args.sectorId) as string,
          summary: args.summary as string,
          prompt: args.prompt as string,
          dependsOnMissionId: args['depends-on'] ? Number(args['depends-on']) : undefined,
        });
        this.emit('state-change', 'mission:changed', { mission });
        return mission;
      }

      case 'mission.list':
        return missionService.listMissions(args as Parameters<MissionService['listMissions']>[0]);

      case 'mission.status':
        return missionService.getMission((args.id ?? args.missionId) as number);

      case 'mission.cancel':
        missionService.abortMission((args.id ?? args.missionId) as number);
        this.emit('state-change', 'mission:changed', { id: args.id ?? args.missionId });
        return null;

      // ── Crew ─────────────────────────────────────────────────────────────────
      case 'crew.list':
        return crewService.listCrew();

      case 'crew.deploy': {
        const missionId = args.mission ? Number(args.mission) : (args.missionId as number | undefined);
        let prompt = (args.prompt ?? args.summary ?? '') as string;

        // If deploying by missionId with no explicit prompt, look it up from the mission record
        if (!prompt && missionId) {
          const mission = missionService.getMission(missionId);
          if (mission) {
            prompt = mission.prompt ?? mission.summary ?? '';
          }
        }

        const result = await crewService.deployCrew({
          sectorId: (args.sector ?? args.sectorId) as string,
          prompt,
          missionId,
        });
        this.emit('state-change', 'crew:changed', result);
        return result;
      }

      case 'crew.recall': {
        const crewId = (args.id ?? args.crewId) as string;
        crewService.recallCrew(crewId);
        this.emit('state-change', 'crew:changed', { crewId, status: 'recalled' });
        return null;
      }

      case 'crew.info': {
        const id = (args.id ?? args.crewId) as string;
        return crewService.getCrewStatus(id);
      }

      case 'crew.observe': {
        const id = (args.id ?? args.crewId) as string;
        const raw = crewService.observeCrew(id);
        return stripAnsi(raw);
      }

      case 'crew.message': {
        const crewId = (args.id ?? args.crewId) as string;
        const message = (args.message ?? args.text) as string;
        if (!crewId || !message) {
          const err = new Error('crew.message requires id and message') as Error & { code: string };
          err.code = 'BAD_REQUEST';
          throw err;
        }
        const sent = crewService.messageCrew(crewId, message);
        if (!sent) {
          const err = new Error(`Crew not active: ${crewId}`) as Error & { code: string };
          err.code = 'NOT_FOUND';
          throw err;
        }
        this.emit('state-change', 'crew:changed', { crewId });
        return { sent: true };
      }

      // ── Comms ─────────────────────────────────────────────────────────────────
      case 'comms.list': {
        const rows = commsService.getRecent(args as Parameters<CommsService['getRecent']>[0]);
        return rows;
      }

      case 'comms.read': {
        const transmissionId = (args.id ?? args.transmissionId) as number;
        const changed = commsService.markRead(transmissionId);
        if (changed) this.emit('state-change', 'comms:changed', { id: transmissionId });
        return null;
      }

      case 'comms.send': {
        const to = args.to as string;
        const payload = (args.message ?? args.payload ?? '') as string;
        const id = commsService.send({
          from: (args.from ?? 'admiral') as string,
          to,
          type: (args.type ?? 'directive') as string,
          payload,
        });
        this.emit('state-change', 'comms:changed', { id });

        // Auto-inject into active crew's Claude Code process if target is a live crew
        let injected = false;
        if (to && to !== 'admiral') {
          injected = crewService.messageCrew(to, payload);
        }

        return { id, injected };
      }

      case 'comms.delete': {
        const transmissionId = (args.id ?? args.transmissionId) as number;
        const deleted = commsService.delete(transmissionId);
        if (deleted) this.emit('state-change', 'comms:changed', {});
        return { deleted };
      }

      case 'comms.clear': {
        const count = commsService.clear(
          args.crew ? { crewId: args.crew as string } : undefined,
        );
        if (count > 0) this.emit('state-change', 'comms:changed', {});
        return { deleted: count };
      }

      case 'comms.read-all': {
        const count = commsService.markAllRead(
          args.crew ? { crewId: args.crew as string } : undefined,
        );
        if (count > 0) this.emit('state-change', 'comms:changed', {});
        return { marked: count };
      }

      case 'comms.info': {
        const transmissionId = (args.id ?? args.transmissionId) as number;
        const transmission = commsService.getTransmission(transmissionId);
        if (!transmission) {
          const err = new Error(`Transmission not found: ${transmissionId}`) as Error & { code: string };
          err.code = 'NOT_FOUND';
          throw err;
        }
        return transmission;
      }

      case 'comms.check':
        return { unread: commsService.getUnread('admiral').length };

      // ── Cargo ─────────────────────────────────────────────────────────────────
      case 'cargo.list':
        return cargoService.listCargo(args as Parameters<CargoService['listCargo']>[0]);

      case 'cargo.inspect':
        return cargoService.getCargo(args.cargoId as number);

      // ── Supply Routes ─────────────────────────────────────────────────────────
      case 'supply-route.list':
        return supplyRouteService.listRoutes();

      case 'supply-route.add':
        return supplyRouteService.addRoute(
          args as Parameters<SupplyRouteService['addRoute']>[0],
        );

      case 'supply-route.remove':
        supplyRouteService.removeRoute(args.routeId as number);
        return null;

      // ── Config ────────────────────────────────────────────────────────────────
      case 'config.get':
        return configService.get(args.key as string);

      case 'config.set':
        configService.set(args.key as string, args.value);
        return null;

      // ── Log ───────────────────────────────────────────────────────────────────
      case 'log.show': {
        const limit = (args.limit as number) ?? 50;
        const crewFilter = args.crew as string | undefined;
        return shipsLog.query({ crewId: crewFilter, limit });
      }

      default: {
        const err = new Error(`Unknown command: ${command}`) as Error & { code: string };
        err.code = 'NOT_FOUND';
        throw err;
      }
    }
  }
}
