# Kanban `integrate()` Stage + `resolve` Run Mode Implementation Plan (#228)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-merge completed feature kanban tasks into their feature integration branch, resolve merge conflicts with a bounded agent-driven `resolve` run, and keep a completed feature's integration branch synced with main — all inside the existing synchronous dispatcher tick, with no origin push or PR (that is #229).

**Architecture:** A new `integrate()` dispatcher stage (gated on a new `autoIntegrate` setting, default on) runs after `claimAndSpawn()`. It has two parts: `integrateTasks()` merges each `review` feature-worktree task into the feature's integration branch (clean → `done` + prune; conflict → spawn a `resolve` run; conflict past a cap of 2 → `blocked`), and `integrateFeatures()` syncs a fully-done feature's integration branch with main (conflict → a synthetic `feature_sync` system task dispatched in `resolve` mode). A new `RunMode='resolve'` reuses the whole worker/claim/heartbeat pipeline; its worker merges the target branch into the task's worktree, resolves conflicts, verifies, commits, and calls `kanban_complete` (→ back to `review`, merge retried next tick). All git work is **local only** — every origin push / `gh pr` call is deferred to #229.

**Tech Stack:** Electron main process, better-sqlite3 (`KanbanStore`), TypeScript, Vitest. Reuses existing `workspace.ts` git helpers (`ensureFeatureBranch`, `checkMergeConflicts`, `mergeWorktreeToBase`, `updateIntegrationBranchFromMain`, `removeWorktree`, `isBranchMerged`) — all synchronous, all merge-only (never push to origin).

**Spec:** `docs/superpowers/specs/2026-06-10-kanban-integration-autopilot-design.md` §1–2, §8–9.

---

## Scope & phase boundary (read first)

This is **phase 2** of the autopilot. It does **local git only**:

- `integrateTasks()` merges a task branch into the **local** feature integration branch via `mergeWorktreeToBase` (which does `git push <repoPath> HEAD:refs/heads/<base>` — a *local* ref update, **never** origin).
- `integrateFeatures()` syncs via `updateIntegrationBranchFromMain` (fetches `origin/<base>` for freshness but merges **locally**, no push).
- **No** `createFeaturePr`, **no** `git push origin`, **no** `gh pr ready`, **no** PrPoller changes, **no** draft-PR lifecycle. Those are #229.
- **No** auto-grouping / feature suggestions / `feature_suggestions` table. That is #230.

