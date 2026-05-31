# Kanban Phase 6 — Scheduled Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users schedule kanban tasks to run once at a future time or on a recurring cadence (interval or cron), reusing the `tasks` table via a new `scheduled` status plus six additive columns.

**Architecture:** A pure, Electron-free `schedule.ts` helper computes next-fire times and validates schedules. The store gains schedule CRUD + a `dueSchedules` query. The dispatcher gains a synchronous `fireSchedules()` step (one-shot → `ready` in place; recurring → spawn a fresh instance task, skip-missed realign past a grace window). Commands/IPC/preload expose set/clear/pause/resume + a next-fire preview. The renderer adds a "Scheduled" lane and a Schedule section in the task drawer.

**Tech Stack:** TypeScript, better-sqlite3 (synchronous, WAL), `cron-parser` v5 (`CronExpressionParser`), Electron IPC, React + zustand, vitest.

**Spec:** `docs/superpowers/specs/2026-05-31-kanban-phase6-scheduled-tasks-design.md`

---

## File Structure

**Created:**
- `src/main/kanban/schedule.ts` — pure schedule helper (`ScheduleInput` re-export, `validateSchedule`, `computeNextRun`, `taskToScheduleInput`). No better-sqlite3 / Electron imports.
- `src/main/__tests__/kanban-schedule.test.ts` — unit tests for the helper.
- `src/renderer/src/components/kanban/__tests__/kanban-utils.test.ts` — unit tests for the new pure renderer helpers.

**Modified:**
- `src/shared/kanban-types.ts` — `scheduled` status, six `Task` schedule fields, `ScheduleInput` union, `CreateTaskInput.scheduledFrom`.
- `src/main/kanban/schema.ts` — `SCHEMA_VERSION` 5→6, six columns on `tasks`.
- `src/main/kanban/kanban-store.ts` — `rowToTask` mapping, `createTask` writes `scheduled_from`, eight schedule methods.
- `src/main/kanban/kanban-dispatcher.ts` — `fireSchedules()`, `graceMs()`, new tick order.
- `src/main/kanban/kanban-commands.ts` — five schedule commands.
- `src/shared/ipc-channels.ts` — five channels.
- `src/shared/ipc-api.ts` — request/response types.
- `src/main/kanban/kanban-ipc.ts` — five handlers.
- `src/preload/index.ts` — five `kanban` methods.
- `src/renderer/src/store/kanban-store.ts` — four schedule actions.
- `src/renderer/src/components/kanban/kanban-utils.ts` — `scheduled` column + summary/format helpers.
- `src/renderer/src/components/kanban/KanbanDrawer.tsx` — Schedule section.
- `src/renderer/src/components/kanban/KanbanCard.tsx` — schedule summary + paused badge.

**Verification commands (this repo):**
- Single test file: `npx vitest run src/main/__tests__/<file>.test.ts`
- All kanban tests: `npx vitest run src/main/__tests__`
- Typecheck: `npm run typecheck`
- Lint: `npm run lint`

---

### Task 1: Add the `cron-parser` dependency

**Files:**
- Modify: `package.json` (via npm)

- [ ] **Step 1: Install cron-parser**

Run: `npm install cron-parser`
Expected: `package.json` `dependencies` gains a `cron-parser` entry (v5.x), `package-lock.json` updated.

- [ ] **Step 2: Verify the v5 named-export API resolves**

Run: `node -e "const { CronExpressionParser } = require('cron-parser'); console.log(typeof CronExpressionParser.parse)"`
Expected: prints `function`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(kanban): add cron-parser dependency for scheduled tasks"
```

---

### Task 2: Shared types — `scheduled` status, `Task` schedule fields, `ScheduleInput`, `CreateTaskInput.scheduledFrom`

**Files:**
- Modify: `src/shared/kanban-types.ts`

These types are referenced by every later task; do them first so the rest typechecks.

- [ ] **Step 1: Add `scheduled` to the `TaskStatus` union**

In `src/shared/kanban-types.ts`, change the `TaskStatus` union (currently lines 1-8) to include `scheduled`:

```ts
export type TaskStatus =
  | 'triage'
  | 'scheduled'
  | 'todo'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'done'
  | 'archived';
```

- [ ] **Step 2: Add the `ScheduleInput` union (after `PendingMode`, around line 16)**

Insert below the `PendingMode` type:

```ts
/** A schedule the user attaches to a task. Discriminated by `kind`. */
export type ScheduleInput =
  | { kind: 'once'; at: number } // epoch ms
  | { kind: 'interval'; everyMs: number } // > 0
  | { kind: 'cron'; expr: string }; // a valid cron expression
```

- [ ] **Step 3: Add the six schedule fields to the `Task` interface**

In the `Task` interface, immediately after `maxRetries: number;` (currently line 53) add:

```ts
  scheduleKind: 'once' | 'interval' | 'cron' | null;
  scheduleCron: string | null;
  scheduleIntervalMs: number | null;
  nextRunAt: number | null;
  schedulePaused: boolean;
  scheduledFrom: string | null;
```

- [ ] **Step 4: Add `scheduledFrom` to `CreateTaskInput`**

In `CreateTaskInput`, after `maxRetries?: number;` add:

```ts
  scheduledFrom?: string | null;
```

- [ ] **Step 5: Typecheck (expect store/schema errors, not type-definition errors)**

Run: `npm run typecheck:node`
Expected: Errors only from `kanban-store.ts` (`rowToTask` missing the six new fields) — that is fixed in Task 4. No errors inside `kanban-types.ts` itself.

- [ ] **Step 6: Commit**

```bash
git add src/shared/kanban-types.ts
git commit -m "feat(kanban): add scheduled status and schedule types"
```

---

### Task 3: Pure schedule helper (`schedule.ts`)

**Files:**
- Create: `src/main/kanban/schedule.ts`
- Test: `src/main/__tests__/kanban-schedule.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/__tests__/kanban-schedule.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { CronExpressionParser } from 'cron-parser';
import {
  computeNextRun,
  validateSchedule,
  taskToScheduleInput
} from '../kanban/schedule';
import type { Task } from '../../shared/kanban-types';

describe('computeNextRun', () => {
  it('returns the fire time as-is for once', () => {
    expect(computeNextRun({ kind: 'once', at: 12345 }, 0)).toBe(12345);
  });

  it('returns after + everyMs for interval', () => {
    expect(computeNextRun({ kind: 'interval', everyMs: 1000 }, 5000)).toBe(6000);
  });

  it('schedules one period out even after a long gap (skip-missed)', () => {
    expect(computeNextRun({ kind: 'interval', everyMs: 1000 }, 999_000)).toBe(1_000_000);
  });

  it('matches cron-parser next() for cron, strictly after `after`', () => {
    const after = Date.parse('2026-01-01T00:00:00Z');
    const expected = CronExpressionParser.parse('0 0 * * *', { currentDate: new Date(after) })
      .next()
      .toDate()
      .getTime();
    const got = computeNextRun({ kind: 'cron', expr: '0 0 * * *' }, after);
    expect(got).toBe(expected);
    expect(got).toBeGreaterThan(after);
  });
});

describe('validateSchedule', () => {
  it('rejects a non-positive interval', () => {
    expect(validateSchedule({ kind: 'interval', everyMs: 0 }).ok).toBe(false);
  });
  it('accepts a positive interval', () => {
    expect(validateSchedule({ kind: 'interval', everyMs: 1000 }).ok).toBe(true);
  });
  it('rejects an invalid cron expression', () => {
    expect(validateSchedule({ kind: 'cron', expr: 'not a cron' }).ok).toBe(false);
  });
  it('accepts a valid cron expression', () => {
    expect(validateSchedule({ kind: 'cron', expr: '0 9 * * 1-5' }).ok).toBe(true);
  });
});

