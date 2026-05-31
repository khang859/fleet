# Kanban Phase 5 — Orchestrator / Auto-Decompose Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a `triage` task be expanded into a child-task graph by an orchestrator Rune run (⚗ Decompose) or rewritten into a fuller spec (✨ Specify), driven from the drawer, the CLI, or the dispatcher (auto_decompose).

**Architecture:** Generalise every run to a **mode** (`work | decompose | specify`) that selects the MCP toolset, the spawn prompt, and the terminal semantics. A `triage` task is flagged with `pending_mode`; a new dispatcher **decompose phase** claims it (CAS `triage → running`), spawns `rune --profile orchestrator`, and the orchestrator builds the graph via `kanban_create`/`kanban_link` then `kanban_complete` (the original goes `done` and becomes the grouping parent so children promote). Specify ends with a terminal `kanban_update` that returns the task to `todo`.

**Tech Stack:** Electron + electron-vite + React + TypeScript, better-sqlite3 (synchronous, WAL), node `child_process`, HTTP MCP server, vitest.

**Spec:** `docs/superpowers/specs/2026-05-30-kanban-phase5-orchestrator-design.md`

---

## File Structure

**Shared types / config**
- `src/shared/kanban-types.ts` — add `RunMode`, `PendingMode`; `Task.pendingMode`; `TaskRun.mode`.
- `src/shared/types.ts` — `WorkerProfile.role`; `KanbanSettings.dispatcher.autoDecompose` + `.maxDecompose`.
- `src/shared/constants.ts` — default profile roles; dispatcher defaults.
- `src/main/settings-store.ts` — backfill `role: 'worker'` on saved profiles.

**Store / schema (main)**
- `src/main/kanban/schema.ts` — schema v2 columns.
- `src/main/kanban/kanban-store.ts` — versioned migration; new read fields; decompose/specify methods; `startRun(mode)`.

**Application / coordination (main)**
- `src/main/kanban/kanban-commands.ts` — `requestDecompose` / `requestSpecify`.
- `src/main/kanban/kanban-mcp-server.ts` — mode-gated toolsets + orchestrator/specify tools.
- `src/main/kanban/kanban-dispatcher.ts` — config fields, decompose phase, reclaim-to-triage.
- `src/main/kanban/spawn-worker.ts` — mode-specific prompts + roster.
- `src/main/index.ts` — thread mode through the spawn closure; resolve orchestrator profile + roster; dispatcher config.

**IPC / renderer**
- `src/shared/ipc-channels.ts`, `src/preload/index.ts`, `src/main/kanban/kanban-ipc.ts` — `decompose`/`specify` channels.
- `src/renderer/src/store/kanban-store.ts`, `src/renderer/src/components/kanban/KanbanDrawer.tsx` — buttons + actions.

**CLI**
- `src/main/fleet-cli.ts`, `src/main/socket-server.ts` — `kanban decompose|specify <id>` verbs.

**Settings UI**
- `src/renderer/src/components/settings/kanban/KanbanSection.tsx`, `ProfileEditor.tsx` — auto_decompose toggle, maxDecompose, role selector.

**Tests** — one alongside each unit: `src/main/__tests__/kanban-store.test.ts`, `kanban-commands.test.ts`, `kanban-mcp-server.test.ts`, `kanban-dispatcher.test.ts`, `kanban-spawn-worker.test.ts`, `fleet-cli.test.ts`, `settings-store.test.ts`.

**Verification commands:** `npm run typecheck`, `npm run lint`, `npx vitest run <file>`, `npm run build`.

---

## Task 1: Shared types, constants, settings-store role backfill

**Files:**
- Modify: `src/shared/kanban-types.ts`
- Modify: `src/shared/types.ts:131-150`
- Modify: `src/shared/constants.ts:83-103`
- Modify: `src/main/settings-store.ts:38`
- Test: `src/main/__tests__/settings-store.test.ts`

- [ ] **Step 1: Add the mode + pending types to `kanban-types.ts`**

Add near the top (after `WorkspaceKind`):

```typescript
/** What a run is doing. 'work' = normal worker; orchestrator runs are 'decompose' | 'specify'. */
export type RunMode = 'work' | 'decompose' | 'specify';

/** A triage task can be flagged for an orchestrator run. */
export type PendingMode = 'decompose' | 'specify';
```

Add `pendingMode` to `Task` (after `result`):

```typescript
  pendingMode: PendingMode | null;
```

Add `mode` to `TaskRun` (after `status`):

```typescript
  mode: RunMode;
```

- [ ] **Step 2: Add `role` to `WorkerProfile` and dispatcher fields to `KanbanSettings`**

In `src/shared/types.ts`, `WorkerProfile` (line 131) gains `role`:

```typescript
export type WorkerProfile = {
  name: string; // ^[a-z0-9][a-z0-9_-]*$ (rune's validName)
  role: 'worker' | 'orchestrator'; // orchestrator profiles drive decompose/specify runs
  model: string; // '' → leave to rune's normal provider resolution
  skills: string[];
  instructions: string; // persona / system-prompt body
};
```

`KanbanSettings.dispatcher` (line 139) gains two fields:

```typescript
  dispatcher: {
    intervalMs: number;
    maxInProgress: number;
    failureLimit: number;
    claimTtlMs: number;
    autoDecompose: boolean; // when true, the dispatcher auto-flags triage tasks for decompose
    maxDecompose: number; // concurrency cap for orchestrator runs (separate from maxInProgress)
  };
```

- [ ] **Step 3: Update `DEFAULT_SETTINGS` in `constants.ts`**

In `src/shared/constants.ts`, the `kanban.dispatcher` default (line 84) and the two profiles (lines 86-101):

```typescript
  kanban: {
    dispatcher: {
      intervalMs: 5000,
      maxInProgress: 3,
      failureLimit: 2,
      claimTtlMs: 900_000,
      autoDecompose: false,
      maxDecompose: 1
    },
    defaults: { workspaceKind: 'scratch', maxRuntimeSeconds: null },
    profiles: [
      {
        name: 'default',
        role: 'worker',
        model: '',
        skills: [],
        instructions:
          'You are a focused Fleet worker. Complete the assigned kanban task end-to-end, then call kanban_complete with a concise result. If you cannot proceed, call kanban_block with the reason.'
      },
      {
        name: 'orchestrator',
        role: 'orchestrator',
        model: '',
        skills: [],
        instructions:
          'You are the Fleet kanban orchestrator. Break the assigned task into a graph of smaller child tasks using kanban_create and kanban_link, choosing an appropriate worker profile for each child. Do not implement the work yourself.'
      }
    ]
  }
```

- [ ] **Step 4: Write the failing settings-store backfill test**

