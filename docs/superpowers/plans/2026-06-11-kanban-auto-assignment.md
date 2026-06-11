# Kanban Auto-Assignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unassigned `ready` kanban tasks get an assignee automatically (single-profile fast path, an LLM `assign` orchestrator run when there's a choice, and a deterministic fallback after repeated failure) instead of stalling forever.

**Architecture:** A new `autoAssign()` stage in the existing `KanbanDispatcher` tick. It assigns deterministically in code when there is exactly one worker profile or after an attempt cap, otherwise spawns an orchestrator run in a new `assign` run mode whose terminal tool `kanban_assign(profile)` sets the assignee and returns the task to `ready`. Gated on a new `autoAssign` setting (default **on**). No schema migration — reuses existing `task_runs.mode` and `consecutive_failures` columns.

**Tech Stack:** TypeScript, Electron main process, better-sqlite3 (`KanbanStore`), HTTP MCP server (`KanbanMcpServer`), rune headless workers, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-10-kanban-integration-autopilot-design.md` §5. **Issue:** #227.

**Deviation from spec (intentional):** The spec's §5 mentions flagging tasks with `pending_mode='assign'`. The dispatcher runs as a single synchronous tick, so flagging then claiming in the same tick is redundant — `claimForAssign()` does a direct CAS on `status='ready' AND assignee IS NULL`. We therefore add `RunMode='assign'` but do **not** add `PendingMode='assign'`. Same observable behavior, less state.

---

### Task 1: Add `assign` to `RunMode` and the `autoAssign` setting/config flag

This task introduces the type/config surface so later tasks compile. No behavior yet.

**Files:**
- Modify: `src/shared/kanban-types.ts:15`
- Modify: `src/shared/types.ts:156-164`
- Modify: `src/shared/constants.ts:105-112`
- Modify: `src/main/kanban/kanban-dispatcher.ts:30-38`
- Modify: `src/main/index.ts:849-860`
- Modify: `src/main/__tests__/kanban-dispatcher.test.ts:31-39,59-67,370-378`

- [ ] **Step 1: Extend `RunMode`**

In `src/shared/kanban-types.ts`, change line 15:

```typescript
/** What a run is doing. 'work' = normal worker; orchestrator runs are 'decompose' | 'specify' | 'assign'. */
export type RunMode = 'work' | 'decompose' | 'specify' | 'assign';
```

- [ ] **Step 2: Add `autoAssign` to the settings type**

In `src/shared/types.ts`, inside `KanbanSettings.dispatcher` (after line 163, `maxDecompose`):

```typescript
    maxDecompose: number; // concurrency cap for orchestrator runs (separate from maxInProgress)
    autoAssign: boolean; // when true, the dispatcher auto-assigns unassigned ready tasks to a worker profile
```

- [ ] **Step 3: Add the default (on)**

In `src/shared/constants.ts`, inside `DEFAULT_SETTINGS.kanban.dispatcher` (after line 111, `maxDecompose: 1`):

```typescript
      maxDecompose: 1,
      autoAssign: true
```

- [ ] **Step 4: Add `autoAssign` to `DispatcherConfig`**

In `src/main/kanban/kanban-dispatcher.ts`, inside the `DispatcherConfig` interface (after the `autoDecompose` line, ~line 35):

```typescript
  autoDecompose: boolean; // automatically arm triage tasks for decompose
  autoAssign: boolean; // automatically assign unassigned ready tasks to a worker profile
  maxDecompose: number; // max concurrent orchestrator runs
```

- [ ] **Step 5: Wire it into `buildDispatcherConfig`**

In `src/main/index.ts`, inside `buildDispatcherConfig()` (after line 856, `autoDecompose: d.autoDecompose,`):

```typescript
      autoDecompose: d.autoDecompose,
      autoAssign: d.autoAssign,
      maxDecompose: d.maxDecompose,
