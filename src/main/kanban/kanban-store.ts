import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import { createLogger } from '../logger';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema';
import type { Task, TaskStatus, CreateTaskInput } from '../../shared/kanban-types';

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
}
