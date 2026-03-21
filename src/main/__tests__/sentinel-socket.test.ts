import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Sentinel } from '../starbase/sentinel';
import { SocketSupervisor } from '../socket-supervisor';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync } from 'fs';

function tmpSocket(): string {
  return join(
    tmpdir(),
    `fleet-sentinel-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`
  );
}

function makeMockServices() {
  return {
    crewService: { listCrew: vi.fn().mockReturnValue([]) },
    missionService: { listMissions: vi.fn().mockReturnValue([]) },
    commsService: {
      getRecent: vi.fn().mockReturnValue([]),
      getUnread: vi.fn().mockReturnValue([])
    },
    sectorService: { listSectors: vi.fn().mockReturnValue([]) },
    cargoService: { listCargo: vi.fn().mockReturnValue([]) },
    supplyRouteService: { listRoutes: vi.fn().mockReturnValue([]) },
    configService: { get: vi.fn().mockReturnValue('val'), set: vi.fn() },
    shipsLog: { query: vi.fn().mockReturnValue([]) }
  } as any;
}

function makeMockDb() {
  const prepared = {
    all: vi.fn().mockReturnValue([]),
    run: vi.fn(),
    get: vi.fn()
  };
  return {
    prepare: vi.fn().mockReturnValue(prepared)
  } as any;
}

describe('Sentinel socket health check', () => {
  let socketPath: string;
  let supervisor: SocketSupervisor;

  beforeEach(async () => {
    socketPath = tmpSocket();
    supervisor = new SocketSupervisor(socketPath, makeMockServices());
    await supervisor.start();
  });

  afterEach(async () => {
    await supervisor.stop();
    try {
      unlinkSync(socketPath);
    } catch {
      // intentional
    }
  });

  it('successful ping resets consecutive failure count', async () => {
    const configService = {
      get: vi.fn((key: string) => {
        if (key === 'lifesign_interval_sec') return 10;
        if (key === 'lifesign_timeout_sec') return 30;
        if (key === 'worktree_disk_budget_gb') return 50;
        return null;
      })
    };
    const sentinel = new Sentinel({
      db: makeMockDb(),
      configService: configService as any,
      supervisor,
      socketPath
    });

    await sentinel.runSweep();

    const restartSpy = vi.spyOn(supervisor, 'restart');
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('triggers restart after 3 consecutive ping failures', async () => {
    await supervisor.stop();

    const configService = {
      get: vi.fn((key: string) => {
        if (key === 'lifesign_interval_sec') return 10;
        if (key === 'lifesign_timeout_sec') return 30;
        if (key === 'worktree_disk_budget_gb') return 50;
        return null;
      })
    };

    const stoppedSupervisor = new SocketSupervisor(socketPath, makeMockServices());
    const restartSpy = vi.spyOn(stoppedSupervisor, 'restart').mockResolvedValue();

    const sentinel = new Sentinel({
      db: makeMockDb(),
      configService: configService as any,
      supervisor: stoppedSupervisor,
      socketPath
    });

    await sentinel.runSweep();
    await sentinel.runSweep();
    await sentinel.runSweep();

    expect(restartSpy).toHaveBeenCalledTimes(1);
  });
});
