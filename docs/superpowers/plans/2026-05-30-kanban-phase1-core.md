# Kanban Phase 1 — Core (Store + Dispatcher + MCP Server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the headless core of Fleet's Kanban board — a SQLite-backed task store, a dispatcher loop that claims/promotes/reclaims tasks and spawns workers, and an HTTP MCP server exposing the kanban worker toolset — all verifiable without the renderer or a live Rune.

**Architecture:** Three main-process modules under `src/main/kanban/`. `KanbanStore` owns all SQLite I/O (schema, CRUD, atomic CAS claims, runs, events, comments, links). `KanbanDispatcher` is a tick loop that calls the store and spawns workers through an injectable `spawnWorker` function (so tests use a stub, not a real process). `KanbanMcpServer` is a minimal JSON-RPC 2.0 HTTP server that maps a per-run token to a task and calls the store. Everything is constructor-injected (db path, clock, spawn fn) so unit tests run against a tmp dir with a fake clock.

**Tech Stack:** TypeScript, `better-sqlite3@^12.8.0` (already a dependency; native rebuild handled by `postinstall`), Node `http`, `zod` (already a dependency) for MCP argument validation, `vitest` (node environment, tests in `src/main/__tests__/`).

**Scope note:** This is Phase 1 of the spec at `docs/superpowers/specs/2026-05-30-kanban-board-design.md`. It deliberately excludes the renderer board tab (Phase 2), profiles/settings (Phase 3), CLI (Phase 4), and multiple boards / worktrees / attachments / orchestrator (Phase 5). Workspaces here are `scratch` only. Worker spawn is wired to a real `rune --prompt` invocation but the orchestrator role and `--profile` are stubbed/deferred. Live end-to-end with real Rune is gated on rune#10 and rune#11; until then, verify with the stub spawn.

---

## File Structure

- `src/shared/kanban-types.ts` — shared TS types (Task, Status, Run, Event, Comment, enums). Imported by main and (later) renderer.
- `src/main/kanban/schema.ts` — the SQL `CREATE TABLE` statements as a single migration string + `SCHEMA_VERSION`.
- `src/main/kanban/kanban-store.ts` — `KanbanStore` class: all DB reads/writes.
- `src/main/kanban/workspace.ts` — `prepareWorkspace` / `cleanupWorkspace` (scratch only this phase).
- `src/main/kanban/kanban-dispatcher.ts` — `KanbanDispatcher` class: reclaim/promote/claimAndSpawn, tick loop.
- `src/main/kanban/kanban-mcp-server.ts` — `KanbanMcpServer` class: JSON-RPC HTTP server + tool handlers.
- `src/main/kanban/spawn-worker.ts` — `spawnRuneWorker` (the real spawn fn injected into the dispatcher in production).
- Tests: `src/main/__tests__/kanban-store.test.ts`, `kanban-dispatcher.test.ts`, `kanban-mcp-server.test.ts`, `kanban-workspace.test.ts`.

**Conventions to follow (verified in this codebase):**
- Services are classes; use `import { createLogger } from '../logger'` and `const log = createLogger('kanban-store')`.
- Constructor-inject the base path so tests pass a tmp dir (see `AnnotationStore`).
- Timestamps are epoch-ms integers (`number`). Inject `now: () => number` (default `Date.now`) for deterministic tests.
- Tests: `import { describe, it, expect, beforeEach, afterEach } from 'vitest'`, tmp dir under `tmpdir()`, clean up in `afterEach`.
- Run a single test file: `npx vitest run src/main/__tests__/<file>.test.ts`.
- Run typecheck after structural changes: `npm run typecheck:node`.

---

## Task 1: Shared types + store schema + open/migrate

**Files:**
- Create: `src/shared/kanban-types.ts`
- Create: `src/main/kanban/schema.ts`
- Create: `src/main/kanban/kanban-store.ts`
- Test: `src/main/__tests__/kanban-store.test.ts`

- [ ] **Step 1: Write the shared types**

Create `src/shared/kanban-types.ts`:

```ts
export type TaskStatus =
  | 'triage'
  | 'todo'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'done'
  | 'archived';

export type WorkspaceKind = 'scratch' | 'dir' | 'worktree';

export type RunOutcome =
  | 'completed'
  | 'blocked'
  | 'crashed'
  | 'timed_out'
  | 'spawn_failed'
  | 'gave_up'
  | 'reclaimed';

export interface Task {
  id: string;
  title: string;
  body: string;
  assignee: string | null;
  status: TaskStatus;
  priority: number;
  tenant: string | null;
  workspaceKind: WorkspaceKind;
  workspacePath: string | null;
  branchName: string | null;
  modelOverride: string | null;
  skills: string[];
  idempotencyKey: string | null;
  result: string | null;
  claimLock: string | null;
  claimExpires: number | null;
  workerPid: number | null;
  currentRunId: number | null;
  lastHeartbeatAt: number | null;
  consecutiveFailures: number;
  lastFailureError: string | null;
  maxRuntimeSeconds: number | null;
  maxRetries: number;
  createdAt: number;
  updatedAt: number;
}

export interface TaskRun {
  id: number;
  taskId: string;
  profile: string | null;
  status: 'running' | 'finished';
  workerPid: number | null;
  startedAt: number;
  endedAt: number | null;
  outcome: RunOutcome | null;
  summary: string | null;
  metadata: Record<string, unknown> | null;
  error: string | null;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  runId: number | null;
  kind: string;
  payload: Record<string, unknown> | null;
  createdAt: number;
}

export interface TaskComment {
  id: number;
  taskId: string;
  author: string;
  body: string;
  createdAt: number;
}

export interface CreateTaskInput {
  title: string;
  body?: string;
  assignee?: string | null;
  status?: TaskStatus;
  priority?: number;
  tenant?: string | null;
  workspaceKind?: WorkspaceKind;
  branchName?: string | null;
  modelOverride?: string | null;
  skills?: string[];
  idempotencyKey?: string | null;
  maxRuntimeSeconds?: number | null;
  maxRetries?: number;
}
```

- [ ] **Step 2: Write the schema module**

Create `src/main/kanban/schema.ts`:

```ts
export const SCHEMA_VERSION = 1;

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
  branch_name TEXT,
  model_override TEXT,
  skills TEXT NOT NULL DEFAULT '[]',
  idempotency_key TEXT,
  result TEXT,
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
```

- [ ] **Step 3: Write the failing test**

Create `src/main/__tests__/kanban-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';

const TEST_DIR = join(tmpdir(), `fleet-kanban-store-test-${Date.now()}`);
const DB_PATH = join(TEST_DIR, 'kanban.db');

describe('KanbanStore', () => {
  let store: KanbanStore;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new KanbanStore(DB_PATH);
  });

  afterEach(() => {
    store.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates the db file and runs migrations', () => {
    expect(existsSync(DB_PATH)).toBe(true);
    expect(store.schemaVersion()).toBe(1);
  });
});
```

