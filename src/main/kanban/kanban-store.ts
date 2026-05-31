import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { createLogger } from '../logger';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema';
import type { Task, TaskStatus, CreateTaskInput, TaskRun, TaskEvent, TaskComment, TaskAttachment, RunOutcome, UpdateTaskFields, BoardCard, Board, RunMode, PendingMode } from '../../shared/kanban-types';
import { prepareAttachmentFile, removeAttachmentFile } from './attachments';
import { deriveBoardSlug } from './board-slug';
import { removeWorktree, cleanupWorkspace } from './workspace';

const log = createLogger('kanban-store');

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

  constructor(dbPath: string, opts: KanbanStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.onEvent = opts.onEvent;
    this.onBoardsChanged = opts.onBoardsChanged;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.attachmentsRoot = join(dirname(dbPath), 'attachments');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    log.info('kanban store opened', { dbPath });
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
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
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
      modelOverride: (r.model_override as string | null) ?? null,
      skills: JSON.parse(String(r.skills ?? '[]')) as string[],
      boardId: String(r.board_id ?? 'default'),
      idempotencyKey: (r.idempotency_key as string | null) ?? null,
      result: (r.result as string | null) ?? null,
      pendingMode: (r.pending_mode as Task['pendingMode']) ?? null,
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
          workspace_kind, workspace_path, repo_path, branch_name, model_override, skills, board_id, idempotency_key,
          max_runtime_seconds, max_retries, created_at, updated_at)
         VALUES (@id, @title, @body, @assignee, @status, @priority, @tenant,
          @workspace_kind, @workspace_path, @repo_path, @branch_name, @model_override, @skills, @board_id, @idempotency_key,
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
        workspace_path: null,
        repo_path: input.repoPath ?? null,
        branch_name: input.branchName ?? null,
        model_override: input.modelOverride ?? null,
        skills: JSON.stringify(input.skills ?? []),
        board_id: input.boardId ?? 'default',
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
      .all(taskId) as Record<string, unknown>[];
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

  listBoard(boardSlug?: string): BoardCard[] {
    const tasks = boardSlug
      ? this.listTasks().filter((t) => t.boardId === boardSlug)
      : this.listTasks();
    const commentRows = this.db
      .prepare('SELECT task_id, COUNT(*) AS c FROM task_comments GROUP BY task_id')
      .all() as { task_id: string; c: number }[];
    const commentCounts = new Map(commentRows.map((r) => [r.task_id, Number(r.c)]));
    const childRows = this.db
      .prepare(
        `SELECT l.parent_id AS parent, COUNT(*) AS total,
          SUM(CASE WHEN c.status='done' THEN 1 ELSE 0 END) AS done
         FROM task_links l JOIN tasks c ON c.id = l.child_id
         GROUP BY l.parent_id`
      )
      .all() as { parent: string; total: number; done: number }[];
    const childMap = new Map(
      childRows.map((r) => [r.parent, { total: Number(r.total), done: Number(r.done) }])
    );
    return tasks.map((t) => ({
      ...t,
      commentCount: commentCounts.get(t.id) ?? 0,
      childTotal: childMap.get(t.id)?.total ?? 0,
      childDone: childMap.get(t.id)?.done ?? 0
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
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToBoard(r));
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
            branchName: t.branchName
          });
        } else if (t.workspacePath) {
          cleanupWorkspace({ kind: t.workspaceKind, path: t.workspacePath });
        }
        rmSync(join(this.attachmentsRoot, t.id), { recursive: true, force: true });
      } catch {
        // best-effort: a filesystem failure must never block the DB delete
      }
    }
    const tx = this.db.transaction((s: string) => {
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
      this.db.prepare('DELETE FROM boards WHERE slug=?').run(s);
    });
    tx(slug);
    this.onBoardsChanged?.();
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

  setWorkspace(taskId: string, path: string, branchName: string | null): void {
    this.db
      .prepare('UPDATE tasks SET workspace_path=?, branch_name=?, updated_at=? WHERE id=?')
      .run(path, branchName, this.now(), taskId);
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
      .all() as Record<string, unknown>[];
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

  /** Flag up to `limit` un-flagged triage tasks for decompose; returns how many were flagged. */
  armTriageForDecompose(limit: number): number {
    if (limit <= 0) return 0;
    const ids = (
      this.db
        .prepare(
          "SELECT id FROM tasks WHERE status='triage' AND pending_mode IS NULL ORDER BY priority DESC, created_at ASC LIMIT ?"
        )
        .all(limit) as { id: string }[]
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
         WHERE t.status='running' AND r.mode != 'work'`
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
}
