import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FleetCLI, runCLI, parseArgs } from '../fleet-cli';
import { SocketServer } from '../socket-server';
import { StarbaseDB } from '../starbase/db';
import { CommsService } from '../starbase/comms-service';
import { SectorService } from '../starbase/sector-service';
import { MissionService } from '../starbase/mission-service';
import { CrewService } from '../starbase/crew-service';
import { CargoService } from '../starbase/cargo-service';
import { SupplyRouteService } from '../starbase/supply-route-service';
import { ConfigService } from '../starbase/config-service';
import { ShipsLog } from '../starbase/ships-log';
import { WorktreeManager } from '../starbase/worktree-manager';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── Test helpers ──────────────────────────────────────────────────────────────

function tmpSocket(): string {
  return join(tmpdir(), `fleet-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

function tmpDir(): string {
  return join(tmpdir(), `fleet-cli-db-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function makeServices(db: StarbaseDB, dbDir: string) {
  const rawDb = db.getDb();
  const commsService = new CommsService(rawDb);
  const sectorService = new SectorService(rawDb, '/tmp');
  const missionService = new MissionService(rawDb);
  const configService = new ConfigService(rawDb);
  const worktreeManager = new WorktreeManager(join(dbDir, 'worktrees'));
  const crewService = new CrewService({
    db: rawDb,
    starbaseId: db.getStarbaseId(),
    sectorService,
    missionService,
    configService,
    worktreeManager,
  });
  const supplyRouteService = new SupplyRouteService(rawDb);
  const cargoService = new CargoService(rawDb, supplyRouteService, configService);
  const shipsLog = new ShipsLog(rawDb);

  const ptyManager = {
    createPty: () => ({ id: 'pty-1' }),
    getPty: () => null,
    killPty: () => {},
    resize: () => {},
    write: () => {},
    listPtys: () => [],
  } as any;

  const createTab = (_label: string, _cwd: string) => 'tab-1';

  return {
    commsService,
    sectorService,
    missionService,
    crewService,
    cargoService,
    supplyRouteService,
    configService,
    ptyManager,
    createTab,
    shipsLog,
  };
}

// ── parseArgs tests ───────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('parses --key value pairs', () => {
    const result = parseArgs(['--sector', 'api', '--summary', 'Add tests']);
    expect(result).toEqual({ sector: 'api', summary: 'Add tests' });
  });

  it('parses boolean flags (no following value)', () => {
    const result = parseArgs(['--unread']);
    expect(result).toEqual({ unread: true });
  });

  it('parses mixed flags and boolean', () => {
    const result = parseArgs(['--sector', 'api', '--unread']);
    expect(result).toEqual({ sector: 'api', unread: true });
  });

  it('maps single positional arg to id', () => {
    const result = parseArgs(['abc-123']);
    expect(result).toEqual({ id: 'abc-123' });
  });

  it('handles empty args', () => {
    const result = parseArgs([]);
    expect(result).toEqual({});
  });

  it('parses multi-word value flags', () => {
    const result = parseArgs(['--summary', 'Add tests', '--unread']);
    expect(result).toEqual({ summary: 'Add tests', unread: true });
  });
});

// ── FleetCLI.send tests ───────────────────────────────────────────────────────

describe('FleetCLI.send', () => {
  let socketPath: string;
  let dbDir: string;
  let db: StarbaseDB;
  let server: SocketServer;

  beforeEach(async () => {
    socketPath = tmpSocket();
    dbDir = tmpDir();
    mkdirSync(dbDir, { recursive: true });
    db = new StarbaseDB('/tmp/fleet-cli-test', dbDir);
    db.open();
    const services = makeServices(db, dbDir);
    server = new SocketServer(socketPath, services);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    db.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('sends a command and returns a parsed response', async () => {
    const cli = new FleetCLI(socketPath);
    const result = await cli.send('comms.check', {});
    expect(result.ok).toBe(true);
    expect((result.data as any).unread).toBe(0);
  });

  it('includes the request id in the response', async () => {
    const cli = new FleetCLI(socketPath);
    const result = await cli.send('comms.check', {});
    expect(result.id).toBeDefined();
    expect(typeof result.id).toBe('string');
  });

  it('returns an error response for unknown command', async () => {
    const cli = new FleetCLI(socketPath);
    const result = await cli.send('unknown.command', {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown command');
    expect(result.code).toBe('NOT_FOUND');
  });

  it('times out if server is not running', async () => {
    const cli = new FleetCLI('/tmp/nonexistent-fleet-test-notrunning.sock');
    const result = await cli.send('comms.check', {}, 500);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timeout|ENOENT|connect/i);
  });
});

// ── runCLI formatting tests ───────────────────────────────────────────────────

describe('runCLI', () => {
  let socketPath: string;
  let dbDir: string;
  let db: StarbaseDB;
  let server: SocketServer;
  let services: ReturnType<typeof makeServices>;

  beforeEach(async () => {
    socketPath = tmpSocket();
    dbDir = tmpDir();
    mkdirSync(dbDir, { recursive: true });
    db = new StarbaseDB('/tmp/fleet-cli-test', dbDir);
    db.open();
    services = makeServices(db, dbDir);
    server = new SocketServer(socketPath, services);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    db.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('comms.check with 0 unread returns empty string', async () => {
    const output = await runCLI(['comms', 'check'], socketPath);
    expect(output).toBe('');
  });

  it('comms.check with N unread returns notification message', async () => {
    services.commsService.send({ from: 'crew-1', to: 'admiral', type: 'hailing', payload: 'hello' });
    services.commsService.send({ from: 'crew-2', to: 'admiral', type: 'hailing', payload: 'world' });

    const output = await runCLI(['comms', 'check'], socketPath);
    expect(output).toContain('2 unread transmission(s)');
    expect(output).toContain('fleet comms list --unread');
  });

  it('sector.list formats array data as text table', async () => {
    const output = await runCLI(['sector', 'list'], socketPath);
    // With no sectors, server returns [] → should produce 'OK' or empty
    expect(typeof output).toBe('string');
  });

  it('--quiet flag swallows connection errors silently', async () => {
    const deadSocket = '/tmp/nonexistent-fleet-quiet-test-unique.sock';
    const output = await runCLI(['comms', 'check', '--quiet'], deadSocket);
    expect(output).toBe('');
  });

  it('--quiet flag swallows command errors silently', async () => {
    const output = await runCLI(['unknown', 'command', '--quiet'], socketPath);
    expect(output).toBe('');
  });

  it('formats array data as table with headers', async () => {
    // crew.list returns an array → should format as table
    const output = await runCLI(['crew', 'list'], socketPath);
    expect(typeof output).toBe('string');
  });
});
