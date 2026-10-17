import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENCY_SCHEMA_VERSION, migrateAgencyDb, openAgencyDb } from '../store/agency-db';

const dirs: string[] = [];
function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-agency-db-'));
  dirs.push(dir);
  return join(dir, 'nested', 'agency.db');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tables(db: Database.Database): string[] {
  return db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((r) => r.name);
}

describe('agency.db', () => {
  it('creates the folder and the current schema on first open, in WAL mode', () => {
    const db = openAgencyDb(tempPath());
    expect(db.pragma('user_version', { simple: true })).toBe(AGENCY_SCHEMA_VERSION);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(tables(db)).toEqual([
      'agency_meta',
      'job_events',
      'jobs',
      'lobbies',
      'onboarding',
      'questions',
      'repos',
      'wakeups'
    ]);
    db.close();
  });

  it('brings a v1 database to v2 without touching its rows', () => {
    const path = tempPath();
    const v1 = openAgencyDb(path);
    v1.exec('DROP TABLE agency_meta; DROP TABLE onboarding;');
    v1.pragma('user_version = 1');
    v1.prepare("INSERT INTO repos VALUES ('r', '/r', 'r', 1)").run();
    v1.close();

    const db = openAgencyDb(path);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    expect(tables(db)).toContain('onboarding');
    expect(db.prepare('SELECT COUNT(*) AS n FROM repos').get()).toEqual({ n: 1 });
    db.close();
  });

  it('migrates again as a no-op, keeping what is stored', () => {
    const path = tempPath();
    const db = openAgencyDb(path);
    db.prepare("INSERT INTO repos VALUES ('r', '/r', 'r', 1)").run();
    db.close();

    const reopened = openAgencyDb(path);
    migrateAgencyDb(reopened);
    expect(reopened.pragma('user_version', { simple: true })).toBe(AGENCY_SCHEMA_VERSION);
    expect(reopened.prepare('SELECT COUNT(*) AS n FROM repos').get()).toEqual({ n: 1 });
    reopened.close();
  });

  it('refuses a database written by a newer Fleet rather than guess at it', () => {
    const path = tempPath();
    openAgencyDb(path).close();
    const db = new Database(path);
    db.pragma(`user_version = ${AGENCY_SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => openAgencyDb(path)).toThrow(/newer than this Fleet understands/);
  });
});
