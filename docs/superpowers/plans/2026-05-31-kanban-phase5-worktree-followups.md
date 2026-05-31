# Kanban Phase 5 Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-remove a worktree-kind task's git worktree + branch when it is archived, and make orchestrator-created child tasks inherit a worktree parent's source repo.

**Architecture:** Two independent, additive changes. (1) A new synchronous best-effort `removeWorktree` helper in `workspace.ts`, invoked from `KanbanCommands.setManualStatus` when a worktree task transitions to `archived` (the single chokepoint that the UI, CLI, and socket all reach). (2) A guarded inheritance branch in the `kanban_create` MCP handler so children of a worktree parent become worktree tasks carrying the parent's `repoPath`.

**Tech Stack:** TypeScript (ESM), Electron main process, better-sqlite3, vitest, `git` via `execFileSync`.

---

## Background the implementer must know

- **Field semantics (worktree kind):** `repoPath` = source git repo; `workspacePath` = created worktree dir `~/.fleet/kanban/worktrees/<taskId>` (persisted on first claim); `branchName` = `kanban/<taskId>` (persisted on first claim). See `src/main/kanban/workspace.ts` and the parent spec `docs/superpowers/specs/2026-05-30-kanban-phase5-worktree-design.md`.
- **Why `removeWorktree` is synchronous:** it runs in a command handler (archive), not in the dispatcher's atomic tick, so there is no claim-race concern. It uses `execFileSync` to match the rest of `workspace.ts`. (The dispatcher-tick synchrony invariant is unaffected — this code is never called from the tick.)
- **Why NOT reuse `WorktreeService.remove` (`src/main/worktree-service.ts`):** it derives the branch name from the worktree dir basename, which for kanban is `<taskId>`, not the actual branch `kanban/<taskId>` — it would delete the wrong branch.
- **Why hook `setManualStatus`, not `archive()`:** the UI archive button calls the renderer `setStatus(id,'archived')` → IPC `KANBAN_SET_STATUS` → `kanban-ipc.ts` → `commands.setManualStatus(id,'archived')`, bypassing `archive()`. `archive()` itself is a thin wrapper over `setManualStatus`. Hooking `setManualStatus` covers UI + CLI + socket.
- **Running guard:** `setManualStatus` already throws `BAD_REQUEST` for a `running` task, so a worktree is never archived while a live worker uses it.
- **Verification commands:** type check `npm run typecheck`; lint `npm run lint`; tests for these files: `npx vitest run src/main/__tests__/kanban-workspace.test.ts src/main/__tests__/kanban-commands.test.ts src/main/__tests__/kanban-mcp-server.test.ts`.
- **Test helper convention:** `src/main/__tests__/kanban-workspace.test.ts` already defines a `makeRepo(name)` that inits a temp git repo with one empty commit. Reuse that pattern.

---

## Task 1: `removeWorktree` helper

**Files:**
- Modify: `src/main/kanban/workspace.ts` (add exported `removeWorktree`; it goes after `cleanupWorkspace`)
- Test: `src/main/__tests__/kanban-workspace.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these three tests inside the existing `describe('kanban workspace', ...)` block in `src/main/__tests__/kanban-workspace.test.ts`. Also add `removeWorktree` to the existing import on line 6.

Change line 6 from:
```ts
import { prepareWorkspace, cleanupWorkspace } from '../kanban/workspace';
```
to:
```ts
import { prepareWorkspace, cleanupWorkspace, removeWorktree } from '../kanban/workspace';
```

Add the tests:
```ts
  it('removeWorktree removes the worktree dir and deletes its branch', () => {
    const repo = makeRepo('rm1');
    const { path, branchName } = prepareWorkspace({
      kind: 'worktree',
      taskId: 'r1',
      workspacesRoot: ROOT,
      worktreesRoot: WT_ROOT,
      repoPath: repo
    });
    expect(existsSync(path)).toBe(true);
    removeWorktree({ repoPath: repo, workspacePath: path, branchName });
    expect(existsSync(path)).toBe(false);
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'kanban/r1'], {
      encoding: 'utf8'
    });
    expect(branches.trim()).toBe('');
  });

  it('removeWorktree force-removes a worktree with uncommitted changes', () => {
    const repo = makeRepo('rm2');
    const { path, branchName } = prepareWorkspace({
      kind: 'worktree',
      taskId: 'r2',
      workspacesRoot: ROOT,
      worktreesRoot: WT_ROOT,
      repoPath: repo
    });
    writeFileSync(join(path, 'dirty.txt'), 'uncommitted');
    removeWorktree({ repoPath: repo, workspacePath: path, branchName });
    expect(existsSync(path)).toBe(false);
  });

  it('removeWorktree does not throw when the dir was deleted out-of-band, and still drops the branch', () => {
    const repo = makeRepo('rm3');
    const { path, branchName } = prepareWorkspace({
      kind: 'worktree',
      taskId: 'r3',
      workspacesRoot: ROOT,
      worktreesRoot: WT_ROOT,
      repoPath: repo
    });
    rmSync(path, { recursive: true, force: true }); // simulate manual deletion
    expect(() => removeWorktree({ repoPath: repo, workspacePath: path, branchName })).not.toThrow();
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'kanban/r3'], {
      encoding: 'utf8'
    });
    expect(branches.trim()).toBe('');
  });