In `src/main/__tests__/settings-store.test.ts`, add (match the file's existing import/setup style — it already constructs a `SettingsStore`; if it stubs `electron-store`, follow that stub):

```typescript
it('backfills role: "worker" on saved profiles missing the field', () => {
  // Saved profiles from a pre-Phase-5 install have no `role`.
  const store = new SettingsStore();
  store.set({
    kanban: {
      ...store.get().kanban,
      profiles: [{ name: 'legacy', model: '', skills: [], instructions: 'x' } as never]
    }
  });
  const profiles = store.get().kanban.profiles;
  expect(profiles[0].role).toBe('worker');
});

it('defaults autoDecompose off and maxDecompose to 1', () => {
  const store = new SettingsStore();
  expect(store.get().kanban.dispatcher.autoDecompose).toBe(false);
  expect(store.get().kanban.dispatcher.maxDecompose).toBe(1);
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx vitest run src/main/__tests__/settings-store.test.ts`
Expected: FAIL — `profiles[0].role` is `undefined`.

- [ ] **Step 6: Backfill role in `settings-store.ts`**

In `get()`, change the `profiles` line (currently `profiles: saved.kanban?.profiles ?? DEFAULT_SETTINGS.kanban.profiles`) to map a default role onto any profile missing one:

```typescript
        profiles: (saved.kanban?.profiles ?? DEFAULT_SETTINGS.kanban.profiles).map((p) => ({
          role: 'worker' as const,
          ...p
        }))
```

(The spread after `role` means a saved `role` wins; only missing roles get `'worker'`.)

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run src/main/__tests__/settings-store.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: errors in `kanban-store.ts` (missing `pendingMode`/`mode` in `rowToTask`/`rowToRun`), `kanban-mcp-server.ts` (`role` on `RunScope`), and any profile literal missing `role`. These are fixed in later tasks; confirm the errors are only those expected and commit anyway (the next task fixes the store). If a profile literal elsewhere (e.g. a test) lacks `role`, add `role: 'worker'`.

- [ ] **Step 9: Commit**

```bash
git add src/shared/kanban-types.ts src/shared/types.ts src/shared/constants.ts src/main/settings-store.ts src/main/__tests__/settings-store.test.ts
git commit -m "feat(kanban): add run modes, profile role, and decompose dispatcher settings"
```

---

## Task 2: Schema v2 migration + store column reads

**Files:**
- Modify: `src/main/kanban/schema.ts`
- Modify: `src/main/kanban/kanban-store.ts:32-35` (migrate), `:46-74` (rowToTask), `:214-228` (rowToRun)
- Test: `src/main/__tests__/kanban-store.test.ts`

- [ ] **Step 1: Bump schema + add columns in `schema.ts`**

Set `export const SCHEMA_VERSION = 2;`. Add `pending_mode TEXT` to the `tasks` CREATE (after `result TEXT,`) and `mode TEXT NOT NULL DEFAULT 'work'` to the `task_runs` CREATE (after `status TEXT NOT NULL,`). These cover **fresh** DBs; existing DBs are migrated in Step 3.

- [ ] **Step 2: Write the failing migration test**

In `src/main/__tests__/kanban-store.test.ts`:

```typescript
it('migrates a v1 db to v2 (adds columns, bumps user_version)', () => {
  // Fresh store is already v2; assert the new columns exist and are nullable/defaulted.
  const t = store.createTask({ title: 'x' });
  expect(store.getTask(t.id)?.pendingMode).toBeNull();
  const run = store.startRun(t.id, 'p', null);
  expect(run.mode).toBe('work');
  expect(store.schemaVersion()).toBe(2);
});
```

Also update the existing assertion `expect(store.schemaVersion()).toBe(1)` (in the "creates the db file and runs migrations" test) to `toBe(2)`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts -t migrates`
Expected: FAIL — `pendingMode` is `undefined` (not yet read) and/or `mode` missing.

- [ ] **Step 4: Implement the versioned migration + reads**

In `kanban-store.ts`, replace `migrate()` so it runs the base schema then applies a versioned upgrade that tolerates already-present columns:

```typescript
  private migrate(): void {
    this.db.exec(SCHEMA_SQL);
    const current = Number(this.db.pragma('user_version', { simple: true }));
    if (current < 2) {
      // Additive: older DBs created before v2 lack these columns.
      this.addColumnIfMissing('tasks', 'pending_mode', 'TEXT');
      this.addColumnIfMissing('task_runs', 'mode', "TEXT NOT NULL DEFAULT 'work'");
    }
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  private addColumnIfMissing(table: string, column: string, decl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  }
```

In `rowToTask`, add (after the `result` line):

```typescript
      pendingMode: (r.pending_mode as Task['pendingMode']) ?? null,
```

In `rowToRun`, add (after the `status` line):

```typescript
      mode: (r.mode as TaskRun['mode']) ?? 'work',
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts`
Expected: PASS (including the updated `schemaVersion` assertion).

- [ ] **Step 6: Commit**

```bash
git add src/main/kanban/schema.ts src/main/kanban/kanban-store.ts src/main/__tests__/kanban-store.test.ts
git commit -m "feat(kanban): schema v2 — pending_mode and run mode columns"
```

---

## Task 3: Store decompose/specify methods

**Files:**
- Modify: `src/main/kanban/kanban-store.ts` (add methods; extend `startRun`)
- Test: `src/main/__tests__/kanban-store.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/main/__tests__/kanban-store.test.ts`:

```typescript
it('flags and reads pending_mode', () => {
  const t = store.createTask({ title: 'x', status: 'triage' });
  store.setPendingMode(t.id, 'decompose');
  expect(store.getTask(t.id)?.pendingMode).toBe('decompose');
  expect(store.pendingDecomposeTasks().map((x) => x.id)).toEqual([t.id]);
  store.setPendingMode(t.id, null);
  expect(store.getTask(t.id)?.pendingMode).toBeNull();
});

it('claimForDecompose atomically moves triage→running and clears pending_mode', () => {
  const t = store.createTask({ title: 'x', status: 'triage' });
  store.setPendingMode(t.id, 'decompose');
  expect(store.claimForDecompose(t.id, 'L', 1000)).toBe(true);
  expect(store.getTask(t.id)?.status).toBe('running');
  expect(store.getTask(t.id)?.pendingMode).toBeNull();
  // a second claim loses (already running / no pending_mode)
  expect(store.claimForDecompose(t.id, 'L2', 1000)).toBe(false);
});

it('startRun records the run mode', () => {
  const t = store.createTask({ title: 'x', status: 'triage' });
  const run = store.startRun(t.id, 'orchestrator', null, 'decompose');
  expect(run.mode).toBe('decompose');
  expect(store.runMode(run.id)).toBe('decompose');
});

it('orchestratorRunningCount counts only non-work running runs', () => {
  const a = store.createTask({ title: 'a', status: 'triage' });
  store.setPendingMode(a.id, 'decompose');
  store.claimForDecompose(a.id, 'L', 1000);
  store.startRun(a.id, 'orchestrator', null, 'decompose');
  const b = store.createTask({ title: 'b', status: 'ready', assignee: 'r' });
  store.claimTask(b.id, 'L2', 1000);
  store.startRun(b.id, 'r', null, 'work');
  expect(store.orchestratorRunningCount()).toBe(1);
});

it('armTriageForDecompose flags up to the limit and returns the count', () => {
  store.createTask({ title: 'a', status: 'triage' });
  store.createTask({ title: 'b', status: 'triage' });
  store.createTask({ title: 'c', status: 'todo' }); // not triage — ignored
  expect(store.armTriageForDecompose(1)).toBe(1);
  expect(store.pendingDecomposeTasks().length).toBe(1);
  expect(store.armTriageForDecompose(5)).toBe(1); // one triage remains unflagged
});

it('setStatusCleared resets claim fields', () => {
  const t = store.createTask({ title: 'x', status: 'triage' });
  store.claimForDecompose(t.id, 'L', 1000);
  store.setStatusCleared(t.id, 'triage');
  const got = store.getTask(t.id);
  expect(got?.status).toBe('triage');
  expect(got?.claimLock).toBeNull();
  expect(got?.currentRunId).toBeNull();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts`
Expected: FAIL — methods undefined; `startRun` rejects a 4th arg type.

- [ ] **Step 3: Extend `startRun` with a mode parameter**

Change the signature and INSERT:

```typescript
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
```

(Add `RunMode` to the type import at the top of the file.) The rest of `startRun` is unchanged.

- [ ] **Step 4: Add the decompose/specify store methods**

Add to `KanbanStore`:

```typescript
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
          worker_pid=NULL, current_run_id=NULL, updated_at=@ts WHERE id=@id`
      )
      .run({ id: taskId, status, ts });
  }
```

Add `PendingMode` to the type import at the top of the file.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/kanban/kanban-store.ts src/main/__tests__/kanban-store.test.ts
git commit -m "feat(kanban): store methods for decompose flagging, claim, and orchestrator counting"
```

---

## Task 4: KanbanCommands.requestDecompose / requestSpecify

**Files:**
- Modify: `src/main/kanban/kanban-commands.ts`
- Test: `src/main/__tests__/kanban-commands.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/main/__tests__/kanban-commands.test.ts` (use the existing `makeCommands()` helper):

```typescript
it('requestDecompose flags a triage task and logs an event', () => {
  const { commands, store } = makeCommands();
  const t = store.createTask({ title: 'big', status: 'triage' });
  commands.requestDecompose(t.id);
  expect(store.getTask(t.id)?.pendingMode).toBe('decompose');
  expect(store.listEvents(t.id).some((e) => e.kind === 'decompose_requested')).toBe(true);
});

it('requestSpecify flags a triage task with specify', () => {
  const { commands, store } = makeCommands();
  const t = store.createTask({ title: 'vague', status: 'triage' });
  commands.requestSpecify(t.id);
  expect(store.getTask(t.id)?.pendingMode).toBe('specify');
});

it('requestDecompose rejects a non-triage task', () => {
  const { commands, store } = makeCommands();
  const t = store.createTask({ title: 'x', status: 'todo' });
  expect(() => commands.requestDecompose(t.id)).toThrow(/triage/i);
});

it('requestDecompose rejects an unknown task', () => {
  const { commands } = makeCommands();
  expect(() => commands.requestDecompose('nope')).toThrow(/not found/i);
});
```

If `makeCommands()` returns only `commands`, extend it to also return `store` (it constructs one); match the helper's current return shape.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-commands.test.ts -t request`
Expected: FAIL — methods undefined.

- [ ] **Step 3: Implement the methods**

Add to `KanbanCommands` (after `dispatch()`), and add `PendingMode` to the import from `../../shared/kanban-types`:

```typescript
  requestDecompose(id: string): void {
    this.requestOrchestration(id, 'decompose');
  }

  requestSpecify(id: string): void {
    this.requestOrchestration(id, 'specify');
  }

  private requestOrchestration(id: string, mode: PendingMode): void {
    const task = this.requireTask(id);
    if (task.status !== 'triage') {
      throw new CodedError('only triage tasks can be decomposed or specified', 'BAD_REQUEST');
    }
    this.store.setPendingMode(id, mode);
    this.store.appendEvent(id, null, mode === 'decompose' ? 'decompose_requested' : 'specify_requested', {});
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/main/__tests__/kanban-commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-commands.ts src/main/__tests__/kanban-commands.test.ts
git commit -m "feat(kanban): requestDecompose/requestSpecify on the shared command layer"
```

---

## Task 5: MCP server — mode-gated toolsets + orchestrator/specify tools

**Files:**
- Modify: `src/main/kanban/kanban-mcp-server.ts`
- Modify (call sites): `src/main/__tests__/kanban-mcp-server.test.ts`, `src/main/index.ts:788`
- Test: `src/main/__tests__/kanban-mcp-server.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/main/__tests__/kanban-mcp-server.test.ts` (note: existing tests pass `{ ..., role: 'worker' }` to `registerRun` — those call sites change in Step 4; update them in the same edit):

```typescript
it('tools/list returns decompose tools for a decompose-mode token', async () => {
  const t = store.createTask({ title: 'big', status: 'running' });
  const run = store.startRun(t.id, 'orchestrator', 1, 'decompose');
  server.registerRun('dtok', { taskId: t.id, runId: run.id, mode: 'decompose' }, 'L');
  const r = await rpc(`${base}?run=dtok`, 'tools/list');
  const names = r.result.tools.map((x: { name: string }) => x.name);
  expect(names).toContain('kanban_create');
  expect(names).toContain('kanban_link');
  expect(names).toContain('kanban_list');
  expect(names).not.toContain('kanban_update');
});

it('a worker-mode token cannot call kanban_create', async () => {
  const t = store.createTask({ title: 'x', status: 'running', assignee: 'r' });
  const run = store.startRun(t.id, 'r', 1, 'work');
  server.registerRun('wtok', { taskId: t.id, runId: run.id, mode: 'work' }, 'L');
  const r = await rpc(`${base}?run=wtok`, 'tools/call', {
    name: 'kanban_create',
    arguments: { title: 'child' }
  });
  expect(String(r.error?.message ?? '')).toMatch(/unknown tool/i);
});

it('kanban_create makes a todo child linked to the orchestrator task', async () => {
  const parent = store.createTask({ title: 'big', status: 'running' });
  const run = store.startRun(parent.id, 'orchestrator', 1, 'decompose');
  server.registerRun('dtok2', { taskId: parent.id, runId: run.id, mode: 'decompose' }, 'L');
  const r = await rpc(`${base}?run=dtok2`, 'tools/call', {
    name: 'kanban_create',
    arguments: { title: 'child task', assignee: 'default' }
  });
  const childId = String(r.result.content[0].text).trim();
  const child = store.getTask(childId);
  expect(child?.status).toBe('todo');
  expect(child?.assignee).toBe('default');
  expect(store.parentsOf(childId)).toContain(parent.id);
  expect(store.listEvents(childId).some((e) => e.kind === 'task_created')).toBe(true);
});

it('kanban_create honors extra parents', async () => {
  const parent = store.createTask({ title: 'big', status: 'running' });
  const dep = store.createTask({ title: 'dep', status: 'todo' });
  const run = store.startRun(parent.id, 'orchestrator', 1, 'decompose');
  server.registerRun('dtok3', { taskId: parent.id, runId: run.id, mode: 'decompose' }, 'L');
  const r = await rpc(`${base}?run=dtok3`, 'tools/call', {
    name: 'kanban_create',
    arguments: { title: 'child', parents: [dep.id] }
  });
  const childId = String(r.result.content[0].text).trim();
  expect(store.parentsOf(childId).sort()).toEqual([dep.id, parent.id].sort());
});

it('kanban_update (specify) rewrites the body and returns the task to todo', async () => {
  const t = store.createTask({ title: 'vague', body: 'old', status: 'running' });
  store.claimForDecompose(t.id, 'L', 100000); // not strictly needed; ensures claim fields set
  const run = store.startRun(t.id, 'orchestrator', 1, 'specify');
  server.registerRun('stok', { taskId: t.id, runId: run.id, mode: 'specify' }, 'L');
  const r = await rpc(`${base}?run=stok`, 'tools/call', {
    name: 'kanban_update',
    arguments: { title: 'clear title', body: 'a much fuller spec' }
  });
  expect(r.result.content[0].text).toMatch(/specified/i);
  const got = store.getTask(t.id);
  expect(got?.status).toBe('todo');
  expect(got?.body).toBe('a much fuller spec');
  expect(got?.title).toBe('clear title');
  expect(got?.claimLock).toBeNull();
});
```

Also update the existing `'lists worker tools'` test if it asserts on a tokenless `tools/list` — that path must still return the worker toolset (the default). Leave it as-is.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-mcp-server.test.ts`
Expected: FAIL — `RunScope.mode` doesn't exist (type error), new tools unimplemented.

- [ ] **Step 3: Replace `role` with `mode` and add the toolsets**

In `kanban-mcp-server.ts`:

Change the scope type and import:

```typescript
import type { KanbanStore } from './kanban-store';
import type { RunMode } from '../../shared/kanban-types';
```

```typescript
interface RunScope {
  taskId: string;
  runId: number;
  mode: RunMode;
}
```

Remove the `export type McpRole = ...` line (replaced by `RunMode`).

Add the orchestrator/specify tool definitions next to `WORKER_TOOLS`. Introduce a shared `McpTool` type so the mixed-shape tool arrays compose without tuple/union friction:

```typescript
type McpTool = { name: string; description: string; inputSchema: Record<string, unknown> };

const ORCHESTRATOR_EXTRA_TOOLS: McpTool[] = [
  {
    name: 'kanban_list',
    description: 'List board tasks. Optional filters by status and assignee (unknown assignee → empty).',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' }, assignee: { type: 'string' } }
    }
  },
  {
    name: 'kanban_create',
    description: 'Create a child task (starts in todo, linked to the current task). Use parents for extra dependencies.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        assignee: { type: 'string' },
        priority: { type: 'number' },
        parents: { type: 'array', items: { type: 'string' } }
      },
      required: ['title']
    }
  },
  {
    name: 'kanban_link',
    description: 'Add a dependency link: child waits for parent to be done.',
    inputSchema: {
      type: 'object',
      properties: { parent_id: { type: 'string' }, child_id: { type: 'string' } },
      required: ['parent_id', 'child_id']
    }
  },
  {
    name: 'kanban_unblock',
    description: 'Return a blocked task to ready.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id']
    }
  }
];

