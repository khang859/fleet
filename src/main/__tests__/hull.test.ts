import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hull, HullOpts } from '../starbase/hull';
import { StarbaseDB } from '../starbase/db';
import { SectorService } from '../starbase/sector-service';
import { MissionService } from '../starbase/mission-service';
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-hull');
const WORKSPACE_DIR = join(TEST_DIR, 'workspace');
const SECTOR_DIR = join(WORKSPACE_DIR, 'api');
const DB_DIR = join(TEST_DIR, 'starbases');
const WORKTREE_DIR = join(TEST_DIR, 'worktrees', 'test-sb', 'hull-crew');

let db: StarbaseDB;
let missionSvc: MissionService;

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(SECTOR_DIR, { recursive: true });
  writeFileSync(join(SECTOR_DIR, 'index.ts'), '');
  // Init git repo
  execSync('git init && git checkout -b main', { cwd: SECTOR_DIR });
  writeFileSync(join(SECTOR_DIR, 'README.md'), '# Test');
  execSync('git add -A && git commit -m "initial"', { cwd: SECTOR_DIR });

  db = new StarbaseDB(WORKSPACE_DIR, DB_DIR);
  db.open();
  const sectorSvc = new SectorService(db.getDb(), WORKSPACE_DIR);
  sectorSvc.addSector({ path: 'api' });
  missionSvc = new MissionService(db.getDb());
});

afterEach(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Hull', () => {
  it('should construct with required opts', () => {
    const mission = missionSvc.addMission({ sectorId: 'api', summary: 'Test', prompt: 'echo hello' });
    const hull = new Hull({
      crewId: 'hull-crew',
      sectorId: 'api',
      missionId: mission.id,
      prompt: 'echo hello',
      worktreePath: WORKTREE_DIR,
      worktreeBranch: 'crew/hull-crew',
      baseBranch: 'main',
      sectorPath: SECTOR_DIR,
      db: db.getDb(),
    });
    expect(hull).toBeDefined();
    expect(hull.getStatus()).toBe('pending');
  });

  it('should track output in ring buffer', () => {
    const mission = missionSvc.addMission({ sectorId: 'api', summary: 'Test', prompt: 'echo hello' });
    const hull = new Hull({
      crewId: 'hull-crew',
      sectorId: 'api',
      missionId: mission.id,
      prompt: 'echo hello',
      worktreePath: WORKTREE_DIR,
      worktreeBranch: 'crew/hull-crew',
      baseBranch: 'main',
      sectorPath: SECTOR_DIR,
      db: db.getDb(),
    });
    // Test the ring buffer directly
    hull.appendOutput('line 1\n');
    hull.appendOutput('line 2\n');
    expect(hull.getOutputBuffer()).toContain('line 1');
    expect(hull.getOutputBuffer()).toContain('line 2');
  });
});
