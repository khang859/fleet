import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StarbaseDB } from '../starbase/db';
import { GLOBAL_SECTOR_ID, SectorService } from '../starbase/sector-service';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-sectors');
const WORKSPACE_DIR = join(TEST_DIR, 'workspace');
const SECTOR_DIR = join(WORKSPACE_DIR, 'api');
const DB_DIR = join(TEST_DIR, 'starbases');

let db: StarbaseDB;
let svc: SectorService;

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(SECTOR_DIR, { recursive: true });
  // Create a dummy file so sector dir has content
  require('fs').writeFileSync(join(SECTOR_DIR, 'index.ts'), '');
  db = new StarbaseDB(WORKSPACE_DIR, DB_DIR);
  db.open();
  svc = new SectorService(db.getDb(), WORKSPACE_DIR);
});

afterEach(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('SectorService', () => {
  it('should add a sector', () => {
    const sector = svc.addSector({ path: 'api' });
    expect(sector.id).toBe('api');
    expect(sector.name).toBe('api');
    expect(sector.root_path).toBe(SECTOR_DIR);
  });

  it('should reject duplicate sectors', () => {
    svc.addSector({ path: 'api' });
    expect(() => svc.addSector({ path: 'api' })).toThrow('already registered');
  });

  it('should reject non-existent directories', () => {
    expect(() => svc.addSector({ path: 'nonexistent' })).toThrow();
  });

  it('should list sectors', () => {
    svc.addSector({ path: 'api' });
    const list = svc.listSectors();
    expect(list).toHaveLength(2);
    const apiSector = list.find(s => s.id === 'api');
    expect(apiSector).toBeDefined();
    expect(apiSector!.id).toBe('api');
  });

  it('should hide logical sectors from visible sector lists', () => {
    svc.addSector({ path: 'api' });

    const list = svc.listVisibleSectors();

    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('api');
  });

  it('should identify the global sentinel as a logical sector', () => {
    expect(svc.isLogicalSector(GLOBAL_SECTOR_ID)).toBe(true);
    expect(svc.isLogicalSector('api')).toBe(false);
  });

  it('should get a sector by id', () => {
    svc.addSector({ path: 'api' });
    const sector = svc.getSector('api');
    expect(sector).toBeDefined();
    expect(sector!.name).toBe('api');
  });

  it('should remove a sector', () => {
    svc.addSector({ path: 'api' });
    svc.removeSector('api');
    expect(svc.listSectors()).toHaveLength(1);
  });

  it('should update a sector', () => {
    svc.addSector({ path: 'api' });
    svc.updateSector('api', { description: 'API service', base_branch: 'develop' });
    const sector = svc.getSector('api');
    expect(sector!.description).toBe('API service');
    expect(sector!.base_branch).toBe('develop');
  });

  it('should auto-detect stack from package.json', () => {
    require('fs').writeFileSync(join(SECTOR_DIR, 'package.json'), '{}');
    const sector = svc.addSector({ path: 'api' });
    expect(sector.stack).toBe('typescript/node');
  });
});