const DECOMPOSE_TOOLS: McpTool[] = [...WORKER_TOOLS, ...ORCHESTRATOR_EXTRA_TOOLS];

const SPECIFY_TOOLS: McpTool[] = [
  WORKER_TOOLS[0], // kanban_show
  {
    name: 'kanban_update',
    description: 'Rewrite this task with an improved title/body. Terminal — ends the specify run.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'string' } },
      required: ['body']
    }
  },
  ...WORKER_TOOLS.filter((t) => t.name === 'kanban_comment' || t.name === 'kanban_heartbeat')
];

function toolsForMode(mode: RunMode): McpTool[] {
  if (mode === 'decompose') return DECOMPOSE_TOOLS;
  if (mode === 'specify') return SPECIFY_TOOLS;
  return WORKER_TOOLS;
}
```

(If `WORKER_TOOLS` is declared `const WORKER_TOOLS = [...]`, annotate it `const WORKER_TOOLS: McpTool[] = [...]` so the spreads and the `return WORKER_TOOLS` all unify on `McpTool[]`.)

In `handle()`, make `tools/list` mode-aware (the token is already parsed as `token`):

```typescript
      case 'tools/list': {
        const scope = this.runs.get(token);
        return this.rpcResult(res, rpcReq.id, { tools: toolsForMode(scope?.mode ?? 'work') });
      }
