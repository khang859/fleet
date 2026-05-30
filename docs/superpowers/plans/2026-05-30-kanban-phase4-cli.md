# Kanban Phase 4 — `fleet kanban` CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `fleet kanban …` terminal command surface (create/inspect/transition tasks, comments, dependency links, event log, dispatcher nudge, and live event streaming) backed by a single shared application layer so the CLI, board IPC, and store cannot drift.

**Architecture:** A new `KanbanCommands` application layer wraps `KanbanStore` + `KanbanDispatcher` (validation + mutation + `task_events` append). `kanban-ipc.ts` is refactored to delegate to it. `SocketServer.dispatch()` gains `kanban.*` cases routed through a lazy `getKanban()` getter (the store is created after the socket server starts), plus a `kanban.watch` subscription channel fed by `KanbanStore.onEvent`. `fleet-cli.ts` routes `fleet kanban <verb>` through the existing generic socket-client path (with positional-arg fixups + client-side validation + help) and a dedicated streaming path for `watch`.

**Tech Stack:** TypeScript, Electron main process, `better-sqlite3` (`KanbanStore`), Node `net` Unix sockets, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-30-kanban-phase4-cli-design.md`

---

## Conventions for every task

- **Type check:** `npm run typecheck`
- **Run one test file:** `npx vitest run <path>`
- **Full suite:** `npm test` (the `pretest` hook rebuilds `better-sqlite3` for the Node ABI automatically)
- **Commit trailer:** every commit message must end with
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- `KanbanStore` opens a real SQLite file, so tests use a temp-dir DB path (see Task 1), **not** `:memory:`.

## File structure

| File | Responsibility | Tasks |
|------|----------------|-------|
| `src/main/kanban/kanban-commands.ts` (new) | Shared application layer: validate → mutate → append event. Owns `MANUAL_STATUSES`. | 1, 2, 3 |
| `src/main/__tests__/kanban-commands.test.ts` (new) | Unit tests for every `KanbanCommands` method against a real store. | 1, 2, 3 |
| `src/main/kanban/kanban-ipc.ts` (modify) | Delegate all handlers to `KanbanCommands`; drop direct store/event calls. | 4 |
| `src/main/index.ts` (modify) | Construct `KanbanCommands`; pass `() => kanbanCommands` to the supervisor; forward `onEvent` to `broadcastKanbanEvent`; pass commands to `registerKanbanIpc`. | 4, 5, 6 |
| `src/main/socket-server.ts` (modify) | `kanban.*` dispatch cases + `kanban.watch` subscription + `broadcastKanbanEvent`. | 5, 6 |
| `src/main/socket-supervisor.ts` (modify) | Thread `getKanban` into `SocketServer`; expose `broadcastKanbanEvent`. | 5, 6 |
| `src/main/__tests__/kanban-socket-watch.test.ts` (new) | Socket-level test: `kanban.watch` subscribe → `broadcastKanbanEvent` delivery. | 6 |
| `src/main/fleet-cli.ts` (modify) | `kanban` verbs via generic path (positional fixups, validation, help) + `watch` streaming client. | 7, 8 |
| `src/main/__tests__/fleet-cli.test.ts` (modify) | Kanban arg-parsing, validation, and help tests. | 7, 8 |

---

### Task 1: `KanbanCommands` — constructor, `create`, `list`, `show`

**Files:**
- Create: `src/main/kanban/kanban-commands.ts`
- Test: `src/main/__tests__/kanban-commands.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/__tests__/kanban-commands.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';
import { KanbanDispatcher } from '../kanban/kanban-dispatcher';
import { KanbanCommands } from '../kanban/kanban-commands';

const TEST_DIR = join(tmpdir(), `fleet-kanban-cmds-${process.pid}`);

function makeCommands(): { store: KanbanStore; commands: KanbanCommands } {
  const store = new KanbanStore(join(TEST_DIR, `cmds-${Math.random().toString(36).slice(2)}.db`));
  const dispatcher = new KanbanDispatcher(store, {
    now: () => 0,
    isAlive: () => true,
    spawnWorker: () => undefined,
    config: { failureLimit: 2, claimGraceMs: 0, maxInProgress: 3, claimTtlMs: 1000 }
  });
  const commands = new KanbanCommands(store, dispatcher, () => ({
    workspaceKind: 'scratch',
    maxRuntimeSeconds: null
  }));
  return { store, commands };
}

