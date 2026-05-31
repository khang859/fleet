# Kanban Worktree Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A kanban task with `workspaceKind: 'worktree'` runs in a dedicated git worktree created from a per-task source repo, on a deterministic `kanban/<taskId>` branch, reused on retry and preserved after completion.

**Architecture:** Add a `repo_path` column (schema v3) holding the worktree source repo. `prepareWorkspace` gains synchronous git worktree create-or-reuse (`execFileSync`), keeping the dispatcher tick race-free. The created worktree path + branch are persisted on the task (via a new `setWorkspace` store method) by the `prepareWorkspaceFn` closure in `index.ts`, so retries reuse the existing worktree. Create surfaces (CLI, board UI) thread `workspaceKind` + `repoPath`; `KanbanCommands.create` rejects worktree tasks with no repo.

**Tech Stack:** Electron main (ESM `.mjs`), better-sqlite3, node `child_process.execFileSync`, React + Tailwind renderer, vitest.

**Spec:** `docs/superpowers/specs/2026-05-30-kanban-phase5-worktree-design.md`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/shared/kanban-types.ts` | Shared task types | Add `Task.repoPath`, `CreateTaskInput.repoPath` |
| `src/main/kanban/schema.ts` | DDL + schema version | Add `repo_path` column, bump `SCHEMA_VERSION` to 3 |
| `src/main/kanban/kanban-store.ts` | SQLite persistence | Migrate v3, map `repo_path`, persist on create, add `setWorkspace` |
| `src/main/kanban/workspace.ts` | Workspace prep | Worktree create-or-reuse; return `{path, branchName}` |
| `src/main/index.ts` | Live wiring | Thread new fields into `prepareWorkspaceFn`, persist result |
| `src/main/kanban/kanban-commands.ts` | App-layer validation | Reject worktree without `repoPath` |
| `src/main/socket-server.ts` | CLI front door | Thread `--workspace` / `--repo` into create |
| `src/main/fleet-cli.ts` | CLI arg validation + help | Validate worktree needs `--repo`; help text |
| `src/renderer/src/components/kanban/KanbanBoard.tsx` | New-task form | Workspace-kind selector + repo input |

Test files: `src/main/__tests__/kanban-workspace.test.ts`, `kanban-store.test.ts`, `kanban-commands.test.ts`.

---

## Task 1: Schema v3 + `repoPath` type + persistence on create

**Files:**
- Modify: `src/shared/kanban-types.ts:27-54` (Task), `:88-102` (CreateTaskInput)
- Modify: `src/main/kanban/schema.ts:1` (version), `:4-31` (tasks DDL)
- Modify: `src/main/kanban/kanban-store.ts:32-43` (migrate), `:61-90` (rowToTask), `:92-125` (createTask)
- Test: `src/main/__tests__/kanban-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/main/__tests__/kanban-store.test.ts` inside the top-level `describe('KanbanStore', …)`:

```typescript
  it('fresh db is created at v3 and persists repoPath', () => {
    const t = store.createTask({ title: 'wt', workspaceKind: 'worktree', repoPath: '/src/repo' });
    expect(store.getTask(t.id)?.repoPath).toBe('/src/repo');
    expect(store.getTask(t.id)?.workspaceKind).toBe('worktree');
    expect(store.schemaVersion()).toBe(3);
  });

  it('repoPath defaults to null when omitted', () => {
    const t = store.createTask({ title: 'plain' });
    expect(store.getTask(t.id)?.repoPath).toBeNull();
  });

  it('upgrades a v2 db to v3 (adds repo_path)', () => {
    const v2Path = join(TEST_DIR, 'v2.db');
    const raw = new Database(v2Path);
    raw.exec(SCHEMA_SQL);
    raw.exec('ALTER TABLE tasks DROP COLUMN repo_path');
    raw.pragma('user_version = 2');
    raw.close();

    const s = new KanbanStore(v2Path);
    const t = s.createTask({ title: 'x', workspaceKind: 'worktree', repoPath: '/r' });
    expect(s.getTask(t.id)?.repoPath).toBe('/r');
    expect(s.schemaVersion()).toBe(3);
    s.close();
  });