- [ ] **Step 4: Run it to confirm it fails**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts`
Expected: FAIL — cannot find module `../kanban/kanban-store`.

- [ ] **Step 5: Write the minimal store**

Create `src/main/kanban/kanban-store.ts`:

```ts
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { createLogger } from '../logger';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema';

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
}
```

- [ ] **Step 6: Run it to confirm it passes**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck:node`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/shared/kanban-types.ts src/main/kanban/schema.ts src/main/kanban/kanban-store.ts src/main/__tests__/kanban-store.test.ts
git commit -m "feat(kanban): sqlite store schema and migration"
```

---

## Task 2: Task create / get / list

**Files:**
- Modify: `src/main/kanban/kanban-store.ts`
- Test: `src/main/__tests__/kanban-store.test.ts`

- [ ] **Step 1: Add the failing tests**

Append inside the `describe` block in `kanban-store.test.ts`:

```ts
it('creates a task with defaults and reads it back', () => {
  const task = store.createTask({ title: 'Write docs' });
  expect(task.id).toMatch(/.+/);
  expect(task.title).toBe('Write docs');
  expect(task.status).toBe('todo');
  expect(task.priority).toBe(0);
  expect(task.skills).toEqual([]);
  expect(task.maxRetries).toBe(1);

  const fetched = store.getTask(task.id);
  expect(fetched).not.toBeNull();
  expect(fetched?.title).toBe('Write docs');
});

it('honors explicit fields and json skills round-trip', () => {
  const task = store.createTask({
    title: 'Build',
    body: 'do it',
    assignee: 'researcher',
    status: 'triage',
    priority: 5,
    skills: ['a', 'b']
  });
  const fetched = store.getTask(task.id);
  expect(fetched?.assignee).toBe('researcher');
  expect(fetched?.status).toBe('triage');
  expect(fetched?.priority).toBe(5);
  expect(fetched?.skills).toEqual(['a', 'b']);
});

it('lists tasks filtered by status', () => {
  store.createTask({ title: 'a', status: 'todo' });
  store.createTask({ title: 'b', status: 'ready' });
  expect(store.listTasks().length).toBe(2);
  expect(store.listTasks({ status: 'ready' }).length).toBe(1);
});