```

In `handleToolCall`, after resolving `scope` and before the `switch`, gate the tool by mode:

```typescript
    const allowed = toolsForMode(scope.mode).some((t) => t.name === name);
    if (!allowed) return this.rpcError(res, rpcReq.id, `unknown tool: ${name}`);
```

Add the new cases to the `switch (name)` in `handleToolCall`:

```typescript
        case 'kanban_list': {
          const a = z
            .object({ status: z.string().optional(), assignee: z.string().optional() })
            .parse(args);
          let rows = this.store.listBoard();
          if (a.status) rows = rows.filter((c) => c.status === a.status);
          if (a.assignee) rows = rows.filter((c) => c.assignee === a.assignee);
          const lines = rows.map((c) => `${c.id}\t${c.status}\t${c.assignee ?? '-'}\t${c.title}`);
          return this.text(res, rpcReq.id, lines.join('\n') || '(no tasks)');
        }
        case 'kanban_create': {
          const a = z
            .object({
              title: z.string(),
              body: z.string().optional(),
              assignee: z.string().optional(),
              priority: z.number().optional(),
              parents: z.array(z.string()).optional()
            })
            .parse(args);
          const child = this.store.createTask({
            title: a.title,
            body: a.body ?? '',
            assignee: a.assignee ?? null,
            priority: a.priority ?? 0,
            status: 'todo'
          });
          this.store.addLink(scope.taskId, child.id); // original is the grouping parent
          for (const p of a.parents ?? []) this.store.addLink(p, child.id);
          this.store.appendEvent(child.id, scope.runId, 'task_created', {
            by: 'orchestrator',
            parent: scope.taskId
          });
          return this.text(res, rpcReq.id, child.id);
        }
        case 'kanban_link': {
          const a = z.object({ parent_id: z.string(), child_id: z.string() }).parse(args);
          this.store.addLink(a.parent_id, a.child_id);
          this.store.appendEvent(a.child_id, scope.runId, 'link_added', { parentId: a.parent_id });
          return this.text(res, rpcReq.id, 'Linked.');
        }
        case 'kanban_unblock': {
          const a = z.object({ task_id: z.string() }).parse(args);
          this.store.setStatus(a.task_id, 'ready');
          this.store.appendEvent(a.task_id, scope.runId, 'status_changed', { to: 'ready', by: 'orchestrator' });
          return this.text(res, rpcReq.id, 'Unblocked.');
        }
        case 'kanban_update': {
          const a = z.object({ title: z.string().optional(), body: z.string() }).parse(args);
          this.store.updateTask(task.id, { title: a.title, body: a.body });
          this.store.appendEvent(task.id, scope.runId, 'task_updated', { by: 'orchestrator' });
          this.store.finishRun(scope.runId, 'completed', { summary: 'specified' });
          this.store.setStatusCleared(task.id, 'todo');
          this.unregisterRun(token);
          return this.text(res, rpcReq.id, `Task ${task.id} specified.`);
        }
