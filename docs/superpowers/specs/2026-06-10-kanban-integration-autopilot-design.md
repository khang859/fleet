# Kanban Integration Autopilot

**Date:** 2026-06-10
**Status:** Approved design

## Problem

The kanban board automates execution but not integration. Today the human must:

- Manually prompt a task to fix merge conflicts when a merge fails.
- Manually merge each finished worktree task, one review click at a time.
- Manually create a feature, assign every related ticket to it, and ship the PR.
- Manually assign a worker profile to every task — an unassigned `ready` task
  stalls silently forever (`readyTasks()` filters `assignee IS NOT NULL`,
  `kanban-store.ts:1022`, and nothing reacts to the leftover).

This spec adds an integration autopilot: deterministic git automation in the
dispatcher, with LLM runs only where judgment is required (conflict resolution,
profile matching, grouping suggestions).

## Goals

- Tasks in a feature flow automatically: complete → merge into the feature's
  integration branch → draft PR → ready PR when the feature is done.
- Merge conflicts are resolved by an agent automatically, with a bounded retry
  budget and a human escape hatch.
- Decompositions always produce a feature; related loose tickets are grouped
  via confirmed suggestions.
- Unassigned tasks are auto-assigned to the best-matching worker profile.

## Non-goals

- Auto-merging the feature PR into main (human merges the PR on GitHub).
- Rewriting history: no force-push, no rebase of pushed branches — merges only.
- Proactively rebasing worktrees of *running* siblings; staleness is handled at
  each task's own merge time.
- Per-feature automation overrides (global settings only, for now).

## Architecture

All automation lives in the existing `KanbanDispatcher` tick (sync, atomic,
~5s), plus new worker run modes following the established
`decompose`/`specify` pattern. No new background services.

```
Dispatcher tick:
  1. reclaim                      (existing)
  2. fireSchedules                (existing)
  3. decompose                    (existing)
  4. autoAssign                   (new) — flag + spawn assign runs
  5. promote                      (existing)
  6. claimAndSpawn                (existing)
  7. integrate                    (new) — feature merges, resolve runs, PR lifecycle
  8. sweepArtifacts / worktrees   (existing)
```

## 1. `integrate()` dispatcher stage

Gated on a new global `autoIntegrate` setting (default **on**).

For each task in `review` with a `featureId`, `workspaceKind='worktree'`, and
no resolve run in flight:

1. `ensureFeatureBranch()` (existing) — integration branch exists.
2. `checkMergeConflicts()` (existing) dry-run against the integration branch.
3. **Clean** → `mergeWorktreeToBase()` targeting the integration branch →
   task `done`, worktree pruned, feature branch pushed, draft PR ensured
   (section 3). `resolve_attempts` reset to 0.
4. **Conflict** → spawn a resolve run (section 2), or block + notify past the
   attempt cap.

Feature completion check: when every member task of an `active` feature is
`done`/`archived` and at least one task merged work into the integration
branch:

1. `updateIntegrationBranchFromMain()` (existing) — sync with main.
2. **Clean** → push, `gh pr ready`, notify, set feature `mergeState`.
3. **Conflict** → create a sync-resolve task (section 2).

Standalone worktree tasks (no feature) keep the human review column unchanged.
One behavior change: when a manual "Merge to base" hits a conflict, the
dispatcher now spawns a resolve run instead of only commenting.

Git operations run serially within the tick (they are already synchronous);
each integrate pass bounds work per tick (e.g. max 3 merges) so the tick stays
fast.

## 2. `resolve` run mode

New `RunMode` value `'resolve'`, spawned via the existing orchestrator-run
machinery (claim, lease, heartbeat, reclaim all reused).

- **Workspace:** the task's existing worktree.
- **Prompt:** "Merge `<target branch>` into your branch. Resolve all conflicts
  preserving the intent of both sides. Verify (typecheck/build per board
  docs). Commit. Call `kanban_complete`."
- **Tools:** `kanban_show`, `kanban_comment`, `kanban_heartbeat`,
  `kanban_complete`, `kanban_block`.
- **On complete:** task returns to `review`; the next `integrate()` pass
  retries the merge.
- **Budget:** new `resolve_attempts` column, incremented per spawned resolve
  run, capped at 2. Past the cap the task moves to `blocked` with a
  notification. Reset on successful merge.

**Feature-sync conflicts** (no task worktree exists for the integration
branch): the dispatcher creates a visible system task — *"Sync `<feature>`
with main"* — whose worktree checks out the integration branch itself,
dispatched in resolve mode with the target `baseBranch`. On completion the
feature-ready flow retries. This reuses the whole worker pipeline rather than
inventing a second execution path. The task carries the `featureId` and is
excluded from the feature's own completion roll-up (it would otherwise gate
itself); exclusion key: new column `tasks.system_kind`
(`'feature_sync' | NULL`) — roll-ups and completion checks skip rows where it
is non-null.

## 3. Draft PR lifecycle

- First successful merge into a feature branch → push `fleet/feature-<id>` and
  `gh pr create --draft` (extend existing `createFeaturePr()` with a draft
  flag). PR URL/number stored on the feature (existing columns).
- Subsequent merges → push only; the PR updates itself. `PrPoller` (existing)
  keeps `prState`/`checksState` fresh.