```

Also update the two existing assertions that hard-code version 2 (`kanban-store.test.ts:28` and `:37`) from `toBe(2)` to `toBe(3)`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts`
Expected: FAIL — new tests fail (`repoPath` is `undefined`/column missing) and the version assertions fail (`3` ≠ `2`).

- [ ] **Step 3: Add the column to the schema and bump the version**

In `src/main/kanban/schema.ts`, change line 1 to:

```typescript
export const SCHEMA_VERSION = 3;
```

In the `tasks` DDL, add `repo_path` right after the `workspace_path TEXT,` line (`schema.ts:13`):

```sql
  workspace_path TEXT,
  repo_path TEXT,
  branch_name TEXT,
```

- [ ] **Step 4: Add the v3 migration branch**

In `src/main/kanban/kanban-store.ts`, extend `migrate()` (after the existing `if (current < 2)` block, before the `user_version` write):

```typescript
    if (current < 3) {
      // Additive: DBs created before v3 lack the worktree source repo column.
      this.addColumnIfMissing('tasks', 'repo_path', 'TEXT');
    }
```

- [ ] **Step 5: Map and persist `repoPath`**

In `rowToTask` (`kanban-store.ts`), add after the `workspacePath` line:

```typescript
      repoPath: (r.repo_path as string | null) ?? null,
```

In `createTask`, add `repo_path` to the column list and `VALUES` clause and bind it. The INSERT becomes:

```typescript
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, body, assignee, status, priority, tenant,
          workspace_kind, workspace_path, repo_path, branch_name, model_override, skills, idempotency_key,
          max_runtime_seconds, max_retries, created_at, updated_at)
         VALUES (@id, @title, @body, @assignee, @status, @priority, @tenant,
          @workspace_kind, @workspace_path, @repo_path, @branch_name, @model_override, @skills, @idempotency_key,
          @max_runtime_seconds, @max_retries, @created_at, @updated_at)`
      )
      .run({
        id,
        title: input.title,
        body: input.body ?? '',
        assignee: input.assignee ?? null,
        status: input.status ?? 'todo',
        priority: input.priority ?? 0,
        tenant: input.tenant ?? null,
        workspace_kind: input.workspaceKind ?? 'scratch',
        workspace_path: null,
        repo_path: input.repoPath ?? null,
        branch_name: input.branchName ?? null,
        model_override: input.modelOverride ?? null,
        skills: JSON.stringify(input.skills ?? []),
        idempotency_key: input.idempotencyKey ?? null,
        max_runtime_seconds: input.maxRuntimeSeconds ?? null,
        max_retries: input.maxRetries ?? 1,
        created_at: ts,
        updated_at: ts
      });
```

Note: the current INSERT omits `workspace_path` (defaults to NULL). We add it explicitly as `null` here only because the column list now spells out `workspace_path` ahead of `repo_path`; behavior is unchanged for non-worktree kinds.

- [ ] **Step 6: Add the types**

In `src/shared/kanban-types.ts`, add to `Task` (after `workspacePath`):

```typescript
  repoPath: string | null;
```

And to `CreateTaskInput` (after `workspaceKind?`):

```typescript
  repoPath?: string;
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts`
Expected: PASS (all, including the version-3 assertions).

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/shared/kanban-types.ts src/main/kanban/schema.ts src/main/kanban/kanban-store.ts src/main/__tests__/kanban-store.test.ts
git commit -m "feat(kanban): add repo_path column (schema v3) for worktree source repo"
```

---

## Task 2: `KanbanStore.setWorkspace`

