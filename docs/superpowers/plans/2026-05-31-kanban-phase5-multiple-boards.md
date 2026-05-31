# Kanban Multiple Boards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users organize kanban tasks into multiple named boards, stored in one DB via a `boards` table + a `board_id` column on tasks, with a board switcher + create/rename/delete UI; the dispatcher keeps running all boards.

**Architecture:** Single `kanban.db`. A `boards` registry table and a `board_id` column on `tasks` (default `'default'`). A pure slug helper (`board-slug.ts`); store board CRUD + a cascading `deleteBoard`; command wrappers; orchestrator children inherit the parent's board; IPC/preload + a `KANBAN_BOARDS_CHANGED` broadcast; renderer store + a toolbar board switcher. The dispatcher and MCP server are unchanged except that `kanban_create` sets the child's `board_id`.

**Tech Stack:** TypeScript (ESM), Electron main/preload, React (zustand) renderer, better-sqlite3, vitest.

**Spec:** `docs/superpowers/specs/2026-05-31-kanban-phase5-multiple-boards-design.md`

---

## Background the implementer must know

- **Migration mechanism:** `migrate()` (`src/main/kanban/kanban-store.ts:35-50`) runs `SCHEMA_SQL` (all `CREATE … IF NOT EXISTS`) unconditionally, then version-gated additive blocks using `addColumnIfMissing(table, column, decl)` — a `PRAGMA table_info` guard that is idempotent on both fresh DBs (column already present from `SCHEMA_SQL`) and existing DBs (column added). A new table needs only a `SCHEMA_SQL` entry + a `SCHEMA_VERSION` bump. No FK constraints exist anywhere (orphan rows are the norm).
- **Dispatcher/MCP are board-agnostic at the row level:** `readyTasks()`/`runningTasks()`/`promotableTodoTasks()` scan the whole `tasks` table, so "all boards always" needs no dispatcher change. The MCP server resolves tasks by `scope.taskId`. The only worker-path change is board inheritance in `kanban_create`.
- **Event/broadcast model:** `KanbanStore` takes an `onEvent` option; `index.ts:753` wires it to `BrowserWindow.getAllWindows().forEach(w => w.webContents.send(KANBAN_EVENT, event))`. This plan adds a parallel `onBoardsChanged` option broadcast as `KANBAN_BOARDS_CHANGED`.
- **Validation lives in the command layer:** `KanbanCommands` throws `CodedError(msg, 'BAD_REQUEST' | 'NOT_FOUND')` (`kanban-commands.ts:3,53,89-111`). The store does not throw coded errors.
- **Cleanup helpers** (`src/main/kanban/workspace.ts`): `removeWorktree({repoPath, workspacePath, branchName})` (best-effort, never throws) and `cleanupWorkspace({kind, path})` (removes only `scratch`).
- **Verification commands:** `npm run typecheck`; `npm run lint`; tests: `npx vitest run src/main/__tests__`. Build: `npm run build`.
- **Lint baseline:** the repo has a large pre-existing lint baseline; the bar is *no NEW errors in the files you changed*. The store's `rowTo*` mappers use `as Record<string, unknown>[]` casts that trip `no-unsafe-type-assertion`/`array-type` — these are the established pattern; match it, don't fight it.

---

## Task 1: Schema v5 — `boards` table + `board_id` column + migration

**Files:**
- Modify: `src/main/kanban/schema.ts`
- Modify: `src/main/kanban/kanban-store.ts` (migrate)
- Test: `src/main/__tests__/kanban-store.test.ts`

- [ ] **Step 1: Update the failing version assertions**

In `src/main/__tests__/kanban-store.test.ts`, change every `expect(<store>.schemaVersion()).toBe(4)` to `toBe(5)` (grep `schemaVersion()).toBe(4)` to find all occurrences — there are 5). Also update the two fresh-db test titles that say `v4` to say `v5`. Leave the existing "upgrades a v2 db to v3" test untouched.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts`
Expected: FAIL — `schemaVersion()` returns 4, assertions expect 5.

- [ ] **Step 3: Add the table, the column, and the migration**

In `src/main/kanban/schema.ts`:
(a) Change `export const SCHEMA_VERSION = 4;` to `export const SCHEMA_VERSION = 5;`
(b) In the `tasks` `CREATE TABLE`, add a `board_id` column. Add this line immediately after the `skills TEXT NOT NULL DEFAULT '[]',` line:
```sql
  board_id TEXT NOT NULL DEFAULT 'default',
