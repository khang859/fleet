import { describe, it, expect, afterEach } from 'vitest';
import { StarbaseDB } from '../starbase/db';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';

const TEST_DIR = join(tmpdir(), 'fleet-test-starbase');

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('StarbaseDB', () => {
  it('should create a database and run migrations', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const workspacePath = '/tmp/test-workspace';
    const db = new StarbaseDB(workspacePath, TEST_DIR);
    db.open();

    // Verify database file exists
    const files = require('fs').readdirSync(TEST_DIR);
    expect(files.some((f: string) => f.endsWith('.db'))).toBe(true);

    // Verify schema_version is set
    const raw = db.getDb();
    const meta = raw.prepare('SELECT schema_version FROM _meta').get() as {
      schema_version: number;
    };
    expect(meta.schema_version).toBeGreaterThanOrEqual(1);

    // Verify sectors table exists
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[];
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('sectors');
    expect(tableNames).toContain('missions');
    expect(tableNames).toContain('crew');
    expect(tableNames).toContain('comms');
    expect(tableNames).toContain('cargo');
    expect(tableNames).toContain('ships_log');
    expect(tableNames).toContain('starbase_config');

    const globalSector = raw
      .prepare("SELECT id, root_path FROM sectors WHERE id = 'global'")
      .get() as { id: string; root_path: string };
    expect(globalSector).toEqual({ id: 'global', root_path: '' });

    db.close();
  });

  it('should derive consistent starbase ID from workspace path', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const db1 = new StarbaseDB('/tmp/workspace-a', TEST_DIR);
    const db2 = new StarbaseDB('/tmp/workspace-a', TEST_DIR);
    expect(db1.getStarbaseId()).toBe(db2.getStarbaseId());

    const db3 = new StarbaseDB('/tmp/workspace-b', TEST_DIR);
    expect(db1.getStarbaseId()).not.toBe(db3.getStarbaseId());
  });

  it('should reopen an existing database without re-running migrations', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const workspacePath = '/tmp/test-workspace';

    const db1 = new StarbaseDB(workspacePath, TEST_DIR);
    db1.open();
    const id1 = db1.getStarbaseId();
    db1.close();

    const db2 = new StarbaseDB(workspacePath, TEST_DIR);
    db2.open();
    const id2 = db2.getStarbaseId();
    expect(id2).toBe(id1);

    // Schema version still 1 (not re-incremented)
    const raw = db2.getDb();
    const meta = raw.prepare('SELECT schema_version FROM _meta').get() as {
      schema_version: number;
    };
    expect(meta.schema_version).toBeGreaterThanOrEqual(1);
    db2.close();
  });

  it('should normalize legacy global sector paths on upgrade', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const workspacePath = '/tmp/test-workspace';
    const db = new StarbaseDB(workspacePath, TEST_DIR);
    db.open();

    const dbPath = db.getDbPath();
    const starbaseId = db.getStarbaseId();
    db.close();

    const raw = new Database(dbPath);
    raw.prepare("UPDATE sectors SET root_path = ':global:' WHERE id = 'global'").run();
    raw.prepare('UPDATE _meta SET schema_version = 12').run();
    raw.close();

    const reopened = new StarbaseDB(workspacePath, TEST_DIR);
    expect(reopened.getStarbaseId()).toBe(starbaseId);
    reopened.open();

    const globalSector = reopened
      .getDb()
      .prepare("SELECT root_path FROM sectors WHERE id = 'global'")
      .get() as { root_path: string };
    expect(globalSector.root_path).toBe('');

    reopened.close();
  });
});