**Files:**
- Modify: `src/main/kanban/kanban-store.ts` (add method near `setWorkerPid`, ~`:469`)
- Test: `src/main/__tests__/kanban-store.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `kanban-store.test.ts`:

```typescript
  it('setWorkspace persists workspacePath and branchName', () => {
    const t = store.createTask({ title: 'wt', workspaceKind: 'worktree', repoPath: '/r' });
    store.setWorkspace(t.id, '/wt/path', 'kanban/abc');
    const got = store.getTask(t.id);
    expect(got?.workspacePath).toBe('/wt/path');
    expect(got?.branchName).toBe('kanban/abc');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts -t setWorkspace`
Expected: FAIL with "store.setWorkspace is not a function".

- [ ] **Step 3: Implement `setWorkspace`**

In `kanban-store.ts`, add after `setWorkerPid` (`:475`):

```typescript
  setWorkspace(taskId: string, path: string, branchName: string | null): void {
    this.db
      .prepare('UPDATE tasks SET workspace_path=?, branch_name=?, updated_at=? WHERE id=?')
      .run(path, branchName, this.now(), taskId);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/kanban-store.test.ts -t setWorkspace`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-store.ts src/main/__tests__/kanban-store.test.ts
git commit -m "feat(kanban): add setWorkspace to persist worktree path + branch"
```

---

## Task 3: Worktree create-or-reuse in `prepareWorkspace`

**Files:**
- Modify: `src/main/kanban/workspace.ts` (whole file)
- Modify: `src/main/index.ts:786-792` (destructure new return shape — compile fix only)
- Test: `src/main/__tests__/kanban-workspace.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the body of `src/main/__tests__/kanban-workspace.test.ts` with (keeps the existing scratch/dir cases, adds worktree cases against a real temp git repo):

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { prepareWorkspace, cleanupWorkspace } from '../kanban/workspace';

const ROOT = join(tmpdir(), `fleet-kanban-ws-test-${process.pid}`);
const WT_ROOT = join(ROOT, 'worktrees');

function makeRepo(name: string): string {
  const repo = join(ROOT, name);
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t.t']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init']);
  return repo;
}

describe('kanban workspace', () => {
  beforeEach(() => mkdirSync(ROOT, { recursive: true }));
  afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

  it('creates a scratch dir under the root', () => {
    const { path, branchName } = prepareWorkspace({
      kind: 'scratch',
      taskId: 'abc',
      workspacesRoot: ROOT,
      worktreesRoot: WT_ROOT
    });
    expect(existsSync(path)).toBe(true);
    expect(path.startsWith(ROOT)).toBe(true);
    expect(branchName).toBeNull();
  });

  it('cleans up a scratch dir', () => {
    const { path } = prepareWorkspace({
      kind: 'scratch',
      taskId: 'abc',
      workspacesRoot: ROOT,
      worktreesRoot: WT_ROOT
    });
    cleanupWorkspace({ kind: 'scratch', path });
    expect(existsSync(path)).toBe(false);
  });

  it('returns the explicit path for dir kind', () => {
    const dir = join(ROOT, 'explicit');
    mkdirSync(dir);
    const { path, branchName } = prepareWorkspace({
      kind: 'dir',
      taskId: 'abc',
      workspacesRoot: ROOT,
      worktreesRoot: WT_ROOT,
      workspacePath: dir
    });
    expect(path).toBe(dir);
    expect(branchName).toBeNull();
  });

  it('does not delete a dir-kind workspace on cleanup', () => {
    const keep = join(ROOT, 'keep');
    mkdirSync(keep);
    cleanupWorkspace({ kind: 'dir', path: keep });
    expect(existsSync(keep)).toBe(true);
  });

  it('creates a worktree on kanban/<taskId> from the source repo', () => {
    const repo = makeRepo('repo1');
    const { path, branchName } = prepareWorkspace({
      kind: 'worktree',
      taskId: 't1',
      workspacesRoot: ROOT,
      worktreesRoot: WT_ROOT,
      repoPath: repo
    });
    expect(path).toBe(join(WT_ROOT, 't1'));
    expect(existsSync(path)).toBe(true);
    expect(branchName).toBe('kanban/t1');
    const branch = execFileSync('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8'
    }).trim();
    expect(branch).toBe('kanban/t1');
  });

  it('reuses an existing worktree without re-creating it', () => {
    const repo = makeRepo('repo2');
    const first = prepareWorkspace({
      kind: 'worktree',
      taskId: 't2',
      workspacesRoot: ROOT,
      worktreesRoot: WT_ROOT,
      repoPath: repo
    });
    // Thread the persisted path + branch back in, as the live closure does on retry.
    const second = prepareWorkspace({
      kind: 'worktree',
      taskId: 't2',
      workspacesRoot: ROOT,
      worktreesRoot: WT_ROOT,
      repoPath: repo,
      workspacePath: first.path,
      branchName: first.branchName ?? undefined
    });
    expect(second.path).toBe(first.path);
    expect(second.branchName).toBe('kanban/t2');
  });

  it('attaches to an already-existing branch instead of failing', () => {
    const repo = makeRepo('repo3');
    execFileSync('git', ['-C', repo, 'branch', 'kanban/t3']);
    const { path, branchName } = prepareWorkspace({
      kind: 'worktree',
      taskId: 't3',
      workspacesRoot: ROOT,
      worktreesRoot: WT_ROOT,
      repoPath: repo
    });
    expect(existsSync(path)).toBe(true);
    expect(branchName).toBe('kanban/t3');
  });

  it('throws when worktree kind has no repoPath', () => {
    expect(() =>
      prepareWorkspace({
        kind: 'worktree',
        taskId: 't4',
        workspacesRoot: ROOT,
        worktreesRoot: WT_ROOT
      })
    ).toThrow(/repoPath/);
  });

  it('throws when repoPath is not a git repo', () => {
    const notRepo = join(ROOT, 'plain');
    mkdirSync(notRepo);
    expect(() =>
      prepareWorkspace({
        kind: 'worktree',
        taskId: 't5',
        workspacesRoot: ROOT,
        worktreesRoot: WT_ROOT,
        repoPath: notRepo
      })
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-workspace.test.ts`
Expected: FAIL — `prepareWorkspace` returns a string (no `.branchName`), and worktree cases error.

- [ ] **Step 3: Rewrite `workspace.ts`**

Replace `src/main/kanban/workspace.ts` with:

```typescript
import { mkdirSync, rmSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import type { WorkspaceKind } from '../../shared/kanban-types';

export interface PrepareWorkspaceInput {
  kind: WorkspaceKind;
  taskId: string;
  /** Root for ephemeral 'scratch' dirs. */
  workspacesRoot: string;
  /** Root for 'worktree' dirs (one per task id). */
  worktreesRoot: string;
  /** Current persisted working directory (explicit dir, or a created worktree). */
  workspacePath?: string;
  /** Source git repo for 'worktree' kind. */
  repoPath?: string;
  /** Current persisted branch (worktree reuse). */
  branchName?: string;
}

export interface PreparedWorkspace {
  path: string;
  branchName: string | null;
}

function isGitRepo(repoPath: string): boolean {
  try {
    execFileSync('git', ['-C', repoPath, 'rev-parse', '--git-dir'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function branchExists(repoPath: string, branch: string): boolean {
  const out = execFileSync('git', ['-C', repoPath, 'branch', '--list', branch], {
    encoding: 'utf8'
  });
  return out.trim().length > 0;
}

/** Returns the working directory the worker should run in, plus its branch (if any). */
export function prepareWorkspace(input: PrepareWorkspaceInput): PreparedWorkspace {
  if (input.kind === 'scratch') {
    const path = join(input.workspacesRoot, input.taskId);
    mkdirSync(path, { recursive: true });
    return { path, branchName: null };
  }

  if (input.kind === 'dir') {
    if (!input.workspacePath) {
      throw new Error("prepareWorkspace: kind 'dir' requires an explicit workspacePath");
    }
    return { path: input.workspacePath, branchName: null };
  }

  // worktree
  if (input.workspacePath && existsSync(input.workspacePath)) {
    return { path: input.workspacePath, branchName: input.branchName ?? null };
  }
  if (!input.repoPath) {
    throw new Error("prepareWorkspace: kind 'worktree' requires repoPath");
  }
  if (!isGitRepo(input.repoPath)) {
    throw new Error(`prepareWorkspace: not a git repo: ${input.repoPath}`);
  }
  const branch = `kanban/${input.taskId}`;
  const dir = join(input.worktreesRoot, input.taskId);
  mkdirSync(input.worktreesRoot, { recursive: true });
  const addArgs = branchExists(input.repoPath, branch)
    ? ['-C', input.repoPath, 'worktree', 'add', dir, branch]
    : ['-C', input.repoPath, 'worktree', 'add', dir, '-b', branch];
  execFileSync('git', addArgs, { stdio: 'ignore' });
  return { path: dir, branchName: branch };
}

export function cleanupWorkspace(input: { kind: WorkspaceKind; path: string }): void {
  // Only scratch is ephemeral; dir/worktree are preserved.
  if (input.kind === 'scratch') {
    rmSync(input.path, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Fix the `index.ts` caller so the project compiles**

In `src/main/index.ts`, the `prepareWorkspaceFn` closure (`:786-792`) currently returns the string from `prepareWorkspace`. Update it to pass the new inputs and return `.path` (persistence is added in Task 4):

```typescript
    prepareWorkspaceFn: (task) =>
      prepareWorkspace({
        kind: task.workspaceKind,
        taskId: task.id,
        workspacesRoot: join(KANBAN_HOME, 'workspaces'),
        worktreesRoot: join(KANBAN_HOME, 'worktrees'),
        workspacePath: task.workspacePath ?? undefined,
        repoPath: task.repoPath ?? undefined,
        branchName: task.branchName ?? undefined
      }).path,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/kanban-workspace.test.ts`
Expected: PASS (all scratch/dir/worktree cases).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/kanban/workspace.ts src/main/index.ts src/main/__tests__/kanban-workspace.test.ts
git commit -m "feat(kanban): synchronous git worktree create-or-reuse in prepareWorkspace"
```

---

## Task 4: Persist the created worktree on the task (live wiring)

**Files:**
- Modify: `src/main/index.ts:786-792` (prepareWorkspaceFn closure)

This is wiring around the live `KanbanStore` instance; correctness of create-vs-reuse is already proven by Task 3's unit tests. The closure persists the result so that on retry `task.workspacePath` is set and Task 3's reuse branch is taken.

- [ ] **Step 1: Persist in the closure**

Replace the `prepareWorkspaceFn` closure from Task 3 with one that captures the result and writes it back via `setWorkspace` for the worktree kind:

```typescript
    prepareWorkspaceFn: (task) => {
      const prepared = prepareWorkspace({
        kind: task.workspaceKind,
        taskId: task.id,
        workspacesRoot: join(KANBAN_HOME, 'workspaces'),
        worktreesRoot: join(KANBAN_HOME, 'worktrees'),
        workspacePath: task.workspacePath ?? undefined,
        repoPath: task.repoPath ?? undefined,
        branchName: task.branchName ?? undefined
      });
      if (task.workspaceKind === 'worktree' && task.workspacePath == null) {
        kanbanStore.setWorkspace(task.id, prepared.path, prepared.branchName);
      }
      return prepared.path;
    },
```

(`kanbanStore` is the module-scoped store instance created at `index.ts:752`.)

- [ ] **Step 2: Typecheck and build**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run build`
Expected: PASS (electron-vite build succeeds).

- [ ] **Step 3: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(kanban): persist created worktree path + branch for retry reuse"
```

---

## Task 5: Reject worktree tasks with no repo in `KanbanCommands.create`

**Files:**
- Modify: `src/main/kanban/kanban-commands.ts:44-53` (create)
- Test: `src/main/__tests__/kanban-commands.test.ts`

- [ ] **Step 1: Write the failing tests**

The test file has ~18 bare `commands.create({ title })` calls that rely on the factory default `workspaceKind: 'worktree'`. Once worktree requires a repo, every one of them would throw. The surgical fix is to flip the two `getCreateDefaults` factory defaults from `'worktree'` to `'scratch'` (the real product default in `DEFAULT_SETTINGS` is `'scratch'`), and cover worktree creation explicitly with new tests. This touches three lines instead of fifteen.

Change the first factory default (`kanban-commands.test.ts:27-30`):

```typescript
  const commands = new KanbanCommands(store, dispatcher, () => ({
    workspaceKind: 'scratch',
    maxRuntimeSeconds: null
  }));
```

Change the second factory default (`kanban-commands.test.ts:237-239`):

```typescript
    const commands = new KanbanCommands(store, dispatcher, () => ({
      workspaceKind: 'scratch',
      maxRuntimeSeconds: null
    }));
```

Update the existing default-applying assertion (`kanban-commands.test.ts:46`) from `'worktree'` to `'scratch'`:

```typescript
    expect(task.workspaceKind).toBe('scratch');
```

Add new tests (anywhere inside the top-level `describe`):

```typescript
  it('rejects a worktree task with no repoPath', () => {
    const { commands } = makeCommands();
    expect(() => commands.create({ title: 'no repo', workspaceKind: 'worktree' })).toThrow(
      /repo/i
    );
  });

  it('allows a scratch task with no repoPath', () => {
    const { commands } = makeCommands();
    const task = commands.create({ title: 'scratch ok', workspaceKind: 'scratch' });
    expect(task.workspaceKind).toBe('scratch');
  });

  it('stores repoPath for a worktree task', () => {
    const { commands } = makeCommands();
    const task = commands.create({
      title: 'wt',
      workspaceKind: 'worktree',
      repoPath: '/src/repo'
    });
    expect(task.repoPath).toBe('/src/repo');
    expect(task.workspaceKind).toBe('worktree');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-commands.test.ts`
Expected: FAIL — the two new validation/storage tests fail (no validation yet; `repoPath` undefined).

- [ ] **Step 3: Add validation to `create`**

In `src/main/kanban/kanban-commands.ts`, update `create` to resolve the kind first and validate:

```typescript
  create(input: CreateTaskInput): Task {
    const d = this.getCreateDefaults();
    const workspaceKind = input.workspaceKind ?? d.workspaceKind;
    if (workspaceKind === 'worktree' && !input.repoPath) {
      throw new CodedError('worktree tasks require a source repo (repoPath)', 'BAD_REQUEST');
    }
    const task = this.store.createTask({
      ...input,
      workspaceKind,
      maxRuntimeSeconds: input.maxRuntimeSeconds ?? d.maxRuntimeSeconds
    });
    this.store.appendEvent(task.id, null, 'task_created', { title: task.title });
    return task;
  }
```

(`CodedError` is already imported at `kanban-commands.ts:3`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/kanban-commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-commands.ts src/main/__tests__/kanban-commands.test.ts
git commit -m "feat(kanban): require repoPath for worktree tasks at create time"
```

---

## Task 6: CLI — thread `--workspace` / `--repo` into create

**Files:**
- Modify: `src/main/socket-server.ts:429-443` (kanban.create handler)
- Modify: `src/main/fleet-cli.ts:337-340` (validation), `:546` & `:571` (help text)

- [ ] **Step 1: Thread the args in the socket handler**

In `src/main/socket-server.ts`, extend the `kanban.create` case to read the new args and build the input:

```typescript
      case 'kanban.create': {
        const k = this.requireKanban();
        const title = typeof args.title === 'string' ? args.title : undefined;
        if (!title) throw new CodedError('kanban create requires --title', 'BAD_REQUEST');
        const input: CreateTaskInput = { title };
        if (typeof args.body === 'string') input.body = args.body;
        if (typeof args.assignee === 'string') input.assignee = args.assignee;
        if (typeof args.priority === 'string') {
          const p = Number(args.priority);
          if (!Number.isNaN(p)) input.priority = p;
        }
        if (
          args.workspace === 'scratch' ||
          args.workspace === 'dir' ||
          args.workspace === 'worktree'
        ) {
          input.workspaceKind = args.workspace;
        }
        if (typeof args.repo === 'string') input.repoPath = args.repo;
        const task = k.create(input);
        this.emit('state-change', 'kanban:changed', { id: task.id });
        return task;
      }
```

(`CreateTaskInput` is already imported in `socket-server.ts`. The authoritative worktree-needs-repo validation lives in `KanbanCommands.create` from Task 5; `k.create` throws `BAD_REQUEST` if missing.)

- [ ] **Step 2: Add a friendly CLI pre-validation**

In `src/main/fleet-cli.ts`, replace the `kanban.create` validation case (`:337-340`) with:

```typescript
    case 'kanban.create':
      if (!args.title)
        return 'Error: kanban create requires --title.\n\nUsage: fleet kanban create --title "..." [--assignee <profile>] [--priority <n>] [--body "..."] [--workspace <scratch|dir|worktree>] [--repo <path>]';
      if (args.workspace === 'worktree' && !args.repo)
        return 'Error: kanban create --workspace worktree requires --repo <path>.\n\nUsage: fleet kanban create --title "..." --workspace worktree --repo <path>';
      return null;
```

- [ ] **Step 3: Update the two help-text lines**

In `src/main/fleet-cli.ts`, update the usage summary line (`:546`):

```
  fleet kanban create --title "..." [--body "..."] [--assignee <profile>] [--priority <n>] [--workspace <scratch|dir|worktree>] [--repo <path>]
```

And add a worktree example after the existing create example (`:571`):

```
  fleet kanban create --title "Refactor auth" --workspace worktree --repo /home/me/project
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Manually verify the CLI validation strings**

Run: `npx vitest run src/main/__tests__` (ensure nothing regressed).
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/socket-server.ts src/main/fleet-cli.ts
git commit -m "feat(kanban): thread --workspace/--repo through fleet kanban create"
```

---

## Task 7: Board UI — workspace-kind selector + repo input

**Files:**
- Modify: `src/renderer/src/components/kanban/KanbanBoard.tsx:15-16` (state), `:41-47` (handleCreate), `:94-119` (form)

- [ ] **Step 1: Add form state**

In `KanbanBoard.tsx`, add next to the existing `newTitle` state (`:16`):

```typescript
  const [newKind, setNewKind] = useState<WorkspaceKind>('scratch');
  const [newRepo, setNewRepo] = useState('');
```

Add the type import to the existing kanban-types import (`:6`):

```typescript
import type { TaskStatus, WorkspaceKind } from '../../../../shared/kanban-types';
```

- [ ] **Step 2: Build the input in `handleCreate`**

Replace `handleCreate` (`:41-47`):

```typescript
  async function handleCreate(): Promise<void> {
    const title = newTitle.trim();
    if (!title) return;
    if (newKind === 'worktree' && !newRepo.trim()) return;
    await createTask({
      title,
      workspaceKind: newKind,
      ...(newKind === 'worktree' ? { repoPath: newRepo.trim() } : {})
    });
    setNewTitle('');
    setNewRepo('');
    setNewKind('scratch');
    setCreating(false);
  }
```

- [ ] **Step 3: Add the selector + repo input to the form**

In the `{creating && (…)}` block (`:94-119`), add a workspace-kind `<select>` after the title `<input>` and a conditional repo `<input>`. The form becomes:

```tsx
      {creating && (
        <div className="flex items-center gap-2 border-b border-neutral-800 bg-neutral-900 px-3 py-2">
          <input
            autoFocus
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate();
              if (e.key === 'Escape') setCreating(false);
            }}
            placeholder="Task title…"
            className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs outline-none focus:border-blue-500"
          />
          <select
            value={newKind}
            onChange={(e) => setNewKind(e.target.value as WorkspaceKind)}
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs outline-none"
          >
            <option value="scratch">scratch</option>
            <option value="dir">dir</option>
            <option value="worktree">worktree</option>
          </select>
          {newKind === 'worktree' && (
            <input
              value={newRepo}
              onChange={(e) => setNewRepo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreate();
                if (e.key === 'Escape') setCreating(false);
              }}
              placeholder="Source repo path…"
              className="w-56 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs outline-none focus:border-blue-500"
            />
          )}
          <button
            onClick={() => void handleCreate()}
            className="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500"
          >
            Create
          </button>
          <button
            onClick={() => setCreating(false)}
            className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800"
          >
            Cancel
          </button>
        </div>
      )}
```

- [ ] **Step 4: Typecheck the renderer**

Run: `npm run typecheck`
Expected: PASS (runs both `typecheck:node` and `typecheck:web`).

- [ ] **Step 5: Lint the changed file**

Run: `npx eslint src/renderer/src/components/kanban/KanbanBoard.tsx`
Expected: No new errors introduced by these edits.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/kanban/KanbanBoard.tsx
git commit -m "feat(kanban): workspace-kind + repo inputs in new-task form"
```

---

## Final Verification

- [ ] **Run the full main test suite**

Run: `npx vitest run src/main/__tests__`
Expected: PASS.

- [ ] **Typecheck + build**

Run: `npm run build`
Expected: PASS (typecheck + electron-vite build).

- [ ] **Update CHANGELOG (only if cutting a release)**

Per `CLAUDE.md`, add a `## vX.Y.Z` entry before tagging. Not required for merging the branch.