```

- [ ] **Step 6: Fix the test config literals**

In `src/main/__tests__/kanban-dispatcher.test.ts`, the two fully-spelled config objects (lines 31-39 and 59-67) and `baseConfig` (lines 370-378) each list every `DispatcherConfig` field, so each needs the new key. Add `autoAssign: false,` after the `autoDecompose: false,` line in all three:

```typescript
        autoDecompose: false,
        autoAssign: false,
        maxDecompose: 1,
```

(In `baseConfig`, match its formatting — `autoDecompose: false,` then `autoAssign: false,` then `maxDecompose: 1,`.)

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 8: Commit**

```bash
git add src/shared/kanban-types.ts src/shared/types.ts src/shared/constants.ts src/main/kanban/kanban-dispatcher.ts src/main/index.ts src/main/__tests__/kanban-dispatcher.test.ts
git commit -m "feat(kanban): add assign run mode and autoAssign setting"
```

---

### Task 2: Store queries — `unassignedReadyTasks()` and `claimForAssign()`

**Files:**
- Modify: `src/main/kanban/kanban-store.ts` (add methods near `readyTasks` ~line 1026 and `claimForDecompose` ~line 1485)
- Test: `src/main/__tests__/kanban-store.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/main/__tests__/kanban-store.test.ts`, add inside the top-level `describe` (place next to the existing `claimForDecompose` test, ~line 364):

```typescript
  it('unassignedReadyTasks returns only ready tasks with no assignee', () => {
    const store = makeStore();
    const a = store.createTask({ title: 'unassigned', status: 'ready' });
    store.createTask({ title: 'assigned', status: 'ready', assignee: 'w' });
    store.createTask({ title: 'todo', status: 'todo' });
    const got = store.unassignedReadyTasks().map((t) => t.id);
    expect(got).toEqual([a.id]);
    store.close();
  });

  it('claimForAssign atomically moves ready+unassigned to running', () => {
    const store = makeStore();
    const t = store.createTask({ title: 'x', status: 'ready' });
    expect(store.claimForAssign(t.id, 'L', 1000)).toBe(true);
    expect(store.getTask(t.id)?.status).toBe('running');
    // a second claim loses (no longer ready+unassigned)
    expect(store.claimForAssign(t.id, 'L2', 1000)).toBe(false);
    store.close();
  });
```

Note: `makeStore()` is the existing helper in this test file. If it requires a clock arg, match the surrounding tests' call style.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts -t "unassignedReadyTasks|claimForAssign"`
Expected: FAIL with "store.unassignedReadyTasks is not a function" / "store.claimForAssign is not a function".

- [ ] **Step 3: Implement `unassignedReadyTasks()`**

In `src/main/kanban/kanban-store.ts`, immediately after the `readyTasks()` method (ends ~line 1026):

```typescript
  /** Ready tasks with no assignee — the auto-assign stage's input (claimAndSpawn ignores these). */
  unassignedReadyTasks(): Task[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM tasks WHERE status='ready' AND assignee IS NULL ORDER BY priority DESC, created_at ASC"
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToTask(r));
  }
```

- [ ] **Step 4: Implement `claimForAssign()`**

In `src/main/kanban/kanban-store.ts`, immediately after `claimForDecompose()` (ends ~line 1485):

```typescript
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts -t "unassignedReadyTasks|claimForAssign"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/kanban/kanban-store.ts src/main/__tests__/kanban-store.test.ts
git commit -m "feat(kanban): add unassignedReadyTasks and claimForAssign store queries"
```

---

### Task 3: Worker prompt + terminal tool for `assign` mode

**Files:**
- Modify: `src/main/kanban/spawn-worker.ts:63-92` (buildPrompt) and `:120-130` (requireToolsForMode)

- [ ] **Step 1: Add the assign prompt branch**

In `src/main/kanban/spawn-worker.ts`, inside `buildPrompt`, add a new branch **before** the final `work` return (after the `specify` block ends ~line 84):

```typescript
  if (mode === 'assign') {
    const roster = (input.roster ?? []).map((r) => `- ${r.name}: ${r.description}`).join('\n');
    return (
      `assign kanban task ${task.id}: ${task.title}\n\n${task.body}\n\n` +
      `Choose the single best-matching worker profile to implement this task, based on each ` +
      `profile's described strengths. Call kanban_assign with that profile's name. Do not do the ` +
      `work yourself.\n\nAvailable worker profiles:\n${roster || '- default: general worker'}`
    );
  }
```

