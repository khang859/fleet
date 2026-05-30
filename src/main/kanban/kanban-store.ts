import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import { createLogger } from '../logger';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema';
import type { Task, TaskStatus, CreateTaskInput, TaskRun, TaskEvent, TaskComment, RunOutcome, UpdateTaskFields } from '../../shared/kanban-types';

const log = createLogger('kanban-store');

export interface KanbanStoreOptions {
  now?: () => number;
}

export class KanbanStore {
  protected db: Database.Database;
  protected now: () => number;

  constructor(dbPath: string, opts: KanbanStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    log.info('kanban store opened', { dbPath });
  }

  private migrate(): void {
    this.db.exec(SCHEMA_SQL);
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
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
      branchName: (r.branch_name as string | null) ?? null,
      modelOverride: (r.model_override as string | null) ?? null,
      skills: JSON.parse(String(r.skills ?? '[]')) as string[],
      idempotencyKey: (r.idempotency_key as string | null) ?? null,
      result: (r.result as string | null) ?? null,
      claimLock: (r.claim_lock as string | null) ?? null,
      claimExpires: (r.claim_expires as number | null) ?? null,
      workerPid: (r.worker_pid as number | null) ?? null,
      currentRunId: (r.current_run_id as number | null) ?? null,
      lastHeartbeatAt: (r.last_heartbeat_at as number | null) ?? null,
      consecutiveFailures: Number(r.consecutive_failures),
      lastFailureError: (r.last_failure_error as string | null) ?? null,
      maxRuntimeSeconds: (r.max_runtime_seconds as number | null) ?? null,
      maxRetries: Number(r.max_retries),
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
          workspace_kind, branch_name, model_override, skills, idempotency_key,
          max_runtime_seconds, max_retries, created_at, updated_at)
         VALUES (@id, @title, @body, @assignee, @status, @priority, @tenant,
          @workspace_kind, @branch_name, @model_override, @skills, @idempotency_key,
          @max_runtime_seconds, @max_retries, @created_at, @updated_at)`
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
        branch_name: input.branchName ?? null,
        model_override: input.modelOverride ?? null,
        skills: JSON.stringify(input.skills ?? []),
        idempotency_key: input.idempotencyKey ?? null,
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
          .all(filter.status) as Record<string, unknown>[])
      : (this.db
          .prepare('SELECT * FROM tasks ORDER BY priority DESC, created_at ASC')
          .all() as Record<string, unknown>[]);
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
      this.db.prepare('SELECT parent_id FROM task_links WHERE child_id = ?').all(childId) as {
        parent_id: string;
      }[]
    ).map((r) => r.parent_id);
  }

  childrenOf(parentId: string): string[] {
    return (
      this.db.prepare('SELECT child_id FROM task_links WHERE parent_id = ?').all(parentId) as {
        child_id: string;
      }[]
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

  /** Todo tasks whose parents (if any) are all 'done'. */
  promotableTodoTasks(): Task[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM tasks t
       WHERE t.status = 'todo'
       AND NOT EXISTS (
         SELECT 1 FROM task_links l
         JOIN tasks p ON p.id = l.parent_id
         WHERE l.child_id = t.id AND p.status != 'done'
       )`
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToTask(r));
  }

  private rowToRun(r: Record<string, unknown>): TaskRun {
    return {
      id: Number(r.id),
      taskId: String(r.task_id),
      profile: (r.profile as string | null) ?? null,
      status: r.status as TaskRun['status'],
      workerPid: (r.worker_pid as number | null) ?? null,
      startedAt: Number(r.started_at),
      endedAt: (r.ended_at as number | null) ?? null,
      outcome: (r.outcome as RunOutcome | null) ?? null,
      summary: (r.summary as string | null) ?? null,
      metadata: r.metadata ? (JSON.parse(String(r.metadata)) as Record<string, unknown>) : null,
      error: (r.error as string | null) ?? null
    };
  }

  startRun(taskId: string, profile: string | null, workerPid: number | null): TaskRun {
    const ts = this.now();
    const info = this.db
      .prepare(
        `INSERT INTO task_runs (task_id, profile, status, worker_pid, started_at)
         VALUES (?, ?, 'running', ?, ?)`
      )
      .run(taskId, profile, workerPid, ts);
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
    const rows = this.db
      .prepare('SELECT * FROM task_runs WHERE task_id=? ORDER BY started_at DESC')
      .all(taskId) as Record<string, unknown>[];
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
    return {
      id: Number(info.lastInsertRowid),
      taskId,
      runId,
      kind,
      payload: payload ?? null,
      createdAt: ts
    };
  }

  listEvents(taskId: string): TaskEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM task_events WHERE task_id=? ORDER BY id ASC')
      .all(taskId) as Record<string, unknown>[];
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
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      taskId: String(r.task_id),
      author: String(r.author),
      body: String(r.body),
      createdAt: Number(r.created_at)
    }));
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
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE status='running'")
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToTask(r));
  }

  readyTasks(): Task[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM tasks WHERE status='ready' AND assignee IS NOT NULL ORDER BY priority DESC, created_at ASC"
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToTask(r));
  }

  updateTask(id: string, fields: UpdateTaskFields): void {
    const current = this.getTask(id);
    if (!current) return;
    const ts = this.now();
    this.db
      .prepare(
        `UPDATE tasks SET title=@title, body=@body, assignee=@assignee,
          priority=@priority, tenant=@tenant, updated_at=@ts WHERE id=@id`
      )
      .run({
        id,
        title: fields.title ?? current.title,
        body: fields.body ?? current.body,
        assignee: fields.assignee !== undefined ? fields.assignee : current.assignee,
        priority: fields.priority ?? current.priority,
        tenant: fields.tenant !== undefined ? fields.tenant : current.tenant,
        ts
      });
  }

  setStatus(taskId: string, status: TaskStatus): void {
    this.db
      .prepare('UPDATE tasks SET status=?, updated_at=? WHERE id=?')
      .run(status, this.now(), taskId);
  }

  setWorkerPid(taskId: string, runId: number, pid: number): void {
    const ts = this.now();
    this.db
      .prepare('UPDATE tasks SET worker_pid=?, updated_at=? WHERE id=?')
      .run(pid, ts, taskId);
    this.db.prepare('UPDATE task_runs SET worker_pid=? WHERE id=?').run(pid, runId);
  }
}
