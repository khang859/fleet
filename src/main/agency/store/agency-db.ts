import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Where the agency keeps its durable state. One file for every repository:
 * jobs belong to a repository, not to a pane, and outlive both the pane and
 * the app. `FLEET_AGENCY_DB_PATH` points it somewhere else, for tests.
 */
export function agencyDbPath(): string {
  return process.env.FLEET_AGENCY_DB_PATH ?? join(homedir(), '.fleet', 'agency.db');
}

/**
 * The schema, one entry per version. Never edit a shipped entry: a database
 * already at that version would never see the change. Add the next one.
 *
 * A lobby wakeup or question has `job_id` NULL. Phase 2 adds plan, step, crew,
 * result, spend and permission tables as version 2.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE repos (
    repo_id TEXT PRIMARY KEY,
    root TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE lobbies (
    repo_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    last_handoff_message_id TEXT
  );
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id TEXT NOT NULL,
    title TEXT NOT NULL,
    brief TEXT NOT NULL,
    state TEXT NOT NULL,
    session_id TEXT NOT NULL UNIQUE,
    handoff_done INTEGER NOT NULL DEFAULT 0,
    budget_usd REAL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE job_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    at INTEGER NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    reason TEXT NOT NULL
  );
  CREATE TABLE questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id TEXT NOT NULL,
    job_id INTEGER,
    plan_version INTEGER,
    step TEXT,
    kind TEXT NOT NULL,
    question TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '',
    options_json TEXT NOT NULL,
    recommended INTEGER,
    dep_question INTEGER,
    dep_option INTEGER,
    status TEXT NOT NULL,
    answer_option INTEGER,
    answer_text TEXT,
    late INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    answered_at INTEGER,
    withdrawn_reason TEXT
  );
  CREATE TABLE wakeups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id TEXT NOT NULL,
    job_id INTEGER,
    kind TEXT NOT NULL,
    question_id INTEGER,
    payload_json TEXT NOT NULL DEFAULT '{}',
    priority INTEGER NOT NULL DEFAULT 1,
    not_before INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    claimed_at INTEGER,
    done_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX wakeups_due ON wakeups(repo_id, job_id, done_at);
  CREATE INDEX questions_open ON questions(repo_id, status);
  `
];

export const AGENCY_SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Bring a database up to the current schema. Each step runs in its own
 * transaction with the version bump, so a crash halfway leaves the database
 * at the last version it fully reached rather than with half a step applied.
 */
export function migrateAgencyDb(db: Database.Database): void {
  const from = Number(db.pragma('user_version', { simple: true }));
  if (from > AGENCY_SCHEMA_VERSION) {
    throw new Error(
      `agency.db is at schema ${from}, newer than this Fleet understands (${AGENCY_SCHEMA_VERSION})`
    );
  }
  MIGRATIONS.slice(from).forEach((sql, i) => {
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${from + i + 1}`);
    })();
  });
}

/** Open (creating if need be) and migrate the agency database at `path`. */
export function openAgencyDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  // Wait briefly rather than throw SQLITE_BUSY when a write lands while WAL is
  // checkpointing.
  db.pragma('busy_timeout = 5000');
  migrateAgencyDb(db);
  return db;
}