describe('KanbanCommands create/list/show', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('create inserts a task, applies defaults, and appends task_created', () => {
    const { store, commands } = makeCommands();
    const task = commands.create({ title: 'First task' });
    expect(task.title).toBe('First task');
    expect(task.workspaceKind).toBe('scratch');
    const events = store.listEvents(task.id);
    expect(events.map((e) => e.kind)).toContain('task_created');
  });

  it('list returns board cards, filtered by status when given', () => {
    const { commands } = makeCommands();
    commands.create({ title: 'a', status: 'ready' });
    commands.create({ title: 'b', status: 'todo' });
    expect(commands.list().length).toBe(2);
    const ready = commands.list({ status: 'ready' });
    expect(ready.length).toBe(1);
    expect(ready[0].title).toBe('a');
  });

  it('show returns task detail; null for unknown id', () => {
    const { commands } = makeCommands();
    const task = commands.create({ title: 'detail me' });
    const detail = commands.show(task.id);
    expect(detail?.task.title).toBe('detail me');
    expect(detail?.comments).toEqual([]);
    expect(commands.show('nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-commands.test.ts`
Expected: FAIL — cannot find module `../kanban/kanban-commands`.

- [ ] **Step 3: Create the implementation**

Create `src/main/kanban/kanban-commands.ts`:

```ts
import { CodedError } from '../errors';
import type { KanbanStore } from './kanban-store';
import type { KanbanDispatcher } from './kanban-dispatcher';
import type {
  CreateTaskInput,
  TaskStatus,
  TaskDetail,
  BoardCard,
  Task,
  TaskComment,
  TaskEvent,
  UpdateTaskFields,
  WorkspaceKind
} from '../../shared/kanban-types';

/** Statuses a human may set manually (everything except dispatcher-owned `running`). */
export const MANUAL_STATUSES: TaskStatus[] = [
  'triage',
  'todo',
  'ready',
  'blocked',
  'done',
  'archived'
];

export interface CreateDefaults {
  workspaceKind: WorkspaceKind;
  maxRuntimeSeconds: number | null;
}

/**
 * KanbanCommands is the single application layer over KanbanStore/KanbanDispatcher.
 * The board IPC, the CLI socket server, and any future front door all call these
 * methods, so validation and event-logging cannot drift between them.
 */
export class KanbanCommands {
  constructor(
    private store: KanbanStore,
    private dispatcher: KanbanDispatcher,
    private getCreateDefaults: () => CreateDefaults
  ) {}

  private requireTask(id: string): Task {
    const task = this.store.getTask(id);
    if (!task) throw new CodedError(`task not found: ${id}`, 'NOT_FOUND');
    return task;
  }

  create(input: CreateTaskInput): Task {
    const d = this.getCreateDefaults();
    const task = this.store.createTask({
      ...input,
      workspaceKind: input.workspaceKind ?? d.workspaceKind,
      maxRuntimeSeconds: input.maxRuntimeSeconds ?? d.maxRuntimeSeconds
    });
    this.store.appendEvent(task.id, null, 'task_created', { title: task.title });
    return task;
  }

  list(filter: { status?: TaskStatus } = {}): BoardCard[] {
    const board = this.store.listBoard();
    return filter.status ? board.filter((c) => c.status === filter.status) : board;
  }

  show(id: string): TaskDetail | null {
    const task = this.store.getTask(id);
    if (!task) return null;
    return {
      task,
      comments: this.store.listComments(id),
      runs: this.store.listRuns(id),
      events: this.store.listEvents(id),
      parents: this.store
        .parentsOf(id)
        .map((pid) => this.store.getTask(pid))
        .filter((t): t is Task => t !== null),
      children: this.store
        .childrenOf(id)
        .map((cid) => this.store.getTask(cid))
        .filter((t): t is Task => t !== null)
    };
  }
}
```

> Note: `TaskComment`, `TaskEvent`, and `UpdateTaskFields` are imported now because Tasks 2–3 use them; if your linter flags them as unused before then, keep them — they are consumed by the end of Task 3.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/__tests__/kanban-commands.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Type check**

Run: `npm run typecheck`
Expected: no errors. (If `TaskComment`/`TaskEvent`/`UpdateTaskFields` trip `no-unused-vars` during type check, that is lint not typecheck — ignore until Task 3 consumes them.)

- [ ] **Step 6: Commit**

```bash
git add src/main/kanban/kanban-commands.ts src/main/__tests__/kanban-commands.test.ts
git commit -m "feat(kanban): KanbanCommands create/list/show application layer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `KanbanCommands` — status verbs (`setManualStatus`, `ready`, `unblock`, `archive`, `block`, `complete`) and `update`/`assign`

**Files:**
- Modify: `src/main/kanban/kanban-commands.ts`
- Test: `src/main/__tests__/kanban-commands.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/main/__tests__/kanban-commands.test.ts` (inside the file, after the existing `describe`):

```ts
describe('KanbanCommands status + assign', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('setManualStatus moves a non-running task and logs status_changed', () => {
    const { store, commands } = makeCommands();
    const t = commands.create({ title: 'x', status: 'todo' });
    commands.setManualStatus(t.id, 'ready');
    expect(store.getTask(t.id)?.status).toBe('ready');
    const kinds = store.listEvents(t.id).map((e) => e.kind);
    expect(kinds).toContain('status_changed');
  });

  it('setManualStatus rejects moving a running task', () => {
    const { store, commands } = makeCommands();
    const t = commands.create({ title: 'x', status: 'running' });
    expect(() => commands.setManualStatus(t.id, 'ready')).toThrowError(/running/);
    expect(store.getTask(t.id)?.status).toBe('running');
  });

  it('setManualStatus rejects an unknown id and an invalid status', () => {
    const { commands } = makeCommands();
    const t = commands.create({ title: 'x' });
    expect(() => commands.setManualStatus('missing', 'ready')).toThrowError(/not found/);
    expect(() => commands.setManualStatus(t.id, 'running')).toThrowError(/running/);
  });

  it('block sets blocked with a reason; complete sets done with a result', () => {
    const { store, commands } = makeCommands();
    const t = commands.create({ title: 'x', status: 'todo' });
    commands.block(t.id, 'waiting on design');
    expect(store.getTask(t.id)?.status).toBe('blocked');
    expect(store.getTask(t.id)?.result).toBe('waiting on design');
    const t2 = commands.create({ title: 'y', status: 'todo' });
    commands.complete(t2.id, 'shipped');
    expect(store.getTask(t2.id)?.status).toBe('done');
    expect(store.getTask(t2.id)?.result).toBe('shipped');
  });

  it('block and complete reject running tasks', () => {
    const { commands } = makeCommands();
    const t = commands.create({ title: 'x', status: 'running' });
    expect(() => commands.block(t.id, 'r')).toThrowError(/running/);
    expect(() => commands.complete(t.id, 'r')).toThrowError(/running/);
  });

  it('assign sets the assignee and logs task_updated', () => {
    const { store, commands } = makeCommands();
    const t = commands.create({ title: 'x' });
    commands.assign(t.id, 'orchestrator');
    expect(store.getTask(t.id)?.assignee).toBe('orchestrator');
    expect(store.listEvents(t.id).map((e) => e.kind)).toContain('task_updated');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-commands.test.ts`
Expected: FAIL — `commands.setManualStatus`/`block`/`complete`/`assign` are not functions.

- [ ] **Step 3: Add the methods**

In `src/main/kanban/kanban-commands.ts`, add these methods to the `KanbanCommands` class (after `show`):

```ts
  update(id: string, fields: UpdateTaskFields): void {
    this.requireTask(id);
    this.store.updateTask(id, fields);
    this.store.appendEvent(id, null, 'task_updated', {});
  }

  assign(id: string, profile: string | null): void {
    this.update(id, { assignee: profile });
  }

  setManualStatus(id: string, status: TaskStatus): void {
    const task = this.requireTask(id);
    if (task.status === 'running' || status === 'running') {
      throw new CodedError('cannot manually change a running task', 'BAD_REQUEST');
    }
    if (!MANUAL_STATUSES.includes(status)) {
      throw new CodedError(`invalid status: ${status}`, 'BAD_REQUEST');
    }
    this.store.setStatus(id, status);
    this.store.appendEvent(id, null, 'status_changed', { from: task.status, to: status, by: 'user' });
  }

  ready(id: string): void {
    this.setManualStatus(id, 'ready');
  }

  unblock(id: string): void {
    this.setManualStatus(id, 'ready');
  }

  archive(id: string): void {
    this.setManualStatus(id, 'archived');
  }

  block(id: string, reason: string): void {
    const task = this.requireTask(id);
    if (task.status === 'running') {
      throw new CodedError('cannot block a running task', 'BAD_REQUEST');
    }
    this.store.blockTask(id, reason);
    this.store.appendEvent(id, null, 'status_changed', {
      from: task.status,
      to: 'blocked',
      by: 'user',
      reason
    });
  }

  complete(id: string, result: string): void {
    const task = this.requireTask(id);
    if (task.status === 'running') {
      throw new CodedError('cannot complete a running task', 'BAD_REQUEST');
    }
    this.store.completeTask(id, result);
    this.store.appendEvent(id, null, 'status_changed', {
      from: task.status,
      to: 'done',
      by: 'user',
      result
    });
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/__tests__/kanban-commands.test.ts`
Expected: PASS (all create/list/show + status/assign tests).

- [ ] **Step 5: Type check**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/kanban/kanban-commands.ts src/main/__tests__/kanban-commands.test.ts
git commit -m "feat(kanban): KanbanCommands status verbs + assign

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `KanbanCommands` — `comment`, `link`, `unlink`, `log`, `dispatch`

**Files:**
- Modify: `src/main/kanban/kanban-commands.ts`
- Test: `src/main/__tests__/kanban-commands.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/main/__tests__/kanban-commands.test.ts`:

```ts
describe('KanbanCommands comment/link/log/dispatch', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('comment adds a human comment and logs comment_added', () => {
    const { store, commands } = makeCommands();
    const t = commands.create({ title: 'x' });
    const c = commands.comment(t.id, 'looks good');
    expect(c.author).toBe('human');
    expect(store.listComments(t.id)[0].body).toBe('looks good');
    expect(store.listEvents(t.id).map((e) => e.kind)).toContain('comment_added');
  });

  it('link and unlink wire parent/child and log events on the child', () => {
    const { store, commands } = makeCommands();
    const parent = commands.create({ title: 'parent' });
    const child = commands.create({ title: 'child' });
    commands.link(parent.id, child.id);
    expect(store.childrenOf(parent.id)).toContain(child.id);
    expect(store.listEvents(child.id).map((e) => e.kind)).toContain('link_added');
    commands.unlink(parent.id, child.id);
    expect(store.childrenOf(parent.id)).not.toContain(child.id);
    expect(store.listEvents(child.id).map((e) => e.kind)).toContain('link_removed');
  });

  it('comment/link reject unknown ids', () => {
    const { commands } = makeCommands();
    expect(() => commands.comment('nope', 'hi')).toThrowError(/not found/);
    expect(() => commands.link('nope', 'also-nope')).toThrowError(/not found/);
  });

  it('log returns the task event list', () => {
    const { commands } = makeCommands();
    const t = commands.create({ title: 'x' });
    commands.comment(t.id, 'note');
    const log = commands.log(t.id);
    expect(log.map((e) => e.kind)).toEqual(expect.arrayContaining(['task_created', 'comment_added']));
  });

  it('dispatch ticks the dispatcher without throwing', () => {
    const { commands } = makeCommands();
    expect(() => commands.dispatch()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-commands.test.ts`
Expected: FAIL — `commands.comment`/`link`/`unlink`/`log`/`dispatch` are not functions.

- [ ] **Step 3: Add the methods**

In `src/main/kanban/kanban-commands.ts`, add to the class (after `complete`):

```ts
  comment(id: string, body: string): TaskComment {
    this.requireTask(id);
    const comment = this.store.addComment(id, 'human', body);
    this.store.appendEvent(id, null, 'comment_added', { author: 'human' });
    return comment;
  }

  link(parentId: string, childId: string): void {
    this.requireTask(parentId);
    this.requireTask(childId);
    this.store.addLink(parentId, childId);
    this.store.appendEvent(childId, null, 'link_added', { parentId });
  }

  unlink(parentId: string, childId: string): void {
    this.requireTask(parentId);
    this.requireTask(childId);
    this.store.removeLink(parentId, childId);
    this.store.appendEvent(childId, null, 'link_removed', { parentId });
  }

  log(id: string): TaskEvent[] {
    this.requireTask(id);
    return this.store.listEvents(id);
  }

  dispatch(): void {
    this.dispatcher.tick();
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/__tests__/kanban-commands.test.ts`
Expected: PASS (all KanbanCommands tests).

- [ ] **Step 5: Type check**

Run: `npm run typecheck`
Expected: no errors (all imported types now consumed).

- [ ] **Step 6: Commit**

```bash
git add src/main/kanban/kanban-commands.ts src/main/__tests__/kanban-commands.test.ts
git commit -m "feat(kanban): KanbanCommands comment/link/log/dispatch

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Refactor `kanban-ipc.ts` to delegate to `KanbanCommands`

**Files:**
- Modify: `src/main/kanban/kanban-ipc.ts` (whole file)
- Modify: `src/main/index.ts:740-806`
- Test: existing `src/main/__tests__/kanban-spawn-worker.test.ts` and any `kanban-ipc` tests must still pass (no behavior change).

**Context:** `registerKanbanIpc` currently takes `(store, dispatcher, getCreateDefaults)` and calls the store + `appendEvent` directly. After this task it takes `(commands)` and each handler delegates. The renderer-facing channel names, payloads, and return values are unchanged. The manual-status guard in `KANBAN_SET_STATUS` previously **silently no-op'd** on rejection (logged a warning) — preserve that by catching the `CodedError` that `commands.setManualStatus` now throws.

- [ ] **Step 1: Rewrite `kanban-ipc.ts`**

Replace the entire contents of `src/main/kanban/kanban-ipc.ts` with:

```ts
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import { createLogger } from '../logger';
import type { KanbanCommands } from './kanban-commands';
import type { CreateTaskInput, TaskDetail, Task } from '../../shared/kanban-types';
import type {
  KanbanUpdateTaskRequest,
  KanbanSetStatusRequest,
  KanbanAddCommentRequest,
  KanbanLinkRequest
} from '../../shared/ipc-api';

const log = createLogger('kanban-ipc');

export function registerKanbanIpc(commands: KanbanCommands): void {
  ipcMain.handle(IPC_CHANNELS.KANBAN_LIST_BOARD, () => commands.list());

  ipcMain.handle(IPC_CHANNELS.KANBAN_GET_TASK, (_e, taskId: string): TaskDetail | null => {
    return commands.show(taskId);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_CREATE_TASK, (_e, input: CreateTaskInput): Task => {
    return commands.create(input);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_UPDATE_TASK, (_e, req: KanbanUpdateTaskRequest) => {
    commands.update(req.id, req.fields);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_SET_STATUS, (_e, req: KanbanSetStatusRequest) => {
    // The board only ever offers valid drag targets; preserve the historical
    // silent no-op when a rejected move slips through (running-owned / invalid).
    try {
      commands.setManualStatus(req.id, req.status);
    } catch (err) {
      log.warn('rejected manual status change', {
        id: req.id,
        to: req.status,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_ADD_COMMENT, (_e, req: KanbanAddCommentRequest) => {
    commands.comment(req.taskId, req.body);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_ADD_LINK, (_e, req: KanbanLinkRequest) => {
    commands.link(req.parentId, req.childId);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_REMOVE_LINK, (_e, req: KanbanLinkRequest) => {
    commands.unlink(req.parentId, req.childId);
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_NUDGE, () => {
    commands.dispatch();
  });

  log.info('kanban IPC handlers registered');
}
```

- [ ] **Step 2: Update `index.ts` to construct `KanbanCommands` and pass it in**

In `src/main/index.ts`, add the import near the other kanban imports (find the line importing `registerKanbanIpc`):

```ts
import { KanbanCommands } from './kanban/kanban-commands';
```

Then, in the `app.whenReady()` block, **after** `kanbanDispatcher = new KanbanDispatcher(...)` / `kanbanDispatcher.start();` (currently line ~802) and **replacing** the existing `registerKanbanIpc(...)` call (currently lines 803-806), insert:

```ts
  const kanbanCommands = new KanbanCommands(kanbanStore, kanbanDispatcher, () => {
    const d = settingsStore.get().kanban.defaults;
    return { workspaceKind: d.workspaceKind, maxRuntimeSeconds: d.maxRuntimeSeconds };
  });
  registerKanbanIpc(kanbanCommands);
```

Leave the `setKanbanSettingsApplier(...)` block that follows unchanged.

- [ ] **Step 3: Type check**

Run: `npm run typecheck`
Expected: no errors. (If `index.ts` still imports `CreateTaskInput`/`WorkspaceKind`/`TaskDetail`/`Task` only for the old inline handlers and they are now unused, remove only those imports your change orphaned — nothing else.)

- [ ] **Step 4: Run the kanban test suites**

Run: `npx vitest run src/main/__tests__/kanban-spawn-worker.test.ts src/main/__tests__/kanban-dispatcher.test.ts src/main/__tests__/kanban-store.test.ts src/main/__tests__/kanban-commands.test.ts`
Expected: PASS — no behavior change.

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/main/kanban/kanban-ipc.ts src/main/index.ts
git commit -m "refactor(kanban): route IPC handlers through KanbanCommands

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `SocketServer` `kanban.*` dispatch + lazy `getKanban` injection

**Files:**
- Modify: `src/main/socket-server.ts`
- Modify: `src/main/socket-supervisor.ts`
- Modify: `src/main/index.ts` (supervisor construction at line ~364)
- Test: `src/main/__tests__/kanban-socket-watch.test.ts` (created here; `watch` added in Task 6)

**Context:** `SocketServer.dispatch(command, args)` is a `switch` returning data for one-shot commands. Add `kanban.*` cases routed through an injected `getKanban()` getter. The kanban store is created (`index.ts:740`) after the supervisor starts (`index.ts:364`), so injection must be lazy.

- [ ] **Step 1: Write the failing test**

Create `src/main/__tests__/kanban-socket-watch.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { createConnection } from 'net';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync } from 'fs';
import { SocketServer } from '../socket-server';
import type { KanbanCommands } from '../kanban/kanban-commands';

function tmpSocket(): string {
  return join(tmpdir(), `fleet-kanban-sock-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
}

// Minimal KanbanCommands stub — only the methods the socket server calls.
function stubKanban(): KanbanCommands {
  return {
    list: () => [{ id: 't1', title: 'hello', status: 'todo' }],
    show: (id: string) => (id === 't1' ? { task: { id: 't1' }, comments: [], runs: [], events: [], parents: [], children: [] } : null)
  } as unknown as KanbanCommands;
}

async function sendOne(sockPath: string, command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(sockPath, () => {
      socket.write(JSON.stringify({ id: 'x', command, args }) + '\n');
    });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf('\n');
      if (nl !== -1) {
        socket.end();
        resolve(JSON.parse(buffer.slice(0, nl)));
      }
    });
    socket.on('error', reject);
  });
}

describe('SocketServer kanban.* dispatch', () => {
  let server: SocketServer;
  let sockPath: string;

  afterEach(async () => {
    await server.stop();
    try {
      unlinkSync(sockPath);
    } catch {
      // ignore
    }
  });

  it('routes kanban.list through getKanban', async () => {
    sockPath = tmpSocket();
    server = new SocketServer(sockPath, undefined, undefined, () => stubKanban());
    await server.start();
    const res = (await sendOne(sockPath, 'kanban.list')) as { ok: boolean; data: unknown[] };
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.data)).toBe(true);
    expect((res.data[0] as { title: string }).title).toBe('hello');
  });

  it('returns UNAVAILABLE when kanban is not wired', async () => {
    sockPath = tmpSocket();
    server = new SocketServer(sockPath, undefined, undefined, () => undefined);
    await server.start();
    const res = (await sendOne(sockPath, 'kanban.list')) as { ok: boolean; code: string };
    expect(res.ok).toBe(false);
    expect(res.code).toBe('UNAVAILABLE');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-socket-watch.test.ts`
Expected: FAIL — `SocketServer` constructor takes 3 args / `kanban.list` is an unknown command.

- [ ] **Step 3: Add the `getKanban` constructor param + `kanban.*` cases**

In `src/main/socket-server.ts`:

3a. Add the import at the top (after the `AnnotateService` import):

```ts
import type { KanbanCommands } from './kanban/kanban-commands';
import type { TaskStatus, CreateTaskInput } from '../shared/kanban-types';
```

3b. Add the 4th constructor parameter:

```ts
  constructor(
    private socketPath: string,
    private imageService?: ImageService,
    private annotateService?: AnnotateService,
    private getKanban?: () => KanbanCommands | undefined
  ) {
    super();
  }
```

3c. Add a private helper (place it just above `private async dispatch(...)`):

```ts
  private requireKanban(): KanbanCommands {
    const k = this.getKanban?.();
    if (!k) throw new CodedError('Kanban not available', 'UNAVAILABLE');
    return k;
  }
```

3d. Add the `kanban.*` cases inside the `dispatch` `switch`, immediately before the `default:` case:

```ts
      // ── Kanban ──────────────────────────────────────────────────────────────
      case 'kanban.create': {
        const k = this.requireKanban();
        const title = typeof args.title === 'string' ? args.title : undefined;
        if (!title) throw new CodedError('kanban create requires --title', 'BAD_REQUEST');
        const input: CreateTaskInput = { title };
        if (typeof args.body === 'string') input.body = args.body;
        if (typeof args.assignee === 'string') input.assignee = args.assignee;
        if (typeof args.priority === 'string') input.priority = Number(args.priority);
        const task = k.create(input);
        this.emit('state-change', 'kanban:changed', { id: task.id });
        return task;
      }

      case 'kanban.list': {
        const k = this.requireKanban();
        const status = typeof args.status === 'string' ? (args.status as TaskStatus) : undefined;
        return k.list(status ? { status } : {});
      }

      case 'kanban.show': {
        const k = this.requireKanban();
        const id = typeof args.id === 'string' ? args.id : undefined;
        if (!id) throw new CodedError('kanban show requires a task id', 'BAD_REQUEST');
        const detail = k.show(id);
        if (!detail) throw new CodedError(`task not found: ${id}`, 'NOT_FOUND');
        return detail;
      }

      case 'kanban.assign': {
        const k = this.requireKanban();
        const id = typeof args.id === 'string' ? args.id : undefined;
        const profile = typeof args.profile === 'string' ? args.profile : undefined;
        if (!id) throw new CodedError('kanban assign requires a task id', 'BAD_REQUEST');
        if (!profile) throw new CodedError('kanban assign requires --profile', 'BAD_REQUEST');
        k.assign(id, profile);
        this.emit('state-change', 'kanban:changed', { id });
        return { ok: true };
      }

      case 'kanban.ready':
      case 'kanban.unblock':
      case 'kanban.archive': {
        const k = this.requireKanban();
        const id = typeof args.id === 'string' ? args.id : undefined;
        if (!id) throw new CodedError(`${command} requires a task id`, 'BAD_REQUEST');
        if (command === 'kanban.ready') k.ready(id);
        else if (command === 'kanban.unblock') k.unblock(id);
        else k.archive(id);
        this.emit('state-change', 'kanban:changed', { id });
        return { ok: true };
      }

      case 'kanban.block': {
        const k = this.requireKanban();
        const id = typeof args.id === 'string' ? args.id : undefined;
        const reason = typeof args.reason === 'string' ? args.reason : undefined;
        if (!id) throw new CodedError('kanban block requires a task id', 'BAD_REQUEST');
        if (!reason) throw new CodedError('kanban block requires --reason', 'BAD_REQUEST');
        k.block(id, reason);
        this.emit('state-change', 'kanban:changed', { id });
        return { ok: true };
      }

      case 'kanban.complete': {
        const k = this.requireKanban();
        const id = typeof args.id === 'string' ? args.id : undefined;
        const result = typeof args.result === 'string' ? args.result : undefined;
        if (!id) throw new CodedError('kanban complete requires a task id', 'BAD_REQUEST');
        if (!result) throw new CodedError('kanban complete requires --result', 'BAD_REQUEST');
        k.complete(id, result);
        this.emit('state-change', 'kanban:changed', { id });
        return { ok: true };
      }

      case 'kanban.comment': {
        const k = this.requireKanban();
        const id = typeof args.id === 'string' ? args.id : undefined;
        const body = typeof args.body === 'string' ? args.body : undefined;
        if (!id) throw new CodedError('kanban comment requires a task id', 'BAD_REQUEST');
        if (!body) throw new CodedError('kanban comment requires a comment body', 'BAD_REQUEST');
        const comment = k.comment(id, body);
        this.emit('state-change', 'kanban:changed', { id });
        return comment;
      }

      case 'kanban.link':
      case 'kanban.unlink': {
        const k = this.requireKanban();
        const parentId = typeof args.parentId === 'string' ? args.parentId : undefined;
        const childId = typeof args.childId === 'string' ? args.childId : undefined;
        if (!parentId || !childId) {
          throw new CodedError(`${command} requires parentId and childId`, 'BAD_REQUEST');
        }
        if (command === 'kanban.link') k.link(parentId, childId);
        else k.unlink(parentId, childId);
        this.emit('state-change', 'kanban:changed', { id: childId });
        return { ok: true };
      }

      case 'kanban.log': {
        const k = this.requireKanban();
        const id = typeof args.id === 'string' ? args.id : undefined;
        if (!id) throw new CodedError('kanban log requires a task id', 'BAD_REQUEST');
        return k.log(id);
      }

      case 'kanban.dispatch': {
        const k = this.requireKanban();
        k.dispatch();
        return { ok: true };
      }
```

- [ ] **Step 4: Thread `getKanban` through `SocketSupervisor`**

In `src/main/socket-supervisor.ts`:

4a. Add the import (after the `AnnotateService` import):

```ts
import type { KanbanCommands } from './kanban/kanban-commands';
```

4b. Add the 4th constructor parameter:

```ts
  constructor(
    private socketPath: string,
    private imageService?: ImageService,
    private annotateService?: AnnotateService,
    private getKanban?: () => KanbanCommands | undefined
  ) {
    super();
  }
```

4c. Pass it into the `SocketServer` in `createServer()`:

```ts
    const server = new SocketServer(
      this.socketPath,
      this.imageService,
      this.annotateService,
      this.getKanban
    );
```

- [ ] **Step 5: Pass the lazy getter in `index.ts`**

In `src/main/index.ts`:

5a. Find the module-level kanban bindings (near line 58: `let kanbanStore: KanbanStore | undefined;`) and add:

```ts
let kanbanCommands: KanbanCommands | undefined;
```

5b. Change the supervisor construction (line ~364) from:

```ts
  socketSupervisor = new SocketSupervisor(SOCKET_PATH, imageService, annotateService);
```

to:

```ts
  socketSupervisor = new SocketSupervisor(
    SOCKET_PATH,
    imageService,
    annotateService,
    () => kanbanCommands
  );
```

5c. Change the Task-4 line `const kanbanCommands = new KanbanCommands(...)` to assign the module-level binding instead of declaring a new local:

```ts
  kanbanCommands = new KanbanCommands(kanbanStore, kanbanDispatcher, () => {
    const d = settingsStore.get().kanban.defaults;
    return { workspaceKind: d.workspaceKind, maxRuntimeSeconds: d.maxRuntimeSeconds };
  });
  registerKanbanIpc(kanbanCommands);
```

(Remove the `const` so it targets the `let kanbanCommands` from 5a.)

- [ ] **Step 6: Run the socket test + type check**

Run: `npx vitest run src/main/__tests__/kanban-socket-watch.test.ts`
Expected: PASS (2 tests).
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/main/socket-server.ts src/main/socket-supervisor.ts src/main/index.ts src/main/__tests__/kanban-socket-watch.test.ts
git commit -m "feat(kanban): socket-server kanban.* dispatch with lazy injection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `kanban.watch` subscription channel + `broadcastKanbanEvent`

**Files:**
- Modify: `src/main/socket-server.ts`
- Modify: `src/main/socket-supervisor.ts`
- Modify: `src/main/index.ts` (the `KanbanStore` `onEvent` callback at line ~741)
- Test: `src/main/__tests__/kanban-socket-watch.test.ts` (extend)

**Context:** `watch` keeps the socket open and streams events. It cannot be a normal `dispatch` case (those return one value and the client reads one line). Special-case it in `handleLine`, like the dead `SocketApi` special-cases `subscribe`. `KanbanStore.onEvent` already fires on every mutation; forward it to `broadcastKanbanEvent`.

- [ ] **Step 1: Write the failing test**

Append to `src/main/__tests__/kanban-socket-watch.test.ts`:

```ts
describe('SocketServer kanban.watch streaming', () => {
  let server: SocketServer;
  let sockPath: string;

  afterEach(async () => {
    await server.stop();
    try {
      unlinkSync(sockPath);
    } catch {
      // ignore
    }
  });

  it('streams broadcast events to a subscribed socket after an ack', async () => {
    sockPath = tmpSocket();
    server = new SocketServer(sockPath, undefined, undefined, () => stubKanban());
    await server.start();

    const lines = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const collected: Array<Record<string, unknown>> = [];
      const client = createConnection(sockPath, () => {
        client.write(JSON.stringify({ id: 'w', command: 'kanban.watch', args: {} }) + '\n');
      });
      let buffer = '';
      client.on('data', (chunk) => {
        buffer += chunk.toString();
        const parts = buffer.split('\n');
        buffer = parts.pop() ?? '';
        for (const p of parts) {
          if (!p.trim()) continue;
          collected.push(JSON.parse(p));
          if (collected.length === 1) {
            // First line is the ack; now broadcast an event.
            server.broadcastKanbanEvent({ taskId: 't1', kind: 'task_created' });
          }
          if (collected.length >= 2) {
            client.end();
            resolve(collected);
          }
        }
      });
      client.on('error', reject);
      setTimeout(() => {
        client.end();
        reject(new Error('timeout'));
      }, 3000);
    });

    expect(lines[0].ok).toBe(true);
    expect((lines[0].data as { watching: boolean }).watching).toBe(true);
    expect((lines[1].kanbanEvent as { kind: string }).kind).toBe('task_created');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-socket-watch.test.ts`
Expected: FAIL — `server.broadcastKanbanEvent` is not a function / no ack received.

- [ ] **Step 3: Add the subscriber set, watch special-case, and broadcast method**

In `src/main/socket-server.ts`:

3a. Add a subscriber set as a class field (next to `private clients = new Set<Socket>();`):

```ts
  private kanbanSubscribers = new Set<Socket>();
```

3b. In the connection handler, remove subscribers on close/error. Find the existing `socket.on('close', ...)` and `socket.on('error', ...)` inside `createServer`'s connection callback and add the delete to each body:

```ts
        socket.on('close', () => {
          this.clients.delete(socket);
          this.kanbanSubscribers.delete(socket);
        });

        socket.on('error', () => {
          this.clients.delete(socket);
          this.kanbanSubscribers.delete(socket);
        });
```

3c. In `handleLine`, after `req` is validated and **before** the `try { const data = await this.dispatch(...) }` block, intercept `kanban.watch`:

```ts
    if (req.command === 'kanban.watch') {
      if (!this.getKanban?.()) {
        this.sendResponse(socket, {
          id: req.id,
          ok: false,
          error: 'Kanban not available',
          code: 'UNAVAILABLE'
        });
        return;
      }
      this.kanbanSubscribers.add(socket);
      this.sendResponse(socket, { id: req.id, ok: true, data: { watching: true } });
      return;
    }
```

3d. Add the broadcast method (public, place it after `private sendResponse(...)`):

```ts
  broadcastKanbanEvent(event: unknown): void {
    const line = JSON.stringify({ kanbanEvent: event }) + '\n';
    for (const socket of this.kanbanSubscribers) {
      if (!socket.destroyed) {
        socket.write(line);
      }
    }
  }
```

- [ ] **Step 4: Expose `broadcastKanbanEvent` on the supervisor**

In `src/main/socket-supervisor.ts`, add a method to the class (after `resetBackoff()`):

```ts
  broadcastKanbanEvent(event: unknown): void {
    this.server?.broadcastKanbanEvent(event);
  }
```

- [ ] **Step 5: Forward store events to the supervisor in `index.ts`**

In `src/main/index.ts`, the `KanbanStore` is created (line ~740) with an `onEvent` callback. Add the supervisor forward to that callback body:

```ts
  kanbanStore = new KanbanStore(join(KANBAN_HOME, 'kanban.db'), {
    onEvent: (event) => {
      const w = mainWindow;
      if (w && !w.isDestroyed()) {
        w.webContents.send(IPC_CHANNELS.KANBAN_EVENT, event);
      }
      socketSupervisor?.broadcastKanbanEvent(event);
    }
  });
```

- [ ] **Step 6: Run the watch test + type check + full suite**

Run: `npx vitest run src/main/__tests__/kanban-socket-watch.test.ts`
Expected: PASS (3 tests total).
Run: `npm run typecheck`
Expected: no errors.
Run: `npm test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/main/socket-server.ts src/main/socket-supervisor.ts src/main/index.ts src/main/__tests__/kanban-socket-watch.test.ts
git commit -m "feat(kanban): kanban.watch streaming + broadcastKanbanEvent

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `fleet-cli.ts` — `kanban` verbs via the generic path (positional fixups, validation, help)

**Files:**
- Modify: `src/main/fleet-cli.ts`
- Test: `src/main/__tests__/fleet-cli.test.ts`

**Context:** Non-`watch` kanban verbs ride the existing generic socket-client path at the bottom of `runCLI` (which sends `kanban.<action>` and auto-formats array→table / object→`key:value` / `--format json`). Two additions make that work: (1) a positional-arg fixup block modeled on the existing `image.action` remap (lines ~746-767), and (2) client-side validation entries in `validateCommand`. Plus help text. `parseArgs` already maps the first positional to `args.id`, so `show <id>`, `block <id> --reason …` etc. get `args.id` for free; only `comment` (id + body) and `link`/`unlink` (parentId + childId) need fixups.

- [ ] **Step 1: Write the failing tests**

Append to `src/main/__tests__/fleet-cli.test.ts`:

```ts
describe('fleet kanban validation', () => {
  const SOCK = '/tmp/no-socket-kanban.sock';

  it('create without --title errors', async () => {
    const out = await runCLI(['kanban', 'create'], SOCK);
    expect(out).toMatch(/requires --title/);
  });

  it('show without id errors', async () => {
    const out = await runCLI(['kanban', 'show'], SOCK);
    expect(out).toMatch(/requires a task id/);
  });

  it('block without --reason errors', async () => {
    const out = await runCLI(['kanban', 'block', 't1'], SOCK);
    expect(out).toMatch(/requires --reason/);
  });

  it('complete without --result errors', async () => {
    const out = await runCLI(['kanban', 'complete', 't1'], SOCK);
    expect(out).toMatch(/requires --result/);
  });

  it('comment without body errors', async () => {
    const out = await runCLI(['kanban', 'comment', 't1'], SOCK);
    expect(out).toMatch(/requires a comment/);
  });

  it('link without two ids errors', async () => {
    const out = await runCLI(['kanban', 'link', 't1'], SOCK);
    expect(out).toMatch(/requires a parent and child/);
  });
});

describe('fleet kanban --help', () => {
  it('shows kanban help', async () => {
    const out = await runCLI(['kanban', '--help'], '/tmp/no-socket.sock');
    expect(out).toMatch(/fleet kanban/);
    expect(out).toMatch(/watch/);
  });

  it('lists kanban in top-level help', async () => {
    const out = await runCLI(['--help'], '/tmp/no-socket.sock');
    expect(out).toMatch(/kanban/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/__tests__/fleet-cli.test.ts`
Expected: FAIL — validation messages absent; kanban not in help.

- [ ] **Step 3: Add validation cases**

In `src/main/fleet-cli.ts`, inside `validateCommand`'s `switch`, add these cases before `default:`:

```ts
    // ── Kanban ────────────────────────────────────────────────────────────
    case 'kanban.create':
      if (!args.title) return 'Error: kanban create requires --title.\n\nUsage: fleet kanban create --title "..." [--assignee <profile>] [--priority <n>] [--body "..."]';
      return null;

    case 'kanban.show':
    case 'kanban.log':
    case 'kanban.ready':
    case 'kanban.unblock':
    case 'kanban.archive': {
      const verb = command.split('.')[1];
      if (!args.id) return `Error: kanban ${verb} requires a task id.\n\nUsage: fleet kanban ${verb} <task-id>`;
      return null;
    }

    case 'kanban.assign':
      if (!args.id) return 'Error: kanban assign requires a task id.\n\nUsage: fleet kanban assign <task-id> --profile <name>';
      if (!args.profile) return 'Error: kanban assign requires --profile.\n\nUsage: fleet kanban assign <task-id> --profile <name>';
      return null;

    case 'kanban.block':
      if (!args.id) return 'Error: kanban block requires a task id.\n\nUsage: fleet kanban block <task-id> --reason "..."';
      if (!args.reason) return 'Error: kanban block requires --reason.\n\nUsage: fleet kanban block <task-id> --reason "..."';
      return null;

    case 'kanban.complete':
      if (!args.id) return 'Error: kanban complete requires a task id.\n\nUsage: fleet kanban complete <task-id> --result "..."';
      if (!args.result) return 'Error: kanban complete requires --result.\n\nUsage: fleet kanban complete <task-id> --result "..."';
      return null;

    case 'kanban.comment':
      if (!args.id) return 'Error: kanban comment requires a task id.\n\nUsage: fleet kanban comment <task-id> "comment text"';
      if (!args.body) return 'Error: kanban comment requires a comment body.\n\nUsage: fleet kanban comment <task-id> "comment text"';
      return null;

    case 'kanban.link':
    case 'kanban.unlink': {
      const verb = command.split('.')[1];
      if (!args.parentId || !args.childId) return `Error: kanban ${verb} requires a parent and child id.\n\nUsage: fleet kanban ${verb} <parent-id> <child-id>`;
      return null;
    }
```

- [ ] **Step 4: Add the positional fixup block**

In `src/main/fleet-cli.ts`, find the `image.action` remap block (`if (command === 'image.action') { ... }`, lines ~746-767). Immediately after it, add the kanban fixup:

```ts
  // ── kanban: remap positionals to named args ──────────────────────────────
  if (group === 'kanban') {
    const positionals = cleanRest.filter((t) => !t.startsWith('--'));
    if (action === 'comment' && positionals.length >= 2) {
      // parseArgs maps every positional to args.id (last wins), so the comment
      // text clobbered id — restore id from the first positional, body from the rest.
      args.id = positionals[0];
      args.body = positionals.slice(1).join(' ');
    }
    if ((action === 'link' || action === 'unlink') && positionals.length >= 2) {
      args.parentId = positionals[0];
      args.childId = positionals[1];
      delete args.id;
    }
  }
```

- [ ] **Step 5: Add help text**

In `src/main/fleet-cli.ts`:

5a. Add a `kanban` row to the `HELP_TOP` command table (after the `pi` row):

```
| kanban | Manage the Kanban board: tasks, links, comments, live watch. |
```

5b. Add a `kanban` entry to `HELP_GROUPS`:

```ts
  kanban: `# fleet kanban

Manage the Kanban board from the terminal. Requires the Fleet app to be running.

## Commands

  fleet kanban create --title "..." [--body "..."] [--assignee <profile>] [--priority <n>]
  fleet kanban list [--status <status>]
  fleet kanban show <task-id>
  fleet kanban assign <task-id> --profile <name>
  fleet kanban ready <task-id>
  fleet kanban block <task-id> --reason "..."
  fleet kanban unblock <task-id>
  fleet kanban archive <task-id>
  fleet kanban complete <task-id> --result "..."
  fleet kanban comment <task-id> "comment text"
  fleet kanban link <parent-id> <child-id>
  fleet kanban unlink <parent-id> <child-id>
  fleet kanban log <task-id>
  fleet kanban dispatch
  fleet kanban watch

## Options

  --status <status>   Filter list by status (triage|todo|ready|running|blocked|done|archived).
  --format json       Emit raw JSON instead of a table.

## Examples

  fleet kanban create --title "Fix flaky test" --assignee default --priority 2
  fleet kanban list --status ready
  fleet kanban show t_abc123
  fleet kanban watch`
```

- [ ] **Step 6: Run the tests + type check**

Run: `npx vitest run src/main/__tests__/fleet-cli.test.ts`
Expected: PASS (kanban validation + help tests, plus all existing).
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/main/fleet-cli.ts src/main/__tests__/fleet-cli.test.ts
git commit -m "feat(kanban): fleet kanban CLI verbs (parsing, validation, help)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `fleet-cli.ts` — `watch` streaming client

**Files:**
- Modify: `src/main/fleet-cli.ts`
- Test: `src/main/__tests__/fleet-cli.test.ts`

**Context:** `watch` cannot use the one-shot `FleetCLI.send` (which closes after the first response line). It needs its own long-lived socket: connect, send `kanban.watch`, print streamed event lines until the connection closes or the user hits Ctrl-C. It returns `''` on close so the entrypoint prints nothing extra, and a `Fleet is not running` string when the socket is absent.

- [ ] **Step 1: Write the failing test**

Append to `src/main/__tests__/fleet-cli.test.ts`:

```ts
describe('fleet kanban watch', () => {
  it('reports when the app is not running', async () => {
    const out = await runCLI(['kanban', 'watch'], '/tmp/fleet-watch-nope.sock');
    expect(out).toMatch(/not running/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/__tests__/fleet-cli.test.ts -t "watch"`
Expected: FAIL — `watch` currently falls through to the generic path and returns an unknown-command error, not a "not running" message.

- [ ] **Step 3: Add the streaming function**

In `src/main/fleet-cli.ts`, add this function above `runCLI` (it uses the already-imported `createConnection`, `randomUUID`, `isRecord`, `toStr`):

```ts
// ── kanban watch: long-lived event stream ────────────────────────────────────

function formatWatchEvent(event: unknown): string {
  if (!isRecord(event)) return toStr(event);
  const t = typeof event.createdAt === 'number' ? new Date(event.createdAt) : null;
  const time = t ? t.toISOString().slice(11, 19) : '--:--:--';
  const taskId = toStr(event.taskId);
  const kind = toStr(event.kind);
  return `${time}  ${taskId}  ${kind}`;
}

export async function runKanbanWatch(sockPath: string, opts: { json: boolean }): Promise<string> {
  return new Promise((resolve) => {
    const socket = createConnection(sockPath, () => {
      socket.write(
        JSON.stringify({ id: randomUUID(), command: 'kanban.watch', args: {} }) + '\n'
      );
    });
    let buffer = '';
    let acked = false;

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (!acked) {
          acked = true;
          if (isRecord(msg) && msg.ok === false) {
            socket.end();
            resolve(`Error: ${toStr(msg.error)}`);
            return;
          }
          process.stderr.write('Watching kanban events (Ctrl-C to stop)…\n');
          continue;
        }
        if (isRecord(msg) && 'kanbanEvent' in msg) {
          process.stdout.write((opts.json ? line : formatWatchEvent(msg.kanbanEvent)) + '\n');
        }
      }
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        resolve('Fleet is not running');
      } else {
        resolve(`Error: ${err.message}`);
      }
    });

    socket.on('close', () => resolve(''));
  });
}
```

- [ ] **Step 4: Route `watch` to it (early return in `runCLI`)**

In `src/main/fleet-cli.ts`, add this block inside `runCLI` alongside the other top-level group blocks — place it right after the `if (group === 'pi') { ... }` block:

```ts
  // ── Top-level "kanban watch" (streaming; all other kanban verbs use the generic path) ──
  if (group === 'kanban' && action === 'watch') {
    const json = rest.includes('--format') && rest[rest.indexOf('--format') + 1] === 'json';
    return runKanbanWatch(sockPath, { json });
  }
```

- [ ] **Step 5: Run the test + type check**

Run: `npx vitest run src/main/__tests__/fleet-cli.test.ts -t "watch"`
Expected: PASS.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/main/fleet-cli.ts src/main/__tests__/fleet-cli.test.ts
git commit -m "feat(kanban): fleet kanban watch streaming client

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] `npm run typecheck` — clean
- [ ] `npm test` — all green
- [ ] `npm run build` — succeeds (typecheck + electron-vite build)
- [ ] **Manual smoke (app running, `npm run dev`):**
  - `fleet kanban create --title "cli smoke" --priority 1` → prints the new task; card appears on the board.
  - `fleet kanban list` → table including the new task; `fleet kanban list --format json` → raw JSON.
  - `fleet kanban show <id>` → task detail.
  - In terminal A: `fleet kanban watch`; in terminal B: `fleet kanban comment <id> "hi"` and `fleet kanban block <id> --reason test` → terminal A streams `status_changed` / `comment_added` lines.
  - `fleet kanban unblock <id>` then `fleet kanban dispatch` → board reflects the change.
  - `fleet kanban --help` and `fleet --help` show kanban.

## Notes for the executor

- **Surgical changes:** Touch only what each task specifies. Do not refactor adjacent code, and do not remove pre-existing dead code (e.g. the unused `SocketApi`/`FleetCommandHandler` stack) — mention it, don't delete it.
- **Orphaned imports:** In Task 4, `index.ts` may have imports (`CreateTaskInput`, `WorkspaceKind`, etc.) that your change orphans. Remove only those your change made unused.
- **`emit('state-change', 'kanban:changed', …)`** in Task 5 mirrors the `image.*` cases; it is harmless if nothing consumes it yet (the supervisor relays `state-change` generically). It is not required for `watch` — `watch` is fed by `KanbanStore.onEvent` (Task 6) — but keeps kanban mutations symmetric with the rest of the socket API.
```
