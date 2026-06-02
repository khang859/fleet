# Kanban Feature Grouping, PR Tracking & Worktree Coordination

**Status:** Design — not yet implemented
**Schema target:** v8 → v9 (single additive migration)

## Problem

Working on a single feature in the kanban board is hard because a feature is really *many* tasks and *many* PRs with no coordination:

1. **No grouping/focus** — boards are too coarse, `task_links` are execution-ordering not membership. No way to say "these N tasks are one feature" and view just them.
2. **PRs are unmanageable** — the PR URL lives only in a free-text comment + a `task_events` payload. No `pr_url` column, no list of open PRs, no GitHub status.
3. **Merge conflicts & ordering** — multiple worktrees off the same base collide only at merge-click time, one at a time, no ordering, `base_branch` frozen at creation, merges never fetch origin first.
4. **Worktree/branch sprawl** — worktrees persist on disk after `done` until manually archived.
5. **Partial decompose + re-setup** — the triage orchestrator sometimes creates only *some* tasks; creating the rest by hand means re-entering folder/worktree config every time.

## Solution overview

Introduce a first-class but lightweight **Feature** entity (membership grouping, distinct from `task_links`). A feature optionally owns an **integration branch**; tasks branch off it and merge back into it, shipping as one feature→main PR. Track PR state per task (polled from `gh`) and roll it up per feature. Auto-prune merged worktrees.

Delivered in 4 independently-shippable phases. All schema changes land in one additive v9 migration; phases are developed sequentially but share the migration.

### Why a first-class entity (not labels / boards / task_links)

- **Not labels** — a feature needs real state (active/shipped), a shared base/integration branch, and a PR rollup. A string can't hold that.
- **Not boards** — boards are the *project* grouping; collapsing feature into board loses project organization and makes every feature heavyweight.
- **Not `task_links`** — links mean "child blocked until parent done" (gates swarms). "Part of feature X" is **membership**, not **ordering**. Overloading links would wrongly block feature siblings on each other. Keep `feature_id` = membership, `task_links` = execution order.

The orchestrator decompose flow already produces exactly this shape (one parent → many linked children); a feature just makes that group first-class, focusable, and inheritable.

### Branch strategy: per-feature integration branch (opt-in, default-on for worktree features)

Feature gets `fleet/feature-<id>` cut from main. Each task worktree branches off the **feature branch** and merges back into it. One PR (feature → main) for the whole feature. Collapses N noisy PRs into one reviewable unit, confines conflicts to within the feature (resolved incrementally as tasks merge in), and gives a natural merge order. Trade-off: more git plumbing + periodic refresh of the integration branch from main.

---

## Data model (schema v8 → v9)

Single migration block (`if (current < 9)`), additive only. Bump `SCHEMA_VERSION` to 9. New table added to `SCHEMA_SQL` for fresh installs; `addColumnIfMissing` for existing DBs. Follows the existing migration pattern in `kanban-store.ts` / `schema.ts`.

### New `features` table

```sql
CREATE TABLE IF NOT EXISTS features (
  id TEXT PRIMARY KEY,                  -- randomUUID().slice(0,8), like tasks
  board_id TEXT NOT NULL,               -- board-scoped; no SQL FK (matches board_id/scheduled_from precedent)
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',-- active | shipped | archived
  repo_path TEXT,                       -- inherited by member tasks (kills re-setup)
  base_branch TEXT,                     -- merge target; inherited by member tasks
  integration_branch TEXT,              -- Phase 3; null until created
  merge_state TEXT,                     -- Phase 3 feature-level: null|pending|in_progress|conflict|merged
  pr_url TEXT,                          -- Phase 3 the one feature->main PR
  pr_number INTEGER,
  pr_state TEXT,                        -- open|merged|closed|draft|null
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_features_board ON features(board_id);
CREATE INDEX IF NOT EXISTS idx_features_status ON features(status);
```

### New columns on `tasks`

```sql
feature_id      TEXT     -- nullable membership FK (no SQL constraint); existing rows = NULL
pr_url          TEXT     -- Phase 2
pr_number       INTEGER  -- Phase 2; enables `gh pr view <number>`
pr_state        TEXT     -- Phase 2 normalized lowercase: open|merged|closed|draft|null
checks_state    TEXT     -- Phase 2 summary: passing|failing|pending|null
pr_merge_state  TEXT     -- Phase 2 gh mergeStateStatus (CLEAN/BEHIND/DIRTY/...) informational
pr_synced_at    INTEGER  -- Phase 2 last successful poll (throttle)
conflict_state  TEXT     -- Phase 3 local pre-check: clean|conflicts|error|null
conflict_files  TEXT     -- Phase 3 JSON array of conflicted paths
worktree_pruned INTEGER NOT NULL DEFAULT 0  -- Phase 4
```

