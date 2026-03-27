import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StarbaseDB } from '../starbase/db';
import { SectorService } from '../starbase/sector-service';
import { SupplyRouteService } from '../starbase/supply-route-service';
import { MissionService } from '../starbase/mission-service';
import { ConfigService } from '../starbase/config-service';
import { CargoService } from '../starbase/cargo-service';
import { rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-cargo-service');
const WORKSPACE_DIR = join(TEST_DIR, 'workspace');
const DB_DIR = join(TEST_DIR, 'starbases');

let db: StarbaseDB;
let sectorSvc: SectorService;
let routeSvc: SupplyRouteService;
let missionSvc: MissionService;
let configSvc: ConfigService;
let cargoSvc: CargoService;

function createSectorDir(name: string): void {
  const dir = join(WORKSPACE_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.ts'), '');
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(WORKSPACE_DIR, { recursive: true });
  createSectorDir('api');
  createSectorDir('web');
  createSectorDir('shared');
  createSectorDir('core');
  db = new StarbaseDB(WORKSPACE_DIR, DB_DIR);
  db.open();

  const rawDb = db.getDb();
  sectorSvc = new SectorService(rawDb, WORKSPACE_DIR);
  routeSvc = new SupplyRouteService(rawDb);
  missionSvc = new MissionService(rawDb);
  configSvc = new ConfigService(rawDb);
  cargoSvc = new CargoService(rawDb, routeSvc, configSvc);

  // Create sectors for foreign key constraints
  sectorSvc.addSector({ path: 'api' });
  sectorSvc.addSector({ path: 'web' });
  sectorSvc.addSector({ path: 'shared' });
  sectorSvc.addSector({ path: 'core' });
});

afterEach(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('CargoService', () => {
  describe('produceCargo', () => {
    it('should insert cargo with default verified=true', () => {
      const cargo = cargoSvc.produceCargo({
        sectorId: 'api',
        type: 'diff',
        manifest: 'some changes'
      });
      expect(cargo.id).toBeDefined();
      expect(cargo.sector_id).toBe('api');
      expect(cargo.type).toBe('diff');
      expect(cargo.manifest).toBe('some changes');
      expect(cargo.verified).toBe(1);
    });

    it('should associate cargo with a crew and mission', () => {
      const mission = missionSvc.addMission({
        sectorId: 'api',
        summary: 'test mission',
        prompt: 'do something'
      });
      const cargo = cargoSvc.produceCargo({
        crewId: 'api-crew-1234',
        missionId: mission.id,
        sectorId: 'api',
        type: 'artifact',
        manifest: '{"file": "index.ts"}'
      });
      expect(cargo.crew_id).toBe('api-crew-1234');
      expect(cargo.mission_id).toBe(mission.id);
      expect(cargo.verified).toBe(1);
    });

    it('should set verified=false when mission has error status', () => {
      const mission = missionSvc.addMission({
        sectorId: 'api',
        summary: 'fail mission',
        prompt: 'will fail'
      });
      missionSvc.setStatus(mission.id, 'error');

      const cargo = cargoSvc.produceCargo({
        missionId: mission.id,
        sectorId: 'api',
        type: 'partial'
      });
      expect(cargo.verified).toBe(0);
    });

    it('should set verified=false when mission has lost status', () => {
      const mission = missionSvc.addMission({
        sectorId: 'api',
        summary: 'lost mission',
        prompt: 'will be lost'
      });
      missionSvc.setStatus(mission.id, 'lost');

      const cargo = cargoSvc.produceCargo({
        missionId: mission.id,
        sectorId: 'api'
      });
      expect(cargo.verified).toBe(0);
    });

    it('should set verified=false when mission has timeout status', () => {
      const mission = missionSvc.addMission({
        sectorId: 'api',
        summary: 'timeout mission',
        prompt: 'will timeout'
      });
      missionSvc.setStatus(mission.id, 'timeout');

      const cargo = cargoSvc.produceCargo({
        missionId: mission.id,
        sectorId: 'api'
      });
      expect(cargo.verified).toBe(0);
    });

    it('should set verified=false when mission has escalated status', () => {
      const mission = missionSvc.addMission({
        sectorId: 'api',
        summary: 'escalated mission',
        prompt: 'will escalate'
      });
      missionSvc.setStatus(mission.id, 'escalated');

      const cargo = cargoSvc.produceCargo({
        missionId: mission.id,
        sectorId: 'api',
        type: 'recovered_cargo'
      });
      expect(cargo.verified).toBe(0);
    });

    it('should keep verified=true for completed missions', () => {
      const mission = missionSvc.addMission({
        sectorId: 'api',
        summary: 'good mission',
        prompt: 'will succeed'
      });
      missionSvc.completeMission(mission.id, 'done');

      const cargo = cargoSvc.produceCargo({
        missionId: mission.id,
        sectorId: 'api'
      });
      expect(cargo.verified).toBe(1);
    });

    it('should handle cargo without missionId (verified=true)', () => {
      const cargo = cargoSvc.produceCargo({
        sectorId: 'api',
        type: 'manual'
      });
      expect(cargo.verified).toBe(1);
    });
  });

  describe('listCargo', () => {
    it('should list all cargo when no filters', () => {
      cargoSvc.produceCargo({ sectorId: 'api', type: 'diff' });
      cargoSvc.produceCargo({ sectorId: 'web', type: 'artifact' });
      const all = cargoSvc.listCargo();
      expect(all).toHaveLength(2);
    });

    it('should filter by sectorId', () => {
      cargoSvc.produceCargo({ sectorId: 'api', type: 'diff' });
      cargoSvc.produceCargo({ sectorId: 'web', type: 'artifact' });
      const apiCargo = cargoSvc.listCargo({ sectorId: 'api' });
      expect(apiCargo).toHaveLength(1);
      expect(apiCargo[0].sector_id).toBe('api');
    });

    it('should filter by crewId', () => {
      cargoSvc.produceCargo({ sectorId: 'api', crewId: 'crew-a' });
      cargoSvc.produceCargo({ sectorId: 'api', crewId: 'crew-b' });
      const result = cargoSvc.listCargo({ crewId: 'crew-a' });
      expect(result).toHaveLength(1);
      expect(result[0].crew_id).toBe('crew-a');
    });

    it('should filter by type', () => {
      cargoSvc.produceCargo({ sectorId: 'api', type: 'diff' });
      cargoSvc.produceCargo({ sectorId: 'api', type: 'artifact' });
      const result = cargoSvc.listCargo({ type: 'diff' });
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('diff');
    });

    it('should filter by verified status', () => {
      const mission = missionSvc.addMission({
        sectorId: 'api',
        summary: 'fail',
        prompt: 'x'
      });
      missionSvc.setStatus(mission.id, 'error');
      cargoSvc.produceCargo({ sectorId: 'api', missionId: mission.id });
      cargoSvc.produceCargo({ sectorId: 'api', type: 'good' });

      const verified = cargoSvc.listCargo({ verified: true });
      expect(verified).toHaveLength(1);
      expect(verified[0].verified).toBe(1);

      const unverified = cargoSvc.listCargo({ verified: false });
      expect(unverified).toHaveLength(1);
      expect(unverified[0].verified).toBe(0);
    });

    it('should combine multiple filters', () => {
      cargoSvc.produceCargo({ sectorId: 'api', crewId: 'crew-a', type: 'diff' });
      cargoSvc.produceCargo({ sectorId: 'api', crewId: 'crew-a', type: 'artifact' });
      cargoSvc.produceCargo({ sectorId: 'web', crewId: 'crew-a', type: 'diff' });

      const result = cargoSvc.listCargo({ sectorId: 'api', crewId: 'crew-a', type: 'diff' });
      expect(result).toHaveLength(1);
    });
  });

  describe('getUndelivered', () => {
    it('should return cargo from upstream sectors', () => {
      // shared -> api (shared is upstream of api)
      routeSvc.addRoute({ upstreamSectorId: 'shared', downstreamSectorId: 'api' });

      cargoSvc.produceCargo({ sectorId: 'shared', type: 'diff', manifest: 'shared changes' });

      const undelivered = cargoSvc.getUndelivered('api');
      expect(undelivered).toHaveLength(1);
      expect(undelivered[0].sector_id).toBe('shared');
    });

    it('should return empty when no upstream routes', () => {
      cargoSvc.produceCargo({ sectorId: 'api', type: 'diff' });
      const undelivered = cargoSvc.getUndelivered('api');
      expect(undelivered).toHaveLength(0);
    });

    it('should return cargo from multiple upstream sectors', () => {
      routeSvc.addRoute({ upstreamSectorId: 'shared', downstreamSectorId: 'api' });
      routeSvc.addRoute({ upstreamSectorId: 'core', downstreamSectorId: 'api' });

      cargoSvc.produceCargo({ sectorId: 'shared', type: 'diff' });
      cargoSvc.produceCargo({ sectorId: 'core', type: 'artifact' });

      const undelivered = cargoSvc.getUndelivered('api');
      expect(undelivered).toHaveLength(2);
    });

    it('should exclude unverified cargo when forward_failed_cargo is false (default)', () => {
      routeSvc.addRoute({ upstreamSectorId: 'shared', downstreamSectorId: 'api' });

      const mission = missionSvc.addMission({
        sectorId: 'shared',
        summary: 'bad',
        prompt: 'x'
      });
      missionSvc.setStatus(mission.id, 'error');

      cargoSvc.produceCargo({ sectorId: 'shared', missionId: mission.id, type: 'partial' });
      cargoSvc.produceCargo({ sectorId: 'shared', type: 'good' });

      const undelivered = cargoSvc.getUndelivered('api');
      expect(undelivered).toHaveLength(1);
      expect(undelivered[0].verified).toBe(1);
    });

    it('should include unverified cargo when forward_failed_cargo is true', () => {
      configSvc.set('forward_failed_cargo', true);
      routeSvc.addRoute({ upstreamSectorId: 'shared', downstreamSectorId: 'api' });

      const mission = missionSvc.addMission({
        sectorId: 'shared',
        summary: 'bad',
        prompt: 'x'
      });
      missionSvc.setStatus(mission.id, 'error');

      cargoSvc.produceCargo({ sectorId: 'shared', missionId: mission.id, type: 'partial' });
      cargoSvc.produceCargo({ sectorId: 'shared', type: 'good' });

      const undelivered = cargoSvc.getUndelivered('api');
      expect(undelivered).toHaveLength(2);
    });

    it('should only return cargo after last deployment in target sector', () => {
      routeSvc.addRoute({ upstreamSectorId: 'shared', downstreamSectorId: 'api' });

      const rawDb = db.getDb();

      // Produce old cargo
      cargoSvc.produceCargo({ sectorId: 'shared', type: 'old-diff' });

      // Simulate a completed deployment in api sector with a timestamp after the cargo
      rawDb
        .prepare(
          `INSERT INTO crew (id, sector_id, status, updated_at)
           VALUES ('api-crew-old', 'api', 'complete', datetime('now'))`
        )
        .run();

      // Produce new cargo after deployment (with a future timestamp)
      rawDb
        .prepare(
          `INSERT INTO cargo (sector_id, type, manifest, verified, created_at)
           VALUES ('shared', 'new-diff', 'new changes', 1, datetime('now', '+1 second'))`
        )
        .run();

      const undelivered = cargoSvc.getUndelivered('api');
      expect(undelivered).toHaveLength(1);
      expect(undelivered[0].type).toBe('new-diff');
    });

    it('should not include cargo from non-upstream sectors', () => {
      routeSvc.addRoute({ upstreamSectorId: 'shared', downstreamSectorId: 'api' });

      cargoSvc.produceCargo({ sectorId: 'shared', type: 'upstream' });
      cargoSvc.produceCargo({ sectorId: 'web', type: 'not-upstream' });

      const undelivered = cargoSvc.getUndelivered('api');
      expect(undelivered).toHaveLength(1);
      expect(undelivered[0].sector_id).toBe('shared');
    });
  });

  describe('sendCargo', () => {
    it('creates cargo record with explicit sourceType', async () => {
      const mission = missionSvc.addMission({
        sectorId: 'api',
        summary: 'test mission',
        prompt: 'do something'
      });

      const cargo = await cargoSvc.sendCargo({
        crewId: 'api-crew-1234',
        missionId: mission.id,
        sectorId: 'api',
        type: 'report',
        content: '# Report\nSome content here.',
        starbaseId: 'test-starbase'
      });

      expect(cargo.id).toBeDefined();
      expect(cargo.crew_id).toBe('api-crew-1234');
      expect(cargo.mission_id).toBe(mission.id);
      expect(cargo.sector_id).toBe('api');
      expect(cargo.type).toBe('report');
      expect(cargo.verified).toBe(1);

      const manifest = JSON.parse(cargo.manifest!);
      expect(manifest.sourceType).toBe('explicit');
      expect(manifest.title).toBe('report');
      expect(manifest.size).toBeGreaterThan(0);
    });

    it('transitions mission from awaiting-cargo-check to completed', async () => {
      const mission = missionSvc.addMission({
        sectorId: 'api',
        summary: 'awaiting cargo',
        prompt: 'deliver cargo'
      });
      missionSvc.setStatus(mission.id, 'awaiting-cargo-check');

      await cargoSvc.sendCargo({
        crewId: 'api-crew-1234',
        missionId: mission.id,
        sectorId: 'api',
        type: 'report',
        content: 'Final report.',
        starbaseId: 'test-starbase'
      });

      const rawDb = db.getDb();
      const updated = rawDb
        .prepare<[number], { status: string; cargo_checked: number }>(
          'SELECT status, cargo_checked FROM missions WHERE id = ?'
        )
        .get(mission.id);

      expect(updated?.status).toBe('completed');
      expect(updated?.cargo_checked).toBe(1);
    });

    it('does NOT transition mission if status is active', async () => {
      const mission = missionSvc.addMission({
        sectorId: 'api',
        summary: 'active mission',
        prompt: 'still running'
      });
      missionSvc.setStatus(mission.id, 'active');

      await cargoSvc.sendCargo({
        crewId: 'api-crew-1234',
        missionId: mission.id,
        sectorId: 'api',
        type: 'partial',
        content: 'Partial output.',
        starbaseId: 'test-starbase'
      });

      const rawDb = db.getDb();
      const updated = rawDb
        .prepare<[number], { status: string }>('SELECT status FROM missions WHERE id = ?')
        .get(mission.id);

      expect(updated?.status).toBe('active');
    });

    it('throws if neither content nor filePath provided', async () => {
      const mission = missionSvc.addMission({
        sectorId: 'api',
        summary: 'test',
        prompt: 'x'
      });

      await expect(
        cargoSvc.sendCargo({
          crewId: 'api-crew-1234',
          missionId: mission.id,
          sectorId: 'api',
          type: 'report',
          starbaseId: 'test-starbase'
        })
      ).rejects.toThrow('sendCargo requires either content or filePath');
    });
  });

  describe('cleanup', () => {
    it('should delete cargo older than specified days', () => {
      const rawDb = db.getDb();

      // Insert old cargo (30 days ago)
      rawDb
        .prepare(
          `INSERT INTO cargo (sector_id, type, verified, created_at)
           VALUES ('api', 'old', 1, datetime('now', '-30 days'))`
        )
        .run();

      // Insert recent cargo
      cargoSvc.produceCargo({ sectorId: 'api', type: 'recent' });

      const deleted = cargoSvc.cleanup(14);
      expect(deleted).toBe(1);

      const remaining = cargoSvc.listCargo();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].type).toBe('recent');
    });

    it('should use default 14 days when no argument', () => {
      const rawDb = db.getDb();

      rawDb
        .prepare(
          `INSERT INTO cargo (sector_id, type, verified, created_at)
           VALUES ('api', 'old', 1, datetime('now', '-20 days'))`
        )
        .run();

      cargoSvc.produceCargo({ sectorId: 'api', type: 'recent' });

      const deleted = cargoSvc.cleanup();
      expect(deleted).toBe(1);
    });

    it('should return 0 when nothing to clean up', () => {
      cargoSvc.produceCargo({ sectorId: 'api', type: 'recent' });
      const deleted = cargoSvc.cleanup(14);
      expect(deleted).toBe(0);
    });

    it('should respect custom retention period', () => {
      const rawDb = db.getDb();

      rawDb
        .prepare(
          `INSERT INTO cargo (sector_id, type, verified, created_at)
           VALUES ('api', 'somewhat-old', 1, datetime('now', '-3 days'))`
        )
        .run();

      // 7-day cleanup should not delete 3-day-old cargo
      expect(cargoSvc.cleanup(7)).toBe(0);

      // 2-day cleanup should delete 3-day-old cargo
      expect(cargoSvc.cleanup(2)).toBe(1);
    });
  });
});