```

`writeFileSync`, `rmSync`, `existsSync`, `execFileSync`, `join` are all already imported at the top of this test file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-workspace.test.ts`
Expected: FAIL — `removeWorktree` is not exported (import error / "removeWorktree is not a function").

- [ ] **Step 3: Implement `removeWorktree`**

Append this to `src/main/kanban/workspace.ts` (after `cleanupWorkspace`, end of file). All imports it needs (`execFileSync`, `rmSync`) are already imported at the top of the file.

```ts
/**
 * Best-effort teardown of a worktree-kind workspace: remove the worktree dir
 * and delete its branch. Never throws — archival must not be blocked by a git
 * failure. Directory cleanup is independent of the git calls, so a moved or
 * deleted repoPath does not leak the worktree dir.
 */
export function removeWorktree(input: {
  repoPath: string;
  workspacePath: string;
  branchName: string | null;
}): void {
  try {
    execFileSync(
      'git',
      ['-C', input.repoPath, 'worktree', 'remove', '--force', input.workspacePath],
      { stdio: 'ignore' }
    );
  } catch {
    // git remove failed (dir gone, repo moved, locked, ...). Clean the dir
    // directly and prune the stale registration so nothing is leaked.
    rmSync(input.workspacePath, { recursive: true, force: true });
    try {
      execFileSync('git', ['-C', input.repoPath, 'worktree', 'prune'], { stdio: 'ignore' });
    } catch {
      // best-effort
    }
  }
  if (input.branchName) {
    try {
      execFileSync('git', ['-C', input.repoPath, 'branch', '-D', input.branchName], {
        stdio: 'ignore'
      });
    } catch {
      // branch already gone or never created
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/main/__tests__/kanban-workspace.test.ts`
Expected: PASS (all worktree tests, including the 3 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/workspace.ts src/main/__tests__/kanban-workspace.test.ts
git commit -m "feat(kanban): add removeWorktree helper for worktree teardown"
```

---

## Task 2: Remove worktree on archive (wire into `setManualStatus`)

**Files:**
- Modify: `src/main/kanban/kanban-commands.ts` (add imports + extend `setManualStatus`)
- Test: `src/main/__tests__/kanban-commands.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/main/__tests__/kanban-commands.test.ts`, add the imports needed to build a real worktree. The file currently has `import { mkdirSync, rmSync } from 'fs';` on line 2 — change it to add `existsSync`, and add two new imports:

```ts
import { mkdirSync, rmSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { prepareWorkspace } from '../kanban/workspace';
```

Add this helper near the top of the file (after `makeCommands`):

```ts
function makeRepo(name: string): string {
  const repo = join(TEST_DIR, name);
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t.t']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init']);
  return repo;
}
```

Add a new `describe` block (place it after the existing top-level describe block, still inside the file):

```ts
describe('KanbanCommands archive worktree teardown', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('archiving a worktree task via setManualStatus removes its worktree and branch', () => {
    const { store, commands } = makeCommands();
    const repo = makeRepo('cmd-rm1');
    const task = store.createTask({
      title: 'wt task',
      status: 'todo',
      workspaceKind: 'worktree',
      repoPath: repo
    });
    const wt = prepareWorkspace({
      kind: 'worktree',
      taskId: task.id,
      workspacesRoot: TEST_DIR,
      worktreesRoot: join(TEST_DIR, 'worktrees'),
      repoPath: repo
    });
    store.setWorkspace(task.id, wt.path, wt.branchName);
    expect(existsSync(wt.path)).toBe(true);

    commands.setManualStatus(task.id, 'archived');

    expect(store.getTask(task.id)?.status).toBe('archived');
    expect(existsSync(wt.path)).toBe(false);
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', `kanban/${task.id}`], {
      encoding: 'utf8'
    });
    expect(branches.trim()).toBe('');
  });

  it('archiving a scratch task does not throw and just archives', () => {
    const { store, commands } = makeCommands();
    const task = commands.create({ title: 'scratch task', status: 'todo' });
    expect(() => commands.setManualStatus(task.id, 'archived')).not.toThrow();
    expect(store.getTask(task.id)?.status).toBe('archived');
  });

  it('archives a worktree task even when its repo and worktree are gone', () => {
    const { store, commands } = makeCommands();
    const task = store.createTask({
      title: 'wt',
      status: 'todo',
      workspaceKind: 'worktree',
      repoPath: join(TEST_DIR, 'missing-repo')
    });
    store.setWorkspace(task.id, join(TEST_DIR, 'missing-wt'), `kanban/${task.id}`);
    expect(() => commands.setManualStatus(task.id, 'archived')).not.toThrow();
    expect(store.getTask(task.id)?.status).toBe('archived');
  });
});
```

`beforeEach`/`afterEach`/`describe`/`it`/`expect` are already imported on line 1. `join`, `tmpdir`, and `TEST_DIR` are already defined in the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-commands.test.ts`
Expected: FAIL on the first new test — `existsSync(wt.path)` is still `true` after archiving (removal not wired yet).

