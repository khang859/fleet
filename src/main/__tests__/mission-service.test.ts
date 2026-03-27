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
      prompt: 'Create a /auth endpoint that validates JWT tokens'
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
    expect(updated!.status).toBe('awaiting-cargo-check');
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
      dependsOnMissionIds: [m1.id]
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
      type: 'research'
    });
    expect(m.type).toBe('research');
  });

  it('should default mission type to code', () => {
    const m = missionSvc.addMission({
      sectorId: 'api',
      summary: 'Add endpoint',
      prompt: 'Create a /users endpoint'
    });
    expect(m.type).toBe('code');
  });

  it('should store original_mission_id when provided', () => {
    const parent = missionSvc.addMission({ sectorId: 'api', summary: 'Original', prompt: 'P' });
    const repair = missionSvc.addMission({
      sectorId: 'api',
      summary: 'Fix CI',
      prompt: 'Fix it',
      originalMissionId: parent.id
    });
    const row = missionSvc.getMission(repair.id);
    expect(row!.original_mission_id).toBe(parent.id);
  });
});

describe('MissionService — dependencies', () => {
  it('getDependencies returns [] when no dependencies', () => {
    const m = missionSvc.addMission({
      sectorId: 'api',
      summary: 'Code',
      prompt: 'P',
      type: 'code'
    });
    expect(missionSvc.getDependencies(m.id)).toEqual([]);
  });

  it('getDependents returns [] when no dependents', () => {
    const r = missionSvc.addMission({
      sectorId: 'api',
      summary: 'Research',
      prompt: 'P',
      type: 'research'
    });
    expect(missionSvc.getDependents(r.id)).toEqual([]);
  });

  it('addMission with dependsOnMissionIds links via junction table', () => {
    const r1 = missionSvc.addMission({
      sectorId: 'api',
      summary: 'R1',
      prompt: 'P',
      type: 'research'
    });
    const r2 = missionSvc.addMission({
      sectorId: 'api',
      summary: 'R2',
      prompt: 'P',
      type: 'research'
    });
    const code = missionSvc.addMission({
      sectorId: 'api',
      summary: 'Code',
      prompt: 'P',
      type: 'code',
      dependsOnMissionIds: [r1.id, r2.id]
    });
    const deps = missionSvc.getDependencies(code.id);
    expect(deps).toHaveLength(2);
    expect(deps.map((d) => d.id)).toContain(r1.id);
    expect(deps.map((d) => d.id)).toContain(r2.id);
  });

  it('getDependents returns code missions that depend on a research mission', () => {
    const r = missionSvc.addMission({
      sectorId: 'api',
      summary: 'R',
      prompt: 'P',
      type: 'research'
    });
    const c1 = missionSvc.addMission({
      sectorId: 'api',
      summary: 'C1',
      prompt: 'P',
      type: 'code',
      dependsOnMissionIds: [r.id]
    });
    const c2 = missionSvc.addMission({
      sectorId: 'api',
      summary: 'C2',
      prompt: 'P',
      type: 'code',
      dependsOnMissionIds: [r.id]
    });
    const dependents = missionSvc.getDependents(r.id);
    expect(dependents).toHaveLength(2);
    expect(dependents.map((d) => d.id)).toContain(c1.id);
    expect(dependents.map((d) => d.id)).toContain(c2.id);
  });
});

describe('MissionService — nextMission with junction table', () => {
  it('queues code mission until research dependency completes', () => {
    const r = missionSvc.addMission({
      sectorId: 'api',
      summary: 'R',
      prompt: 'P',
      type: 'research'
    });
    missionSvc.activateMission(r.id, 'crew-r'); // simulate research deployed
    missionSvc.addMission({
      sectorId: 'api',
      summary: 'C',
      prompt: 'P',
      type: 'code',
      dependsOnMissionIds: [r.id]
    });
    // Research is active (not completed) — code mission should not be next
    expect(missionSvc.nextMission('api')).toBeUndefined();
  });

  it('unblocks code mission when research dependency completes', () => {
    const r = missionSvc.addMission({
      sectorId: 'api',
      summary: 'R',
      prompt: 'P',
      type: 'research'
    });
    missionSvc.activateMission(r.id, 'crew-r');
    const code = missionSvc.addMission({
      sectorId: 'api',
      summary: 'C',
      prompt: 'P',
      type: 'code',
      dependsOnMissionIds: [r.id]
    });
    missionSvc.completeMission(r.id, 'done');
    expect(missionSvc.nextMission('api')?.id).toBe(code.id);
  });

  it('unblocks code mission when research dependency fails (terminal state)', () => {
    const r = missionSvc.addMission({
      sectorId: 'api',
      summary: 'R',
      prompt: 'P',
      type: 'research'
    });
    missionSvc.activateMission(r.id, 'crew-r');
    const code = missionSvc.addMission({
      sectorId: 'api',
      summary: 'C',
      prompt: 'P',
      type: 'code',
      dependsOnMissionIds: [r.id]
    });
    missionSvc.failMission(r.id, 'error');
    expect(missionSvc.nextMission('api')?.id).toBe(code.id);
  });

  it('unblocks code mission when research dependency is aborted', () => {
    const r = missionSvc.addMission({
      sectorId: 'api',
      summary: 'R',
      prompt: 'P',
      type: 'research'
    });
    const code = missionSvc.addMission({
      sectorId: 'api',
      summary: 'C',
      prompt: 'P',
      type: 'code',
      dependsOnMissionIds: [r.id]
    });
    missionSvc.abortMission(r.id);
    expect(missionSvc.nextMission('api')?.id).toBe(code.id);
  });

  it('stays blocked when one of two dependencies is still active', () => {
    const r1 = missionSvc.addMission({
      sectorId: 'api',
      summary: 'R1',
      prompt: 'P',
      type: 'research'
    });
    const r2 = missionSvc.addMission({
      sectorId: 'api',
      summary: 'R2',
      prompt: 'P',
      type: 'research'
    });
    missionSvc.activateMission(r1.id, 'crew-r1');
    missionSvc.activateMission(r2.id, 'crew-r2');
    missionSvc.addMission({
      sectorId: 'api',
      summary: 'C',
      prompt: 'P',
      type: 'code',
      dependsOnMissionIds: [r1.id, r2.id]
    });
    missionSvc.completeMission(r1.id, 'done');
    // r2 still active — code mission blocked
    expect(missionSvc.nextMission('api')).toBeUndefined();
  });

  it('mission with no dependencies is immediately eligible', () => {
    const m = missionSvc.addMission({
      sectorId: 'api',
      summary: 'Simple',
      prompt: 'P',
      type: 'code'
    });
    expect(missionSvc.nextMission('api')?.id).toBe(m.id);
  });
});
