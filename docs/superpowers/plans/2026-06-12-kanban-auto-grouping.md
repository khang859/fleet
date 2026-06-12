# Kanban Auto-Grouping into Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group related kanban tickets into a single feature (one PR) automatically — deterministically at decompose time, and via human-confirmed suggestions for loose tickets — implementing spec §4 of `docs/superpowers/specs/2026-06-10-kanban-integration-autopilot-design.md` (issue #230).

**Architecture:** Two independent mechanisms. (A) **Decompose enforcement** — deterministic, in code: when a `decompose` orchestrator run completes having produced ≥2 worktree children and no feature, a `KanbanCommands.enforceDecomposeGrouping` method (called from the MCP `kanban_complete` handler) creates a feature named after the parent and assigns parent + children. No reliance on the orchestrator prompt. (B) **Loose-ticket detection** — suggestion-gated: a new dispatcher stage `detectFeatureGroups()` finds ≥2 ungrouped worktree tasks sharing a `repoPath` in `todo`/`ready`, debounced per repo, and spawns one PM run (new `RunMode 'suggest'`, on a transient `system_kind='suggest'` task) that may call a new terminal tool `kanban_suggest_feature(name, task_ids, reason)`. That tool records a **pending** row in a new `feature_suggestions` table — it never regroups anything. A board banner offers **Accept** (creates the feature + assigns the tasks) / **Dismiss**.

**Tech Stack:** Electron main (TypeScript), better-sqlite3, the existing `KanbanStore` / `KanbanCommands` / `KanbanDispatcher` / `KanbanMcpServer` seams, rune worker runs via `spawn-worker.ts`, React + Tailwind renderer, vitest.

**Standing constraints (carried from this initiative):**
- **No `as` casts and no `eslint-disable` in `src`.** Use zod for runtime validation of any external/worker input. The only sanctioned exception is the file-local raw-sqlite-row `Record<string, unknown>` query convention already used throughout `kanban-store.ts`.
- Vitest does **not** typecheck — run `npm run typecheck` separately from `npx vitest run`.
- All git/dispatcher automation is best-effort: append an event, never throw out of a tick.
- Do not add a `CHANGELOG.md` entry (that happens at release time only).
- Commits end with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

