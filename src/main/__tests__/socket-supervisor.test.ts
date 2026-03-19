import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, unlinkSync } from 'node:fs';

let SocketSupervisor: typeof import('../socket-supervisor').SocketSupervisor;

function tmpSocket(): string {
  return join(tmpdir(), `fleet-sv-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

function sendPing(socketPath: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      client.write(JSON.stringify({ id: 'ping-1', command: 'ping', args: {} }) + '\n');
    });
    let buffer = '';
    client.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      if (lines.length > 1 && lines[0].trim()) {
        client.end();
        try { resolve(JSON.parse(lines[0])); } catch (e) { reject(e); }
      }
    });
    client.on('error', reject);
    setTimeout(() => { client.destroy(); reject(new Error('timeout')); }, 3000);
  });
}

function makeMockServices() {
  return {
    crewService: { listCrew: vi.fn().mockReturnValue([]) },
    missionService: { listMissions: vi.fn().mockReturnValue([]) },
    commsService: { getRecent: vi.fn().mockReturnValue([]), getUnread: vi.fn().mockReturnValue([]), send: vi.fn().mockReturnValue(1) },
    sectorService: { listSectors: vi.fn().mockReturnValue([]) },
    cargoService: { listCargo: vi.fn().mockReturnValue([]) },
    supplyRouteService: { listRoutes: vi.fn().mockReturnValue([]) },
    configService: { get: vi.fn().mockReturnValue('val'), set: vi.fn() },
    shipsLog: { query: vi.fn().mockReturnValue([]) },
  } as any;
}

describe('SocketSupervisor', () => {
  let socketPath: string;
  let supervisor: InstanceType<typeof SocketSupervisor>;
  let services: ReturnType<typeof makeMockServices>;

  beforeEach(async () => {
    ({ SocketSupervisor } = await import('../socket-supervisor'));
    socketPath = tmpSocket();
    services = makeMockServices();
  });

  afterEach(async () => {
    await supervisor?.stop();
    try { unlinkSync(socketPath); } catch {}
  });

  it('starts and accepts ping', async () => {
    supervisor = new SocketSupervisor(socketPath, services);
    await supervisor.start();

    const response = await sendPing(socketPath);
    expect(response.ok).toBe(true);
    expect((response.data as any).pong).toBe(true);
  });

  it('proxies state-change events from inner SocketServer', async () => {
    supervisor = new SocketSupervisor(socketPath, services);
    await supervisor.start();

    const events: string[] = [];
    supervisor.on('state-change', (event: string) => {
      events.push(event);
    });

    const client = createConnection(socketPath, () => {
      client.write(JSON.stringify({ id: 'x', command: 'comms.send', args: { to: 'crew-1', message: 'hi' } }) + '\n');
    });
    await new Promise<void>((resolve) => {
      client.on('data', () => { client.end(); resolve(); });
      setTimeout(() => { client.destroy(); resolve(); }, 2000);
    });

    expect(events).toContain('comms:changed');
  });

  it('exposes restart() method that restarts the server', async () => {
    supervisor = new SocketSupervisor(socketPath, services);
    await supervisor.start();

    const restartedPromise = new Promise<void>((resolve) => {
      supervisor.on('restarted', resolve);
    });

    await supervisor.restart();
    await restartedPromise;

    const response = await sendPing(socketPath);
    expect(response.ok).toBe(true);
  });

  it('concurrent restart calls are deduplicated', async () => {
    supervisor = new SocketSupervisor(socketPath, services);
    await supervisor.start();

    let restartCount = 0;
    supervisor.on('restarted', () => restartCount++);

    await Promise.all([supervisor.restart(), supervisor.restart()]);
    await new Promise((r) => setTimeout(r, 100));

    expect(restartCount).toBe(1);
  });

  it('stops cleanly', async () => {
    supervisor = new SocketSupervisor(socketPath, services);
    await supervisor.start();
    await supervisor.stop();
    expect(existsSync(socketPath)).toBe(false);
  });
});