```

(`updateTask` keeps the current title when `title` is `undefined`, so a body-only specify call preserves the title.)

- [ ] **Step 4: Fix the `registerRun` call site in `index.ts`**

In `src/main/index.ts`, the worker spawn closure currently calls
`kanbanMcpRef.registerRun(runToken, { taskId: task.id, runId, role: 'worker' }, lock);`.
Change `role: 'worker'` to `mode: 'work'`. (The decompose/specify wiring in this closure is completed in Task 8; for now just make this compile.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/main/__tests__/kanban-mcp-server.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/kanban/kanban-mcp-server.ts src/main/__tests__/kanban-mcp-server.test.ts src/main/index.ts
git commit -m "feat(kanban): mode-gated MCP toolsets + orchestrator/specify tools"
```

---

## Task 6: Dispatcher — config fields, decompose phase, reclaim-to-triage

**Files:**
- Modify: `src/main/kanban/kanban-dispatcher.ts`
- Modify (call sites): `src/main/__tests__/kanban-dispatcher.test.ts` (add `autoDecompose`/`maxDecompose` to every `config` literal)
- Test: `src/main/__tests__/kanban-dispatcher.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/main/__tests__/kanban-dispatcher.test.ts`, add a describe block (reuse the file's `makeStore(clock)` helper). Define a config helper to keep literals DRY:

```typescript
const baseConfig = {
  failureLimit: 2,
  claimGraceMs: 0,
  maxInProgress: 3,
  claimTtlMs: 1000,
  autoDecompose: false,
  maxDecompose: 1
};

describe('KanbanDispatcher.decompose', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('claims a flagged triage task and spawns an orchestrator run', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'big', status: 'triage' });
    store.setPendingMode(t.id, 'decompose');
    const spawned: Array<{ id: string; mode: string }> = [];
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: (args) => {
        spawned.push({ id: args.task.id, mode: args.mode });
        return 4242;
      },
      config: { ...baseConfig },
      prepareWorkspaceFn: () => '/tmp/ws'
    });
    disp.decompose();
    expect(spawned).toEqual([{ id: t.id, mode: 'decompose' }]);
    expect(store.getTask(t.id)?.status).toBe('running');
    expect(store.getTask(t.id)?.pendingMode).toBeNull();
    store.close();
  });

  it('respects the maxDecompose cap', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    for (let i = 0; i < 3; i++) {
      const t = store.createTask({ title: `t${i}`, status: 'triage' });
      store.setPendingMode(t.id, 'decompose');
    }
    let count = 0;
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => (count++, 1),
      config: { ...baseConfig, maxDecompose: 2 },
      prepareWorkspaceFn: () => '/tmp/ws'
    });
    disp.decompose();
    expect(count).toBe(2);
    store.close();
  });

  it('auto_decompose arms triage tasks only when enabled', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    store.createTask({ title: 'a', status: 'triage' });
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => 1,
      config: { ...baseConfig, autoDecompose: true, maxDecompose: 1 },
      prepareWorkspaceFn: () => '/tmp/ws'
    });
    disp.decompose();
    // the one triage task got armed and immediately claimed+spawned
    expect(store.runningTasks().length).toBe(1);
    store.close();
  });

  it('reclaim returns a dead orchestrator run to triage', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'big', status: 'triage' });
    store.setPendingMode(t.id, 'decompose');
    store.claimForDecompose(t.id, 'L', 100);
    store.startRun(t.id, 'orchestrator', 9999, 'decompose');
    clock.t = 2000; // claim expired
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => 1,
      config: { ...baseConfig }
    });
    disp.reclaim();
    expect(store.getTask(t.id)?.status).toBe('triage');
    store.close();
  });
});
```

Then add `autoDecompose: false, maxDecompose: 1` to **every** existing `config: { ... }` literal in this file (the reclaim/promote/claimAndSpawn/reconfigure suites). The `reconfigure` tests also pass config literals to `disp.reconfigure(...)` — add the two fields there too.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts`
Expected: FAIL — `decompose` undefined; `args.mode` undefined; type errors on configs (until the two fields are added everywhere).

- [ ] **Step 3: Extend the dispatcher**

In `kanban-dispatcher.ts`, add `RunMode` to imports:

```typescript
import type { Task } from '../../shared/kanban-types';
import type { RunMode } from '../../shared/kanban-types';
```

Extend the interfaces:

```typescript
export interface SpawnWorkerArgs {
  task: Task;
  runId: number;
  lock: string;
  workspace: string;
  mode: RunMode;
}

export interface DispatcherConfig {
  failureLimit: number;
  claimGraceMs: number;
  maxInProgress: number;
  claimTtlMs: number;
  autoDecompose: boolean;
  maxDecompose: number;
}
```

In `claimAndSpawn`, pass `mode: 'work'` into the `spawnWorker` call:

```typescript
        pid = this.deps.spawnWorker({ task, runId: run.id, lock, workspace, mode: 'work' });
```

In `reclaim`, replace the `else { this.store.returnToReady(task.id); }` branch with a mode-aware return:

```typescript
      } else {
        const mode = task.currentRunId != null ? this.store.runMode(task.currentRunId) : 'work';
        if (mode && mode !== 'work') this.store.setStatusCleared(task.id, 'triage');
        else this.store.returnToReady(task.id);
      }