**Spec refinements (deliberate, beyond the literal spec text):**
- The `feature_suggestions` table gains a `repo_path` column (not in the spec's column list) so the "no pending suggestion for that repo" debounce gate is a simple indexed query rather than a JSON-overlap scan.
- The PM detection run is attached to a transient `system_kind='suggest'` task (deleted on terminal), mirroring the established `feature_sync` system-task pattern from #228, rather than inventing a new autonomous board-run path (none exists in the dispatcher).
- Loose-ticket detection has **no new on/off setting** (spec §6 adds only `autoIntegrate`/`autoAssign`); it is always-on but strongly debounced (one detection run per repo per `SUGGEST_COOLDOWN_MS`, bounded by the existing `maxDecompose` orchestrator-slot budget). Decompose enforcement is unconditional (a deterministic repair).

---

## File Structure

**Modified:**
- `src/shared/kanban-types.ts` — add `SuggestionStatus`, `FeatureSuggestion`, `CreateSuggestionInput`; extend `RunMode` with `'suggest'`.
- `src/main/kanban/schema.ts` — bump `SCHEMA_VERSION` 12→13; add `feature_suggestions` table to `SCHEMA_SQL` + a `current < 13` migration block.
- `src/main/kanban/kanban-store.ts` — suggestion CRUD; `ungroupedWorktreeReadyTodoTasks`, `hasOpenSuggestTask`, `claimForSuggest`, `deleteTask`.
- `src/main/kanban/kanban-commands.ts` — `enforceDecomposeGrouping`, `listSuggestions`, `acceptSuggestion`, `dismissSuggestion`.
- `src/main/kanban/kanban-mcp-server.ts` — call enforcement on decompose `kanban_complete`; `SUGGEST_TOOLS`; `toolsForMode('suggest')`; `kanban_suggest_feature` handler; suggest-mode `kanban_block` deletes the system task.
- `src/main/kanban/kanban-dispatcher.ts` — `detectFeatureGroups()` stage + per-repo cooldown + reclaim `'suggest'` handling + tick wiring.
- `src/main/kanban/spawn-worker.ts` — `buildPrompt` + `requireToolsForMode` for `'suggest'`.
- `src/shared/ipc-channels.ts` — three new channels.
- `src/main/kanban/kanban-ipc.ts` — three new handlers.
- `src/preload/index.ts` (+ its `window.fleet` type decl) — bridge the three calls.
- `src/renderer/src/store/kanban-store.ts` — `suggestions` state + `loadSuggestions`/`acceptSuggestion`/`dismissSuggestion`.
- `src/renderer/src/components/kanban/KanbanBoard.tsx` — mount the banner.

**Created:**
- `src/renderer/src/components/kanban/FeatureSuggestionsPrompt.tsx` — the Accept/Dismiss banner.

**Tests modified/added:** `kanban-store.test.ts`, `kanban-commands.test.ts`, `kanban-mcp-server.test.ts`, `kanban-dispatcher.test.ts`, `kanban-spawn-worker.test.ts`.

---

## Task 1: Decompose enforcement — `KanbanCommands.enforceDecomposeGrouping`

Deterministic grouping safety net. When a decompose run has produced ≥2 worktree children and nothing is grouped yet, create a feature named after the parent and assign parent + children.

**Files:**
- Modify: `src/main/kanban/kanban-commands.ts`
- Test: `src/main/__tests__/kanban-commands.test.ts`

**Context:** `store.childrenOf(parentId)` returns child **ID strings** (`kanban-store.ts:351`). `store.createFeature({ boardId, name, repoPath?, baseBranch? })` returns a `Feature` (`kanban-store.ts:1326`). `store.assignTaskToFeature(taskId, featureId)` sets `feature_id` (`kanban-store.ts:1458`). `store.appendEvent(taskId, runId, type, payload)` — pass `null` for `runId`; for a feature event, the "taskId" arg is the `featureId` (see `ensureFeaturePr` in the dispatcher, which calls `appendEvent(featureId, null, 'feature_pr_created', …)`). Decompose children inherit `workspaceKind`/`repoPath`/`baseBranch` from the parent via the MCP server's `inheritWorkspace`.

- [ ] **Step 1: Write the failing test**

Add to `kanban-commands.test.ts` (inside a new `describe('KanbanCommands.enforceDecomposeGrouping', …)`; reuse the file's `makeCommands()` helper):

```ts
describe('KanbanCommands.enforceDecomposeGrouping', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('groups a decompose parent + its ≥2 worktree children into a new feature', () => {
    const { store, commands } = makeCommands();
    const parent = store.createTask({
      title: 'Build auth',
      status: 'done',
      workspaceKind: 'worktree',
      repoPath: '/repo',
      baseBranch: 'main'
    });
    const c1 = store.createTask({ title: 'a', workspaceKind: 'worktree', repoPath: '/repo', baseBranch: 'main' });
    const c2 = store.createTask({ title: 'b', workspaceKind: 'worktree', repoPath: '/repo', baseBranch: 'main' });
    store.addLink(parent.id, c1.id);
    store.addLink(parent.id, c2.id);

    commands.enforceDecomposeGrouping(parent.id);

    const features = store.listFeatures({});
    expect(features).toHaveLength(1);
    expect(features[0].name).toBe('Build auth');
    expect(features[0].repoPath).toBe('/repo');
    expect(store.getTask(parent.id)?.featureId).toBe(features[0].id);
    expect(store.getTask(c1.id)?.featureId).toBe(features[0].id);
    expect(store.getTask(c2.id)?.featureId).toBe(features[0].id);
    store.close();
  });

  it('is a no-op when fewer than 2 worktree children exist', () => {
    const { store, commands } = makeCommands();
    const parent = store.createTask({ title: 'p', status: 'done', workspaceKind: 'worktree', repoPath: '/repo', baseBranch: 'main' });
    const c1 = store.createTask({ title: 'a', workspaceKind: 'worktree', repoPath: '/repo', baseBranch: 'main' });
    const scratch = store.createTask({ title: 's' }); // scratch child does not count
    store.addLink(parent.id, c1.id);
    store.addLink(parent.id, scratch.id);
    commands.enforceDecomposeGrouping(parent.id);
    expect(store.listFeatures({})).toHaveLength(0);
    store.close();
  });

  it('is a no-op when the children are already grouped (orchestrator grouped them)', () => {
    const { store, commands } = makeCommands();
    const f = store.createFeature({ boardId: 'default', name: 'pre', repoPath: '/repo', baseBranch: 'main' });
    const parent = store.createTask({ title: 'p', status: 'done', workspaceKind: 'worktree', repoPath: '/repo', baseBranch: 'main' });
    const c1 = store.createTask({ title: 'a', workspaceKind: 'worktree', repoPath: '/repo', baseBranch: 'main', featureId: f.id });
    const c2 = store.createTask({ title: 'b', workspaceKind: 'worktree', repoPath: '/repo', baseBranch: 'main', featureId: f.id });
    store.addLink(parent.id, c1.id);
    store.addLink(parent.id, c2.id);
    commands.enforceDecomposeGrouping(parent.id);
    expect(store.listFeatures({})).toHaveLength(1); // no new feature
    store.close();
  });

  it('is a no-op when the parent is already in a feature', () => {
    const { store, commands } = makeCommands();
    const f = store.createFeature({ boardId: 'default', name: 'pre', repoPath: '/repo', baseBranch: 'main' });
    const parent = store.createTask({ title: 'p', status: 'done', workspaceKind: 'worktree', repoPath: '/repo', baseBranch: 'main', featureId: f.id });
    const c1 = store.createTask({ title: 'a', workspaceKind: 'worktree', repoPath: '/repo', baseBranch: 'main' });
    const c2 = store.createTask({ title: 'b', workspaceKind: 'worktree', repoPath: '/repo', baseBranch: 'main' });
    store.addLink(parent.id, c1.id);
    store.addLink(parent.id, c2.id);
    commands.enforceDecomposeGrouping(parent.id);
    expect(store.listFeatures({})).toHaveLength(1);
    store.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-commands.test.ts -t enforceDecomposeGrouping`
Expected: FAIL — `commands.enforceDecomposeGrouping is not a function`.

- [ ] **Step 3: Implement `enforceDecomposeGrouping`**

Add this method to the `KanbanCommands` class in `src/main/kanban/kanban-commands.ts` (place it near the other feature methods, e.g. after `assignTaskToFeature`):

```ts
/**
 * Deterministic decompose enforcement (spec §4): after a decompose run produces
 * ≥2 worktree children with no feature, create a feature named after the parent
 * and group parent + children. Idempotent — re-running it once anything is grouped
 * is a no-op. Called from the MCP kanban_complete handler when a decompose run ends.
 */
enforceDecomposeGrouping(parentTaskId: string): void {
  const parent = this.store.getTask(parentTaskId);
  if (!parent || parent.featureId) return; // already grouped, or gone
  const children = this.store
    .childrenOf(parentTaskId)
    .map((id) => this.store.getTask(id))
    .filter((t): t is Task => t != null && t.workspaceKind === 'worktree');
  if (children.length < 2) return;
  if (children.some((c) => c.featureId)) return; // the orchestrator already grouped them

  const repoPath = parent.repoPath ?? children[0].repoPath ?? null;
  const baseBranch = parent.baseBranch ?? children[0].baseBranch ?? null;
  const feature = this.store.createFeature({
    boardId: parent.boardId,
    name: parent.title,
    repoPath,
    baseBranch
  });
  this.store.appendEvent(feature.id, null, 'feature_created', {
    name: parent.title,
    by: 'decompose-enforce'
  });
  for (const t of [parent, ...children]) {
    this.store.assignTaskToFeature(t.id, feature.id);
    this.store.appendEvent(t.id, null, 'feature_assigned', { featureId: feature.id });
  }
}
```

Ensure `Task` is imported in `kanban-commands.ts` (it almost certainly already is — check the existing `import type { … } from '../../shared/kanban-types'` line and add `Task` if missing).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/main/__tests__/kanban-commands.test.ts -t enforceDecomposeGrouping`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Then:
```bash
git add src/main/kanban/kanban-commands.ts src/main/__tests__/kanban-commands.test.ts
git commit -m "feat(kanban): enforceDecomposeGrouping command (#230)"
```

---

## Task 2: Wire enforcement into the MCP `kanban_complete` decompose path

**Files:**
- Modify: `src/main/kanban/kanban-mcp-server.ts:982-989` (the non-worktree `kanban_complete` branch)
- Test: `src/main/__tests__/kanban-mcp-server.test.ts`

**Context:** Decompose parents are triage cards (no worktree), so a decompose `kanban_complete` lands in the non-worktree branch at `kanban-mcp-server.ts:982`. The server holds an optional `this.commands` injected via `setCommands` (`kanban-mcp-server.ts:443,460`). Worker runs are registered with `server.registerRun(token, { kind: 'task', taskId, runId, mode })` (public, `kanban-mcp-server.ts:482`). The test harness constructs `new KanbanMcpServer(store)` and calls tools over HTTP via the `rpc(url, method, params)` helper; use `${base}?run=<token>`.

- [ ] **Step 1: Write the failing test**

Add to `kanban-mcp-server.test.ts`. This test wires commands into the server, registers a decompose run on a parent with two worktree children, calls `kanban_complete`, and asserts a feature was created and everything is grouped:

```ts
it('auto-groups decompose children into a feature on kanban_complete', async () => {
  const dispatcher = new KanbanDispatcher(store, {
    now: () => 0,
    isAlive: () => true,
    spawnWorker: () => undefined,
    config: {
      failureLimit: 2, claimGraceMs: 0, maxInProgress: 3, claimTtlMs: 1000,
      autoDecompose: false, autoAssign: false, autoIntegrate: false, maxDecompose: 1, artifactRetentionDays: 0
    }
  });
  const commands = new KanbanCommands(store, dispatcher, () => ({ workspaceKind: 'scratch', maxRuntimeSeconds: null }));
  server.setCommands(commands);

  const parent = store.createTask({ title: 'Group me', status: 'running', workspaceKind: 'worktree', repoPath: '/r', baseBranch: 'main' });
  const c1 = store.createTask({ title: 'a', workspaceKind: 'worktree', repoPath: '/r', baseBranch: 'main' });
  const c2 = store.createTask({ title: 'b', workspaceKind: 'worktree', repoPath: '/r', baseBranch: 'main' });
  store.addLink(parent.id, c1.id);
  store.addLink(parent.id, c2.id);
  const run = store.startRun(parent.id, 'orchestrator', null, 'decompose');
  server.registerRun('tok-dec', { kind: 'task', taskId: parent.id, runId: run.id, mode: 'decompose' });

  await rpc(`${base}?run=tok-dec`, 'tools/call', { name: 'kanban_complete', arguments: { summary: 'done' } });

  const features = store.listFeatures({});
  expect(features).toHaveLength(1);
  expect(store.getTask(c1.id)?.featureId).toBe(features[0].id);
});
```

(Import `KanbanDispatcher` and `KanbanCommands` at the top of the test file — `KanbanCommands` is already imported; add `KanbanDispatcher` if not present.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-mcp-server.test.ts -t auto-group`
Expected: FAIL — `features` is empty.

- [ ] **Step 3: Add the enforcement call**

In `kanban-mcp-server.ts`, in the non-worktree `kanban_complete` branch, immediately before `this.unregisterRun(token);` at line ~988:

```ts
          this.store.appendEvent(task.id, scope.runId, 'completed', { summary: a.summary });
          if (scope.mode === 'decompose') this.commands?.enforceDecomposeGrouping(task.id);
          this.unregisterRun(token);
          return this.text(res, rpcReq.id, `Task ${task.id} marked done.`);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/__tests__/kanban-mcp-server.test.ts -t auto-group`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/main/kanban/kanban-mcp-server.ts src/main/__tests__/kanban-mcp-server.test.ts
git commit -m "feat(kanban): group decompose children on kanban_complete (#230)"
```

---

## Task 3: Types + schema v13 + suggestion store CRUD

**Files:**
- Modify: `src/shared/kanban-types.ts`
- Modify: `src/main/kanban/schema.ts`
- Modify: `src/main/kanban/kanban-store.ts`
- Test: `src/main/__tests__/kanban-store.test.ts`

**Context:** `SCHEMA_VERSION` is currently `12` (`schema.ts:1`). New tables are declared both in the idempotent `SCHEMA_SQL` (fresh installs) **and** created in a `current < 13` migration block (existing DBs). JSON columns are stored with `JSON.stringify` and read with `JSON.parse(String(r.col ?? '[]'))` (see `rowToTask` skills/docs). Row mappers cast the raw row as `Record<string, unknown>` (the sanctioned file-local convention). `randomUUID().slice(0, 8)` is the id convention.

- [ ] **Step 1: Add the types**

In `src/shared/kanban-types.ts`, after the `Feature`/`FeatureMergeState` definitions add:

```ts
export type SuggestionStatus = 'pending' | 'accepted' | 'dismissed';

/** A PM-proposed grouping of loose tickets into a feature, awaiting a human Accept/Dismiss (spec §4). */
export interface FeatureSuggestion {
  id: string;
  boardId: string;
  repoPath: string | null;
  name: string;
  taskIds: string[];
  reason: string | null;
  status: SuggestionStatus;
  createdAt: number;
  updatedAt: number;
}

export interface CreateSuggestionInput {
  boardId: string;
  repoPath: string | null;
  name: string;
  taskIds: string[];
  reason?: string | null;
}
```

Also extend `RunMode` (currently `'work' | 'decompose' | 'specify' | 'assign' | 'resolve'`) to include `'suggest'`:

```ts
export type RunMode = 'work' | 'decompose' | 'specify' | 'assign' | 'resolve' | 'suggest';
```

- [ ] **Step 2: Add the schema**

In `src/main/kanban/schema.ts`: bump `export const SCHEMA_VERSION = 13;`. Add this table to `SCHEMA_SQL` (near the other `CREATE TABLE IF NOT EXISTS` blocks, e.g. after `features`):

```sql
CREATE TABLE IF NOT EXISTS feature_suggestions (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  repo_path TEXT,
  name TEXT NOT NULL,
  task_ids TEXT NOT NULL DEFAULT '[]',
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_suggestions_board ON feature_suggestions(board_id);
CREATE INDEX IF NOT EXISTS idx_suggestions_status ON feature_suggestions(status);
```

And add a migration block after the existing `current < 12` block in the `migrate()` method:

```ts
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
  this.db.exec('CREATE INDEX IF NOT EXISTS idx_suggestions_board ON feature_suggestions(board_id)');
  this.db.exec('CREATE INDEX IF NOT EXISTS idx_suggestions_status ON feature_suggestions(status)');
}
```

(Match the exact `addColumnIfMissing`/`this.db.exec` style already used in `schema.ts`. If migrations live in a different method/shape than shown, follow the existing structure — the key requirements are: bump to 13, add the table to `SCHEMA_SQL`, and create it in a `current < 13` block.)

- [ ] **Step 3: Add store methods**

In `src/main/kanban/kanban-store.ts`, add a row mapper + CRUD (place near the feature methods). Import `FeatureSuggestion`, `SuggestionStatus`, `CreateSuggestionInput` from the shared types:

```ts
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
    .run(id, input.boardId, input.repoPath ?? null, input.name, JSON.stringify(input.taskIds), input.reason ?? null, ts, ts);
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
    .prepare(`SELECT * FROM feature_suggestions WHERE ${where.join(' AND ')} ORDER BY created_at DESC`)
    .all(params) as Array<Record<string, unknown>>;
  return rows.map((r) => this.rowToSuggestion(r));
}

updateSuggestionStatus(id: string, status: SuggestionStatus): void {
  this.db
    .prepare('UPDATE feature_suggestions SET status=?, updated_at=? WHERE id=?')
    .run(status, this.now(), id);
}
```

- [ ] **Step 4: Write tests**

Add to `kanban-store.test.ts`. First update the two `schemaVersion()` assertions that currently expect `12` to expect `13` (there are several `expect(store.schemaVersion()).toBe(12)` and a `'fresh db is created at v12'` test name — bump the numbers; you may leave the test titles or rename to v13). Then add:

```ts
it('creates and lists feature suggestions, filtering by status and repo', () => {
  const s1 = store.createSuggestion({ boardId: 'default', repoPath: '/r', name: 'Auth', taskIds: ['a', 'b'], reason: 'related' });
  expect(s1.status).toBe('pending');
  expect(s1.taskIds).toEqual(['a', 'b']);
  store.createSuggestion({ boardId: 'default', repoPath: '/other', name: 'Other', taskIds: ['c', 'd'] });
  expect(store.listSuggestions('default')).toHaveLength(2);
  expect(store.listSuggestions('default', { repoPath: '/r' })).toHaveLength(1);
  store.updateSuggestionStatus(s1.id, 'accepted');
  expect(store.getSuggestion(s1.id)?.status).toBe('accepted');
  expect(store.listSuggestions('default', { status: 'pending', repoPath: '/r' })).toHaveLength(0);
});
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts`
Expected: PASS (including the bumped v13 assertions).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/shared/kanban-types.ts src/main/kanban/schema.ts src/main/kanban/kanban-store.ts src/main/__tests__/kanban-store.test.ts
git commit -m "feat(kanban): feature_suggestions schema v13 + store CRUD (#230)"
```

---

## Task 4: Accept / Dismiss commands

**Files:**
- Modify: `src/main/kanban/kanban-commands.ts`
- Test: `src/main/__tests__/kanban-commands.test.ts`

**Context:** Accept must create the feature, assign every still-existing suggested task, and mark the row `accepted`. Dismiss just marks `dismissed`. Base the feature's `baseBranch` on the first suggested task that still has one (suggested tasks share a repo but the suggestion row only stores `repoPath`). `requireFeature`/`CodedError` patterns exist in the file; for a missing suggestion throw `new CodedError('suggestion not found', 'NOT_FOUND')` (match the file's existing error code conventions — grep for `CodedError(` to confirm the exact code strings used).

