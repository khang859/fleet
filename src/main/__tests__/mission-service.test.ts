import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StarbaseDB } from '../starbase/db';
import { SectorService } from '../starbase/sector-service';
import { MissionService } from '../starbase/mission-service';
import { rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-missions');
const WORKSPACE_DIR = join(TEST_DIR, 'workspace');
const SECTOR_DIR = join(WORKSPACE_DIR, 'api');
const DB_DIR = join(TEST_DIR, 'starbases');

let db: StarbaseDB;
let missionSvc: MissionService;

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(SECTOR_DIR, { recursive: true });
  writeFileSync(join(SECTOR_DIR, 'index.ts'), '');
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

describe('MissionService', () => {
  it('should add a mission', () => {
    const m = missionSvc.addMission({
      sectorId: 'api',
      summary: 'Add auth endpoint',
      prompt: 'Create a /auth endpoint that validates JWT tokens',
    });
    expect(m.id).toBeDefined();
    expect(m.status).toBe('queued');
    expect(m.summary).toBe('Add auth endpoint');
  });

  it('should list missions by sector', () => {
    missionSvc.addMission({ sectorId: 'api', summary: 'M1', prompt: 'P1' });
    missionSvc.addMission({ sectorId: 'api', summary: 'M2', prompt: 'P2' });
    const list = missionSvc.listMissions({ sectorId: 'api' });
    expect(list).toHaveLength(2);
  });

  it('should complete a mission', () => {
    const m = missionSvc.addMission({ sectorId: 'api', summary: 'M1', prompt: 'P1' });
    missionSvc.completeMission(m.id, 'Endpoint created');
    const updated = missionSvc.getMission(m.id);
    expect(updated!.status).toBe('completed');
    expect(updated!.result).toBe('Endpoint created');
    expect(updated!.completed_at).toBeDefined();
  });

  it('should fail a mission', () => {
    const m = missionSvc.addMission({ sectorId: 'api', summary: 'M1', prompt: 'P1' });
    missionSvc.failMission(m.id, 'Test failures');
    const updated = missionSvc.getMission(m.id);
    expect(updated!.status).toBe('failed');
  });

  it('should abort only queued missions', () => {
    const m = missionSvc.addMission({ sectorId: 'api', summary: 'M1', prompt: 'P1' });
    missionSvc.abortMission(m.id);
    expect(missionSvc.getMission(m.id)!.status).toBe('aborted');
  });

  it('should get next mission by priority', () => {
    missionSvc.addMission({ sectorId: 'api', summary: 'Low', prompt: 'P', priority: 10 });
    missionSvc.addMission({ sectorId: 'api', summary: 'High', prompt: 'P', priority: 1 });
    const next = missionSvc.nextMission('api');
    expect(next!.summary).toBe('High');
  });

  it('should skip missions with unmet dependencies', () => {
    const m1 = missionSvc.addMission({ sectorId: 'api', summary: 'M1', prompt: 'P1' });
    missionSvc.addMission({
      sectorId: 'api',
      summary: 'M2',
      prompt: 'P2',
      dependsOnMissionId: m1.id,
    });
    // M2 depends on M1 which is still queued — nextMission should return M1
    const next = missionSvc.nextMission('api');
    expect(next!.summary).toBe('M1');
  });

  it('should store and return mission type', () => {
    const m = missionSvc.addMission({
      sectorId: 'api',
      summary: 'Research auth patterns',
      prompt: 'Investigate auth patterns in the codebase',
      type: 'research',
    });
    expect(m.type).toBe('research');
  });

  it('should default mission type to code', () => {
    const m = missionSvc.addMission({
      sectorId: 'api',
      summary: 'Add endpoint',
      prompt: 'Create a /users endpoint',
    });
    expect(m.type).toBe('code');
  });
});