- All member tasks done + clean sync → `gh pr ready <number>` + notification.
- Manual **Ship** button remains as an override at any point.
- No `gh` / no remote: skip PR steps and post one deduped feature event
  (tracked via a feature-level flag) — never a comment per tick.

## 4. Auto-grouping into features

**At decompose (deterministic, in code):** when a decompose run completes
having created ≥2 worktree children and no feature, the dispatcher/commands
layer creates a feature named after the parent task and assigns parent +
children to it. This does not rely on the orchestrator prompt remembering
`kanban_feature_create`.

**Loose-ticket detection (PM, suggestion-gated):**

- Heuristic gate in the dispatcher: ≥2 ungrouped worktree tasks sharing a
  `repoPath` in `todo`/`ready`, and no pending suggestion for that repo.
  Debounced (one detection run per repo per cooldown window).
- Spawns one PM run that judges relatedness and may call a new tool
  `kanban_suggest_feature(name, task_ids, reason)`.
- Suggestions persist in a new `feature_suggestions` table:
  `id, board_id, name, task_ids (JSON), reason, status
  ('pending'|'accepted'|'dismissed'), created_at`.
- UI: board banner listing pending suggestions with **Accept** (creates the
  feature, assigns the tasks) and **Dismiss**. Nothing regroups without a
  click.

## 5. Auto-assignment

Fixes the silent-stall gap for unassigned tasks.

- **Trigger:** dispatcher stage `autoAssign()` flags unassigned `ready` tasks
  with `pending_mode='assign'` (new `PendingMode` value).
- **Fast path:** if exactly one worker profile exists, set it directly in code
  (no LLM run) and append an `assigned` event.
- **LLM path:** spawn an orchestrator run in new mode `'assign'`. The prompt
  contains the task and the worker-profile roster (names + descriptions +
  instructions). Terminal tool: new `kanban_assign(profile)` — sets the
  assignee with the same phantom-profile guard as `kanban_create`, ends the
  run. Side tools: `kanban_show`, `kanban_comment`, `kanban_heartbeat`.
- **After assignment:** task returns to `ready`; the normal `claimAndSpawn()`
  picks it up next tick.
- **Fallback:** if the assign run fails twice (reusing the
  decompose-style failure handling) or no orchestrator-capable profile
  exists, assign the default worker profile (the same fallback
  `resolveWorkProfile()` already encodes) and comment why.
- **Gate:** new `autoAssign` setting, default **on** (unlike `autoDecompose`,
  this repairs a dead-end rather than changing workflow shape).

`readyTasks()`'s `assignee IS NOT NULL` filter stays — it is what keeps the
assign stage and the claim stage from racing.

## 6. Settings & guardrails

New kanban settings (with existing dispatcher settings):

| Setting | Default | Effect |
|---|---|---|
| `autoIntegrate` | on | enables the `integrate()` stage |
| `autoAssign` | on | enables the `autoAssign()` stage |

Hard guardrails, not configurable:

- Merges only; never force-push, never rewrite shared history.
- Resolve attempts capped at 2 → `blocked` + notification.
- All git ops best-effort: failures append comments/events (existing
  pattern), never throw out of the tick.
- Every automated action appends a task/feature event, so the audit trail
  stays complete.

## 7. UI

- Card/drawer badge for resolve and assign runs (e.g. "resolving conflicts —
  attempt 1/2"), driven by run mode + events already streamed to the board.
- `FeaturePrRollup`: show draft vs ready PR state; Ship button unchanged.
- Board banner for pending feature suggestions (Accept / Dismiss).
- Integration events (auto-merged, PR drafted, PR ready, resolve spawned)
  appear in the task comment/event thread.

## 8. Data model changes

- `tasks.resolve_attempts` (INTEGER, default 0).
- `tasks.system_kind` (TEXT, `'feature_sync' | NULL`) — system tasks excluded
  from feature roll-ups.
- `PendingMode` gains `'assign'`; `RunMode` gains `'resolve'` and `'assign'`.
- New table `feature_suggestions` (section 4).
- Feature-level flag for the deduped "PR skipped: no remote/gh" event.
- Additive migration via existing `addColumnIfMissing` pattern (schema v11).

## 9. Testing

Vitest unit tests, following the existing dispatcher test style (mocked store
deps / workspace fns):

- `integrate()`: clean merge → done + prune + PR ensured; conflict → resolve
  spawn; attempt cap → blocked + notification; all-done feature → sync + PR
  ready; sync conflict → system sync task; `autoIntegrate` off → no-op.
- `resolve` mode: complete → back to `review`; attempts increment/reset.
- `autoAssign()`: single-profile fast path; LLM path spawn; fallback to
  default profile; `autoAssign` off → no-op; `kanban_assign` rejects unknown
  profiles.
- Auto-grouping: decompose with ≥2 worktree children and no feature → feature
  created; suggestion accept/dismiss state transitions.
- Manual merge conflict → resolve run spawned (standalone task path).

## Implementation phasing

1. **Auto-assignment** (standalone, unblocks daily use immediately).
2. **`integrate()` + `resolve` mode** (feature auto-merge + conflict agent).
3. **Draft PR lifecycle** (extends 2).
4. **Auto-grouping** (decompose enforcement, then PM suggestions + UI).
