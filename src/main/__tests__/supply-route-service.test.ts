import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StarbaseDB } from '../starbase/db';
import { SectorService } from '../starbase/sector-service';
import { SupplyRouteService, CyclicDependencyError } from '../starbase/supply-route-service';
import { rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-supply-routes');
const WORKSPACE_DIR = join(TEST_DIR, 'workspace');
const DB_DIR = join(TEST_DIR, 'starbases');

let db: StarbaseDB;
let sectorSvc: SectorService;
let routeSvc: SupplyRouteService;

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
  sectorSvc = new SectorService(db.getDb(), WORKSPACE_DIR);
  routeSvc = new SupplyRouteService(db.getDb());

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

describe('SupplyRouteService', () => {
  describe('addRoute', () => {
    it('should add a route between two sectors', () => {
      const route = routeSvc.addRoute({
        upstreamSectorId: 'shared',
        downstreamSectorId: 'api'
      });
      expect(route.id).toBeDefined();
      expect(route.upstream_sector_id).toBe('shared');
      expect(route.downstream_sector_id).toBe('api');
    });

    it('should add a route with a relationship label', () => {
      const route = routeSvc.addRoute({
        upstreamSectorId: 'shared',
        downstreamSectorId: 'api',
        relationship: 'depends-on'
      });
      expect(route.relationship).toBe('depends-on');
    });

    it('should reject self-referencing routes', () => {
      expect(() =>
        routeSvc.addRoute({
          upstreamSectorId: 'api',
          downstreamSectorId: 'api'
        })
      ).toThrow(CyclicDependencyError);
    });
  });

  describe('cycle detection', () => {
    it('should reject A -> B -> A cycle', () => {
      routeSvc.addRoute({
        upstreamSectorId: 'api',
        downstreamSectorId: 'web'
      });
      expect(() =>
        routeSvc.addRoute({
          upstreamSectorId: 'web',
          downstreamSectorId: 'api'
        })
      ).toThrow(CyclicDependencyError);
    });

    it('should reject A -> B -> C -> A cycle', () => {
      routeSvc.addRoute({
        upstreamSectorId: 'api',
        downstreamSectorId: 'web'
      });
      routeSvc.addRoute({
        upstreamSectorId: 'web',
        downstreamSectorId: 'shared'
      });
      expect(() =>
        routeSvc.addRoute({
          upstreamSectorId: 'shared',
          downstreamSectorId: 'api'
        })
      ).toThrow(CyclicDependencyError);
    });

    it('should include the cycle path in the error message', () => {
      routeSvc.addRoute({
        upstreamSectorId: 'api',
        downstreamSectorId: 'web'
      });
      try {
        routeSvc.addRoute({
          upstreamSectorId: 'web',
          downstreamSectorId: 'api'
        });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CyclicDependencyError);
        const msg = (err as CyclicDependencyError).message;
        expect(msg).toContain('api');
        expect(msg).toContain('web');
      }
    });

    it('should allow diamond dependencies (no cycle)', () => {
      // core -> api, core -> web, api -> shared, web -> shared
      routeSvc.addRoute({ upstreamSectorId: 'core', downstreamSectorId: 'api' });
      routeSvc.addRoute({ upstreamSectorId: 'core', downstreamSectorId: 'web' });
      routeSvc.addRoute({ upstreamSectorId: 'api', downstreamSectorId: 'shared' });
      expect(() =>
        routeSvc.addRoute({ upstreamSectorId: 'web', downstreamSectorId: 'shared' })
      ).not.toThrow();
    });
  });

  describe('removeRoute', () => {
    it('should remove an existing route', () => {
      const route = routeSvc.addRoute({
        upstreamSectorId: 'shared',
        downstreamSectorId: 'api'
      });
      routeSvc.removeRoute(route.id);
      expect(routeSvc.listRoutes()).toHaveLength(0);
    });

    it('should throw when removing non-existent route', () => {
      expect(() => routeSvc.removeRoute(999)).toThrow();
    });
  });

  describe('listRoutes', () => {
    it('should list all routes', () => {
      routeSvc.addRoute({ upstreamSectorId: 'shared', downstreamSectorId: 'api' });
      routeSvc.addRoute({ upstreamSectorId: 'shared', downstreamSectorId: 'web' });
      expect(routeSvc.listRoutes()).toHaveLength(2);
    });

    it('should filter routes by sectorId', () => {
      routeSvc.addRoute({ upstreamSectorId: 'shared', downstreamSectorId: 'api' });
      routeSvc.addRoute({ upstreamSectorId: 'core', downstreamSectorId: 'web' });
      const routes = routeSvc.listRoutes({ sectorId: 'shared' });
      expect(routes).toHaveLength(1);
      expect(routes[0].upstream_sector_id).toBe('shared');
    });

    it('should return routes where sector is downstream', () => {
      routeSvc.addRoute({ upstreamSectorId: 'shared', downstreamSectorId: 'api' });
      routeSvc.addRoute({ upstreamSectorId: 'core', downstreamSectorId: 'api' });
      const routes = routeSvc.listRoutes({ sectorId: 'api' });
      expect(routes).toHaveLength(2);
    });
  });

  describe('getDownstream', () => {
    it('should get direct downstream sectors', () => {
      routeSvc.addRoute({ upstreamSectorId: 'shared', downstreamSectorId: 'api' });
      routeSvc.addRoute({ upstreamSectorId: 'shared', downstreamSectorId: 'web' });
      const downstream = routeSvc.getDownstream('shared');
      expect(downstream).toHaveLength(2);
      expect(downstream.map((d) => d.downstream_sector_id).sort()).toEqual(['api', 'web']);
    });

    it('should return empty array when no downstream', () => {
      expect(routeSvc.getDownstream('api')).toHaveLength(0);
    });
  });

  describe('getUpstream', () => {
    it('should get direct upstream sectors', () => {
      routeSvc.addRoute({ upstreamSectorId: 'shared', downstreamSectorId: 'api' });
      routeSvc.addRoute({ upstreamSectorId: 'core', downstreamSectorId: 'api' });
      const upstream = routeSvc.getUpstream('api');
      expect(upstream).toHaveLength(2);
      expect(upstream.map((u) => u.upstream_sector_id).sort()).toEqual(['core', 'shared']);
    });

    it('should return empty array when no upstream', () => {
      expect(routeSvc.getUpstream('shared')).toHaveLength(0);
    });
  });

  describe('getGraph', () => {
    it('should return adjacency list of the full graph', () => {
      routeSvc.addRoute({ upstreamSectorId: 'shared', downstreamSectorId: 'api' });
      routeSvc.addRoute({ upstreamSectorId: 'shared', downstreamSectorId: 'web' });
      routeSvc.addRoute({ upstreamSectorId: 'core', downstreamSectorId: 'shared' });
      const graph = routeSvc.getGraph();
      expect(graph['shared']).toEqual(expect.arrayContaining(['api', 'web']));
      expect(graph['core']).toEqual(['shared']);
    });

    it('should return empty object when no routes', () => {
      const graph = routeSvc.getGraph();
      expect(Object.keys(graph)).toHaveLength(0);
    });
  });
});
