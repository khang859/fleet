# Kanban Phase 5 — Worktree Workspaces Design

**Status:** Approved (design)
**Date:** 2026-05-30
**Parent:** `docs/superpowers/specs/2026-05-30-kanban-board-design.md` (§Phasing item 5: Advanced — worktrees)
**Sibling specs:** orchestrator/auto-decompose (done), multiple boards (future), attachments (future)

## Goal

A kanban task with `workspaceKind: 'worktree'` runs in a dedicated git worktree created from a per-task **source repo**, on a deterministic `kanban/<taskId>` branch. The worktree is reused across retries and preserved after the task finishes (never auto-removed).

## Background

`WorkspaceKind = 'scratch' | 'dir' | 'worktree'` already exists in `src/shared/kanban-types.ts`. Today `prepareWorkspace` (`src/main/kanban/workspace.ts`) only implements `scratch` (creates `~/.fleet/kanban/workspaces/<taskId>`); `dir` and `worktree` require an explicit `path` and otherwise throw. This spec makes `worktree` real.

A separate async `WorktreeService` (`src/main/worktree-service.ts`, simple-git) exists for the terminal/worktree-tab feature. We deliberately do **not** reuse it for kanban worktree *creation* — see "Why synchronous git" below. It may be reused for a future manual-removal feature.

### The atomic-tick invariant

The dispatcher `tick()` is synchronous. CAS claims (`claimTask`, `claimForDecompose`) are race-free precisely because there is no `await` yield point between claiming a task and spawning its worker within a single tick. `prepareWorkspaceFn` is called synchronously inside `claimAndSpawn` and `decompose` (`kanban-dispatcher.ts:101`, `:141`). Any worktree creation must therefore be **synchronous** to preserve this invariant — an async prep step would introduce a yield point and reopen the claim race.

## Decisions (locked)

| Question | Decision |
|---|---|
| Source repo | Per-task field — new `repo_path` column (not overloaded onto `workspacePath`). |
| Cleanup | Never auto-remove; preserve worktree + branch after the task finishes. |
| Branch name | Task-derived, deterministic: `kanban/<taskId>`. |
| Retry behavior | Reuse the existing worktree (create-or-reuse), preserving partial commits. |
| Prep architecture | Synchronous git via `execFileSync` (Approach A). |
| Worktree location | Kanban-owned, task-keyed: `~/.fleet/kanban/worktrees/<taskId>`. |

### Why synchronous git (Approach A)

`git worktree add` is typically sub-second and shares the source repo's object store, so the brief main-thread block is acceptable. Keeping prep synchronous preserves the race-free dispatcher tick. The alternative (make `prepareWorkspaceFn` async) was rejected because it forces an `await` into the claim→spawn window.

### Field semantics by kind

| Kind | `repoPath` | `workspacePath` | `branchName` |
|---|---|---|---|
| `scratch` | null | null (computed `~/.fleet/kanban/workspaces/<taskId>`) | null |
| `dir` | null | explicit dir the worker runs in | null |
| `worktree` | source repo (set at create) | created worktree path (persisted on first run) | `kanban/<taskId>` (persisted on first run) |

## Architecture

### 1. Data model (schema v3, additive)

- Add column `tasks.repo_path TEXT` via the existing `addColumnIfMissing` helper; bump `SCHEMA_VERSION` from 2 to 3. Migration is guarded (`if (current !== SCHEMA_VERSION)`) and additive, matching the v2 pattern.
- `src/shared/kanban-types.ts`: add `repoPath: string | null` to `Task`; add optional `repoPath?: string` to `CreateTaskInput`.
- `rowToTask` maps `repo_path` → `repoPath`.
- `KanbanStore.createTask` persists `repo_path` from the input.

### 2. Worktree create-or-reuse helper (`src/main/kanban/workspace.ts`)

`prepareWorkspace` gains a real `worktree` branch. Inputs needed for worktree kind: `taskId`, `repoPath`, current `workspacePath`, current `branchName`, and the kanban worktrees root.

Logic for `kind === 'worktree'`:

1. **Reuse:** if `workspacePath` is set and that directory exists → return `{ path: workspacePath, branchName }`.
2. **Validate:** require `repoPath`; verify it is a git repo (`git -C <repoPath> rev-parse --git-dir`). On failure, throw.
3. **Create:** compute `worktreeDir = <worktreesRoot>/<taskId>` (`worktreesRoot = ~/.fleet/kanban/worktrees`). Branch = `kanban/<taskId>`.
   - Primary: `git -C <repoPath> worktree add <worktreeDir> -b kanban/<taskId>`.
   - Branch-exists recovery: if the branch already exists (orphaned from a prior run that lost its `workspacePath`), attach instead: `git -C <repoPath> worktree add <worktreeDir> kanban/<taskId>`.
