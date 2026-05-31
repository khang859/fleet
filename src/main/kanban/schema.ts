export const SCHEMA_VERSION = 3;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  assignee TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  priority INTEGER NOT NULL DEFAULT 0,
  tenant TEXT,
  workspace_kind TEXT NOT NULL DEFAULT 'scratch',
  workspace_path TEXT,
  repo_path TEXT,
  branch_name TEXT,
  model_override TEXT,
  skills TEXT NOT NULL DEFAULT '[]',
  idempotency_key TEXT,
  result TEXT,
  pending_mode TEXT,
  claim_lock TEXT,
  claim_expires INTEGER,
  worker_pid INTEGER,
  current_run_id INTEGER,
  last_heartbeat_at INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_failure_error TEXT,
  max_runtime_seconds INTEGER,
  max_retries INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idem ON tasks(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_links (
  parent_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  PRIMARY KEY (parent_id, child_id)
);
CREATE INDEX IF NOT EXISTS idx_links_child ON task_links(child_id);

CREATE TABLE IF NOT EXISTS task_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_task ON task_comments(task_id);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  run_id INTEGER,
  kind TEXT NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id);

CREATE TABLE IF NOT EXISTS task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  profile TEXT,
  status TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'work',
  worker_pid INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT,
  summary TEXT,
  metadata TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_task ON task_runs(task_id);
`;