- [ ] **Step 2: Add the terminal tool for assign mode**

In `src/main/kanban/spawn-worker.ts`, in `requireToolsForMode` (~line 120), add a case before `default`:

```typescript
    case 'specify':
      return 'kanban_update';
    case 'assign':
      return 'kanban_assign';
    default:
      return null;
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/kanban/spawn-worker.ts
git commit -m "feat(kanban): assign-mode worker prompt and require-tool"
```

---

### Task 4: MCP server — `kanban_assign` tool, `ASSIGN_TOOLS`, handler

**Files:**
- Modify: `src/main/kanban/kanban-mcp-server.ts` (tool defs ~line 218, `toolsForMode` ~line 408, handler switch ~line 919)
- Test: `src/main/__tests__/kanban-mcp-server.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/main/__tests__/kanban-mcp-server.test.ts`, add inside the `describe('KanbanMcpServer', ...)` block (after the `kanban_block` test, ~line 95):

```typescript
  it('kanban_assign sets the assignee, returns to ready, and rejects unknown profiles', async () => {
    const profiles = () =>
      [
        { name: 'alpha', role: 'worker' as const },
        { name: 'beta', role: 'worker' as const }
      ];
    const s2 = new KanbanMcpServer(store, profiles);
    const port2 = await s2.start(0);
    const base2 = `http://127.0.0.1:${port2}/mcp`;
    try {
      const t = store.createTask({ title: 'needs owner', status: 'ready' });
      store.claimForAssign(t.id, 'LOCK', 100000);
      const run = store.startRun(t.id, 'orchestrator', 1, 'assign');
      s2.registerRun('atok', { kind: 'task', taskId: t.id, runId: run.id, mode: 'assign' }, 'LOCK');

      // unknown profile is rejected
      const bad = await rpc(`${base2}?run=atok`, 'tools/call', {
        name: 'kanban_assign',
        arguments: { profile: 'ghost' }
      });
      expect(String(bad.error?.message ?? bad.result?.content?.[0]?.text)).toMatch(
        /unknown worker profile/i
      );
      expect(store.getTask(t.id)?.assignee).toBeNull();

      // valid profile assigns and returns the task to ready
      const ok = await rpc(`${base2}?run=atok`, 'tools/call', {
        name: 'kanban_assign',
        arguments: { profile: 'alpha' }
      });
      expect(ok.result.content[0].text).toMatch(/alpha/i);
      const got = store.getTask(t.id);
      expect(got?.assignee).toBe('alpha');
      expect(got?.status).toBe('ready');
      expect(store.listRuns(t.id)[0].outcome).toBe('completed');
    } finally {
      await s2.stop();
    }
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-mcp-server.test.ts -t "kanban_assign"`
Expected: FAIL — `kanban_assign` is rejected as `unknown tool` (not yet in ASSIGN_TOOLS) or the task isn't assigned.

- [ ] **Step 3: Define `ASSIGN_TOOLS` and route it in `toolsForMode`**

In `src/main/kanban/kanban-mcp-server.ts`, after the `SPECIFY_TOOLS` definition (ends ~line 230):

```typescript
const ASSIGN_TOOLS: McpTool[] = [
  WORKER_TOOLS[0], // kanban_show
  {
    name: 'kanban_assign',
    description:
      'Assign this task to a worker profile by name. Terminal — ends the assign run.',
    inputSchema: {
      type: 'object',
      properties: { profile: { type: 'string' } },
      required: ['profile']
    }
  },
  ...WORKER_TOOLS.filter((t) => t.name === 'kanban_comment' || t.name === 'kanban_heartbeat')
];
```

Then in `toolsForMode` (~line 408), add the branch before the final return:

```typescript
function toolsForMode(mode: RunMode): McpTool[] {
  if (mode === 'decompose') return DECOMPOSE_TOOLS;
  if (mode === 'specify') return SPECIFY_TOOLS;
  if (mode === 'assign') return ASSIGN_TOOLS;
  return WORKER_TOOLS;
}
```

- [ ] **Step 4: Implement the `kanban_assign` handler**

In `src/main/kanban/kanban-mcp-server.ts`, inside the task-scope `handleToolCall` switch, add a case after `kanban_block` (~line 976, before `kanban_comment`):

```typescript
        case 'kanban_assign': {
          const a = z.object({ profile: z.string() }).parse(args);
          const name = a.profile.trim();
          // Same phantom-assignee guard as kanban_create: only assign to a real worker profile.
          const workerNames = this.getProfiles()
            .filter((p) => p.role === 'worker')
            .map((p) => p.name);
          if (workerNames.length > 0 && !workerNames.includes(name)) {
            return this.rpcError(
              res,
              rpcReq.id,
              `unknown worker profile "${name}". Valid profiles: ${workerNames.join(', ')}`
            );
          }
          this.store.updateTask(task.id, { assignee: name });
          // Back to ready, now assigned — claimAndSpawn picks it up on the next tick.
          this.store.returnToReady(task.id);
          this.store.finishRun(scope.runId, 'completed', { summary: `assigned ${name}` });
          this.store.appendEvent(task.id, scope.runId, 'assigned', { assignee: name, by: 'orchestrator' });
          this.unregisterRun(token);
          return this.text(res, rpcReq.id, `Assigned ${name}.`);
        }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/main/__tests__/kanban-mcp-server.test.ts -t "kanban_assign"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/kanban/kanban-mcp-server.ts src/main/__tests__/kanban-mcp-server.test.ts
