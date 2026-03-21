import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StarbaseDB } from '../starbase/db';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-budget');
const WORKSPACE_DIR = join(TEST_DIR, 'workspace');
const SECTOR_DIR = join(WORKSPACE_DIR, 'api');
const DB_DIR = join(TEST_DIR, 'starbases');

let db: StarbaseDB;
let rawDb: ReturnType<StarbaseDB['getDb']>;

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(SECTOR_DIR, { recursive: true });
  writeFileSync(join(SECTOR_DIR, 'index.ts'), '');
  db = new StarbaseDB(WORKSPACE_DIR, DB_DIR);
  db.open();
  rawDb = db.getDb();

  // Seed sector and mission
  rawDb
    .prepare("INSERT INTO sectors (id, name, root_path) VALUES ('api', 'API', ?)")
    .run(SECTOR_DIR);
  rawDb
    .prepare(
      "INSERT INTO missions (sector_id, summary, prompt) VALUES ('api', 'test', 'test prompt')"
    )
    .run();
});

afterEach(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('mission_deployment_count', () => {
  it('starts at 0 for new missions', () => {
    const row = rawDb
      .prepare('SELECT mission_deployment_count FROM missions WHERE id = 1')
      .get() as { mission_deployment_count: number };
    expect(row.mission_deployment_count).toBe(0);
  });

  it('can be incremented', () => {
    rawDb
      .prepare(
        'UPDATE missions SET mission_deployment_count = mission_deployment_count + 1 WHERE id = 1'
      )
      .run();
    const row = rawDb
      .prepare('SELECT mission_deployment_count FROM missions WHERE id = 1')
      .get() as { mission_deployment_count: number };
    expect(row.mission_deployment_count).toBe(1);
  });

  it('is NOT reset by resetForRequeue fields', () => {
    rawDb.prepare('UPDATE missions SET mission_deployment_count = 5 WHERE id = 1').run();
    // Simulate resetForRequeue
    rawDb
      .prepare(
        'UPDATE missions SET crew_id = NULL, started_at = NULL, completed_at = NULL, result = NULL WHERE id = 1'
      )
      .run();
    const row = rawDb
      .prepare('SELECT mission_deployment_count FROM missions WHERE id = 1')
      .get() as { mission_deployment_count: number };
    expect(row.mission_deployment_count).toBe(5);
  });
});
