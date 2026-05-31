# Kanban Phase 5 Follow-ups — Worktree Removal + Child Repo Inheritance Design

**Status:** Approved (design)
**Date:** 2026-05-31
**Parent:** `docs/superpowers/specs/2026-05-30-kanban-phase5-worktree-design.md` (§Non-goals)
**Validated by:** two independent subagent reviews (both flagged the same critical hook-point bug; design below incorporates the fix)

## Goal

Two small, independent follow-ups to the worktree-workspace feature:

1. **Auto-remove worktree on archive** — when a worktree-kind task is archived, remove its git worktree and delete its `kanban/<taskId>` branch (full cleanup). Tasks reaching `done` still preserve their worktree.
2. **Child repo inheritance** — when an orchestrator decomposes a worktree-kind task (with a `repoPath`), its children inherit `workspaceKind: 'worktree'` and the parent's `repoPath`, each getting their own `kanban/<childId>` worktree off the same source repo.

## Background

Field semantics (from the parent spec) are unchanged:

| Kind | `repoPath` | `workspacePath` | `branchName` |
|---|---|---|---|
| `worktree` | source repo (set at create) | created worktree dir `~/.fleet/kanban/worktrees/<taskId>` (persisted on first run) | `kanban/<taskId>` (persisted on first run) |

`cleanupWorkspace` (`workspace.ts:95`) exists and is tested but is **not wired into any production call site** (verified) — it only removes `scratch`. So today archival does nothing to workspaces, and worktrees are preserved indefinitely.

`prepareWorkspace` is called **synchronously** inside the dispatcher's atomic tick (no `await` between CAS claim and spawn). Worktree **removal**, by contrast, runs in a command handler (archive), **not** in the tick, so it can use synchronous `execFileSync` without any race concern — matching the existing `workspace.ts` style.

## Feature 1 — Auto-remove worktree on archive

### 1a. `removeWorktree` helper (`src/main/kanban/workspace.ts`)

New exported function:

```ts
export function removeWorktree(input: {
  repoPath: string;
  workspacePath: string;
  branchName: string | null;
}): void
```

Synchronous, best-effort, never throws on git failure. Structure so directory cleanup is **independent** of the git calls (a moved/deleted `repoPath` must not leak the worktree dir):

1. `git -C <repoPath> worktree remove --force <workspacePath>` (force: the worktree may be dirty).
2. If step 1 throws (dir already gone, repo moved, etc.): `rmSync(workspacePath, { recursive: true, force: true })`, then best-effort `git -C <repoPath> worktree prune`.
3. `git -C <repoPath> branch -D <branchName>` when `branchName` is non-null (best-effort; ignore "branch not found"). `-D` force-deletes regardless of merge state — kanban branches are usually unmerged.

We do **not** reuse the async `WorktreeService.remove` (`src/main/worktree-service.ts`): it derives the branch name from the worktree dir basename, which for kanban is `<taskId>`, not our `kanban/<taskId>` branch — it would delete the wrong branch (or none).

`cleanupWorkspace` is left unchanged (still scratch-only); `removeWorktree` is a distinct, explicit operation.

### 1b. Wiring — `KanbanCommands.setManualStatus` (`src/main/kanban/kanban-commands.ts:99`)

**The hook point is `setManualStatus`, not `archive()`.** The UI archive button (`KanbanDrawer.tsx:137`) calls the renderer `setStatus(id,'archived')` → IPC `KANBAN_SET_STATUS` → `kanban-ipc.ts:34` → `commands.setManualStatus(id,'archived')`, bypassing `archive()` entirely (there is no `archive` IPC channel). `archive()` is a thin wrapper that itself calls `setManualStatus`. Hooking `setManualStatus` covers all three front doors (UI + CLI + socket).

In `setManualStatus(id, status)`, after the existing running-task guard and `setStatus`/`appendEvent`, when `status === 'archived'`:

- Use the task snapshot already read at the top of the method.
- If `task.workspaceKind === 'worktree'` **and** `task.workspacePath` **and** `task.repoPath`: call `removeWorktree({ repoPath, workspacePath, branchName })` inside a `try/catch` (best-effort; log a warning on failure).
- Ordering: status change **first**, removal **after**. Removal must never block archival — a failed git remove still archives the task.

No race with the dispatcher: `setManualStatus` already rejects archiving a `running` task (`kanban-commands.ts:101`, `BAD_REQUEST`), so no live worker is using the worktree at archive time, and the dispatcher never acts on `archived` tasks.