- [ ] **Step 3: Add imports + a logger to `kanban-commands.ts`**

At the top of `src/main/kanban/kanban-commands.ts`, after the existing imports (after line 15), add:

```ts
import { createLogger } from '../logger';
import { removeWorktree } from './workspace';

const log = createLogger('kanban-commands');
```

- [ ] **Step 4: Extend `setManualStatus` to remove the worktree on archive**

In `src/main/kanban/kanban-commands.ts`, replace the existing `setManualStatus` method (currently lines 99-113):

```ts
  setManualStatus(id: string, status: TaskStatus): void {
    const task = this.requireTask(id);
    if (task.status === 'running' || status === 'running') {
      throw new CodedError('cannot manually change a running task', 'BAD_REQUEST');
    }
    if (!MANUAL_STATUSES.includes(status)) {
      throw new CodedError(`invalid status: ${status}`, 'BAD_REQUEST');
    }
    this.store.setStatus(id, status);
    this.store.appendEvent(id, null, 'status_changed', {
      from: task.status,
      to: status,
      by: 'user'
    });
  }
```

with:

```ts
  setManualStatus(id: string, status: TaskStatus): void {
    const task = this.requireTask(id);
    if (task.status === 'running' || status === 'running') {
      throw new CodedError('cannot manually change a running task', 'BAD_REQUEST');
    }
    if (!MANUAL_STATUSES.includes(status)) {
      throw new CodedError(`invalid status: ${status}`, 'BAD_REQUEST');
    }
    this.store.setStatus(id, status);
    this.store.appendEvent(id, null, 'status_changed', {
      from: task.status,
      to: status,
      by: 'user'
    });
    // Archiving a worktree task tears down its worktree + branch (best-effort;
    // removeWorktree never throws, but guard archival defensively regardless).
    if (
      status === 'archived' &&
      task.workspaceKind === 'worktree' &&
      task.workspacePath &&
      task.repoPath
    ) {
      try {
        removeWorktree({
          repoPath: task.repoPath,
          workspacePath: task.workspacePath,
          branchName: task.branchName
        });
      } catch (err) {
        log.warn('worktree removal on archive failed', {
          taskId: id,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/main/__tests__/kanban-commands.test.ts`
Expected: PASS (all existing tests plus the 3 new ones).

- [ ] **Step 6: Commit**

```bash
git add src/main/kanban/kanban-commands.ts src/main/__tests__/kanban-commands.test.ts
git commit -m "feat(kanban): remove worktree + branch when a worktree task is archived"
```

---

## Task 3: Orchestrator children inherit the parent's worktree repo