`PendingMode` is **not** extended with `'resolve'` (following the #227 precedent: a single synchronous tick makes a flag-then-claim handshake redundant; the dispatcher claims directly via a CAS). Only `RunMode` gains `'resolve'`.

### Constants (define where indicated)

- `RESOLVE_ATTEMPT_CAP = 2` — resolve runs per task before `blocked` + notify. (Independent of the work-phase `failureLimit`; tracked in the new `resolve_attempts` column, not `consecutive_failures`.)
- `MAX_INTEGRATE_PER_TICK = 3` — max merges + resolve-spawns processed per tick so the tick stays fast.

---

## File structure

| File | Change |
|---|---|
| `src/main/kanban/schema.ts` | `SCHEMA_VERSION` 10 → 11 |
| `src/shared/kanban-types.ts` | `RunMode` += `'resolve'`; `Task` += `resolveAttempts`, `systemKind`; `CreateTaskInput` += `systemKind` |
| `src/main/kanban/kanban-store.ts` | v11 migration; `rowToTask`/`createTask` for new columns; new query/claim/attempt methods; rollup exclusion |
| `src/shared/types.ts` | `KanbanSettings.dispatcher` += `autoIntegrate` |
| `src/shared/constants.ts` | `DEFAULT_SETTINGS.kanban.dispatcher.autoIntegrate = true` |
| `src/main/kanban/kanban-dispatcher.ts` | `DispatcherConfig.autoIntegrate`; `DispatcherDeps.integration` (test seam); `spawnResolve`, `integrate`, `integrateTasks`, `integrateFeatures`, `requestResolve`; consts; wire into `tick()` |
| `src/main/kanban/spawn-worker.ts` | `buildPrompt` `resolve` branch; `requireToolsForMode` `resolve`; `BuildWorkerInput.resolveTarget` |
| `src/main/kanban/kanban-mcp-server.ts` | `RESOLVE_TOOLS`; `toolsForMode` `resolve` branch |
| `src/main/index.ts` | `buildDispatcherConfig` += `autoIntegrate`; `spawnWorker` `resolve` branch (worker profile + `resolveTarget`) |
| `src/renderer/src/components/settings/kanban/KanbanSection.tsx` | "Auto-integrate" checkbox |
| `src/main/__tests__/*.test.ts` | tests per task; `autoIntegrate: false` added to existing dispatcher config literals |

---

## Task 1: Data model — migration v11 + types

**Files:**
- Modify: `src/main/kanban/schema.ts` (the `SCHEMA_VERSION` line)
- Modify: `src/shared/kanban-types.ts:15` (`RunMode`), `:135-184` (`Task`), `:282-304` (`CreateTaskInput`)
- Modify: `src/main/kanban/kanban-store.ts` (migration block; `rowToTask`; `createTask` INSERT)
- Test: `src/main/__tests__/kanban-store.test.ts`

- [ ] **Step 1: Write the failing test** in `kanban-store.test.ts` (mirror the existing `makeStore`/`beforeEach` harness in that file — do NOT invent a helper):

```typescript
it('defaults resolve_attempts to 0 and system_kind to null on new tasks', () => {
  const t = store.createTask({ title: 'x' });
  const got = store.getTask(t.id)!;
  expect(got.resolveAttempts).toBe(0);
  expect(got.systemKind).toBeNull();
});

it('persists system_kind when provided to createTask', () => {
  const t = store.createTask({ title: 'sync', systemKind: 'feature_sync' });
  expect(store.getTask(t.id)!.systemKind).toBe('feature_sync');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts -t 'resolve_attempts'`
Expected: FAIL — `resolveAttempts`/`systemKind` undefined.

- [ ] **Step 3: Bump schema version** in `src/main/kanban/schema.ts`: change `export const SCHEMA_VERSION = 10;` to `= 11;`.

- [ ] **Step 4: Add the v11 migration** in `kanban-store.ts`, in the migration ladder (after the `if (current < 10)` block — find it by searching `current < 10`), mirroring the v8/v9 additive pattern:

```typescript
if (current < 11) {
  // Phase-2 autopilot: bounded resolve-run budget + synthetic system-task marker.
  this.addColumnIfMissing('tasks', 'resolve_attempts', 'INTEGER NOT NULL DEFAULT 0');
  this.addColumnIfMissing('tasks', 'system_kind', 'TEXT');
}
```

- [ ] **Step 5: Extend the types** in `src/shared/kanban-types.ts`:
  - `RunMode`: `export type RunMode = 'work' | 'decompose' | 'specify' | 'assign' | 'resolve';` and update the doc comment to mention `'resolve'`.
  - `Task` interface: after `consecutiveFailures: number;` add `resolveAttempts: number;` and after `worktreePruned: boolean;` add `systemKind: string | null;` with a doc comment: `/** Non-null marks a dispatcher-created system task (e.g. 'feature_sync'); excluded from feature roll-ups. */`
  - `CreateTaskInput`: after `scheduledFrom?: string | null;` add `systemKind?: string | null;`

- [ ] **Step 6: Map the columns in `rowToTask`** (search `rowToTask(` in kanban-store.ts). Add, alongside the existing numeric/string field mappings:

```typescript
resolveAttempts: Number(r.resolve_attempts ?? 0),
systemKind: (r.system_kind as string | null) ?? null,
```

- [ ] **Step 7: Write `system_kind` in `createTask`.** In the `createTask` INSERT (search `INSERT INTO tasks`), add the `system_kind` column + binding. The column list, placeholders, and the params object/array must all stay aligned — add `system_kind` to the column list, a matching placeholder, and bind `input.systemKind ?? null`. (`resolve_attempts` needs no INSERT entry — its `DEFAULT 0` covers new rows.)

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts`
Expected: PASS (new tests + all existing store tests).

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no new errors; `RunMode` switch exhaustiveness in spawn-worker/mcp handled in Tasks 4–5).

> NOTE: extending `RunMode` may surface `switch` exhaustiveness or default-branch warnings in `spawn-worker.ts`/`kanban-mcp-server.ts`. Those files get their `'resolve'` cases in Tasks 4–5; if typecheck flags an unhandled case now, it is expected and resolved by those tasks. Do not silence it here.

- [ ] **Step 10: Commit**

```bash
git add src/main/kanban/schema.ts src/shared/kanban-types.ts src/main/kanban/kanban-store.ts src/main/__tests__/kanban-store.test.ts
git commit -m "feat(kanban): schema v11 — resolve_attempts + system_kind, RunMode 'resolve'"
```

---

## Task 2: Settings — `autoIntegrate` (default on) + UI

**Files:**
- Modify: `src/shared/types.ts` (`KanbanSettings.dispatcher`, near `autoAssign`)
- Modify: `src/shared/constants.ts` (`DEFAULT_SETTINGS.kanban.dispatcher`, near `autoAssign`)
- Modify: `src/main/kanban/kanban-dispatcher.ts` (`DispatcherConfig`)
- Modify: `src/main/index.ts` (`buildDispatcherConfig`)
- Modify: `src/renderer/src/components/settings/kanban/KanbanSection.tsx`
- Test: `src/main/__tests__/settings-kanban-notifications.test.ts` OR wherever default-settings are asserted (search `autoAssign` in `src/main/__tests__` and `src/shared/__tests__`)

- [ ] **Step 1: Write the failing test.** Find the existing test that asserts `DEFAULT_SETTINGS.kanban.dispatcher.autoAssign` (search `autoAssign` under `__tests__`). Add an adjacent assertion:

```typescript
expect(DEFAULT_SETTINGS.kanban.dispatcher.autoIntegrate).toBe(true);
```

If no such test exists, add one to `src/shared/__tests__/` (a tiny `constants` import test mirroring the file's style).

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run -t 'autoIntegrate'`
Expected: FAIL — property missing.

- [ ] **Step 3: Add the type** in `src/shared/types.ts`. In `KanbanSettings.dispatcher`, immediately after `autoAssign: boolean;` add:

```typescript
/** Auto-merge completed feature tasks into their integration branch; spawn resolve runs on conflict. */
autoIntegrate: boolean;
```

- [ ] **Step 4: Add the default** in `src/shared/constants.ts`. In `DEFAULT_SETTINGS.kanban.dispatcher`, after `autoAssign: true,` add `autoIntegrate: true,`.

- [ ] **Step 5: Add to `DispatcherConfig`** in `kanban-dispatcher.ts`, after `autoAssign: boolean;`:

```typescript
autoIntegrate: boolean; // auto-merge feature review tasks into the integration branch + resolve runs
```

- [ ] **Step 6: Wire `buildDispatcherConfig`** in `src/main/index.ts` (around line 856): after `autoAssign: d.autoAssign,` add `autoIntegrate: d.autoIntegrate,`.

- [ ] **Step 7: Add the UI row** in `KanbanSection.tsx`. Find the "Auto-assign unassigned tasks" `SettingRow` and add an identical one below it:

```tsx
<SettingRow label="Auto-integrate completed feature tasks" description="Merge finished feature tasks into the feature branch; resolve conflicts automatically.">
  <input
    type="checkbox"
    className="h-4 w-4"
    checked={k.dispatcher.autoIntegrate}
    onChange={(e) => patch({ dispatcher: { ...k.dispatcher, autoIntegrate: e.target.checked } })}
  />
</SettingRow>
```

(Match the exact `SettingRow`/prop shape used by the autoAssign row in this file — copy it verbatim and change label/description/checked/patch key.)

- [ ] **Step 8: Add `autoIntegrate: false` to existing dispatcher config literals.** Search `autoAssign:` across `src/main/__tests__/kanban-dispatcher.test.ts`, `kanban-commands.test.ts`, `kanban-mcp-server.test.ts`. Every inline `DispatcherConfig` object literal (the ones NOT using `...baseConfig`) needs `autoIntegrate: false` added next to `autoAssign`. Also add `autoIntegrate: false` to the `baseConfig` object (`kanban-dispatcher.test.ts:378`). `...baseConfig` spreads inherit it automatically.

- [ ] **Step 9: Run tests + typecheck**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts && npm run typecheck`
Expected: PASS — typecheck is the real gate that every `DispatcherConfig` literal now has `autoIntegrate`.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(kanban): autoIntegrate setting (default on) + KanbanSection toggle"
```

---

## Task 3: Store — integrate/resolve queries, claim, attempts, rollup exclusion

**Files:**
- Modify: `src/main/kanban/kanban-store.ts`
- Test: `src/main/__tests__/kanban-store.test.ts`

Add these methods (place each near a sibling: queries near `readyTasks`/`unassignedReadyTasks`; the CAS near `claimForAssign`; attempt mutators near `clearFailures`; rollup edits in `featureRollup`/`listFeatureTasks`).

- [ ] **Step 1: Write failing tests** in `kanban-store.test.ts`:

```typescript
it('reviewWorktreeFeatureTasks returns only review + worktree + featured + non-system tasks', () => {
  const f = store.createFeature({ boardId: 'default', name: 'F' });
  const a = store.createTask({ title: 'a', featureId: f.id, workspaceKind: 'worktree' });
  store.setWorkspace(a.id, '/tmp/a', 'br-a', 'main');
  store.reviewTask(a.id, null);
  // excluded: no feature
  const b = store.createTask({ title: 'b', workspaceKind: 'worktree' });
  store.setWorkspace(b.id, '/tmp/b', 'br-b', 'main');
  store.reviewTask(b.id, null);
  // excluded: system task
  const sys = store.createTask({ title: 's', featureId: f.id, workspaceKind: 'worktree', systemKind: 'feature_sync' });
  store.setWorkspace(sys.id, '/tmp/s', 'br-s', 'main');
  store.reviewTask(sys.id, null);
  const ids = store.reviewWorktreeFeatureTasks().map((t) => t.id);
  expect(ids).toEqual([a.id]);
});

it('claimForResolve atomically moves a review task to running', () => {
  const t = store.createTask({ title: 'x', workspaceKind: 'worktree' });
  store.reviewTask(t.id, null);
  expect(store.claimForResolve(t.id, 'L1', 1000)).toBe(true);
  expect(store.getTask(t.id)!.status).toBe('running');
  // second claim loses (already running)
  expect(store.claimForResolve(t.id, 'L2', 1000)).toBe(false);
});

it('increment/reset resolve attempts', () => {
  const t = store.createTask({ title: 'x' });
  store.incrementResolveAttempts(t.id);
  store.incrementResolveAttempts(t.id);
  expect(store.getTask(t.id)!.resolveAttempts).toBe(2);
  store.resetResolveAttempts(t.id);
  expect(store.getTask(t.id)!.resolveAttempts).toBe(0);
});

it('openSystemTask finds a non-terminal feature_sync task for a feature', () => {
  const f = store.createFeature({ boardId: 'default', name: 'F' });
  expect(store.openSystemTask(f.id, 'feature_sync')).toBeNull();
  const sys = store.createTask({ title: 's', featureId: f.id, systemKind: 'feature_sync', status: 'review' });
  expect(store.openSystemTask(f.id, 'feature_sync')?.id).toBe(sys.id);
  store.completeTask(sys.id, null);
  expect(store.openSystemTask(f.id, 'feature_sync')).toBeNull(); // done = terminal
});

it('featureRollup and listFeatureTasks exclude system tasks', () => {
  const f = store.createFeature({ boardId: 'default', name: 'F' });
  const a = store.createTask({ title: 'a', featureId: f.id, status: 'done' });
  store.createTask({ title: 's', featureId: f.id, systemKind: 'feature_sync', status: 'running' });
  expect(store.featureRollup(f.id).total).toBe(1);
  expect(store.featureRollup(f.id).done).toBe(1);
  expect(store.listFeatureTasks(f.id).map((t) => t.id)).toEqual([a.id]);
});
```

> Confirm the real signatures of `createFeature`/`setWorkspace`/`reviewTask` in `kanban-store.ts` and adapt the test calls to match (the snippets above assume `createFeature({ boardId, name })` and `setWorkspace(id, path, branch, base)` — fix if the actual API differs).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts -t 'resolve|reviewWorktreeFeature|openSystemTask|exclude system'`
Expected: FAIL — methods not defined.

- [ ] **Step 3: Add `reviewWorktreeFeatureTasks`** (near `readyTasks`):

```typescript
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
```

- [ ] **Step 4: Add `claimForResolve`** (near `claimForAssign`), atomic CAS `review → running`:

```typescript
/** Atomically claim a review task for a resolve run (review → running). Returns false if it lost the race. */
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
```

- [ ] **Step 5: Add attempt mutators** (near `clearFailures`):

```typescript
incrementResolveAttempts(taskId: string): void {
  this.db
    .prepare('UPDATE tasks SET resolve_attempts = resolve_attempts + 1, updated_at=? WHERE id=?')
    .run(this.now(), taskId);
}

resetResolveAttempts(taskId: string): void {
  this.db.prepare('UPDATE tasks SET resolve_attempts = 0, updated_at=? WHERE id=?').run(this.now(), taskId);
}
```

- [ ] **Step 6: Add `openSystemTask`** (near `listFeatureTasks`):

```typescript
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
```

- [ ] **Step 7: Exclude system tasks from roll-ups.** In `featureRollup` add `AND system_kind IS NULL` to the `WHERE feature_id=?` clause. In `listFeatureTasks` add the same to its `WHERE feature_id=?`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/main/kanban/kanban-store.ts src/main/__tests__/kanban-store.test.ts
git commit -m "feat(kanban): store queries for integrate/resolve + system-task rollup exclusion"
```

---

## Task 4: `resolve` run plumbing — spawn-worker prompt + tool gate

**Files:**
- Modify: `src/main/kanban/spawn-worker.ts` (`BuildWorkerInput`, `buildPrompt`, `requireToolsForMode`)
- Test: `src/main/__tests__/kanban-spawn-worker.test.ts`

The resolve worker merges a target branch into its own worktree, resolves conflicts, verifies, commits, and completes. It needs to know the **target branch**, passed via a new optional `resolveTarget` on `BuildWorkerInput` (computed by the caller in Task 6).

- [ ] **Step 1: Write failing tests** in `kanban-spawn-worker.test.ts` (mirror the existing assign-mode tests in this file):

```typescript
it('resolve mode prompt instructs merging the target branch and completing', () => {
  const out = buildWorkerInvocation({
    ...baseInput,
    mode: 'resolve',
    resolveTarget: 'fleet/feature-abc',
    task: { ...baseInput.task, id: 'T1', title: 'Fix X', body: '' }
  });
  expect(out.args.join(' ')).toContain('fleet/feature-abc');
  expect(out.args.join(' ')).toMatch(/resolve/i);
});

it('resolve mode requires kanban_complete', () => {
  const out = buildWorkerInvocation({ ...baseInput, mode: 'resolve', resolveTarget: 'main' });
  const i = out.args.indexOf('--require-tool');
  expect(i).toBeGreaterThan(-1);
  expect(out.args[i + 1]).toContain('kanban_complete');
});
```

> Adapt `baseInput`/`buildWorkerInvocation` to the real harness in this test file (find how the existing `assign`/`work` tests build their input).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-spawn-worker.test.ts -t 'resolve'`
Expected: FAIL.

- [ ] **Step 3: Add `resolveTarget` to `BuildWorkerInput`** (find the interface in `spawn-worker.ts`): add `resolveTarget?: string;` with a comment `/** Branch to merge into the worktree for a resolve run (integration branch, or base for a feature_sync task). */`.

- [ ] **Step 4: Add the resolve branch to `buildPrompt`** (after the `if (mode === 'assign')` block, before the final `work` return):

```typescript
if (mode === 'resolve') {
  const target = input.resolveTarget ?? task.baseBranch ?? 'the base branch';
  return (
    `resolve merge conflicts for kanban task ${task.id}: ${task.title}\n\n${task.body}\n\n` +
    `Merge \`${target}\` into your current branch. Resolve every conflict, preserving the intent of ` +
    `both sides. Verify your resolution (run the project's typecheck/build per the board docs if present). ` +
    `Commit the merge. Then call kanban_complete with a one-line summary. If the conflicts cannot be ` +
    `resolved safely, call kanban_block with the reason instead.`
  );
}
```

- [ ] **Step 5: Add the resolve case to `requireToolsForMode`** — add to the `case 'work':`/`case 'decompose':` group so it returns `'kanban_complete,kanban_block'`:

```typescript
case 'work':
case 'decompose':
case 'resolve':
  return 'kanban_complete,kanban_block';
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run src/main/__tests__/kanban-spawn-worker.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/kanban/spawn-worker.ts src/main/__tests__/kanban-spawn-worker.test.ts
git commit -m "feat(kanban): resolve-mode worker prompt + terminal tool"
```

---

## Task 5: MCP tool gating for `resolve`

**Files:**
- Modify: `src/main/kanban/kanban-mcp-server.ts` (`RESOLVE_TOOLS`, `toolsForMode`)
- Test: `src/main/__tests__/kanban-mcp-server.test.ts`

Resolve tools per spec §2: `kanban_show`, `kanban_comment`, `kanban_heartbeat`, `kanban_complete`, `kanban_block`. All already exist in `WORKER_TOOLS`.

- [ ] **Step 1: Write a failing test** in `kanban-mcp-server.test.ts` (find how existing tests assert `toolsForMode`/exposed tools; if `toolsForMode` is not exported, assert via the same mechanism the assign-mode test uses — e.g. listing tools for a registered resolve run):

```typescript
it('resolve mode exposes show/comment/heartbeat/complete/block and not kanban_create', () => {
  const names = toolNamesForMode('resolve'); // use the file's existing test accessor
  expect(names).toEqual(expect.arrayContaining(['kanban_show','kanban_comment','kanban_heartbeat','kanban_complete','kanban_block']));
  expect(names).not.toContain('kanban_create');
  expect(names).not.toContain('kanban_assign');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-mcp-server.test.ts -t 'resolve mode exposes'`
Expected: FAIL — resolve falls through to `WORKER_TOOLS` (which may include `kanban_create`/`kanban_artifact`), so the negative assertions fail.

- [ ] **Step 3: Add `RESOLVE_TOOLS`** (after `ASSIGN_TOOLS`, ~line 244), built by filtering `WORKER_TOOLS` to the five names:

```typescript
const RESOLVE_TOOLS: McpTool[] = WORKER_TOOLS.filter((t) =>
  ['kanban_show', 'kanban_comment', 'kanban_heartbeat', 'kanban_complete', 'kanban_block'].includes(t.name)
);
```

- [ ] **Step 4: Add the branch to `toolsForMode`** (line ~422): after `if (mode === 'assign') return ASSIGN_TOOLS;` add `if (mode === 'resolve') return RESOLVE_TOOLS;`.

- [ ] **Step 5: Verify the `kanban_complete` handler routes a resolve run to `review`.** Find the `kanban_complete` handler. It calls `reviewTask` for worktree tasks (→ `review`) and must **not** prune the worktree (the worktree is needed for the retry merge). Confirm this is already the case — if `kanban_complete` special-cases by run mode, ensure `resolve` lands in the same `review` path as `work`. Add a regression test asserting a resolve-run `kanban_complete` leaves the task in `review`:

```typescript
it('kanban_complete on a resolve run returns the task to review', async () => {
  // register a resolve run for a worktree task, call kanban_complete, assert status === 'review'
  // (mirror the existing kanban_complete test setup, with mode: 'resolve')
});
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run src/main/__tests__/kanban-mcp-server.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/kanban/kanban-mcp-server.ts src/main/__tests__/kanban-mcp-server.test.ts
git commit -m "feat(kanban): MCP resolve-mode tool gating"
```

---

## Task 6: Dispatcher — integration deps seam + `spawnResolve` + `index.ts` resolve wiring

**Files:**
- Modify: `src/main/kanban/kanban-dispatcher.ts` (consts, `DispatcherDeps.integration`, `spawnResolve`)
- Modify: `src/main/index.ts` (`spawnWorker` resolve branch: worker profile + `resolveTarget`)
- Test: `src/main/__tests__/kanban-dispatcher.test.ts`

The dispatcher's git ops become an injectable bag so `integrate()` is unit-testable with fakes. In production the bag defaults to the real `workspace.ts` imports, so `index.ts` needs no new wiring for the ops.

- [ ] **Step 1: Write failing tests** in `kanban-dispatcher.test.ts`. Add a `fakeIntegration` helper near `baseConfig` and tests for `spawnResolve` via a thin public entry (`requestResolve`, added here and reused in Task 8):

```typescript
function fakeIntegration(over: Partial<IntegrationOps> = {}): IntegrationOps {
  return {
    ensureFeatureBranch: () => ({ ok: true }),
    checkMergeConflicts: () => ({ state: 'clean', files: [] }),
    mergeWorktreeToBase: () => ({ ok: true }),
    updateIntegrationBranchFromMain: () => ({ ok: true, alreadyUpToDate: true }),
    removeWorktree: () => ({ branchKept: false }),
    isBranchMerged: () => false,
    ...over
  };
}

it('requestResolve spawns a resolve run and increments attempts', () => {
  const clock = { t: 1000 };
  const store = makeStore(clock);
  const t = store.createTask({ title: 'x', workspaceKind: 'worktree' });
  store.setWorkspace(t.id, '/tmp/x', 'br-x', 'main');
  store.reviewTask(t.id, null);
  const spawned: SpawnWorkerArgs[] = [];
  const disp = new KanbanDispatcher(store, {
    now: () => clock.t, isAlive: () => true,
    spawnWorker: (a) => { spawned.push(a); return 4242; },
    config: { ...baseConfig, autoIntegrate: true },
    integration: fakeIntegration()
  });
  disp.requestResolve(t.id);
  expect(spawned[0]?.mode).toBe('resolve');
  expect(store.getTask(t.id)!.status).toBe('running');
  expect(store.getTask(t.id)!.resolveAttempts).toBe(1);
  store.close();
});

it('requestResolve blocks past the attempt cap instead of spawning', () => {
  const clock = { t: 1000 };
  const store = makeStore(clock);
  const t = store.createTask({ title: 'x', workspaceKind: 'worktree' });
  store.setWorkspace(t.id, '/tmp/x', 'br-x', 'main');
  store.reviewTask(t.id, null);
  store.incrementResolveAttempts(t.id);
  store.incrementResolveAttempts(t.id); // at cap (2)
  const spawned: SpawnWorkerArgs[] = [];
  const disp = new KanbanDispatcher(store, {
    now: () => clock.t, isAlive: () => true,
    spawnWorker: (a) => { spawned.push(a); return 1; },
    config: { ...baseConfig, autoIntegrate: true },
    integration: fakeIntegration()
  });
  disp.requestResolve(t.id);
  expect(spawned).toHaveLength(0);
  expect(store.getTask(t.id)!.status).toBe('blocked');
  store.close();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts -t 'requestResolve'`
Expected: FAIL — `requestResolve`/`integration` not defined.

- [ ] **Step 3: Add imports + an `IntegrationOps` type + constants** in `kanban-dispatcher.ts`. Extend the existing `workspace` import:

```typescript
import {
  finalizeWorktree, isBranchMerged, removeWorktree,
  ensureFeatureBranch, checkMergeConflicts, mergeWorktreeToBase, updateIntegrationBranchFromMain
} from './workspace';
```

Add (near the other module consts):

```typescript
/** Resolve runs attempted per task before it is blocked. Tracked in tasks.resolve_attempts (independent of failureLimit). */
const RESOLVE_ATTEMPT_CAP = 2;
/** Max task merges + resolve spawns processed per integrate() tick, so the tick stays fast. */
const MAX_INTEGRATE_PER_TICK = 3;

/** Git ops used by integrate(); injectable so the stage is unit-testable. Defaults to the real workspace.ts fns. */
export interface IntegrationOps {
  ensureFeatureBranch: typeof ensureFeatureBranch;
  checkMergeConflicts: typeof checkMergeConflicts;
  mergeWorktreeToBase: typeof mergeWorktreeToBase;
  updateIntegrationBranchFromMain: typeof updateIntegrationBranchFromMain;
  removeWorktree: typeof removeWorktree;
  isBranchMerged: typeof isBranchMerged;
}

const DEFAULT_INTEGRATION_OPS: IntegrationOps = {
  ensureFeatureBranch, checkMergeConflicts, mergeWorktreeToBase,
  updateIntegrationBranchFromMain, removeWorktree, isBranchMerged
};
```

Add `integration?: IntegrationOps;` to `DispatcherDeps` (optional; comment: `/** Git ops for integrate(); injected in tests, defaults to real workspace.ts fns. */`).

Add a private accessor on the class: `private get ops(): IntegrationOps { return this.deps.integration ?? DEFAULT_INTEGRATION_OPS; }`

- [ ] **Step 4: Add `integrationBranchFor(task)` + `resolveTargetFor(task)` private helpers** on the dispatcher (used by spawnResolve and integrate):

```typescript
/** The feature integration branch a task merges into (or null for a standalone task). */
private integrationBranchFor(featureId: string | null): string | null {
  if (!featureId) return null;
  const f = this.store.getFeature(featureId);
  if (!f) return null;
  return f.integrationBranch ?? `fleet/feature-${f.id}`;
}
```

- [ ] **Step 5: Add `spawnResolve` + public `requestResolve`.** `spawnResolve` is the shared engine (used by `integrateTasks`, `integrateFeatures`, and `requestResolve`):

```typescript
/**
 * Spawn a resolve run for a review task (or block it past the cap). Returns true if a run was spawned.
 * The worker merges `target` into the task's worktree, resolves, commits, and completes (→ review).
 */
private spawnResolve(task: Task, target: string): boolean {
  const attempts = task.resolveAttempts ?? 0;
  if (attempts >= RESOLVE_ATTEMPT_CAP) {
    const note = `merge conflicts unresolved after ${RESOLVE_ATTEMPT_CAP} resolve attempt(s)`;
    this.store.blockTask(task.id, note);
    this.store.appendEvent(task.id, null, 'blocked', { reason: note });
    log.warn('resolve gave up', { taskId: task.id, attempts });
    return false;
  }
  const lock = this.nextLock();
  if (!this.store.claimForResolve(task.id, lock, this.deps.config.claimTtlMs)) return false; // lost race
  let runId: number | null = null;
  try {
    const workspace = task.workspacePath ?? '';
    const run = this.store.startRun(task.id, task.assignee ?? 'worker', null, 'resolve');
    runId = run.id;
    this.store.incrementResolveAttempts(task.id);
    const pid = this.deps.spawnWorker({ task, runId: run.id, lock, workspace, mode: 'resolve' });
    if (pid != null) this.store.setWorkerPid(task.id, run.id, pid);
    this.store.appendEvent(task.id, run.id, 'spawned', { pid: pid ?? null, mode: 'resolve', target, attempt: attempts + 1 });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    this.store.recordFailure(task.id, msg);
    if (runId != null) this.store.finishRun(runId, 'spawn_failed', { error: msg });
    this.store.appendEvent(task.id, runId, 'spawn_failed', { error: msg, mode: 'resolve' });
    this.store.setStatusCleared(task.id, 'review'); // hand back to review so a later tick retries
    log.error('resolve spawn failed', { taskId: task.id, error: msg });
    return false;
  }
}

/**
 * Public entry for the standalone manual-merge-conflict path (KanbanCommands.mergeReviewTask).
 * Resolves against the task's merge target (its integration branch for a feature task, else its base).
 */
requestResolve(taskId: string): boolean {
  const task = this.store.getTask(taskId);
  if (!task || task.status !== 'review') return false;
  const target = this.integrationBranchFor(task.featureId) ?? task.baseBranch;
  if (!target) return false;
  return this.spawnResolve(task, target);
}
```

- [ ] **Step 6: Wire the `index.ts` `spawnWorker` resolve branch.** In `src/main/index.ts` `spawnWorker` (line ~931), `resolve` must run under a **worker** profile (it writes code) and receive a `resolveTarget`:
  - Change the profile-selection condition from `if (mode === 'work')` to `if (mode === 'work' || mode === 'resolve')` so resolve uses `resolveWorkProfile(profiles, task.assignee)` (the worker persona that calls `kanban_complete`).
  - Before building the worker invocation, compute the target:

```typescript
let resolveTarget: string | undefined;
if (mode === 'resolve') {
  if (task.systemKind === 'feature_sync') {
    // The system task's branch IS the integration branch; merge main (base) into it.
    resolveTarget = task.baseBranch ?? undefined;
  } else if (task.featureId) {
    const f = kanbanStore!.getFeature(task.featureId);
    resolveTarget = (f?.integrationBranch ?? (f ? `fleet/feature-${f.id}` : undefined)) ?? undefined;
  } else {
    resolveTarget = task.baseBranch ?? undefined;
  }
}
```

  - Pass `resolveTarget` into the object handed to `buildWorkerInvocation`.
  - The `if (mode !== 'assign')` orchestrator-assignee write is in the `else` (orchestrator) branch; since resolve now takes the work-like branch, it won't overwrite the assignee. Confirm this.

- [ ] **Step 7: Run tests + typecheck**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/kanban/kanban-dispatcher.ts src/main/index.ts src/main/__tests__/kanban-dispatcher.test.ts
git commit -m "feat(kanban): dispatcher spawnResolve + integration deps seam + index resolve wiring"
```

---

## Task 7: Dispatcher — `integrateTasks()` (task-level auto-merge)

**Files:**
- Modify: `src/main/kanban/kanban-dispatcher.ts` (`integrate`, `integrateTasks`, `tick`)
- Test: `src/main/__tests__/kanban-dispatcher.test.ts`

- [ ] **Step 1: Write failing tests** in `kanban-dispatcher.test.ts`:

```typescript
function reviewFeatureTask(store: KanbanStore) {
  const f = store.createFeature({ boardId: 'default', name: 'F' });
  store.updateFeature(f.id, { integrationBranch: `fleet/feature-${f.id}`, repoPath: '/repo', baseBranch: 'main' });
  const t = store.createTask({ title: 't', featureId: f.id, workspaceKind: 'worktree', repoPath: '/repo', baseBranch: 'main' });
  store.setWorkspace(t.id, '/tmp/t', 'br-t', 'main');
  store.reviewTask(t.id, null);
  return { f, t };
}

it('integrate: clean feature task → merged, done, pruned, attempts reset', () => {
  const clock = { t: 1000 };
  const store = makeStore(clock);
  const { t } = reviewFeatureTask(store);
  const disp = new KanbanDispatcher(store, {
    now: () => clock.t, isAlive: () => true, spawnWorker: () => 1,
    config: { ...baseConfig, autoIntegrate: true },
    integration: fakeIntegration({ checkMergeConflicts: () => ({ state: 'clean', files: [] }), mergeWorktreeToBase: () => ({ ok: true }) })
  });
  disp.integrate();
  const got = store.getTask(t.id)!;
  expect(got.status).toBe('done');
  expect(got.worktreePruned).toBe(true);
  expect(got.resolveAttempts).toBe(0);
  store.close();
});

it('integrate: conflicting feature task → resolve run spawned (not merged)', () => {
  const clock = { t: 1000 };
  const store = makeStore(clock);
  const { t } = reviewFeatureTask(store);
  const spawned: SpawnWorkerArgs[] = [];
  const disp = new KanbanDispatcher(store, {
    now: () => clock.t, isAlive: () => true, spawnWorker: (a) => { spawned.push(a); return 7; },
    config: { ...baseConfig, autoIntegrate: true },
    integration: fakeIntegration({ checkMergeConflicts: () => ({ state: 'conflicts', files: ['a.ts'] }) })
  });
  disp.integrate();
  expect(spawned[0]?.mode).toBe('resolve');
  expect(store.getTask(t.id)!.status).toBe('running');
  store.close();
});

it('integrate: autoIntegrate off → no-op', () => {
  const clock = { t: 1000 };
  const store = makeStore(clock);
  const { t } = reviewFeatureTask(store);
  const disp = new KanbanDispatcher(store, {
    now: () => clock.t, isAlive: () => true, spawnWorker: () => 1,
    config: { ...baseConfig, autoIntegrate: false }, integration: fakeIntegration()
  });
  disp.integrate();
  expect(store.getTask(t.id)!.status).toBe('review');
  store.close();
});

it('integrate: conflicting task at the resolve cap → blocked', () => {
  const clock = { t: 1000 };
  const store = makeStore(clock);
  const { t } = reviewFeatureTask(store);
  store.incrementResolveAttempts(t.id);
  store.incrementResolveAttempts(t.id); // at cap
  const disp = new KanbanDispatcher(store, {
    now: () => clock.t, isAlive: () => true, spawnWorker: () => 1,
    config: { ...baseConfig, autoIntegrate: true },
    integration: fakeIntegration({ checkMergeConflicts: () => ({ state: 'conflicts', files: ['a.ts'] }) })
  });
  disp.integrate();
  expect(store.getTask(t.id)!.status).toBe('blocked');
  store.close();
});
```

> Confirm `createFeature`/`updateFeature` signatures; adapt the helper to the real API. `updateFeature` must accept `repoPath`/`baseBranch`/`integrationBranch` (see `UpdateFeatureInput`).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts -t 'integrate:'`
Expected: FAIL — `integrate` not defined.

- [ ] **Step 3: Implement `integrate` + `integrateTasks`:**

```typescript
/** Auto-integrate completed feature tasks and sync completed features. Local git only — no push/PR (that is #229). */
integrate(): void {
  if (!this.deps.config.autoIntegrate) return;
  const budget = this.integrateTasks(MAX_INTEGRATE_PER_TICK);
  this.integrateFeatures(budget); // Task 8
}

/** Merge each review feature task into its integration branch; spawn a resolve run on conflict. Returns remaining budget. */
private integrateTasks(budget: number): number {
  for (const task of this.store.reviewWorktreeFeatureTasks()) {
    if (budget <= 0) break;
    if (!task.repoPath || !task.branchName || !task.baseBranch || !task.workspacePath) continue;
    const integrationBranch = this.integrationBranchFor(task.featureId);
    if (!integrationBranch) continue;

    const ensured = this.ops.ensureFeatureBranch({
      repoPath: task.repoPath, integrationBranch, baseBranch: task.baseBranch
    });
    if (!ensured.ok) {
      this.store.appendEvent(task.id, null, 'merge_failed', { base: integrationBranch, error: ensured.error });
      continue;
    }

    const pred = this.ops.checkMergeConflicts({
      repoPath: task.repoPath, baseBranch: integrationBranch, branchName: task.branchName
    });
    if (pred.state === 'error') continue; // can't predict — leave in review for a human
    if (pred.state === 'conflicts') {
      if (this.spawnResolve(task, integrationBranch)) budget -= 1;
      continue;
    }
    // clean prediction → real merge into the (local) integration branch
    const res = this.ops.mergeWorktreeToBase({
      repoPath: task.repoPath, branchName: task.branchName, baseBranch: integrationBranch,
      worktreeParentDir: dirname(task.workspacePath), taskId: task.id, title: task.title
    });
    if (res.ok) {
      this.store.completeTask(task.id, task.result);
      this.store.appendEvent(task.id, null, 'merged', { base: integrationBranch, branch: task.branchName, by: 'integrate' });
      this.ops.removeWorktree({
        repoPath: task.repoPath, workspacePath: task.workspacePath,
        branchName: task.branchName, baseBranch: integrationBranch
      });
      this.store.setWorktreePruned(task.id);
      this.store.appendEvent(task.id, null, 'worktree_pruned', { branch: task.branchName, by: 'integrate' });
      this.store.resetResolveAttempts(task.id);
      budget -= 1;
    } else if (res.conflict) {
      // prediction raced (clean → dirty); fall back to a resolve run
      if (this.spawnResolve(task, integrationBranch)) budget -= 1;
    } else {
      this.store.appendEvent(task.id, null, 'merge_failed', { base: integrationBranch, error: res.error });
    }
  }
  return budget;
}
```

- [ ] **Step 4: Add the `dirname` import** at the top of `kanban-dispatcher.ts`: `import { dirname } from 'path';`

- [ ] **Step 5: Add a temporary `integrateFeatures` stub** so this task typechecks/tests in isolation (replaced fully in Task 8):

```typescript
private integrateFeatures(_budget: number): void { /* implemented in Task 8 */ }
```

- [ ] **Step 6: Wire into `tick()`** — add `this.integrate();` after `this.claimAndSpawn();` and before `this.sweepArtifacts();`:

```typescript
tick(): void {
  this.reclaim();
  this.fireSchedules();
  this.decompose();
  this.autoAssign();
  this.promote();
  this.claimAndSpawn();
  this.integrate();
  this.sweepArtifacts();
  this.sweepMergedWorktrees();
}
```

- [ ] **Step 7: Run tests + typecheck**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/kanban/kanban-dispatcher.ts src/main/__tests__/kanban-dispatcher.test.ts
git commit -m "feat(kanban): integrate() task-level auto-merge + resolve dispatch"
```

---

## Task 8: Dispatcher — `integrateFeatures()` (completion sync + feature-sync system task)

**Files:**
- Modify: `src/main/kanban/kanban-dispatcher.ts` (replace the `integrateFeatures` stub; add `createFeatureSyncTask`)
- Test: `src/main/__tests__/kanban-dispatcher.test.ts`

Behavior: for each `active` feature whose member tasks (system tasks excluded) are all `done`/`archived` and whose integration branch is ahead of base (something merged), sync the integration branch with main. Clean → done (mark `mergeState='in_progress'` so it fires once); conflict → a `feature_sync` system task dispatched in resolve mode. A running/blocked system task gates re-entry.

- [ ] **Step 1: Write failing tests** in `kanban-dispatcher.test.ts`:

```typescript
function doneFeature(store: KanbanStore) {
  const f = store.createFeature({ boardId: 'default', name: 'F' });
  store.updateFeature(f.id, { integrationBranch: `fleet/feature-${f.id}`, repoPath: '/repo', baseBranch: 'main' });
  const a = store.createTask({ title: 'a', featureId: f.id, status: 'done', repoPath: '/repo', baseBranch: 'main' });
  return { f, a };
}

it('integrateFeatures: all done + clean sync → no system task, fires once', () => {
  const clock = { t: 1000 };
  const store = makeStore(clock);
  const { f } = doneFeature(store);
  let syncCalls = 0;
  const disp = new KanbanDispatcher(store, {
    now: () => clock.t, isAlive: () => true, spawnWorker: () => 1,
    config: { ...baseConfig, autoIntegrate: true },
    integration: fakeIntegration({
      isBranchMerged: () => false, // integration ahead of base → something merged
      updateIntegrationBranchFromMain: () => { syncCalls++; return { ok: true }; }
    })
  });
  disp.integrate();
  disp.integrate(); // second tick must NOT re-sync
  expect(syncCalls).toBe(1);
  expect(store.openSystemTask(f.id, 'feature_sync')).toBeNull();
  store.close();
});

it('integrateFeatures: sync conflict → feature_sync system task spawned in resolve mode', () => {
  const clock = { t: 1000 };
  const store = makeStore(clock);
  const { f } = doneFeature(store);
  const spawned: SpawnWorkerArgs[] = [];
  const disp = new KanbanDispatcher(store, {
    now: () => clock.t, isAlive: () => true, spawnWorker: (a) => { spawned.push(a); return 9; },
    config: { ...baseConfig, autoIntegrate: true },
    integration: fakeIntegration({ isBranchMerged: () => false, updateIntegrationBranchFromMain: () => ({ ok: false, conflict: true }) })
  });
  disp.integrate();
  const sys = store.openSystemTask(f.id, 'feature_sync');
  expect(sys).not.toBeNull();
  expect(sys!.systemKind).toBe('feature_sync');
  expect(spawned[0]?.mode).toBe('resolve');
  expect(store.featureRollup(f.id).total).toBe(1); // system task excluded
  store.close();
});

it('integrateFeatures: nothing merged (integration == base) → skip', () => {
  const clock = { t: 1000 };
  const store = makeStore(clock);
  const { f } = doneFeature(store);
  let syncCalls = 0;
  const disp = new KanbanDispatcher(store, {
    now: () => clock.t, isAlive: () => true, spawnWorker: () => 1,
    config: { ...baseConfig, autoIntegrate: true },
    integration: fakeIntegration({ isBranchMerged: () => true, updateIntegrationBranchFromMain: () => { syncCalls++; return { ok: true }; } })
  });
  disp.integrate();
  expect(syncCalls).toBe(0);
  store.close();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts -t 'integrateFeatures'`
Expected: FAIL — stub is a no-op.

- [ ] **Step 3: Replace the stub** with the real `integrateFeatures` + `createFeatureSyncTask`:

```typescript
/** Sync each fully-done feature's integration branch with main; spawn a feature_sync resolve task on conflict. */
private integrateFeatures(budget: number): void {
  for (const feature of this.store.listFeatures({ status: 'active' })) {
    if (budget <= 0) break;
    if (!feature.repoPath || !feature.baseBranch) continue;
    const integrationBranch = feature.integrationBranch ?? `fleet/feature-${feature.id}`;

    const rollup = this.store.featureRollup(feature.id); // system tasks already excluded
    const allDone = rollup.total > 0 && rollup.done + rollup.archived === rollup.total;
    if (!allDone) continue;

    // Only act once integration actually contains merged work (branch ahead of base).
    if (this.ops.isBranchMerged({ repoPath: feature.repoPath, branchName: integrationBranch, baseBranch: feature.baseBranch })) {
      continue;
    }

    const open = this.store.openSystemTask(feature.id, 'feature_sync');
    if (open?.status === 'running') continue; // a resolve is already in flight

    // Fire-once guard for the clean path: 'in_progress' means "integration synced, awaiting #229 ship".
    if (!open && (feature.mergeState === 'in_progress' || feature.mergeState === 'merged')) continue;

    const sync = this.ops.updateIntegrationBranchFromMain({
      repoPath: feature.repoPath, integrationBranch, baseBranch: feature.baseBranch
    });

    if (sync.ok) {
      if (open) { // a prior conflict was resolved by the system task → close it out
        this.store.completeTask(open.id, 'synced with main');
        this.store.appendEvent(open.id, null, 'merged', { base: feature.baseBranch, by: 'feature_sync' });
      }
      this.store.updateFeature(feature.id, { mergeState: 'in_progress' });
    } else if (sync.conflict) {
      this.store.updateFeature(feature.id, { mergeState: 'conflict' });
      const target = feature.baseBranch;
      if (open?.status === 'review') {
        if (this.spawnResolve(open, target)) budget -= 1;
      } else if (!open) {
        const sys = this.createFeatureSyncTask(feature, integrationBranch);
        if (sys && this.spawnResolve(sys, target)) budget -= 1;
      }
    }
    // sync error (e.g. base not found): leave for next tick
  }
}

/**
 * Create the synthetic system task whose worktree checks out the integration branch itself,
 * so a resolve run can merge main into it. Excluded from feature roll-ups via system_kind.
 */
private createFeatureSyncTask(feature: Feature, integrationBranch: string): Task | null {
  if (!feature.repoPath || !feature.baseBranch) return null;
  const task = this.store.createTask({
    title: `Sync ${feature.name} with main`,
    body: `Merge ${feature.baseBranch} into ${integrationBranch} and resolve any conflicts so the feature can ship.`,
    status: 'review', // spawnResolve claims from review
    boardId: feature.boardId,
    featureId: feature.id,
    systemKind: 'feature_sync',
    workspaceKind: 'worktree',
    repoPath: feature.repoPath,
    branchName: integrationBranch, // the worktree checks out the integration branch
    baseBranch: feature.baseBranch
  });
  // The system task's worktree must check out the integration branch. prepareWorkspaceFn
  // (index.ts) branches from branchName when workspace_path is null; persist the intended branch now.
  this.store.appendEvent(task.id, null, 'task_created', { by: 'dispatcher', system: 'feature_sync' });
  return task;
}
```

- [ ] **Step 4: Add the `Feature` type import** to `kanban-dispatcher.ts`: extend the `kanban-types` import to include `Feature` (and `Task` is already imported).

- [ ] **Step 5: Verify the system task's worktree is created on the integration branch.** The system task has `workspacePath == null`, so when `spawnResolve` calls `spawnWorker`, `index.ts` `prepareWorkspaceFn` runs first (in the dispatcher's `claimAndSpawn`? No — resolve bypasses prepareWorkspaceFn). **Important:** `spawnResolve` passes `workspace: task.workspacePath ?? ''`. For a freshly-created system task that is empty. The system task needs its worktree prepared. Handle this in `spawnResolve`: if `task.workspacePath == null` and `this.deps.prepareWorkspaceFn` exists, call it to create the worktree first, then use the returned path. Update `spawnResolve` Step 5 (Task 6) accordingly:

```typescript
// inside spawnResolve, replace `const workspace = task.workspacePath ?? '';` with:
let workspace = task.workspacePath ?? '';
if (!workspace && this.deps.prepareWorkspaceFn) {
  workspace = this.deps.prepareWorkspaceFn(task); // creates the worktree on task.branchName
}
```

  `prepareWorkspace` (index.ts) uses `startPoint: task.baseBranch ?? featureStartPoint` and `branchName: task.branchName`. For the system task, `branchName` is the integration branch (an existing branch), so prepareWorkspace checks it out. Confirm `prepareWorkspace` checks out an existing `branchName` rather than erroring. If it always creates a new branch, the system-task worktree setup needs `prepareWorkspace` to support an existing branch — verify in `workspace.ts prepareWorkspace` and adjust the plan note if needed. (In tests, `prepareWorkspaceFn` is absent, so the fake path `''` is used and `spawnWorker` is the injected fake — the worktree mechanics are exercised manually, not in unit tests.)

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/kanban/kanban-dispatcher.ts src/main/__tests__/kanban-dispatcher.test.ts
git commit -m "feat(kanban): integrateFeatures() completion sync + feature_sync system task"
```

---

## Task 9: Standalone manual-merge → resolve

**Files:**
- Modify: `src/main/kanban/kanban-commands.ts` (`mergeReviewTask` conflict branch)
- Test: `src/main/__tests__/kanban-commands.test.ts`

When the human clicks "Merge to base" on a standalone (or feature) worktree task and the merge **conflicts**, spawn a resolve run instead of only commenting. `KanbanCommands` already holds `this.dispatcher` (it calls `this.dispatcher.tick()`).

- [ ] **Step 1: Write a failing test** in `kanban-commands.test.ts`. Find how this file constructs `KanbanCommands` with a dispatcher (or a stub). Stub `dispatcher.requestResolve` and assert it is called on a conflicting merge:

```typescript
it('mergeReviewTask on conflict requests a resolve run', () => {
  // Arrange a review worktree task whose mergeWorktreeToBase returns { ok:false, conflict:true }.
  // (mock the workspace merge fn the same way other commands tests stub git, OR point repoPath at a
  //  fixture that conflicts — follow the existing pattern in this file.)
  const calls: string[] = [];
  commands.setDispatcher({ tick: () => {}, requestResolve: (id: string) => { calls.push(id); return true; } } as unknown as KanbanDispatcher);
  const res = commands.mergeReviewTask(task.id);
  expect(res.ok).toBe(false);
  expect(res.conflict).toBe(true);
  expect(calls).toEqual([task.id]);
});
```

> Match the file's actual dispatcher-injection mechanism (constructor arg, a setter, or a stub object). If conflicts are hard to simulate via real git in this test file, follow whatever stubbing the existing `mergeReviewTask` tests use.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-commands.test.ts -t 'requests a resolve'`
Expected: FAIL — no `requestResolve` call.

- [ ] **Step 3: Update `mergeReviewTask`'s conflict branch** (kanban-commands.ts:656-665). In the `if (!result.ok)` block, when `result.conflict` is true, after the existing comment + `merge_failed` event, request a resolve run:

```typescript
if (!result.ok) {
  const reason = result.conflict
    ? `merge conflict against ${task.baseBranch}; spawning a resolve run`
    : (result.error ?? 'merge failed');
  this.store.addComment(id, 'human', `merge to ${task.baseBranch} failed: ${reason}`);
  this.store.appendEvent(id, null, 'merge_failed', { base: task.baseBranch, conflict: !!result.conflict });
  if (result.conflict) this.dispatcher.requestResolve(id);
  return { ok: false, conflict: result.conflict, error: reason };
}
```

(The task is still in `review` when `mergeReviewTask` runs, so `requestResolve`'s `status === 'review'` guard and `claimForResolve` CAS both hold.)

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/main/__tests__/kanban-commands.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-commands.ts src/main/__tests__/kanban-commands.test.ts
git commit -m "feat(kanban): manual merge conflict spawns a resolve run"
```

---

## Task 10: Full verification + UI badge (optional polish) + changelog

**Files:**
- Modify: `src/renderer/src/components/kanban/...` (resolve badge — only if a low-risk existing badge pattern exists)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Resolve/attempt badge (light touch).** The board already renders run-mode/event badges (spec §7). If the card/drawer has an existing badge driven by run mode or the latest event, add a `resolve` case showing e.g. `resolving conflicts — attempt N/2` (N = `task.resolveAttempts`). If no clean seam exists, SKIP this step and note it as a #229/follow-up — do not build new UI plumbing here. Add a test only if you touch renderer logic with existing test coverage.

- [ ] **Step 2: Full typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Full kanban test suite**

Run: `npx vitest run src/main/__tests__/kanban-*.test.ts src/shared/__tests__/kanban-*.test.ts`
Expected: PASS (all green).

- [ ] **Step 4: Lint (net-zero check).** Repo lint is pre-existing-red in `kanban-store.ts`/`kanban-mcp-server.ts`. Confirm this change adds **no new** lint errors:

Run: `npm run lint`
Then compare the per-file error counts for touched files against `main`. Expected: net-zero new errors. No `as` casts (use the existing `.all() as Array<Record<string, unknown>>` query-cast convention only), no `eslint-disable` in `src`.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: SUCCESS.

- [ ] **Step 6: Add a CHANGELOG entry** under a new `## vX.Y.Z` heading (next patch/minor — check current version in `package.json`), e.g.:

```markdown
## v2.67.0

- Kanban autopilot phase 2: completed feature tasks now auto-merge into their feature integration branch; merge conflicts spawn a bounded agent-driven resolve run (max 2 attempts, then the task blocks with a notification). Completed features auto-sync their integration branch with main. New `autoIntegrate` setting (default on). (#228)
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "docs(kanban): changelog for integrate/resolve (autopilot phase 2, #228)"
```

---

## Final review

After all tasks: dispatch a final whole-branch code review (per subagent-driven-development), then use `superpowers:finishing-a-development-branch` to open the PR (`Closes #228`). Verify against the issue's "Done when":

1. A feature task completing with a clean merge reaches `done` with no human click. ✓ (Task 7)
2. A conflicting task gets a resolve run, then merges; after 2 failed attempts it blocks with a notification. ✓ (Tasks 6–7; `blocked` event → notification via `classifyKanbanEvent`)
3. Vitest coverage per spec §9. ✓ (Tasks 1–9)

**Phase boundary reminder for the PR description:** #228 is local-git only. No origin push, no `gh pr` — draft-PR lifecycle, `gh pr ready`, and the feature-ready notification are #229.