### Migration sketch

```ts
if (current < 9) {
  this.db.exec(`CREATE TABLE IF NOT EXISTS features (...)`);
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
}
```

### Backward-compat / cascade notes

- All new task columns are nullable (or default 0). Existing rows deserialize cleanly via `?? null` in `rowToTask`. `features` is empty on migrate.
- `feature_id` FK is **unenforced** (matches `board_id`/`scheduled_from`). Manual cascade required:
  - `deleteBoard` transaction must add, before deleting tasks: `UPDATE tasks SET feature_id=NULL WHERE board_id=?` then `DELETE FROM features WHERE board_id=?`.
  - Hard `deleteFeature` nulls `feature_id` on member tasks, then removes the feature row.
- `archiveFeature` is soft (status only); never deletes.

---

## Reconciliation decisions

Where the backend / git / UI designs disagreed, these are the resolved calls:

| Decision | Disagreement | Resolution & rationale |
|---|---|---|
| **PR poller location** | tick vs separate class | **Separate `PrPoller` (60s interval, batched/throttled).** `gh` network calls (~300ms–1s) inside the synchronous 5s dispatch tick would stall task claiming. |
| **`pr_state` casing** | gh uppercase vs lowercase | **Normalize to lowercase** (`open\|merged\|closed\|draft`) at the `workspace.ts` boundary. `draft` from gh `isDraft`. DB/types/UI consistent. |
| **Checks storage** | JSON blob vs summary | **`checks_state` summary only** (`passing\|failing\|pending\|null`). UI renders a chip; blob is dead weight. |
| **Auto-complete on merge** | poller completes vs not | **No status change from poller.** "Make PR" already marks task `done`, so polling is informational only. |
| **`merge_state` name** | same name, two meanings | **Split:** `features.merge_state` (integration state) vs `tasks.pr_merge_state` (gh status). No cross-table collision. |
| **Feature terminal status** | `archived` vs `abandoned` | **`archived`** — matches task vocabulary. |
| **Delete vs archive feature** | hard vs soft | **Both:** soft `archiveFeature` default; hard `deleteFeature` nulls members first. |
| **Focus vs swimlanes** | — | **Focus filter only, no swimlanes.** 4 features × 8 columns = horizontal-scroll hell; Features tab gives cross-feature overview instead. |

---

## Phase 1 — Feature entity + focus + workspace inheritance + re-decompose

Kills pains #1 (grouping) and #5 (re-setup / partial decompose).

### Backend

**Types (`src/shared/kanban-types.ts`)**
```ts
export type FeatureStatus = 'active' | 'shipped' | 'archived';
export type FeatureMergeState = 'pending' | 'in_progress' | 'conflict' | 'merged';
export type PrState = 'open' | 'merged' | 'closed' | 'draft';

export interface Feature {
  id: string; boardId: string; name: string; status: FeatureStatus;
  repoPath: string | null; baseBranch: string | null;
  integrationBranch: string | null; mergeState: FeatureMergeState | null;
  prUrl: string | null; prNumber: number | null; prState: PrState | null;
  createdAt: number; updatedAt: number;
}
export interface CreateFeatureInput { boardId: string; name: string; repoPath?: string | null; baseBranch?: string | null; }
export interface UpdateFeatureInput { name?: string; status?: FeatureStatus; repoPath?: string | null; baseBranch?: string | null; integrationBranch?: string | null; mergeState?: FeatureMergeState | null; }
export interface FeatureRollup {
  featureId: string; total: number; todo: number; running: number; review: number; done: number; archived: number;
  openPrCount: number; mergedPrCount: number; checksState: 'passing'|'failing'|'pending'|null;
}
export interface FeatureDetail { feature: Feature; tasks: Task[]; rollup: FeatureRollup; }
// Task gains: featureId: string | null  (+ Phase 2/3/4 fields)
// CreateTaskInput gains: featureId?: string | null
// BoardCard inherits featureId; gains prInfo (Phase 2)
```