4. Return `{ path: worktreeDir, branchName: 'kanban/<taskId>' }`.

All git invocations use `execFileSync` (no shell). The function signature changes from returning `string` to returning `{ path: string; branchName: string | null }` so the caller can persist the branch. (`scratch`/`dir` return `{ path, branchName: null }`.)

`cleanupWorkspace` is unchanged: only `scratch` is removed; `dir`/`worktree` are preserved.

### 3. Persistence + dispatcher wiring

For reuse-on-retry, the created worktree path and branch must be persisted on the task on first creation.

- Add `KanbanStore.setWorkspace(taskId, path, branchName)` — updates `workspace_path` and `branch_name`.
- `DispatcherDeps.prepareWorkspaceFn` keeps its `(task) => string` signature at the dispatcher boundary; persistence happens inside the closure. The live `prepareWorkspaceFn` in `src/main/index.ts` calls the helper, and when it creates a worktree, calls `store.setWorkspace(task.id, path, branchName)` before returning the path string. The dispatcher continues to receive a `string` and pass it as `workspace` to `spawnWorker` — no dispatcher logic change.

  Rationale: the dispatcher stays agnostic of workspace kinds; index.ts owns wiring (store + paths), consistent with the current design where `prepareWorkspaceFn` is constructed in index.ts with `KANBAN_HOME`.

### 4. Create surfaces

- **CLI** (`fleet kanban create`): add `--workspace <scratch|dir|worktree>` and `--repo <path>`. Validation: if `--workspace worktree`, `--repo` is required and must be an existing path; otherwise error before creating.
- **Board UI** (new-task form): add a workspace-kind selector; when `worktree` is selected, show a source-repo path input. Defaults come from `settings.kanban.defaults` (existing).
- `KanbanCommands.create` validates: `workspaceKind === 'worktree'` requires a non-empty `repoPath`, else `BAD_REQUEST`.

## Data flow

```
create task (kind=worktree, repoPath=/src/repo)
  → stored: repo_path=/src/repo, workspace_path=NULL, branch_name=NULL
dispatcher tick → claimTask → prepareWorkspaceFn(task)
  → helper: no workspacePath → create worktree
      git -C /src/repo worktree add ~/.fleet/kanban/worktrees/<id> -b kanban/<id>
  → store.setWorkspace(id, ~/.fleet/kanban/worktrees/<id>, kanban/<id>)
  → returns worktree path
  → spawnWorker runs rune in the worktree
[task fails, returned to ready]
dispatcher tick → claimTask → prepareWorkspaceFn(task)
  → helper: workspacePath set & exists → REUSE (partial commits intact)
[task done] → cleanupWorkspace: worktree preserved
```

## Error handling

- **Missing `repoPath`** for worktree kind: rejected at create time (`KanbanCommands.create` → `BAD_REQUEST`).
- **Invalid repo / `git worktree add` failure** at prep time: the helper throws; `prepareWorkspaceFn` propagates; the dispatcher's existing `try/catch` in `claimAndSpawn`/`decompose` runs `recordFailure` + `returnToReady` (work) / `setStatusCleared('triage')` + re-flag (decompose), with retries up to `failureLimit` then `gave_up`. No new error path is introduced.
- **Branch already exists** (orphaned): handled by the attach-recovery in the helper (step 3), not an error.

## Testing strategy

- `src/main/kanban/workspace.test.ts`:
  - create: builds a worktree from a real temp git repo on `kanban/<taskId>`; returns the path + branch.
  - reuse: second call with `workspacePath` set returns it without invoking git create.
  - branch-exists recovery: pre-create the branch, then prep attaches rather than failing.
  - invalid repo: throws.
  - scratch/dir unchanged (existing behavior, `branchName: null`).
- Store: schema v3 migration test (open a v2 DB lacking `repo_path`, reopen, assert column added + `user_version=3`); `setWorkspace` persists path + branch; `createTask` persists `repoPath`.
- `KanbanCommands.create`: worktree-kind without `repoPath` → `BAD_REQUEST`; with `repoPath` → stored.
- CLI: `--workspace worktree` without `--repo` errors; with `--repo` threads `repoPath` into create.

## Non-goals (this spec)

- Worktree **removal** UI/CLI (preserve-only for now; manual `git worktree remove` or a later feature, possibly reusing `WorktreeService.remove`).
- Orchestrator children auto-inheriting the parent's repo/worktree (MCP `kanban_create` does not yet thread `repoPath`; future follow-up).
- Changing the `dir` kind (stays explicit-path).
