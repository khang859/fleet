export const SCHEMA_VERSION = 16;

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
  base_branch TEXT,
  model_override TEXT,
  skills TEXT NOT NULL DEFAULT '[]',
  docs TEXT NOT NULL DEFAULT '[]',
  board_id TEXT NOT NULL DEFAULT 'default',
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
  schedule_kind TEXT,
  schedule_cron TEXT,
  schedule_interval_ms INTEGER,
  next_run_at INTEGER,
  schedule_paused INTEGER NOT NULL DEFAULT 0,
  scheduled_from TEXT,
  feature_id TEXT,
  pr_url TEXT,
  pr_number INTEGER,
  pr_state TEXT,
  checks_state TEXT,
  pr_merge_state TEXT,
  pr_synced_at INTEGER,
  conflict_state TEXT,
  conflict_files TEXT,
  worktree_pruned INTEGER NOT NULL DEFAULT 0,
  resolve_attempts INTEGER NOT NULL DEFAULT 0,
  verify_attempts INTEGER NOT NULL DEFAULT 0,
  review_verdict TEXT,
  review_attempts INTEGER NOT NULL DEFAULT 0,
  review_head_sha TEXT,
  system_kind TEXT,
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

CREATE TABLE IF NOT EXISTS task_attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  content_type TEXT,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_task ON task_attachments(task_id);

CREATE TABLE IF NOT EXISTS boards (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS features (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  repo_path TEXT,
  base_branch TEXT,
  integration_branch TEXT,
  merge_state TEXT,
  pr_url TEXT,
  pr_number INTEGER,
  pr_state TEXT,
  checks_state TEXT,
  pr_synced_at INTEGER,
  pr_skip_notified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_features_board ON features(board_id);
CREATE INDEX IF NOT EXISTS idx_features_status ON features(status);

CREATE TABLE IF NOT EXISTS task_artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id INTEGER,
  board_id TEXT NOT NULL,
  title TEXT,
  filename TEXT NOT NULL,
  source_rel_path TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  content_type TEXT,
  size INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'kept',
  created_at INTEGER NOT NULL,
  discarded_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON task_artifacts(task_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_board ON task_artifacts(board_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_state ON task_artifacts(state);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  description TEXT,
  verify_commands TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_board_name ON projects(board_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_board_path ON projects(board_id, path);

CREATE TABLE IF NOT EXISTS feature_suggestions (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  repo_path TEXT,
  name TEXT NOT NULL,
  task_ids TEXT NOT NULL DEFAULT '[]',
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_suggestions_board ON feature_suggestions(board_id);
CREATE INDEX IF NOT EXISTS idx_suggestions_status ON feature_suggestions(status);

CREATE TABLE IF NOT EXISTS pm_proposals (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_proposals_board ON pm_proposals(board_id);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON pm_proposals(status);
`;