**Store (`kanban-store.ts`)** — `rowToFeature`; `createFeature`, `getFeature`, `listFeatures({boardId,status})`, `updateFeature`, `archiveFeature`, `deleteFeature`, `assignTaskToFeature(taskId, featureId|null)`, `listFeatureTasks` (order `priority DESC, created_at ASC`), `featureRollup` (single aggregating LEFT JOIN query). Extend `rowToTask` + `createTask` INSERT for `feature_id`. Extend `deleteBoard` cascade.

**Commands (`kanban-commands.ts`)** — `requireFeature` guard; `createFeature`, `updateFeature`, `archiveFeature`, `deleteFeature`, `listFeatures`, `showFeature`, `assignTaskToFeature`, `redecompose(featureId)`. Validation: non-empty name; board must exist; archiving with running tasks → `BAD_REQUEST`; cross-board membership → `BAD_REQUEST`; redecompose requires active feature with ≥1 task.

**`redecompose`** — find root triage task in the feature (oldest / no in-feature parents); if none in triage, create a new triage task in the feature whose body lists existing tasks for orchestrator context; set `pending_mode='decompose'`; `dispatcher.tick()`.

**MCP (`kanban-mcp-server.ts`)** — extend `inheritWorkspace` to propagate `featureId` (and Phase 3: resolve integration branch as base); add `feature_id` optional to `kanban_create` input schema; new orchestrator-only tool `kanban_feature_create` (name, optional base_branch) → `store.createFeature(...)`, returns feature id; register in `ORCHESTRATOR_EXTRA_TOOLS`.

**IPC / preload** — channels: `kanban:list-features`, `:create-feature`, `:get-feature`, `:update-feature`, `:archive-feature`, `:delete-feature`, `:assign-task-to-feature`, `:redecompose`. Request types in `ipc-api.ts`; `ipcMain.handle` in `kanban-ipc.ts`; `fleetApi.kanban.*` wrappers in `preload/index.ts`.

### UI

- **`kanban-store.ts` (renderer)** — state: `features`, `selectedFeatureId` (localStorage `fleet.kanban.focusedFeature`). Actions: `loadFeatures`, `createFeature`, `updateFeature`, `deleteFeature`, `setFocusedFeature`, `assignFeature`, `redecompose`. `switchBoard` calls `loadFeatures()` and resets focus; `loadBoard` calls `loadFeatures()` after.
- **`FeatureSelector.tsx`** (new) — toolbar `<select>` (All features / per feature / + New feature…) + edit button → `FeaturePickerModal`. Reads store directly.
- **`FeaturePickerModal.tsx`** (new) — create/edit modal (name, repo path + Browse, base branch, delete in edit mode). SwarmModal styling.
- **`KanbanBoard.tsx`** — insert `<FeatureSelector/>` in toolbar (with separator); add feature predicate to `visible` filter (`selectedFeatureId && c.featureId !== selectedFeatureId → hide`); empty-feature notice with "Clear filter"; create form: when focused, prefill repo/base + worktree from feature, show violet "Creating in feature: X" banner, pass `featureId`.
- **`KanbanCard.tsx`** — violet feature badge (truncated). `featureName` derived in `KanbanColumn` from store and passed as prop.
- **`KanbanDrawer.tsx`** — Feature `<select>` section (assign/clear → `assignFeature`); seed `featureId` in reset `useEffect`; "Decompose again" button when triage + has feature + has children.

### Phase 1 build checklist
1. Bump `SCHEMA_VERSION` → 9; add `features` DDL + full v9 migration block.
2. Types: `Feature*`, `Task.featureId`, `CreateTaskInput.featureId`.
3. Store: `rowToFeature` + feature CRUD + `assignTaskToFeature` + `listFeatureTasks` + `featureRollup`; `rowToTask`/`createTask` for `feature_id`; `deleteBoard` cascade.
4. Commands: feature CRUD + `redecompose`.
5. MCP: `inheritWorkspace` propagation + `kanban_create` field + `kanban_feature_create`.
6. IPC channels + `ipc-api.ts` types + `kanban-ipc.ts` handlers + preload wrappers.
7. Renderer store + `FeatureSelector` + `FeaturePickerModal` + board/card/column/drawer edits.
8. `npm run typecheck` → verify: create feature, create task in it, decompose → children inherit `feature_id`, focus filters board, create form inherits repo/base.

---

## Phase 2 — PR tracking + dashboard

Kills pain #2.

### Backend / git (`workspace.ts`, new `pr-poller.ts`)

