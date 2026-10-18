import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
      'claude_trust',
      'client_files',
      'crew_members',
      'declined_topics',
      'job_events',
      'job_holds',
      'job_log',
      'job_resources',
      'job_steps',
      'job_workspaces',
      'jobs',
      'lobbies',
      'meet_progress',
      'merge_runs',
      'onboarding',
      'permission_requests',
      'plan_versions',
      'preference_conflicts',
      'preference_uses',
      'project_members',
      'project_trust',
      'projects',
      'questions',
      'repos',
      'results',
      'settings_history',
      'settings_proposals',
      'spend_marks',
      'spend_reservations',
      'spend_samples',
      'wakeups'
    ]);
    db.close();
  });

  it('brings a v1 database to the current schema without touching its rows', () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    const v1 = new Database(path);
    migrateAgencyDb(v1, 1);
    v1.prepare("INSERT INTO repos VALUES ('r', '/r', 'r', 1)").run();
    v1.close();

    const db = openAgencyDb(path);
    expect(db.pragma('user_version', { simple: true })).toBe(AGENCY_SCHEMA_VERSION);
    expect(tables(db)).toContain('onboarding');
    expect(db.prepare('SELECT COUNT(*) AS n FROM repos').get()).toEqual({ n: 1 });
    db.close();
  });

  it('gives v2 jobs and questions the v3 columns with their defaults', () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    const v2 = new Database(path);
    migrateAgencyDb(v2, 2);
    v2.prepare(
      `INSERT INTO jobs (repo_id, title, brief, state, session_id, created_at, updated_at)
       VALUES ('r', 't', 'b', 'running', 's', 1, 1)`
    ).run();
    v2.prepare(
      `INSERT INTO questions (repo_id, kind, question, options_json, status, created_at)
       VALUES ('r', 'ask', 'Q?', '[]', 'open', 1)`
    ).run();
    v2.close();

    const db = openAgencyDb(path);
    expect(
      db
        .prepare('SELECT approved_version, close_target, chain_count, linked_job_id FROM jobs')
        .get()
    ).toEqual({ approved_version: null, close_target: null, chain_count: 0, linked_job_id: null });
    expect(db.prepare('SELECT payload_json FROM questions').get()).toEqual({ payload_json: '{}' });
    db.close();
  });

  it('keeps v10 dollar spend as usd samples on the two-meter table', () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    const v10 = new Database(path);
    migrateAgencyDb(v10, 10);
    v10
      .prepare(
        "INSERT INTO spend_samples (job_id, crew_id, source, usd, at) VALUES (4, 7, 'crew', 1.25, 9)"
      )
      .run();
    v10.close();

    const db = openAgencyDb(path);
    expect(db.prepare('SELECT * FROM spend_samples').all()).toEqual([
      {
        id: 1,
        job_id: 4,
        crew_id: 7,
        source: 'crew',
        meter: 'usd',
        amount: 1.25,
        estimate: 0,
        at: 9
      }
    ]);
    db.close();
  });

  it('gives a database from before the preference tables those tables and Meet you progress, empty', () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    const old = new Database(path);
    migrateAgencyDb(old, AGENCY_SCHEMA_VERSION - 3);
    expect(tables(old)).not.toContain('project_trust');
    old.close();

    const db = openAgencyDb(path);
    for (const table of [
      'preference_uses',
      'preference_conflicts',
      'declined_topics',
      'project_trust',
      'meet_progress'
    ]) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    db.close();
  });

  it('gives older plan versions no uses and no auto-start, and older merges the client as starter', () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    const old = new Database(path);
    migrateAgencyDb(old, AGENCY_SCHEMA_VERSION - 1);
    old.close();

    const db = openAgencyDb(path);
    const columns = (table: string): Array<{ name: string; dflt_value: string | null }> =>
      db
        .prepare<
          [],
          { name: string; dflt_value: string | null }
        >(`SELECT name, dflt_value FROM pragma_table_info('${table}')`)
        .all();
    expect(columns('plan_versions')).toEqual(
      expect.arrayContaining([
        { name: 'uses_json', dflt_value: "'[]'" },
        { name: 'auto_start_usd', dflt_value: null }
      ])
    );
    expect(columns('merge_runs')).toContainEqual({ name: 'started_by', dflt_value: "'client'" });
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