```

(Read `task.currentRunId` / `runMode` **before** `finishRun` doesn't clear it — `finishRun` only updates `task_runs`, not `tasks.current_run_id`, so the id is still valid here.)

Add the `decompose()` method:

```typescript
  /** Claim flagged triage tasks and spawn orchestrator (decompose/specify) runs. */
  decompose(): void {
    let slots = this.deps.config.maxDecompose - this.store.orchestratorRunningCount();
    if (slots <= 0) return;
    if (this.deps.config.autoDecompose) {
      this.store.armTriageForDecompose(slots);
    }
    const ttl = this.deps.config.claimTtlMs;
    for (const task of this.store.pendingDecomposeTasks()) {
      if (slots <= 0) break;
      const mode = task.pendingMode;
      if (mode == null) continue;
      const lock = this.nextLock();
      if (!this.store.claimForDecompose(task.id, lock, ttl)) continue; // lost the race
      let runId: number | null = null;
      try {
        const workspace = this.deps.prepareWorkspaceFn
          ? this.deps.prepareWorkspaceFn(task)
          : (task.workspacePath ?? '');
        const run = this.store.startRun(task.id, 'orchestrator', null, mode);
        runId = run.id;
        const pid = this.deps.spawnWorker({ task, runId: run.id, lock, workspace, mode });
        if (pid != null) this.store.setWorkerPid(task.id, run.id, pid);
        this.store.appendEvent(task.id, run.id, 'spawned', { pid: pid ?? null, mode });
        slots -= 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.store.recordFailure(task.id, msg);
        if (runId != null) this.store.finishRun(runId, 'spawn_failed', { error: msg });
        this.store.appendEvent(task.id, runId, 'spawn_failed', { error: msg });
        this.store.setStatusCleared(task.id, 'triage');
        log.error('decompose spawn failed', { taskId: task.id, error: msg });
      }
    }
  }
```

Insert `decompose()` into `tick()` between `reclaim` and `promote`:

```typescript
  tick(): void {
    this.reclaim();
    this.decompose();
    this.promote();
    this.claimAndSpawn();
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-dispatcher.ts src/main/__tests__/kanban-dispatcher.test.ts
git commit -m "feat(kanban): dispatcher decompose phase + reclaim orchestrator runs to triage"
```

---

## Task 7: spawn-worker — mode-specific prompts + roster

**Files:**
- Modify: `src/main/kanban/spawn-worker.ts`
- Test: `src/main/__tests__/kanban-spawn-worker.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/main/__tests__/kanban-spawn-worker.test.ts` (it already exercises `buildWorkerInvocation`; match its temp-dir setup):

```typescript
it('builds a decompose prompt with the worker roster and --profile orchestrator', () => {
  const inv = buildWorkerInvocation({
    task: { id: 't1', title: 'big', body: 'do everything', assignee: null, modelOverride: null },
    workspace: WS,
    mcpPort: 1234,
    runToken: 'tok',
    logPath: join(WS, 'r.log'),
    mode: 'decompose',
    profile: { name: 'orchestrator', role: 'orchestrator', model: '', skills: [], instructions: 'route' },
    roster: [{ name: 'coder', description: 'writes code' }]
  });
  const prompt = inv.args[inv.args.indexOf('--prompt') + 1];
  expect(prompt).toMatch(/decompose/i);
  expect(prompt).toContain('coder: writes code');
  expect(inv.args).toContain('--profile');
  expect(inv.args[inv.args.indexOf('--profile') + 1]).toBe('orchestrator');
});

it('builds a specify prompt that says not to create child tasks', () => {
  const inv = buildWorkerInvocation({
    task: { id: 't2', title: 'vague', body: 'x', assignee: null, modelOverride: null },
    workspace: WS,
    mcpPort: 1234,
    runToken: 'tok',
    logPath: join(WS, 'r.log'),
    mode: 'specify',
    profile: { name: 'orchestrator', role: 'orchestrator', model: '', skills: [], instructions: 'route' }
  });
  const prompt = inv.args[inv.args.indexOf('--prompt') + 1];
  expect(prompt).toMatch(/kanban_update/);
  expect(prompt).toMatch(/do not create child/i);
});

it('builds the normal work prompt for mode work', () => {
  const inv = buildWorkerInvocation({
    task: { id: 't3', title: 'fix', body: 'bug', assignee: 'default', modelOverride: null },
    workspace: WS,
    mcpPort: 1234,
    runToken: 'tok',
    logPath: join(WS, 'r.log'),
    mode: 'work'
  });
  const prompt = inv.args[inv.args.indexOf('--prompt') + 1];
  expect(prompt).toMatch(/^work kanban task t3/);
  expect(inv.args[inv.args.indexOf('--profile') + 1]).toBe('default');
});
```

(Define `WS` as the test's temp workspace dir, as the existing tests do.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-spawn-worker.test.ts`
Expected: FAIL — `mode`/`roster` not on `BuildWorkerInput`; prompt always "work …".

- [ ] **Step 3: Extend `spawn-worker.ts`**

Add to imports:

```typescript
import type { RunMode } from '../../shared/kanban-types';
```

Extend `BuildWorkerInput`:

```typescript
export interface BuildWorkerInput {
  task: WorkerTaskInfo;
  workspace: string;
  mcpPort: number;
  runToken: string;
  logPath: string;
  mode: RunMode;
  profile?: WorkerProfile | null;
  roster?: Array<{ name: string; description: string }>;
}
```

Add a prompt builder above `buildWorkerInvocation`:

```typescript
function buildPrompt(input: BuildWorkerInput): string {
  const { mode, task } = input;
  if (mode === 'decompose') {
    const roster = (input.roster ?? []).map((r) => `- ${r.name}: ${r.description}`).join('\n');
    return (
      `decompose kanban task ${task.id}: ${task.title}\n\n${task.body}\n\n` +
      `Break this into a graph of smaller child tasks. For each unit of work, call kanban_create ` +
      `with a clear title and body, and an assignee chosen from the worker profiles below. Pass ` +
      `parents=[...] for true dependencies. Do not implement the work yourself. When the graph is ` +
      `complete, call kanban_complete with a one-line summary.\n\n` +
      `Available worker profiles:\n${roster || '- default: general worker'}`
    );
  }
  if (mode === 'specify') {
    return (
      `specify kanban task ${task.id}: ${task.title}\n\n${task.body}\n\n` +
      `Rewrite this task into a fuller, clearer specification. Do not create child tasks. When done, ` +
      `call kanban_update with the improved title and body.`
    );
  }
  return `work kanban task ${task.id}: ${task.title}\n\n${task.body}`;
}
```

In `buildWorkerInvocation`, replace the prompt/`--profile` block. Currently:

```typescript
  const prompt = `work kanban task ${input.task.id}: ${input.task.title}\n\n${input.task.body}`;
  const args = ['--prompt', prompt];
  if (input.task.assignee) args.push('--profile', input.task.assignee);
  if (input.task.modelOverride) args.push('--model', input.task.modelOverride);
```

with:

```typescript
  const prompt = buildPrompt(input);
  const args = ['--prompt', prompt];
  const profileName = input.profile?.name ?? input.task.assignee ?? null;
  if (profileName) args.push('--profile', profileName);
  if (input.task.modelOverride) args.push('--model', input.task.modelOverride);
```

`spawnRuneWorker` already forwards `input` to `buildWorkerInvocation`, so no other change there. Note: existing call sites in tests that build a `work` invocation now must pass `mode: 'work'`; update any that fail to compile.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/main/__tests__/kanban-spawn-worker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/spawn-worker.ts src/main/__tests__/kanban-spawn-worker.test.ts
git commit -m "feat(kanban): mode-specific worker prompts + orchestrator roster"
```

---

## Task 8: index.ts wiring (orchestrator profile + roster + dispatcher config)

**Files:**
- Modify: `src/main/index.ts:759-810` (spawn closure + dispatcher config)

This task is integration glue verified by typecheck/build (no new unit test).

- [ ] **Step 1: Thread mode + orchestrator resolution through the spawn closure**

Replace the `spawnWorker` closure body so it resolves the right profile/roster per mode and registers the run with that mode. The closure currently destructures `{ task, runId, lock, workspace }`; add `mode`:

```typescript
    spawnWorker: ({ task, runId, lock, workspace, mode }) => {
      const runToken = randomUUID();
      kanbanMcpRef.registerRun(runToken, { taskId: task.id, runId, mode }, lock);
      const profiles = settingsStore.get().kanban.profiles;
      let profile;
      let roster: Array<{ name: string; description: string }> | undefined;
      if (mode === 'work') {
        profile = task.assignee ? (profiles.find((p) => p.name === task.assignee) ?? null) : null;
      } else {
        // decompose/specify: run as an orchestrator profile; offer the worker roster.
        profile =
          profiles.find((p) => p.role === 'orchestrator') ??
          profiles.find((p) => p.name === 'orchestrator') ??
          null;
        roster = profiles
          .filter((p) => p.role !== 'orchestrator')
          .map((p) => ({ name: p.name, description: (p.instructions.split('\n')[0] ?? '').slice(0, 120) }));
      }
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
        logPath: join(KANBAN_HOME, 'logs', `${runToken}.log`),
        mode,
        profile,
        roster
      });
    },
