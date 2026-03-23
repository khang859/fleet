import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CrewService, InsufficientMemoryError } from '../starbase/crew-service';
import { Hull } from '../starbase/hull';
import { StarbaseDB } from '../starbase/db';
import { SectorService } from '../starbase/sector-service';
import { MissionService } from '../starbase/mission-service';
import { WorktreeManager } from '../starbase/worktree-manager';
import { ConfigService } from '../starbase/config-service';
import { rmSync, mkdirSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-crew-svc');

let db: StarbaseDB;
let crewSvc: CrewService;

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  const wsDir = join(TEST_DIR, 'workspace');
  const sectorDir = join(wsDir, 'api');
  mkdirSync(sectorDir, { recursive: true });
  writeFileSync(join(sectorDir, 'index.ts'), '');
  execSync('git init && git checkout -b main', { cwd: sectorDir });
  execSync('git config user.email "test@test.com" && git config user.name "Test"', {
    cwd: sectorDir
  });
  writeFileSync(join(sectorDir, 'README.md'), '# Test');
  execSync('git add -A && git commit -m "initial"', { cwd: sectorDir });

  const dbDir = join(TEST_DIR, 'starbases');
  db = new StarbaseDB(wsDir, dbDir);
  db.open();

  const sectorSvc = new SectorService(db.getDb(), wsDir);
  sectorSvc.addSector({ path: 'api' });

  const missionSvc = new MissionService(db.getDb());
  const configSvc = new ConfigService(db.getDb());
  const wtMgr = new WorktreeManager(join(TEST_DIR, 'worktrees'));

  crewSvc = new CrewService({
    db: db.getDb(),
    starbaseId: db.getStarbaseId(),
    sectorService: sectorSvc,
    missionService: missionSvc,
    configService: configSvc,
    worktreeManager: wtMgr
  });
});

