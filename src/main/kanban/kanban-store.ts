import Database from 'better-sqlite3';
import { mkdirSync, rmSync, existsSync, realpathSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { createLogger } from '../logger';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema';
import type {
  Task,
  TaskStatus,
  CreateTaskInput,
  TaskRun,
  TaskEvent,
  TaskComment,
  TaskAttachment,
  TaskArtifact,
  ArtifactKind,
  ArtifactListItem,
  ArtifactListFilter,
  RunOutcome,
  UpdateTaskFields,
  BoardCard,
  Board,
  BoardDigestConfig,
  Project,
  RunMode,
  PendingMode,
  ScheduleInput,
  Feature,
  FeatureStatus,
  CreateFeatureInput,
  UpdateFeatureInput,
  FeatureRollup,
  TaskPrInfo,
  PrState,
  ChecksState,
  ConflictState,
  FeatureSuggestion,
  SuggestionStatus,
  CreateSuggestionInput,
  VerifyCommand,
  ReviewVerdict,
  PmProposal,
  PmProposalKind,
  PmProposalStatus
} from '../../shared/kanban-types';
import { validateSchedule, computeNextRun } from './schedule';
import { prepareAttachmentFile, removeAttachmentFile } from './attachments';
import {
  prepareArtifactFile,
  removeArtifactFile,
  listUnregisteredLeftovers
} from './artifact-files';
import { deriveBoardSlug } from './board-slug';
import { removeWorktree, cleanupWorkspace } from './workspace';
import { isSwarmRoot } from './kanban-swarm';

const log = createLogger('kanban-store');

const VERIFY_COMMANDS_SCHEMA = z.array(
  z.object({ label: z.string().min(1), command: z.string().min(1) })
);

/** Parse a project's verify_commands JSON; malformed/empty → []. */
function parseVerifyCommands(raw: unknown): VerifyCommand[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    return VERIFY_COMMANDS_SCHEMA.parse(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** Append a plain reference line pointing at a seeded artifact (reuse provenance). */
function appendArtifactReference(body: string, art: { filename: string }): string {
  const ref = `Seeded from artifact: ${art.filename} (attached).`;
  return body.trim() ? `${body.trimEnd()}\n\n${ref}` : ref;
}

/** Build a task's PR tracking sub-object, or null when it has never had a PR. */
function prInfoFromRow(r: Record<string, unknown>): TaskPrInfo | null {
  const url = (r.pr_url as string | null) ?? null;
  const number = (r.pr_number as number | null) ?? null;
  if (url == null && number == null) return null;
  return {
    url,
    number,
    state: (r.pr_state as PrState | null) ?? null,
    checksState: (r.checks_state as ChecksState | null) ?? null,
    mergeState: (r.pr_merge_state as string | null) ?? null,
    syncedAt: (r.pr_synced_at as number | null) ?? null
  };
}

export interface KanbanStoreOptions {
  now?: () => number;
  onEvent?: (event: TaskEvent) => void;
  onBoardsChanged?: () => void;
}

export class KanbanStore {
  protected db: Database.Database;
  protected now: () => number;
  protected onEvent?: (event: TaskEvent) => void;
  protected onBoardsChanged?: () => void;
  private attachmentsRoot: string;
  private artifactsRoot: string;
  private workspacesRoot: string;

  constructor(dbPath: string, opts: KanbanStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.onEvent = opts.onEvent;
    this.onBoardsChanged = opts.onBoardsChanged;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.attachmentsRoot = join(dirname(dbPath), 'attachments');
    this.artifactsRoot = join(dirname(dbPath), 'artifacts');
    this.workspacesRoot = join(dirname(dbPath), 'workspaces');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    log.info('kanban store opened', { dbPath });
  }

  /** Run `fn` inside a single SQLite transaction. Rolls back if `fn` throws. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private migrate(): void {
    this.db.exec(SCHEMA_SQL);
    const current = Number(this.db.pragma('user_version', { simple: true }));
    if (current < 2) {
      // Additive: older DBs created before v2 lack these columns.
      this.addColumnIfMissing('tasks', 'pending_mode', 'TEXT');
      this.addColumnIfMissing('task_runs', 'mode', "TEXT NOT NULL DEFAULT 'work'");
    }
    if (current < 3) {
      // Additive: DBs created before v3 lack the worktree source repo column.
      this.addColumnIfMissing('tasks', 'repo_path', 'TEXT');
    }
    if (current < 5) {
      // Additive: DBs created before v5 lack the board column.
      this.addColumnIfMissing('tasks', 'board_id', "TEXT NOT NULL DEFAULT 'default'");
      // Index must be created AFTER the column exists (it can't live in SCHEMA_SQL,
      // which runs before this block against a pre-v5 tasks table).
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_board ON tasks(board_id)');
    }
    if (current < 6) {
      // Additive: DBs created before v6 lack the scheduling columns.
      this.addColumnIfMissing('tasks', 'schedule_kind', 'TEXT');
      this.addColumnIfMissing('tasks', 'schedule_cron', 'TEXT');
      this.addColumnIfMissing('tasks', 'schedule_interval_ms', 'INTEGER');
      this.addColumnIfMissing('tasks', 'next_run_at', 'INTEGER');
      this.addColumnIfMissing('tasks', 'schedule_paused', 'INTEGER NOT NULL DEFAULT 0');
      this.addColumnIfMissing('tasks', 'scheduled_from', 'TEXT');
    }
    if (current < 8) {
      // Additive: DBs created before v8 lack the worktree merge-target column.
      this.addColumnIfMissing('tasks', 'base_branch', 'TEXT');
    }
    if (current < 9) {
      // Additive: DBs created before v9 lack the features table + per-task PR/feature
      // columns. The features table is in SCHEMA_SQL for fresh installs; create it here
      // too (idempotent) so existing DBs gain it.
      this.db.exec(`CREATE TABLE IF NOT EXISTS features (
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
      )`);
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_features_board ON features(board_id)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_features_status ON features(status)');
      this.addColumnIfMissing('tasks', 'feature_id', 'TEXT');
      this.addColumnIfMissing('tasks', 'pr_url', 'TEXT');
      this.addColumnIfMissing('tasks', 'pr_number', 'INTEGER');
      this.addColumnIfMissing('tasks', 'pr_state', 'TEXT');
      this.addColumnIfMissing('tasks', 'checks_state', 'TEXT');
      this.addColumnIfMissing('tasks', 'pr_merge_state', 'TEXT');
      this.addColumnIfMissing('tasks', 'pr_synced_at', 'INTEGER');
      this.addColumnIfMissing('tasks', 'conflict_state', 'TEXT');
      this.addColumnIfMissing('tasks', 'conflict_files', 'TEXT');
      this.addColumnIfMissing('tasks', 'worktree_pruned', 'INTEGER NOT NULL DEFAULT 0');
      // Index must be created AFTER the column exists (it can't live in SCHEMA_SQL,
      // which runs before this block against a pre-v9 tasks table).
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_feature ON tasks(feature_id)');
    }
    if (current < 10) {
      // Additive: DBs created before v10 lack the projects table + per-task docs column.
      // The projects table is in SCHEMA_SQL for fresh installs; CREATE IF NOT EXISTS is
      // idempotent so existing DBs gain it here.
      this.addColumnIfMissing('tasks', 'docs', "TEXT NOT NULL DEFAULT '[]'");
    }
    if (current < 11) {
      // Phase-2 autopilot: bounded resolve-run budget + synthetic system-task marker.
      this.addColumnIfMissing('tasks', 'resolve_attempts', 'INTEGER NOT NULL DEFAULT 0');
      this.addColumnIfMissing('tasks', 'system_kind', 'TEXT');
    }
    if (current < 12) {
      // Phase-3 autopilot (draft PR lifecycle): feature-level PR freshness + a
      // fire-once flag for the "no remote/gh, PR skipped" event.
      this.addColumnIfMissing('features', 'checks_state', 'TEXT');
      this.addColumnIfMissing('features', 'pr_synced_at', 'INTEGER');
      this.addColumnIfMissing('features', 'pr_skip_notified', 'INTEGER NOT NULL DEFAULT 0');
    }
    if (current < 13) {
      // Auto-grouping (spec §4): PM feature-grouping suggestions, awaiting human Accept/Dismiss.
      this.db.exec(`CREATE TABLE IF NOT EXISTS feature_suggestions (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL,
        repo_path TEXT,
        name TEXT NOT NULL,
        task_ids TEXT NOT NULL DEFAULT '[]',
        reason TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      this.db.exec(
        'CREATE INDEX IF NOT EXISTS idx_suggestions_board ON feature_suggestions(board_id)'
      );
      this.db.exec(
        'CREATE INDEX IF NOT EXISTS idx_suggestions_status ON feature_suggestions(status)'
      );
    }
    if (current < 14) {
      // Deterministic verify gates (#231): per-project verify commands +
      // a bounded verify-fix budget on tasks. Additive, idempotent.
      this.addColumnIfMissing('projects', 'verify_commands', 'TEXT');
      this.addColumnIfMissing('tasks', 'verify_attempts', 'INTEGER NOT NULL DEFAULT 0');
    }
    if (current < 15) {
      // Agent code review (#232): per-task verdict, bounded review-fix budget,
      // and the approved HEAD sha that integrate merges. Additive, idempotent.
      this.addColumnIfMissing('tasks', 'review_verdict', 'TEXT');
      this.addColumnIfMissing('tasks', 'review_attempts', 'INTEGER NOT NULL DEFAULT 0');
      this.addColumnIfMissing('tasks', 'review_head_sha', 'TEXT');
    }
    if (current < 16) {
      // v16 introduced the pm_proposals table; it is created via SCHEMA_SQL
      // (CREATE TABLE IF NOT EXISTS) on every open, so no migration step is needed here.
    }
    if (current < 17) {
      // Per-board standup digest: cron schedule + last-run watermark. The columns
      // are in SCHEMA_SQL for fresh installs; add them here for existing DBs.
      this.addColumnIfMissing('boards', 'digest_cron', 'TEXT');
      this.addColumnIfMissing('boards', 'last_digest_at', 'INTEGER');
    }
    if (current < 18) {
      // SDLC pipeline templates (#234): stage identity on tasks + a QA verdict on
      // features. Additive, idempotent. The columns are in SCHEMA_SQL for fresh
      // installs; add them here for existing DBs. No new indexes.
      this.addColumnIfMissing('tasks', 'pipeline_template', 'TEXT');
      this.addColumnIfMissing('tasks', 'pipeline_stage', 'TEXT');
      this.addColumnIfMissing('features', 'qa_verdict', 'TEXT');
    }
    // Seed the permanent default board (idempotent: fresh and existing DBs).
    const ts = this.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO boards (slug, name, created_at, updated_at)
         VALUES ('default', 'Default', ?, ?)`
      )
      .run(ts, ts);
    if (current !== SCHEMA_VERSION) {
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
  }

  private addColumnIfMissing(table: string, column: string, decl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  }

  schemaVersion(): number {
    const row = this.db.pragma('user_version', { simple: true });
    return Number(row);
  }

  close(): void {
    this.db.close();
  }

  private rowToTask(r: Record<string, unknown>): Task {
    return {
      id: String(r.id),
      title: String(r.title),
      body: String(r.body ?? ''),
      assignee: (r.assignee as string | null) ?? null,
      status: r.status as TaskStatus,
      priority: Number(r.priority),
      tenant: (r.tenant as string | null) ?? null,
      workspaceKind: r.workspace_kind as Task['workspaceKind'],
      workspacePath: (r.workspace_path as string | null) ?? null,
      repoPath: (r.repo_path as string | null) ?? null,
      branchName: (r.branch_name as string | null) ?? null,
      baseBranch: (r.base_branch as string | null) ?? null,
      modelOverride: (r.model_override as string | null) ?? null,
      skills: JSON.parse(String(r.skills ?? '[]')) as string[],
      docs: JSON.parse(String(r.docs ?? '[]')) as string[],
      boardId: String(r.board_id ?? 'default'),
      featureId: (r.feature_id as string | null) ?? null,
      idempotencyKey: (r.idempotency_key as string | null) ?? null,
      result: (r.result as string | null) ?? null,
      pendingMode: (r.pending_mode as Task['pendingMode']) ?? null,
      claimLock: (r.claim_lock as string | null) ?? null,
      claimExpires: (r.claim_expires as number | null) ?? null,
      workerPid: (r.worker_pid as number | null) ?? null,
      currentRunId: (r.current_run_id as number | null) ?? null,
      lastHeartbeatAt: (r.last_heartbeat_at as number | null) ?? null,
      consecutiveFailures: Number(r.consecutive_failures),
      resolveAttempts: Number(r.resolve_attempts ?? 0),
      verifyAttempts: Number(r.verify_attempts ?? 0),
      reviewVerdict: (r.review_verdict as Task['reviewVerdict']) ?? null,
      reviewAttempts: Number(r.review_attempts ?? 0),
      reviewHeadSha: (r.review_head_sha as string | null) ?? null,
      lastFailureError: (r.last_failure_error as string | null) ?? null,
      maxRuntimeSeconds: (r.max_runtime_seconds as number | null) ?? null,
      maxRetries: Number(r.max_retries),
      scheduleKind: (r.schedule_kind as Task['scheduleKind']) ?? null,
      scheduleCron: (r.schedule_cron as string | null) ?? null,
      scheduleIntervalMs: (r.schedule_interval_ms as number | null) ?? null,
      nextRunAt: (r.next_run_at as number | null) ?? null,
      schedulePaused: Number(r.schedule_paused ?? 0) === 1,
      scheduledFrom: (r.scheduled_from as string | null) ?? null,
      prInfo: prInfoFromRow(r),
      conflictState: (r.conflict_state as ConflictState | null) ?? null,
      conflictFiles: JSON.parse(String(r.conflict_files ?? '[]')) as string[],
      worktreePruned: Number(r.worktree_pruned ?? 0) === 1,
      systemKind: (r.system_kind as string | null) ?? null,
      pipelineTemplate: (r.pipeline_template as Task['pipelineTemplate']) ?? null,
      pipelineStage: (r.pipeline_stage as Task['pipelineStage']) ?? null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at)
    };
  }

  createTask(input: CreateTaskInput): Task {
    const id = randomUUID().slice(0, 8);
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, body, assignee, status, priority, tenant,
          workspace_kind, workspace_path, repo_path, branch_name, base_branch, model_override, skills, docs, board_id, feature_id, idempotency_key,
          scheduled_from, system_kind, pipeline_template, pipeline_stage, max_runtime_seconds, max_retries, created_at, updated_at)
         VALUES (@id, @title, @body, @assignee, @status, @priority, @tenant,
          @workspace_kind, @workspace_path, @repo_path, @branch_name, @base_branch, @model_override, @skills, @docs, @board_id, @feature_id, @idempotency_key,
          @scheduled_from, @system_kind, @pipeline_template, @pipeline_stage, @max_runtime_seconds, @max_retries, @created_at, @updated_at)`
      )
      .run({
        id,
        title: input.title,
        body: input.body ?? '',
        assignee: input.assignee ?? null,
        status: input.status ?? 'todo',
        priority: input.priority ?? 0,
        tenant: input.tenant ?? null,
        workspace_kind: input.workspaceKind ?? 'scratch',
        workspace_path: input.workspacePath ?? null,
        repo_path: input.repoPath ?? null,
        branch_name: input.branchName ?? null,
        base_branch: input.baseBranch ?? null,
        model_override: input.modelOverride ?? null,
        skills: JSON.stringify(input.skills ?? []),
        docs: JSON.stringify(input.docs ?? []),
        board_id: input.boardId ?? 'default',
        feature_id: input.featureId ?? null,
        idempotency_key: input.idempotencyKey ?? null,
        scheduled_from: input.scheduledFrom ?? null,
        system_kind: input.systemKind ?? null,
        pipeline_template: input.pipelineTemplate ?? null,
        pipeline_stage: input.pipelineStage ?? null,
        max_runtime_seconds: input.maxRuntimeSeconds ?? null,
        max_retries: input.maxRetries ?? 1,
        created_at: ts,
        updated_at: ts
      });
    const task = this.getTask(id);
    if (!task) throw new Error('createTask: failed to read back task');
    return task;
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToTask(row) : null;
  }

  listTasks(filter: { status?: TaskStatus } = {}): Task[] {
    const rows = filter.status
      ? (this.db
          .prepare('SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, created_at ASC')
          .all(filter.status) as Array<Record<string, unknown>>)
      : (this.db
          .prepare('SELECT * FROM tasks ORDER BY priority DESC, created_at ASC')
          .all() as Array<Record<string, unknown>>);
    return rows.map((r) => this.rowToTask(r));
  }

  addLink(parentId: string, childId: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO task_links (parent_id, child_id) VALUES (?, ?)')
      .run(parentId, childId);
  }

  removeLink(parentId: string, childId: string): void {
    this.db
      .prepare('DELETE FROM task_links WHERE parent_id = ? AND child_id = ?')
      .run(parentId, childId);
  }

  parentsOf(childId: string): string[] {
    return (
      this.db.prepare('SELECT parent_id FROM task_links WHERE child_id = ?').all(childId) as Array<{
        parent_id: string;
      }>
    ).map((r) => r.parent_id);
  }

  childrenOf(parentId: string): string[] {
    return (
      this.db
        .prepare('SELECT child_id FROM task_links WHERE parent_id = ?')
        .all(parentId) as Array<{
        child_id: string;
      }>
    ).map((r) => r.child_id);
  }

  /**
   * Atomically claim a ready task. Returns true if this caller won the claim.
   * CAS: only succeeds if status='ready' and (no live lock OR claim expired).
   */
  claimTask(taskId: string, lock: string, ttlMs: number): boolean {
    const ts = this.now();
    const res = this.db
      .prepare(
        `UPDATE tasks
         SET status='running', claim_lock=@lock, claim_expires=@expires,
             last_heartbeat_at=@ts, updated_at=@ts
         WHERE id=@id AND status='ready'
           AND (claim_lock IS NULL OR claim_expires <= @ts)`
      )
      .run({ id: taskId, lock, expires: ts + ttlMs, ts });
    return res.changes === 1;
  }

  extendClaim(taskId: string, lock: string, ttlMs: number): boolean {
    const ts = this.now();
    const res = this.db
      .prepare(
        `UPDATE tasks SET claim_expires=@expires, last_heartbeat_at=@ts, updated_at=@ts
         WHERE id=@id AND claim_lock=@lock`
      )
      .run({ id: taskId, lock, expires: ts + ttlMs, ts });
    return res.changes === 1;
  }

  /** Clear claim fields and set status back to 'ready'. */
  returnToReady(taskId: string): void {
    const ts = this.now();
    this.db
      .prepare(
        `UPDATE tasks SET status='ready', claim_lock=NULL, claim_expires=NULL,
          worker_pid=NULL, current_run_id=NULL, updated_at=@ts
         WHERE id=@id`
      )
      .run({ id: taskId, ts });
  }

  /** Todo tasks whose parents (if any) are all settled (done or archived). */
  promotableTodoTasks(): Task[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM tasks t
       WHERE t.status = 'todo'
       AND NOT EXISTS (
         SELECT 1 FROM task_links l
         JOIN tasks p ON p.id = l.parent_id
         WHERE l.child_id = t.id AND p.status NOT IN ('done','archived')
       )`
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToTask(r));
  }

  private rowToRun(r: Record<string, unknown>): TaskRun {
    return {
      id: Number(r.id),
      taskId: String(r.task_id),
      profile: (r.profile as string | null) ?? null,
      status: r.status as TaskRun['status'],
      mode: (r.mode as TaskRun['mode']) ?? 'work',
      workerPid: (r.worker_pid as number | null) ?? null,
      startedAt: Number(r.started_at),
      endedAt: (r.ended_at as number | null) ?? null,
      outcome: (r.outcome as RunOutcome | null) ?? null,
      summary: (r.summary as string | null) ?? null,
      metadata: r.metadata ? (JSON.parse(String(r.metadata)) as Record<string, unknown>) : null,
      error: (r.error as string | null) ?? null
    };
  }

  startRun(
    taskId: string,
    profile: string | null,
    workerPid: number | null,
    mode: RunMode = 'work'
  ): TaskRun {
    const ts = this.now();
    const info = this.db
      .prepare(
        `INSERT INTO task_runs (task_id, profile, status, mode, worker_pid, started_at)
         VALUES (?, ?, 'running', ?, ?, ?)`
      )
      .run(taskId, profile, mode, workerPid, ts);
    const runId = Number(info.lastInsertRowid);
    this.db
      .prepare('UPDATE tasks SET current_run_id=?, worker_pid=?, updated_at=? WHERE id=?')
      .run(runId, workerPid, ts, taskId);
    const run = this.db.prepare('SELECT * FROM task_runs WHERE id=?').get(runId) as Record<
      string,
      unknown
    >;
    return this.rowToRun(run);
  }

  finishRun(
    runId: number,
    outcome: RunOutcome,
    opts: { summary?: string; metadata?: Record<string, unknown>; error?: string } = {}
  ): void {
    const ts = this.now();
    this.db
      .prepare(
        `UPDATE task_runs SET status='finished', ended_at=?, outcome=?, summary=?, metadata=?, error=?
         WHERE id=? AND status='running'`
      )
      .run(
        ts,
        outcome,
        opts.summary ?? null,
        opts.metadata ? JSON.stringify(opts.metadata) : null,
        opts.error ?? null,
        runId
      );
  }

  listRuns(taskId: string): TaskRun[] {
    // `id DESC` tiebreaks runs started in the same millisecond so [0] is
    // deterministically the most recent run (relied on by replyAndResume).
    const rows = this.db
      .prepare('SELECT * FROM task_runs WHERE task_id=? ORDER BY started_at DESC, id DESC')
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToRun(r));
  }

  appendEvent(
    taskId: string,
    runId: number | null,
    kind: string,
    payload?: Record<string, unknown>
  ): TaskEvent {
    const ts = this.now();
    const info = this.db
      .prepare(
        `INSERT INTO task_events (task_id, run_id, kind, payload, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(taskId, runId, kind, payload ? JSON.stringify(payload) : null, ts);
    const event: TaskEvent = {
      id: Number(info.lastInsertRowid),
      taskId,
      runId,
      kind,
      payload: payload ?? null,
      createdAt: ts
    };
    this.onEvent?.(event);
    return event;
  }

  /**
   * Drop a spec task's re-arm guards so a re-armed run may re-fan-out AND the dispatcher
   * may raise a fresh approval proposal once it completes again (pipeline §6). Clears both
   * the fan-out guard (`children_emitted`) and the one-shot approval guard
   * (`spec_approval_raised`); leaving the latter would permanently silence raiseSpecApprovals.
   */
  clearSpecFanout(specTaskId: string): void {
    this.db
      .prepare(
        "DELETE FROM task_events WHERE task_id=? AND kind IN ('children_emitted','spec_approval_raised')"
      )
      .run(specTaskId);
  }

  listEvents(taskId: string): TaskEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM task_events WHERE task_id=? ORDER BY id ASC')
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      taskId: String(r.task_id),
      runId: (r.run_id as number | null) ?? null,
      kind: String(r.kind),
      payload: r.payload ? (JSON.parse(String(r.payload)) as Record<string, unknown>) : null,
      createdAt: Number(r.created_at)
    }));
  }

  /** All events for a board's tasks since `since` (epoch ms), oldest first. */
  listBoardEventsSince(boardId: string, since: number): TaskEvent[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM task_events e
           JOIN tasks t ON t.id = e.task_id
          WHERE t.board_id = ? AND e.created_at >= ?
          ORDER BY e.id ASC`
      )
      .all(boardId, since) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      taskId: String(r.task_id),
      runId: (r.run_id as number | null) ?? null,
      kind: String(r.kind),
      payload: r.payload ? (JSON.parse(String(r.payload)) as Record<string, unknown>) : null,
      createdAt: Number(r.created_at)
    }));
  }

  addComment(taskId: string, author: string, body: string): TaskComment {
    const ts = this.now();
    const info = this.db
      .prepare('INSERT INTO task_comments (task_id, author, body, created_at) VALUES (?, ?, ?, ?)')
      .run(taskId, author, body, ts);
    return { id: Number(info.lastInsertRowid), taskId, author, body, createdAt: ts };
  }

  listComments(taskId: string): TaskComment[] {
    const rows = this.db
      .prepare('SELECT * FROM task_comments WHERE task_id=? ORDER BY id ASC')
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      taskId: String(r.task_id),
      author: String(r.author),
      body: String(r.body),
      createdAt: Number(r.created_at)
    }));
  }

  private rowToAttachment(r: Record<string, unknown>): TaskAttachment {
    return {
      id: String(r.id),
      taskId: String(r.task_id),
      filename: String(r.filename),
      storedPath: String(r.stored_path),
      contentType: (r.content_type as string | null) ?? null,
      size: Number(r.size),
      createdAt: Number(r.created_at)
    };
  }

  addAttachment(taskId: string, sourcePath: string): TaskAttachment {
    const id = randomUUID().slice(0, 8);
    const prepared = prepareAttachmentFile({
      attachmentsRoot: this.attachmentsRoot,
      taskId,
      attachmentId: id,
      sourcePath
    });
    const ts = this.now();
    try {
      this.db
        .prepare(
          `INSERT INTO task_attachments (id, task_id, filename, stored_path, content_type, size, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          taskId,
          prepared.filename,
          prepared.storedPath,
          prepared.contentType,
          prepared.size,
          ts
        );
    } catch (err) {
      removeAttachmentFile(prepared.storedPath); // never leave an orphan file
      throw err;
    }
    return {
      id,
      taskId,
      filename: prepared.filename,
      storedPath: prepared.storedPath,
      contentType: prepared.contentType,
      size: prepared.size,
      createdAt: ts
    };
  }

  listAttachments(taskId: string): TaskAttachment[] {
    const rows = this.db
      .prepare('SELECT * FROM task_attachments WHERE task_id=? ORDER BY created_at ASC, id ASC')
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToAttachment(r));
  }

  getAttachment(id: string): TaskAttachment | null {
    const row = this.db.prepare('SELECT * FROM task_attachments WHERE id=?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToAttachment(row) : null;
  }

  removeAttachment(id: string): void {
    const att = this.getAttachment(id);
    if (!att) return;
    removeAttachmentFile(att.storedPath);
    this.db.prepare('DELETE FROM task_attachments WHERE id=?').run(id);
  }

  private rowToArtifact(r: Record<string, unknown>): TaskArtifact {
    return {
      id: String(r.id),
      taskId: String(r.task_id),
      runId: (r.run_id as number | null) ?? null,
      boardId: String(r.board_id),
      title: (r.title as string | null) ?? null,
      filename: String(r.filename),
      sourceRelPath: String(r.source_rel_path),
      storedPath: String(r.stored_path),
      kind: r.kind as ArtifactKind,
      contentType: (r.content_type as string | null) ?? null,
      size: Number(r.size),
      state: r.state as TaskArtifact['state'],
      createdAt: Number(r.created_at),
      discardedAt: (r.discarded_at as number | null) ?? null
    };
  }

  /** Register a worker-produced file as a durable artifact (copy taken at registration time). */
  addArtifact(input: {
    taskId: string;
    runId: number | null;
    boardId: string;
    workspaceRoot: string;
    relPath: string;
    title?: string | null;
    kind?: ArtifactKind;
  }): TaskArtifact {
    const id = randomUUID().slice(0, 8);
    const prepared = prepareArtifactFile({
      artifactsRoot: this.artifactsRoot,
      boardId: input.boardId,
      taskId: input.taskId,
      artifactId: id,
      workspaceRoot: input.workspaceRoot,
      relPath: input.relPath,
      kind: input.kind
    });
    const ts = this.now();
    const title = input.title ?? null;
    try {
      this.db
        .prepare(
          `INSERT INTO task_artifacts
            (id, task_id, run_id, board_id, title, filename, source_rel_path, stored_path,
             kind, content_type, size, state, created_at, discarded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'kept', ?, NULL)`
        )
        .run(
          id,
          input.taskId,
          input.runId,
          input.boardId,
          title,
          prepared.filename,
          prepared.sourceRelPath,
          prepared.storedPath,
          prepared.kind,
          prepared.contentType,
          prepared.size,
          ts
        );
    } catch (err) {
      removeArtifactFile(prepared.storedPath); // never leave an orphan file
      throw err;
    }
    return {
      id,
      taskId: input.taskId,
      runId: input.runId,
      boardId: input.boardId,
      title,
      filename: prepared.filename,
      sourceRelPath: prepared.sourceRelPath,
      storedPath: prepared.storedPath,
      kind: prepared.kind,
      contentType: prepared.contentType,
      size: prepared.size,
      state: 'kept',
      createdAt: ts,
      discardedAt: null
    };
  }

  listArtifacts(taskId: string): TaskArtifact[] {
    const rows = this.db
      .prepare('SELECT * FROM task_artifacts WHERE task_id=? ORDER BY created_at ASC, id ASC')
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToArtifact(r));
  }

  getArtifact(id: string): TaskArtifact | null {
    const row = this.db.prepare('SELECT * FROM task_artifacts WHERE id=?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToArtifact(row) : null;
  }

  /** Cross-board feed for the global Artifacts browser: artifacts joined with task + board. */
  listAllArtifacts(filter: ArtifactListFilter = {}): ArtifactListItem[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.boardSlug) {
      where.push('a.board_id=@board');
      params.board = filter.boardSlug;
    }
    if (filter.state) {
      where.push('a.state=@state');
      params.state = filter.state;
    }
    if (filter.kind) {
      where.push('a.kind=@kind');
      params.kind = filter.kind;
    }
    if (filter.query?.trim()) {
      where.push('(a.filename LIKE @q OR a.title LIKE @q OR t.title LIKE @q)');
      params.q = `%${filter.query.trim()}%`;
    }
    const sql = `SELECT a.*, t.title AS task_title, b.name AS board_name
       FROM task_artifacts a
       JOIN tasks t ON t.id = a.task_id
       LEFT JOIN boards b ON b.slug = a.board_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY a.created_at DESC, a.id DESC`;
    const rows = this.db.prepare(sql).all(params) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      ...this.rowToArtifact(r),
      taskTitle: (r.task_title as string | null) ?? '',
      boardName: (r.board_name as string | null) ?? (r.board_id as string | null) ?? ''
    }));
  }

  discardArtifact(id: string): void {
    this.db
      .prepare(
        "UPDATE task_artifacts SET state='discarded', discarded_at=? WHERE id=? AND state='kept'"
      )
      .run(this.now(), id);
  }

  restoreArtifact(id: string): void {
    this.db
      .prepare(
        "UPDATE task_artifacts SET state='kept', discarded_at=NULL WHERE id=? AND state='discarded'"
      )
      .run(id);
  }

  /** Hard delete: remove the row and the stored file copy. */
  purgeArtifact(id: string): void {
    const art = this.getArtifact(id);
    if (!art) return;
    removeArtifactFile(art.storedPath);
    this.db.prepare('DELETE FROM task_artifacts WHERE id=?').run(id);
  }

  /**
   * Retention sweep: purge discarded artifacts whose discard predates `cutoffMs`. Returns
   * per-artifact metadata (not just a count) so the caller can emit one visible purge event each.
   */
  purgeDiscardedBefore(
    cutoffMs: number
  ): Array<{ id: string; taskId: string; runId: number | null; filename: string }> {
    const rows = this.db
      .prepare(
        "SELECT id, task_id, run_id, filename, stored_path FROM task_artifacts WHERE state='discarded' AND discarded_at IS NOT NULL AND discarded_at <= ?"
      )
      .all(cutoffMs) as Array<Record<string, unknown>>;
    const purged: Array<{ id: string; taskId: string; runId: number | null; filename: string }> =
      [];
    for (const r of rows) {
      removeArtifactFile(String(r.stored_path));
      this.db.prepare('DELETE FROM task_artifacts WHERE id=?').run(String(r.id));
      purged.push({
        id: String(r.id),
        taskId: String(r.task_id),
        runId: (r.run_id as number | null) ?? null,
        filename: String(r.filename)
      });
    }
    return purged;
  }

  /**
   * Atomically create a task seeded with a kept artifact: the artifact copy is attached and a
   * reference line is appended to the body, inside one transaction. Copied attachment files are
   * removed if the transaction rolls back, so neither a task-without-input nor an orphan file
   * can result.
   */
  createTaskFromArtifact(artifactId: string, input: CreateTaskInput): Task {
    const art = this.getArtifact(artifactId);
    if (!art) throw new Error(`artifact not found: ${artifactId}`);
    if (art.state !== 'kept') throw new Error('only kept artifacts can be reused');
    const copied: string[] = [];
    try {
      return this.transaction(() => {
        const task = this.createTask({
          ...input,
          body: appendArtifactReference(input.body ?? '', art)
        });
        const att = this.addAttachment(task.id, art.storedPath);
        copied.push(att.storedPath);
        return task;
      });
    } catch (err) {
      for (const p of copied) removeAttachmentFile(p);
      throw err;
    }
  }

  /** Attach a kept artifact's copy to an existing task and append a reference line to its body.
   *  Caller is responsible for rollback file cleanup when used inside a larger transaction. */
  attachArtifactToTask(taskId: string, artifactId: string): TaskAttachment {
    const art = this.getArtifact(artifactId);
    if (!art) throw new Error(`artifact not found: ${artifactId}`);
    if (art.state !== 'kept') throw new Error('only kept artifacts can be reused');
    const att = this.addAttachment(taskId, art.storedPath);
    const task = this.getTask(taskId);
    if (task) {
      this.db
        .prepare('UPDATE tasks SET body=?, updated_at=? WHERE id=?')
        .run(appendArtifactReference(task.body, art), this.now(), taskId);
    }
    return att;
  }

  /** Top-level files in a scratch task's workspace not yet registered as artifacts (§6). */
  scratchLeftovers(taskId: string): string[] {
    const task = this.getTask(taskId);
    if (task?.workspaceKind !== 'scratch' || !task.workspacePath) return [];
    if (!existsSync(task.workspacePath)) return [];
    const registered = this.listArtifacts(taskId).map((a) => a.sourceRelPath);
    return listUnregisteredLeftovers({
      workspaceRoot: task.workspacePath,
      registeredRelPaths: registered
    });
  }

  /**
   * Delete a scratch task's workspace dir. The recursive delete is canonicalization-guarded:
   * the workspace must be a direct child of the canonical workspaces root, so a symlinked
   * component can never redirect the rm onto the user's real files. Returns true if deleted.
   */
  deleteScratchWorkspace(taskId: string): boolean {
    const task = this.getTask(taskId);
    if (task?.workspaceKind !== 'scratch' || !task.workspacePath) return false;
    let canonRoot: string;
    let canonWs: string;
    try {
      canonRoot = realpathSync(this.workspacesRoot);
      canonWs = realpathSync(task.workspacePath);
    } catch {
      return false; // path already gone or unreadable
    }
    if (dirname(canonWs) !== canonRoot) return false; // not a direct child — refuse
    rmSync(canonWs, { recursive: true, force: true });
    return true;
  }

  completeTask(taskId: string, result: string | null): void {
    const ts = this.now();
    this.db
      .prepare(
        `UPDATE tasks SET status='done', result=?, claim_lock=NULL, claim_expires=NULL,
          worker_pid=NULL, current_run_id=NULL, consecutive_failures=0, last_failure_error=NULL, updated_at=?
         WHERE id=?`
      )
      .run(result, ts, taskId);
  }

  /** Record a freshly-created PR on a task (no status change); poller fills in checks/merge state. */
  setPr(taskId: string, prUrl: string, prNumber: number | null): void {
    const ts = this.now();
    this.db
      .prepare(
        `UPDATE tasks SET pr_url=?, pr_number=?, pr_state='open', pr_synced_at=?, updated_at=? WHERE id=?`
      )
      .run(prUrl, prNumber, ts, ts, taskId);
  }

  /**
   * Write back polled PR status (the PrPoller's only mutation). Does NOT bump
   * updated_at — a background poll is metadata, not a task edit; the poller emits
   * an explicit event when something actually changed. `prNumber` is written only
   * when supplied (a poll can discover the number for a URL-only PR).
   */
  setPrStatus(
    taskId: string,
    fields: {
      prState: PrState | null;
      checksState: ChecksState | null;
      prMergeState: string | null;
      prNumber?: number | null;
    }
  ): void {
    const ts = this.now();
    if (fields.prNumber !== undefined) {
      this.db
        .prepare(
          `UPDATE tasks SET pr_state=?, checks_state=?, pr_merge_state=?, pr_number=?, pr_synced_at=? WHERE id=?`
        )
        .run(fields.prState, fields.checksState, fields.prMergeState, fields.prNumber, ts, taskId);
    } else {
      this.db
        .prepare(
          `UPDATE tasks SET pr_state=?, checks_state=?, pr_merge_state=?, pr_synced_at=? WHERE id=?`
        )
        .run(fields.prState, fields.checksState, fields.prMergeState, ts, taskId);
    }
  }

  /** Record the result of a local pre-merge conflict check (no updated_at bump). */
  setTaskConflict(taskId: string, state: ConflictState | null, files: string[]): void {
    this.db
      .prepare('UPDATE tasks SET conflict_state=?, conflict_files=? WHERE id=?')
      .run(state, JSON.stringify(files), taskId);
  }

  /**
   * Worktree tasks with a live workspace on disk (Phase 4). Used both by the board
   * manager (all statuses on a board) and the prune sweep (finished tasks, any board).
   */
  worktreeTasks(filter: { boardId?: string; statuses?: TaskStatus[] } = {}): Task[] {
    const where = ["workspace_kind='worktree'", 'workspace_path IS NOT NULL'];
    const params: unknown[] = [];
    if (filter.boardId) {
      where.push('board_id=?');
      params.push(filter.boardId);
    }
    if (filter.statuses?.length) {
      where.push(`status IN (${filter.statuses.map(() => '?').join(',')})`);
      params.push(...filter.statuses);
    }
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY created_at ASC`)
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToTask(r));
  }

  /** Mark a task's worktree as pruned: the dir is gone, so clear its path and flag it. */
  setWorktreePruned(taskId: string): void {
    this.db
      .prepare('UPDATE tasks SET worktree_pruned=1, workspace_path=NULL, updated_at=? WHERE id=?')
      .run(this.now(), taskId);
  }

  /** Open/draft-PR tasks not polled since `cutoff` (oldest sync first), for the PrPoller. */
  tasksDuePrSync(cutoff: number, limit: number): Task[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE pr_number IS NOT NULL AND pr_state IN ('open','draft')
           AND (pr_synced_at IS NULL OR pr_synced_at <= @cutoff)
         ORDER BY pr_synced_at ASC
         LIMIT @limit`
      )
      .all({ cutoff, limit }) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToTask(r));
  }

  /**
   * Land a worktree task in the human review gate: same claim-clearing as
   * completeTask, but status='review' (not 'done'), so the work is preserved and
   * dependent children stay gated until a human picks an integration action.
   */
  reviewTask(taskId: string, result: string | null): void {
    const ts = this.now();
    this.db
      .prepare(
        `UPDATE tasks SET status='review', result=?, claim_lock=NULL, claim_expires=NULL,
          worker_pid=NULL, current_run_id=NULL, consecutive_failures=0, last_failure_error=NULL, updated_at=?
         WHERE id=?`
      )
      .run(result, ts, taskId);
  }

  blockTask(taskId: string, reason: string): void {
    const ts = this.now();
    this.db
      .prepare(
        `UPDATE tasks SET status='blocked', result=?, claim_lock=NULL, claim_expires=NULL,
          worker_pid=NULL, current_run_id=NULL, updated_at=?
         WHERE id=?`
      )
      .run(reason, ts, taskId);
  }

  recordFailure(taskId: string, error: string): void {
    const ts = this.now();
    this.db
      .prepare(
        `UPDATE tasks SET consecutive_failures = consecutive_failures + 1,
          last_failure_error=?, updated_at=? WHERE id=?`
      )
      .run(error, ts, taskId);
  }

  giveUp(taskId: string, error: string): void {
    const ts = this.now();
    this.db
      .prepare(
        `UPDATE tasks SET status='blocked', result=?, claim_lock=NULL, claim_expires=NULL,
          worker_pid=NULL, current_run_id=NULL, last_failure_error=?, updated_at=?
         WHERE id=?`
      )
      .run(`gave-up: ${error}`, error, ts, taskId);
  }

  runningTasks(): Task[] {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE status='running'").all() as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => this.rowToTask(r));
  }

  readyTasks(): Task[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM tasks WHERE status='ready' AND assignee IS NOT NULL ORDER BY priority DESC, created_at ASC"
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToTask(r));
  }

  /** Ready tasks with no assignee — the auto-assign stage's input (claimAndSpawn ignores these). */
  unassignedReadyTasks(): Task[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM tasks WHERE status='ready' AND assignee IS NULL ORDER BY priority DESC, created_at ASC"
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToTask(r));
  }

  /** Review-column feature tasks with a live worktree, eligible for auto-integration. Excludes system tasks. */
  reviewWorktreeFeatureTasks(): Task[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status='review' AND feature_id IS NOT NULL AND system_kind IS NULL
           AND workspace_kind='worktree' AND workspace_path IS NOT NULL
           AND branch_name IS NOT NULL AND base_branch IS NOT NULL
         ORDER BY priority DESC, created_at ASC`
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToTask(r));
  }

  listBoard(boardSlug?: string): BoardCard[] {
    const tasks = boardSlug
      ? this.listTasks().filter((t) => t.boardId === boardSlug)
      : this.listTasks();
    const commentRows = this.db
      .prepare('SELECT task_id, COUNT(*) AS c FROM task_comments GROUP BY task_id')
      .all() as Array<{ task_id: string; c: number }>;
    const commentCounts = new Map(commentRows.map((r) => [r.task_id, Number(r.c)]));
    const childRows = this.db
      .prepare(
        `SELECT l.parent_id AS parent, COUNT(*) AS total,
          SUM(CASE WHEN c.status='done' THEN 1 ELSE 0 END) AS done
         FROM task_links l JOIN tasks c ON c.id = l.child_id
         GROUP BY l.parent_id`
      )
      .all() as Array<{ parent: string; total: number; done: number }>;
    const childMap = new Map(
      childRows.map((r) => [r.parent, { total: Number(r.total), done: Number(r.done) }])
    );
    const artifactRows = this.db
      .prepare(
        "SELECT task_id, COUNT(*) AS c FROM task_artifacts WHERE state='kept' GROUP BY task_id"
      )
      .all() as Array<{ task_id: string; c: number }>;
    const artifactCounts = new Map(artifactRows.map((r) => [r.task_id, Number(r.c)]));
    return tasks.map((t) => ({
      ...t,
      commentCount: commentCounts.get(t.id) ?? 0,
      childTotal: childMap.get(t.id)?.total ?? 0,
      childDone: childMap.get(t.id)?.done ?? 0,
      artifactCount: artifactCounts.get(t.id) ?? 0
    }));
  }

  private rowToBoard(r: Record<string, unknown>): Board {
    return {
      slug: String(r.slug),
      name: String(r.name),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at)
    };
  }

  listBoards(): Board[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM boards
         ORDER BY CASE WHEN slug='default' THEN 0 ELSE 1 END, created_at ASC, slug ASC`
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToBoard(r));
  }

  /** Digest config for a board. A missing/unknown slug yields the all-null config (same as an unconfigured board). */
  getDigestConfig(boardSlug: string): BoardDigestConfig {
    const row = this.db
      .prepare('SELECT digest_cron, last_digest_at FROM boards WHERE slug=?')
      .get(boardSlug) as
      | { digest_cron: string | null; last_digest_at: number | null }
      | undefined;
    return {
      digestCron: row?.digest_cron ?? null,
      lastDigestAt: row?.last_digest_at ?? null
    };
  }

  setDigestCron(boardSlug: string, cron: string | null): void {
    this.db.prepare('UPDATE boards SET digest_cron=? WHERE slug=?').run(cron, boardSlug);
  }

  stampLastDigest(boardSlug: string): void {
    this.db.prepare('UPDATE boards SET last_digest_at=? WHERE slug=?').run(this.now(), boardSlug);
  }

  private rowToProject(r: Record<string, unknown>): Project {
    return {
      id: String(r.id),
      boardId: String(r.board_id),
      name: String(r.name),
      path: String(r.path),
      description: (r.description as string | null) ?? null,
      verifyCommands: parseVerifyCommands(r.verify_commands),
      isDefault: Number(r.is_default) === 1,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at)
    };
  }

  listProjects(boardId: string): Project[] {
    const rows = this.db
      .prepare('SELECT * FROM projects WHERE board_id=? ORDER BY created_at ASC, id ASC')
      .all(boardId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToProject(r));
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToProject(row) : null;
  }

  getProjectByName(boardId: string, name: string): Project | null {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE board_id=? AND name=?')
      .get(boardId, name) as Record<string, unknown> | undefined;
    return row ? this.rowToProject(row) : null;
  }

  /** Find a registered project by its on-disk path (normalized), for the verify gate. */
  getProjectByPath(boardId: string, path: string): Project | null {
    const target = resolve(path);
    for (const p of this.listProjects(boardId)) {
      if (resolve(p.path) === target) return p;
    }
    return null;
  }

  setProjectVerifyCommands(projectId: string, commands: VerifyCommand[]): void {
    const json = JSON.stringify(VERIFY_COMMANDS_SCHEMA.parse(commands));
    this.db
      .prepare('UPDATE projects SET verify_commands=?, updated_at=? WHERE id=?')
      .run(json, this.now(), projectId);
  }

  addProject(input: {
    boardId: string;
    name: string;
    path: string;
    description?: string | null;
  }): Project {
    const id = randomUUID().slice(0, 8);
    const ts = this.now();
    return this.db.transaction(() => {
      const isFirst = this.listProjects(input.boardId).length === 0;
      this.db
        .prepare(
          `INSERT INTO projects (id, board_id, name, path, description, is_default, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.boardId,
          input.name,
          input.path,
          input.description ?? null,
          isFirst ? 1 : 0,
          ts,
          ts
        );
      const p = this.getProject(id);
      if (!p) throw new Error('addProject: failed to read back project');
      return p;
    })();
  }

  /** Remove a project; if it was the default, the oldest remaining project is promoted. */
  removeProject(id: string): void {
    this.db.transaction(() => {
      const p = this.getProject(id);
      if (!p) return;
      this.db.prepare('DELETE FROM projects WHERE id=?').run(id);
      if (p.isDefault) {
        const next = this.listProjects(p.boardId)[0];
        if (next) {
          this.db
            .prepare('UPDATE projects SET is_default=1, updated_at=? WHERE id=?')
            .run(this.now(), next.id);
        }
      }
    })();
  }

  setDefaultProject(id: string): void {
    this.db.transaction(() => {
      const p = this.getProject(id);
      if (!p) return;
      this.db.prepare('UPDATE projects SET is_default=0 WHERE board_id=?').run(p.boardId);
      this.db
        .prepare('UPDATE projects SET is_default=1, updated_at=? WHERE id=?')
        .run(this.now(), id);
    })();
  }

  private uniqueBoardSlug(base: string): string {
    const exists = (s: string): boolean =>
      this.db.prepare('SELECT 1 FROM boards WHERE slug=?').get(s) !== undefined;
    if (!exists(base)) return base;
    for (let n = 2; ; n += 1) {
      const candidate = `${base}-${n}`;
      if (!exists(candidate)) return candidate;
    }
  }

  createBoard(name: string): Board {
    const slug = this.uniqueBoardSlug(deriveBoardSlug(name));
    const ts = this.now();
    this.db
      .prepare('INSERT INTO boards (slug, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(slug, name, ts, ts);
    this.onBoardsChanged?.();
    return { slug, name, createdAt: ts, updatedAt: ts };
  }

  renameBoard(slug: string, name: string): void {
    this.db
      .prepare('UPDATE boards SET name=?, updated_at=? WHERE slug=?')
      .run(name, this.now(), slug);
    this.onBoardsChanged?.();
  }

  deleteBoard(slug: string): void {
    // Gather the board's tasks first so on-disk cleanup can run before the rows go.
    const tasks = this.listTasks().filter((t) => t.boardId === slug);
    for (const t of tasks) {
      try {
        if (t.workspaceKind === 'worktree' && t.workspacePath && t.repoPath) {
          removeWorktree({
            repoPath: t.repoPath,
            workspacePath: t.workspacePath,
            branchName: t.branchName,
            baseBranch: t.baseBranch
          });
        } else if (t.workspacePath) {
          cleanupWorkspace({ kind: t.workspaceKind, path: t.workspacePath });
        }
        rmSync(join(this.attachmentsRoot, t.id), { recursive: true, force: true });
      } catch {
        // best-effort: a filesystem failure must never block the DB delete
      }
    }
    try {
      // Artifacts are stored per board, so one rm clears every task's snapshots.
      rmSync(join(this.artifactsRoot, slug), { recursive: true, force: true });
    } catch {
      // best-effort
    }
    const tx = this.db.transaction((s: string) => {
      this.db.prepare('DELETE FROM task_artifacts WHERE board_id=?').run(s);
      this.db
        .prepare(
          'DELETE FROM task_attachments WHERE task_id IN (SELECT id FROM tasks WHERE board_id=?)'
        )
        .run(s);
      this.db
        .prepare(
          'DELETE FROM task_comments WHERE task_id IN (SELECT id FROM tasks WHERE board_id=?)'
        )
        .run(s);
      this.db
        .prepare('DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE board_id=?)')
        .run(s);
      this.db
        .prepare('DELETE FROM task_runs WHERE task_id IN (SELECT id FROM tasks WHERE board_id=?)')
        .run(s);
      this.db
        .prepare(
          `DELETE FROM task_links
           WHERE parent_id IN (SELECT id FROM tasks WHERE board_id=?)
              OR child_id IN (SELECT id FROM tasks WHERE board_id=?)`
        )
        .run(s, s);
      this.db.prepare('DELETE FROM tasks WHERE board_id=?').run(s);
      this.db.prepare('DELETE FROM features WHERE board_id=?').run(s);
      this.db.prepare('DELETE FROM projects WHERE board_id=?').run(s);
      this.db.prepare('DELETE FROM boards WHERE slug=?').run(s);
    });
    tx(slug);
    this.onBoardsChanged?.();
  }

  // ---- Features (task grouping) ----

  private rowToFeature(r: Record<string, unknown>): Feature {
    return {
      id: String(r.id),
      boardId: String(r.board_id),
      name: String(r.name),
      status: r.status as FeatureStatus,
      repoPath: (r.repo_path as string | null) ?? null,
      baseBranch: (r.base_branch as string | null) ?? null,
      integrationBranch: (r.integration_branch as string | null) ?? null,
      mergeState: (r.merge_state as Feature['mergeState']) ?? null,
      prUrl: (r.pr_url as string | null) ?? null,
      prNumber: (r.pr_number as number | null) ?? null,
      prState: (r.pr_state as Feature['prState']) ?? null,
      checksState: (r.checks_state as ChecksState | null) ?? null,
      syncedAt: (r.pr_synced_at as number | null) ?? null,
      prSkipNotified: Number(r.pr_skip_notified ?? 0) === 1,
      qaVerdict: (r.qa_verdict as Feature['qaVerdict']) ?? null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at)
    };
  }

  createFeature(input: CreateFeatureInput): Feature {
    const id = randomUUID().slice(0, 8);
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO features (id, board_id, name, status, repo_path, base_branch, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`
      )
      .run(id, input.boardId, input.name, input.repoPath ?? null, input.baseBranch ?? null, ts, ts);
    const feature = this.getFeature(id);
    if (!feature) throw new Error('createFeature: failed to read back feature');
    return feature;
  }

  getFeature(id: string): Feature | null {
    const row = this.db.prepare('SELECT * FROM features WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToFeature(row) : null;
  }

  /**
   * Resolve a full_feature pipeline's gate/qa task ids from the root's pipeline_expanded
   * event, keyed by feature id. Returns null for non-pipeline features or fallback
   * expansions (which record `fallback` and no stage ids).
   */
  pipelineAnchorForFeature(
    featureId: string
  ): { gateId: string; qaId: string; featureId: string } | null {
    const row = this.db
      .prepare(
        "SELECT payload FROM task_events WHERE kind='pipeline_expanded' " +
          "AND json_extract(payload, '$.featureId')=@f " +
          "AND json_extract(payload, '$.fallback') IS NULL LIMIT 1"
      )
      .get({ f: featureId }) as { payload: string } | undefined;
    if (!row) return null;
    const p = JSON.parse(row.payload) as Record<string, unknown>;
    const gateId = p.gateId;
    const qaId = p.qaId;
    if (typeof gateId !== 'string' || typeof qaId !== 'string') return null;
    return { gateId, qaId, featureId };
  }

  listFeatures(filter: { boardId?: string; status?: FeatureStatus } = {}): Feature[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.boardId) {
      where.push('board_id=@boardId');
      params.boardId = filter.boardId;
    }
    if (filter.status) {
      where.push('status=@status');
      params.status = filter.status;
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM features ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC`
      )
      .all(params) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToFeature(r));
  }

  updateFeature(id: string, fields: UpdateFeatureInput): void {
    const current = this.getFeature(id);
    if (!current) return;
    const ts = this.now();
    this.db
      .prepare(
        `UPDATE features SET name=@name, status=@status, repo_path=@repo_path,
          base_branch=@base_branch, integration_branch=@integration_branch,
          merge_state=@merge_state, updated_at=@ts WHERE id=@id`
      )
      .run({
        id,
        name: fields.name ?? current.name,
        status: fields.status ?? current.status,
        repo_path: fields.repoPath !== undefined ? fields.repoPath : current.repoPath,
        base_branch: fields.baseBranch !== undefined ? fields.baseBranch : current.baseBranch,
        integration_branch:
          fields.integrationBranch !== undefined
            ? fields.integrationBranch
            : current.integrationBranch,
        merge_state: fields.mergeState !== undefined ? fields.mergeState : current.mergeState,
        ts
      });
  }

  /** Record the single feature→main PR on a feature (set when it ships or auto-drafts). */
  setFeaturePr(
    featureId: string,
    prUrl: string,
    prNumber: number | null,
    prState: PrState = 'open'
  ): void {
    this.db
      .prepare(`UPDATE features SET pr_url=?, pr_number=?, pr_state=?, updated_at=? WHERE id=?`)
      .run(prUrl, prNumber, prState, this.now(), featureId);
  }

  /** Flip a feature PR's state in place (e.g. draft -> open when marked ready). */
  setFeaturePrState(featureId: string, prState: PrState): void {
    this.db
      .prepare(`UPDATE features SET pr_state=?, updated_at=? WHERE id=?`)
      .run(prState, this.now(), featureId);
  }

  /** Active features with a PR number not polled since `cutoff` (oldest first), for the PrPoller. */
  featuresDuePrSync(cutoff: number, limit: number): Feature[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM features
         WHERE status='active' AND pr_number IS NOT NULL AND pr_state IN ('open','draft')
           AND (pr_synced_at IS NULL OR pr_synced_at <= @cutoff)
         ORDER BY pr_synced_at ASC
         LIMIT @limit`
      )
      .all({ cutoff, limit }) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToFeature(r));
  }

  /** Write polled feature-PR state and bump pr_synced_at so the next sweep skips it (no updated_at bump). */
  setFeaturePrStatus(
    featureId: string,
    fields: { prState: PrState | null; checksState: ChecksState | null }
  ): void {
    this.db
      .prepare(`UPDATE features SET pr_state=?, checks_state=?, pr_synced_at=? WHERE id=?`)
      .run(fields.prState, fields.checksState, this.now(), featureId);
  }

  /** Mark that the "PR skipped: no remote/gh" event has been posted for this feature (fire-once). */
  setFeaturePrSkipNotified(featureId: string): void {
    this.db
      .prepare(`UPDATE features SET pr_skip_notified=1, updated_at=? WHERE id=?`)
      .run(this.now(), featureId);
  }

  /** Soft close: flip status to archived; member tasks keep their feature_id. */
  archiveFeature(id: string): void {
    this.db
      .prepare("UPDATE features SET status='archived', updated_at=? WHERE id=?")
      .run(this.now(), id);
  }

  /** Hard delete: null member tasks' feature_id, then remove the feature row. */
  deleteFeature(id: string): void {
    const tx = this.db.transaction((featureId: string) => {
      this.db.prepare('UPDATE tasks SET feature_id=NULL WHERE feature_id=?').run(featureId);
      this.db.prepare('DELETE FROM features WHERE id=?').run(featureId);
    });
    tx(id);
  }

  assignTaskToFeature(taskId: string, featureId: string | null): void {
    this.db
      .prepare('UPDATE tasks SET feature_id=?, updated_at=? WHERE id=?')
      .run(featureId, this.now(), taskId);
  }

  listFeatureTasks(featureId: string): Task[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM tasks WHERE feature_id=? AND system_kind IS NULL ORDER BY priority DESC, created_at ASC'
      )
      .all(featureId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToTask(r));
  }

  /** A non-terminal (not done/archived) system task of the given kind for a feature, or null. */
  openSystemTask(featureId: string, kind: string): Task | null {
    const row = this.db
      .prepare(
        `SELECT * FROM tasks WHERE feature_id=? AND system_kind=?
           AND status NOT IN ('done','archived') ORDER BY created_at ASC LIMIT 1`
      )
      .get(featureId, kind) as Record<string, unknown> | undefined;
    return row ? this.rowToTask(row) : null;
  }

  /** Single-query status rollup for a feature (focus banner + Features dashboard). */
  featureRollup(featureId: string): FeatureRollup {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status IN ('triage','scheduled','todo','ready') THEN 1 ELSE 0 END) AS todo,
           SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN status IN ('blocked','review') THEN 1 ELSE 0 END) AS review,
           SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN status='archived' THEN 1 ELSE 0 END) AS archived
         FROM tasks WHERE feature_id=? AND system_kind IS NULL`
      )
      .get(featureId) as Record<string, number | null>;
    return {
      featureId,
      total: Number(row.total ?? 0),
      todo: Number(row.todo ?? 0),
      running: Number(row.running ?? 0),
      review: Number(row.review ?? 0),
      done: Number(row.done ?? 0),
      archived: Number(row.archived ?? 0)
    };
  }

  // ---- Feature suggestions (spec §4 auto-grouping) ----

  private rowToSuggestion(r: Record<string, unknown>): FeatureSuggestion {
    return {
      id: String(r.id),
      boardId: String(r.board_id),
      repoPath: (r.repo_path as string | null) ?? null,
      name: String(r.name),
      taskIds: JSON.parse(String(r.task_ids ?? '[]')) as string[],
      reason: (r.reason as string | null) ?? null,
      status: r.status as SuggestionStatus,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at)
    };
  }

  createSuggestion(input: CreateSuggestionInput): FeatureSuggestion {
    const id = randomUUID().slice(0, 8);
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO feature_suggestions (id, board_id, repo_path, name, task_ids, reason, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(
        id,
        input.boardId,
        input.repoPath ?? null,
        input.name,
        JSON.stringify(input.taskIds),
        input.reason ?? null,
        ts,
        ts
      );
    const s = this.getSuggestion(id);
    if (!s) throw new Error('createSuggestion: failed to read back suggestion');
    return s;
  }

  getSuggestion(id: string): FeatureSuggestion | null {
    const row = this.db.prepare('SELECT * FROM feature_suggestions WHERE id=?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToSuggestion(row) : null;
  }

  listSuggestions(
    boardId: string,
    filter: { status?: SuggestionStatus; repoPath?: string } = {}
  ): FeatureSuggestion[] {
    const where = ['board_id=@boardId'];
    const params: Record<string, unknown> = { boardId };
    if (filter.status) {
      where.push('status=@status');
      params.status = filter.status;
    }
    if (filter.repoPath) {
      where.push('repo_path=@repoPath');
      params.repoPath = filter.repoPath;
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM feature_suggestions WHERE ${where.join(' AND ')} ORDER BY created_at DESC`
      )
      .all(params) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToSuggestion(r));
  }

  updateSuggestionStatus(id: string, status: SuggestionStatus): void {
    this.db
      .prepare('UPDATE feature_suggestions SET status=?, updated_at=? WHERE id=?')
      .run(status, this.now(), id);
  }

  createProposal(input: {
    boardId: string;
    kind: PmProposalKind;
    targetId: string;
    rationale: string;
  }): PmProposal {
    const id = randomUUID().slice(0, 8);
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO pm_proposals (id, board_id, kind, target_id, rationale, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`
      )
      .run(id, input.boardId, input.kind, input.targetId, input.rationale, ts);
    const p = this.getProposal(id);
    if (!p) throw new Error('createProposal: failed to read back proposal');
    return p;
  }

  getProposal(id: string): PmProposal | null {
    const row = this.db.prepare('SELECT * FROM pm_proposals WHERE id=?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToProposal(row) : null;
  }

  listProposals(boardId: string, filter: { status?: PmProposalStatus } = {}): PmProposal[] {
    const where = ['board_id=@boardId'];
    const params: Record<string, unknown> = { boardId };
    if (filter.status) {
      where.push('status=@status');
      params.status = filter.status;
    }
    const rows = this.db
      .prepare(`SELECT * FROM pm_proposals WHERE ${where.join(' AND ')} ORDER BY created_at DESC`)
      .all(params) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToProposal(r));
  }

  resolveProposal(
    id: string,
    status: 'accepted' | 'dismissed' | 'failed',
    error: string | null
  ): void {
    this.db
      .prepare('UPDATE pm_proposals SET status=?, error=?, resolved_at=? WHERE id=?')
      .run(status, error, this.now(), id);
  }

  private rowToProposal(r: Record<string, unknown>): PmProposal {
    return {
      id: String(r.id),
      boardId: String(r.board_id),
      kind: r.kind as PmProposalKind,
      targetId: String(r.target_id),
      rationale: String(r.rationale ?? ''),
      status: r.status as PmProposalStatus,
      error: (r.error as string | null) ?? null,
      createdAt: Number(r.created_at),
      resolvedAt: (r.resolved_at as number | null) ?? null
    };
  }

  updateTask(id: string, fields: UpdateTaskFields): void {
    const current = this.getTask(id);
    if (!current) return;
    const ts = this.now();
    this.db
      .prepare(
        `UPDATE tasks SET title=@title, body=@body, assignee=@assignee,
          priority=@priority, tenant=@tenant, docs=@docs, updated_at=@ts WHERE id=@id`
      )
      .run({
        id,
        title: fields.title ?? current.title,
        body: fields.body ?? current.body,
        assignee: fields.assignee !== undefined ? fields.assignee : current.assignee,
        priority: fields.priority ?? current.priority,
        tenant: fields.tenant !== undefined ? fields.tenant : current.tenant,
        docs: fields.docs !== undefined ? JSON.stringify(fields.docs) : JSON.stringify(current.docs),
        ts
      });
  }

  setStatus(taskId: string, status: TaskStatus): void {
    this.db
      .prepare('UPDATE tasks SET status=?, updated_at=? WHERE id=?')
      .run(status, this.now(), taskId);
  }

  /** Attach a task to a feature (pipeline expander backfills the root's feature). */
  setFeatureId(taskId: string, featureId: string): void {
    this.db
      .prepare('UPDATE tasks SET feature_id=?, updated_at=? WHERE id=?')
      .run(featureId, this.now(), taskId);
  }

  setWorkerPid(taskId: string, runId: number, pid: number): void {
    const ts = this.now();
    this.db.prepare('UPDATE tasks SET worker_pid=?, updated_at=? WHERE id=?').run(pid, ts, taskId);
    this.db.prepare('UPDATE task_runs SET worker_pid=? WHERE id=?').run(pid, runId);
  }

  setWorkspace(
    taskId: string,
    path: string,
    branchName: string | null,
    baseBranch: string | null = null
  ): void {
    this.db
      .prepare(
        'UPDATE tasks SET workspace_path=?, branch_name=?, base_branch=?, updated_at=? WHERE id=?'
      )
      .run(path, branchName, baseBranch, this.now(), taskId);
  }

  setPendingMode(taskId: string, mode: PendingMode | null): void {
    this.db
      .prepare('UPDATE tasks SET pending_mode=?, updated_at=? WHERE id=?')
      .run(mode, this.now(), taskId);
  }

  /** Triage tasks flagged for an orchestrator run, highest priority first. */
  pendingDecomposeTasks(): Task[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM tasks WHERE status='triage' AND pending_mode IS NOT NULL ORDER BY priority DESC, created_at ASC"
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToTask(r));
  }

  /** Atomic CAS claim of a flagged triage task; clears pending_mode in the same write. */
  claimForDecompose(taskId: string, lock: string, ttlMs: number): boolean {
    const ts = this.now();
    const res = this.db
      .prepare(
        `UPDATE tasks
         SET status='running', claim_lock=@lock, claim_expires=@expires,
             last_heartbeat_at=@ts, pending_mode=NULL, updated_at=@ts
         WHERE id=@id AND status='triage' AND pending_mode IS NOT NULL
           AND (claim_lock IS NULL OR claim_expires <= @ts)`
      )
      .run({ id: taskId, lock, expires: ts + ttlMs, ts });
    return res.changes === 1;
  }

  /** Atomic CAS claim of an unassigned ready task for an assign run; moves ready→running. */
  claimForAssign(taskId: string, lock: string, ttlMs: number): boolean {
    const ts = this.now();
    const res = this.db
      .prepare(
        `UPDATE tasks
         SET status='running', claim_lock=@lock, claim_expires=@expires,
             last_heartbeat_at=@ts, updated_at=@ts
         WHERE id=@id AND status='ready' AND assignee IS NULL
           AND (claim_lock IS NULL OR claim_expires <= @ts)`
      )
      .run({ id: taskId, lock, expires: ts + ttlMs, ts });
    return res.changes === 1;
  }

  /** Atomically claim a review task for a resolve run (review -> running). Returns false if it lost the race. */
  claimForResolve(taskId: string, lock: string, ttlMs: number): boolean {
    const ts = this.now();
    const res = this.db
      .prepare(
        `UPDATE tasks SET status='running', claim_lock=@lock, claim_expires=@expires,
           last_heartbeat_at=@ts, updated_at=@ts
         WHERE id=@id AND status='review'
           AND (claim_lock IS NULL OR claim_expires <= @ts)`
      )
      .run({ id: taskId, lock, expires: ts + ttlMs, ts });
    return res.changes === 1;
  }

  /** Re-claim a running task (whose verify run just ended) with a fresh lock for a verify-fix run. */
  claimForVerifyFix(taskId: string, lock: string, ttlMs: number): boolean {
    const ts = this.now();
    const res = this.db
      .prepare(
        `UPDATE tasks SET claim_lock=@lock, claim_expires=@expires, last_heartbeat_at=@ts, updated_at=@ts
         WHERE id=@id AND status='running'`
      )
      .run({ id: taskId, lock, expires: ts + ttlMs, ts });
    return res.changes === 1;
  }

  /** CAS-claim a review-status worktree task for an agent review run; flips it to running. */
  claimForReview(taskId: string, lock: string, ttlMs: number): boolean {
    const ts = this.now();
    const res = this.db
      .prepare(
        `UPDATE tasks SET status='running', claim_lock=@lock, claim_expires=@expires,
           last_heartbeat_at=@ts, updated_at=@ts
         WHERE id=@id AND status='review'
           AND (claim_lock IS NULL OR claim_expires <= @ts)`
      )
      .run({ id: taskId, lock, expires: ts + ttlMs, ts });
    return res.changes === 1;
  }

  /** Record the agent review verdict; capture the approved HEAD sha on approve. */
  setReviewVerdict(taskId: string, decision: ReviewVerdict, headSha?: string | null): void {
    this.db
      .prepare(
        'UPDATE tasks SET review_verdict=@v, review_head_sha=@sha, updated_at=@ts WHERE id=@id'
      )
      .run({ id: taskId, v: decision, sha: headSha ?? null, ts: this.now() });
  }

  /** Record the feature-level QA verdict (pipeline §8). null clears it. */
  setQaVerdict(featureId: string, verdict: 'pass' | 'request_changes' | null): void {
    this.db
      .prepare('UPDATE features SET qa_verdict=@v, updated_at=@ts WHERE id=@id')
      .run({ id: featureId, v: verdict, ts: this.now() });
  }

  incrementReviewAttempts(taskId: string): void {
    this.db
      .prepare('UPDATE tasks SET review_attempts = review_attempts + 1, updated_at=? WHERE id=?')
      .run(this.now(), taskId);
  }

  resetReviewAttempts(taskId: string): void {
    this.db
      .prepare('UPDATE tasks SET review_attempts = 0, updated_at=? WHERE id=?')
      .run(this.now(), taskId);
  }

  /** Null the verdict + approved sha (a fresh diff invalidates a prior verdict). Leaves attempts untouched. */
  clearReviewVerdict(taskId: string): void {
    this.db
      .prepare(
        'UPDATE tasks SET review_verdict=NULL, review_head_sha=NULL, updated_at=? WHERE id=?'
      )
      .run(this.now(), taskId);
  }

  /** Spec-stage tasks that have completed (status done), for approval-proposal raising. */
  doneSpecTasks(): Task[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM tasks WHERE pipeline_stage='spec' AND status='done' ORDER BY priority DESC, created_at ASC"
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToTask(r));
  }

  /** Review-status worktree tasks awaiting an agent verdict (candidates for reviewTasks()). */
  reviewPendingTasks(): Task[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status='review' AND workspace_kind='worktree' AND workspace_path IS NOT NULL
           AND review_verdict IS NULL AND system_kind IS NULL
         ORDER BY priority DESC, created_at ASC`
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToTask(r));
  }

  /** True when the task is part of a swarm graph (linked up to a swarm root). */
  isSwarmMember(taskId: string): boolean {
    const seen = new Set<string>();
    let frontier = [taskId];
    while (frontier.length) {
      const next: string[] = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (isSwarmRoot(this, id)) return true;
        for (const p of this.parentsOf(id)) next.push(p);
      }
      frontier = next;
    }
    return false;
  }

  /** Flag up to `limit` un-flagged triage tasks for decompose; returns how many were flagged. */
  armTriageForDecompose(limit: number): number {
    if (limit <= 0) return 0;
    const ids = (
      this.db
        .prepare(
          "SELECT id FROM tasks WHERE status='triage' AND pending_mode IS NULL ORDER BY priority DESC, created_at ASC LIMIT ?"
        )
        .all(limit) as Array<{ id: string }>
    ).map((r) => r.id);
    for (const id of ids) this.setPendingMode(id, 'decompose');
    return ids.length;
  }

  /** Running tasks whose current run is an orchestrator run (mode != 'work'). */
  orchestratorRunningCount(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM tasks t
         JOIN task_runs r ON r.id = t.current_run_id
         WHERE t.status='running' AND r.mode NOT IN ('work','verify','review')`
      )
      .get() as { c: number };
    return Number(row.c);
  }

  runMode(runId: number): RunMode | null {
    const row = this.db.prepare('SELECT mode FROM task_runs WHERE id=?').get(runId) as
      | { mode: string }
      | undefined;
    return row ? (row.mode as RunMode) : null;
  }

  /** Set status and clear all claim/run fields (used by reclaim→triage and specify→todo). */
  setStatusCleared(taskId: string, status: TaskStatus): void {
    const ts = this.now();
    this.db
      .prepare(
        `UPDATE tasks SET status=@status, claim_lock=NULL, claim_expires=NULL,
          worker_pid=NULL, current_run_id=NULL, last_heartbeat_at=NULL, updated_at=@ts WHERE id=@id`
      )
      .run({ id: taskId, status, ts });
  }

  /** Reset the failure counters so a resumed task starts with a clean slate. */
  clearFailures(taskId: string): void {
    this.db
      .prepare(
        'UPDATE tasks SET consecutive_failures=0, last_failure_error=NULL, updated_at=? WHERE id=?'
      )
      .run(this.now(), taskId);
  }

  incrementResolveAttempts(taskId: string): void {
    this.db
      .prepare('UPDATE tasks SET resolve_attempts = resolve_attempts + 1, updated_at=? WHERE id=?')
      .run(this.now(), taskId);
  }

  incrementVerifyAttempts(taskId: string): void {
    this.db
      .prepare('UPDATE tasks SET verify_attempts = verify_attempts + 1, updated_at=? WHERE id=?')
      .run(this.now(), taskId);
  }

  resetResolveAttempts(taskId: string): void {
    this.db
      .prepare('UPDATE tasks SET resolve_attempts = 0, updated_at=? WHERE id=?')
      .run(this.now(), taskId);
  }

  resetVerifyAttempts(taskId: string): void {
    this.db
      .prepare('UPDATE tasks SET verify_attempts = 0, updated_at=? WHERE id=?')
      .run(this.now(), taskId);
  }

  /** Attach (or replace) a schedule on a task; moves it to the scheduled lane. */
  setSchedule(taskId: string, input: ScheduleInput): void {
    const v = validateSchedule(input);
    if (!v.ok) throw new Error(v.error);
    const ts = this.now();
    const nextRunAt = input.kind === 'once' ? input.at : computeNextRun(input, ts);
    this.db
      .prepare(
        `UPDATE tasks SET status='scheduled', schedule_kind=@kind, schedule_cron=@cron,
          schedule_interval_ms=@everyMs, next_run_at=@nextRunAt, schedule_paused=0, updated_at=@ts
         WHERE id=@id`
      )
      .run({
        id: taskId,
        kind: input.kind,
        cron: input.kind === 'cron' ? input.expr : null,
        everyMs: input.kind === 'interval' ? input.everyMs : null,
        nextRunAt,
        ts
      });
  }

  /** Remove a schedule; returns the task to the todo lane. */
  clearSchedule(taskId: string): void {
    const ts = this.now();
    this.db
      .prepare(
        `UPDATE tasks SET status='todo', schedule_kind=NULL, schedule_cron=NULL,
          schedule_interval_ms=NULL, next_run_at=NULL, schedule_paused=0, updated_at=@ts
         WHERE id=@id`
      )
      .run({ id: taskId, ts });
  }

  /** Null all schedule columns WITHOUT changing status (used when a scheduled task is moved out of the lane). */
  dropSchedule(taskId: string): void {
    const ts = this.now();
    this.db
      .prepare(
        `UPDATE tasks SET schedule_kind=NULL, schedule_cron=NULL, schedule_interval_ms=NULL,
          next_run_at=NULL, schedule_paused=0, updated_at=@ts
         WHERE id=@id`
      )
      .run({ id: taskId, ts });
  }

  pauseSchedule(taskId: string): void {
    this.db
      .prepare('UPDATE tasks SET schedule_paused=1, updated_at=? WHERE id=?')
      .run(this.now(), taskId);
  }

  resumeSchedule(taskId: string): void {
    this.db
      .prepare('UPDATE tasks SET schedule_paused=0, updated_at=? WHERE id=?')
      .run(this.now(), taskId);
  }

  /** Scheduled, unpaused tasks whose next fire is due at/before `now`. */
  dueSchedules(now: number): Task[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status='scheduled' AND schedule_paused=0
           AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC`
      )
      .all(now) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToTask(r));
  }

  advanceNextRun(taskId: string, nextRunAt: number): void {
    this.db
      .prepare('UPDATE tasks SET next_run_at=?, updated_at=? WHERE id=?')
      .run(nextRunAt, this.now(), taskId);
  }

  /** One-shot fire: move scheduled -> ready in place and drop the schedule. */
  fireOnce(taskId: string): void {
    const ts = this.now();
    this.db
      .prepare(
        `UPDATE tasks SET status='ready', schedule_kind=NULL, schedule_cron=NULL,
          schedule_interval_ms=NULL, next_run_at=NULL, schedule_paused=0, updated_at=@ts
         WHERE id=@id`
      )
      .run({ id: taskId, ts });
  }

  /** Recurring fire: create a fresh todo instance copying the template's work fields. */
  spawnScheduledInstance(template: Task): Task {
    // Note: idempotencyKey is intentionally not inherited — each fired instance is a
    // distinct task with its own identity; reusing the template's key would collide.
    return this.createTask({
      title: template.title,
      body: template.body,
      assignee: template.assignee,
      priority: template.priority,
      tenant: template.tenant,
      workspaceKind: template.workspaceKind,
      repoPath: template.repoPath ?? undefined,
      branchName: template.branchName,
      modelOverride: template.modelOverride,
      skills: template.skills,
      docs: template.docs,
      boardId: template.boardId,
      maxRuntimeSeconds: template.maxRuntimeSeconds,
      maxRetries: template.maxRetries,
      status: 'todo',
      scheduledFrom: template.id
    });
  }

  /** Ungrouped worktree tasks in todo/ready that belong to a repo — candidates for a grouping suggestion (spec §4). */
  ungroupedWorktreeReadyTodoTasks(): Task[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status IN ('todo','ready') AND feature_id IS NULL
           AND workspace_kind='worktree' AND repo_path IS NOT NULL AND system_kind IS NULL
         ORDER BY priority DESC, created_at ASC`
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToTask(r));
  }

  /** True when a non-terminal suggest system task already exists for this board+repo (debounce guard). */
  hasOpenSuggestTask(boardId: string, repoPath: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM tasks WHERE board_id=? AND repo_path=? AND system_kind='suggest'
           AND status NOT IN ('done','archived') LIMIT 1`
      )
      .get(boardId, repoPath);
    return row != null;
  }

  /** Atomic CAS claim of a suggest system task (review -> running). */
  claimForSuggest(taskId: string, lock: string, ttlMs: number): boolean {
    const ts = this.now();
    const res = this.db
      .prepare(
        `UPDATE tasks SET status='running', claim_lock=@lock, claim_expires=@expires,
           last_heartbeat_at=@ts, updated_at=@ts
         WHERE id=@id AND status='review'
           AND (claim_lock IS NULL OR claim_expires <= @ts)`
      )
      .run({ id: taskId, lock, expires: ts + ttlMs, ts });
    return res.changes === 1;
  }

  /** Test-only raw handle for simulating corruption; do not use in production code. */
  rawDbForTest(): Database.Database {
    return this.db;
  }

  /** Hard-delete a task row and its links (used to drop a transient suggest system task on terminal). */
  deleteTask(id: string): void {
    const tx = this.db.transaction((taskId: string) => {
      this.db.prepare('DELETE FROM task_links WHERE parent_id=? OR child_id=?').run(taskId, taskId);
      this.db.prepare('DELETE FROM tasks WHERE id=?').run(taskId);
    });
    tx(id);
  }
}