```

- [ ] **Step 2: Add the new dispatcher config fields**

In `buildDispatcherConfig()`, include the two new settings:

```typescript
  const buildDispatcherConfig = (): DispatcherConfig => {
    const d = settingsStore.get().kanban.dispatcher;
    return {
      failureLimit: d.failureLimit,
      claimGraceMs: 30_000,
      maxInProgress: d.maxInProgress,
      claimTtlMs: d.claimTtlMs,
      autoDecompose: d.autoDecompose,
      maxDecompose: d.maxDecompose
    };
  };
```

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run build`
Expected: PASS (build runs typecheck then electron-vite build).

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(kanban): wire orchestrator profile + roster into the worker spawn closure"
```

---

## Task 9: IPC + preload + renderer store + drawer buttons

**Files:**
- Modify: `src/shared/ipc-channels.ts:122-131`
- Modify: `src/main/kanban/kanban-ipc.ts`
- Modify: `src/preload/index.ts:424-443`
- Modify: `src/renderer/src/store/kanban-store.ts`
- Modify: `src/renderer/src/components/kanban/KanbanDrawer.tsx`

Verified by typecheck/build + the renderer store unit (the store has no existing test file; this task adds behavior verified by build and the manual check in Task 11's manual section).

- [ ] **Step 1: Add the IPC channels**

In `src/shared/ipc-channels.ts`, in the kanban block (after `KANBAN_NUDGE`):

```typescript
  KANBAN_DECOMPOSE: 'kanban:decompose',
  KANBAN_SPECIFY: 'kanban:specify',
```

- [ ] **Step 2: Add the IPC handlers**

In `src/main/kanban/kanban-ipc.ts`, after the `KANBAN_NUDGE` handler:

```typescript
  ipcMain.handle(IPC_CHANNELS.KANBAN_DECOMPOSE, (_e, taskId: string) => {
    commands.requestDecompose(taskId);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_SPECIFY, (_e, taskId: string) => {
    commands.requestSpecify(taskId);
  });
```

- [ ] **Step 3: Expose them in preload**

In `src/preload/index.ts`, in the `kanban` object (after `nudge`):

```typescript
    decompose: async (taskId: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_DECOMPOSE, taskId),
    specify: async (taskId: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_SPECIFY, taskId),
```

(`FleetApi` is `typeof` this object, so the renderer types pick these up automatically.)

- [ ] **Step 4: Add renderer store actions**

In `src/renderer/src/store/kanban-store.ts`, add to the `KanbanState` type:

```typescript
  decompose: (id: string) => Promise<void>;
  specify: (id: string) => Promise<void>;
```

and to the store body (after `nudge`):

```typescript
  decompose: async (id) => {
    await window.fleet.kanban.decompose(id);
    await get().loadBoard();
    await get().refreshDetail();
  },
  specify: async (id) => {
    await window.fleet.kanban.specify(id);
    await get().loadBoard();
    await get().refreshDetail();
  },
```

- [ ] **Step 5: Add the drawer buttons**

In `src/renderer/src/components/kanban/KanbanDrawer.tsx`:

Pull the new actions from the store (extend the destructure on line 21-22):

```typescript
  const { detail, closeTask, updateTask, setStatus, addComment, addLink, removeLink, decompose, specify } =
    useKanbanStore();
```

Add a block right after the status-actions `<div>` (after the closing of the `ACTIONS.map` block, before the `running` notice), shown only for triage tasks:

```tsx
        {t.status === 'triage' && !running && (
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => void decompose(t.id)}
              className="rounded border border-purple-700 px-2 py-1 text-purple-300 hover:bg-neutral-800"
            >
              ⚗ Decompose
            </button>
            <button
              onClick={() => void specify(t.id)}
              className="rounded border border-sky-700 px-2 py-1 text-sky-300 hover:bg-neutral-800"
            >
              ✨ Specify
            </button>
          </div>
        )}
        {t.pendingMode && (
          <p className="text-[10px] text-purple-400">
            Queued for {t.pendingMode}… the dispatcher will pick this up shortly.
          </p>
        )}
```

(`t.pendingMode` is on the `Task` type from Task 1; `BoardCard`/`TaskDetail.task` carry it through.)

- [ ] **Step 6: Typecheck + build**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/ipc-channels.ts src/main/kanban/kanban-ipc.ts src/preload/index.ts src/renderer/src/store/kanban-store.ts src/renderer/src/components/kanban/KanbanDrawer.tsx
git commit -m "feat(kanban): decompose/specify IPC + drawer buttons"
```

---

## Task 10: CLI — `fleet kanban decompose|specify <id>`

**Files:**
- Modify: `src/main/fleet-cli.ts` (validateCommand + help)
- Modify: `src/main/socket-server.ts` (dispatch cases)
- Test: `src/main/__tests__/fleet-cli.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/main/__tests__/fleet-cli.test.ts` (match the existing `validateCommand`/help test style):

