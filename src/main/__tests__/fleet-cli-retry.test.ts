import { describe, it, expect, vi, afterEach } from 'vitest';
import { FleetCLI } from '../fleet-cli';
import { SocketServer } from '../socket-server';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';

function tmpSocket(): string {
  return join(
    tmpdir(),
    `fleet-retry-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`
  );
}

function makeMockServices() {
  return {
    crewService: { listCrew: () => [] },
    missionService: { listMissions: () => [] },
    commsService: { getRecent: () => [], getUnread: () => [] },
    sectorService: { listSectors: () => [] },
    cargoService: { listCargo: () => [] },
    supplyRouteService: { listRoutes: () => [] },
    configService: { get: () => 'val', set: () => {} },
    shipsLog: { query: () => [] }
  } as any;
}

function captureStderr(): () => string {
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return () => spy.mock.calls.map(([chunk]) => String(chunk)).join('');
}

describe('FleetCLI.sendWithRetry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('succeeds immediately when socket is available', async () => {
    const socketPath = tmpSocket();
    const server = new SocketServer(socketPath, makeMockServices());
    await server.start();

    try {
      const cli = new FleetCLI(socketPath);
      const result = await cli.sendWithRetry('ping', {});
      expect(result.ok).toBe(true);
      expect((result.data as any).pong).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it('retries on transient errors and eventually fails', async () => {
    const socketPath = tmpSocket();
    // No server running, socket file doesn't exist
    const stderr = captureStderr();
    const cli = new FleetCLI(socketPath);
    const result = await cli.sendWithRetry(
      'ping',
      {},
      { waitForAppMs: 0, maxRetries: 2, initialBackoffMs: 50 }
    );
    expect(result.ok).toBe(false);
    expect(stderr()).toContain('Connection failed (ENOENT), retrying (1/2)...');
    expect(stderr()).toContain('Connection failed (ENOENT), retrying (2/2)...');
  });

  it('waits for socket file to appear', async () => {
    const socketPath = tmpSocket();
    expect(existsSync(socketPath)).toBe(false);

    // Start server after 300ms delay
    const server = new SocketServer(socketPath, makeMockServices());
    setTimeout(() => {
      void server.start();
    }, 300);

    const stderr = captureStderr();
    const cli = new FleetCLI(socketPath);
    const result = await cli.sendWithRetry('ping', {}, { waitForAppMs: 3000, pollIntervalMs: 100 });

    expect(result.ok).toBe(true);
    expect((result.data as any).pong).toBe(true);
    expect(stderr()).toContain('Waiting for Fleet app to start...');

    await server.stop();
  });

  it('fails immediately on non-transient errors', async () => {
    const socketPath = tmpSocket();
    const server = new SocketServer(socketPath, makeMockServices());
    await server.start();

    try {
      const cli = new FleetCLI(socketPath);
      const result = await cli.sendWithRetry('unknown.command', {});
      expect(result.ok).toBe(false);
      expect(result.code).toBe('NOT_FOUND');
    } finally {
      await server.stop();
    }
  });
});
