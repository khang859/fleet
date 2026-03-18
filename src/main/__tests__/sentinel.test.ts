import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StarbaseDB } from '../starbase/db';
import { Sentinel } from '../starbase/sentinel';
import { ConfigService } from '../starbase/config-service';
import { rmSync, mkdirSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

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
  execSync('git config user.email "test@test.com" && git config user.name "Test"', { cwd: sectorDir });
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
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
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
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      opts.sectorId,
      opts.status ?? 'active',
      opts.lastLifesign ?? sqliteDatetime(new Date()),
      opts.deadline ?? null,
      opts.pid ?? process.pid,
      opts.commsCountMinute ?? 0,
    );
}

describe('Sentinel', () => {
  it('should mark crew with stale lifesign as lost', async () => {
    const sectorDir = join(TEST_DIR, 'workspace', 'api');
    insertSector('api', sectorDir);

    // Insert crew with lifesign 60 seconds ago (timeout is 30s)
    const staleTime = sqliteDatetime(new Date(Date.now() - 60_000));
    insertCrew({ id: 'crew-1', sectorId: 'api', lastLifesign: staleTime });

    const sentinel = new Sentinel({ db: getDb(), configService });
    await sentinel.runSweep();

    const crew = getDb().prepare('SELECT status FROM crew WHERE id = ?').get('crew-1') as { status: string };
    expect(crew.status).toBe('lost');

    // Should have a ships_log entry
    const logEntry = getDb()
      .prepare("SELECT * FROM ships_log WHERE crew_id = 'crew-1' AND event_type = 'lifesign_lost'")
      .get();
    expect(logEntry).toBeDefined();
  });

  it('should not mark crew with fresh lifesign as lost', async () => {
    const sectorDir = join(TEST_DIR, 'workspace', 'api');
    insertSector('api', sectorDir);

    insertCrew({ id: 'crew-1', sectorId: 'api', lastLifesign: sqliteDatetime(new Date()) });

    const sentinel = new Sentinel({ db: getDb(), configService });
    await sentinel.runSweep();

    const crew = getDb().prepare('SELECT status FROM crew WHERE id = ?').get('crew-1') as { status: string };
    expect(crew.status).toBe('active');
  });

  it('should mark crew with expired deadline for termination', async () => {
    const sectorDir = join(TEST_DIR, 'workspace', 'api');
    insertSector('api', sectorDir);

    // Deadline in the past — use a dead PID so SIGTERM doesn't kill the test runner
    const pastDeadline = sqliteDatetime(new Date(Date.now() - 60_000));
    insertCrew({ id: 'crew-1', sectorId: 'api', deadline: pastDeadline, pid: 99999999 });

    const sentinel = new Sentinel({ db: getDb(), configService });
    await sentinel.runSweep();

    const crew = getDb().prepare('SELECT status FROM crew WHERE id = ?').get('crew-1') as { status: string };
    expect(crew.status).toBe('timeout');
  });

  it('should disable sector with missing root path', async () => {
    insertSector('missing-sector', '/nonexistent/path/that/does/not/exist');
    insertCrew({ id: 'crew-1', sectorId: 'missing-sector' });

    const sentinel = new Sentinel({ db: getDb(), configService });
    await sentinel.runSweep();

    const crew = getDb().prepare('SELECT status FROM crew WHERE id = ?').get('crew-1') as { status: string };
    expect(crew.status).toBe('lost');

    const logEntry = getDb()
      .prepare("SELECT * FROM ships_log WHERE event_type = 'sector_path_missing'")
      .get();
    expect(logEntry).toBeDefined();
  });

  it('should reset comms_count_minute on every 6th sweep', async () => {
    const sectorDir = join(TEST_DIR, 'workspace', 'api');
    insertSector('api', sectorDir);
    insertCrew({ id: 'crew-1', sectorId: 'api', commsCountMinute: 15 });

    const sentinel = new Sentinel({ db: getDb(), configService });

    // Run 5 sweeps — should NOT reset
    for (let i = 0; i < 5; i++) {
      await sentinel.runSweep();
    }
    let crew = getDb().prepare('SELECT comms_count_minute FROM crew WHERE id = ?').get('crew-1') as { comms_count_minute: number };
    expect(crew.comms_count_minute).toBe(15);

    // 6th sweep — should reset
    await sentinel.runSweep();
    crew = getDb().prepare('SELECT comms_count_minute FROM crew WHERE id = ?').get('crew-1') as { comms_count_minute: number };
    expect(crew.comms_count_minute).toBe(0);
  });

  it('should start and stop the sweep interval', async () => {
    const sentinel = new Sentinel({ db: getDb(), configService });
    sentinel.start(100); // 100ms interval for testing
    // Let it run a couple sweeps
    await new Promise((r) => setTimeout(r, 250));
    sentinel.stop();
    // Should not throw after stop
  });
});