- **`fetchPrState({workspacePath, prNumberOrBranch})`** → `gh pr view <n|branch> --json state,mergeStateStatus,statusCheckRollup,url,number` (`cwd: workspacePath`). Returns tagged union `{ok:true, pr}` / `{ok:false, notFound?|noGh?, error}`. Normalize state to lowercase; derive `checksState` from `statusCheckRollup` (any FAILURE/TIMED_OUT → failing; all SUCCESS → passing; else pending; empty → null). Errors: `ENOENT`→noGh; "no pull requests found"→notFound; parse failure handled.
- **`pushAndCreatePr`** return type gains `number` (fetch via `fetchPrState` on the new URL, or regex `/\/pull\/(\d+)/`).
- **`PrPoller`** class (own 60s `setInterval`, not the tick): query `store.openPrTasks()` (`pr_number NOT NULL AND pr_state IN (open,draft)`), poll serially (no parallel `gh`), per-PR min-gap 45s via in-memory `Map`, rate-limit backoff 5min on "API rate limit exceeded". Write back via `store.setPrStatus`. Started/stopped alongside dispatcher in `src/main/index.ts`. `notFound` → set `pr_state=null`, no auto-complete.

**Store** — `setPrStatus(taskId,{prState,checksState,prMergeState,prNumber?})`, `tasksDuePrSync(cutoff,limit)` / `openPrTasks()`. Extend `rowToTask` for PR fields. `createPrForTask` calls `setPrStatus(id,{prState:'open',prNumber})` immediately + stores `pr_url`/`pr_number`.

### UI

- **Types** — `TaskPrInfo`; `BoardCard.prInfo`, `TaskDetail.prInfo`.
- **`PrStatusBadge.tsx`** (new) — state chip (open=emerald, merged=violet, closed=neutral strikethrough, draft=dashed) + optional checks chip.
- **`FeaturesView.tsx`** (new) — top-level "Features" tab (mirrors `ArtifactsView`): header + filters (status, search), `space-y-4` feature rows with progress bar + PR rollup + Focus/Edit actions. `useMemo` grouping; manual Refresh button + last-refreshed timestamp.
- **`FeaturePrRollup.tsx`** (new) — slim strip under toolbar when focused: "N open · M merged" + checks summary.
- **Store** — `prList`, `loadPrList(featureId?)`.
- **`KanbanBoard.tsx`** — `view: 'board'|'artifacts'|'features'`; Features tab button; render `<FeaturePrRollup>` when focused.
- **`KanbanCard.tsx`** — `<PrStatusBadge>` when `card.prInfo`.
- **`KanbanDrawer.tsx`** — PR status section after Workspace.

---

## Phase 3 — Integration branch + merge coordination

Kills pain #3.

### Git (`workspace.ts`)

- **`ensureFeatureBranch({repoPath, integrationBranch, baseBranch})`** — `branch --list` (idempotent); best-effort `fetch origin <base>`; resolve `origin/<base>` else local; `git branch <integration> <ref>`. No push at creation.
- **Worktree creation** — feature task uses `integrationBranch` as `startPoint` (existing `prepareWorkspace` `startPoint` param); captured `baseBranch` = integration branch.
- **`mergeTaskIntoFeature(...)`** — per-feature in-process lock (`const activeMerges = new Set<string>()`); fetch-before-merge; ff-only update of local integration branch from origin; delegate to `mergeWorktreeToBase` with `baseBranch = integrationBranch`. Conflict → abort + `{ok:false,conflict:true}`.
- **`checkMergeConflicts(...)`** — `git merge-tree --write-tree --no-messages <mergeBase> <target> <branch>` (exit 1 + parse `CONFLICT...: file`); fallback temp-worktree `merge --no-commit --no-ff` + `diff --name-only --diff-filter=U` + abort. Trigger on review entry; store `conflict_state`/`conflict_files`.
- **`createFeaturePr(...)`** — `push -u origin <integration>`; existing-PR check; `gh pr create --base main --head <integration>`; fetch number. Pre-flight `updateIntegrationBranchFromMain`.
- **`updateIntegrationBranchFromMain(...)`** — fetch origin/main; ancestry checks; merge main into integration via temp worktree; conflict → `{ok:false,conflict:true}`. Triggered by explicit "Sync with main" or pre-`createFeaturePr`; poller sets a `needs_sync` flag on `mergeStateStatus==='BEHIND'` (no auto-merge).

