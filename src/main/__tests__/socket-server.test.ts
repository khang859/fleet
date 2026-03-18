import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';

// We need to import after creating mocks
let SocketServer: typeof import('../socket-server').SocketServer;

function tmpSocket(): string {
  return join(tmpdir(), `fleet-ss-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

function sendCommand(
  socketPath: string,
  cmd: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      client.write(JSON.stringify(cmd) + '\n');
    });
    let buffer = '';
    client.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      if (lines.length > 1 && lines[0].trim()) {
        client.end();
        try {
          resolve(JSON.parse(lines[0]));
        } catch (e) {
          reject(e);
        }
      }
    });
    client.on('error', reject);
    setTimeout(() => {
      client.destroy();
      reject(new Error('timeout'));
    }, 3000);
  });
}

function makeMockServices() {
  const sectorService = {
    listSectors: vi.fn().mockReturnValue([{ id: 'alpha', name: 'Alpha' }]),
    getSector: vi.fn().mockReturnValue({ id: 'alpha', name: 'Alpha' }),
    addSector: vi.fn().mockReturnValue({ id: 'new-sector', name: 'New Sector' }),
    removeSector: vi.fn(),
  };

  const missionService = {
    addMission: vi.fn().mockReturnValue({ id: 1, summary: 'test', status: 'queued' }),
    listMissions: vi.fn().mockReturnValue([]),
    getMission: vi.fn().mockReturnValue({ id: 1, status: 'queued' }),
    abortMission: vi.fn(),
  };

  const commsService = {
    getRecent: vi.fn().mockReturnValue([{ id: 1, type: 'directive', payload: 'hello' }]),
    getUnread: vi.fn().mockReturnValue([]),
    send: vi.fn().mockReturnValue(1),
    markRead: vi.fn(),
  };

  const crewService = {
    listCrew: vi.fn().mockReturnValue([]),
    deployCrew: vi.fn().mockResolvedValue({ crewId: 'crew-1', tabId: 'tab-1', missionId: 1 }),
    recallCrew: vi.fn(),
    observeCrew: vi.fn().mockReturnValue('some output'),
  };

  const cargoService = {
    listCargo: vi.fn().mockReturnValue([]),
    getCargo: vi.fn().mockReturnValue(null),
  };

  const supplyRouteService = {
    listRoutes: vi.fn().mockReturnValue([]),
    addRoute: vi.fn().mockReturnValue({ id: 1 }),
    removeRoute: vi.fn(),
  };

  const configService = {
    get: vi.fn().mockReturnValue('some-value'),
    set: vi.fn(),
  };

  const ptyManager = {
    create: vi.fn(),
    kill: vi.fn(),
    write: vi.fn(),
    has: vi.fn().mockReturnValue(false),
  };

  const shipsLog = {
    query: vi.fn().mockReturnValue([{ id: 1, event_type: 'deployed', created_at: '2026-01-01' }]),
    getRecent: vi.fn().mockReturnValue([]),
    log: vi.fn().mockReturnValue(1),
  };

  const createTab = vi.fn().mockReturnValue('tab-uuid');

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
  };
}

describe('SocketServer', () => {
  let socketPath: string;
  let server: InstanceType<typeof import('../socket-server').SocketServer>;
  let services: ReturnType<typeof makeMockServices>;

  beforeEach(async () => {
    ({ SocketServer } = await import('../socket-server'));
    socketPath = tmpSocket();
    services = makeMockServices();
    server = new SocketServer(socketPath, services as any);
  });

  afterEach(async () => {
    await server.stop();
    try {
      unlinkSync(socketPath);
    } catch {}
  });

  it('starts and accepts connections', async () => {
    await server.start();
    expect(existsSync(socketPath)).toBe(true);
  });

  it('cleans up stale socket file on startup', async () => {
    // Create a fake stale socket file
    writeFileSync(socketPath, 'stale');
    expect(existsSync(socketPath)).toBe(true);

    // Server should delete and replace it
    await server.start();
    expect(existsSync(socketPath)).toBe(true);
    // The file should now be a valid socket, not our stale content
  });

  it('routes sector.list command and returns correct results', async () => {
    await server.start();

    const response = await sendCommand(socketPath, {
      id: 'req-1',
      command: 'sector.list',
      args: {},
    });

    expect(response.id).toBe('req-1');
    expect(response.ok).toBe(true);
    expect(response.data).toEqual([{ id: 'alpha', name: 'Alpha' }]);
    expect(services.sectorService.listSectors).toHaveBeenCalled();
  });

  it('returns error response for unknown commands', async () => {
    await server.start();

    const response = await sendCommand(socketPath, {
      id: 'req-bad',
      command: 'unknown.command',
      args: {},
    });

    expect(response.id).toBe('req-bad');
    expect(response.ok).toBe(false);
    expect(response.error).toBeDefined();
    expect(response.code).toBe('NOT_FOUND');
  });

  it('returns error for malformed JSON', async () => {
    await server.start();

    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const client = createConnection(socketPath, () => {
        client.write('not valid json\n');
      });
      let buffer = '';
      client.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        if (lines.length > 1 && lines[0].trim()) {
          client.end();
          resolve(JSON.parse(lines[0]));
        }
      });
      client.on('error', reject);
      setTimeout(() => { client.destroy(); reject(new Error('timeout')); }, 3000);
    });

    expect(response.ok).toBe(false);
    expect(response.error).toBeDefined();
  });

  it('emits state change event for comms.send', async () => {
    await server.start();

    const events: Array<{ event: string; data: unknown }> = [];
    server.on('state-change', (event, data) => {
      events.push({ event, data });
    });

    await sendCommand(socketPath, {
      id: 'req-comms',
      command: 'comms.send',
      args: { to: 'crew-1', message: 'hello' },
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].event).toBe('comms:changed');
    expect(services.commsService.send).toHaveBeenCalled();
  });

  it('stops cleanly and removes socket file', async () => {
    await server.start();
    expect(existsSync(socketPath)).toBe(true);
    await server.stop();
    expect(existsSync(socketPath)).toBe(false);
  });

  it('handles multiple concurrent requests', async () => {
    await server.start();

    const [r1, r2, r3] = await Promise.all([
      sendCommand(socketPath, { id: 'r1', command: 'sector.list', args: {} }),
      sendCommand(socketPath, { id: 'r2', command: 'sector.list', args: {} }),
      sendCommand(socketPath, { id: 'r3', command: 'crew.list', args: {} }),
    ]);

    expect(r1.id).toBe('r1');
    expect(r1.ok).toBe(true);
    expect(r2.id).toBe('r2');
    expect(r2.ok).toBe(true);
    expect(r3.id).toBe('r3');
    expect(r3.ok).toBe(true);
  });

  it('emits state change event for mission.create', async () => {
    await server.start();

    const events: Array<{ event: string }> = [];
    server.on('state-change', (event) => {
      events.push({ event });
    });

    await sendCommand(socketPath, {
      id: 'req-mission',
      command: 'mission.create',
      args: { sector: 'alpha', summary: 'Do stuff', prompt: 'Do the stuff' },
    });

    expect(events.some((e) => e.event === 'mission:changed')).toBe(true);
  });

  it('emits state change event for crew.deploy', async () => {
    await server.start();

    const events: Array<{ event: string }> = [];
    server.on('state-change', (event) => {
      events.push({ event });
    });

    await sendCommand(socketPath, {
      id: 'req-deploy',
      command: 'crew.deploy',
      args: { sector: 'alpha', prompt: 'Do work' },
    });

    expect(events.some((e) => e.event === 'crew:changed')).toBe(true);
  });

  it('strips ANSI codes from crew.observe output', async () => {
    services.crewService.observeCrew.mockReturnValue('\x1b[31mred text\x1b[0m normal');
    await server.start();

    const response = await sendCommand(socketPath, {
      id: 'req-observe',
      command: 'crew.observe',
      args: { id: 'crew-1' },
    });

    expect(response.ok).toBe(true);
    expect(response.data).not.toContain('\x1b');
    expect(response.data).toContain('red text');
    expect(response.data).toContain('normal');
  });

  it('comms.check returns unread count', async () => {
    services.commsService.getUnread.mockReturnValue([{ id: 1 }, { id: 2 }]);
    await server.start();

    const response = await sendCommand(socketPath, {
      id: 'req-check',
      command: 'comms.check',
      args: {},
    });

    expect(response.ok).toBe(true);
    expect((response.data as any).unread).toBe(2);
  });
});
