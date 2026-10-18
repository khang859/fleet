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
 * A lobby wakeup or question has `job_id` NULL. Version 2 adds onboarding
 * progress: whether the first-run checks were finished (`agency_meta`) and,
 * per repository, when setup and the starter questions were done.
 *
 * Version 3 adds what a job runs on: plan versions and their steps, the crew,
 * results, spend samples, the resources cleanup has to undo (recorded before
 * they are made), holds that keep a running job waiting, settings history and
 * proposals, and workspace projects with their member repositories.
 *
 * Version 4 adds what a `client_file` card proposes (`questions.data_json`),
 * and each client file as Fleet last wrote it, so a change made outside Fleet
 * shows.
 *
 * Version 5 adds the members the client left out of a workspace project.
 *
 * Version 6 adds the merge of a job's PRs: each PR result's place in the
 * merge order, its merge status and merged commit, and one merge run per job.
 *
 * Version 7 adds the folders Claude Code has reported from, which it only
 * does once its folder trust prompt is accepted there.
 *
 * Version 8 adds each job workspace's block of ports and the env its panes
 * and setup commands get.
 *
 * Version 9 adds the crew flags: what a member needs beyond its session
 * phase, since when, and until when.
 *
 * Version 10 adds crew permission requests, with who answered each and why.
 *
 * Version 11 adds spend on two meters: each sample says whether it is dollars
 * or a share of the weekly Claude limit and whether it is an estimate, and a
 * lobby's Admiral turns are samples with `job_id` NULL. It adds the estimates
 * reserved before crew acts and Admiral turns, the budget levels already acted
 * on, how each crew member is billed and the session cost it last reported,
 * and the job's share of the weekly limit.
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
  `,
  `
  CREATE TABLE agency_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE onboarding (
    repo_id TEXT PRIMARY KEY,
    setup_done_at INTEGER,
    starter_done_at INTEGER
  );
  `,
  `
  ALTER TABLE jobs ADD COLUMN approved_version INTEGER;
  ALTER TABLE jobs ADD COLUMN close_target TEXT;
  ALTER TABLE jobs ADD COLUMN chain_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE jobs ADD COLUMN linked_job_id INTEGER;
  ALTER TABLE questions ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}';

  CREATE TABLE job_holds (
    job_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    since INTEGER NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (job_id, kind)
  );
  CREATE TABLE plan_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    kind TEXT NOT NULL,
    author TEXT NOT NULL,
    parent_version INTEGER,
    plan_json TEXT NOT NULL,
    checks_json TEXT NOT NULL,
    bases_json TEXT,
    snapshot_json TEXT NOT NULL DEFAULT '{}',
    effects_json TEXT,
    decision_note TEXT,
    proposed_at INTEGER NOT NULL,
    decided_at INTEGER,
    UNIQUE (job_id, version)
  );
  CREATE TABLE job_steps (
    job_id INTEGER NOT NULL,
    step_id TEXT NOT NULL,
    role TEXT NOT NULL,
    position INTEGER NOT NULL,
    status TEXT NOT NULL,
    added_in INTEGER NOT NULL,
    removed_in INTEGER,
    branch_seq INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    finished_at INTEGER,
    PRIMARY KEY (job_id, step_id)
  );
  CREATE TABLE job_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    step_id TEXT,
    text TEXT NOT NULL,
    data_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX job_log_job ON job_log(job_id, id);
  CREATE TABLE results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    step_id TEXT,
    plan_version INTEGER,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    listed INTEGER NOT NULL,
    title TEXT NOT NULL,
    member TEXT,
    ref TEXT NOT NULL,
    data_json TEXT NOT NULL DEFAULT '{}',
    head_sha TEXT,
    observed_json TEXT,
    observed_at INTEGER,
    delivered_at INTEGER NOT NULL
  );
  CREATE INDEX results_job ON results(job_id);
  CREATE TABLE crew_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    step_id TEXT NOT NULL,
    role TEXT NOT NULL,
    runtime TEXT NOT NULL,
    model TEXT,
    label TEXT NOT NULL,
    pane_id TEXT,
    session_id TEXT,
    workspace_id INTEGER,
    status TEXT NOT NULL,
    replaces INTEGER,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    end_reason TEXT
  );
  CREATE INDEX crew_job ON crew_members(job_id, status);
  CREATE TABLE spend_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    crew_id INTEGER,
    source TEXT NOT NULL,
    usd REAL NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE TABLE job_workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    step_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    root TEXT NOT NULL,
    branch TEXT NOT NULL,
    UNIQUE (job_id, step_id, attempt)
  );
  CREATE TABLE job_resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    workspace_id INTEGER,
    kind TEXT NOT NULL,
    member TEXT,
    path TEXT,
    branch TEXT,
    base_sha TEXT,
    label TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX job_resources_job ON job_resources(job_id, status);
  CREATE TABLE settings_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    key TEXT NOT NULL,
    before TEXT NOT NULL,
    after TEXT NOT NULL,
    reason TEXT NOT NULL,
    proposal_id INTEGER
  );
  CREATE INDEX settings_history_key ON settings_history(project_id, key, id);
  CREATE TABLE settings_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    job_id INTEGER,
    group_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    before_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    root TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE project_members (
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    repo_id TEXT NOT NULL,
    git_common_dir TEXT NOT NULL,
    remote TEXT,
    default_branch TEXT,
    position INTEGER NOT NULL,
    PRIMARY KEY (project_id, name)
  );
  CREATE UNIQUE INDEX project_members_repo ON project_members(repo_id);
  `,
  `
  ALTER TABLE questions ADD COLUMN data_json TEXT NOT NULL DEFAULT '{}';
  CREATE TABLE client_files (
    repo_id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    written_at INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE projects ADD COLUMN left_out_json TEXT NOT NULL DEFAULT '[]';
  `,
  `
  ALTER TABLE results ADD COLUMN merge_position INTEGER;
  ALTER TABLE results ADD COLUMN merge_status TEXT;
  ALTER TABLE results ADD COLUMN merge_sha TEXT;
  CREATE TABLE merge_runs (
    job_id INTEGER PRIMARY KEY,
    status TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    since INTEGER,
    rerun_at INTEGER,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE claude_trust (
    folder TEXT PRIMARY KEY,
    seen_at INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE job_workspaces ADD COLUMN ports_start INTEGER;
  ALTER TABLE job_workspaces ADD COLUMN ports_size INTEGER;
  ALTER TABLE job_workspaces ADD COLUMN env_json TEXT NOT NULL DEFAULT '{}';
  `,
  `
  ALTER TABLE crew_members ADD COLUMN flag TEXT;
  ALTER TABLE crew_members ADD COLUMN flag_since INTEGER;
  ALTER TABLE crew_members ADD COLUMN flag_until INTEGER;
  `,
  `
  CREATE TABLE permission_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    crew_id INTEGER NOT NULL,
    step_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    tool_use_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    target TEXT NOT NULL,
    state TEXT NOT NULL,
    answered_by TEXT,
    reason TEXT NOT NULL DEFAULT '',
    summary TEXT,
    recommend TEXT,
    created_at INTEGER NOT NULL,
    asked_at INTEGER,
    expires_at INTEGER,
    answered_at INTEGER
  );
  CREATE INDEX permission_requests_job ON permission_requests(job_id, id);
  CREATE INDEX permission_requests_state ON permission_requests(state);
  `,
  `
  CREATE TABLE spend_samples_v11 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER,
    crew_id INTEGER,
    source TEXT NOT NULL,
    meter TEXT NOT NULL,
    amount REAL NOT NULL,
    estimate INTEGER NOT NULL DEFAULT 0,
    at INTEGER NOT NULL
  );
  INSERT INTO spend_samples_v11 (id, job_id, crew_id, source, meter, amount, at)
    SELECT id, job_id, crew_id, source, 'usd', usd, at FROM spend_samples;
  DROP TABLE spend_samples;
  ALTER TABLE spend_samples_v11 RENAME TO spend_samples;
  CREATE INDEX spend_samples_job ON spend_samples(job_id, meter);
  CREATE INDEX spend_samples_at ON spend_samples(at);
  CREATE TABLE spend_reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER,
    crew_id INTEGER,
    meter TEXT NOT NULL,
    amount REAL NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE spend_marks (
    job_id INTEGER NOT NULL,
    meter TEXT NOT NULL,
    level TEXT NOT NULL,
    budget REAL NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (job_id, meter, level)
  );
  ALTER TABLE crew_members ADD COLUMN billing TEXT;
  ALTER TABLE crew_members ADD COLUMN cost_seen REAL;
  ALTER TABLE jobs ADD COLUMN budget_week_pct REAL;
  `,
  `
  CREATE TABLE preference_uses (
    layer TEXT NOT NULL,
    norm_text TEXT NOT NULL,
    job_id INTEGER NOT NULL,
    PRIMARY KEY (layer, norm_text, job_id)
  );
  CREATE TABLE preference_conflicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    layer TEXT NOT NULL,
    norm_text TEXT NOT NULL,
    rule_source TEXT NOT NULL,
    rule_text TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX preference_conflicts_layer ON preference_conflicts(layer, status);
  CREATE TABLE declined_topics (
    project_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (project_id, topic)
  );
  CREATE TABLE project_trust (
    project_id TEXT PRIMARY KEY,
    level TEXT NOT NULL,
    auto_start_usd REAL,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE meet_progress (
    layer TEXT PRIMARY KEY,
    seen_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE plan_versions ADD COLUMN uses_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE plan_versions ADD COLUMN auto_start_usd REAL;
  ALTER TABLE merge_runs ADD COLUMN started_by TEXT NOT NULL DEFAULT 'client';
  `
];

export const AGENCY_SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Bring a database up to the current schema (or to `to`, which tests use to
 * build an older one). Each step runs in its own
 * transaction with the version bump, so a crash halfway leaves the database
 * at the last version it fully reached rather than with half a step applied.
 */
export function migrateAgencyDb(db: Database.Database, to: number = AGENCY_SCHEMA_VERSION): void {
  const from = Number(db.pragma('user_version', { simple: true }));
  if (from > AGENCY_SCHEMA_VERSION) {
    throw new Error(
      `agency.db is at schema ${from}, newer than this Fleet understands (${AGENCY_SCHEMA_VERSION})`
    );
  }
  MIGRATIONS.slice(from, to).forEach((sql, i) => {
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