- [ ] **Step 1: Write the failing tests**

```ts
describe('KanbanCommands suggestions', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('accept creates a feature, assigns the tasks, and marks accepted', () => {
    const { store, commands } = makeCommands();
    const t1 = store.createTask({ title: 'a', workspaceKind: 'worktree', repoPath: '/r', baseBranch: 'main' });
    const t2 = store.createTask({ title: 'b', workspaceKind: 'worktree', repoPath: '/r', baseBranch: 'main' });
    const s = store.createSuggestion({ boardId: 'default', repoPath: '/r', name: 'Grouped', taskIds: [t1.id, t2.id] });

    const feature = commands.acceptSuggestion(s.id);

    expect(feature.name).toBe('Grouped');
    expect(feature.repoPath).toBe('/r');
    expect(store.getTask(t1.id)?.featureId).toBe(feature.id);
    expect(store.getTask(t2.id)?.featureId).toBe(feature.id);
    expect(store.getSuggestion(s.id)?.status).toBe('accepted');
    store.close();
  });

  it('accept skips tasks that no longer exist', () => {
    const { store, commands } = makeCommands();
    const t1 = store.createTask({ title: 'a', workspaceKind: 'worktree', repoPath: '/r', baseBranch: 'main' });
    const s = store.createSuggestion({ boardId: 'default', repoPath: '/r', name: 'G', taskIds: [t1.id, 'gone'] });
    const feature = commands.acceptSuggestion(s.id);
    expect(store.listFeatureTasks(feature.id).map((t) => t.id)).toEqual([t1.id]);
    store.close();
  });

  it('dismiss marks the suggestion dismissed without creating a feature', () => {
    const { store, commands } = makeCommands();
    const s = store.createSuggestion({ boardId: 'default', repoPath: '/r', name: 'G', taskIds: ['a'] });
    commands.dismissSuggestion(s.id);
    expect(store.getSuggestion(s.id)?.status).toBe('dismissed');
    expect(store.listFeatures({})).toHaveLength(0);
    store.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/__tests__/kanban-commands.test.ts -t suggestions`