```typescript
it('kanban decompose requires a task id', () => {
  expect(validateCommand('kanban.decompose', {})).toMatch(/requires a task id/i);
  expect(validateCommand('kanban.decompose', { id: 't1' })).toBeNull();
});

it('kanban specify requires a task id', () => {
  expect(validateCommand('kanban.specify', {})).toMatch(/requires a task id/i);
  expect(validateCommand('kanban.specify', { id: 't1' })).toBeNull();
});

it('kanban help lists decompose and specify', () => {
  const help = getHelpText(['kanban', '--help']);
  expect(help).toContain('decompose');
  expect(help).toContain('specify');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/__tests__/fleet-cli.test.ts -t 'decompose\|specify'`
Expected: FAIL — validation returns `null` (no case) and help lacks the verbs.

- [ ] **Step 3: Add the validation cases**

In `fleet-cli.ts` `validateCommand`, fold the two verbs into the existing id-only group. Change:

```typescript
    case 'kanban.show':
    case 'kanban.log':
    case 'kanban.ready':
    case 'kanban.unblock':
    case 'kanban.archive': {
```

to also include:

```typescript
    case 'kanban.show':
    case 'kanban.log':
    case 'kanban.ready':
    case 'kanban.unblock':
    case 'kanban.archive':
    case 'kanban.decompose':
    case 'kanban.specify': {
```

(The shared body already derives `verb` from `command.split('.')[1]` and produces `requires a task id`.)

- [ ] **Step 4: Add the help lines**

In `HELP_GROUPS.kanban`, add two lines in the command list (after `fleet kanban dispatch`):

```
  fleet kanban decompose <task-id>          Fan a triage task into a child-task graph
  fleet kanban specify <task-id>            Rewrite a triage task into a fuller spec
```

- [ ] **Step 5: Add the socket dispatch cases**

In `src/main/socket-server.ts`, after the `kanban.dispatch` case:

```typescript
      case 'kanban.decompose':
      case 'kanban.specify': {
        const k = this.requireKanban();
        const id = typeof args.id === 'string' ? args.id : undefined;
        if (!id) throw new CodedError(`kanban ${command.split('.')[1]} requires a task id`, 'BAD_REQUEST');
        if (command === 'kanban.decompose') k.requestDecompose(id);
        else k.requestSpecify(id);
        return { ok: true };
      }
```

- [ ] **Step 6: Run the tests + typecheck**

Run: `npx vitest run src/main/__tests__/fleet-cli.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/fleet-cli.ts src/main/socket-server.ts src/main/__tests__/fleet-cli.test.ts
git commit -m "feat(kanban): fleet kanban decompose/specify CLI verbs"
```

---

## Task 11: Settings UI — auto_decompose, maxDecompose, profile role

**Files:**
- Modify: `src/renderer/src/components/settings/kanban/KanbanSection.tsx`
- Modify: `src/renderer/src/components/settings/kanban/ProfileEditor.tsx`

Verified by typecheck/build + manual. (These are controlled inputs over typed settings; the type system catches wiring errors.)

- [ ] **Step 1: Add the dispatcher toggles in `KanbanSection.tsx`**

After the "Claim TTL (ms)" `SettingRow` (inside the Dispatcher `<section>`), add:

```tsx
        <SettingRow label="Auto-decompose triage tasks">
          <input
            type="checkbox"
            checked={k.dispatcher.autoDecompose}
            onChange={(e) =>
              patch({ dispatcher: { ...k.dispatcher, autoDecompose: e.target.checked } })
            }
            className="h-4 w-4"
          />
        </SettingRow>
        <SettingRow label="Max concurrent orchestrator runs">
          <input
            type="number"
            min={1}
            value={k.dispatcher.maxDecompose}
            onChange={(e) =>
              patch({
                dispatcher: {
                  ...k.dispatcher,
                  maxDecompose: Math.max(1, Number(e.target.value) || 1)
                }
              })
            }
            className="w-28 rounded bg-neutral-800 px-2 py-1 text-sm border border-neutral-700"
          />
        </SettingRow>
```

- [ ] **Step 2: Fix the "+ New profile" default to include role**

In `KanbanSection.tsx`, the new-profile button creates `{ name: '', model: '', skills: [], instructions: '' }`. Add `role`:

```tsx
                profiles: [...k.profiles, { name: '', role: 'worker', model: '', skills: [], instructions: '' }]
```

- [ ] **Step 3: Add a role selector in `ProfileEditor.tsx`**

After the name row (the `<div className="flex items-center gap-2">…</div>` block) and its validation messages, add:

```tsx
      <select
        value={profile.role}
        onChange={(e) =>
          onChange({ ...profile, role: e.target.value === 'orchestrator' ? 'orchestrator' : 'worker' })
        }
        title="role"
        className="w-full rounded bg-neutral-800 px-2 py-1 text-sm border border-neutral-700"
      >
        <option value="worker">worker</option>
        <option value="orchestrator">orchestrator</option>
      </select>
```

- [ ] **Step 4: Typecheck + build + lint**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run lint`
Expected: PASS.

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests pass (previous total + the new tests from Tasks 1–10).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/settings/kanban/KanbanSection.tsx src/renderer/src/components/settings/kanban/ProfileEditor.tsx
git commit -m "feat(kanban): settings for auto-decompose, maxDecompose, and profile role"
```

---

## Manual verification (after all tasks; needs the app + real Rune)

1. Create a task, set it to `triage`. Open the drawer → click **⚗ Decompose**. Card shows "Queued for decompose…", then flips to `running` with an orchestrator run in the Runs list and a live log tail.
2. The orchestrator calls `kanban_create` for 2–3 children (with `parents` for a dependency), then `kanban_complete`. The original goes `done`; its child-progress pill shows N/M; the children promote (`todo → ready`) and dispatch to workers in dependency order.
3. On another triage task, click **✨ Specify**. The orchestrator rewrites the body via `kanban_update`; the task lands back in `todo` with the fuller spec, no children created.
4. `fleet kanban decompose <id>` and `fleet kanban specify <id>` from the terminal drive the same flows.
5. Settings → Kanban: toggle **Auto-decompose** on; create a few triage tasks; confirm the dispatcher arms and decomposes them within the `maxDecompose` cap, and leaves the rest until slots free. Toggle off; confirm triage tasks are no longer auto-armed.
6. Kill an orchestrator process mid-run (or let its claim expire): the task returns to `triage` and (under the failure limit) can be re-decomposed; over the limit it auto-blocks (`gave_up`).

---

## Notes for the implementer

- **better-sqlite3 is synchronous and the Electron main process is single-threaded** — there is no yield point between a read and the following write, so the CAS claims and the "claim clears pending_mode in one UPDATE" are race-free without extra locking.
- **Do not** revive or touch the dead `SocketApi`/`FleetCommandHandler` stack — the live path is `SocketSupervisor → SocketServer.dispatch`.
- Match existing style: `CodedError(message, code)` for command-layer failures; events via `store.appendEvent`; `z.object(...).parse` for MCP tool args.
- When a task says "update existing call sites," it means the edits won't compile until those are fixed — fix only what your change broke (registerRun `role→mode`, dispatcher config literals, `buildWorkerInvocation` callers needing `mode`), nothing more.