**Commands** — `mergeReviewTask` routes through `mergeTaskIntoFeature` when `task.featureId` set; `createFeaturePr(featureId)`; `syncFeatureWithMain(featureId)`; `checkConflictsForTask`. `setFeatureIntegrationBranch` records name + `merge_state='pending'`.

### UI

- `Feature.integrationBranch`; `TaskDetail.conflictWarnings`.
- `FeaturePrRollup` shows integration branch + "Ship feature" (confirm → `shipFeature`).
- `KanbanDrawer` — conflict warnings in Workspace section (`likely` on card, `possible` in drawer); "Merge to integration" button in Review section.
- `MergeOrderModal.tsx` (new) — sortable list of review tasks in a feature; "Merge in this order" iterates `mergeToIntegration`, stops on conflict.

---

## Phase 4 — Worktree lifecycle

Kills pain #4.

### Backend / git

- **Auto-prune** — `mergeReviewTask` calls `removeWorktree` on success (existing `isBranchMerged` guard). Deferred sweep: dispatcher `sweepMergedWorktrees()` (after `sweepArtifacts`) over `store.mergedWorktreeTasks()` (worktree + workspace_path + done/archived), JS-side `isBranchMerged` check, `removeWorktree` + `clearWorkspacePath` + `worktree_pruned` event. Never prunes unmerged; squash-merges (not ancestors) left for manual archive.
- **`listWorktreeBranches({repoPath, baseBranch})`** — `worktree list --porcelain`; filter `kanban/*` + `fleet/feature-*`; `rev-list --left-right --count base...branch` (ahead/behind); `merge-base --is-ancestor` (merged).
- **`bulkPruneWorktrees({repoPath, baseBranch, dryRun?})`** — merged-only; `removeWorktree` each; `worktree prune` at end.
- **Store** — `setWorktreePruned`, `clearWorkspacePath`, `mergedWorktreeTasks`, `featureBranchesInFlight`.

### UI

- `WorktreeInfo`, `PruneResult` types; store `worktrees`, `loadWorktrees`, `pruneWorktrees`.
- `WorktreeManager.tsx` (new) — view + drawer modes: per-branch ahead/behind, merged chip, task link, individual + bulk prune, auto-prune result banner. "Branches" view-toggle tab; drawer section when `workspaceKind==='worktree'`.

---

## Risks & edge cases

- **Concurrent merges** — `activeMerges` Set serializes within-process (execFileSync is sync); leftover temp worktrees cleaned by existing `cleanupTempWorktree` before each `worktree add`.
- **Local-only repos (no origin)** — all fetch/push best-effort and silent except `createFeaturePr` (clear error: origin required).
- **gh auth / missing** — `noGh`/error surfaced verbatim; poller no-ops if gh absent (dep injection optional).
- **Squash merges** — `merge-base --is-ancestor` returns false; branch kept, auto-prune skips (safe); manual archive.
- **`git merge-tree --write-tree`** — Git 2.38+; temp-worktree fallback for older.
- **PR poller staleness** — 60s interval bounds lag; Features view has manual Refresh.
- **Partial decompose duplicates** — redecompose body lists existing tasks + orchestrator `kanban_list`; dedup is orchestrator's responsibility (no hard idempotency block).
- **Empty-feature board** — explicit "no visible tasks / clear filter" notice.
- **Focus persistence across boards** — `switchBoard` resets `selectedFeatureId` + clears localStorage.

## Files touched (all phases)

**Main:** `src/main/kanban/schema.ts`, `kanban-store.ts`, `kanban-commands.ts`, `kanban-dispatcher.ts`, `kanban-mcp-server.ts`, `workspace.ts`, new `pr-poller.ts`, `kanban-ipc.ts`, `src/main/index.ts` (bootstrap: PrPoller, pollPrStatus dep).
**Shared:** `src/shared/kanban-types.ts`, `ipc-api.ts`, `ipc-channels.ts`.
**Preload:** `src/preload/index.ts`.
**Renderer:** `store/kanban-store.ts`; new `FeatureSelector.tsx`, `FeaturePickerModal.tsx`, `FeaturesView.tsx`, `PrStatusBadge.tsx`, `FeaturePrRollup.tsx`, `MergeOrderModal.tsx`, `WorktreeManager.tsx`; edits to `KanbanBoard.tsx`, `KanbanCard.tsx`, `KanbanColumn.tsx`, `KanbanDrawer.tsx`, `kanban-utils.ts`.