Expected: FAIL — methods undefined.

- [ ] **Step 3: Implement the commands**

Add to `KanbanCommands` (import `FeatureSuggestion`, `Feature` if not already imported):

```ts
listSuggestions(boardId: string): FeatureSuggestion[] {
  return this.store.listSuggestions(boardId, { status: 'pending' });
}

/** Accept a pending suggestion: create the feature, assign the still-existing tasks, mark accepted. */
acceptSuggestion(id: string): Feature {
  const s = this.store.getSuggestion(id);
  if (!s) throw new CodedError('suggestion not found', 'NOT_FOUND');
  const tasks = s.taskIds.map((tid) => this.store.getTask(tid)).filter((t): t is Task => t != null);
  const baseBranch = tasks.find((t) => t.baseBranch)?.baseBranch ?? null;
  const feature = this.store.createFeature({
    boardId: s.boardId,
    name: s.name,
    repoPath: s.repoPath,
    baseBranch
  });
  this.store.appendEvent(feature.id, null, 'feature_created', { name: s.name, by: 'suggestion-accept' });
  for (const t of tasks) {
    this.store.assignTaskToFeature(t.id, feature.id);
    this.store.appendEvent(t.id, null, 'feature_assigned', { featureId: feature.id });
  }
  this.store.updateSuggestionStatus(id, 'accepted');
  return feature;
}

dismissSuggestion(id: string): void {
  const s = this.store.getSuggestion(id);
  if (!s) throw new CodedError('suggestion not found', 'NOT_FOUND');
  this.store.updateSuggestionStatus(id, 'dismissed');
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/main/__tests__/kanban-commands.test.ts -t suggestions`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/main/kanban/kanban-commands.ts src/main/__tests__/kanban-commands.test.ts
git commit -m "feat(kanban): accept/dismiss feature suggestion commands (#230)"
```

---

## Task 5: Store support for the detection run

**Files:**
- Modify: `src/main/kanban/kanban-store.ts`
- Test: `src/main/__tests__/kanban-store.test.ts`

**Context:** The detection stage needs: (1) the candidate query, (2) a per-repo "is a suggest run already open" guard, (3) an atomic claim for the transient system task, (4) a hard delete for it on terminal. Mirror `claimForResolve` (`kanban-store.ts:1601`, `review`→`running`) and `openSystemTask` (`kanban-store.ts:1474`).

- [ ] **Step 1: Write failing tests**

```ts
it('ungroupedWorktreeReadyTodoTasks returns only ungrouped worktree todo/ready tasks with a repo', () => {
  const a = store.createTask({ title: 'a', status: 'ready', workspaceKind: 'worktree', repoPath: '/r' });
  const b = store.createTask({ title: 'b', status: 'todo', workspaceKind: 'worktree', repoPath: '/r' });
  store.createTask({ title: 'grouped', status: 'ready', workspaceKind: 'worktree', repoPath: '/r', featureId: 'f1' });
  store.createTask({ title: 'scratch', status: 'ready' }); // not worktree
  store.createTask({ title: 'norepo', status: 'ready', workspaceKind: 'worktree' }); // no repo
  store.createTask({ title: 'running', status: 'running', workspaceKind: 'worktree', repoPath: '/r' }); // wrong status
  const ids = store.ungroupedWorktreeReadyTodoTasks().map((t) => t.id).sort();
  expect(ids).toEqual([a.id, b.id].sort());
});

it('hasOpenSuggestTask detects a non-terminal suggest system task for a repo', () => {
  expect(store.hasOpenSuggestTask('default', '/r')).toBe(false);
  const sys = store.createTask({ title: 'detect', status: 'review', boardId: 'default', systemKind: 'suggest', repoPath: '/r' });
  expect(store.hasOpenSuggestTask('default', '/r')).toBe(true);
  expect(store.hasOpenSuggestTask('default', '/other')).toBe(false);
  store.completeTask(sys.id, 'done');
  expect(store.hasOpenSuggestTask('default', '/r')).toBe(false);
});

it('claimForSuggest moves a review task to running once', () => {
  const sys = store.createTask({ title: 'd', status: 'review', systemKind: 'suggest', repoPath: '/r' });
  expect(store.claimForSuggest(sys.id, 'L', 1000)).toBe(true);
  expect(store.getTask(sys.id)?.status).toBe('running');
  expect(store.claimForSuggest(sys.id, 'L2', 1000)).toBe(false);
});