describe('taskToScheduleInput', () => {
  const base = { scheduleCron: null, scheduleIntervalMs: null, nextRunAt: null } as Partial<Task>;
  it('maps an interval task', () => {
    const t = { ...base, scheduleKind: 'interval', scheduleIntervalMs: 2000 } as Task;
    expect(taskToScheduleInput(t)).toEqual({ kind: 'interval', everyMs: 2000 });
  });
  it('maps a cron task', () => {
    const t = { ...base, scheduleKind: 'cron', scheduleCron: '0 0 * * *' } as Task;
    expect(taskToScheduleInput(t)).toEqual({ kind: 'cron', expr: '0 0 * * *' });
  });
  it('returns null for an unscheduled task', () => {
    const t = { ...base, scheduleKind: null } as Task;
    expect(taskToScheduleInput(t)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-schedule.test.ts`
Expected: FAIL — `Cannot find module '../kanban/schedule'`.

- [ ] **Step 3: Implement the helper**

Create `src/main/kanban/schedule.ts`:

```ts
import { CronExpressionParser } from 'cron-parser';
import type { Task, ScheduleInput } from '../../shared/kanban-types';

export type { ScheduleInput };

/** Validates a schedule input. Rejects non-positive intervals and invalid cron. */
export function validateSchedule(
  input: ScheduleInput
): { ok: true } | { ok: false; error: string } {
  if (input.kind === 'once') {
    if (!Number.isFinite(input.at)) return { ok: false, error: 'invalid date' };
    return { ok: true };
  }
  if (input.kind === 'interval') {
    if (!Number.isFinite(input.everyMs) || input.everyMs <= 0) {
      return { ok: false, error: 'interval must be greater than zero' };
    }
    return { ok: true };
  }
  try {
    CronExpressionParser.parse(input.expr);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'invalid cron expression' };
  }
}

/**
 * Next fire strictly after `after` (epoch ms).
 * - once: the fixed fire time.
 * - interval: `after + everyMs` (always one period out — naturally skip-missed).
 * - cron: cron-parser's next() seeded at `after`.
 */
export function computeNextRun(input: ScheduleInput, after: number): number {
  if (input.kind === 'once') return input.at;
  if (input.kind === 'interval') return after + input.everyMs;
  const interval = CronExpressionParser.parse(input.expr, { currentDate: new Date(after) });
  return interval.next().toDate().getTime();
}

/** Reconstructs a recurring ScheduleInput from a task's columns (null if not recurring). */
export function taskToScheduleInput(task: Task): ScheduleInput | null {
  switch (task.scheduleKind) {
    case 'once':
      return task.nextRunAt != null ? { kind: 'once', at: task.nextRunAt } : null;
    case 'interval':
      return task.scheduleIntervalMs != null
        ? { kind: 'interval', everyMs: task.scheduleIntervalMs }
        : null;
    case 'cron':
      return task.scheduleCron != null ? { kind: 'cron', expr: task.scheduleCron } : null;
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/__tests__/kanban-schedule.test.ts`
Expected: PASS (all assertions green).

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/schedule.ts src/main/__tests__/kanban-schedule.test.ts
git commit -m "feat(kanban): add pure schedule helper (computeNextRun, validateSchedule)"
```

---

### Task 4: Schema v6 + `rowToTask` mapping + `createTask` writes `scheduled_from`

**Files:**
- Modify: `src/main/kanban/schema.ts`
- Modify: `src/main/kanban/kanban-store.ts:88-119` (`rowToTask`), `:121-157` (`createTask`), `:40-70` (`migrate`)
- Test: `src/main/__tests__/kanban-store.test.ts`

- [ ] **Step 1: Write the failing migration test**

Append to `src/main/__tests__/kanban-store.test.ts` (inside the existing top-level `describe`, or add a new `describe('KanbanStore migration', …)` block). Use the existing file's imports; it already imports `KanbanStore`, `Database` is added here:

```ts
import Database from 'better-sqlite3';

describe('KanbanStore schema v6 migration', () => {
  it('migrates a v5 database to v6 with schedule columns and intact rows', () => {
    const dbPath = join(TEST_DIR, `mig-v6-${Math.random()}.db`);
    const raw = new Database(dbPath);
    raw.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
      assignee TEXT, status TEXT NOT NULL DEFAULT 'todo', priority INTEGER NOT NULL DEFAULT 0,
      tenant TEXT, workspace_kind TEXT NOT NULL DEFAULT 'scratch', workspace_path TEXT,
      repo_path TEXT, branch_name TEXT, model_override TEXT, skills TEXT NOT NULL DEFAULT '[]',
      board_id TEXT NOT NULL DEFAULT 'default', idempotency_key TEXT, result TEXT, pending_mode TEXT,
      claim_lock TEXT, claim_expires INTEGER, worker_pid INTEGER, current_run_id INTEGER,
      last_heartbeat_at INTEGER, consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_failure_error TEXT, max_runtime_seconds INTEGER, max_retries INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );`);
    raw
      .prepare(`INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?, ?, 'todo', ?, ?)`)
      .run('legacy1', 'old task', 1, 1);
    raw.pragma('user_version = 5');
    raw.close();

    const store = new KanbanStore(dbPath, { now: () => 1000 });
    expect(store.schemaVersion()).toBe(6);
    const t = store.getTask('legacy1');
    expect(t?.title).toBe('old task');
    expect(t?.scheduleKind).toBeNull();
    expect(t?.schedulePaused).toBe(false);
    expect(t?.nextRunAt).toBeNull();
    store.close();
  });
});
```

> If `TEST_DIR` / `join` / `KanbanStore` are not already imported in this file, mirror the imports already present at the top of `kanban-store.test.ts` (it creates DBs under a tmp dir). Add only the `Database` import if missing.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts -t "migrates a v5 database"`
Expected: FAIL — `schemaVersion()` returns 5 (or the schedule columns are absent / `scheduleKind` is `undefined`).

- [ ] **Step 3: Bump the schema version and add the columns to `SCHEMA_SQL`**

In `src/main/kanban/schema.ts`, change line 1:

```ts
export const SCHEMA_VERSION = 6;
```

In the `tasks` CREATE block, insert the six columns immediately after `  max_retries INTEGER NOT NULL DEFAULT 1,` (currently line 30) and before `  created_at INTEGER NOT NULL,`:

```sql
  schedule_kind TEXT,
  schedule_cron TEXT,
  schedule_interval_ms INTEGER,
  next_run_at INTEGER,
  schedule_paused INTEGER NOT NULL DEFAULT 0,
  scheduled_from TEXT,
```

- [ ] **Step 4: Add the version-gated migration block**

In `src/main/kanban/kanban-store.ts`, inside `migrate()`, after the `if (current < 5) { … }` block (ends line 58) and before the default-board seed (line 59), add:

```ts
    if (current < 6) {
      // Additive: DBs created before v6 lack the scheduling columns.
      this.addColumnIfMissing('tasks', 'schedule_kind', 'TEXT');
      this.addColumnIfMissing('tasks', 'schedule_cron', 'TEXT');
      this.addColumnIfMissing('tasks', 'schedule_interval_ms', 'INTEGER');
      this.addColumnIfMissing('tasks', 'next_run_at', 'INTEGER');
      this.addColumnIfMissing('tasks', 'schedule_paused', 'INTEGER NOT NULL DEFAULT 0');
      this.addColumnIfMissing('tasks', 'scheduled_from', 'TEXT');
    }
```

- [ ] **Step 5: Map the new columns in `rowToTask`**

In `rowToTask` (currently ends at line 117 with `updatedAt`), add the six fields after `maxRetries: Number(r.max_retries),`:

```ts
      scheduleKind: (r.schedule_kind as Task['scheduleKind']) ?? null,
      scheduleCron: (r.schedule_cron as string | null) ?? null,
      scheduleIntervalMs: (r.schedule_interval_ms as number | null) ?? null,
      nextRunAt: (r.next_run_at as number | null) ?? null,
      schedulePaused: Number(r.schedule_paused ?? 0) === 1,
      scheduledFrom: (r.scheduled_from as string | null) ?? null,
```

- [ ] **Step 6: Persist `scheduled_from` in `createTask`**

In `createTask`, update the INSERT to include `scheduled_from`. Change the column list (currently line 126-128) so `idempotency_key,` is followed by `scheduled_from,`:

```ts
        `INSERT INTO tasks (id, title, body, assignee, status, priority, tenant,
          workspace_kind, workspace_path, repo_path, branch_name, model_override, skills, board_id, idempotency_key,
          scheduled_from, max_runtime_seconds, max_retries, created_at, updated_at)
         VALUES (@id, @title, @body, @assignee, @status, @priority, @tenant,
          @workspace_kind, @workspace_path, @repo_path, @branch_name, @model_override, @skills, @board_id, @idempotency_key,
          @scheduled_from, @max_runtime_seconds, @max_retries, @created_at, @updated_at)`
```

And in the `.run({ … })` object, add after `idempotency_key: input.idempotencyKey ?? null,`:

```ts
        scheduled_from: input.scheduledFrom ?? null,
```

- [ ] **Step 7: Run the migration test to verify it passes**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts -t "migrates a v5 database"`
Expected: PASS.

- [ ] **Step 8: Run the full store + typecheck to confirm no regressions**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts && npm run typecheck:node`
Expected: All store tests PASS; typecheck clean (the Task 2 `rowToTask` error is now resolved).

- [ ] **Step 9: Commit**

```bash
git add src/main/kanban/schema.ts src/main/kanban/kanban-store.ts src/main/__tests__/kanban-store.test.ts
git commit -m "feat(kanban): schema v6 with additive scheduling columns"
```

---

### Task 5: Store schedule methods

**Files:**
- Modify: `src/main/kanban/kanban-store.ts` (add methods; add imports)
- Test: `src/main/__tests__/kanban-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Append a new `describe` to `src/main/__tests__/kanban-store.test.ts`:

```ts
describe('KanbanStore scheduling', () => {
  it('setSchedule (interval) sets columns, next_run_at, and scheduled status', () => {
    const store = new KanbanStore(join(TEST_DIR, `sch-${Math.random()}.db`), { now: () => 10_000 });
    const t = store.createTask({ title: 'rec', assignee: 'r' });
    store.setSchedule(t.id, { kind: 'interval', everyMs: 5000 });
    const got = store.getTask(t.id)!;
    expect(got.status).toBe('scheduled');
    expect(got.scheduleKind).toBe('interval');
    expect(got.scheduleIntervalMs).toBe(5000);
    expect(got.nextRunAt).toBe(15_000); // now + everyMs
    expect(got.schedulePaused).toBe(false);
    store.close();
  });

  it('setSchedule (once) sets next_run_at to the fixed time', () => {
    const store = new KanbanStore(join(TEST_DIR, `sch-${Math.random()}.db`), { now: () => 10_000 });
    const t = store.createTask({ title: 'one', assignee: 'r' });
    store.setSchedule(t.id, { kind: 'once', at: 99_000 });
    const got = store.getTask(t.id)!;
    expect(got.status).toBe('scheduled');
    expect(got.scheduleKind).toBe('once');
    expect(got.nextRunAt).toBe(99_000);
    store.close();
  });

  it('clearSchedule returns the task to todo and nulls schedule columns', () => {
    const store = new KanbanStore(join(TEST_DIR, `sch-${Math.random()}.db`), { now: () => 10_000 });
    const t = store.createTask({ title: 'rec', assignee: 'r' });
    store.setSchedule(t.id, { kind: 'interval', everyMs: 5000 });
    store.clearSchedule(t.id);
    const got = store.getTask(t.id)!;
    expect(got.status).toBe('todo');
    expect(got.scheduleKind).toBeNull();
    expect(got.nextRunAt).toBeNull();
    store.close();
  });

  it('pause/resume toggles schedule_paused', () => {
    const store = new KanbanStore(join(TEST_DIR, `sch-${Math.random()}.db`), { now: () => 10_000 });
    const t = store.createTask({ title: 'rec', assignee: 'r' });
    store.setSchedule(t.id, { kind: 'interval', everyMs: 5000 });
    store.pauseSchedule(t.id);
    expect(store.getTask(t.id)!.schedulePaused).toBe(true);
    store.resumeSchedule(t.id);
    expect(store.getTask(t.id)!.schedulePaused).toBe(false);
    store.close();
  });

  it('dueSchedules returns only unpaused scheduled rows due at/before now', () => {
    const store = new KanbanStore(join(TEST_DIR, `sch-${Math.random()}.db`), { now: () => 10_000 });
    const due = store.createTask({ title: 'due', assignee: 'r' });
    const future = store.createTask({ title: 'future', assignee: 'r' });
    const paused = store.createTask({ title: 'paused', assignee: 'r' });
    store.setSchedule(due.id, { kind: 'once', at: 9_000 }); // <= now
    store.setSchedule(future.id, { kind: 'once', at: 11_000 }); // > now
    store.setSchedule(paused.id, { kind: 'once', at: 9_000 });
    store.pauseSchedule(paused.id);
    const ids = store.dueSchedules(10_000).map((t) => t.id);
    expect(ids).toEqual([due.id]);
    store.close();
  });

  it('fireOnce moves a scheduled task to ready and clears schedule columns', () => {
    const store = new KanbanStore(join(TEST_DIR, `sch-${Math.random()}.db`), { now: () => 10_000 });
    const t = store.createTask({ title: 'one', assignee: 'r' });
    store.setSchedule(t.id, { kind: 'once', at: 9_000 });
    store.fireOnce(t.id);
    const got = store.getTask(t.id)!;
    expect(got.status).toBe('ready');
    expect(got.scheduleKind).toBeNull();
    store.close();
  });

  it('advanceNextRun updates next_run_at without changing status', () => {
    const store = new KanbanStore(join(TEST_DIR, `sch-${Math.random()}.db`), { now: () => 10_000 });
    const t = store.createTask({ title: 'rec', assignee: 'r' });
    store.setSchedule(t.id, { kind: 'interval', everyMs: 5000 });
    store.advanceNextRun(t.id, 42_000);
    const got = store.getTask(t.id)!;
    expect(got.nextRunAt).toBe(42_000);
    expect(got.status).toBe('scheduled');
    store.close();
  });

  it('spawnScheduledInstance copies fields, inherits board, sets scheduled_from + todo', () => {
    const store = new KanbanStore(join(TEST_DIR, `sch-${Math.random()}.db`), { now: () => 10_000 });
    const board = store.createBoard('Ops');
    const tmpl = store.createTask({
      title: 'nightly',
      body: 'do it',
      assignee: 'r',
      priority: 3,
      tenant: 'acme',
      boardId: board.slug,
      skills: ['a'],
      maxRetries: 2
    });
    store.setSchedule(tmpl.id, { kind: 'interval', everyMs: 5000 });
    const inst = store.spawnScheduledInstance(store.getTask(tmpl.id)!);
    expect(inst.id).not.toBe(tmpl.id);
    expect(inst.status).toBe('todo');
    expect(inst.title).toBe('nightly');
    expect(inst.body).toBe('do it');
    expect(inst.assignee).toBe('r');
    expect(inst.priority).toBe(3);
    expect(inst.tenant).toBe('acme');
    expect(inst.boardId).toBe(board.slug);
    expect(inst.skills).toEqual(['a']);
    expect(inst.maxRetries).toBe(2);
    expect(inst.scheduledFrom).toBe(tmpl.id);
    expect(inst.scheduleKind).toBeNull();
    store.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts -t "KanbanStore scheduling"`
Expected: FAIL — `store.setSchedule is not a function` (and siblings).

- [ ] **Step 3: Add imports for the helper at the top of `kanban-store.ts`**

After the existing `import type { … } from '../../shared/kanban-types';` (line 7) add:

```ts
import { validateSchedule, computeNextRun } from './schedule';
import type { ScheduleInput } from '../../shared/kanban-types';
```

> `ScheduleInput` may instead be added to the existing `import type { … }` list from `'../../shared/kanban-types'` to avoid a second import line; either is fine.

- [ ] **Step 4: Implement the eight methods**

Add these methods to the `KanbanStore` class (place them after `setStatusCleared`, before the closing brace at line 759):

```ts
  /** Attach (or replace) a schedule on a task; moves it to the scheduled lane. */
  setSchedule(taskId: string, input: ScheduleInput): void {
    const v = validateSchedule(input);
    if (!v.ok) throw new Error(v.error); // commands validate first; this is defense-in-depth
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
      .all(now) as Record<string, unknown>[];
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
          schedule_interval_ms=NULL, next_run_at=NULL, updated_at=@ts
         WHERE id=@id`
      )
      .run({ id: taskId, ts });
  }

  /** Recurring fire: create a fresh todo instance copying the template's work fields. */
  spawnScheduledInstance(template: Task): Task {
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
      boardId: template.boardId,
      maxRuntimeSeconds: template.maxRuntimeSeconds,
      maxRetries: template.maxRetries,
      status: 'todo',
      scheduledFrom: template.id
    });
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts -t "KanbanStore scheduling"`
Expected: PASS (all 8).

- [ ] **Step 6: Commit**

```bash
git add src/main/kanban/kanban-store.ts src/main/__tests__/kanban-store.test.ts
git commit -m "feat(kanban): store schedule CRUD, dueSchedules, instance spawning"
```

---

### Task 6: Dispatcher `fireSchedules()` + new tick order

**Files:**
- Modify: `src/main/kanban/kanban-dispatcher.ts`
- Test: `src/main/__tests__/kanban-dispatcher.test.ts`

- [ ] **Step 1: Write the failing tests**

Append a `describe` to `src/main/__tests__/kanban-dispatcher.test.ts`. Reuse the file's existing `makeStore(clock)` helper and the dispatcher-config shape used elsewhere in the file:

```ts
describe('KanbanDispatcher.fireSchedules', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  function makeDisp(store: KanbanStore, clock: { t: number }, spawned: number[]): KanbanDispatcher {
    return new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => {
        spawned.push(1);
        return 123;
      },
      config: {
        failureLimit: 2,
        claimGraceMs: 0,
        maxInProgress: 3,
        claimTtlMs: 1000,
        autoDecompose: false,
        maxDecompose: 1
      },
      intervalMs: 5000 // GRACE_MS = max(2*5000, 60000) = 60000
    });
  }

  it('fires a due one-shot in place (scheduled -> ready)', () => {
    const clock = { t: 1_000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'one', assignee: 'r' });
    store.setSchedule(t.id, { kind: 'once', at: 1_000 });
    const disp = makeDisp(store, clock, []);
    disp.fireSchedules();
    expect(store.getTask(t.id)?.status).toBe('ready');
    store.close();
  });

  it('fires a due recurring template within grace: spawns an instance and advances next_run_at', () => {
    const clock = { t: 1_000_000 };
    const store = makeStore(clock);
    const tmpl = store.createTask({ title: 'rec', assignee: 'r' });
    store.setSchedule(tmpl.id, { kind: 'interval', everyMs: 50_000 }); // next_run_at = 1_050_000
    clock.t = 1_050_001; // 1ms past due — well within 60s grace
    const disp = makeDisp(store, clock, []);
    disp.fireSchedules();
    const instances = store
      .listTasks({ status: 'todo' })
      .filter((x) => x.scheduledFrom === tmpl.id);
    expect(instances.length).toBe(1);
    const after = store.getTask(tmpl.id)!;
    expect(after.status).toBe('scheduled');
    expect(after.nextRunAt).toBe(1_050_001 + 50_000); // computeNextRun(interval, now)
    store.close();
  });

  it('realigns a missed recurring template (> grace) without spawning', () => {
    const clock = { t: 1_000_000 };
    const store = makeStore(clock);
    const tmpl = store.createTask({ title: 'rec', assignee: 'r' });
    store.setSchedule(tmpl.id, { kind: 'interval', everyMs: 50_000 }); // next_run_at = 1_050_000
    clock.t = 1_050_000 + 70_000; // 70s late > 60s grace
    const disp = makeDisp(store, clock, []);
    disp.fireSchedules();
    const instances = store
      .listTasks({ status: 'todo' })
      .filter((x) => x.scheduledFrom === tmpl.id);
    expect(instances.length).toBe(0);
    expect(store.getTask(tmpl.id)!.nextRunAt).toBe(clock.t + 50_000);
    store.close();
  });

  it('does not fire a paused recurring template', () => {
    const clock = { t: 1_000_000 };
    const store = makeStore(clock);
    const tmpl = store.createTask({ title: 'rec', assignee: 'r' });
    store.setSchedule(tmpl.id, { kind: 'interval', everyMs: 50_000 });
    store.pauseSchedule(tmpl.id);
    clock.t = 1_050_001;
    const spawned: number[] = [];
    const disp = makeDisp(store, clock, spawned);
    disp.fireSchedules();
    expect(store.listTasks({ status: 'todo' }).filter((x) => x.scheduledFrom === tmpl.id).length).toBe(0);
    expect(store.getTask(tmpl.id)!.status).toBe('scheduled');
    store.close();
  });
});
```

> If `KanbanStore` is not already imported in this test file, it is (line 5). `beforeEach`/`afterEach`/`mkdirSync`/`rmSync`/`TEST_DIR` are all already present at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts -t "fireSchedules"`
Expected: FAIL — `disp.fireSchedules is not a function`.

- [ ] **Step 3: Add the import and implement `fireSchedules()` + `graceMs()`**

In `src/main/kanban/kanban-dispatcher.ts`, after the existing imports (line 3) add:

```ts
import { computeNextRun, taskToScheduleInput } from './schedule';
```

Add these two methods to the `KanbanDispatcher` class (place `fireSchedules` after `promote()` which ends line 80; place `graceMs` as a private helper just above it):

```ts
  private graceMs(): number {
    return Math.max(2 * (this.deps.intervalMs ?? DEFAULT_INTERVAL_MS), 60_000);
  }

  /** Fire due schedules: one-shots run in place; recurring templates spawn instances
   *  (or realign past the grace window). Synchronous — preserves the atomic-tick invariant. */
  fireSchedules(): void {
    const now = this.deps.now();
    const grace = this.graceMs();
    for (const t of this.store.dueSchedules(now)) {
      if (t.scheduleKind === 'once') {
        this.store.fireOnce(t.id);
        this.store.appendEvent(t.id, null, 'schedule_fired', { kind: 'once' });
        continue;
      }
      const input = taskToScheduleInput(t);
      if (!input) continue; // defensive: scheduled row with no usable recurrence
      const next = computeNextRun(input, now);
      if (t.nextRunAt != null && now - t.nextRunAt > grace) {
        this.store.advanceNextRun(t.id, next);
        this.store.appendEvent(t.id, null, 'schedule_realigned', { nextRunAt: next });
      } else {
        const instance = this.store.spawnScheduledInstance(t);
        this.store.advanceNextRun(t.id, next);
        this.store.appendEvent(t.id, null, 'schedule_fired', {
          kind: t.scheduleKind,
          instanceId: instance.id
        });
      }
    }
  }
```

- [ ] **Step 4: Insert `fireSchedules` into the tick order**

Change `tick()` (currently lines 162-167) to:

```ts
  tick(): void {
    this.reclaim();
    this.fireSchedules();
    this.decompose();
    this.promote();
    this.claimAndSpawn();
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts`
Expected: All dispatcher tests PASS (existing + the four new ones).

- [ ] **Step 6: Commit**

```bash
git add src/main/kanban/kanban-dispatcher.ts src/main/__tests__/kanban-dispatcher.test.ts
git commit -m "feat(kanban): dispatcher fires schedules (one-shot in place, recurring spawns)"
```

---

### Task 7: Commands — set/clear/pause/resume + preview

**Files:**
- Modify: `src/main/kanban/kanban-commands.ts`
- Test: `src/main/__tests__/kanban-commands.test.ts`

- [ ] **Step 1: Write the failing tests**

Append a `describe` to `src/main/__tests__/kanban-commands.test.ts` (reuse the file's existing harness for constructing `KanbanCommands` — mirror how other command tests build `store`/`dispatcher`/`commands`; the helper there is typically named `makeCommands()` or builds them inline):

```ts
describe('KanbanCommands scheduling', () => {
  it('setSchedule rejects an invalid cron with BAD_REQUEST', () => {
    const { commands } = makeCommands();
    const t = commands.create({ title: 'x' });
    expect(() => commands.setSchedule(t.id, { kind: 'cron', expr: 'nope' })).toThrowError(
      /cron|invalid/i
    );
  });

  it('setSchedule rejects a non-positive interval with BAD_REQUEST', () => {
    const { commands } = makeCommands();
    const t = commands.create({ title: 'x' });
    let code: string | undefined;
    try {
      commands.setSchedule(t.id, { kind: 'interval', everyMs: 0 });
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('BAD_REQUEST');
  });

  it('setSchedule with a valid interval round-trips and logs an event', () => {
    const { commands, store } = makeCommands();
    const t = commands.create({ title: 'x', assignee: 'r' });
    commands.setSchedule(t.id, { kind: 'interval', everyMs: 5000 });
    expect(store.getTask(t.id)!.status).toBe('scheduled');
    expect(store.listEvents(t.id).some((e) => e.kind === 'schedule_set')).toBe(true);
  });

  it('pauseSchedule rejects a one-shot schedule', () => {
    const { commands } = makeCommands();
    const t = commands.create({ title: 'x' });
    commands.setSchedule(t.id, { kind: 'once', at: 99_000 });
    expect(() => commands.pauseSchedule(t.id)).toThrowError(/recurring/i);
  });

  it('previewSchedule returns next fire times for a valid schedule', () => {
    const { commands } = makeCommands();
    const res = commands.previewSchedule({ kind: 'interval', everyMs: 1000 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.next.length).toBe(3);
  });

  it('previewSchedule returns an error for an invalid cron', () => {
    const { commands } = makeCommands();
    const res = commands.previewSchedule({ kind: 'cron', expr: 'nope' });
    expect(res.ok).toBe(false);
  });
});
```

> Adapt `makeCommands()` to the file's actual helper. If the existing tests construct `commands` differently (e.g. a `beforeEach` assigning a module-scoped `commands`/`store`), follow that same pattern instead of destructuring. The assertions on behavior are what matter.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-commands.test.ts -t "scheduling"`
Expected: FAIL — `commands.setSchedule is not a function`.

- [ ] **Step 3: Add imports to `kanban-commands.ts`**

After the existing imports, add:

```ts
import { validateSchedule, computeNextRun } from './schedule';
import type { ScheduleInput } from '../../shared/kanban-types';
```

> `ScheduleInput` may instead be appended to the existing `import type { … } from '../../shared/kanban-types';` block (lines 4-17).

- [ ] **Step 4: Implement the five command methods**

Add to the `KanbanCommands` class, after `requestSpecify` / `requestOrchestration` (before `dispatch()` at line 284):

```ts
  setSchedule(id: string, input: ScheduleInput): void {
    this.requireTask(id);
    const v = validateSchedule(input);
    if (!v.ok) throw new CodedError(v.error, 'BAD_REQUEST');
    this.store.setSchedule(id, input);
    this.store.appendEvent(id, null, 'schedule_set', { kind: input.kind });
  }

  clearSchedule(id: string): void {
    this.requireTask(id);
    this.store.clearSchedule(id);
    this.store.appendEvent(id, null, 'schedule_cleared', {});
  }

  pauseSchedule(id: string): void {
    const t = this.requireTask(id);
    if (t.scheduleKind == null || t.scheduleKind === 'once') {
      throw new CodedError('only recurring schedules can be paused', 'BAD_REQUEST');
    }
    this.store.pauseSchedule(id);
    this.store.appendEvent(id, null, 'schedule_paused', {});
  }

  resumeSchedule(id: string): void {
    const t = this.requireTask(id);
    if (t.scheduleKind == null || t.scheduleKind === 'once') {
      throw new CodedError('only recurring schedules can be resumed', 'BAD_REQUEST');
    }
    this.store.resumeSchedule(id);
    this.store.appendEvent(id, null, 'schedule_resumed', {});
  }

  /** Compute the next ~3 fire times for a candidate schedule (drawer live preview). */
  previewSchedule(input: ScheduleInput): { ok: true; next: number[] } | { ok: false; error: string } {
    const v = validateSchedule(input);
    if (!v.ok) return { ok: false, error: v.error };
    const next: number[] = [];
    let after = Date.now();
    for (let i = 0; i < 3; i += 1) {
      const n = computeNextRun(input, after);
      next.push(n);
      after = n;
      if (input.kind === 'once') break; // a one-shot fires exactly once
    }
    return { ok: true, next };
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/main/__tests__/kanban-commands.test.ts -t "scheduling"`
Expected: PASS (all 6).

- [ ] **Step 6: Commit**

```bash
git add src/main/kanban/kanban-commands.ts src/main/__tests__/kanban-commands.test.ts
git commit -m "feat(kanban): schedule commands (set/clear/pause/resume/preview)"
```

---

### Task 8: IPC channels + ipc-api types + handlers + preload

**Files:**
- Modify: `src/shared/ipc-channels.ts:121-142`
- Modify: `src/shared/ipc-api.ts`
- Modify: `src/main/kanban/kanban-ipc.ts`
- Modify: `src/preload/index.ts:427-468`

No new unit test — verified by typecheck + build (this layer is thin plumbing; behavior is covered by Task 7's command tests).

- [ ] **Step 1: Add the five channels**

In `src/shared/ipc-channels.ts`, in the `// Kanban` block, after `KANBAN_BOARDS_CHANGED: 'kanban:boards-changed'` add a comma and:

```ts
  KANBAN_SET_SCHEDULE: 'kanban:set-schedule',
  KANBAN_CLEAR_SCHEDULE: 'kanban:clear-schedule',
  KANBAN_PAUSE_SCHEDULE: 'kanban:pause-schedule',
  KANBAN_RESUME_SCHEDULE: 'kanban:resume-schedule',
  KANBAN_PREVIEW_SCHEDULE: 'kanban:preview-schedule'
```

(Ensure the line before now ends with a comma.)

- [ ] **Step 2: Add the request/response types to `ipc-api.ts`**

In `src/shared/ipc-api.ts`, change the existing kanban-types import (line 3) to also import `ScheduleInput`:

```ts
import type { UpdateTaskFields, TaskStatus, ScheduleInput } from './kanban-types';
```

At the end of the file (after `KanbanRenameBoardRequest`), add:

```ts
export type KanbanSetScheduleRequest = {
  taskId: string;
  input: ScheduleInput;
};

export type KanbanPreviewScheduleResponse =
  | { ok: true; next: number[] }
  | { ok: false; error: string };
```

- [ ] **Step 3: Register the five handlers in `kanban-ipc.ts`**

In `src/main/kanban/kanban-ipc.ts`, extend the type import block (lines 7-14) to add `KanbanSetScheduleRequest`, and add a `ScheduleInput` type import:

```ts
import type {
  KanbanUpdateTaskRequest,
  KanbanSetStatusRequest,
  KanbanAddCommentRequest,
  KanbanLinkRequest,
  KanbanAddAttachmentRequest,
  KanbanRenameBoardRequest,
  KanbanSetScheduleRequest
} from '../../shared/ipc-api';
import type { ScheduleInput } from '../../shared/kanban-types';
```

> `ScheduleInput` can be merged into the existing `import type { CreateTaskInput, TaskDetail, Task } from '../../shared/kanban-types';` line (6) instead of a separate line.

Before the final `log.info(...)` call, add:

```ts
  ipcMain.handle(IPC_CHANNELS.KANBAN_SET_SCHEDULE, (_e, req: KanbanSetScheduleRequest) => {
    // CodedError('BAD_REQUEST') propagates to the renderer's invoke() for inline display.
    commands.setSchedule(req.taskId, req.input);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_CLEAR_SCHEDULE, (_e, taskId: string) => {
    commands.clearSchedule(taskId);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_PAUSE_SCHEDULE, (_e, taskId: string) => {
    commands.pauseSchedule(taskId);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_RESUME_SCHEDULE, (_e, taskId: string) => {
    commands.resumeSchedule(taskId);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_PREVIEW_SCHEDULE, (_e, input: ScheduleInput) => {
    return commands.previewSchedule(input);
  });
```

- [ ] **Step 4: Add the five preload methods**

In `src/preload/index.ts`, the `kanban` block ends at line 467-468 with `onEvent: …`. First ensure the needed types are imported near the top of the file (where `KanbanRenameBoardRequest` etc. are imported from `'../shared/ipc-api'`, and kanban-types from `'../shared/kanban-types'`):

- add `KanbanSetScheduleRequest`, `KanbanPreviewScheduleResponse` to the `ipc-api` import,
- add `ScheduleInput` to the `kanban-types` import.

Then add a comma after the `onEvent` method and insert:

```ts
    setSchedule: async (req: KanbanSetScheduleRequest): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_SET_SCHEDULE, req),
    clearSchedule: async (taskId: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_CLEAR_SCHEDULE, taskId),
    pauseSchedule: async (taskId: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_PAUSE_SCHEDULE, taskId),
    resumeSchedule: async (taskId: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_RESUME_SCHEDULE, taskId),
    previewSchedule: async (input: ScheduleInput): Promise<KanbanPreviewScheduleResponse> =>
      typedInvoke<KanbanPreviewScheduleResponse>(IPC_CHANNELS.KANBAN_PREVIEW_SCHEDULE, input)
```

> Place these inside the `kanban: { … }` object. The existing `onEvent` is the last entry — add a trailing comma to it, then append the five above (the last one, `previewSchedule`, has no trailing comma since it becomes the final entry).

- [ ] **Step 5: Typecheck both projects**

Run: `npm run typecheck`
Expected: Clean (no errors). This confirms `window.fleet.kanban.setSchedule` etc. are now typed for the renderer.

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc-channels.ts src/shared/ipc-api.ts src/main/kanban/kanban-ipc.ts src/preload/index.ts
git commit -m "feat(kanban): IPC + preload for schedule operations"
```

---

### Task 9: Renderer store actions + `kanban-utils` (lane + summary helpers)

**Files:**
- Modify: `src/renderer/src/store/kanban-store.ts`
- Modify: `src/renderer/src/components/kanban/kanban-utils.ts`
- Test: `src/renderer/src/components/kanban/__tests__/kanban-utils.test.ts`

- [ ] **Step 1: Write the failing tests for the pure helpers**

Create `src/renderer/src/components/kanban/__tests__/kanban-utils.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { COLUMNS, DRAG_TARGETS, scheduleSummary, formatInterval } from '../kanban-utils';

describe('kanban-utils schedule helpers', () => {
  it('includes a Scheduled column that is not a drag target', () => {
    expect(COLUMNS.some((c) => c.status === 'scheduled')).toBe(true);
    expect(DRAG_TARGETS).not.toContain('scheduled');
  });

  it('formatInterval renders human units', () => {
    expect(formatInterval(30_000)).toBe('30s');
    expect(formatInterval(120_000)).toBe('2m');
    expect(formatInterval(2 * 3600_000)).toBe('2h');
    expect(formatInterval(48 * 3600_000)).toBe('2d');
  });

  it('scheduleSummary describes each kind', () => {
    expect(scheduleSummary({ scheduleKind: 'cron', scheduleCron: '0 9 * * *', scheduleIntervalMs: null })).toBe(
      '0 9 * * *'
    );
    expect(
      scheduleSummary({ scheduleKind: 'interval', scheduleCron: null, scheduleIntervalMs: 7200_000 })
    ).toBe('every 2h');
    expect(scheduleSummary({ scheduleKind: 'once', scheduleCron: null, scheduleIntervalMs: null })).toBe(
      'once'
    );
    expect(scheduleSummary({ scheduleKind: null, scheduleCron: null, scheduleIntervalMs: null })).toBe(
      ''
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/src/components/kanban/__tests__/kanban-utils.test.ts`
Expected: FAIL — `scheduleSummary`/`formatInterval` are not exported and no `scheduled` column.

- [ ] **Step 3: Add the `scheduled` lane and helpers to `kanban-utils.ts`**

In `src/renderer/src/components/kanban/kanban-utils.ts`, add `Task` to the import (line 1):

```ts
import type { TaskStatus, Task } from '../../../../shared/kanban-types';
```

Change `COLUMNS` to put a Scheduled lane first:

```ts
export const COLUMNS: Array<{ status: TaskStatus; label: string }> = [
  { status: 'scheduled', label: 'Scheduled' },
  { status: 'triage', label: 'Triage' },
  { status: 'todo', label: 'Todo' },
  { status: 'ready', label: 'Ready' },
  { status: 'running', label: 'Running' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'done', label: 'Done' }
];
```

Leave `DRAG_TARGETS` unchanged (scheduling happens via the drawer, not drag-and-drop).

At the end of the file add the pure helpers:

```ts
/** Compact human label for an interval period (input is ms). */
export function formatInterval(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** One-line recurrence summary for a scheduled card. */
export function scheduleSummary(
  task: Pick<Task, 'scheduleKind' | 'scheduleCron' | 'scheduleIntervalMs'>
): string {
  if (task.scheduleKind === 'cron') return task.scheduleCron ?? 'cron';
  if (task.scheduleKind === 'interval') return `every ${formatInterval(task.scheduleIntervalMs ?? 0)}`;
  if (task.scheduleKind === 'once') return 'once';
  return '';
}

/** Localized absolute time for a next-fire timestamp. */
export function formatNextRun(epochMs: number | null): string {
  if (epochMs == null) return '';
  return new Date(epochMs).toLocaleString();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/src/components/kanban/__tests__/kanban-utils.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the four schedule actions to the renderer store**

In `src/renderer/src/store/kanban-store.ts`, add `ScheduleInput` to the type import (lines 2-9):

```ts
import type {
  Board,
  BoardCard,
  TaskDetail,
  CreateTaskInput,
  TaskStatus,
  UpdateTaskFields,
  ScheduleInput
} from '../../../shared/kanban-types';
```

In the `KanbanState` type, after `specify: (id: string) => Promise<void>;` add:

```ts
  setSchedule: (taskId: string, input: ScheduleInput) => Promise<void>;
  clearSchedule: (taskId: string) => Promise<void>;
  pauseSchedule: (taskId: string) => Promise<void>;
  resumeSchedule: (taskId: string) => Promise<void>;
```

In the store implementation, after the `specify` action (ends line 137) add:

```ts
  setSchedule: async (taskId, input) => {
    await window.fleet.kanban.setSchedule({ taskId, input });
    await get().loadBoard();
    await get().refreshDetail();
  },
  clearSchedule: async (taskId) => {
    await window.fleet.kanban.clearSchedule(taskId);
    await get().loadBoard();
    await get().refreshDetail();
  },
  pauseSchedule: async (taskId) => {
    await window.fleet.kanban.pauseSchedule(taskId);
    await get().loadBoard();
    await get().refreshDetail();
  },
  resumeSchedule: async (taskId) => {
    await window.fleet.kanban.resumeSchedule(taskId);
    await get().loadBoard();
    await get().refreshDetail();
  },
```

- [ ] **Step 6: Typecheck the web project**

Run: `npm run typecheck:web`
Expected: Clean.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/store/kanban-store.ts src/renderer/src/components/kanban/kanban-utils.ts src/renderer/src/components/kanban/__tests__/kanban-utils.test.ts
git commit -m "feat(kanban): renderer Scheduled lane + schedule store actions"
```

---

### Task 10: Renderer — Schedule section in the drawer + card summary

**Files:**
- Modify: `src/renderer/src/components/kanban/KanbanCard.tsx`
- Modify: `src/renderer/src/components/kanban/KanbanDrawer.tsx`

No unit test (the repo has no React-component test harness for kanban). Verified by typecheck + build, and the pure logic it relies on is already tested in Task 9.

- [ ] **Step 1: Show the schedule summary + paused badge on scheduled cards**

In `src/renderer/src/components/kanban/KanbanCard.tsx`, change the import (line 1) and add the icons (line 2):

```ts
import type { BoardCard } from '../../../../shared/kanban-types';
import { MessageSquare, GitBranch, Clock, PauseCircle } from 'lucide-react';
import { scheduleSummary, formatNextRun } from './kanban-utils';
```

Inside the metadata row `<div className="mt-1.5 …">` (after the `commentCount` block, before that `div` closes at line 59), add:

```tsx
        {card.status === 'scheduled' && (
          <span className="inline-flex items-center gap-0.5 text-indigo-300" title={formatNextRun(card.nextRunAt)}>
            {card.schedulePaused ? <PauseCircle size={10} /> : <Clock size={10} />}
            {scheduleSummary(card)}
          </span>
        )}
```

- [ ] **Step 2: Add the Schedule section to the drawer**

In `src/renderer/src/components/kanban/KanbanDrawer.tsx`:

(a) Extend the store destructuring (lines 21-34) to pull the new actions:

```ts
  const {
    detail,
    closeTask,
    updateTask,
    setStatus,
    addComment,
    addLink,
    removeLink,
    decompose,
    specify,
    uploadAttachments,
    removeAttachment,
    saveAttachmentCopy,
    setSchedule,
    clearSchedule,
    pauseSchedule,
    resumeSchedule
  } = useKanbanStore();
```

(b) Add `Clock` to the lucide import (line 5) and import the summary helper + type:

```ts
import { X, Paperclip, Download, Clock } from 'lucide-react';
```

```ts
import { relativeTime, formatDuration, formatBytes, scheduleSummary, formatNextRun } from './kanban-utils';
import type { TaskStatus, ScheduleInput } from '../../../../shared/kanban-types';
```

(c) Add local state for the schedule editor, after the existing `useState` declarations (around line 45):

```ts
  const [schedKind, setSchedKind] = useState<'once' | 'interval' | 'cron'>('interval');
  const [schedAt, setSchedAt] = useState(''); // datetime-local string
  const [schedEveryN, setSchedEveryN] = useState(1);
  const [schedUnit, setSchedUnit] = useState<'minutes' | 'hours' | 'days'>('hours');
  const [schedCron, setSchedCron] = useState('0 9 * * *');
  const [schedPreview, setSchedPreview] = useState<number[]>([]);
  const [schedError, setSchedError] = useState<string | null>(null);
```

(d) Add a helper inside the component (after the `save()` function, before `pickAndUpload`) that builds a `ScheduleInput` from the editor state:

```ts
  const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;

  function buildScheduleInput(): ScheduleInput | null {
    if (schedKind === 'once') {
      const ms = Date.parse(schedAt);
      if (Number.isNaN(ms)) return null;
      return { kind: 'once', at: ms };
    }
    if (schedKind === 'interval') {
      return { kind: 'interval', everyMs: Math.max(1, schedEveryN) * UNIT_MS[schedUnit] };
    }
    return { kind: 'cron', expr: schedCron.trim() };
  }

  async function refreshPreview(): Promise<void> {
    const input = buildScheduleInput();
    if (!input) {
      setSchedPreview([]);
      setSchedError('enter a valid date/time');
      return;
    }
    const res = await window.fleet.kanban.previewSchedule(input);
    if (res.ok) {
      setSchedPreview(res.next);
      setSchedError(null);
    } else {
      setSchedPreview([]);
      setSchedError(res.error);
    }
  }

  async function applySchedule(): Promise<void> {
    const input = buildScheduleInput();
    if (!input) {
      setSchedError('enter a valid date/time');
      return;
    }
    try {
      await setSchedule(t.id, input);
      setSchedError(null);
    } catch (err) {
      setSchedError(err instanceof Error ? err.message : 'could not set schedule');
    }
  }
```

(e) Render the section. Insert a new `<section>` immediately before the `{/* Run history */}` section (line 345). It is hidden for running tasks (scheduling an active worker makes no sense):

```tsx
        {/* Schedule */}
        {!running && (
          <section>
            <h3 className="mb-1 flex items-center gap-1 font-semibold text-neutral-400">
              <Clock size={12} /> Schedule
            </h3>
            {t.scheduleKind ? (
              <div className="rounded border border-neutral-800 bg-neutral-950 p-2">
                <div className="flex items-center justify-between">
                  <span className="text-indigo-300">{scheduleSummary(t)}</span>
                  <span className="text-[10px] text-neutral-500">
                    next {formatNextRun(t.nextRunAt)}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {t.scheduleKind !== 'once' &&
                    (t.schedulePaused ? (
                      <button
                        onClick={() => void resumeSchedule(t.id)}
                        className="rounded border border-neutral-700 px-2 py-1 hover:bg-neutral-800"
                      >
                        Resume
                      </button>
                    ) : (
                      <button
                        onClick={() => void pauseSchedule(t.id)}
                        className="rounded border border-neutral-700 px-2 py-1 hover:bg-neutral-800"
                      >
                        Pause
                      </button>
                    ))}
                  <button
                    onClick={() => void clearSchedule(t.id)}
                    className="rounded border border-neutral-700 px-2 py-1 hover:bg-neutral-800"
                  >
                    Clear schedule
                  </button>
                </div>
                {t.schedulePaused && (
                  <p className="mt-1 text-[10px] text-amber-400">Paused — will not fire.</p>
                )}
              </div>
            ) : (
              <div className="space-y-2 rounded border border-neutral-800 bg-neutral-950 p-2">
                <select
                  value={schedKind}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === 'once' || v === 'interval' || v === 'cron') setSchedKind(v);
                    setSchedPreview([]);
                    setSchedError(null);
                  }}
                  className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 outline-none focus:border-blue-500"
                >
                  <option value="once">Once (at a time)</option>
                  <option value="interval">Repeat every…</option>
                  <option value="cron">Cron expression</option>
                </select>

                {schedKind === 'once' && (
                  <input
                    type="datetime-local"
                    value={schedAt}
                    onChange={(e) => setSchedAt(e.target.value)}
                    className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 outline-none focus:border-blue-500"
                  />
                )}
                {schedKind === 'interval' && (
                  <div className="flex gap-1">
                    <input
                      type="number"
                      min={1}
                      value={schedEveryN}
                      onChange={(e) => setSchedEveryN(Math.max(1, Number(e.target.value)))}
                      className="w-16 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 outline-none focus:border-blue-500"
                    />
                    <select
                      value={schedUnit}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === 'minutes' || v === 'hours' || v === 'days') setSchedUnit(v);
                      }}
                      className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 outline-none focus:border-blue-500"
                    >
                      <option value="minutes">minutes</option>
                      <option value="hours">hours</option>
                      <option value="days">days</option>
                    </select>
                  </div>
                )}
                {schedKind === 'cron' && (
                  <input
                    value={schedCron}
                    onChange={(e) => setSchedCron(e.target.value)}
                    placeholder="0 9 * * *"
                    className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono outline-none focus:border-blue-500"
                  />
                )}

                <div className="flex gap-1.5">
                  <button
                    onClick={() => void refreshPreview()}
                    className="rounded border border-neutral-700 px-2 py-1 hover:bg-neutral-800"
                  >
                    Preview
                  </button>
                  <button
                    onClick={() => void applySchedule()}
                    className="rounded bg-blue-600 px-2 py-1 text-white hover:bg-blue-500"
                  >
                    Set schedule
                  </button>
                </div>

                {schedPreview.length > 0 && (
                  <div className="text-[10px] text-neutral-500">
                    Next: {schedPreview.map((n) => formatNextRun(n)).join(' · ')}
                  </div>
                )}
                {schedError && <p className="text-[10px] text-red-400">{schedError}</p>}
              </div>
            )}
          </section>
        )}
```

- [ ] **Step 3: Typecheck the web project**

Run: `npm run typecheck:web`
Expected: Clean.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/kanban/KanbanCard.tsx src/renderer/src/components/kanban/KanbanDrawer.tsx
git commit -m "feat(kanban): schedule editor in drawer + scheduled card summary"
```

---

### Task 11: Full verification + changelog

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: All tests PASS (existing + the new schedule/store/dispatcher/commands/utils tests).

- [ ] **Step 2: Typecheck, lint, build**

Run: `npm run build`
Expected: typecheck passes, lint clean (no new warnings), electron-vite build succeeds.

- [ ] **Step 3: Add a changelog entry**

Add a `## vX.Y.Z` section near the top of `CHANGELOG.md` (use the next unreleased version; do NOT create a release tag here — that is a separate, user-initiated step):

```markdown
## vX.Y.Z

- Kanban: scheduled tasks — run a task once at a future time or on a recurring interval/cron cadence. Recurring schedules spawn a fresh instance task per fire; missed fires while the app was closed are skipped and realigned. New "Scheduled" lane and a Schedule section in the task drawer.
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(kanban): changelog for scheduled tasks"
```

---

## Self-Review (completed against the spec)

**1. Spec coverage:**
- Schema v6 + six additive columns, no index → Task 4. ✅
- `scheduled` status → Task 2. ✅
- One-shot runs in place (`fireOnce` → ready); overdue-on-reopen (no grace branch for `once`) → Tasks 5, 6. ✅
- Recurring template spawns instance; skip-missed realign past `GRACE_MS = max(2×interval, 60s)` → Task 6. ✅
- `spawnScheduledInstance` copies all listed fields + `scheduled_from`, status todo, no parent links (so `promote()` advances it) → Task 5. ✅
- Pure `schedule.ts` (`computeNextRun`, `validateSchedule`) + `cron-parser` → Tasks 1, 3. ✅
- Tick order `reclaim → fireSchedules → decompose → promote → claimAndSpawn`, synchronous → Task 6. ✅
- Store methods (`setSchedule`/`clearSchedule`/`pause`/`resume`/`dueSchedules`/`advanceNextRun`/`fireOnce`/`spawnScheduledInstance`) → Task 5. ✅
- Commands with `BAD_REQUEST` on invalid cron/interval + `appendEvent` parity → Task 7. ✅
- Five IPC channels incl. `KANBAN_PREVIEW_SCHEDULE` returning next ~3 fires or a validation error → Tasks 7, 8. ✅
- ipc-api types, kanban-ipc handlers, preload methods → Task 8. ✅
- Renderer: Scheduled lane, drawer Schedule section with kind picker + live preview + clear/pause/resume, store actions; recurring instances appear in normal lanes (they are ordinary todo tasks) → Tasks 9, 10. ✅
- Live refresh rides the existing `task_events → KANBAN_EVENT` feed (App.tsx already refetches on any event; every schedule command calls `appendEvent`) → no extra renderer plumbing needed. ✅
- Error handling: paused filtered by `dueSchedules`; overlapping instances bounded by `maxInProgress` (no interlock); `computeNextRun > after` guaranteed → Tasks 5, 6. ✅

**2. Deliberate, documented deviations from the spec (Simplicity First):**
- **Validation lives in the command layer**, not in `store.setSchedule`, mirroring how `KanbanCommands.create` validates `workspaceKind`. The store still guards defensively (throws a plain `Error`), but the user-facing `CodedError('BAD_REQUEST')` comes from the command. Net behavior (invalid input rejected and surfaced in the drawer) matches the spec.
- **Pause/resume/clear controls live in the drawer's Schedule section**, not as inline lane buttons; the card shows the summary + a paused badge and opens the drawer on click (the spec's "edit affordance"). This avoids threading store actions through `KanbanCard` and keeps the card presentational. All functionality from the spec is present.
- **`scheduleSummary` shows the raw cron string** (e.g. `0 9 * * *`) rather than an English rendering ("Daily 9:00"); a cron-to-prose translator is unjustified scope for v1. Interval shows "every 2h"; once shows "once". Flagged so the reviewer doesn't read it as a gap.

**3. Type consistency:** `ScheduleInput` is defined once in `kanban-types.ts` and imported everywhere (helper, store, commands, ipc-api, preload, renderer store). Method names are identical across layers: `setSchedule`, `clearSchedule`, `pauseSchedule`, `resumeSchedule`, `previewSchedule`, `dueSchedules`, `advanceNextRun`, `fireOnce`, `spawnScheduledInstance`, `computeNextRun`, `validateSchedule`, `taskToScheduleInput`. `Task` fields (`scheduleKind`, `scheduleCron`, `scheduleIntervalMs`, `nextRunAt`, `schedulePaused`, `scheduledFrom`) match the `rowToTask` mapping and the SQL column names (`schedule_kind`, `schedule_cron`, `schedule_interval_ms`, `next_run_at`, `schedule_paused`, `scheduled_from`).