afterEach(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('CrewService', () => {
  it('should generate a crew ID with sector slug and random hex', () => {
    const id = crewSvc.generateCrewId('api');
    expect(id).toMatch(/^api-code-[a-f0-9]{4}$/);
  });

  it('should generate a crew ID with the specified mission type', () => {
    const id = crewSvc.generateCrewId('fleet', 'research');
    expect(id).toMatch(/^fleet-research-[a-f0-9]{4}$/);
  });

  it('should list crew (empty initially)', () => {
    expect(crewSvc.listCrew()).toHaveLength(0);
  });

  it('should dismiss a terminal crew record when no hull is in memory (post-restart recall)', () => {
    const rawDb = db.getDb();
    rawDb
      .prepare('INSERT INTO crew (id, sector_id, status) VALUES (?, ?, ?)')
      .run('fleet-crew-old', 'api', 'error');

    crewSvc.recallCrew('fleet-crew-old');

    const row = rawDb.prepare('SELECT status FROM crew WHERE id = ?').get('fleet-crew-old') as {
      status: string;
    };
    expect(row.status).toBe('dismissed');
  });

  it('should mark active crew with no hull as lost when recalled post-restart', () => {
    const rawDb = db.getDb();
    rawDb
      .prepare('INSERT INTO crew (id, sector_id, status) VALUES (?, ?, ?)')
      .run('fleet-crew-active', 'api', 'active');

    crewSvc.recallCrew('fleet-crew-active');

    const row = rawDb.prepare('SELECT status FROM crew WHERE id = ?').get('fleet-crew-active') as {
      status: string;
    };
    expect(row.status).toBe('lost');
  });

  it('should throw InsufficientMemoryError and queue mission when free RAM is below threshold', async () => {
    // Set an impossibly high threshold so any real machine will fail the check
    const configSvc = crewSvc['deps'].configService;
    configSvc.set('min_deploy_free_memory_gb', 999999);

    // Create a mission first (mission-first workflow)
    const missionSvc = crewSvc['deps'].missionService;
    const mission = missionSvc.addMission({
      sectorId: 'api',
      summary: 'Test mission',
      prompt: 'do something'
    });

    await expect(
      crewSvc.deployCrew({ sectorId: 'api', prompt: 'do something', missionId: mission.id })
    ).rejects.toBeInstanceOf(InsufficientMemoryError);

    // Mission should be queued (not failed)
    const missions = db
      .getDb()
      .prepare("SELECT status FROM missions WHERE sector_id = 'api'")
      .all() as Array<{ status: string }>;
    expect(missions).toHaveLength(1);
    expect(missions[0].status).toBe('queued');
  });

  it('should reject deployCrew without a missionId', async () => {
    await expect(
      crewSvc.deployCrew({ sectorId: 'api', prompt: 'do something', missionId: undefined as any })
    ).rejects.toThrow('requires a missionId');
  });

  it('should reject deployCrew with an empty prompt', async () => {
    const missionSvc = crewSvc['deps'].missionService;
    const mission = missionSvc.addMission({
      sectorId: 'api',
      summary: 'Test',
      prompt: 'real prompt'
    });

    await expect(
      crewSvc.deployCrew({ sectorId: 'api', prompt: '', missionId: mission.id })
    ).rejects.toThrow('empty prompt');
  });

  it('should throw when deploying repair mission without prBranch', async () => {
    const missionSvc = crewSvc['deps'].missionService;
    const mission = missionSvc.addMission({
      sectorId: 'api',
      summary: 'Fix CI',
      prompt: 'Fix it',
      type: 'repair'
    });

    await expect(
      crewSvc.deployCrew({
        sectorId: 'api',
        missionId: mission.id,
        prompt: 'Fix it',
        type: 'repair'
        // intentionally no prBranch
      })
    ).rejects.toThrow('Repair mission');
  });
});

describe('CrewService hull.start() failure handling', () => {
  let crewSvc2: CrewService;

  beforeEach(() => {
    const wsDir = join(TEST_DIR, 'workspace');
    const db2 = db; // reuse the same DB from outer beforeEach

    const sectorSvc = new SectorService(db2.getDb(), wsDir);
    const missionSvc = new MissionService(db2.getDb());
    const configSvc = new ConfigService(db2.getDb());
    // Disable the memory gate so tests aren't blocked by available RAM
    configSvc.set('min_deploy_free_memory_gb', 0);
    const wtMgr = new WorktreeManager(join(TEST_DIR, 'worktrees'));

    crewSvc2 = new CrewService({
      db: db2.getDb(),
      starbaseId: db2.getStarbaseId(),
      sectorService: sectorSvc,
      missionService: missionSvc,
      configService: configSvc,
      worktreeManager: wtMgr
    });
  });

  it('should clean up hull from map when hull.start() throws', async () => {
    const missionSvc = crewSvc2['deps'].missionService;
    const mission = missionSvc.addMission({
      sectorId: 'api',
      summary: 'Test',
      prompt: 'do something'
    });

    const startSpy = vi.spyOn(Hull.prototype, 'start').mockImplementationOnce(() => {
      throw new Error('concurrent deploy — mission already claimed');
    });

    await expect(
      crewSvc2.deployCrew({ sectorId: 'api', missionId: mission.id, prompt: 'do something' })
    ).rejects.toThrow('concurrent deploy');

    expect(crewSvc2['hulls'].size).toBe(0);
    startSpy.mockRestore();
  });

  it('should write deploy_failed comms when hull.start() throws', async () => {
    const missionSvc = crewSvc2['deps'].missionService;
    const mission = missionSvc.addMission({
      sectorId: 'api',
      summary: 'Test',
      prompt: 'do something'
    });

    const startSpy = vi.spyOn(Hull.prototype, 'start').mockImplementationOnce(() => {
      throw new Error('concurrent deploy — mission already claimed');
    });

    await expect(
      crewSvc2.deployCrew({ sectorId: 'api', missionId: mission.id, prompt: 'do something' })
    ).rejects.toThrow('concurrent deploy');

    const commsRow = db
      .getDb()
      .prepare<
        [],
        { type: string }
      >('SELECT type FROM comms WHERE type = ? ORDER BY id DESC LIMIT 1')
      .get('deploy_failed');
    expect(commsRow?.type).toBe('deploy_failed');
    startSpy.mockRestore();
  });
});
