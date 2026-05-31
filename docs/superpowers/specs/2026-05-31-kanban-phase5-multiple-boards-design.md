# Kanban Phase 5 — Multiple Boards Design

**Status:** Approved (design)
**Date:** 2026-05-31
**Parent spec:** `docs/superpowers/specs/2026-05-30-kanban-board-design.md` (§ Multiple boards)

## Goal

Let users organize kanban tasks into multiple named boards. The implementation
keeps a **single** `kanban.db`, adding a `boards` registry table and a
`board_id` column on tasks. The dispatcher runs **all boards** continuously; the
UI shows one board at a time with a switcher and create/rename/delete
management. Existing tasks migrate onto a permanent **"default"** board. This is
the last of the four Phase 5 subsystems (worktrees ✅, orchestrator ✅,
attachments ✅, multiple boards).

## Decisions (settled during brainstorming)

- **Dispatch scope:** all non-archived boards run workers continuously — not
  just the board currently in view.
- **Storage:** single DB + `board_id` column (not DB-file-per-board). Chosen
  because task IDs are globally unique (so workspaces/worktrees/attachments need
  no on-disk reshuffle) and the dispatcher already scans the whole `tasks`
  table, so "all boards always" costs almost no dispatcher change.
- **Board ops in v1:** create, switch, rename, delete.
- **Remove semantics:** block while the board has a running worker, then
  hard-delete the board, its tasks, and their on-disk data. No soft-archive.
- **Worker/MCP surface:** each worker is implicitly scoped to its task's board;
  orchestrator-created children inherit the parent's board. Workers get **no**
  board-management tools.

## Background / grounding

- `KANBAN_HOME = ~/.fleet/kanban` (`src/main/index.ts:751`); the DB is
  `KANBAN_HOME/kanban.db`. Workspaces/worktrees/logs/attachments live in sibling
  dirs keyed by **globally unique** `taskId` (`randomUUID().slice(0,8)`), so a
  single shared DB needs no per-board directory layout.
- `migrate()` (`kanban-store.ts:35-50`) runs `SCHEMA_SQL` (all
  `CREATE … IF NOT EXISTS`) unconditionally, then version-gated additive blocks
  using `addColumnIfMissing` (a `PRAGMA table_info` guard, idempotent on fresh
  and existing DBs), then sets `user_version`.
- The dispatcher (`kanban-dispatcher.ts`) and MCP server
  (`kanban-mcp-server.ts`) each hold **one** `KanbanStore`. The dispatcher's
  `readyTasks()`/`runningTasks()`/`promotableTodoTasks()` already query the
  whole `tasks` table; the MCP server resolves tasks by `scope.taskId`. Both are
  board-agnostic at the row level today.
- The orchestrator's `kanban_create` handler (`kanban-mcp-server.ts:~321`)
  creates child tasks; this is where board inheritance is added (mirroring the
  worktree `repoPath` inheritance already shipped).
- Live refresh: `store.appendEvent` → `onEvent` → renderer `KANBAN_EVENT`
  (coalesced board+detail refetch, `App.tsx:308-317`).

## Data model (schema v5)

New `boards` table in `SCHEMA_SQL` with `IF NOT EXISTS`:

```sql
CREATE TABLE IF NOT EXISTS boards (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

No `icon`/`description`/`archived_at` columns — hard-delete (no soft-archive) is
the chosen lifecycle and no icons were requested (YAGNI).

`tasks` gains:

```sql
board_id TEXT NOT NULL DEFAULT 'default'
```

plus `CREATE INDEX IF NOT EXISTS idx_tasks_board ON tasks(board_id);`. No FK
constraint (the schema declares none anywhere; orphan rows are the existing
norm).

**Migration:**

1. Add `board_id TEXT NOT NULL DEFAULT 'default'` to the `tasks` CREATE in
   `SCHEMA_SQL` (covers fresh DBs) and add the `boards` table + `idx_tasks_board`
   to `SCHEMA_SQL`.
2. In `migrate()`: `if (current < 5)` →
   `addColumnIfMissing('tasks', 'board_id', "TEXT NOT NULL DEFAULT 'default'")`
   (covers existing v4 DBs; idempotent on fresh DBs that already have the column).
3. **Unconditionally** seed the default board:
   `INSERT OR IGNORE INTO boards (slug, name, created_at, updated_at) VALUES ('default', 'Default', <now>, <now>)`.
4. Bump `SCHEMA_VERSION` 4 → 5.

Existing tasks inherit `board_id = 'default'` via the column default. `'default'`
is a permanent board: renamable, never deletable.

## Why the dispatcher barely changes

With a single store and "all boards always," the dispatcher's existing whole-table
queries claim and run ready tasks on **any** board with no change — `board_id`
rides along on each `Task` row.

The one **correctness** change in the worker path: `kanban_create` sets the
child's `board_id` to the parent task's `board_id`. This keeps a decomposed task
tree on a single board. Because inheritance happens in the store/MCP layer, **no**
`FLEET_KANBAN_BOARD` environment variable is needed (omitted — YAGNI).

## Store / command surface

- **`boards` CRUD on `KanbanStore`:**
  - `listBoards(): Board[]` — ordered (default first, then by `created_at ASC`).
  - `createBoard(name): Board` — derive slug from name, uniquify on collision.
  - `renameBoard(slug, name): void` — update `name` + `updated_at`; slug fixed.
  - `deleteBoard(slug): void` — see below.
- **Slug rules:** lowercase; must start with `[a-z0-9]`; `-`/`_` allowed
  internally; 1–64 chars; no path traversal characters. Derivation lowercases,
  replaces runs of non-`[a-z0-9]` with `-`, trims leading/trailing `-`, and
  truncates to 64. On collision, append `-2`, `-3`, … An empty/invalid derived
  slug → `BAD_REQUEST`.
- **`createTask`** accepts an optional `boardId` (default `'default'`); the
  `INSERT` writes `board_id`.
- **`listBoard(boardSlug): BoardCard[]`** filters cards to one board.
- **`deleteBoard(slug)`** runs in a transaction:
  1. Reject if `slug === 'default'` (`BAD_REQUEST`).
  2. Reject if any task on the board has status `running` (or a live claim)
     (`BAD_REQUEST`, message "stop running tasks first" — mirrors the existing
     `setManualStatus` running-task guard).
  3. Best-effort on-disk cleanup per task on the board: `removeWorktree` for
     `workspaceKind === 'worktree'`, `cleanupWorkspace` for `scratch`, and remove
     the `attachments/<taskId>` directory. Never blocks the DB delete on a
     filesystem error (matches the worktree-removal style). Worker logs
     (`logs/<runToken>.log`) are keyed by run token, not task id, and are left
     in place (tiny, shared dir) — same accepted-orphan tradeoff as
     attachments-on-archive.
  4. Delete the board's rows across `task_attachments`, `task_comments`,
     `task_events`, `task_runs`, `task_links` (where parent or child belongs to
     the board), and `tasks` (where `board_id = slug`), then delete the `boards`
     row.
- **Commands:** `createBoard`/`renameBoard`/`deleteBoard`/`listBoards` wrappers
  with validation. Board operations are not task-scoped, so they do **not** write
  `task_events`; they trigger the board-changed signal below.

## IPC + preload

- New channels: `KANBAN_LIST_BOARDS`, `KANBAN_CREATE_BOARD`,
  `KANBAN_RENAME_BOARD`, `KANBAN_DELETE_BOARD`.
- The existing board-fetch IPC (`listBoard`) gains a `boardSlug` argument.
- Request types in `ipc-api.ts`; preload methods on the `kanban` block:
  `listBoards`, `createBoard(name)`, `renameBoard(slug, name)`,
  `deleteBoard(slug)`.

## Renderer

- **`Board` type** (`shared/kanban-types.ts`): `{ slug; name; createdAt; updatedAt }`.
- **Store:** `boards: Board[]`, `activeBoardSlug: string` (persisted to
  `localStorage`, falling back to `'default'`), `loadBoards()`,
  `createBoard/renameBoard/deleteBoard/switchBoard`. `loadBoard()` passes
  `activeBoardSlug`. `switchBoard(slug)` sets the slug then reloads cards. If the
  active board is deleted, fall back to `'default'` and reload.
- **UI:** a board switcher in the `KanbanBoard` toolbar — a dropdown showing the
  active board's name and the board list, a "＋ New board" item (prompts for a
  name), and a small per-board affordance to rename/delete. Delete confirms and
  surfaces the "stop running tasks" / "can't delete default" errors inline. The
  switcher is always present (unobtrusive when only the default board exists).

## Live refresh

Board create/rename/delete are not tied to a task, so they broadcast a
lightweight **`KANBAN_BOARDS_CHANGED`** renderer signal (separate from the task
`KANBAN_EVENT` feed) that triggers `loadBoards()` in the renderer. Task activity
keeps flowing through the existing `KANBAN_EVENT` → `loadBoard()` path, reloading
the active board.

## Error handling

- Duplicate board name → slug uniquified (`research`, `research-2`, …).
- Empty/invalid name → `BAD_REQUEST`.
- Delete default board / delete a board with a running task → `BAD_REQUEST`,
  surfaced inline in the switcher UI.
- On-disk cleanup during delete is best-effort and never blocks the DB delete.

## Testing strategy

- **Store:** board CRUD; slug derivation, uniquing, and validation; `createTask`
  honors `boardId`; `listBoard(slug)` isolates cards across boards; `deleteBoard`
  cascades all child rows and is blocked for `'default'` and for a board with a
  running task; the migration backfills existing tasks to `'default'` and seeds
  the default board.
- **MCP/commands:** orchestrator `kanban_create` places children on the parent's
  board; board command wrappers validate.
- **Migration:** a v4 DB opens at v5 with `boards` present, the default board
  seeded, and pre-existing tasks on `'default'`, rows intact.

## Non-goals (v1)

- No DB-file-per-board.
- No cross-board task links.
- No board icons/descriptions, no soft-archive, no board reordering.
- No `FLEET_KANBAN_BOARD` env var, no per-board dispatcher enable/disable.
- No board MCP tools for workers (workers are implicitly board-scoped).