it('getTask returns null for unknown id', () => {
  expect(store.getTask('nope')).toBeNull();
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts`
Expected: FAIL — `store.createTask is not a function`.

- [ ] **Step 3: Implement create/get/list + row mapping**

Add to the top of `kanban-store.ts` imports:

```ts
import { randomUUID } from 'crypto';
import type { Task, TaskStatus, CreateTaskInput } from '../../shared/kanban-types';
```

Add these private helpers and public methods to the `KanbanStore` class:

```ts
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
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-store.ts src/main/__tests__/kanban-store.test.ts
git commit -m "feat(kanban): task create/get/list"
```

---

## Task 3: Links and dependency promotion query

**Files:**
- Modify: `src/main/kanban/kanban-store.ts`
- Test: `src/main/__tests__/kanban-store.test.ts`

- [ ] **Step 1: Add failing tests**

Append to the `describe` block:

```ts
it('links parent->child and reads parents/children', () => {
  const p = store.createTask({ title: 'parent' });
  const c = store.createTask({ title: 'child' });
  store.addLink(p.id, c.id);
  expect(store.parentsOf(c.id)).toEqual([p.id]);
  expect(store.childrenOf(p.id)).toEqual([c.id]);
});

it('promotableTodoTasks returns todo tasks whose parents are all done', () => {
  const p = store.createTask({ title: 'parent', status: 'done' });
  const c = store.createTask({ title: 'child', status: 'todo' });
  store.addLink(p.id, c.id);
  expect(store.promotableTodoTasks().map((t) => t.id)).toContain(c.id);
});

it('does not promote a todo task with an unfinished parent', () => {
  const p = store.createTask({ title: 'parent', status: 'running' });
  const c = store.createTask({ title: 'child', status: 'todo' });
  store.addLink(p.id, c.id);
  expect(store.promotableTodoTasks().map((t) => t.id)).not.toContain(c.id);
});

it('promotes a todo task with no parents', () => {
  const c = store.createTask({ title: 'orphan', status: 'todo' });
  expect(store.promotableTodoTasks().map((t) => t.id)).toContain(c.id);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts`
Expected: FAIL — `store.addLink is not a function`.

- [ ] **Step 3: Implement links + promotion query**

Add to `KanbanStore`:

```ts
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
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-store.ts src/main/__tests__/kanban-store.test.ts
git commit -m "feat(kanban): task links and dependency promotion query"
```

---

## Task 4: Atomic claim (compare-and-swap), extend, release

**Files:**
- Modify: `src/main/kanban/kanban-store.ts`
- Test: `src/main/__tests__/kanban-store.test.ts`

- [ ] **Step 1: Add failing tests**

Append to the `describe` block:

```ts
it('claims a ready task and prevents a second claim', () => {
  const t = store.createTask({ title: 'x', status: 'ready' });
  const first = store.claimTask(t.id, 'lock-A', 1000);
  expect(first).toBe(true);
  const second = store.claimTask(t.id, 'lock-B', 1000);
  expect(second).toBe(false);
  const fetched = store.getTask(t.id);
  expect(fetched?.status).toBe('running');
  expect(fetched?.claimLock).toBe('lock-A');
});

it('re-claims a task whose claim has expired', () => {
  let clock = 1000;
  const s = new KanbanStore(join(TEST_DIR, 'claim.db'), { now: () => clock });
  const t = s.createTask({ title: 'x', status: 'ready' });
  expect(s.claimTask(t.id, 'lock-A', 100)).toBe(true); // expires at 1100
  clock = 1200; // past expiry
  // expired claims are reclaimable: pretend the dispatcher returned it to ready
  s.returnToReady(t.id);
  expect(s.claimTask(t.id, 'lock-B', 100)).toBe(true);
  s.close();
});

it('extendClaim pushes claim_expires forward only for the lock holder', () => {
  let clock = 1000;
  const s = new KanbanStore(join(TEST_DIR, 'extend.db'), { now: () => clock });
  const t = s.createTask({ title: 'x', status: 'ready' });
  s.claimTask(t.id, 'lock-A', 100);
  clock = 1050;
  expect(s.extendClaim(t.id, 'lock-A', 100)).toBe(true);
  expect(s.getTask(t.id)?.claimExpires).toBe(1150);
  expect(s.extendClaim(t.id, 'wrong-lock', 100)).toBe(false);
  s.close();
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts`
Expected: FAIL — `store.claimTask is not a function`.

- [ ] **Step 3: Implement claim/extend/release/returnToReady**

Add to `KanbanStore`:

```ts
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
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-store.ts src/main/__tests__/kanban-store.test.ts
git commit -m "feat(kanban): atomic CAS claim, extend, return-to-ready"
```

---

## Task 5: Runs, events, comments

**Files:**
- Modify: `src/main/kanban/kanban-store.ts`
- Test: `src/main/__tests__/kanban-store.test.ts`

- [ ] **Step 1: Add failing tests**

Append to the `describe` block:

```ts
it('starts a run, sets it as current, and finishes it', () => {
  const t = store.createTask({ title: 'x', status: 'ready' });
  const run = store.startRun(t.id, 'researcher', 4321);
  expect(run.status).toBe('running');
  expect(store.getTask(t.id)?.currentRunId).toBe(run.id);
  store.finishRun(run.id, 'completed', { summary: 'did it', metadata: { files: 2 } });
  const runs = store.listRuns(t.id);
  expect(runs[0].outcome).toBe('completed');
  expect(runs[0].summary).toBe('did it');
  expect(runs[0].metadata).toEqual({ files: 2 });
});

it('appends and lists events with json payload', () => {
  const t = store.createTask({ title: 'x' });
  store.appendEvent(t.id, null, 'created', { by: 'human' });
  const events = store.listEvents(t.id);
  expect(events.length).toBe(1);
  expect(events[0].kind).toBe('created');
  expect(events[0].payload).toEqual({ by: 'human' });
});

it('adds and lists comments in order', () => {
  const t = store.createTask({ title: 'x' });
  store.addComment(t.id, 'researcher', 'first');
  store.addComment(t.id, 'human', 'second');
  const comments = store.listComments(t.id);
  expect(comments.map((c) => c.body)).toEqual(['first', 'second']);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts`
Expected: FAIL — `store.startRun is not a function`.

- [ ] **Step 3: Implement runs/events/comments**

Add imports: `import type { TaskRun, TaskEvent, TaskComment, RunOutcome } from '../../shared/kanban-types';`

Add to `KanbanStore`:

```ts
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
       WHERE id=?`
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
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-store.ts src/main/__tests__/kanban-store.test.ts
git commit -m "feat(kanban): runs, events, and comments"
```

---

## Task 6: Terminal transitions + reclaim helpers

**Files:**
- Modify: `src/main/kanban/kanban-store.ts`
- Test: `src/main/__tests__/kanban-store.test.ts`

These are the state-machine transitions the dispatcher and MCP server call. `completeTask`/`blockTask` reset the failure counter / record the failure; `reclaimExpiredOrDead` returns the list of tasks whose claim expired or whose pid is dead (the dispatcher decides retry vs gave_up).

- [ ] **Step 1: Add failing tests**

Append to the `describe` block:

```ts
it('completeTask sets done, stores result, clears claim, resets failures', () => {
  const t = store.createTask({ title: 'x', status: 'ready' });
  store.claimTask(t.id, 'L', 1000);
  store.completeTask(t.id, 'shipped');
  const f = store.getTask(t.id);
  expect(f?.status).toBe('done');
  expect(f?.result).toBe('shipped');
  expect(f?.claimLock).toBeNull();
  expect(f?.consecutiveFailures).toBe(0);
});

it('blockTask sets blocked and stores reason as result', () => {
  const t = store.createTask({ title: 'x', status: 'ready' });
  store.claimTask(t.id, 'L', 1000);
  store.blockTask(t.id, 'needs key');
  const f = store.getTask(t.id);
  expect(f?.status).toBe('blocked');
  expect(f?.result).toBe('needs key');
});

it('recordFailure increments counter and stores error', () => {
  const t = store.createTask({ title: 'x', status: 'running' });
  store.recordFailure(t.id, 'boom');
  expect(store.getTask(t.id)?.consecutiveFailures).toBe(1);
  store.recordFailure(t.id, 'boom2');
  expect(store.getTask(t.id)?.consecutiveFailures).toBe(2);
  expect(store.getTask(t.id)?.lastFailureError).toBe('boom2');
});

it('runningTasks returns only running tasks with claim info', () => {
  const a = store.createTask({ title: 'a', status: 'ready' });
  store.createTask({ title: 'b', status: 'todo' });
  store.claimTask(a.id, 'L', 1000);
  const running = store.runningTasks();
  expect(running.map((t) => t.id)).toEqual([a.id]);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts`
Expected: FAIL — `store.completeTask is not a function`.

- [ ] **Step 3: Implement transitions**

Add to `KanbanStore`:

```ts
completeTask(taskId: string, result: string | null): void {
  const ts = this.now();
  this.db
    .prepare(
      `UPDATE tasks SET status='done', result=?, claim_lock=NULL, claim_expires=NULL,
        worker_pid=NULL, consecutive_failures=0, last_failure_error=NULL, updated_at=?
       WHERE id=?`
    )
    .run(result, ts, taskId);
}

blockTask(taskId: string, reason: string): void {
  const ts = this.now();
  this.db
    .prepare(
      `UPDATE tasks SET status='blocked', result=?, claim_lock=NULL, claim_expires=NULL,
        worker_pid=NULL, updated_at=?
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
        worker_pid=NULL, last_failure_error=?, updated_at=?
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

setStatus(taskId: string, status: TaskStatus): void {
  this.db
    .prepare('UPDATE tasks SET status=?, updated_at=? WHERE id=?')
    .run(status, this.now(), taskId);
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-store.ts src/main/__tests__/kanban-store.test.ts
git commit -m "feat(kanban): terminal transitions and failure/reclaim helpers"
```

---

## Task 7: Scratch workspace prepare/cleanup

**Files:**
- Create: `src/main/kanban/workspace.ts`
- Test: `src/main/__tests__/kanban-workspace.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/__tests__/kanban-workspace.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { prepareWorkspace, cleanupWorkspace } from '../kanban/workspace';

const ROOT = join(tmpdir(), `fleet-kanban-ws-test-${Date.now()}`);

describe('kanban workspace', () => {
  beforeEach(() => mkdirSync(ROOT, { recursive: true }));
  afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

  it('creates a scratch dir under the root', () => {
    const path = prepareWorkspace({ kind: 'scratch', taskId: 'abc', workspacesRoot: ROOT });
    expect(existsSync(path)).toBe(true);
    expect(path.startsWith(ROOT)).toBe(true);
  });

  it('cleans up a scratch dir', () => {
    const path = prepareWorkspace({ kind: 'scratch', taskId: 'abc', workspacesRoot: ROOT });
    cleanupWorkspace({ kind: 'scratch', path });
    expect(existsSync(path)).toBe(false);
  });

  it('does not delete a dir-kind workspace on cleanup', () => {
    const keep = join(ROOT, 'keep');
    mkdirSync(keep);
    cleanupWorkspace({ kind: 'dir', path: keep });
    expect(existsSync(keep)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/main/__tests__/kanban-workspace.test.ts`
Expected: FAIL — cannot find module `../kanban/workspace`.

- [ ] **Step 3: Implement workspace.ts**

Create `src/main/kanban/workspace.ts`:

```ts
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import type { WorkspaceKind } from '../../shared/kanban-types';

export interface PrepareWorkspaceInput {
  kind: WorkspaceKind;
  taskId: string;
  workspacesRoot: string;
  /** For 'dir'/'worktree' kinds, the resolved absolute path. */
  path?: string;
}

/** Returns the absolute workspace path the worker should run in. */
export function prepareWorkspace(input: PrepareWorkspaceInput): string {
  if (input.kind === 'scratch') {
    const path = join(input.workspacesRoot, input.taskId);
    mkdirSync(path, { recursive: true });
    return path;
  }
  // dir / worktree: Phase 5 resolves these; for now require an explicit path.
  if (!input.path) {
    throw new Error(`prepareWorkspace: kind '${input.kind}' requires an explicit path`);
  }
  return input.path;
}

export function cleanupWorkspace(input: { kind: WorkspaceKind; path: string }): void {
  // Only scratch is ephemeral; dir/worktree are preserved.
  if (input.kind === 'scratch') {
    rmSync(input.path, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run src/main/__tests__/kanban-workspace.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/workspace.ts src/main/__tests__/kanban-workspace.test.ts
git commit -m "feat(kanban): scratch workspace prepare/cleanup"
```

---

## Task 8: Dispatcher — reclaim step

**Files:**
- Create: `src/main/kanban/kanban-dispatcher.ts`
- Test: `src/main/__tests__/kanban-dispatcher.test.ts`

The dispatcher takes the store, a clock, an `isAlive(pid)` predicate (injectable so tests don't depend on real pids), config, and a `spawnWorker` fn (added in Task 10; default a no-op here). `reclaim()` returns expired/dead running tasks to `ready`, or gives up after the failure limit.

- [ ] **Step 1: Write the failing test**

Create `src/main/__tests__/kanban-dispatcher.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';
import { KanbanDispatcher } from '../kanban/kanban-dispatcher';

const TEST_DIR = join(tmpdir(), `fleet-kanban-disp-test-${Date.now()}`);

function makeStore(clock: { t: number }): KanbanStore {
  return new KanbanStore(join(TEST_DIR, `d-${clock.t}-${Math.random()}.db`), {
    now: () => clock.t
  });
}

describe('KanbanDispatcher.reclaim', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('returns a task with an expired claim back to ready', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
    store.claimTask(t.id, 'L', 100); // expires 1100
    store.startRun(t.id, 'r', 4321);
    clock.t = 2000;
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: { failureLimit: 2, claimGraceMs: 0 }
    });
    disp.reclaim();
    expect(store.getTask(t.id)?.status).toBe('ready');
    expect(store.getTask(t.id)?.consecutiveFailures).toBe(1);
    store.close();
  });

  it('gives up after exceeding the failure limit', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
    store.recordFailure(t.id, 'prev');
    store.recordFailure(t.id, 'prev2'); // now at 2 == limit
    store.claimTask(t.id, 'L', 100);
    clock.t = 2000;
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: { failureLimit: 2, claimGraceMs: 0 }
    });
    disp.reclaim();
    expect(store.getTask(t.id)?.status).toBe('blocked');
    store.close();
  });

  it('reclaims a running task whose pid is dead even if claim not expired', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
    store.claimTask(t.id, 'L', 100000); // long ttl
    store.startRun(t.id, 'r', 9999);
    clock.t = 1001 + 31_000; // past the 30s grace window
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => false, // pid dead
      spawnWorker: () => undefined,
      config: { failureLimit: 2, claimGraceMs: 30_000 }
    });
    disp.reclaim();
    expect(store.getTask(t.id)?.status).toBe('ready');
    store.close();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts`
Expected: FAIL — cannot find module `../kanban/kanban-dispatcher`.

- [ ] **Step 3: Implement the dispatcher skeleton + reclaim**

Create `src/main/kanban/kanban-dispatcher.ts`:

```ts
import { createLogger } from '../logger';
import type { KanbanStore } from './kanban-store';
import type { Task } from '../../shared/kanban-types';

const log = createLogger('kanban-dispatcher');

export interface SpawnWorkerArgs {
  task: Task;
  runId: number;
  lock: string;
  workspace: string;
}

export interface DispatcherConfig {
  failureLimit: number; // consecutive failures before gave_up
  claimGraceMs: number; // protect freshly-spawned workers from reclaim
  maxInProgress?: number; // concurrency cap (used in Task 10)
  claimTtlMs?: number; // claim lease length (used in Task 10)
}

export interface DispatcherDeps {
  now: () => number;
  isAlive: (pid: number) => boolean;
  spawnWorker: (args: SpawnWorkerArgs) => number | undefined; // returns pid
  config: DispatcherConfig;
}

export class KanbanDispatcher {
  constructor(
    private store: KanbanStore,
    private deps: DispatcherDeps
  ) {}

  /** Return expired/dead running tasks to ready, or give up past the failure limit. */
  reclaim(): void {
    const now = this.deps.now();
    for (const task of this.store.runningTasks()) {
      const expired = task.claimExpires != null && task.claimExpires <= now;
      const fresh =
        task.lastHeartbeatAt != null && now - task.lastHeartbeatAt < this.deps.config.claimGraceMs;
      const dead = task.workerPid != null && !fresh && !this.deps.isAlive(task.workerPid);
      if (!expired && !dead) continue;

      const reason = expired ? 'claim expired' : 'worker pid not alive';
      if (task.currentRunId != null) {
        this.store.finishRun(task.currentRunId, 'reclaimed', { error: reason });
      }
      this.store.recordFailure(task.id, reason);
      this.store.appendEvent(task.id, task.currentRunId, 'reclaimed', { reason });

      const failures = this.store.getTask(task.id)?.consecutiveFailures ?? 0;
      if (failures >= this.deps.config.failureLimit) {
        this.store.giveUp(task.id, reason);
        this.store.appendEvent(task.id, null, 'gave_up', { reason });
        log.warn('task gave up', { taskId: task.id, failures });
      } else {
        this.store.returnToReady(task.id);
      }
    }
  }
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-dispatcher.ts src/main/__tests__/kanban-dispatcher.test.ts
git commit -m "feat(kanban): dispatcher reclaim step"
```

---

## Task 9: Dispatcher — promote step

**Files:**
- Modify: `src/main/kanban/kanban-dispatcher.ts`
- Test: `src/main/__tests__/kanban-dispatcher.test.ts`

- [ ] **Step 1: Add failing test**

Append a new `describe` block to `kanban-dispatcher.test.ts`:

```ts
describe('KanbanDispatcher.promote', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('promotes a todo task whose parents are all done', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const p = store.createTask({ title: 'p', status: 'done' });
    const c = store.createTask({ title: 'c', status: 'todo' });
    store.addLink(p.id, c.id);
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: { failureLimit: 2, claimGraceMs: 0 }
    });
    disp.promote();
    expect(store.getTask(c.id)?.status).toBe('ready');
    store.close();
  });

  it('leaves a todo task blocked by an unfinished parent', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const p = store.createTask({ title: 'p', status: 'running' });
    const c = store.createTask({ title: 'c', status: 'todo' });
    store.addLink(p.id, c.id);
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => undefined,
      config: { failureLimit: 2, claimGraceMs: 0 }
    });
    disp.promote();
    expect(store.getTask(c.id)?.status).toBe('todo');
    store.close();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts`
Expected: FAIL — `disp.promote is not a function`.

- [ ] **Step 3: Implement promote**

Add to the `KanbanDispatcher` class:

```ts
/** Promote todo tasks whose parents are all done to ready. */
promote(): void {
  for (const task of this.store.promotableTodoTasks()) {
    this.store.setStatus(task.id, 'ready');
    this.store.appendEvent(task.id, null, 'promoted', {});
  }
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-dispatcher.ts src/main/__tests__/kanban-dispatcher.test.ts
git commit -m "feat(kanban): dispatcher promote step"
```

---

## Task 10: Dispatcher — claim & spawn step + tick loop

**Files:**
- Modify: `src/main/kanban/kanban-dispatcher.ts`
- Test: `src/main/__tests__/kanban-dispatcher.test.ts`

`claimAndSpawn()` claims up to `maxInProgress - currentlyRunning` ready tasks, starts a run, prepares the workspace via an injected `prepareWorkspaceFn`, and calls `spawnWorker`. On spawn failure it records a failure and returns the task to ready. `tick()` chains reclaim → promote → claimAndSpawn. `start()`/`stop()` manage the interval.

- [ ] **Step 1: Add failing test**

Append a new `describe` block to `kanban-dispatcher.test.ts`:

```ts
describe('KanbanDispatcher.claimAndSpawn', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('claims a ready task, starts a run, and calls spawnWorker', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
    const spawned: string[] = [];
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: (args) => {
        spawned.push(args.task.id);
        return 12345;
      },
      config: { failureLimit: 2, claimGraceMs: 0, maxInProgress: 3, claimTtlMs: 1000 },
      prepareWorkspaceFn: () => '/tmp/ws'
    });
    disp.claimAndSpawn();
    expect(spawned).toEqual([t.id]);
    expect(store.getTask(t.id)?.status).toBe('running');
    expect(store.getTask(t.id)?.workerPid).toBe(12345);
    expect(store.listRuns(t.id).length).toBe(1);
    store.close();
  });

  it('respects the maxInProgress concurrency cap', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    // one already running
    const a = store.createTask({ title: 'a', status: 'ready', assignee: 'r' });
    store.claimTask(a.id, 'L', 100000);
    // two more ready
    store.createTask({ title: 'b', status: 'ready', assignee: 'r' });
    store.createTask({ title: 'c', status: 'ready', assignee: 'r' });
    let spawnCount = 0;
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => {
        spawnCount += 1;
        return 1;
      },
      config: { failureLimit: 2, claimGraceMs: 0, maxInProgress: 2, claimTtlMs: 1000 },
      prepareWorkspaceFn: () => '/tmp/ws'
    });
    disp.claimAndSpawn();
    expect(spawnCount).toBe(1); // 2 cap - 1 already running = 1 new
    store.close();
  });

  it('returns the task to ready and records failure when spawn throws', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => {
        throw new Error('spawn boom');
      },
      config: { failureLimit: 2, claimGraceMs: 0, maxInProgress: 3, claimTtlMs: 1000 },
      prepareWorkspaceFn: () => '/tmp/ws'
    });
    disp.claimAndSpawn();
    expect(store.getTask(t.id)?.status).toBe('ready');
    expect(store.getTask(t.id)?.consecutiveFailures).toBe(1);
    store.close();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts`
Expected: FAIL — `disp.claimAndSpawn is not a function` (and a type error on `prepareWorkspaceFn`).

- [ ] **Step 3: Implement claimAndSpawn + tick + start/stop**

In `kanban-dispatcher.ts`, add to the `DispatcherDeps` interface:

```ts
  prepareWorkspaceFn?: (task: Task) => string;
  intervalMs?: number;
```

Add a private field and timer plus these methods to `KanbanDispatcher`:

```ts
private timer: ReturnType<typeof setInterval> | null = null;
private genLock = 0;

private nextLock(): string {
  this.genLock += 1;
  return `${this.deps.now()}-${this.genLock}`;
}

claimAndSpawn(): void {
  const cap = this.deps.config.maxInProgress ?? 3;
  const ttl = this.deps.config.claimTtlMs ?? 15 * 60 * 1000;
  let slots = cap - this.store.runningTasks().length;
  if (slots <= 0) return;

  for (const task of this.store.readyTasks()) {
    if (slots <= 0) break;
    const lock = this.nextLock();
    if (!this.store.claimTask(task.id, lock, ttl)) continue; // lost the race

    let pid: number | undefined;
    try {
      const workspace = this.deps.prepareWorkspaceFn
        ? this.deps.prepareWorkspaceFn(task)
        : (task.workspacePath ?? '');
      const run = this.store.startRun(task.id, task.assignee, null);
      pid = this.deps.spawnWorker({ task, runId: run.id, lock, workspace });
      if (pid != null) {
        this.store.setWorkerPid(task.id, run.id, pid);
      }
      this.store.appendEvent(task.id, run.id, 'spawned', { pid: pid ?? null });
      slots -= 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.store.recordFailure(task.id, msg);
      this.store.appendEvent(task.id, null, 'spawn_failed', { error: msg });
      this.store.returnToReady(task.id);
      log.error('spawn failed', { taskId: task.id, error: msg });
    }
  }
}

tick(): void {
  this.reclaim();
  this.promote();
  this.claimAndSpawn();
}

start(): void {
  if (this.timer) return;
  const interval = this.deps.intervalMs ?? 5000;
  this.timer = setInterval(() => {
    try {
      this.tick();
    } catch (err) {
      log.error('tick error', { error: err instanceof Error ? err.message : String(err) });
    }
  }, interval);
}

stop(): void {
  if (this.timer) {
    clearInterval(this.timer);
    this.timer = null;
  }
}
```

Add the `setWorkerPid` helper to `KanbanStore` (`kanban-store.ts`):

```ts
setWorkerPid(taskId: string, runId: number, pid: number): void {
  const ts = this.now();
  this.db
    .prepare('UPDATE tasks SET worker_pid=?, updated_at=? WHERE id=?')
    .run(pid, ts, taskId);
  this.db.prepare('UPDATE task_runs SET worker_pid=? WHERE id=?').run(pid, runId);
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck:node`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/kanban/kanban-dispatcher.ts src/main/kanban/kanban-store.ts src/main/__tests__/kanban-dispatcher.test.ts
git commit -m "feat(kanban): dispatcher claim/spawn step and tick loop"
```

---

## Task 11: MCP server — JSON-RPC HTTP endpoint + token scoping

**Files:**
- Create: `src/main/kanban/kanban-mcp-server.ts`
- Test: `src/main/__tests__/kanban-mcp-server.test.ts`

The server speaks JSON-RPC 2.0 over HTTP POST (matching Rune's client: `initialize`, `notifications/initialized`, `tools/list`, `tools/call`; responds `application/json`). A per-run token (registered via `registerRun`) scopes a request to a task. This task implements the server, `initialize`, `tools/list`, and token resolution; `tools/call` lands in Task 12.

- [ ] **Step 1: Write the failing test**

Create `src/main/__tests__/kanban-mcp-server.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';
import { KanbanMcpServer } from '../kanban/kanban-mcp-server';

const TEST_DIR = join(tmpdir(), `fleet-kanban-mcp-test-${Date.now()}`);

async function rpc(url: string, method: string, params?: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  return res.json();
}

describe('KanbanMcpServer', () => {
  let store: KanbanStore;
  let server: KanbanMcpServer;
  let base: string;

  beforeEach(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new KanbanStore(join(TEST_DIR, 'mcp.db'));
    server = new KanbanMcpServer(store);
    const port = await server.start(0); // 0 = ephemeral port
    base = `http://127.0.0.1:${port}/mcp`;
  });

  afterEach(async () => {
    await server.stop();
    store.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('responds to initialize', async () => {
    const r = await rpc(base, 'initialize', { protocolVersion: '2024-11-05' });
    expect(r.result.protocolVersion).toBe('2024-11-05');
    expect(r.result.serverInfo.name).toBe('fleet-kanban');
  });

  it('lists worker tools', async () => {
    const r = await rpc(base, 'tools/list');
    const names = r.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('kanban_complete');
    expect(names).toContain('kanban_block');
    expect(names).toContain('kanban_comment');
    expect(names).toContain('kanban_heartbeat');
    expect(names).toContain('kanban_show');
  });

  it('rejects a tools/call with an unknown run token', async () => {
    const r = await rpc(`${base}?run=bogus`, 'tools/call', {
      name: 'kanban_show',
      arguments: {}
    });
    expect(r.error).toBeTruthy();
    expect(String(r.error.message)).toMatch(/run token/i);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/main/__tests__/kanban-mcp-server.test.ts`
Expected: FAIL — cannot find module `../kanban/kanban-mcp-server`.

- [ ] **Step 3: Implement the server skeleton**

Create `src/main/kanban/kanban-mcp-server.ts`:

```ts
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { URL } from 'url';
import { createLogger } from '../logger';
import type { KanbanStore } from './kanban-store';

const log = createLogger('kanban-mcp');

export type McpRole = 'worker' | 'orchestrator';

interface RunScope {
  taskId: string;
  runId: number;
  role: McpRole;
}

interface JsonRpcRequest {
  jsonrpc: string;
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = '2024-11-05';

const WORKER_TOOLS = [
  {
    name: 'kanban_show',
    description: 'Show the current task: title, body, comments, prior run summaries.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'kanban_complete',
    description: 'Mark the task done with a human-readable summary and optional metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        metadata: { type: 'object' }
      },
      required: ['summary']
    }
  },
  {
    name: 'kanban_block',
    description: 'Block the task for human input. Prefix reason with "review-required: " for review.',
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason']
    }
  },
  {
    name: 'kanban_comment',
    description: 'Append a durable comment to the task thread.',
    inputSchema: {
      type: 'object',
      properties: { body: { type: 'string' } },
      required: ['body']
    }
  },
  {
    name: 'kanban_heartbeat',
    description: 'Signal liveness during a long operation; extends the claim lease.',
    inputSchema: {
      type: 'object',
      properties: { note: { type: 'string' } }
    }
  }
];

export class KanbanMcpServer {
  private server: Server | null = null;
  private runs = new Map<string, RunScope>();
  private claimLocks = new Map<string, string>(); // token -> claim lock (for heartbeat)

  constructor(private store: KanbanStore) {}

  /** Register a per-run token; returns the token to embed in the worker's MCP url. */
  registerRun(token: string, scope: RunScope, claimLock: string): void {
    this.runs.set(token, scope);
    this.claimLocks.set(token, claimLock);
  }

  unregisterRun(token: string): void {
    this.runs.delete(token);
    this.claimLocks.delete(token);
  }

  start(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          log.error('handler error', { error: err instanceof Error ? err.message : String(err) });
          this.send(res, 500, { error: 'internal' });
        });
      });
      this.server.on('error', reject);
      // Bind to loopback only — never expose the board to the network.
      this.server.listen(port, '127.0.0.1', () => {
        const addr = this.server?.address();
        const bound = typeof addr === 'object' && addr ? addr.port : port;
        log.info('kanban mcp server listening', { port: bound });
        resolve(bound);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(json);
  }

  private rpcResult(res: ServerResponse, id: JsonRpcRequest['id'], result: unknown): void {
    this.send(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
  }

  private rpcError(res: ServerResponse, id: JsonRpcRequest['id'], message: string): void {
    this.send(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message } });
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf-8');
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') return this.send(res, 405, { error: 'method not allowed' });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const token = url.searchParams.get('run') ?? '';
    const raw = await this.readBody(req);
    let rpcReq: JsonRpcRequest;
    try {
      rpcReq = JSON.parse(raw) as JsonRpcRequest;
    } catch {
      return this.send(res, 400, { error: 'bad json' });
    }

    switch (rpcReq.method) {
      case 'initialize':
        return this.rpcResult(res, rpcReq.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'fleet-kanban', version: '1' }
        });
      case 'notifications/initialized':
        res.writeHead(202).end();
        return;
      case 'tools/list':
        return this.rpcResult(res, rpcReq.id, { tools: WORKER_TOOLS });
      case 'tools/call':
        return this.handleToolCall(res, rpcReq, token);
      default:
        return this.rpcError(res, rpcReq.id, `unknown method: ${rpcReq.method}`);
    }
  }

  // Implemented in Task 12.
  private handleToolCall(res: ServerResponse, rpcReq: JsonRpcRequest, token: string): void {
    const scope = this.runs.get(token);
    if (!scope) return this.rpcError(res, rpcReq.id, 'unknown or missing run token');
    return this.rpcError(res, rpcReq.id, 'not implemented');
  }
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run src/main/__tests__/kanban-mcp-server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-mcp-server.ts src/main/__tests__/kanban-mcp-server.test.ts
git commit -m "feat(kanban): mcp server scaffolding, initialize, tools/list, token scoping"
```

---

## Task 12: MCP server — tools/call handlers

**Files:**
- Modify: `src/main/kanban/kanban-mcp-server.ts`
- Test: `src/main/__tests__/kanban-mcp-server.test.ts`

- [ ] **Step 1: Add failing tests**

Append to the `describe` block in `kanban-mcp-server.test.ts`:

```ts
it('kanban_complete marks the task done and finishes the run', async () => {
  const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
  store.claimTask(t.id, 'LOCK', 100000);
  const run = store.startRun(t.id, 'r', 1);
  server.registerRun('tok1', { taskId: t.id, runId: run.id, role: 'worker' }, 'LOCK');

  const r = await rpc(`${base}?run=tok1`, 'tools/call', {
    name: 'kanban_complete',
    arguments: { summary: 'shipped it', metadata: { files: 3 } }
  });
  expect(r.result.content[0].text).toMatch(/done/i);
  expect(store.getTask(t.id)?.status).toBe('done');
  expect(store.getTask(t.id)?.result).toBe('shipped it');
  const runs = store.listRuns(t.id);
  expect(runs[0].outcome).toBe('completed');
});

it('kanban_block blocks the task', async () => {
  const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
  store.claimTask(t.id, 'LOCK', 100000);
  const run = store.startRun(t.id, 'r', 1);
  server.registerRun('tok2', { taskId: t.id, runId: run.id, role: 'worker' }, 'LOCK');
  await rpc(`${base}?run=tok2`, 'tools/call', {
    name: 'kanban_block',
    arguments: { reason: 'review-required: see comment' }
  });
  expect(store.getTask(t.id)?.status).toBe('blocked');
});

it('kanban_comment appends a comment authored by the assignee', async () => {
  const t = store.createTask({ title: 'x', status: 'ready', assignee: 'researcher' });
  const run = store.startRun(t.id, 'researcher', 1);
  server.registerRun('tok3', { taskId: t.id, runId: run.id, role: 'worker' }, 'LOCK');
  await rpc(`${base}?run=tok3`, 'tools/call', {
    name: 'kanban_comment',
    arguments: { body: 'progress note' }
  });
  const comments = store.listComments(t.id);
  expect(comments[0].body).toBe('progress note');
  expect(comments[0].author).toBe('researcher');
});

it('kanban_heartbeat extends the claim for the lock holder', async () => {
  const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
  store.claimTask(t.id, 'LOCK', 1000);
  const before = store.getTask(t.id)?.claimExpires ?? 0;
  const run = store.startRun(t.id, 'r', 1);
  server.registerRun('tok4', { taskId: t.id, runId: run.id, role: 'worker' }, 'LOCK');
  await rpc(`${base}?run=tok4`, 'tools/call', { name: 'kanban_heartbeat', arguments: {} });
  const after = store.getTask(t.id)?.claimExpires ?? 0;
  expect(after).toBeGreaterThanOrEqual(before);
});

it('kanban_show returns the task title and body', async () => {
  const t = store.createTask({ title: 'My task', body: 'do the thing', status: 'ready', assignee: 'r' });
  const run = store.startRun(t.id, 'r', 1);
  server.registerRun('tok5', { taskId: t.id, runId: run.id, role: 'worker' }, 'LOCK');
  const r = await rpc(`${base}?run=tok5`, 'tools/call', { name: 'kanban_show', arguments: {} });
  expect(r.result.content[0].text).toMatch(/My task/);
  expect(r.result.content[0].text).toMatch(/do the thing/);
});

it('writes a task_event for each tool call', async () => {
  const t = store.createTask({ title: 'x', status: 'ready', assignee: 'r' });
  const run = store.startRun(t.id, 'r', 1);
  server.registerRun('tok6', { taskId: t.id, runId: run.id, role: 'worker' }, 'LOCK');
  await rpc(`${base}?run=tok6`, 'tools/call', { name: 'kanban_comment', arguments: { body: 'x' } });
  const kinds = store.listEvents(t.id).map((e) => e.kind);
  expect(kinds).toContain('comment');
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/main/__tests__/kanban-mcp-server.test.ts`
Expected: FAIL — `kanban_complete` returns "not implemented".

- [ ] **Step 3: Implement tools/call**

Add `import { z } from 'zod';` at the top of `kanban-mcp-server.ts`.

Replace the placeholder `handleToolCall` method with:

```ts
private text(res: ServerResponse, id: JsonRpcRequest['id'], message: string): void {
  this.rpcResult(res, id, { content: [{ type: 'text', text: message }] });
}

private handleToolCall(res: ServerResponse, rpcReq: JsonRpcRequest, token: string): void {
  const scope = this.runs.get(token);
  if (!scope) return this.rpcError(res, rpcReq.id, 'unknown or missing run token');

  const params = rpcReq.params ?? {};
  const name = String(params.name ?? '');
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const task = this.store.getTask(scope.taskId);
  if (!task) return this.rpcError(res, rpcReq.id, `task ${scope.taskId} not found`);
  const author = task.assignee ?? 'worker';

  try {
    switch (name) {
      case 'kanban_show': {
        const comments = this.store.listComments(task.id);
        const runs = this.store.listRuns(task.id).filter((r) => r.summary);
        const lines = [
          `# ${task.title} (${task.id})`,
          '',
          task.body || '(no body)',
          '',
          comments.length ? '## Comments' : '',
          ...comments.map((c) => `- ${c.author}: ${c.body}`),
          runs.length ? '## Prior runs' : '',
          ...runs.map((r) => `- ${r.outcome}: ${r.summary ?? ''}`)
        ].filter(Boolean);
        return this.text(res, rpcReq.id, lines.join('\n'));
      }
      case 'kanban_complete': {
        const a = z.object({ summary: z.string(), metadata: z.record(z.unknown()).optional() }).parse(args);
        this.store.completeTask(task.id, a.summary);
        this.store.finishRun(scope.runId, 'completed', { summary: a.summary, metadata: a.metadata });
        this.store.appendEvent(task.id, scope.runId, 'completed', { summary: a.summary });
        return this.text(res, rpcReq.id, `Task ${task.id} marked done.`);
      }
      case 'kanban_block': {
        const a = z.object({ reason: z.string() }).parse(args);
        this.store.blockTask(task.id, a.reason);
        this.store.finishRun(scope.runId, 'blocked', { summary: a.reason });
        this.store.appendEvent(task.id, scope.runId, 'blocked', { reason: a.reason });
        return this.text(res, rpcReq.id, `Task ${task.id} blocked.`);
      }
      case 'kanban_comment': {
        const a = z.object({ body: z.string() }).parse(args);
        this.store.addComment(task.id, author, a.body);
        this.store.appendEvent(task.id, scope.runId, 'comment', { author });
        return this.text(res, rpcReq.id, 'Comment added.');
      }
      case 'kanban_heartbeat': {
        const lock = this.claimLocks.get(token);
        if (lock) this.store.extendClaim(task.id, lock, 15 * 60 * 1000);
        this.store.appendEvent(task.id, scope.runId, 'heartbeat', {});
        return this.text(res, rpcReq.id, 'Heartbeat recorded.');
      }
      default:
        return this.rpcError(res, rpcReq.id, `unknown tool: ${name}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return this.rpcError(res, rpcReq.id, msg);
  }
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run src/main/__tests__/kanban-mcp-server.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck:node`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/kanban/kanban-mcp-server.ts src/main/__tests__/kanban-mcp-server.test.ts
git commit -m "feat(kanban): mcp worker tool handlers (complete/block/comment/heartbeat/show)"
```

---

## Task 13: Real worker spawn fn + integration wiring

**Files:**
- Create: `src/main/kanban/spawn-worker.ts`
- Test: `src/main/__tests__/kanban-spawn-worker.test.ts`
- Modify: `src/main/index.ts`

`spawnRuneWorker` builds the `rune --prompt` invocation, writes a task-scoped `.rune/mcp.json` into the workspace (per rune#11), sets env, and spawns a detached child whose stdout/stderr stream to a per-run log file. The unit test verifies the command/env/config it *would* run via an injected spawn fn (no real process). Wiring in `index.ts` instantiates the three components on app ready and tears them down on quit.

- [ ] **Step 1: Write the failing test**

Create `src/main/__tests__/kanban-spawn-worker.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildWorkerInvocation } from '../kanban/spawn-worker';

const ROOT = join(tmpdir(), `fleet-kanban-spawn-test-${Date.now()}`);

describe('buildWorkerInvocation', () => {
  beforeEach(() => mkdirSync(ROOT, { recursive: true }));
  afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

  it('builds rune --prompt args with the profile and writes a scoped mcp.json', () => {
    const workspace = join(ROOT, 'ws');
    mkdirSync(workspace, { recursive: true });
    const inv = buildWorkerInvocation({
      task: {
        id: 'abc',
        title: 'Do X',
        body: 'details',
        assignee: 'researcher',
        modelOverride: null
      },
      workspace,
      mcpPort: 5599,
      runToken: 'tok-abc',
      logPath: join(ROOT, 'abc.log')
    });

    expect(inv.command).toBe('rune');
    expect(inv.args).toContain('--prompt');
    expect(inv.args).toContain('--profile');
    expect(inv.args).toContain('researcher');
    expect(inv.env.RUNE_MCP_CONFIG).toBe(join(workspace, '.rune', 'mcp.json'));
    expect(inv.env.FLEET_KANBAN_TASK).toBe('abc');

    const cfg = JSON.parse(readFileSync(join(workspace, '.rune', 'mcp.json'), 'utf-8'));
    expect(cfg.servers.kanban.url).toBe('http://127.0.0.1:5599/mcp?run=tok-abc');
    expect(cfg.servers.kanban.type).toBe('http');
    expect(existsSync(join(workspace, '.rune', 'mcp.json'))).toBe(true);
  });

  it('adds --model when a model override is set', () => {
    const workspace = join(ROOT, 'ws2');
    mkdirSync(workspace, { recursive: true });
    const inv = buildWorkerInvocation({
      task: { id: 'd', title: 't', body: '', assignee: 'r', modelOverride: 'gpt-4' },
      workspace,
      mcpPort: 1,
      runToken: 'x',
      logPath: join(ROOT, 'd.log')
    });
    expect(inv.args).toContain('--model');
    expect(inv.args).toContain('gpt-4');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/main/__tests__/kanban-spawn-worker.test.ts`
Expected: FAIL — cannot find module `../kanban/spawn-worker`.

- [ ] **Step 3: Implement spawn-worker.ts**

Create `src/main/kanban/spawn-worker.ts`:

```ts
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, openSync } from 'fs';
import { join, dirname } from 'path';
import { createLogger } from '../logger';

const log = createLogger('kanban-spawn');

export interface WorkerTaskInfo {
  id: string;
  title: string;
  body: string;
  assignee: string | null;
  modelOverride: string | null;
}

export interface BuildWorkerInput {
  task: WorkerTaskInfo;
  workspace: string;
  mcpPort: number;
  runToken: string;
  logPath: string;
}

export interface WorkerInvocation {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  logPath: string;
}

/** Pure builder: computes the rune invocation and writes the scoped mcp.json. */
export function buildWorkerInvocation(input: BuildWorkerInput): WorkerInvocation {
  const runeDir = join(input.workspace, '.rune');
  mkdirSync(runeDir, { recursive: true });
  const mcpConfigPath = join(runeDir, 'mcp.json');
  const url = `http://127.0.0.1:${input.mcpPort}/mcp?run=${input.runToken}`;
  writeFileSync(
    mcpConfigPath,
    JSON.stringify({ servers: { kanban: { type: 'http', url } } }, null, 2)
  );

  const prompt = `work kanban task ${input.task.id}: ${input.task.title}\n\n${input.task.body}`;
  const args = ['--prompt', prompt];
  if (input.task.assignee) args.push('--profile', input.task.assignee);
  if (input.task.modelOverride) args.push('--model', input.task.modelOverride);

  return {
    command: 'rune',
    args,
    cwd: input.workspace,
    logPath: input.logPath,
    env: {
      RUNE_MCP_CONFIG: mcpConfigPath,
      FLEET_KANBAN_TASK: input.task.id,
      FLEET_KANBAN_RUN: input.runToken
    }
  };
}

/** Spawns the worker as a detached child; returns its pid (or undefined on failure). */
export function spawnRuneWorker(input: BuildWorkerInput): number | undefined {
  const inv = buildWorkerInvocation(input);
  mkdirSync(dirname(inv.logPath), { recursive: true });
  const out = openSync(inv.logPath, 'a');
  const child = spawn(inv.command, inv.args, {
    cwd: inv.cwd,
    env: { ...process.env, ...inv.env },
    detached: true,
    stdio: ['ignore', out, out]
  });
  child.unref();
  log.info('spawned rune worker', { taskId: input.task.id, pid: child.pid });
  return child.pid;
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run src/main/__tests__/kanban-spawn-worker.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the components into the main process**

In `src/main/index.ts`, near the other service constructions (search for `new AnnotationStore` / the service init block around lines 49–88), add the kanban bootstrap. First add imports at the top with the other `./` imports:

```ts
import { join } from 'path';
import { homedir } from 'os';
import { KanbanStore } from './kanban/kanban-store';
import { KanbanDispatcher } from './kanban/kanban-dispatcher';
import { KanbanMcpServer } from './kanban/kanban-mcp-server';
import { prepareWorkspace } from './kanban/workspace';
import { spawnRuneWorker } from './kanban/spawn-worker';
import { randomUUID } from 'crypto';
```

(Skip any import already present — `join`, `homedir`, `randomUUID` may already be imported; do not duplicate.)

Then, inside the app-ready service-init section, add the following. **This block awaits `kanbanMcp.start`, so it must run in an async context** — the existing service init is inside `app.whenReady().then(async () => { … })`; if the spot you add it to isn't async, wrap the kanban bootstrap in an async IIFE (`void (async () => { … })()`).

```ts
const KANBAN_HOME = join(homedir(), '.fleet', 'kanban');
const kanbanStore = new KanbanStore(join(KANBAN_HOME, 'kanban.db'));
const kanbanMcp = new KanbanMcpServer(kanbanStore);
const kanbanMcpPort = await kanbanMcp.start(0);

const kanbanDispatcher = new KanbanDispatcher(kanbanStore, {
  now: Date.now,
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  prepareWorkspaceFn: (task) =>
    prepareWorkspace({
      kind: task.workspaceKind,
      taskId: task.id,
      workspacesRoot: join(KANBAN_HOME, 'workspaces'),
      path: task.workspacePath ?? undefined
    }),
  spawnWorker: ({ task, runId, lock, workspace }) => {
    const runToken = randomUUID();
    kanbanMcp.registerRun(runToken, { taskId: task.id, runId, role: 'worker' }, lock);
    return spawnRuneWorker({
      task: {
        id: task.id,
        title: task.title,
        body: task.body,
        assignee: task.assignee,
        modelOverride: task.modelOverride
      },
      workspace,
      mcpPort: kanbanMcpPort,
      runToken,
      logPath: join(KANBAN_HOME, 'logs', `${runToken}.log`)
    });
  },
  config: { failureLimit: 2, claimGraceMs: 30_000, maxInProgress: 3, claimTtlMs: 15 * 60 * 1000 },
  intervalMs: 5000
});
kanbanDispatcher.start();
```

Find the app quit/cleanup handler (search for `app.on('before-quit'` or the existing teardown block) and add:

```ts
kanbanDispatcher.stop();
await kanbanMcp.stop();
kanbanStore.close();
```

- [ ] **Step 6: Typecheck the whole node project**

Run: `npm run typecheck:node`
Expected: no errors. (If `index.ts` reports an unused var or a duplicate import, remove the duplicate — only the kanban additions should change.)

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: all kanban tests pass; no pre-existing tests broken.

- [ ] **Step 8: Lint**

Run: `npm run lint`
Expected: no new errors in `src/main/kanban/**`.

- [ ] **Step 9: Commit**

```bash
git add src/main/kanban/spawn-worker.ts src/main/__tests__/kanban-spawn-worker.test.ts src/main/index.ts
git commit -m "feat(kanban): real rune worker spawn and main-process wiring"
```

---

## Phase 1 Done — Verification

After Task 13:

- [ ] `npm test` — all green.
- [ ] `npm run typecheck` — clean.
- [ ] `npm run lint` — clean.
- [ ] **Manual smoke (stub, no Rune needed):** add a temporary script or a node REPL that opens `~/.fleet/kanban/kanban.db` via `KanbanStore`, creates a task with `status:'ready'` + an assignee, and confirms the dispatcher (running inside `npm run dev`) moves it to `running` and writes a `spawned` event + a `logs/<token>.log` file. (Rune will error out until rune#10/#11 land — that's expected; the dispatcher/claim/run plumbing is what's under test here.)
- [ ] **Live (after rune#10 + rune#11):** with a real `rune` on PATH and a configured provider, the worker connects to the kanban MCP, calls `kanban_complete`, and the task flips to `done` with a result. Track as a follow-up once those issues close.

## Notes for later phases (not in scope here)

- **Phase 2 (Board UI):** the renderer subscribes to `task_events`; expose a `kanban.onEvent` IPC by having `KanbanStore` extend `EventEmitter` and emit on every `appendEvent`, relayed through the main `EventBus`. Add a `kanban` tab type then.
- **Phase 3:** worker-profile registry → materialize `~/.rune/profiles/*.md`; needs rune#12. Until then `--profile` is passed but Rune ignores unknown flags only if rune#12 lands — guard by making the dispatcher omit `--profile` when no profile registry exists.
- **Phase 5:** `prepareWorkspace` gains `worktree` (via `WorktreeService`) and `dir` validation; the MCP server gains the orchestrator role tools (`list/create/link/unblock`) gated on `scope.role === 'orchestrator'`.
```