```
(c) After the `idx_tasks_idem` index line, add a board index:
```sql
CREATE INDEX IF NOT EXISTS idx_tasks_board ON tasks(board_id);
```
(d) After the `task_attachments` block (after its index, before the closing backtick), append the boards table:
```sql

CREATE TABLE IF NOT EXISTS boards (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

In `src/main/kanban/kanban-store.ts`, in `migrate()`, after the `if (current < 3) {...}` block and before the `if (current !== SCHEMA_VERSION)` line, add:
```ts
    if (current < 5) {
      // Additive: DBs created before v5 lack the board column.
      this.addColumnIfMissing('tasks', 'board_id', "TEXT NOT NULL DEFAULT 'default'");
    }
    // Seed the permanent default board (idempotent: fresh and existing DBs).
    const ts = this.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO boards (slug, name, created_at, updated_at)
         VALUES ('default', 'Default', ?, ?)`
      )
      .run(ts, ts);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts`
Expected: PASS (existing tests, now at v5).

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/schema.ts src/main/kanban/kanban-store.ts src/main/__tests__/kanban-store.test.ts
git commit -m "$(cat <<'EOF'
feat(kanban): add boards table + board_id column (schema v5)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `board-slug.ts` — pure slug helper

**Files:**
- Create: `src/main/kanban/board-slug.ts`
- Test: `src/main/__tests__/kanban-board-slug.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/main/__tests__/kanban-board-slug.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { deriveBoardSlug, isValidBoardSlug } from '../kanban/board-slug';

