/**
 * Admiral Integration Tests
 *
 * End-to-end tests that verify the full CLI workflow through SocketServer.
 * Uses minimal mock services that track state across commands.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'node:fs';

import { SocketServer } from '../socket-server';
import { FleetCLI, runCLI } from '../fleet-cli';

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpSocket(): string {
  // macOS limits Unix socket paths to 104 chars — keep prefix short
  return join(tmpdir(), `fai-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

// ── Stateful mock services ─────────────────────────────────────────────────────
//
// Unlike the unit tests that use static vi.fn() mocks, these hold real state so
// that sequential commands (create → list) work end-to-end.

interface MockMission {
  id: number;
  sectorId: string;
  summary: string;
  prompt: string;
  status: string;
}

interface MockCommsMsg {
  id: number;
  from: string;
  to: string;
  type: string;
  payload: string;
  read: boolean;
}

function makeStatefulServices() {
  // ── Sectors ──
  const sectors = [
    { id: 'alpha', name: 'Alpha', path: '/workspace/alpha' },
    { id: 'beta', name: 'Beta', path: '/workspace/beta' },
  ];

  const sectorService = {
    listSectors: () => sectors,
    listVisibleSectors: () => sectors,
    getSector: (id: string) => sectors.find((s) => s.id === id) ?? null,
    addSector: (args: { path: string; name?: string }) => {
      const sector = { id: args.path, name: args.name ?? args.path, path: `/workspace/${args.path}` };
      sectors.push(sector);
      return sector;
    },
    removeSector: (id: string) => {
      const idx = sectors.findIndex((s) => s.id === id);
      if (idx !== -1) sectors.splice(idx, 1);
    },
  };

  // ── Missions ──
  const missions: MockMission[] = [];
  let missionIdSeq = 1;

  const missionService = {
    addMission: (args: { sectorId: string; summary: string; prompt: string }): MockMission => {
      const mission: MockMission = {
        id: missionIdSeq++,
        sectorId: args.sectorId,
        summary: args.summary,
        prompt: args.prompt,
        status: 'queued',
      };
      missions.push(mission);
      return mission;
    },
    listMissions: (filter?: { sectorId?: string }) => {
      if (filter?.sectorId) {
        return missions.filter((m) => m.sectorId === filter.sectorId);
      }
      return missions.slice();
    },
    getMission: (id: number) => missions.find((m) => m.id === id) ?? null,
    abortMission: (id: number) => {
      const m = missions.find((mm) => mm.id === id);
      if (m) m.status = 'aborted';
    },
  };

  // ── Comms ──
  const commsMessages: MockCommsMsg[] = [];
  let commsIdSeq = 1;

  const commsService = {
    getRecent: (filter?: { unread?: boolean }) => {
      if (filter?.unread) return commsMessages.filter((m) => !m.read);
      return commsMessages.slice();
    },
    getUnread: (to: string) => commsMessages.filter((m) => m.to === to && !m.read),
    send: (args: { from: string; to: string; type: string; payload: string }) => {
      const id = commsIdSeq++;
      commsMessages.push({ id, ...args, read: false });
      return id;
    },
    markRead: (id: number) => {
      const m = commsMessages.find((msg) => msg.id === id);
      if (m) m.read = true;
    },
  };

  // ── Stub-only services (not exercised in these tests) ──
  const crewService = {
    listCrew: () => [],
    deployCrew: async () => ({ crewId: 'crew-1', tabId: 'tab-1', missionId: 1 }),
    recallCrew: () => {},
    observeCrew: () => '',
  };

  const cargoService = {
    listCargo: () => [],
    getCargo: () => null,
  };

  const supplyRouteService = {
    listRoutes: () => [],
    addRoute: () => ({ id: 1 }),
    removeRoute: () => {},
  };

  const configService = {
    get: () => null,
    set: () => {},
  };

  const ptyManager = {
    create: () => {},
    kill: () => {},
    write: () => {},
    has: () => false,
  };

  const shipsLog = {
    query: () => [],
    log: () => 1,
    getRecent: () => [],
  };

  const createTab = (_label: string, _cwd: string) => 'tab-uuid';

  return {
    sectorService,
    missionService,
    commsService,
    crewService,
    cargoService,
    supplyRouteService,
    configService,
    ptyManager,
    shipsLog,
    createTab,
    // Expose internal state for assertions
    _missions: missions,
    _commsMessages: commsMessages,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Admiral Integration', () => {
  let socketPath: string;
  let server: SocketServer;
  let services: ReturnType<typeof makeStatefulServices>;
  let cli: FleetCLI;

  beforeEach(async () => {
    socketPath = tmpSocket();
    services = makeStatefulServices();
    server = new SocketServer(socketPath, services as any);
    await server.start();
    cli = new FleetCLI(socketPath);
  });

  afterEach(async () => {
    await server.stop();
    try {
      unlinkSync(socketPath);
    } catch {
      // already removed by stop()
    }
  });

  it('full CLI workflow: list sectors, check comms, create mission, list missions', async () => {
    // 1. fleet sector list — returns the pre-seeded sectors
    const sectorOutput = await runCLI(['sector', 'list'], socketPath);
    expect(sectorOutput).toContain('alpha');
    expect(sectorOutput).toContain('beta');

    // 2. fleet comms check — 0 unread messages → returns empty string
    const commsOutput = await runCLI(['comms', 'check'], socketPath);
    expect(commsOutput).toBe('');

    // 3. fleet mission create — creates a mission via socket
    const createResp = await cli.send('mission.create', {
      sector: 'alpha',
      summary: 'Implement auth',
      prompt: 'Add JWT-based authentication to the API',
      type: 'code',
    });
    expect(createResp.ok).toBe(true);
    const created = createResp.data as MockMission;
    expect(created.id).toBeDefined();
    expect(created.summary).toBe('Implement auth');
    expect(created.status).toBe('queued');

    // Verify state was persisted in mock service
    expect(services._missions).toHaveLength(1);
    expect(services._missions[0].sectorId).toBe('alpha');

    // 4. fleet mission list — shows the created mission
    const listResp = await cli.send('mission.list', {});
    expect(listResp.ok).toBe(true);
    const listed = listResp.data as MockMission[];
    expect(listed).toHaveLength(1);
    expect(listed[0].summary).toBe('Implement auth');

    // Also verify via runCLI formatting
    const missionOutput = await runCLI(['mission', 'list'], socketPath);
    expect(missionOutput).toContain('Implement auth');
  });

  it('state change events fire for mutating commands', async () => {
    const events: Array<{ event: string; data: unknown }> = [];
    server.on('state-change', (event, data) => {
      events.push({ event, data });
    });

    // mission.create should emit 'mission:changed'
    const resp = await cli.send('mission.create', {
      sector: 'beta',
      summary: 'Refactor service',
      prompt: 'Extract service layer from controllers',
      type: 'code',
    });

    expect(resp.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('mission:changed');
    expect((events[0].data as any).mission).toBeDefined();
    expect((events[0].data as any).mission.summary).toBe('Refactor service');
  });

  it('runCLI --quiet swallows errors when server is down', async () => {
    // Stop the server so the socket is no longer accepting connections
    await server.stop();

    // runCLI with --quiet must return empty string and not throw
    const output = await runCLI(['mission', 'list', '--quiet'], socketPath);
    expect(output).toBe('');
  });

  it('shared state: multiple sequential commands reflect accumulated changes', async () => {
    // Create two missions sequentially
    await cli.send('mission.create', {
      sector: 'alpha',
      summary: 'Task One',
      prompt: 'Do task one',
      type: 'code',
    });
    await cli.send('mission.create', {
      sector: 'alpha',
      summary: 'Task Two',
      prompt: 'Do task two',
      type: 'code',
    });

    // Both should appear in the list
    const listResp = await cli.send('mission.list', {});
    expect(listResp.ok).toBe(true);
    const missions = listResp.data as MockMission[];
    expect(missions).toHaveLength(2);
    expect(missions.map((m) => m.summary)).toContain('Task One');
    expect(missions.map((m) => m.summary)).toContain('Task Two');

    // comms check should still be empty (no messages sent)
    const commsOutput = await runCLI(['comms', 'check'], socketPath);
    expect(commsOutput).toBe('');
  });
});
