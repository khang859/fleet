import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StarbaseDB } from '../starbase/db';
import { runReconciliation } from '../starbase/reconciliation';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-reconciliation');

let starbaseDb: StarbaseDB;

function getDb() {
  return starbaseDb.getDb();
}

/** Convert JS Date to SQLite datetime format */
function sqliteDatetime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });

  const sectorDir = join(TEST_DIR, 'workspace', 'api');
  mkdirSync(sectorDir, { recursive: true });
  writeFileSync(join(sectorDir, 'index.ts'), '');
  execSync('git init && git checkout -b main', { cwd: sectorDir });
  execSync('git config user.email "test@test.com" && git config user.name "Test"', { cwd: sectorDir });
  execSync('git add -A && git commit -m "init"', { cwd: sectorDir });

  starbaseDb = new StarbaseDB(join(TEST_DIR, 'workspace'), join(TEST_DIR, 'starbases'));
  starbaseDb.open();
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

function insertCrew(opts: {
  id: string;
  sectorId: string;
  status?: string;
  pid?: number;
  worktreePath?: string;
  worktreeBranch?: string;
  createdAt?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO crew (id, sector_id, status, pid, worktree_path, worktree_branch, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      opts.sectorId,
      opts.status ?? 'active',
      opts.pid ?? 99999999,
      opts.worktreePath ?? null,
      opts.worktreeBranch ?? null,
      opts.createdAt ?? sqliteDatetime(new Date()),
    );
}

function insertMission(opts: {
  sectorId: string;
  status?: string;
  crewId?: string;
}): number {
  const result = getDb()
    .prepare(
      `INSERT INTO missions (sector_id, summary, prompt, status, crew_id) VALUES (?, 'test', 'test prompt', ?, ?)`,
    )
    .run(opts.sectorId, opts.status ?? 'queued', opts.crewId ?? null);
  return result.lastInsertRowid as number;
}

describe('runReconciliation', () => {
  it('should mark active crew with dead PID as lost', async () => {
    const sectorDir = join(TEST_DIR, 'workspace', 'api');
    insertSector('api', sectorDir);
    // PID 99999999 should not exist
    insertCrew({ id: 'crew-dead', sectorId: 'api', status: 'active', pid: 99999999 });

    const summary = await runReconciliation({
      db: getDb(),
      starbaseId: starbaseDb.getStarbaseId(),
      worktreeBasePath: join(TEST_DIR, 'worktrees'),
    });

    expect(summary.lostCrew).toContain('crew-dead');
    const crew = getDb().prepare('SELECT status FROM crew WHERE id = ?').get('crew-dead') as { status: string };
    expect(crew.status).toBe('lost');
  });

  it('should treat active crew with alive PID but old created_at as stale', async () => {
    const sectorDir = join(TEST_DIR, 'workspace', 'api');
    insertSector('api', sectorDir);
    // Use our own PID (alive) but created 25 hours ago
    const oldTime = sqliteDatetime(new Date(Date.now() - 25 * 60 * 60 * 1000));
    insertCrew({ id: 'crew-stale', sectorId: 'api', status: 'active', pid: process.pid, createdAt: oldTime });

    const summary = await runReconciliation({
      db: getDb(),
      starbaseId: starbaseDb.getStarbaseId(),
      worktreeBasePath: join(TEST_DIR, 'worktrees'),
    });

    expect(summary.lostCrew).toContain('crew-stale');
  });

  it('should clean up orphaned worktree directories', async () => {
    const sectorDir = join(TEST_DIR, 'workspace', 'api');
    insertSector('api', sectorDir);

    // Create an orphaned worktree directory (not tracked in crew table)
    const orphanDir = join(TEST_DIR, 'worktrees', starbaseDb.getStarbaseId(), 'orphan-crew');
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(orphanDir, 'file.txt'), 'orphan');

    const summary = await runReconciliation({
      db: getDb(),
      starbaseId: starbaseDb.getStarbaseId(),
      worktreeBasePath: join(TEST_DIR, 'worktrees'),
    });

    expect(summary.orphanedWorktrees).toContain(orphanDir);
  });

  it('should reset active missions with lost crew to queued', async () => {
    const sectorDir = join(TEST_DIR, 'workspace', 'api');
    insertSector('api', sectorDir);
    insertCrew({ id: 'crew-dead', sectorId: 'api', status: 'active', pid: 99999999 });
    const missionId = insertMission({ sectorId: 'api', status: 'active', crewId: 'crew-dead' });

    const summary = await runReconciliation({
      db: getDb(),
      starbaseId: starbaseDb.getStarbaseId(),
      worktreeBasePath: join(TEST_DIR, 'worktrees'),
    });

    expect(summary.requeuedMissions).toContain(missionId);
    const mission = getDb().prepare('SELECT status FROM missions WHERE id = ?').get(missionId) as { status: string };
    expect(mission.status).toBe('queued');
  });

  it('should not touch crew that are already complete', async () => {
    const sectorDir = join(TEST_DIR, 'workspace', 'api');
    insertSector('api', sectorDir);
    insertCrew({ id: 'crew-done', sectorId: 'api', status: 'complete', pid: 99999999 });

    const summary = await runReconciliation({
      db: getDb(),
      starbaseId: starbaseDb.getStarbaseId(),
      worktreeBasePath: join(TEST_DIR, 'worktrees'),
    });

    expect(summary.lostCrew).not.toContain('crew-done');
    const crew = getDb().prepare('SELECT status FROM crew WHERE id = ?').get('crew-done') as { status: string };
    expect(crew.status).toBe('complete');
  });

  it('should remove a lingering worktree for errored crew without a push-pending mission', async () => {
    const sectorDir = join(TEST_DIR, 'workspace', 'api');
    insertSector('api', sectorDir);

    const worktreeDir = join(TEST_DIR, 'worktrees', starbaseDb.getStarbaseId(), 'crew-errored');
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(join(worktreeDir, 'leftover.ts'), '// orphan');

    insertCrew({ id: 'crew-errored', sectorId: 'api', status: 'error', worktreePath: worktreeDir });
    insertMission({ sectorId: 'api', status: 'failed', crewId: 'crew-errored' });

    const summary = await runReconciliation({
      db: getDb(),
      starbaseId: starbaseDb.getStarbaseId(),
      worktreeBasePath: join(TEST_DIR, 'worktrees'),
    });

    expect(summary.cleanedErroredCrew).toContain('crew-errored');
    expect(existsSync(worktreeDir)).toBe(false);
  });

  it('should NOT remove a worktree for errored crew with a push-pending mission', async () => {
    const sectorDir = join(TEST_DIR, 'workspace', 'api');
    insertSector('api', sectorDir);

    const worktreeDir = join(TEST_DIR, 'worktrees', starbaseDb.getStarbaseId(), 'crew-push-pending');
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(join(worktreeDir, 'leftover.ts'), '// needs push');

    insertCrew({ id: 'crew-push-pending', sectorId: 'api', status: 'error', worktreePath: worktreeDir });
    insertMission({ sectorId: 'api', status: 'push-pending', crewId: 'crew-push-pending' });

    const summary = await runReconciliation({
      db: getDb(),
      starbaseId: starbaseDb.getStarbaseId(),
      worktreeBasePath: join(TEST_DIR, 'worktrees'),
    });

    expect(summary.cleanedErroredCrew).not.toContain('crew-push-pending');
    expect(existsSync(worktreeDir)).toBe(true);
  });
});