describe('board-slug', () => {
  it('lowercases and hyphenates names', () => {
    expect(deriveBoardSlug('Research')).toBe('research');
    expect(deriveBoardSlug('My Board')).toBe('my-board');
    expect(deriveBoardSlug('  Hello   World  ')).toBe('hello-world');
    expect(deriveBoardSlug('Front-end & API')).toBe('front-end-api');
  });

  it('strips non-alphanumerics and leading/trailing hyphens', () => {
    expect(deriveBoardSlug('!!!')).toBe('');
    expect(deriveBoardSlug('café')).toBe('caf');
    expect(deriveBoardSlug('--edge--')).toBe('edge');
  });

  it('truncates to 64 chars with no trailing hyphen', () => {
    const slug = deriveBoardSlug('a'.repeat(80));
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('isValidBoardSlug accepts valid slugs and rejects junk', () => {
    expect(isValidBoardSlug('default')).toBe(true);
    expect(isValidBoardSlug('research-2')).toBe(true);
    expect(isValidBoardSlug('a_b')).toBe(true);
    expect(isValidBoardSlug('')).toBe(false);
    expect(isValidBoardSlug('-bad')).toBe(false);
    expect(isValidBoardSlug('../etc')).toBe(false);
    expect(isValidBoardSlug('a'.repeat(65))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-board-slug.test.ts`
Expected: FAIL — module `../kanban/board-slug` does not exist.

- [ ] **Step 3: Implement the helper**

Create `src/main/kanban/board-slug.ts`:
```ts
const MAX_SLUG = 64;

/** Reduce a display name to a safe slug: lowercase, [a-z0-9] + internal -/_, 1..64 chars. */
export function deriveBoardSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '');
}

export function isValidBoardSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/main/__tests__/kanban-board-slug.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/board-slug.ts src/main/__tests__/kanban-board-slug.test.ts
git commit -m "$(cat <<'EOF'
feat(kanban): add board slug derivation/validation helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `Board` type + `board_id` plumbing + store board CRUD (no delete)

**Files:**
- Modify: `src/shared/kanban-types.ts` (add `Board`, add `boardId` to `Task` + `CreateTaskInput`)
- Modify: `src/main/kanban/kanban-store.ts`
- Test: `src/main/__tests__/kanban-store.test.ts`

- [ ] **Step 1: Add the types**

In `src/shared/kanban-types.ts`:
(a) Add a `boardId: string;` field to the `Task` interface (after the `skills: string[];` line).
(b) Add `boardId?: string;` to `CreateTaskInput` (after its `skills?: string[];` line).
(c) After the `Task` interface, add:
```ts
export interface Board {
  slug: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}
```

- [ ] **Step 2: Write the failing tests**

In `src/main/__tests__/kanban-store.test.ts`, add this `describe` block after the existing top-level describe block (reuses `TEST_DIR`, `DB_PATH`, `KanbanStore`, vitest globals already imported in the file — verify names with grep):
```ts
describe('KanbanStore boards', () => {
  let store: KanbanStore;
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new KanbanStore(DB_PATH);
  });
  afterEach(() => {
    store.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('seeds the default board and new tasks land on it', () => {
    expect(store.listBoards().map((b) => b.slug)).toEqual(['default']);
    const t = store.createTask({ title: 'x' });
    expect(t.boardId).toBe('default');
  });

  it('creates boards with unique slugs derived from the name', () => {
    const a = store.createBoard('Research');
    expect(a.slug).toBe('research');
    const b = store.createBoard('Research');
    expect(b.slug).toBe('research-2');
    expect(store.listBoards().map((b2) => b2.slug)).toEqual(['default', 'research', 'research-2']);
  });

  it('renames a board (slug stays fixed)', () => {
    const a = store.createBoard('Research');
    store.renameBoard(a.slug, 'Renamed');
    expect(store.listBoards().find((b) => b.slug === 'research')?.name).toBe('Renamed');
  });

  it('createTask honors boardId and listBoard filters by board', () => {
    store.createBoard('Research');
    store.createTask({ title: 'on default' });
    store.createTask({ title: 'on research', boardId: 'research' });
    expect(store.listBoard('default').map((c) => c.title)).toEqual(['on default']);
    expect(store.listBoard('research').map((c) => c.title)).toEqual(['on research']);
    expect(store.listBoard().length).toBe(2);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts`
Expected: FAIL — `store.listBoards`/`createBoard` not a function; `t.boardId` undefined.

- [ ] **Step 4: Implement the plumbing + CRUD**

In `src/main/kanban/kanban-store.ts`:

(a) Add `Board` to the type import from `../../shared/kanban-types`, and add a value import for the slug helper near the other imports:
```ts
import { deriveBoardSlug } from './board-slug';
```

(b) In `rowToTask` (after the `skills:` line), add:
```ts
      boardId: String(r.board_id ?? 'default'),
```

(c) In `createTask`, add `board_id` to the INSERT. Add `board_id` to the column list and `@board_id` to the VALUES list (both in the `tasks` INSERT), and add to the `.run({...})` object:
```ts
        board_id: input.boardId ?? 'default',
```

(d) Change `listBoard()` to accept an optional board slug. Replace the method signature line `listBoard(): BoardCard[] {` with:
```ts
  listBoard(boardSlug?: string): BoardCard[] {
```
and replace its first line `const tasks = this.listTasks();` with:
```ts
    const tasks = boardSlug
      ? this.listTasks().filter((t) => t.boardId === boardSlug)
      : this.listTasks();
```

(e) Add a `rowToBoard` mapper and the board CRUD methods. Place them after `listBoard` (before `updateTask`):
```ts
  private rowToBoard(r: Record<string, unknown>): Board {
    return {
      slug: String(r.slug),
      name: String(r.name),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at)
    };
  }

  listBoards(): Board[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM boards
         ORDER BY CASE WHEN slug='default' THEN 0 ELSE 1 END, created_at ASC, slug ASC`
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToBoard(r));
  }

  private uniqueBoardSlug(base: string): string {
    const exists = (s: string): boolean =>
      this.db.prepare('SELECT 1 FROM boards WHERE slug=?').get(s) !== undefined;
    if (!exists(base)) return base;
    for (let n = 2; ; n += 1) {
      const candidate = `${base}-${n}`;
      if (!exists(candidate)) return candidate;
    }
  }

  createBoard(name: string): Board {
    const slug = this.uniqueBoardSlug(deriveBoardSlug(name));
    const ts = this.now();
    this.db
      .prepare('INSERT INTO boards (slug, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(slug, name, ts, ts);
    this.onBoardsChanged?.();
    return { slug, name, createdAt: ts, updatedAt: ts };
  }

  renameBoard(slug: string, name: string): void {
    this.db
      .prepare('UPDATE boards SET name=?, updated_at=? WHERE slug=?')
      .run(name, this.now(), slug);
    this.onBoardsChanged?.();
  }
```
NOTE: `this.onBoardsChanged` is added in Task 6. For now it does not exist — to keep this task compiling, add the optional field declaration and constructor wiring as part of THIS task: add `protected onBoardsChanged?: () => void;` near the other protected fields (alongside `onEvent`), and in the constructor add `this.onBoardsChanged = opts.onBoardsChanged;` next to `this.onEvent = opts.onEvent;`, and add `onBoardsChanged?: () => void;` to the `KanbanStoreOptions` interface. (Task 6 wires the actual broadcast in `index.ts`.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts`
Expected: PASS (existing + 4 new).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/shared/kanban-types.ts src/main/kanban/kanban-store.ts src/main/__tests__/kanban-store.test.ts
git commit -m "$(cat <<'EOF'
feat(kanban): Board type, board_id plumbing, and board CRUD (list/create/rename)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `deleteBoard` — cascade + best-effort fs cleanup

**Files:**
- Modify: `src/main/kanban/kanban-store.ts`
- Test: `src/main/__tests__/kanban-store.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/main/__tests__/kanban-store.test.ts`, inside the `describe('KanbanStore boards', …)` block from Task 3, add:
```ts
  it('deleteBoard removes the board, its tasks, and their child rows', () => {
    store.createBoard('Research');
    const t = store.createTask({ title: 'doomed', boardId: 'research' });
    store.addComment(t.id, 'a comment');
    store.appendEvent(t.id, null, 'note', {});
    store.deleteBoard('research');
    expect(store.listBoards().map((b) => b.slug)).toEqual(['default']);
    expect(store.getTask(t.id)).toBeNull();
    expect(store.listComments(t.id)).toHaveLength(0);
    expect(store.listEvents(t.id)).toHaveLength(0);
  });

  it('deleteBoard leaves other boards untouched', () => {
    store.createBoard('Research');
    const keep = store.createTask({ title: 'keep' }); // default board
    store.createTask({ title: 'drop', boardId: 'research' });
    store.deleteBoard('research');
    expect(store.getTask(keep.id)?.id).toBe(keep.id);
    expect(store.listBoard('default')).toHaveLength(1);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts`
Expected: FAIL — `store.deleteBoard` is not a function.

- [ ] **Step 3: Implement `deleteBoard`**

In `src/main/kanban/kanban-store.ts`:

(a) Add `rmSync` to the `fs` import (it currently imports `mkdirSync` — change to `import { mkdirSync, rmSync } from 'fs';`), and add a value import for the workspace cleanup helpers near the other imports:
```ts
import { removeWorktree, cleanupWorkspace } from './workspace';
```

(b) Add the method after `renameBoard`:
```ts
  deleteBoard(slug: string): void {
    // Gather the board's tasks first so on-disk cleanup can run before the rows go.
    const tasks = this.listTasks().filter((t) => t.boardId === slug);
    for (const t of tasks) {
      try {
        if (t.workspaceKind === 'worktree' && t.workspacePath && t.repoPath) {
          removeWorktree({
            repoPath: t.repoPath,
            workspacePath: t.workspacePath,
            branchName: t.branchName
          });
        } else if (t.workspacePath) {
          cleanupWorkspace({ kind: t.workspaceKind, path: t.workspacePath });
        }
        rmSync(join(this.attachmentsRoot, t.id), { recursive: true, force: true });
      } catch {
        // best-effort: a filesystem failure must never block the DB delete
      }
    }
    const tx = this.db.transaction((s: string) => {
      this.db
        .prepare('DELETE FROM task_attachments WHERE task_id IN (SELECT id FROM tasks WHERE board_id=?)')
        .run(s);
      this.db
        .prepare('DELETE FROM task_comments WHERE task_id IN (SELECT id FROM tasks WHERE board_id=?)')
        .run(s);
      this.db
        .prepare('DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE board_id=?)')
        .run(s);
      this.db
        .prepare('DELETE FROM task_runs WHERE task_id IN (SELECT id FROM tasks WHERE board_id=?)')
        .run(s);
      this.db
        .prepare(
          `DELETE FROM task_links
           WHERE parent_id IN (SELECT id FROM tasks WHERE board_id=?)
              OR child_id IN (SELECT id FROM tasks WHERE board_id=?)`
        )
        .run(s, s);
      this.db.prepare('DELETE FROM tasks WHERE board_id=?').run(s);
      this.db.prepare('DELETE FROM boards WHERE slug=?').run(s);
    });
    tx(slug);
    this.onBoardsChanged?.();
  }
```
(`join` and `this.attachmentsRoot` already exist in the store.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-store.ts src/main/__tests__/kanban-store.test.ts
git commit -m "$(cat <<'EOF'
feat(kanban): cascading deleteBoard with best-effort workspace cleanup

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Command wrappers + orchestrator board inheritance

**Files:**
- Modify: `src/main/kanban/kanban-commands.ts`
- Modify: `src/main/kanban/kanban-mcp-server.ts` (board inheritance in `kanban_create`)
- Test: `src/main/__tests__/kanban-commands.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/main/__tests__/kanban-commands.test.ts`, add this `describe` block at the end (reuses `makeCommands`, `TEST_DIR`, vitest globals already in the file — verify with grep):
```ts
describe('KanbanCommands boards', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('createBoard derives a slug and listBoards returns it', () => {
    const { commands } = makeCommands();
    const b = commands.createBoard('Research');
    expect(b.slug).toBe('research');
    expect(commands.listBoards().map((x) => x.slug)).toContain('research');
  });

  it('createBoard rejects an empty / junk name', () => {
    const { commands } = makeCommands();
    expect(() => commands.createBoard('   ')).toThrow();
    expect(() => commands.createBoard('!!!')).toThrow();
  });

  it('renameBoard rejects an empty name', () => {
    const { commands } = makeCommands();
    commands.createBoard('Research');
    expect(() => commands.renameBoard('research', '  ')).toThrow();
  });

  it('deleteBoard refuses the default board', () => {
    const { commands } = makeCommands();
    expect(() => commands.deleteBoard('default')).toThrow();
  });

  it('deleteBoard refuses a board with a running task', () => {
    const { store, commands } = makeCommands();
    commands.createBoard('Research');
    const t = store.createTask({ title: 'busy', boardId: 'research' });
    store.setStatus(t.id, 'running');
    expect(() => commands.deleteBoard('research')).toThrow();
    expect(commands.listBoards().map((b) => b.slug)).toContain('research');
  });

  it('deleteBoard removes an idle board', () => {
    const { store, commands } = makeCommands();
    commands.createBoard('Research');
    store.createTask({ title: 'idle', boardId: 'research' });
    commands.deleteBoard('research');
    expect(commands.listBoards().map((b) => b.slug)).not.toContain('research');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-commands.test.ts`
Expected: FAIL — `commands.createBoard`/`listBoards`/`deleteBoard` not functions.

- [ ] **Step 3: Implement the command wrappers**

In `src/main/kanban/kanban-commands.ts`:
(a) Add `Board` to the type import from `../../shared/kanban-types`, and add a value import:
```ts
import { deriveBoardSlug } from './board-slug';
```
(b) Change `list` to accept an optional board slug. Replace the `list` method:
```ts
  list(filter: { status?: TaskStatus; boardSlug?: string } = {}): BoardCard[] {
    const board = this.store.listBoard(filter.boardSlug);
    return filter.status ? board.filter((c) => c.status === filter.status) : board;
  }
```
(c) Add the board commands (place after `list`, before `show`):
```ts
  listBoards(): Board[] {
    return this.store.listBoards();
  }

  createBoard(name: string): Board {
    if (name.trim() === '' || deriveBoardSlug(name) === '') {
      throw new CodedError('invalid board name', 'BAD_REQUEST');
    }
    return this.store.createBoard(name);
  }

  renameBoard(slug: string, name: string): void {
    if (name.trim() === '') {
      throw new CodedError('board name cannot be empty', 'BAD_REQUEST');
    }
    this.store.renameBoard(slug, name);
  }

  deleteBoard(slug: string): void {
    if (slug === 'default') {
      throw new CodedError('the default board cannot be deleted', 'BAD_REQUEST');
    }
    if (this.store.listBoard(slug).some((c) => c.status === 'running')) {
      throw new CodedError('stop running tasks before deleting this board', 'BAD_REQUEST');
    }
    this.store.deleteBoard(slug);
  }
```

In `src/main/kanban/kanban-mcp-server.ts`, in the `kanban_create` handler, add board inheritance to the child `createTask` call. In the `this.store.createTask({ … })` object (the one with `status: 'todo'` and `...inherit`), add a `boardId` line:
```ts
            boardId: task.boardId,
```
(`task` is the parent task already fetched as `store.getTask(scope.taskId)`.)

- [ ] **Step 4: Run the command tests to verify they pass**

Run: `npx vitest run src/main/__tests__/kanban-commands.test.ts`
Expected: PASS (existing + 6 new).

- [ ] **Step 5: Add the MCP inheritance test**

In `src/main/__tests__/kanban-mcp-server.test.ts`, find the existing `kanban_create` test (grep `kanban_create`) and mirror its setup to add a test asserting board inheritance. The test must: create a parent task on a non-default board (`store.createTask({ title: 'p', boardId: 'research' })` after `store.createBoard('Research')`), register a decompose run scope for it, invoke the `kanban_create` tool, then assert the created child's `boardId` is `'research'` (fetch the child via `store.getTask(childId)`). Match the existing test's exact harness (how it builds the server, registers the run token/scope, and calls the tool) — do not invent a new harness.

If no `kanban_create` test exists to mirror, report this as DONE_WITH_CONCERNS and skip the MCP test (the command-level board scoping is still covered); the inheritance line is a one-line, low-risk change.

- [ ] **Step 6: Run the MCP tests**

Run: `npx vitest run src/main/__tests__/kanban-mcp-server.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/kanban/kanban-commands.ts src/main/kanban/kanban-mcp-server.ts src/main/__tests__/kanban-commands.test.ts src/main/__tests__/kanban-mcp-server.test.ts
git commit -m "$(cat <<'EOF'
feat(kanban): board command wrappers + orchestrator child board inheritance

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: IPC + preload + boards-changed broadcast

**Files:**
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/shared/ipc-api.ts`
- Modify: `src/main/kanban/kanban-ipc.ts`
- Modify: `src/main/index.ts` (wire `onBoardsChanged` broadcast)
- Modify: `src/preload/index.ts`

No unit test (IPC needs an Electron runtime); verification is `npm run typecheck` + `npm run lint`.

- [ ] **Step 1: Add the channels**

In `src/shared/ipc-channels.ts`, in the Kanban block (after `KANBAN_SAVE_ATTACHMENT_COPY`), add (ensure the line before gets a trailing comma):
```ts
  KANBAN_LIST_BOARDS: 'kanban:list-boards',
  KANBAN_CREATE_BOARD: 'kanban:create-board',
  KANBAN_RENAME_BOARD: 'kanban:rename-board',
  KANBAN_DELETE_BOARD: 'kanban:delete-board',
  KANBAN_BOARDS_CHANGED: 'kanban:boards-changed'
```

- [ ] **Step 2: Add the request type**

In `src/shared/ipc-api.ts`, after `KanbanLinkRequest` (grep it), add:
```ts
export type KanbanRenameBoardRequest = {
  slug: string;
  name: string;
};
```

- [ ] **Step 3: Add the IPC handlers + board-scoped listBoard**

In `src/main/kanban/kanban-ipc.ts`:
(a) Add `KanbanRenameBoardRequest` to the type import from `../../shared/ipc-api`.
(b) Change the `KANBAN_LIST_BOARD` handler to pass a board slug:
```ts
  ipcMain.handle(IPC_CHANNELS.KANBAN_LIST_BOARD, (_e, boardSlug?: string) =>
    commands.list({ boardSlug })
  );
```
(c) Register the board handlers (place after the existing kanban handlers, before any final `log.info`):
```ts
  ipcMain.handle(IPC_CHANNELS.KANBAN_LIST_BOARDS, () => commands.listBoards());
  ipcMain.handle(IPC_CHANNELS.KANBAN_CREATE_BOARD, (_e, name: string) => commands.createBoard(name));
  ipcMain.handle(IPC_CHANNELS.KANBAN_RENAME_BOARD, (_e, req: KanbanRenameBoardRequest) =>
    commands.renameBoard(req.slug, req.name)
  );
  ipcMain.handle(IPC_CHANNELS.KANBAN_DELETE_BOARD, (_e, slug: string) => commands.deleteBoard(slug));
```

- [ ] **Step 4: Wire the boards-changed broadcast**

In `src/main/index.ts`, in the `new KanbanStore(join(KANBAN_HOME, 'kanban.db'), { … })` options object (around line 752, alongside the existing `onEvent`), add an `onBoardsChanged` callback that broadcasts to all windows (mirror the `onEvent` broadcast just below it):
```ts
    onBoardsChanged: () => {
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send(IPC_CHANNELS.KANBAN_BOARDS_CHANGED);
      }
    },
```
(`BrowserWindow` and `IPC_CHANNELS` are already imported in this file.)

- [ ] **Step 5: Add the preload methods**

In `src/preload/index.ts`:
(a) Add `KanbanRenameBoardRequest` and `Board` to the imports (`Board` from `../shared/kanban-types`, `KanbanRenameBoardRequest` from `../shared/ipc-api`).
(b) Change the existing `listBoard` method to accept an optional slug:
```ts
    listBoard: async (boardSlug?: string): Promise<BoardCard[]> =>
      typedInvoke<BoardCard[]>(IPC_CHANNELS.KANBAN_LIST_BOARD, boardSlug),
```
(c) In the `kanban` block (after `saveAttachmentCopy`, before `onEvent`), add:
```ts
    listBoards: async (): Promise<Board[]> =>
      typedInvoke<Board[]>(IPC_CHANNELS.KANBAN_LIST_BOARDS),
    createBoard: async (name: string): Promise<Board> =>
      typedInvoke<Board>(IPC_CHANNELS.KANBAN_CREATE_BOARD, name),
    renameBoard: async (req: KanbanRenameBoardRequest): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_RENAME_BOARD, req),
    deleteBoard: async (slug: string): Promise<void> =>
      typedInvoke<void>(IPC_CHANNELS.KANBAN_DELETE_BOARD, slug),
    onBoardsChanged: (callback: () => void): Unsubscribe =>
      onChannel<void>(IPC_CHANNELS.KANBAN_BOARDS_CHANGED, () => callback()),
```
(`onChannel` and `Unsubscribe` are already used by the existing `onEvent` method — match its style.)

- [ ] **Step 6: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: typecheck clean; no new lint errors in the changed files.

- [ ] **Step 7: Commit**

```bash
git add src/shared/ipc-channels.ts src/shared/ipc-api.ts src/main/kanban/kanban-ipc.ts src/main/index.ts src/preload/index.ts
git commit -m "$(cat <<'EOF'
feat(kanban): IPC + preload surface for boards + boards-changed broadcast

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Renderer store + board switcher UI

**Files:**
- Modify: `src/renderer/src/store/kanban-store.ts`
- Modify: `src/renderer/src/components/kanban/KanbanBoard.tsx`

UI; verification is `npm run typecheck`, `npm run lint`, `npm run build` (no renderer component tests in this repo).

- [ ] **Step 1: Add renderer store state + actions**

In `src/renderer/src/store/kanban-store.ts`:

(a) Add `Board` to the type import from `../../../shared/kanban-types`.

(b) Add to the `KanbanState` type (after the `cards: BoardCard[];` / `loaded` fields, group with state, and add the actions after `loadBoard`):
```ts
  boards: Board[];
  activeBoardSlug: string;
  loadBoards: () => Promise<void>;
  switchBoard: (slug: string) => Promise<void>;
  createBoard: (name: string) => Promise<void>;
  renameBoard: (slug: string, name: string) => Promise<void>;
  deleteBoard: (slug: string) => Promise<void>;
```

(c) Initialize state. Replace the initial `cards: [], loaded: false,` lines with (read the persisted active slug once):
```ts
  cards: [],
  loaded: false,
  boards: [],
  activeBoardSlug: localStorage.getItem('fleet.kanban.activeBoard') ?? 'default',
```

(d) Change `loadBoard` to pass the active slug:
```ts
  loadBoard: async () => {
    const cards = await window.fleet.kanban.listBoard(get().activeBoardSlug);
    set({ cards, loaded: true });
  },
```

(e) Add the board actions (after `loadBoard`):
```ts
  loadBoards: async () => {
    const boards = await window.fleet.kanban.listBoards();
    // If the active board vanished (e.g. deleted in another window), fall back.
    const active = get().activeBoardSlug;
    if (!boards.some((b) => b.slug === active)) {
      localStorage.setItem('fleet.kanban.activeBoard', 'default');
      set({ boards, activeBoardSlug: 'default' });
      await get().loadBoard();
      return;
    }
    set({ boards });
  },
  switchBoard: async (slug) => {
    localStorage.setItem('fleet.kanban.activeBoard', slug);
    set({ activeBoardSlug: slug, openTaskId: null, detail: null });
    await get().loadBoard();
  },
  createBoard: async (name) => {
    const board = await window.fleet.kanban.createBoard(name);
    await get().loadBoards();
    await get().switchBoard(board.slug);
  },
  renameBoard: async (slug, name) => {
    await window.fleet.kanban.renameBoard({ slug, name });
    await get().loadBoards();
  },
  deleteBoard: async (slug) => {
    await window.fleet.kanban.deleteBoard(slug);
    if (get().activeBoardSlug === slug) {
      await get().switchBoard('default');
    }
    await get().loadBoards();
  },
```

- [ ] **Step 2: Render the board switcher + load boards**

In `src/renderer/src/components/kanban/KanbanBoard.tsx`:

(a) Pull the new state/actions from the store hook. Replace the destructure:
```ts
  const { cards, loaded, loadBoard, openTask, openTaskId, setStatus, createTask, nudge } =
    useKanbanStore();
```
with:
```ts
  const {
    cards,
    loaded,
    loadBoard,
    openTask,
    openTaskId,
    setStatus,
    createTask,
    nudge,
    boards,
    activeBoardSlug,
    loadBoards,
    switchBoard,
    createBoard,
    renameBoard,
    deleteBoard
  } = useKanbanStore();
```

(b) Load boards on mount and subscribe to the boards-changed broadcast. Replace the existing mount effect:
```ts
  useEffect(() => {
    if (!loaded) void loadBoard();
  }, [loaded, loadBoard]);
```
with:
```ts
  useEffect(() => {
    if (!loaded) void loadBoard();
    void loadBoards();
    const off = window.fleet.kanban.onBoardsChanged(() => void loadBoards());
    return off;
  }, [loaded, loadBoard, loadBoards]);
```

(c) Add the switcher control as the first item in the toolbar `<div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">`, before the search `<input>`. Use a native `<select>` for switching plus small New/Rename/Delete buttons. Insert:
```tsx
        <select
          value={activeBoardSlug}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '__new__') {
              const name = window.prompt('New board name');
              if (name && name.trim()) void createBoard(name.trim());
            } else {
              void switchBoard(v);
            }
          }}
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs outline-none focus:border-blue-500"
          title="Switch board"
        >
          {boards.map((b) => (
            <option key={b.slug} value={b.slug}>
              {b.name}
            </option>
          ))}
          <option value="__new__">＋ New board…</option>
        </select>
        <button
          onClick={() => {
            const current = boards.find((b) => b.slug === activeBoardSlug);
            const name = window.prompt('Rename board', current?.name ?? '');
            if (name && name.trim()) void renameBoard(activeBoardSlug, name.trim());
          }}
          disabled={activeBoardSlug === 'default'}
          className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-40"
          title="Rename board"
        >
          Rename
        </button>
        <button
          onClick={() => {
            if (activeBoardSlug === 'default') return;
            const current = boards.find((b) => b.slug === activeBoardSlug);
            if (window.confirm(`Delete board "${current?.name ?? activeBoardSlug}" and all its tasks?`)) {
              void deleteBoard(activeBoardSlug).catch((err) =>
                window.alert(err instanceof Error ? err.message : 'Could not delete board')
              );
            }
          }}
          disabled={activeBoardSlug === 'default'}
          className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-red-900/40 disabled:opacity-40"
          title="Delete board"
        >
          Delete
        </button>
        <div className="h-4 w-px bg-neutral-800" />
```
NOTE: the default board's Rename/Delete buttons are disabled (`activeBoardSlug === 'default'`); the spec allows renaming the default board, but to keep the slug-permanence rule simple and avoid an extra prompt path, v1 disables both for `default`. (Renaming default is a non-goal nicety — confirm acceptable; if the reviewer objects, enabling Rename for default is a one-line change to drop that `disabled`.)

- [ ] **Step 3: Typecheck, lint, build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: typecheck clean; no new lint errors in changed files; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/store/kanban-store.ts src/renderer/src/components/kanban/KanbanBoard.tsx
git commit -m "$(cat <<'EOF'
feat(kanban): board switcher UI + renderer board state

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification (after all tasks)

- [ ] **Typecheck + lint + full main test suite + build**

```bash
npm run typecheck
npm run lint
npx vitest run src/main/__tests__
npm run build
```
Expected: typecheck clean; lint adds no new errors vs the pre-branch baseline; all tests pass; build succeeds.

---

## Notes for the implementer

- **DRY/YAGNI/Surgical:** touch only the files listed per task. No DB-file-per-board, no cross-board links, no board icons/descriptions, no soft-archive, no `FLEET_KANBAN_BOARD` env var, no board MCP tools (all explicit non-goals).
- **Layering:** slug logic in `board-slug.ts`; the store owns rows + the cascade + fs cleanup delegation; commands own validation (`CodedError`) and policy (no-delete-default, no-delete-running); IPC is thin; the renderer holds `activeBoardSlug`.
- **Match existing style:** `rowTo*` mappers, prepared statements, `appendEvent` parity, the toolbar's Tailwind conventions, and the `onEvent`→broadcast pattern for `onBoardsChanged`.
- **The dispatcher is intentionally untouched** — all-boards dispatch falls out of its existing whole-table queries.
