export type Migration = {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: '001-initial',
    sql: `
      CREATE TABLE IF NOT EXISTS _meta (
        schema_version INTEGER NOT NULL,
        workspace_path TEXT NOT NULL,
        created_at DATETIME DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS sectors (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT UNIQUE NOT NULL,
        stack TEXT,
        description TEXT,
        base_branch TEXT DEFAULT 'main',
        merge_strategy TEXT DEFAULT 'pr',
        verify_command TEXT,
        lint_command TEXT,
        review_mode TEXT DEFAULT 'admiral-review',
        worktree_enabled INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT (datetime('now')),
        updated_at DATETIME DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS supply_routes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        upstream_sector_id TEXT NOT NULL REFERENCES sectors(id),
        downstream_sector_id TEXT NOT NULL REFERENCES sectors(id),
        relationship TEXT,
        created_at DATETIME DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS missions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sector_id TEXT NOT NULL REFERENCES sectors(id),
        crew_id TEXT,
        summary TEXT NOT NULL,
        prompt TEXT NOT NULL,
        acceptance_criteria TEXT,
        status TEXT DEFAULT 'queued',
        priority INTEGER DEFAULT 0,
        depends_on_mission_id INTEGER REFERENCES missions(id),
        result TEXT,
        verify_result TEXT,
        review_verdict TEXT,
        review_notes TEXT,
        created_at DATETIME DEFAULT (datetime('now')),
        started_at DATETIME,
        completed_at DATETIME
      );

      CREATE TABLE IF NOT EXISTS crew (
        id TEXT PRIMARY KEY,
        tab_id TEXT,
        sector_id TEXT NOT NULL REFERENCES sectors(id),
        mission_id INTEGER REFERENCES missions(id),
        sector_path TEXT,
        worktree_path TEXT,
        worktree_branch TEXT,
        status TEXT DEFAULT 'active',
        mission_summary TEXT,
        avatar_variant TEXT,
        pid INTEGER,
        deadline DATETIME,
        token_budget INTEGER DEFAULT 0,
        tokens_used INTEGER DEFAULT 0,
        last_lifesign DATETIME,
        created_at DATETIME DEFAULT (datetime('now')),
        updated_at DATETIME DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS comms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_crew TEXT,
        to_crew TEXT,
        thread_id TEXT,
        in_reply_to INTEGER REFERENCES comms(id),
        type TEXT,
        payload TEXT,
        read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS cargo (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        crew_id TEXT,
        mission_id INTEGER REFERENCES missions(id),
        sector_id TEXT NOT NULL REFERENCES sectors(id),
        type TEXT,
        manifest TEXT,
        verified INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS ships_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        crew_id TEXT,
        event_type TEXT NOT NULL,
        detail TEXT,
        created_at DATETIME DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS starbase_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT (datetime('now'))
      );
    `
  },
  {
    version: 2,
    name: '002-phase4-pool-and-rate-limit',
    sql: `
      ALTER TABLE crew ADD COLUMN pool_status TEXT;
      ALTER TABLE crew ADD COLUMN pooled_at DATETIME;
      ALTER TABLE crew ADD COLUMN comms_count_minute INTEGER DEFAULT 0;
    `
  },
  {
    version: 3,
    name: '003-indexes',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_cargo_sector ON cargo(sector_id);
      CREATE INDEX IF NOT EXISTS idx_comms_to ON comms(to_crew, read);
      CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status, sector_id);
    `
  },
  {
    version: 4,
    name: '004-comms-dedup',
    sql: `
      ALTER TABLE comms ADD COLUMN repeat_count INTEGER DEFAULT 1;
      ALTER TABLE comms ADD COLUMN last_repeated_at TEXT;
    `
  },
  {
    version: 5,
    name: '005-sector-agent-config',
    sql: `
      ALTER TABLE sectors ADD COLUMN model TEXT;
      ALTER TABLE sectors ADD COLUMN system_prompt TEXT;
      ALTER TABLE sectors ADD COLUMN allowed_tools TEXT;
      ALTER TABLE sectors ADD COLUMN mcp_config TEXT;
    `
  },
  {
    version: 6,
    name: '006-mission-type',
    sql: `
      ALTER TABLE missions ADD COLUMN type TEXT DEFAULT 'code';
    `
  },
  {
    version: 7,
    name: '007-first-officer',
    sql: `
      CREATE TABLE IF NOT EXISTS memos (
        id TEXT PRIMARY KEY,
        crew_id TEXT REFERENCES crew(id),
        mission_id INTEGER REFERENCES missions(id),
        event_type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unread',
        retry_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT (datetime('now')),
        updated_at DATETIME DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_memos_crew_mission ON memos(crew_id, mission_id);
      CREATE INDEX IF NOT EXISTS idx_memos_status ON memos(status);

      ALTER TABLE missions ADD COLUMN first_officer_retry_count INTEGER DEFAULT 0;
    `
  },
  {
    version: 8,
    name: '008-pr-review',
    sql: `
      ALTER TABLE missions ADD COLUMN review_round INTEGER DEFAULT 0;
      ALTER TABLE missions ADD COLUMN pr_branch TEXT;
    `
  },
  {
    version: 9,
    name: '009-mission-dependencies',
    sql: `
      CREATE TABLE IF NOT EXISTS mission_dependencies (
        mission_id             INTEGER NOT NULL REFERENCES missions(id),
        depends_on_mission_id  INTEGER NOT NULL REFERENCES missions(id),
        PRIMARY KEY (mission_id, depends_on_mission_id)
      );

      INSERT OR IGNORE INTO mission_dependencies (mission_id, depends_on_mission_id)
      SELECT id, depends_on_mission_id FROM missions WHERE depends_on_mission_id IS NOT NULL;
    `
  },
  {
    version: 10,
    name: '010-fo-circuit-breaker',
    sql: `
      ALTER TABLE missions ADD COLUMN last_error_fingerprint TEXT;
      ALTER TABLE missions ADD COLUMN mission_deployment_count INTEGER DEFAULT 0;
      ALTER TABLE comms ADD COLUMN mission_id INTEGER REFERENCES missions(id);
      CREATE INDEX IF NOT EXISTS idx_comms_mission_type ON comms(mission_id, type, read);
      DROP TABLE IF EXISTS memos;

      INSERT OR IGNORE INTO starbase_config (key, value) VALUES ('max_mission_deployments', '8');
      UPDATE starbase_config SET value = '"claude-haiku-4-5"' WHERE key = 'first_officer_model';
    `
  },
  {
    version: 11,
    name: '011-protocols-navigator',
    sql: `
      CREATE TABLE IF NOT EXISTS protocols (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        help_text TEXT,
        trigger_examples TEXT,
        enabled INTEGER DEFAULT 1,
        built_in INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT (datetime('now')),
        updated_at DATETIME DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS protocol_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        protocol_id TEXT REFERENCES protocols(id) ON DELETE CASCADE,
        step_order INTEGER NOT NULL,
        type TEXT NOT NULL,
        config TEXT NOT NULL,
        description TEXT,
        UNIQUE(protocol_id, step_order)
      );

      CREATE TABLE IF NOT EXISTS protocol_executions (
        id TEXT PRIMARY KEY,
        protocol_id TEXT REFERENCES protocols(id),
        status TEXT NOT NULL DEFAULT 'running',
        current_step INTEGER NOT NULL DEFAULT 1,
        feature_request TEXT NOT NULL,
        context TEXT,
        active_crew_ids TEXT,
        created_at DATETIME DEFAULT (datetime('now')),
        updated_at DATETIME DEFAULT (datetime('now'))
      );

      INSERT OR IGNORE INTO sectors (id, name, root_path, stack)
      VALUES ('global', 'Global', ':global:', 'none');

      INSERT OR IGNORE INTO starbase_config (key, value) VALUES ('navigator_model', '"claude-haiku-4-5"');
      INSERT OR IGNORE INTO starbase_config (key, value) VALUES ('navigator_max_concurrent', '2');
      INSERT OR IGNORE INTO starbase_config (key, value) VALUES ('navigator_timeout', '180');
      INSERT OR IGNORE INTO starbase_config (key, value) VALUES ('navigator_max_review_iterations', '3');
      INSERT OR IGNORE INTO starbase_config (key, value) VALUES ('navigator_gate_expiry', '86400');
      INSERT OR IGNORE INTO starbase_config (key, value) VALUES ('protocol_executions_retention_days', '30');
    `
  },
  {
    version: 12,
    name: '012-protocol-fk-columns',
    sql: `
      ALTER TABLE missions ADD COLUMN protocol_execution_id TEXT REFERENCES protocol_executions(id);
      ALTER TABLE comms ADD COLUMN execution_id TEXT REFERENCES protocol_executions(id);
      ALTER TABLE cargo ADD COLUMN protocol_execution_id TEXT REFERENCES protocol_executions(id);
      CREATE INDEX IF NOT EXISTS idx_comms_execution ON comms(execution_id, read);
      CREATE INDEX IF NOT EXISTS idx_missions_execution ON missions(protocol_execution_id);
    `
  }
]

export const CONFIG_DEFAULTS: Record<string, unknown> = {
  max_concurrent_worktrees: 5,
  worktree_pool_size: 2,
  worktree_disk_budget_gb: 5,
  default_mission_timeout_min: 15,
  default_merge_strategy: 'pr',
  comms_rate_limit_per_min: 30,
  default_token_budget: 0,
  lifesign_interval_sec: 10,
  lifesign_timeout_sec: 30,
  default_review_mode: 'admiral-review',
  review_timeout_min: 10,
  comms_retention_days: 30,
  cargo_retention_days: 14,
  ships_log_retention_days: 30,
  crew_retention_days: 7,
  forward_failed_cargo: false,
  min_deploy_free_memory_gb: 1.5,
  first_officer_max_retries: 3,
  first_officer_max_concurrent: 2,
  first_officer_timeout: 120,
  first_officer_model: 'claude-haiku-4-5',
  max_mission_deployments: 8,
  review_crew_max_concurrent: 2,
  navigator_model: 'claude-haiku-4-5',
  navigator_max_concurrent: 2,
  navigator_timeout: 180,
  navigator_max_review_iterations: 3,
  navigator_gate_expiry: 86400,
  protocol_executions_retention_days: 30,
}