it('deleteTask removes the task row and its links', () => {
  const p = store.createTask({ title: 'p' });
  const c = store.createTask({ title: 'c' });
  store.addLink(p.id, c.id);
  store.deleteTask(c.id);
  expect(store.getTask(c.id)).toBeNull();
  expect(store.childrenOf(p.id)).toEqual([]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts -t "ungrouped|hasOpenSuggest|claimForSuggest|deleteTask"`
Expected: FAIL — methods undefined.

- [ ] **Step 3: Implement the store methods**

```ts
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

/** Hard-delete a task row and its links (used to drop a transient suggest system task on terminal). */
deleteTask(id: string): void {
  const tx = this.db.transaction((taskId: string) => {
    this.db.prepare('DELETE FROM task_links WHERE parent_id=? OR child_id=?').run(taskId, taskId);
    this.db.prepare('DELETE FROM tasks WHERE id=?').run(taskId);
  });
  tx(id);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts -t "ungrouped|hasOpenSuggest|claimForSuggest|deleteTask"`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/main/kanban/kanban-store.ts src/main/__tests__/kanban-store.test.ts
git commit -m "feat(kanban): store support for grouping detection runs (#230)"
```

---

## Task 6: `detectFeatureGroups()` dispatcher stage + reclaim handling

**Files:**
- Modify: `src/main/kanban/kanban-dispatcher.ts`
- Test: `src/main/__tests__/kanban-dispatcher.test.ts`

**Context:** Stages are spawned with `this.store.startRun(taskId, 'orchestrator', null, mode)` then `this.deps.spawnWorker({ task, runId, lock, workspace, mode })` (see `autoAssign`, `kanban-dispatcher.ts:380-384`). Orchestrator-slot budget = `maxDecompose - this.store.orchestratorRunningCount()`. The per-repo cooldown follows the in-memory `lastWorktreeSweepAt` precedent (`kanban-dispatcher.ts:124`). reclaim routes non-work modes; `assign`→ready, `resolve`→review must be matched first (`kanban-dispatcher.ts:211-214`); add `suggest`→`deleteTask` there so a dead detection run is dropped, not parked in triage. Insert the stage between `autoAssign()` and `promote()` in `tick()`.

- [ ] **Step 1: Add constant + cooldown field**

Near the top constants add:

```ts
/** Min gap between grouping-detection runs for the same repo (debounce; spec §4). */
const SUGGEST_COOLDOWN_MS = 30 * 60_000;
```

Add a field to the class beside `lastWorktreeSweepAt`:

```ts
private lastSuggestAtByRepo = new Map<string, number>();
```

- [ ] **Step 2: Write the failing tests**

```ts
describe('KanbanDispatcher.detectFeatureGroups', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  function makeDisp(store: KanbanStore, clock: { t: number }, spawn: (a: SpawnWorkerArgs) => number | undefined) {
    return new KanbanDispatcher(store, {
      now: () => clock.t, isAlive: () => true, spawnWorker: spawn,
      prepareWorkspaceFn: (t) => t.workspacePath ?? '',
      config: {
        failureLimit: 2, claimGraceMs: 0, maxInProgress: 3, claimTtlMs: 1000,
        autoDecompose: false, autoAssign: false, autoIntegrate: false, maxDecompose: 2, artifactRetentionDays: 0
      }
    });
  }

  it('spawns a suggest run for a repo with ≥2 ungrouped worktree tasks', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    store.createTask({ title: 'a', status: 'ready', workspaceKind: 'worktree', repoPath: '/r', baseBranch: 'main', boardId: 'default' });
    store.createTask({ title: 'b', status: 'todo', workspaceKind: 'worktree', repoPath: '/r', baseBranch: 'main', boardId: 'default' });
    const spawned: SpawnWorkerArgs[] = [];
    const disp = makeDisp(store, clock, (a) => { spawned.push(a); return 4321; });
    disp.detectFeatureGroups();
    expect(spawned).toHaveLength(1);
    expect(spawned[0].mode).toBe('suggest');
    // a transient suggest system task was created for the repo and is now running
    expect(store.hasOpenSuggestTask('default', '/r')).toBe(true);
    store.close();
  });

  it('does not spawn twice for the same repo within the cooldown', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    store.createTask({ title: 'a', status: 'ready', workspaceKind: 'worktree', repoPath: '/r', baseBranch: 'main', boardId: 'default' });
    store.createTask({ title: 'b', status: 'ready', workspaceKind: 'worktree', repoPath: '/r', baseBranch: 'main', boardId: 'default' });
    let n = 0;
    const disp = makeDisp(store, clock, () => { n++; return 1; });
    disp.detectFeatureGroups();
    // even after the first run's system task is gone, the cooldown blocks a re-spawn
    store.listTasks().filter((t) => t.systemKind === 'suggest').forEach((t) => store.deleteTask(t.id));
    clock.t = 1000 + 60_000;
    disp.detectFeatureGroups();
    expect(n).toBe(1);
    store.close();
  });

  it('does not spawn when a pending suggestion already exists for the repo', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    store.createTask({ title: 'a', status: 'ready', workspaceKind: 'worktree', repoPath: '/r', baseBranch: 'main', boardId: 'default' });
    store.createTask({ title: 'b', status: 'ready', workspaceKind: 'worktree', repoPath: '/r', baseBranch: 'main', boardId: 'default' });
    store.createSuggestion({ boardId: 'default', repoPath: '/r', name: 'x', taskIds: [] });
    let n = 0;
    const disp = makeDisp(store, clock, () => { n++; return 1; });
    disp.detectFeatureGroups();
    expect(n).toBe(0);
    store.close();
  });

  it('reclaim drops a dead suggest run (deletes the system task, no triage)', () => {
    const clock = { t: 1000 };
    const store = makeStore(clock);
    const sys = store.createTask({ title: 'detect', status: 'review', boardId: 'default', systemKind: 'suggest', repoPath: '/r' });
    store.claimForSuggest(sys.id, 'L', 100); // expires 1100
    const run = store.startRun(sys.id, 'orchestrator', null, 'suggest');
    store.setWorkerPid(sys.id, run.id, 999);
    clock.t = 5000;
    const disp = makeDisp(store, clock, () => undefined);
    // simulate a dead pid
    (disp as unknown as { deps: { isAlive: (p: number) => boolean } }).deps.isAlive = () => false;
    disp.reclaim();
    expect(store.getTask(sys.id)).toBeNull();
    store.close();
  });
});
```

NOTE: the last test casts `disp` only to flip `isAlive` — avoid this in `src`, but it is acceptable in a **test** file (the eslint cast ban applies to `src`, not tests). Cleaner alternative: capture a mutable `alive` flag in the `makeDisp` closure (`isAlive: () => alive`) and set it before `reclaim()`. Prefer the closure approach.

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts -t detectFeatureGroups`
Expected: FAIL — `disp.detectFeatureGroups is not a function`.

- [ ] **Step 4: Implement the stage + reclaim branch + tick wiring**

Add the reclaim branch (in `reclaim()`, before the generic `else if (mode && mode !== 'work')`):

```ts
        if (mode === 'assign') this.store.returnToReady(task.id);
        else if (mode === 'resolve') this.store.setStatusCleared(task.id, 'review');
        else if (mode === 'suggest') this.store.deleteTask(task.id);
        else if (mode && mode !== 'work') this.store.setStatusCleared(task.id, 'triage');
        else this.store.returnToReady(task.id);
```

Add the stage method:

```ts
/**
 * Detect loose tickets worth grouping (spec §4): for each repo with ≥2 ungrouped worktree
 * tasks in todo/ready, spawn one PM `suggest` run (on a transient system task) that may record
 * a pending grouping suggestion. Debounced per repo; gated by the orchestrator-slot budget.
 * Nothing is regrouped here — the suggestion only surfaces a banner for a human to Accept.
 */
detectFeatureGroups(): void {
  let slots = this.deps.config.maxDecompose - this.store.orchestratorRunningCount();
  if (slots <= 0) return;
  const now = this.deps.now();

  // group candidates by board+repo
  const byRepo = new Map<string, Task[]>();
  for (const t of this.store.ungroupedWorktreeReadyTodoTasks()) {
    if (!t.repoPath) continue;
    const key = `${t.boardId} ${t.repoPath}`;
    const list = byRepo.get(key) ?? [];
    list.push(t);
    byRepo.set(key, list);
  }

  for (const [key, tasks] of byRepo) {
    if (slots <= 0) break;
    if (tasks.length < 2) continue;
    const [boardId, repoPath] = key.split(' ');
    const last = this.lastSuggestAtByRepo.get(key) ?? 0;
    if (now - last < SUGGEST_COOLDOWN_MS) continue;
    if (this.store.hasOpenSuggestTask(boardId, repoPath)) continue;
    if (this.store.listSuggestions(boardId, { status: 'pending', repoPath }).length > 0) continue;

    const baseBranch = tasks.find((t) => t.baseBranch)?.baseBranch ?? null;
    const body =
      `These ungrouped tasks share the repo ${repoPath}:\n` +
      tasks.map((t) => `- ${t.id}: ${t.title}`).join('\n') +
      `\n\nIf a coherent subset should ship together as one feature, call kanban_suggest_feature ` +
      `with a feature name, those task ids, and a one-line reason. If nothing is clearly related, ` +
      `call kanban_block.`;

    const sys = this.store.createTask({
      title: `Suggest a feature grouping for ${repoPath}`,
      body,
      status: 'review', // claimForSuggest claims from review
      boardId,
      systemKind: 'suggest',
      workspaceKind: 'dir',
      workspacePath: repoPath,
      repoPath
    });

    const lock = this.nextLock();
    if (!this.store.claimForSuggest(sys.id, lock, this.deps.config.claimTtlMs)) {
      this.store.deleteTask(sys.id);
      continue;
    }
    let runId: number | null = null;
    try {
      const workspace = this.deps.prepareWorkspaceFn ? this.deps.prepareWorkspaceFn(sys) : (sys.workspacePath ?? '');
      const run = this.store.startRun(sys.id, 'orchestrator', null, 'suggest');
      runId = run.id;
      const pid = this.deps.spawnWorker({ task: sys, runId: run.id, lock, workspace, mode: 'suggest' });
      if (pid != null) this.store.setWorkerPid(sys.id, run.id, pid);
      this.store.appendEvent(sys.id, run.id, 'spawned', { pid: pid ?? null, mode: 'suggest' });
      this.lastSuggestAtByRepo.set(key, now);
      slots -= 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (runId != null) this.store.finishRun(runId, 'spawn_failed', { error: msg });
      this.store.deleteTask(sys.id); // never park a detection task on the board
      log.error('suggest spawn failed', { repoPath, error: msg });
    }
    void baseBranch; // base branch is resolved at Accept time, not needed for the suggestion row
  }
}
```

(Drop the `void baseBranch;`/`baseBranch` lines entirely if you prefer — the suggestion row does not store a base branch; it's recomputed in `acceptSuggestion`. They're shown only to make explicit that base branch is intentionally not threaded here.)

Wire into `tick()` between `autoAssign()` and `promote()`:

```ts
    this.autoAssign();
    this.detectFeatureGroups();
    this.promote();
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/main/__tests__/kanban-dispatcher.test.ts -t detectFeatureGroups`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/main/kanban/kanban-dispatcher.ts src/main/__tests__/kanban-dispatcher.test.ts
git commit -m "feat(kanban): detectFeatureGroups dispatcher stage (#230)"
```

---

## Task 7: spawn-worker prompt + terminal tool for `suggest`

**Files:**
- Modify: `src/main/kanban/spawn-worker.ts`
- Test: `src/main/__tests__/kanban-spawn-worker.test.ts`

**Context:** `buildPrompt` (`spawn-worker.ts:65`) branches on `mode`; the system task's `body` already carries the candidate list (built in Task 6), so the suggest prompt just frames the job and defers to the body. `requireToolsForMode` (`spawn-worker.ts:141`) sets the rune `--require-tool` terminal list.

- [ ] **Step 1: Write the failing test**

Open `kanban-spawn-worker.test.ts`, mirror an existing `buildPrompt`/`buildWorkerInvocation` test. Add:

```ts
it('builds a suggest prompt and requires the kanban_suggest_feature terminal', () => {
  const inv = buildWorkerInvocation({
    task: { id: 't1', title: 'Suggest a feature grouping for /r', body: '- a: x\n- b: y', assignee: null, modelOverride: null },
    workspace: tmpWorkspace, // reuse the file's existing workspace fixture
    mcpPort: 1234,
    runToken: 'tok',
    logPath: join(tmpWorkspace, 'log'),
    mode: 'suggest'
  });
  const i = inv.args.indexOf('--prompt');
  expect(inv.args[i + 1]).toContain('grouping');
  const r = inv.args.indexOf('--require-tool');
  expect(inv.args[r + 1]).toBe('kanban_suggest_feature,kanban_block');
});
```

(Match how the existing tests in this file construct `workspace`/`logPath` — reuse their fixture variables.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/__tests__/kanban-spawn-worker.test.ts -t suggest`
Expected: FAIL (prompt has no suggest branch; require-tool returns null → no `--require-tool`).

- [ ] **Step 3: Implement**

In `buildPrompt`, before the final `return` (the `work` fallthrough), add:

```ts
  if (mode === 'suggest') {
    return (
      `suggest a feature grouping for kanban task ${task.id}: ${task.title}\n\n${task.body}\n\n` +
      `You are grouping related loose tickets so they can ship as one feature. Use kanban_list / ` +
      `kanban_show if you need more detail. Do not implement anything and do not create tasks. When ` +
      `you have identified a coherent group, call kanban_suggest_feature(name, task_ids, reason). If ` +
      `no subset is clearly related, call kanban_block with a short reason.`
    );
  }
```

In `requireToolsForMode`, add a case:

```ts
    case 'suggest':
      return 'kanban_suggest_feature,kanban_block';
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/main/__tests__/kanban-spawn-worker.test.ts -t suggest`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/main/kanban/spawn-worker.ts src/main/__tests__/kanban-spawn-worker.test.ts
git commit -m "feat(kanban): suggest-mode worker prompt + terminal tool (#230)"
```

---

## Task 8: MCP `kanban_suggest_feature` tool + suggest-mode block

**Files:**
- Modify: `src/main/kanban/kanban-mcp-server.ts`
- Test: `src/main/__tests__/kanban-mcp-server.test.ts`

**Context:** Tool sets are `McpTool[]` constants resolved by `toolsForMode(mode)` (`kanban-mcp-server.ts:428`). `ASSIGN_TOOLS` (`:232`) is the closest template (a couple of worker tools + one terminal). `handleToolCall` dispatches by name after an allow-list check. The terminal handler pattern (`kanban_assign`, `:999`): validate args with zod, mutate the store, `finishRun`, `appendEvent`, `unregisterRun(token)`, return text. For `suggest`, the terminal records a **pending** suggestion (never a feature) and deletes the transient system task. The existing `kanban_block` handler (`:991`) blocks the task — for a suggest system task we must delete it instead, so special-case `scope.mode === 'suggest'`.

- [ ] **Step 1: Write the failing tests**

```ts
it('suggest run records a pending suggestion and removes the system task', async () => {
  const sys = store.createTask({ title: 'detect', status: 'running', boardId: 'default', systemKind: 'suggest', repoPath: '/r' });
  const t1 = store.createTask({ title: 'a', boardId: 'default', workspaceKind: 'worktree', repoPath: '/r' });
  const t2 = store.createTask({ title: 'b', boardId: 'default', workspaceKind: 'worktree', repoPath: '/r' });
  const run = store.startRun(sys.id, 'orchestrator', null, 'suggest');
  server.registerRun('tok-sug', { kind: 'task', taskId: sys.id, runId: run.id, mode: 'suggest' });

  await rpc(`${base}?run=tok-sug`, 'tools/call', {
    name: 'kanban_suggest_feature',
    arguments: { name: 'Grouped', task_ids: [t1.id, t2.id], reason: 'same area' }
  });

  const suggestions = store.listSuggestions('default');
  expect(suggestions).toHaveLength(1);
  expect(suggestions[0].status).toBe('pending');
  expect(suggestions[0].taskIds).toEqual([t1.id, t2.id]);
  expect(suggestions[0].repoPath).toBe('/r');
  expect(store.getTask(sys.id)).toBeNull(); // system task gone
});

it('suggest tools include kanban_suggest_feature', async () => {
  const sys = store.createTask({ title: 'd', status: 'running', boardId: 'default', systemKind: 'suggest', repoPath: '/r' });
  const run = store.startRun(sys.id, 'orchestrator', null, 'suggest');
  server.registerRun('tok-list', { kind: 'task', taskId: sys.id, runId: run.id, mode: 'suggest' });
  const r = await rpc(`${base}?run=tok-list`, 'tools/list');
  const names = r.result.tools.map((t: { name: string }) => t.name);
  expect(names).toContain('kanban_suggest_feature');
});

it('kanban_block on a suggest run deletes the system task instead of blocking it', async () => {
  const sys = store.createTask({ title: 'd', status: 'running', boardId: 'default', systemKind: 'suggest', repoPath: '/r' });
  const run = store.startRun(sys.id, 'orchestrator', null, 'suggest');
  server.registerRun('tok-blk', { kind: 'task', taskId: sys.id, runId: run.id, mode: 'suggest' });
  await rpc(`${base}?run=tok-blk`, 'tools/call', { name: 'kanban_block', arguments: { reason: 'nothing related' } });
  expect(store.getTask(sys.id)).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/__tests__/kanban-mcp-server.test.ts -t suggest`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add the tool-set constant near `ASSIGN_TOOLS`:

```ts
const SUGGEST_TOOLS: McpTool[] = [
  ...WORKER_TOOLS.filter((t) => t.name === 'kanban_show'),
  // kanban_list lets the run inspect related tasks before grouping.
  ...ORCHESTRATOR_EXTRA_TOOLS.filter((t) => t.name === 'kanban_list'),
  {
    name: 'kanban_suggest_feature',
    description:
      'Propose grouping related tasks into a feature. Records a pending suggestion for a human to accept. Terminal — ends the suggest run.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        task_ids: { type: 'array', items: { type: 'string' } },
        reason: { type: 'string' }
      },
      required: ['name', 'task_ids']
    }
  },
  ...WORKER_TOOLS.filter((t) => t.name === 'kanban_comment' || t.name === 'kanban_heartbeat'),
  ...WORKER_TOOLS.filter((t) => t.name === 'kanban_block')
];
```

(Confirm `ORCHESTRATOR_EXTRA_TOOLS` is the array that contains `kanban_list` — grep for `kanban_list` in the file; if it lives in a differently-named constant, filter from that one. If `kanban_block` is not part of `WORKER_TOOLS`, copy its literal from wherever it's defined.)

Register it in `toolsForMode`:

```ts
  if (mode === 'suggest') return SUGGEST_TOOLS;
```

Add the handler in the `handleToolCall` switch (near `kanban_assign`):

```ts
        case 'kanban_suggest_feature': {
          const a = z
            .object({
              name: z.string(),
              task_ids: z.array(z.string()),
              reason: z.string().optional()
            })
            .parse(args);
          // Only keep task ids that exist on this board (defensive against a stale roster).
          const validIds = a.task_ids.filter((tid) => {
            const t = this.store.getTask(tid);
            return t != null && t.boardId === task.boardId;
          });
          this.store.createSuggestion({
            boardId: task.boardId,
            repoPath: task.repoPath ?? null,
            name: a.name,
            taskIds: validIds,
            reason: a.reason ?? null
          });
          this.store.finishRun(scope.runId, 'completed', {
            summary: `suggested feature "${a.name}" (${validIds.length} task(s))`
          });
          this.store.deleteTask(task.id); // drop the transient detection task
          this.unregisterRun(token);
          return this.text(res, rpcReq.id, `Suggested feature "${a.name}".`);
        }
```

Special-case suggest in the `kanban_block` handler (at the top of `case 'kanban_block':`, before `blockTask`):

```ts
        case 'kanban_block': {
          const a = z.object({ reason: z.string() }).parse(args);
          if (scope.mode === 'suggest') {
            // A detection run that found nothing: drop the transient task, don't park a blocked card.
            this.store.finishRun(scope.runId, 'blocked', { summary: a.reason });
            this.store.deleteTask(task.id);
            this.unregisterRun(token);
            return this.text(res, rpcReq.id, 'No grouping suggested.');
          }
          this.store.blockTask(task.id, a.reason);
          // …existing block body unchanged…
        }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/main/__tests__/kanban-mcp-server.test.ts -t suggest`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/main/kanban/kanban-mcp-server.ts src/main/__tests__/kanban-mcp-server.test.ts
git commit -m "feat(kanban): kanban_suggest_feature MCP tool (#230)"
```

---

## Task 9: IPC + preload bridge

**Files:**
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/main/kanban/kanban-ipc.ts`
- Modify: `src/preload/index.ts` (+ the `window.fleet` type declaration, wherever it lives — grep for `listFeatures` to find both the preload bridge object and its `.d.ts`/interface)

**Context:** Existing feature channels are declared in `ipc-channels.ts:194-203` and handled in `kanban-ipc.ts` (`ipcMain.handle(IPC_CHANNELS.KANBAN_LIST_FEATURES, …) => commands.listFeatures(filter)`). The preload exposes `window.fleet.kanban.listFeatures` etc. Mirror that pattern exactly for three calls: `listSuggestions(boardId)`, `acceptSuggestion(id)`, `dismissSuggestion(id)`.

- [ ] **Step 1: Add channels**

In `src/shared/ipc-channels.ts`, near the other `KANBAN_*` entries:

```ts
  KANBAN_LIST_SUGGESTIONS: 'kanban:list-suggestions',
  KANBAN_ACCEPT_SUGGESTION: 'kanban:accept-suggestion',
  KANBAN_DISMISS_SUGGESTION: 'kanban:dismiss-suggestion',
```

- [ ] **Step 2: Add handlers**

In `src/main/kanban/kanban-ipc.ts`:

```ts
ipcMain.handle(
  IPC_CHANNELS.KANBAN_LIST_SUGGESTIONS,
  (_e, boardId: string): FeatureSuggestion[] => commands.listSuggestions(boardId)
);
ipcMain.handle(IPC_CHANNELS.KANBAN_ACCEPT_SUGGESTION, (_e, id: string): Feature => commands.acceptSuggestion(id));
ipcMain.handle(IPC_CHANNELS.KANBAN_DISMISS_SUGGESTION, (_e, id: string): void => {
  commands.dismissSuggestion(id);
});
```

Add `FeatureSuggestion` (and `Feature` if not already) to the file's type imports from `../../shared/kanban-types`.

- [ ] **Step 3: Add preload bridge**

In `src/preload/index.ts`, in the `kanban` object, mirror `listFeatures`:

```ts
      listSuggestions: (boardId: string) => ipcRenderer.invoke(IPC_CHANNELS.KANBAN_LIST_SUGGESTIONS, boardId),
      acceptSuggestion: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.KANBAN_ACCEPT_SUGGESTION, id),
      dismissSuggestion: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.KANBAN_DISMISS_SUGGESTION, id),
```

Add the matching method signatures to the `window.fleet` kanban interface declaration (grep `listFeatures` to find it — likely the same file or a `*.d.ts`):

```ts
      listSuggestions: (boardId: string) => Promise<FeatureSuggestion[]>;
      acceptSuggestion: (id: string) => Promise<Feature>;
      dismissSuggestion: (id: string) => Promise<void>;
```

Import `FeatureSuggestion`/`Feature` types where that interface is declared.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS (both `typecheck:node` and `typecheck:web`).

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc-channels.ts src/main/kanban/kanban-ipc.ts src/preload/index.ts
git commit -m "feat(kanban): IPC + preload for feature suggestions (#230)"
```

---

## Task 10: Renderer store — suggestions state

**Files:**
- Modify: `src/renderer/src/store/kanban-store.ts`

**Context:** The renderer zustand store has `loadBoard` → `loadFeatures` (`kanban-store.ts:104-132` of the renderer file). `activeBoardSlug` is the board id. Add a parallel `suggestions` slice loaded alongside features and refreshed after accept/dismiss.

- [ ] **Step 1: Add state + actions**

Add to the store's state type and implementation:

```ts
  suggestions: FeatureSuggestion[];
  loadSuggestions: () => Promise<void>;
  acceptSuggestion: (id: string) => Promise<void>;
  dismissSuggestion: (id: string) => Promise<void>;
```

```ts
  suggestions: [],
  loadSuggestions: async () => {
    const suggestions = await window.fleet.kanban.listSuggestions(get().activeBoardSlug);
    set({ suggestions });
  },
  acceptSuggestion: async (id) => {
    await window.fleet.kanban.acceptSuggestion(id);
    await Promise.all([get().loadSuggestions(), get().loadFeatures(), get().loadBoard()]);
  },
  dismissSuggestion: async (id) => {
    await window.fleet.kanban.dismissSuggestion(id);
    await get().loadSuggestions();
  },
```

Call `loadSuggestions()` from `loadBoard` (alongside the existing `loadFeatures()` call). Import `FeatureSuggestion` from `../../../shared/kanban-types` (match the existing relative import path used for `Feature` in this file).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck:web`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/store/kanban-store.ts
git commit -m "feat(kanban): renderer store feature-suggestions slice (#230)"
```

---

## Task 11: Suggestions banner UI

**Files:**
- Create: `src/renderer/src/components/kanban/FeatureSuggestionsPrompt.tsx`
- Modify: `src/renderer/src/components/kanban/KanbanBoard.tsx`

**Context:** `FeaturePrRollup.tsx` is the styling reference: a slim full-width bar `border-b border-neutral-800 bg-neutral-900/60 px-3 py-1 text-[11px] text-neutral-400` with small bordered buttons (`rounded border border-neutral-700 px-2 py-0.5 … hover:bg-neutral-800`). Mount the new component right after `<FeaturePrRollup … />` (`KanbanBoard.tsx:559`). Pull state from the renderer store (`useKanbanStore`). Use `lucide-react` icons consistent with the codebase (e.g. `Layers`, `Check`, `X`).

- [ ] **Step 1: Create the component**

```tsx
import { Layers, Check, X } from 'lucide-react';
import { useKanbanStore } from '../../store/kanban-store';

export function FeatureSuggestionsPrompt(): JSX.Element | null {
  const suggestions = useKanbanStore((s) => s.suggestions);
  const accept = useKanbanStore((s) => s.acceptSuggestion);
  const dismiss = useKanbanStore((s) => s.dismissSuggestion);

  const pending = suggestions.filter((s) => s.status === 'pending');
  if (pending.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 border-b border-neutral-800 bg-neutral-900/60 px-3 py-1.5 text-[11px] text-neutral-400">
      {pending.map((s) => (
        <div key={s.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="inline-flex items-center gap-1 text-neutral-300">
            <Layers size={12} className="text-amber-400" />
            Group <span className="font-medium text-neutral-200">{s.name}</span>
            <span className="text-neutral-500">({s.taskIds.length} tasks)</span>
          </span>
          {s.reason && <span className="truncate text-neutral-500">— {s.reason}</span>}
          <span className="ml-auto inline-flex items-center gap-1.5">
            <button
              onClick={() => void accept(s.id)}
              className="inline-flex items-center gap-1 rounded border border-neutral-700 px-2 py-0.5 text-emerald-300 transition active:scale-[0.97] hover:bg-neutral-800"
            >
              <Check size={11} /> Accept
            </button>
            <button
              onClick={() => void dismiss(s.id)}
              className="inline-flex items-center gap-1 rounded border border-neutral-700 px-2 py-0.5 text-neutral-400 transition active:scale-[0.97] hover:bg-neutral-800"
            >
              <X size={11} /> Dismiss
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
```

(If the codebase uses default exports for these board components, match that convention instead of the named export shown.)

- [ ] **Step 2: Mount it**

In `KanbanBoard.tsx`, import the component and render it immediately after `<FeaturePrRollup … />`:

```tsx
            <FeaturePrRollup … />
            <FeatureSuggestionsPrompt />
```

- [ ] **Step 3: Typecheck + lint**

Run: `npm run typecheck:web`
Run: `npm run lint` (the repo lint has pre-existing warnings; ensure you add **no new** errors in the files you touched).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/kanban/FeatureSuggestionsPrompt.tsx src/renderer/src/components/kanban/KanbanBoard.tsx
git commit -m "feat(kanban): feature-suggestions board banner (#230)"
```

---

## Task 12: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: PASS (`typecheck:node` + `typecheck:web`).

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: all pass (no regressions; the v12→v13 assertion bumps from Task 3 are the only intentionally-changed existing tests).

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no **new** errors introduced by the changed files (repo has pre-existing lint noise).

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 5: Final review pass**

Confirm the spec §4 "Done when" criteria:
- Decomposing a multi-part ticket always yields a feature (Tasks 1–2).
- Related loose tickets produce a suggestion banner; Accept wires them into a feature (Tasks 3–11).
- Vitest coverage per spec §9: decompose→feature created; suggestion accept/dismiss transitions (Tasks 1, 3, 4).

No commit needed if steps 1–4 were already green from prior task commits.

---

## Self-Review Notes

- **Spec coverage:** §4 decompose enforcement → Tasks 1–2. §4 loose-ticket detection (heuristic gate, debounce, PM run, `kanban_suggest_feature`, `feature_suggestions` table, Accept/Dismiss banner) → Tasks 3–11. §8 data model (`RunMode += 'suggest'`, new table) → Tasks 3, 5. §9 testing → Tasks 1, 3, 4, 6, 8.
- **Type consistency:** `RunMode 'suggest'` is added in Task 3 and consumed in Tasks 6/7/8. `FeatureSuggestion`/`SuggestionStatus`/`CreateSuggestionInput` defined in Task 3, used in 3/4/8/9/10/11. Store method names (`createSuggestion`, `listSuggestions(boardId, {status?, repoPath?})`, `updateSuggestionStatus`, `ungroupedWorktreeReadyTodoTasks`, `hasOpenSuggestTask`, `claimForSuggest`, `deleteTask`) are used consistently across dispatcher/commands/mcp.
- **No-cast rule:** all worker/IPC inputs validated with zod (`kanban_suggest_feature`); the only casts are the sanctioned file-local sqlite-row `Record<string, unknown>` mappers and a test-only `isAlive` flip (preferably done via closure, not a cast).
- **No silent regroup:** `kanban_suggest_feature` writes a `pending` row only; the feature is created exclusively in `acceptSuggestion` (a human click). Detection is debounced per repo and gated on no-open-task + no-pending-suggestion.