git commit -m "feat(kanban): kanban_assign MCP tool for assign runs"
```

---

### Task 5: Dispatcher `autoAssign()` stage + reclaim routing + tick wiring

**Files:**
- Modify: `src/main/kanban/kanban-dispatcher.ts` (deps ~line 52-64, reclaim ~line 147-149, add `autoAssign()` after `decompose()` ~line 277, `tick()` ~line 330-338, add a top-level const ~line 12)
- Test: `src/main/__tests__/kanban-dispatcher.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/main/__tests__/kanban-dispatcher.test.ts`, add a new `describe` block after the `KanbanDispatcher.decompose` block (~line 499):

```typescript
describe('KanbanDispatcher.autoAssign', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('fast-path: a single worker profile is assigned in code, no run spawned', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready' });
    let spawned = 0;
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => (spawned++, 1),
      config: { ...baseConfig, autoAssign: true },
      workerProfileNames: () => ['solo']
    });
    disp.autoAssign();
    expect(spawned).toBe(0);
    expect(store.getTask(t.id)?.assignee).toBe('solo');
    expect(store.getTask(t.id)?.status).toBe('ready');
    store.close();
  });

  it('LLM path: with multiple profiles it spawns an assign run', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready' });
    const spawned: Array<{ id: string; mode: string }> = [];
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: (args) => {
        spawned.push({ id: args.task.id, mode: args.mode });
        return 4242;
      },
      config: { ...baseConfig, autoAssign: true },
      prepareWorkspaceFn: () => '/tmp/ws',
      workerProfileNames: () => ['alpha', 'beta']
    });
    disp.autoAssign();
    expect(spawned).toEqual([{ id: t.id, mode: 'assign' }]);
    expect(store.getTask(t.id)?.status).toBe('running');
    store.close();
  });

  it('fallback: after the attempt cap, assigns the first worker profile in code', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready' });
    store.recordFailure(t.id, 'a1');
    store.recordFailure(t.id, 'a2'); // consecutiveFailures = 2 == cap
    let spawned = 0;
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => (spawned++, 1),
      config: { ...baseConfig, autoAssign: true },
      prepareWorkspaceFn: () => '/tmp/ws',
      workerProfileNames: () => ['alpha', 'beta']
    });
    disp.autoAssign();
    expect(spawned).toBe(0);
    expect(store.getTask(t.id)?.assignee).toBe('alpha');
    store.close();
  });

  it('is a no-op when autoAssign is off', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready' });
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => 1,
      config: { ...baseConfig, autoAssign: false },
      workerProfileNames: () => ['alpha', 'beta']
    });
    disp.autoAssign();
    expect(store.getTask(t.id)?.assignee).toBeNull();
    expect(store.getTask(t.id)?.status).toBe('ready');
    store.close();
  });

  it('is a no-op when no worker profiles exist', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready' });
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => 1,
      config: { ...baseConfig, autoAssign: true },
      workerProfileNames: () => []
    });
    disp.autoAssign();
    expect(store.getTask(t.id)?.assignee).toBeNull();
    store.close();
  });

  it('reclaim returns a dead assign run to the unassigned ready pool', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const t = store.createTask({ title: 'x', status: 'ready' });
    store.claimForAssign(t.id, 'L', 100); // expires 1100
    store.startRun(t.id, 'orchestrator', 9999, 'assign');
    clock.t = 2000; // claim expired
    const disp = new KanbanDispatcher(store, {
      now: () => clock.t,
      isAlive: () => true,
      spawnWorker: () => 1,
      config: { ...baseConfig }
    });
    disp.reclaim();
    const got = store.getTask(t.id);
    expect(got?.status).toBe('ready');
    expect(got?.assignee).toBeNull();
    store.close();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts -t "autoAssign"`
Expected: FAIL — `disp.autoAssign is not a function` and the reclaim-assign case lands in `triage` not `ready`.

- [ ] **Step 3: Add the attempt-cap constant**

In `src/main/kanban/kanban-dispatcher.ts`, near the other top-level consts (after line 12):

```typescript
/** Assign runs attempted before the dispatcher falls back to the default worker profile. */
const ASSIGN_ATTEMPT_CAP = 2;
```

- [ ] **Step 4: Add the `workerProfileNames` dep**

In `src/main/kanban/kanban-dispatcher.ts`, in the `DispatcherDeps` interface (after `clearWorkerExit`, ~line 63):

```typescript
  clearWorkerExit?: (runId: number) => void;
  // Worker-role profile names (in profile order), for the auto-assign fast path and fallback.
  workerProfileNames?: () => string[];
```

- [ ] **Step 5: Route reclaimed assign runs back to ready**

In `src/main/kanban/kanban-dispatcher.ts`, in `reclaim()`, replace the mode-routing block (currently lines 147-149):

```typescript
        const mode = task.currentRunId != null ? this.store.runMode(task.currentRunId) : 'work';
        if (mode && mode !== 'work') this.store.setStatusCleared(task.id, 'triage');
        else this.store.returnToReady(task.id);
```

with:

```typescript
        const mode = task.currentRunId != null ? this.store.runMode(task.currentRunId) : 'work';
        // An assign run died: return the task to the unassigned ready pool so autoAssign
        // retries or falls back (decompose/specify go back to triage instead).
        if (mode === 'assign') this.store.returnToReady(task.id);
        else if (mode && mode !== 'work') this.store.setStatusCleared(task.id, 'triage');
        else this.store.returnToReady(task.id);
```

- [ ] **Step 6: Implement `autoAssign()`**

In `src/main/kanban/kanban-dispatcher.ts`, add this method immediately after `decompose()` (ends ~line 277):

```typescript
  /**
   * Assign unassigned `ready` tasks so they don't stall (claimAndSpawn ignores
   * tasks with no assignee). Exactly one worker profile, or a task past the
   * attempt cap, is assigned deterministically in code; otherwise an orchestrator
   * `assign` run picks the best-matching profile. Gated on `autoAssign`.
   */
  autoAssign(): void {
    if (!this.deps.config.autoAssign) return;
    const workerNames = this.deps.workerProfileNames?.() ?? [];
    if (workerNames.length === 0) return; // nothing to assign to
    let slots = this.deps.config.maxDecompose - this.store.orchestratorRunningCount();
    const ttl = this.deps.config.claimTtlMs;

    for (const task of this.store.unassignedReadyTasks()) {
      // Deterministic assignment: a lone profile, or a task that has burned the
      // attempt cap. No run needed.
      if (workerNames.length === 1 || task.consecutiveFailures >= ASSIGN_ATTEMPT_CAP) {
        const name = workerNames[0];
        const by = workerNames.length === 1 ? 'single-profile' : 'fallback';
        this.store.updateTask(task.id, { assignee: name });
        this.store.appendEvent(task.id, null, 'assigned', { assignee: name, by });
        if (by === 'fallback') {
          this.store.addComment(
            task.id,
            'dispatcher',
            `Auto-assigned ${name} after ${task.consecutiveFailures} failed assignment attempt(s).`
          );
        }
        continue;
      }

      // Otherwise pick via an orchestrator assign run (bounded by the orchestrator budget).
      if (slots <= 0) break;
      const lock = this.nextLock();
      if (!this.store.claimForAssign(task.id, lock, ttl)) continue; // lost the race
      let runId: number | null = null;
      try {
        const workspace = this.deps.prepareWorkspaceFn
          ? this.deps.prepareWorkspaceFn(task)
          : (task.workspacePath ?? '');
        const run = this.store.startRun(task.id, 'orchestrator', null, 'assign');
        runId = run.id;
        const pid = this.deps.spawnWorker({ task, runId: run.id, lock, workspace, mode: 'assign' });
        if (pid != null) this.store.setWorkerPid(task.id, run.id, pid);
        this.store.appendEvent(task.id, run.id, 'spawned', { mode: 'assign' });
        slots -= 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.store.recordFailure(task.id, msg);
        if (runId != null) this.store.finishRun(runId, 'spawn_failed', { error: msg });
        this.store.appendEvent(task.id, runId, 'spawn_failed', { error: msg });
        this.store.returnToReady(task.id); // back to the unassigned ready pool
        log.error('assign spawn failed', { taskId: task.id, error: msg });
      }
    }
  }
```

- [ ] **Step 7: Call it in the tick**

In `src/main/kanban/kanban-dispatcher.ts`, in `tick()` (~line 330), insert `this.autoAssign();` between `decompose()` and `promote()`:

```typescript
  tick(): void {
    this.reclaim();
    this.fireSchedules();
    this.decompose();
    this.autoAssign();
    this.promote();
    this.claimAndSpawn();
    this.sweepArtifacts();
    this.sweepMergedWorktrees();
  }
```

- [ ] **Step 8: Run the dispatcher tests**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts`
Expected: PASS (new `autoAssign` block + all existing tests).

- [ ] **Step 9: Commit**

```bash
git add src/main/kanban/kanban-dispatcher.ts src/main/__tests__/kanban-dispatcher.test.ts
git commit -m "feat(kanban): autoAssign dispatcher stage with fallback and reclaim routing"
```

---

### Task 6: Wire `assign` mode + `workerProfileNames` into the real spawn path

**Files:**
- Modify: `src/main/index.ts:861-963` (dispatcher deps + `spawnWorker`)

- [ ] **Step 1: Provide `workerProfileNames` to the dispatcher**

In `src/main/index.ts`, in the `new KanbanDispatcher(kanbanStore, { ... })` deps object, add (e.g. right after `now: Date.now,` ~line 862):

```typescript
    now: Date.now,
    workerProfileNames: () =>
      settingsStore
        .get()
        .kanban.profiles.filter((p) => p.role === 'worker')
        .map((p) => p.name),
```

- [ ] **Step 2: Don't overwrite the assignee on an assign run**

In `src/main/index.ts`, in the `spawnWorker` dep, the non-`work` branch currently always writes `assignee` (line 962). Guard it so `assign` runs leave the assignee untouched (the run's whole job is to set it). Replace line 962:

```typescript
        kanbanStore!.updateTask(task.id, { assignee: profile?.name ?? 'orchestrator' });
```

with:

```typescript
        // decompose/specify record the orchestrator as the card's assignee; an assign run
        // must not — it exists precisely to choose and set the real assignee itself.
        if (mode !== 'assign') {
          kanbanStore!.updateTask(task.id, { assignee: profile?.name ?? 'orchestrator' });
        }
```

(The roster + orchestrator-profile selection in the same `else` branch already apply to `assign`, which is what `kanban_assign`'s prompt needs.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(kanban): wire assign mode and worker roster into the spawn path"
```

---

### Task 7: Settings UI toggle

**Files:**
- Modify: `src/renderer/src/components/settings/kanban/KanbanSection.tsx:102-127`

- [ ] **Step 1: Add the toggle**

In `src/renderer/src/components/settings/kanban/KanbanSection.tsx`, after the "Auto-decompose triage tasks" `SettingRow` (ends ~line 111), add:

```tsx
        <SettingRow label="Auto-assign unassigned tasks">
          <input
            type="checkbox"
            checked={k.dispatcher.autoAssign}
            onChange={(e) =>
              patch({ dispatcher: { ...k.dispatcher, autoAssign: e.target.checked } })
            }
            className="h-4 w-4"
          />
        </SettingRow>
```

- [ ] **Step 2: Typecheck (web)**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/settings/kanban/KanbanSection.tsx
git commit -m "feat(kanban): settings toggle for auto-assignment"
```

---

### Task 8: Full verification

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: PASS (both `typecheck:node` and `typecheck:web`).

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: No **new** errors from the changed files. (Repo lint is pre-existing-red in places; verify the files this plan touched are clean — no `as` casts, no eslint-disable.)

- [ ] **Step 3: Run the full kanban test suite**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts src/main/__tests__/kanban-dispatcher.test.ts src/main/__tests__/kanban-mcp-server.test.ts`
Expected: PASS.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: SUCCESS.

- [ ] **Step 5: Final confirmation**

All green → the autopilot phase-1 (auto-assignment) is complete. Manual smoke (optional, not in CI): create an unassigned task directly in `ready`; within a few ticks it gains an assignee and is claimed.

---

## Self-Review

**Spec coverage (§5):**
- Trigger / dispatcher stage → Task 5 `autoAssign()` + tick wiring. ✓
- Fast path (single profile, in code, `assigned` event) → Task 5, asserted. ✓
- LLM path (orchestrator `assign` run, roster prompt, terminal `kanban_assign`) → Tasks 3, 4, 5, 6. ✓
- `kanban_assign` phantom-profile guard → Task 4, asserted. ✓
- After assignment → ready, claimed next tick → Task 4 (`returnToReady`) + existing `claimAndSpawn`. ✓
- Fallback (cap reached or no orchestrator profile) → Task 5 (`ASSIGN_ATTEMPT_CAP`, first-worker assign + comment); "no worker profile" → no-op (documented; nothing to assign to). ✓
- `autoAssign` setting default on → Tasks 1, 7. ✓
- `readyTasks()`'s `assignee IS NOT NULL` filter stays → untouched. ✓

**Deviations (documented in header):** `PendingMode='assign'` not added (claim is a direct CAS, single-tick); no schema migration (reuses `mode`/`consecutive_failures` columns). The §5 line about "no orchestrator-capable profile → default worker" reduces here to: if there are zero worker profiles, skip (there is nothing to assign); if there are worker profiles but no orchestrator, the LLM path still spawns and `spawn-worker` falls back per its existing logic — the attempt cap then forces the deterministic fallback. Acceptable and bounded.

**Type consistency:** `RunMode='assign'` is used identically across `kanban-types.ts`, `spawn-worker.ts` (`buildPrompt`, `requireToolsForMode`), `kanban-mcp-server.ts` (`toolsForMode`), `kanban-dispatcher.ts` (`startRun(..., 'assign')`, reclaim), and `index.ts`. `autoAssign` field name matches across `KanbanSettings`, `DEFAULT_SETTINGS`, `DispatcherConfig`, `buildDispatcherConfig`, tests, and UI. Store methods `unassignedReadyTasks()` / `claimForAssign()` named consistently in store, dispatcher, and tests.

**Placeholder scan:** none — every step has concrete code and an exact command.