**Files:**
- Modify: `src/main/kanban/kanban-mcp-server.ts` (the `kanban_create` case, currently lines 321-345)
- Test: `src/main/__tests__/kanban-mcp-server.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these two tests inside the existing `describe('KanbanMcpServer', ...)` block in `src/main/__tests__/kanban-mcp-server.test.ts`:

```ts
  it('kanban_create makes worktree children that inherit the parent repo', async () => {
    const parent = store.createTask({
      title: 'big',
      status: 'running',
      workspaceKind: 'worktree',
      repoPath: '/src/myrepo'
    });
    const run = store.startRun(parent.id, 'orchestrator', 1, 'decompose');
    server.registerRun('itok', { taskId: parent.id, runId: run.id, mode: 'decompose' }, 'L');
    const r = await rpc(`${base}?run=itok`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'child' }
    });
    const childId = String(r.result.content[0].text).trim();
    const child = store.getTask(childId);
    expect(child?.workspaceKind).toBe('worktree');
    expect(child?.repoPath).toBe('/src/myrepo');
  });

  it('kanban_create leaves children as scratch when the parent is not a worktree', async () => {
    const parent = store.createTask({ title: 'big', status: 'running' });
    const run = store.startRun(parent.id, 'orchestrator', 1, 'decompose');
    server.registerRun('itok2', { taskId: parent.id, runId: run.id, mode: 'decompose' }, 'L');
    const r = await rpc(`${base}?run=itok2`, 'tools/call', {
      name: 'kanban_create',
      arguments: { title: 'child' }
    });
    const childId = String(r.result.content[0].text).trim();
    const child = store.getTask(childId);
    expect(child?.workspaceKind).toBe('scratch');
    expect(child?.repoPath).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/__tests__/kanban-mcp-server.test.ts`
Expected: FAIL on the first new test — `child.workspaceKind` is `scratch` (inheritance not wired yet).

- [ ] **Step 3: Implement inheritance in the `kanban_create` handler**

In `src/main/kanban/kanban-mcp-server.ts`, replace the body of the `kanban_create` case (currently lines 321-345):

```ts
        case 'kanban_create': {
          const a = z
            .object({
              title: z.string(),
              body: z.string().optional(),
              assignee: z.string().optional(),
              priority: z.number().optional(),
              parents: z.array(z.string()).optional()
            })
            .parse(args);
          const child = this.store.createTask({
            title: a.title,
            body: a.body ?? '',
            assignee: a.assignee ?? null,
            priority: a.priority ?? 0,
            status: 'todo'
          });
          this.store.addLink(scope.taskId, child.id); // original is the grouping parent
          for (const p of a.parents ?? []) this.store.addLink(p, child.id);
          this.store.appendEvent(child.id, scope.runId, 'task_created', {
            by: 'orchestrator',
            parent: scope.taskId
          });
          return this.text(res, rpcReq.id, child.id);
        }
```

with (note the new `inherit` object, gated on a truthy `task.repoPath`, spread into `createTask`):

```ts
        case 'kanban_create': {
          const a = z
            .object({
              title: z.string(),
              body: z.string().optional(),
              assignee: z.string().optional(),
              priority: z.number().optional(),
              parents: z.array(z.string()).optional()
            })
            .parse(args);
          // Children of a worktree parent inherit its source repo so each runs
          // in its own kanban/<childId> worktree. Gate on a truthy repoPath:
          // store.createTask bypasses the create() repoPath guard, so a
          // worktree task without a repo would fail at claim time.
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
          this.store.addLink(scope.taskId, child.id); // original is the grouping parent
          for (const p of a.parents ?? []) this.store.addLink(p, child.id);
          this.store.appendEvent(child.id, scope.runId, 'task_created', {
            by: 'orchestrator',
            parent: scope.taskId
          });
          return this.text(res, rpcReq.id, child.id);
        }
```

(`task` is already in scope — it is `this.store.getTask(scope.taskId)`, the parent, resolved at the top of `handleToolCall`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/main/__tests__/kanban-mcp-server.test.ts`
Expected: PASS (all existing tests plus the 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-mcp-server.ts src/main/__tests__/kanban-mcp-server.test.ts
git commit -m "feat(kanban): decomposed children inherit a worktree parent's repo"
```

---

## Final verification (after all tasks)

- [ ] **Type check + lint + full kanban tests**

```bash
npm run typecheck
npm run lint
npx vitest run src/main/__tests__
```
Expected: typecheck clean, lint clean, all tests pass.

---

## Notes for the implementer

- DRY/YAGNI/Surgical: touch only the three files above (+ their tests). Do not modify the CLI, socket server, IPC, renderer, or `archive()` — they all already route through `setManualStatus`.
- Do not change `cleanupWorkspace`, `prepareWorkspace`, or the dispatcher.
- Leave the archived task's `workspacePath`/`branchName` fields in place (do not null them) — the `existsSync` reuse guard handles any future re-run.
- Match existing style (the codebase uses `execFileSync` with `stdio` options and `createLogger`).
