import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StarbaseDB } from '../starbase/db';
import { ConfigService } from '../starbase/config-service';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-sentinel-cb');
const WORKSPACE_DIR = join(TEST_DIR, 'workspace');
const SECTOR_DIR = join(WORKSPACE_DIR, 'api');
const DB_DIR = join(TEST_DIR, 'starbases');

let db: StarbaseDB;
let rawDb: ReturnType<StarbaseDB['getDb']>;
let configService: ConfigService;

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(SECTOR_DIR, { recursive: true });
  writeFileSync(join(SECTOR_DIR, 'index.ts'), '');
  db = new StarbaseDB(WORKSPACE_DIR, DB_DIR);
  db.open();
  rawDb = db.getDb();
  configService = new ConfigService(rawDb);

  // Seed sector and mission
  rawDb
    .prepare("INSERT INTO sectors (id, name, root_path) VALUES ('api', 'API', ?)")
    .run(SECTOR_DIR);
  rawDb
    .prepare(
      "INSERT INTO missions (sector_id, summary, prompt, status) VALUES ('api', 'test mission', 'test prompt', 'failed')"
    )
    .run();
  rawDb
    .prepare(
      "INSERT INTO crew (id, sector_id, mission_id, status) VALUES ('crew-1', 'api', 1, 'error')"
    )
    .run();
});

afterEach(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('sentinel circuit breaker query guards', () => {
  it('query dedup picks only latest crew per mission', () => {
    // Add a second older errored crew for the same mission
    rawDb
      .prepare(
        "INSERT INTO crew (id, sector_id, mission_id, status, updated_at) VALUES ('crew-0', 'api', 1, 'error', datetime('now', '-1 hour'))"
      )
      .run();

    const rows = rawDb
      .prepare(
        `SELECT c.id as crew_id FROM crew c
       JOIN missions m ON m.id = c.mission_id
       WHERE c.status IN ('error', 'lost', 'timeout')
         AND m.status IN ('failed', 'failed-verification')
         AND c.id = (
           SELECT c2.id FROM crew c2
           WHERE c2.mission_id = m.id AND c2.status IN ('error', 'lost', 'timeout')
           ORDER BY c2.updated_at DESC LIMIT 1
         )`
      )
      .all() as Array<{ crew_id: string }>;

    expect(rows.length).toBe(1);
    expect(rows[0].crew_id).toBe('crew-1'); // most recent
  });

  it('budget gate excludes missions at deployment limit', () => {
    const maxDeploy = (configService.get('max_mission_deployments') as number) ?? 8;
    rawDb.prepare('UPDATE missions SET mission_deployment_count = ? WHERE id = 1').run(maxDeploy);

    const rows = rawDb
      .prepare(
        `SELECT c.id FROM crew c
       JOIN missions m ON m.id = c.mission_id
       WHERE c.status = 'error' AND m.status = 'failed'
         AND m.mission_deployment_count < ?`
      )
      .all(maxDeploy) as Array<{ id: string }>;

    expect(rows.length).toBe(0);
  });

  it('comms dedup blocks dispatch when unread memo exists', () => {
    rawDb
      .prepare(
        "INSERT INTO comms (from_crew, to_crew, type, mission_id, payload, read) VALUES ('first-officer', 'admiral', 'memo', 1, '{}', 0)"
      )
      .run();

    const rows = rawDb
      .prepare(
        `SELECT c.id FROM crew c
       JOIN missions m ON m.id = c.mission_id
       WHERE c.status = 'error' AND m.status = 'failed'
         AND NOT EXISTS (
           SELECT 1 FROM comms WHERE type = 'memo' AND mission_id = m.id AND read = 0
         )`
      )
      .all() as Array<{ id: string }>;

    expect(rows.length).toBe(0);
  });

  it('comms dedup allows dispatch when memo is read', () => {
    rawDb
      .prepare(
        "INSERT INTO comms (from_crew, to_crew, type, mission_id, payload, read) VALUES ('first-officer', 'admiral', 'memo', 1, '{}', 1)"
      )
      .run();

    const rows = rawDb
      .prepare(
        `SELECT c.id FROM crew c
       JOIN missions m ON m.id = c.mission_id
       WHERE c.status = 'error' AND m.status = 'failed'
         AND NOT EXISTS (
           SELECT 1 FROM comms WHERE type = 'memo' AND mission_id = m.id AND read = 0
         )`
      )
      .all() as Array<{ id: string }>;

    expect(rows.length).toBe(1);
  });
});