The archived task's `workspacePath`/`branchName` fields are **left in place** (not nulled) as a historical record. If the task is later un-archived and re-run, `prepareWorkspace`'s `existsSync` guard sees the removed dir, falls through to create, and `branchExists` is false (branch was deleted) → recreates cleanly with `-b`. Verified coherent.

### 1c. Surfaces

No CLI / socket / UI / IPC changes. `fleet kanban archive`, socket `kanban.archive`, and the UI archive button all reach `setManualStatus`, which now carries the removal.

## Feature 2 — Child repo inheritance

### Change — `kanban_create` MCP handler (`src/main/kanban/kanban-mcp-server.ts:321`)

In the decompose flow, `task` (= `store.getTask(scope.taskId)`, line 254) is the parent orchestrator task. When creating a child, inherit worktree settings **only when the parent is a worktree with a truthy `repoPath`**:

```ts
const inherit =
  task.workspaceKind === 'worktree' && task.repoPath
    ? { workspaceKind: 'worktree' as const, repoPath: task.repoPath }
    : {};
const child = this.store.createTask({
  title: a.title,
  body: a.body ?? '',
  assignee: a.assignee ?? null,
  priority: a.priority ?? 0,
  status: 'todo',
  ...inherit
});
```

The `&& task.repoPath` guard is required: `store.createTask` bypasses `KanbanCommands.create`'s "worktree requires repoPath → `BAD_REQUEST`" validation, so we must not produce a worktree child without a repo (it would throw at claim time and loop on spawn failure).

The child needs **no** `branchName` at creation — `createTask` always persists `workspace_path = NULL`, so on first claim `prepareWorkspaceFn` derives `kanban/<childId>`, creates the worktree, and persists path + branch. Each child gets its own worktree off the parent's source repo via the existing promote → claim → `prepareWorkspaceFn` path. **No dispatcher change.** The `kanban_create` tool input schema is unchanged — inheritance is implicit.

## Data flow

```
Archive (Feature 1):
  user archives worktree task (UI button | CLI | socket)
    → commands.setManualStatus(id, 'archived')
        → reject if running (existing guard)
        → setStatus('archived') + appendEvent
        → if worktree + workspacePath + repoPath: removeWorktree(...) [best-effort]
            git -C <repo> worktree remove --force <workspacePath>   (fallback: rmSync + prune)
            git -C <repo> branch -D kanban/<taskId>

Inheritance (Feature 2):
  orchestrator decomposes worktree parent (repoPath=/src/repo)
    → kanban_create → child created { workspaceKind:'worktree', repoPath:/src/repo, status:'todo', workspace_path:NULL }
  child promoted to ready → dispatcher claim → prepareWorkspaceFn
    → creates ~/.fleet/kanban/worktrees/<childId> on kanban/<childId> from /src/repo
```

## Error handling

- **Removal failure** (repo moved/deleted, locked worktree, branch checked out elsewhere): swallowed by the `try/catch` in `setManualStatus`; archival proceeds. The dir-cleanup `rmSync` runs independently of git so the worktree dir is not leaked when only the repo is gone.
- **Worktree never created** (task archived before first claim → `workspacePath` null): removal skipped by the guard; no branch exists either (branch + dir are created together).
- **Inherited child with no repo:** impossible — gated on truthy `parent.repoPath`.

## Testing strategy

- `kanban-workspace.test.ts`:
  - `removeWorktree` removes a real temp worktree dir and deletes its `kanban/<taskId>` branch.
  - Safe no-op style when the dir was already deleted out-of-band (falls back to rmSync + prune; does not throw).
  - Force-removes a dirty worktree (uncommitted changes present).
- `kanban-commands.test.ts`:
  - Archiving a worktree task **via `setManualStatus('archived')`** (the UI path) triggers removal — this is the regression test for the critical hook-point bug.
  - Archiving a scratch task does not attempt worktree removal.
  - Archival still succeeds when `removeWorktree` throws (inject a failure) — task ends `archived`.
- `kanban-mcp-server.test.ts` (or the MCP create test location):
  - `kanban_create` under a worktree parent yields a child with `workspaceKind:'worktree'` carrying the parent's `repoPath`.
  - `kanban_create` under a scratch / null-repo parent yields a scratch child (no inheritance).

## Non-goals (this spec)

- Manual (non-archive) worktree removal command/UI — archive is the single removal trigger.
- Nulling `workspacePath`/`branchName` on the archived task (verified harmless to leave).
- Changing `scratch`/`dir` cleanup behavior.
- Sharing a single worktree across children (each child gets its own).
