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
  min_deploy_free_memory_gb: 1.5
}
