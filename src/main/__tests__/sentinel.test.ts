import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StarbaseDB } from '../starbase/db';
import { Sentinel } from '../starbase/sentinel';
import { ConfigService } from '../starbase/config-service';
import { ShipsLog } from '../starbase/ships-log';
import { rmSync, mkdirSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Navigator } from '../starbase/navigator';

const TEST_DIR = join(tmpdir(), 'fleet-test-sentinel');

let starbaseDb: StarbaseDB;
let configService: ConfigService;

function getDb() {
  return starbaseDb.getDb();
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });

  // Create a sector directory with git repo
  const sectorDir = join(TEST_DIR, 'workspace', 'api');
  mkdirSync(sectorDir, { recursive: true });
  writeFileSync(join(sectorDir, 'index.ts'), '');
  execSync('git init && git checkout -b main', { cwd: sectorDir });
  execSync('git config user.email "test@test.com" && git config user.name "Test"', {
    cwd: sectorDir
  });
  execSync('git add -A && git commit -m "init"', { cwd: sectorDir });

  starbaseDb = new StarbaseDB(join(TEST_DIR, 'workspace'), join(TEST_DIR, 'starbases'));
  starbaseDb.open();
  configService = new ConfigService(getDb());
});

afterEach(() => {
  starbaseDb.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function insertSector(id: string, rootPath: string): void {
  getDb()
    .prepare('INSERT INTO sectors (id, name, root_path) VALUES (?, ?, ?)')
    .run(id, id, rootPath);
}

/** Convert JS Date to SQLite datetime format */
function sqliteDatetime(date: Date): string {
  return date
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '');
}

function insertCrew(opts: {
  id: string;
  sectorId: string;
  status?: string;
  lastLifesign?: string;
  deadline?: string;
  pid?: number;
  commsCountMinute?: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO crew (id, sector_id, status, last_lifesign, deadline, pid, comms_count_minute)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.id,
      opts.sectorId,
      opts.status ?? 'active',
      opts.lastLifesign ?? sqliteDatetime(new Date()),
      opts.deadline ?? null,
      opts.pid ?? process.pid,
      opts.commsCountMinute ?? 0
    );
}

describe('Sentinel', () => {
  it('should mark crew with stale lifesign as lost', async () => {
    const sectorDir = join(TEST_DIR, 'workspace', 'api');
    insertSector('api', sectorDir);

    // Insert crew with lifesign 60 seconds ago (timeout is 30s)
    const staleTime = sqliteDatetime(new Date(Date.now() - 60_000));
    insertCrew({ id: 'crew-1', sectorId: 'api', lastLifesign: staleTime });

    const sentinel = new Sentinel({ db: getDb(), configService, shipsLog: new ShipsLog(getDb()) });
    await sentinel.runSweep();

    const crew = getDb().prepare('SELECT status FROM crew WHERE id = ?').get('crew-1') as {
      status: string;
    };
    expect(crew.status).toBe('lost');

    // Should have a ships_log entry
    const logEntry = getDb()
      .prepare("SELECT * FROM ships_log WHERE crew_id = 'crew-1' AND event_type = 'lifesign_lost'")
      .get();
    expect(logEntry).toBeDefined();

    // Verify via ShipsLog class
    const logEntries = new ShipsLog(getDb()).query({ eventType: 'lifesign_lost' });
    expect(logEntries.length).toBeGreaterThanOrEqual(1);
  });

  it('should not mark crew with fresh lifesign as lost', async () => {
    const sectorDir = join(TEST_DIR, 'workspace', 'api');
    insertSector('api', sectorDir);

    insertCrew({ id: 'crew-1', sectorId: 'api', lastLifesign: sqliteDatetime(new Date()) });

    const sentinel = new Sentinel({ db: getDb(), configService, shipsLog: new ShipsLog(getDb()) });
    await sentinel.runSweep();

    const crew = getDb().prepare('SELECT status FROM crew WHERE id = ?').get('crew-1') as {
      status: string;
    };
    expect(crew.status).toBe('active');
  });

  it('should mark crew with expired deadline for termination', async () => {
    const sectorDir = join(TEST_DIR, 'workspace', 'api');
    insertSector('api', sectorDir);

    // Deadline in the past — use a dead PID so SIGTERM doesn't kill the test runner
    const pastDeadline = sqliteDatetime(new Date(Date.now() - 60_000));
    insertCrew({ id: 'crew-1', sectorId: 'api', deadline: pastDeadline, pid: 99999999 });

    const sentinel = new Sentinel({ db: getDb(), configService, shipsLog: new ShipsLog(getDb()) });
    await sentinel.runSweep();

    const crew = getDb().prepare('SELECT status FROM crew WHERE id = ?').get('crew-1') as {
      status: string;
    };
    expect(crew.status).toBe('timeout');

    // Verify timeout ships log entry via ShipsLog class
    const logEntries = new ShipsLog(getDb()).query({ eventType: 'timeout' });
    expect(logEntries.length).toBeGreaterThanOrEqual(1);
  });

  it('should disable sector with missing root path', async () => {
    insertSector('missing-sector', '/nonexistent/path/that/does/not/exist');
    insertCrew({ id: 'crew-1', sectorId: 'missing-sector' });

    const sentinel = new Sentinel({ db: getDb(), configService, shipsLog: new ShipsLog(getDb()) });
    await sentinel.runSweep();

    const crew = getDb().prepare('SELECT status FROM crew WHERE id = ?').get('crew-1') as {
      status: string;
    };
    expect(crew.status).toBe('lost');

    const logEntry = getDb()
      .prepare("SELECT * FROM ships_log WHERE event_type = 'sector_path_missing'")
      .get();
    expect(logEntry).toBeDefined();
  });

  it('should ignore the global sentinel during sector path validation', async () => {
    insertCrew({ id: 'crew-1', sectorId: 'global' });

    const sentinel = new Sentinel({ db: getDb(), configService, shipsLog: new ShipsLog(getDb()) });
    await sentinel.runSweep();

    const crew = getDb().prepare('SELECT status FROM crew WHERE id = ?').get('crew-1') as {
      status: string;
    };
    expect(crew.status).toBe('active');

    const logEntry = getDb()
      .prepare(
        'SELECT * FROM ships_log WHERE event_type = \'sector_path_missing\' AND detail LIKE \'%"sectorId":"global"%\''
      )
      .get();
    expect(logEntry).toBeUndefined();
  });

  it('should reset comms_count_minute on every 6th sweep', async () => {
    const sectorDir = join(TEST_DIR, 'workspace', 'api');
    insertSector('api', sectorDir);
    insertCrew({ id: 'crew-1', sectorId: 'api', commsCountMinute: 15 });

    const sentinel = new Sentinel({ db: getDb(), configService, shipsLog: new ShipsLog(getDb()) });

    // Run 5 sweeps — should NOT reset
    for (let i = 0; i < 5; i++) {
      await sentinel.runSweep();
    }
    let crew = getDb()
      .prepare('SELECT comms_count_minute FROM crew WHERE id = ?')
      .get('crew-1') as { comms_count_minute: number };
    expect(crew.comms_count_minute).toBe(15);

    // 6th sweep — should reset
    await sentinel.runSweep();
    crew = getDb().prepare('SELECT comms_count_minute FROM crew WHERE id = ?').get('crew-1') as {
      comms_count_minute: number;
    };
    expect(crew.comms_count_minute).toBe(0);
  });

  it('should start and stop the sweep interval', async () => {
    const sentinel = new Sentinel({ db: getDb(), configService, shipsLog: new ShipsLog(getDb()) });
    sentinel.start(100); // 100ms interval for testing
    // Let it run a couple sweeps
    await new Promise((r) => setTimeout(r, 250));
    sentinel.stop();
    // Should not throw after stop
  });
});

describe('Navigator sweep', () => {
  it('triggers Navigator when FO escalation exists for protocol mission', async () => {
    // Set up: sector, mission with protocol_execution_id, crew, FO memo comms row
    const sectorId = 'test-sector';
    getDb()
      .prepare(`INSERT OR IGNORE INTO sectors (id, name, root_path) VALUES (?, ?, ?)`)
      .run(sectorId, 'Test', join(TEST_DIR, 'workspace', 'api'));
    getDb()
      .prepare(`INSERT OR IGNORE INTO protocols (id, slug, name) VALUES ('p1', 'test', 'Test')`)
      .run();
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO protocol_executions (id, protocol_id, feature_request) VALUES ('exec-1', 'p1', 'build auth')`
      )
      .run();
    const missionId = (
      getDb()
        .prepare(
          `INSERT INTO missions (sector_id, summary, prompt, protocol_execution_id) VALUES (?, ?, ?, ?) RETURNING id`
        )
        .get(sectorId, 'test', 'test', 'exec-1') as { id: number }
    ).id;
    getDb()
      .prepare(
        `INSERT INTO comms (from_crew, to_crew, type, mission_id, payload) VALUES ('first-officer', 'admiral', 'memo', ?, ?)`
      )
      .run(missionId, JSON.stringify({ reason: 'escalated' }));

    const dispatchedIds: string[] = [];
    const nav = {
      dispatch: vi.fn((event: { executionId: string }) => {
        dispatchedIds.push(event.executionId);
        return true;
      }),
      isRunning: vi.fn(() => false),
      activeCount: 0,
      reconcile: vi.fn(),
      shutdown: vi.fn()
    };

    const sentinel = new Sentinel({
      db: getDb(),
      configService,
      shipsLog: new ShipsLog(getDb()),
      navigator: nav as unknown as Navigator
    });
    await (sentinel as unknown as { navigatorSweep: () => Promise<void> }).navigatorSweep();

    expect(dispatchedIds).toContain('exec-1');
  });

  it('expires stale gate-pending executions', async () => {
    getDb()
      .prepare(`INSERT OR IGNORE INTO protocols (id, slug, name) VALUES ('p2', 'proto2', 'Proto2')`)
      .run();
    getDb()
      .prepare(
        `INSERT INTO protocol_executions (id, protocol_id, feature_request, status) VALUES ('exec-stale', 'p2', 'test', 'gate-pending')`
      )
      .run();
    getDb()
      .prepare(
        `UPDATE protocol_executions SET updated_at = datetime('now', '-2 days') WHERE id = 'exec-stale'`
      )
      .run();

    const sentinel = new Sentinel({ db: getDb(), configService, shipsLog: new ShipsLog(getDb()) });
    await (sentinel as unknown as { navigatorSweep: () => Promise<void> }).navigatorSweep();

    const exec = getDb()
      .prepare(`SELECT status FROM protocol_executions WHERE id = 'exec-stale'`)
      .get() as { status: string };
    expect(exec.status).toBe('gate-expired');
  });
});

describe('prMonitorSweep — escalation', () => {
  it('should escalate mission when review_round >= MAX_REPAIR_ROUNDS', async () => {
    const sectorDir = join(TEST_DIR, 'workspace', 'api');
    insertSector('api', sectorDir);

    // Insert an approved mission with pr_branch set and review_round = 2 (>= MAX_REPAIR_ROUNDS)
    const missionId = (
      getDb()
        .prepare(
          `INSERT INTO missions (sector_id, summary, prompt, status, type, pr_branch, review_round)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
        )
        .get('api', 'Test mission', 'Do some work', 'approved', 'code', 'feature/test-branch', 2) as {
        id: number;
      }
    ).id;

    const mockDeployCrew = vi.fn();
    const mockAddMission = vi.fn();

    const sentinel = new Sentinel({
      db: getDb(),
      configService,
      shipsLog: new ShipsLog(getDb()),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      crewService: { deployCrew: mockDeployCrew } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      missionService: { addMission: mockAddMission } as any
    });

    await (sentinel as unknown as { prMonitorSweep: () => Promise<void> }).prMonitorSweep();

    // Mission should be escalated
    const mission = getDb()
      .prepare('SELECT status FROM missions WHERE id = ?')
      .get(missionId) as { status: string };
    expect(mission.status).toBe('escalated');

    // deployCrew should NOT have been called
    expect(mockDeployCrew).not.toHaveBeenCalled();

    // Should have a comms memo about the escalation
    const memo = getDb()
      .prepare(
        `SELECT * FROM comms WHERE mission_id = ? AND type = 'memo' AND from_crew = 'first-officer' AND to_crew = 'admiral'`
      )
      .get(missionId);
    expect(memo).toBeDefined();
  });

  it('should skip missions when crewService or missionService is not provided', async () => {
    const sectorDir = join(TEST_DIR, 'workspace', 'api');
    insertSector('api', sectorDir);

    getDb()
      .prepare(
        `INSERT INTO missions (sector_id, summary, prompt, status, type, pr_branch, review_round)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('api', 'Test mission', 'Do some work', 'approved', 'code', 'feature/test-branch', 0);

    // No crewService or missionService
    const sentinel = new Sentinel({ db: getDb(), configService, shipsLog: new ShipsLog(getDb()) });

    // Should complete without error and not touch the mission
    await (sentinel as unknown as { prMonitorSweep: () => Promise<void> }).prMonitorSweep();

    const mission = getDb()
      .prepare("SELECT status FROM missions WHERE status = 'approved'")
      .get() as { status: string } | undefined;
    // Mission should remain approved (untouched)
    expect(mission?.status).toBe('approved');
  });
});
