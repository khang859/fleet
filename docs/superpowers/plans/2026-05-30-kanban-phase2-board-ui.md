# Kanban Phase 2 — Board UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class Kanban board tab to Fleet — columns, cards, drag-and-drop status changes, a card drawer (edit/comment/links/run-history), and a live event stream — backed by a new `window.fleet.kanban.*` IPC surface over the Phase 1 `KanbanStore`/`KanbanDispatcher`.

**Architecture:** Three new store methods (`updateTask`, `listBoard`, plus an `onEvent` sink) extend the existing `KanbanStore`. A new `kanban-ipc.ts` registers `ipcMain.handle` verbs; the store's `onEvent` callback pushes `task_events` to the renderer via `webContents.send`. The renderer gets a `'kanban'` tab type, a Zustand `useKanbanStore`, and `components/kanban/*` React components. Live updates use the proven `images.onChanged → reload` pattern: any event → refetch board + open task.

**Tech Stack:** Electron (ESM main), React + TypeScript, Zustand, Radix UI primitives + Tailwind v4, `react-markdown` (+ `remark-gfm`, `rehype-highlight`), `lucide-react`, native HTML5 drag-and-drop, `better-sqlite3`, vitest (node env).

---

## Critical Context for All Implementers

**better-sqlite3 native addon (REQUIRED before any vitest run that touches the store):**
The prebuilt `.node` addon targets Electron's ABI, but vitest runs under system Node. Before running tests that import `KanbanStore`, run:
```bash
npm rebuild better-sqlite3 >/dev/null 2>&1
```
Do **not** run `npm install` mid-task — it silently re-targets the addon to Electron and breaks vitest.

**Verification commands:**
- Single test file: `npm rebuild better-sqlite3 >/dev/null 2>&1; npx vitest run <path>`
- Typecheck: `npm run typecheck` (runs `typecheck:node` + `typecheck:web`)
- Lint: `npm run lint`

**Existing files you will touch (exact paths):**
- `src/shared/kanban-types.ts` — Phase 1 types (Task, TaskRun, TaskEvent, TaskComment, CreateTaskInput, TaskStatus).
- `src/main/kanban/kanban-store.ts` — `KanbanStore` class. `protected db`, `protected now`. Has `appendEvent`, `listComments`, `listRuns`, `listEvents`, `parentsOf`, `childrenOf`, `listTasks`, `getTask`, `setStatus`, `createTask`, `addComment`, `addLink`, `removeLink`.
- `src/shared/ipc-channels.ts` — channel name constants (colon-namespaced).
- `src/shared/ipc-api.ts` — IPC payload TS types.
- `src/preload/index.ts` — `fleetApi` object + `typedInvoke`/`onChannel` helpers; `export type FleetApi = typeof fleetApi`.
- `src/main/index.ts` — kanban bootstrap lives at lines ~735-779 inside `app.whenReady()`; `IPC_CHANNELS` already imported; `mainWindow` module-scoped.
- `src/renderer/src/store/workspace-store.ts` — `addPiTab` at lines ~355-386 is the template for `addKanbanTab`.
- `src/shared/types.ts` — `Tab.type` union (line ~19) and `PaneLeaf.paneType` union (line ~49).
- `src/renderer/src/App.tsx` — tab render switch at lines ~772-778; effect-based IPC subscriptions (e.g. `pi.onOpen` at ~281).
- `src/renderer/src/lib/commands.ts` — `createCommandRegistry()` returns `Command[]`; `new-tab` command (line ~20) calls `useWorkspaceStore.getState().addTab(...)`.

**Scope guardrails (YAGNI — these are LATER phases, do NOT build them now):**
- Worker-profile assignee dropdown → Phase 3. In Phase 2 the assignee is a plain text input.
- Live worker log tail in the drawer → later phase (no live Rune worker yet; defer file-tailing).
- Attachments, ⚗ Decompose / ✨ Specify, board switcher, running-lane grouping, CLI → Phases 4/5.
- Manual moves into/out of the **Running** column are forbidden (Running is dispatcher-owned). Running cards are not draggable. To run a task: set an assignee + move it to Ready; the dispatcher promotes it.

---

## Task 1: Store — `updateTask` method

**Files:**
- Modify: `src/main/kanban/kanban-store.ts`
- Modify: `src/shared/kanban-types.ts`
- Test: `src/main/__tests__/kanban-store.test.ts`

- [ ] **Step 1: Add `UpdateTaskFields` type**

In `src/shared/kanban-types.ts`, append:
```typescript
export interface UpdateTaskFields {
  title?: string;
  body?: string;
  assignee?: string | null;
  priority?: number;
  tenant?: string | null;
}
```

- [ ] **Step 2: Write the failing test**

In `src/main/__tests__/kanban-store.test.ts`, add (match the file's existing import + temp-db setup style):
```typescript
it('updateTask updates only provided fields and bumps updatedAt', () => {
  const t = store.createTask({ title: 'orig', body: 'b', priority: 1, assignee: 'alice' });
  const before = store.getTask(t.id)!;
  store.updateTask(t.id, { title: 'changed', assignee: null });
  const after = store.getTask(t.id)!;
  expect(after.title).toBe('changed');
  expect(after.assignee).toBeNull();
  expect(after.body).toBe('b'); // untouched
  expect(after.priority).toBe(1); // untouched
  expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm rebuild better-sqlite3 >/dev/null 2>&1; npx vitest run src/main/__tests__/kanban-store.test.ts -t updateTask`
Expected: FAIL — `store.updateTask is not a function`.

- [ ] **Step 4: Implement `updateTask`**

In `kanban-store.ts`, add the import of `UpdateTaskFields` to the existing type import line, then add this method (place it near `setStatus`):
```typescript
updateTask(id: string, fields: UpdateTaskFields): void {
  const current = this.getTask(id);
  if (!current) return;
  const ts = this.now();
  this.db
    .prepare(
      `UPDATE tasks SET title=@title, body=@body, assignee=@assignee,
        priority=@priority, tenant=@tenant, updated_at=@ts WHERE id=@id`
    )
    .run({
      id,
      title: fields.title ?? current.title,
      body: fields.body ?? current.body,
      assignee: fields.assignee !== undefined ? fields.assignee : current.assignee,
      priority: fields.priority ?? current.priority,
      tenant: fields.tenant !== undefined ? fields.tenant : current.tenant,
      ts
    });
}
```
Note: `assignee`/`tenant` use `!== undefined` so callers can explicitly clear them to `null`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm rebuild better-sqlite3 >/dev/null 2>&1; npx vitest run src/main/__tests__/kanban-store.test.ts -t updateTask`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/kanban/kanban-store.ts src/shared/kanban-types.ts src/main/__tests__/kanban-store.test.ts
git commit -m "feat(kanban): add updateTask store method"
```

---

## Task 2: Store — `listBoard` enriched cards

**Files:**
- Modify: `src/main/kanban/kanban-store.ts`
- Modify: `src/shared/kanban-types.ts`
- Test: `src/main/__tests__/kanban-store.test.ts`

- [ ] **Step 1: Add `BoardCard` type**

In `src/shared/kanban-types.ts`, append:
```typescript
export interface BoardCard extends Task {
  commentCount: number;
  childTotal: number;
  childDone: number;
}
```

- [ ] **Step 2: Write the failing test**

```typescript
it('listBoard returns cards with comment and child-progress counts', () => {
  const parent = store.createTask({ title: 'parent' });
  const childA = store.createTask({ title: 'a' });
  const childB = store.createTask({ title: 'b' });
  store.addLink(parent.id, childA.id);
  store.addLink(parent.id, childB.id);
  store.setStatus(childA.id, 'done');
  store.addComment(parent.id, 'human', 'hi');
  store.addComment(parent.id, 'human', 'again');

  const cards = store.listBoard();
  const p = cards.find((c) => c.id === parent.id)!;
  expect(p.commentCount).toBe(2);
  expect(p.childTotal).toBe(2);
  expect(p.childDone).toBe(1);
  const a = cards.find((c) => c.id === childA.id)!;
  expect(a.childTotal).toBe(0);
  expect(a.commentCount).toBe(0);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm rebuild better-sqlite3 >/dev/null 2>&1; npx vitest run src/main/__tests__/kanban-store.test.ts -t listBoard`
Expected: FAIL — `store.listBoard is not a function`.

- [ ] **Step 4: Implement `listBoard`**

Add `BoardCard` to the type import line in `kanban-store.ts`, then add:
```typescript
listBoard(): BoardCard[] {
  const tasks = this.listTasks();
  const commentRows = this.db
    .prepare('SELECT task_id, COUNT(*) AS c FROM task_comments GROUP BY task_id')
    .all() as { task_id: string; c: number }[];
  const commentCounts = new Map(commentRows.map((r) => [r.task_id, Number(r.c)]));
  const childRows = this.db
    .prepare(
      `SELECT l.parent_id AS parent, COUNT(*) AS total,
        SUM(CASE WHEN c.status='done' THEN 1 ELSE 0 END) AS done
       FROM task_links l JOIN tasks c ON c.id = l.child_id
       GROUP BY l.parent_id`
    )
    .all() as { parent: string; total: number; done: number }[];
  const childMap = new Map(
    childRows.map((r) => [r.parent, { total: Number(r.total), done: Number(r.done) }])
  );
  return tasks.map((t) => ({
    ...t,
    commentCount: commentCounts.get(t.id) ?? 0,
    childTotal: childMap.get(t.id)?.total ?? 0,
    childDone: childMap.get(t.id)?.done ?? 0
  }));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm rebuild better-sqlite3 >/dev/null 2>&1; npx vitest run src/main/__tests__/kanban-store.test.ts -t listBoard`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/kanban/kanban-store.ts src/shared/kanban-types.ts src/main/__tests__/kanban-store.test.ts
git commit -m "feat(kanban): add listBoard enriched card query"
```

---

## Task 3: Store — `onEvent` live sink + `TaskDetail` type

**Files:**
- Modify: `src/main/kanban/kanban-store.ts`
- Modify: `src/shared/kanban-types.ts`
- Test: `src/main/__tests__/kanban-store.test.ts`

- [ ] **Step 1: Add `TaskDetail` type**

In `src/shared/kanban-types.ts`, append:
```typescript
export interface TaskDetail {
  task: Task;
  comments: TaskComment[];
  runs: TaskRun[];
  events: TaskEvent[];
  parents: Task[];
  children: Task[];
}
```

- [ ] **Step 2: Write the failing test**

```typescript
it('onEvent sink fires for every appended event', () => {
  const seen: string[] = [];
  const s = new KanbanStore(':memory:', { now: () => 1000, onEvent: (e) => seen.push(e.kind) });
  const t = s.createTask({ title: 'x' });
  s.appendEvent(t.id, null, 'status_changed', { to: 'ready' });
  s.close();
  expect(seen).toContain('status_changed');
});
```
(If the test file's setup uses a temp-file DB rather than `:memory:`, follow that convention instead; `:memory:` is fine for `better-sqlite3`.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npm rebuild better-sqlite3 >/dev/null 2>&1; npx vitest run src/main/__tests__/kanban-store.test.ts -t "onEvent sink"`
Expected: FAIL — `onEvent` option not honored (`seen` is empty), or a type error on the unknown option.

- [ ] **Step 4: Implement the sink**

In `kanban-store.ts`:

Extend `KanbanStoreOptions`:
```typescript
export interface KanbanStoreOptions {
  now?: () => number;
  onEvent?: (event: TaskEvent) => void;
}
```
Add a field and assign in the constructor (alongside `this.now = ...`):
```typescript
  protected onEvent?: (event: TaskEvent) => void;
```
```typescript
    this.onEvent = opts.onEvent;
```
In `appendEvent`, after building the `event` object and before `return`:
```typescript
    const event: TaskEvent = {
      id: Number(info.lastInsertRowid),
      taskId,
      runId,
      kind,
      payload: payload ?? null,
      createdAt: ts
    };
    this.onEvent?.(event);
    return event;
```
(Refactor the existing inline `return { ... }` into the named `event` const shown above.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npm rebuild better-sqlite3 >/dev/null 2>&1; npx vitest run src/main/__tests__/kanban-store.test.ts -t "onEvent sink"`
Expected: PASS.

- [ ] **Step 6: Run the full store suite + typecheck:node**

Run: `npm rebuild better-sqlite3 >/dev/null 2>&1; npx vitest run src/main/__tests__/kanban-store.test.ts && npm run typecheck:node`
Expected: all pass, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/main/kanban/kanban-store.ts src/shared/kanban-types.ts src/main/__tests__/kanban-store.test.ts
git commit -m "feat(kanban): add onEvent live sink and TaskDetail type"
```

---

## Task 4: Shared — IPC channels + payload types

**Files:**
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/shared/ipc-api.ts`

- [ ] **Step 1: Add channel constants**

In `src/shared/ipc-channels.ts`, inside the `IPC_CHANNELS` object (after the `PI_*` block), add:
```typescript
  // Kanban
  KANBAN_LIST_BOARD: 'kanban:list-board',
  KANBAN_GET_TASK: 'kanban:get-task',
  KANBAN_CREATE_TASK: 'kanban:create-task',
  KANBAN_UPDATE_TASK: 'kanban:update-task',
  KANBAN_SET_STATUS: 'kanban:set-status',
  KANBAN_ADD_COMMENT: 'kanban:add-comment',
  KANBAN_ADD_LINK: 'kanban:add-link',
  KANBAN_REMOVE_LINK: 'kanban:remove-link',
  KANBAN_NUDGE: 'kanban:nudge',
  KANBAN_EVENT: 'kanban:event',
```

- [ ] **Step 2: Add payload request types**

In `src/shared/ipc-api.ts`, append:
```typescript
export type KanbanUpdateTaskRequest = {
  id: string;
  fields: import('./kanban-types').UpdateTaskFields;
};

export type KanbanSetStatusRequest = {
  id: string;
  status: import('./kanban-types').TaskStatus;
};

export type KanbanAddCommentRequest = {
  taskId: string;
  body: string;
};

export type KanbanLinkRequest = {
  parentId: string;
  childId: string;
};
```
(Using inline `import('./kanban-types')` keeps this file's existing import block untouched. If the file already imports from `./kanban-types`, prefer adding to that import instead.)

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: clean (no consumers yet; this just confirms the types compile).

- [ ] **Step 4: Commit**

```bash
git add src/shared/ipc-channels.ts src/shared/ipc-api.ts
git commit -m "feat(kanban): add kanban IPC channels and payload types"
```

---

## Task 5: Preload — `window.fleet.kanban` namespace

**Files:**
- Modify: `src/preload/index.ts`

Context: `fleetApi` is an object literal; `typedInvoke<T>(channel, ...args)` wraps `ipcRenderer.invoke`; `onChannel<T>(channel, cb): Unsubscribe` wraps `ipcRenderer.on` and returns a cleanup fn. `export type FleetApi = typeof fleetApi` auto-derives the renderer type — no `env.d.ts` change needed.

- [ ] **Step 1: Add the kanban namespace**

In `src/preload/index.ts`, add to the `fleetApi` object (e.g. after the `pi: { ... }` namespace). Import the needed types at the top of the file alongside existing `ipc-api` imports:
```typescript
import type {
  KanbanUpdateTaskRequest,
  KanbanSetStatusRequest,
  KanbanAddCommentRequest,
  KanbanLinkRequest
} from '../shared/ipc-api';
import type {
  BoardCard,
  TaskDetail,
  CreateTaskInput,
  Task,
  TaskEvent
} from '../shared/kanban-types';
```
Namespace:
```typescript
  kanban: {
    listBoard: async (): Promise<BoardCard[]> => typedInvoke(IPC_CHANNELS.KANBAN_LIST_BOARD),
    getTask: async (taskId: string): Promise<TaskDetail | null> =>
      typedInvoke(IPC_CHANNELS.KANBAN_GET_TASK, taskId),
    createTask: async (input: CreateTaskInput): Promise<Task> =>
      typedInvoke(IPC_CHANNELS.KANBAN_CREATE_TASK, input),
    updateTask: async (req: KanbanUpdateTaskRequest): Promise<void> =>
      typedInvoke(IPC_CHANNELS.KANBAN_UPDATE_TASK, req),
    setStatus: async (req: KanbanSetStatusRequest): Promise<void> =>
      typedInvoke(IPC_CHANNELS.KANBAN_SET_STATUS, req),
    addComment: async (req: KanbanAddCommentRequest): Promise<void> =>
      typedInvoke(IPC_CHANNELS.KANBAN_ADD_COMMENT, req),
    addLink: async (req: KanbanLinkRequest): Promise<void> =>
      typedInvoke(IPC_CHANNELS.KANBAN_ADD_LINK, req),
    removeLink: async (req: KanbanLinkRequest): Promise<void> =>
      typedInvoke(IPC_CHANNELS.KANBAN_REMOVE_LINK, req),
    nudge: async (): Promise<void> => typedInvoke(IPC_CHANNELS.KANBAN_NUDGE),
    onEvent: (callback: (event: TaskEvent) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.KANBAN_EVENT, callback)
  },
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(kanban): expose window.fleet.kanban preload API"
```

---

## Task 6: Main — `kanban-ipc.ts` handlers + index.ts wiring

**Files:**
- Create: `src/main/kanban/kanban-ipc.ts`
- Modify: `src/main/index.ts`

Context: `kanbanStore`/`kanbanDispatcher` are created late, inside `app.whenReady()` (index.ts ~737-779), AFTER `registerIpcHandlers(...)` runs (~323). So kanban handlers are registered separately, right after the dispatcher is constructed. `dispatcher.tick()` is public (Phase 1). The live push goes through the store's `onEvent` (wired in this task), NOT through these handlers.

- [ ] **Step 1: Create `kanban-ipc.ts`**

```typescript
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import { createLogger } from '../logger';
import type { KanbanStore } from './kanban-store';
import type { KanbanDispatcher } from './kanban-dispatcher';
import type {
  CreateTaskInput,
  TaskStatus,
  TaskDetail,
  Task
} from '../../shared/kanban-types';
import type {
  KanbanUpdateTaskRequest,
  KanbanSetStatusRequest,
  KanbanAddCommentRequest,
  KanbanLinkRequest
} from '../../shared/ipc-api';

const log = createLogger('kanban-ipc');

const MANUAL_STATUSES: TaskStatus[] = [
  'triage',
  'todo',
  'ready',
  'blocked',
  'done',
  'archived'
];

function notNull(t: Task | null): t is Task {
  return t !== null;
}

export function registerKanbanIpc(store: KanbanStore, dispatcher: KanbanDispatcher): void {
  ipcMain.handle(IPC_CHANNELS.KANBAN_LIST_BOARD, () => store.listBoard());

  ipcMain.handle(IPC_CHANNELS.KANBAN_GET_TASK, (_e, taskId: string): TaskDetail | null => {
    const task = store.getTask(taskId);
    if (!task) return null;
    return {
      task,
      comments: store.listComments(taskId),
      runs: store.listRuns(taskId),
      events: store.listEvents(taskId),
      parents: store.parentsOf(taskId).map((id) => store.getTask(id)).filter(notNull),
      children: store.childrenOf(taskId).map((id) => store.getTask(id)).filter(notNull)
    };
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_CREATE_TASK, (_e, input: CreateTaskInput): Task => {
    const task = store.createTask(input);
    store.appendEvent(task.id, null, 'task_created', { title: task.title });
    return task;
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_UPDATE_TASK, (_e, req: KanbanUpdateTaskRequest) => {
    store.updateTask(req.id, req.fields);
    store.appendEvent(req.id, null, 'task_updated', {});
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_SET_STATUS, (_e, req: KanbanSetStatusRequest) => {
    const task = store.getTask(req.id);
    if (!task) return;
    // Running is dispatcher-owned: reject manual moves into or out of it.
    if (task.status === 'running' || req.status === 'running') {
      log.warn('rejected manual status change involving running', {
        id: req.id,
        from: task.status,
        to: req.status
      });
      return;
    }
    if (!MANUAL_STATUSES.includes(req.status)) return;
    store.setStatus(req.id, req.status);
    store.appendEvent(req.id, null, 'status_changed', {
      from: task.status,
      to: req.status,
      by: 'user'
    });
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_ADD_COMMENT, (_e, req: KanbanAddCommentRequest) => {
    store.addComment(req.taskId, 'human', req.body);
    store.appendEvent(req.taskId, null, 'comment_added', { author: 'human' });
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_ADD_LINK, (_e, req: KanbanLinkRequest) => {
    store.addLink(req.parentId, req.childId);
    store.appendEvent(req.childId, null, 'link_added', { parentId: req.parentId });
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_REMOVE_LINK, (_e, req: KanbanLinkRequest) => {
    store.removeLink(req.parentId, req.childId);
    store.appendEvent(req.childId, null, 'link_removed', { parentId: req.parentId });
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_NUDGE, () => {
    dispatcher.tick();
  });

  log.info('kanban IPC handlers registered');
}
```

- [ ] **Step 2: Wire `onEvent` into the store + register handlers in index.ts**

In `src/main/index.ts`:

(a) Add the import near the other kanban imports:
```typescript
import { registerKanbanIpc } from './kanban/kanban-ipc';
```
(b) Change the `KanbanStore` construction (currently `kanbanStore = new KanbanStore(join(KANBAN_HOME, 'kanban.db'));`) to pass an `onEvent` push:
```typescript
  kanbanStore = new KanbanStore(join(KANBAN_HOME, 'kanban.db'), {
    onEvent: (event) => {
      const w = mainWindow;
      if (w && !w.isDestroyed()) {
        w.webContents.send(IPC_CHANNELS.KANBAN_EVENT, event);
      }
    }
  });
```
(c) After `kanbanDispatcher.start();`, add:
```typescript
  registerKanbanIpc(kanbanStore, kanbanDispatcher);
```

- [ ] **Step 3: Verify typecheck:node**

Run: `npm run typecheck:node`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/main/kanban/kanban-ipc.ts src/main/index.ts
git commit -m "feat(kanban): register kanban IPC handlers and live event push"
```

---

## Task 7: Renderer — `'kanban'` tab type + `addKanbanTab` store action

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/renderer/src/store/workspace-store.ts`
- Test: `src/renderer/src/store/__tests__/workspace-store.test.ts`

Context: `addPiTab(cwd)` (workspace-store ~355-386) is the template. Tests call `useWorkspaceStore.getState().<action>()` directly in node env and assert on state — no `window.fleet` mock needed (the action only touches the store + `generateId`).

- [ ] **Step 1: Extend the type unions**

In `src/shared/types.ts`:
- `Tab.type` union: add `| 'kanban'`.
- `PaneLeaf.paneType` union: add `| 'kanban'`.

- [ ] **Step 2: Write the failing test**

In `workspace-store.test.ts`, add:
```typescript
it('addKanbanTab adds a kanban tab and activates it', () => {
  useWorkspaceStore.setState({
    workspace: { id: 'ws', label: 'W', tabs: [] },
    backgroundWorkspaces: new Map(),
    activeTabId: null,
    activePaneId: null
  });
  const paneId = useWorkspaceStore.getState().addKanbanTab('/tmp');
  const state = useWorkspaceStore.getState();
  const tab = state.workspace.tabs.find((t) => t.type === 'kanban');
  expect(tab).toBeDefined();
  expect(tab!.splitRoot.type).toBe('leaf');
  expect(state.activeTabId).toBe(tab!.id);
  expect(typeof paneId).toBe('string');
});
```
(Match the file's existing `beforeEach`/`setState` shape — only the fields the action reads matter.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/store/__tests__/workspace-store.test.ts -t addKanbanTab`
Expected: FAIL — `addKanbanTab is not a function`.

- [ ] **Step 4: Implement `addKanbanTab`**

In `workspace-store.ts`, add to the `WorkspaceStore` type (near `addPiTab`):
```typescript
  addKanbanTab: (cwd: string) => string;
```
And implement it (place next to `addPiTab`; the board is not a shell, so omit `shellProfileId`/`pathContext`):
```typescript
addKanbanTab: (cwd) => {
  const leaf: PaneLeaf = {
    type: 'leaf',
    id: generateId(),
    cwd,
    paneType: 'kanban'
  };
  const tab: Tab = {
    id: generateId(),
    label: 'Kanban',
    labelIsCustom: true,
    cwd,
    type: 'kanban',
    splitRoot: leaf
  };
  set((state) => ({
    workspace: {
      ...state.workspace,
      tabs: [...state.workspace.tabs, tab]
    },
    activeTabId: tab.id,
    activePaneId: leaf.id,
    isDirty: true
  }));
  return leaf.id;
},
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/store/__tests__/workspace-store.test.ts -t addKanbanTab`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/renderer/src/store/workspace-store.ts src/renderer/src/store/__tests__/workspace-store.test.ts
git commit -m "feat(kanban): add 'kanban' tab type and addKanbanTab action"
```

---

## Task 8: Renderer — `useKanbanStore` (Zustand)

**Files:**
- Create: `src/renderer/src/store/kanban-store.ts`

Context: mirror `image-store.ts` (Zustand + direct `window.fleet.*` calls). No automated test (it calls `window.fleet`, unavailable in node env); verified by typecheck:web and manual. Verify the relative import depth compiles (`src/renderer/src/store` → `../../../shared`).

- [ ] **Step 1: Create the store**

```typescript
import { create } from 'zustand';
import type {
  BoardCard,
  TaskDetail,
  CreateTaskInput,
  TaskStatus,
  UpdateTaskFields
} from '../../../shared/kanban-types';

type KanbanState = {
  cards: BoardCard[];
  loaded: boolean;
  openTaskId: string | null;
  detail: TaskDetail | null;
  loadBoard: () => Promise<void>;
  openTask: (id: string) => Promise<void>;
  closeTask: () => void;
  refreshDetail: () => Promise<void>;
  createTask: (input: CreateTaskInput) => Promise<void>;
  updateTask: (id: string, fields: UpdateTaskFields) => Promise<void>;
  setStatus: (id: string, status: TaskStatus) => Promise<void>;
  addComment: (taskId: string, body: string) => Promise<void>;
  addLink: (parentId: string, childId: string) => Promise<void>;
  removeLink: (parentId: string, childId: string) => Promise<void>;
  nudge: () => Promise<void>;
};

export const useKanbanStore = create<KanbanState>((set, get) => ({
  cards: [],
  loaded: false,
  openTaskId: null,
  detail: null,

  loadBoard: async () => {
    const cards = await window.fleet.kanban.listBoard();
    set({ cards, loaded: true });
  },
  openTask: async (id) => {
    const detail = await window.fleet.kanban.getTask(id);
    set({ openTaskId: id, detail });
  },
  closeTask: () => set({ openTaskId: null, detail: null }),
  refreshDetail: async () => {
    const id = get().openTaskId;
    if (!id) return;
    const detail = await window.fleet.kanban.getTask(id);
    set({ detail });
  },
  createTask: async (input) => {
    await window.fleet.kanban.createTask(input);
    await get().loadBoard();
  },
  updateTask: async (id, fields) => {
    await window.fleet.kanban.updateTask({ id, fields });
    await get().loadBoard();
    await get().refreshDetail();
  },
  setStatus: async (id, status) => {
    await window.fleet.kanban.setStatus({ id, status });
    await get().loadBoard();
    await get().refreshDetail();
  },
  addComment: async (taskId, body) => {
    await window.fleet.kanban.addComment({ taskId, body });
    await get().refreshDetail();
  },
  addLink: async (parentId, childId) => {
    await window.fleet.kanban.addLink({ parentId, childId });
    await get().loadBoard();
    await get().refreshDetail();
  },
  removeLink: async (parentId, childId) => {
    await window.fleet.kanban.removeLink({ parentId, childId });
    await get().loadBoard();
    await get().refreshDetail();
  },
  nudge: async () => {
    await window.fleet.kanban.nudge();
  }
}));
```

- [ ] **Step 2: Verify typecheck:web**

Run: `npm run typecheck:web`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/store/kanban-store.ts
git commit -m "feat(kanban): add renderer kanban Zustand store"
```

---

## Task 9: Renderer — board, columns, cards (+ drag-and-drop)

**Files:**
- Create: `src/renderer/src/components/kanban/KanbanBoard.tsx`
- Create: `src/renderer/src/components/kanban/KanbanColumn.tsx`
- Create: `src/renderer/src/components/kanban/KanbanCard.tsx`
- Create: `src/renderer/src/components/kanban/kanban-utils.ts`

Context: No DnD library — use native HTML5 drag (`draggable`, `onDragStart`/`onDragOver`/`onDrop`) per `TabItem.tsx`. Styling idiom: `neutral-*` base, `blue-*` accents, Tailwind v4. Icons from `lucide-react`. Relative import to shared from `components/kanban` is `../../../../shared`; to the store is `../../store/kanban-store`.

- [ ] **Step 1: Create `kanban-utils.ts`**

```typescript
import type { TaskStatus } from '../../../../shared/kanban-types';

export const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'triage', label: 'Triage' },
  { status: 'todo', label: 'Todo' },
  { status: 'ready', label: 'Ready' },
  { status: 'running', label: 'Running' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'done', label: 'Done' }
];

// Manual drag targets exclude 'running' (dispatcher-owned) and 'archived'.
export const DRAG_TARGETS: TaskStatus[] = ['triage', 'todo', 'ready', 'blocked', 'done'];

export function relativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(epochMs).toLocaleDateString();
}

export function formatDuration(startMs: number, endMs: number | null): string {
  const end = endMs ?? Date.now();
  const secs = Math.max(0, Math.floor((end - startMs) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}
```

- [ ] **Step 2: Create `KanbanCard.tsx`**

```typescript
import type { BoardCard } from '../../../../shared/kanban-types';
import { MessageSquare, GitBranch } from 'lucide-react';

type Props = {
  card: BoardCard;
  onOpen: (id: string) => void;
  onDragStart: (id: string) => void;
};

export function KanbanCard({ card, onOpen, onDragStart }: Props): React.JSX.Element {
  const draggable = card.status !== 'running';
  return (
    <div
      draggable={draggable}
      onDragStart={(e) => {
        if (!draggable) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', card.id);
        onDragStart(card.id);
      }}
      onClick={() => onOpen(card.id)}
      className="group cursor-pointer rounded-md border border-neutral-700 bg-neutral-800/60 p-2 text-xs text-neutral-200 hover:border-neutral-500 hover:bg-neutral-800 transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium leading-snug line-clamp-2">{card.title}</span>
        {card.status === 'running' && (
          <span className="mt-0.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-blue-400" title="worker running" />
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-neutral-400">
        <span className="font-mono text-neutral-500">{card.id}</span>
        {card.assignee && (
          <span className="rounded bg-teal-500/20 px-1 text-teal-300">{card.assignee}</span>
        )}
        {card.priority > 0 && (
          <span className="rounded bg-amber-500/20 px-1 text-amber-300">P{card.priority}</span>
        )}
        {card.tenant && (
          <span className="rounded bg-neutral-700 px-1 text-neutral-300">{card.tenant}</span>
        )}
        {card.childTotal > 0 && (
          <span className="inline-flex items-center gap-0.5">
            <GitBranch size={10} /> {card.childDone}/{card.childTotal}
          </span>
        )}
        {card.commentCount > 0 && (
          <span className="inline-flex items-center gap-0.5">
            <MessageSquare size={10} /> {card.commentCount}
          </span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create `KanbanColumn.tsx`**

```typescript
import { useState } from 'react';
import type { BoardCard, TaskStatus } from '../../../../shared/kanban-types';
import { KanbanCard } from './KanbanCard';
import { DRAG_TARGETS } from './kanban-utils';

type Props = {
  status: TaskStatus;
  label: string;
  cards: BoardCard[];
  onOpen: (id: string) => void;
  onDragStart: (id: string) => void;
  onDropCard: (status: TaskStatus) => void;
};

export function KanbanColumn({
  status,
  label,
  cards,
  onOpen,
  onDragStart,
  onDropCard
}: Props): React.JSX.Element {
  const [over, setOver] = useState(false);
  const isDropTarget = DRAG_TARGETS.includes(status);
  return (
    <div className="flex h-full w-64 shrink-0 flex-col">
      <div className="mb-2 flex items-center justify-between px-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">
        <span>{label}</span>
        <span className="rounded bg-neutral-800 px-1.5 text-neutral-500">{cards.length}</span>
      </div>
      <div
        onDragOver={(e) => {
          if (!isDropTarget) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (isDropTarget) onDropCard(status);
        }}
        className={`flex flex-1 flex-col gap-2 overflow-y-auto rounded-md border border-dashed p-2 transition-colors ${
          over ? 'border-blue-500 bg-blue-500/5' : 'border-neutral-800'
        }`}
      >
        {cards.map((c) => (
          <KanbanCard key={c.id} card={c} onOpen={onOpen} onDragStart={onDragStart} />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create `KanbanBoard.tsx`**

```typescript
import { useEffect, useRef, useState } from 'react';
import { useKanbanStore } from '../../store/kanban-store';
import { KanbanColumn } from './KanbanColumn';
import { KanbanDrawer } from './KanbanDrawer';
import { COLUMNS } from './kanban-utils';
import type { TaskStatus } from '../../../../shared/kanban-types';
import { Plus, Zap, Archive } from 'lucide-react';

export function KanbanBoard(): React.JSX.Element {
  const { cards, loaded, loadBoard, openTask, openTaskId, setStatus, createTask, nudge } =
    useKanbanStore();
  const [search, setSearch] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState<string>('');
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const draggingId = useRef<string | null>(null);

  useEffect(() => {
    if (!loaded) void loadBoard();
  }, [loaded, loadBoard]);

  const assignees = Array.from(
    new Set(cards.map((c) => c.assignee).filter((a): a is string => !!a))
  ).sort();

  const visible = cards.filter((c) => {
    if (c.status === 'archived' && !showArchived) return false;
    if (assigneeFilter && c.assignee !== assigneeFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!c.title.toLowerCase().includes(q) && !c.id.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const columns = showArchived
    ? [...COLUMNS, { status: 'archived' as TaskStatus, label: 'Archived' }]
    : COLUMNS;

  async function handleCreate(): Promise<void> {
    const title = newTitle.trim();
    if (!title) return;
    await createTask({ title });
    setNewTitle('');
    setCreating(false);
  }

  return (
    <div className="flex h-full w-full flex-col bg-neutral-950 text-neutral-200">
      <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          className="w-48 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs outline-none focus:border-blue-500"
        />
        <select
          value={assigneeFilter}
          onChange={(e) => setAssigneeFilter(e.target.value)}
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs outline-none"
        >
          <option value="">All assignees</option>
          {assignees.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <button
          onClick={() => setShowArchived((v) => !v)}
          className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs ${
            showArchived ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:bg-neutral-800'
          }`}
        >
          <Archive size={12} /> Archived
        </button>
        <div className="flex-1" />
        <button
          onClick={() => void nudge()}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800"
          title="Run a dispatcher tick now"
        >
          <Zap size={12} /> Nudge
        </button>
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500"
        >
          <Plus size={12} /> New Task
        </button>
      </div>

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

      <div className="flex flex-1 gap-3 overflow-x-auto p-3">
        {columns.map((col) => (
          <KanbanColumn
            key={col.status}
            status={col.status}
            label={col.label}
            cards={visible.filter((c) => c.status === col.status)}
            onOpen={(id) => void openTask(id)}
            onDragStart={(id) => {
              draggingId.current = id;
            }}
            onDropCard={(status) => {
              const id = draggingId.current;
              draggingId.current = null;
              if (id) void setStatus(id, status);
            }}
          />
        ))}
      </div>

      {openTaskId && <KanbanDrawer />}
    </div>
  );
}
```
(`KanbanDrawer` is created in Task 10; this import will not resolve until then. Build/typecheck at the end of Task 10.)

- [ ] **Step 5: Verify typecheck:web (expected to fail only on the not-yet-created drawer)**

Run: `npm run typecheck:web`
Expected: the only error references the missing `./KanbanDrawer`. If any OTHER errors appear, fix them now.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/kanban/
git commit -m "feat(kanban): board, columns, cards with drag-and-drop"
```

---

## Task 10: Renderer — card drawer + comment thread

**Files:**
- Create: `src/renderer/src/components/kanban/KanbanDrawer.tsx`
- Create: `src/renderer/src/components/kanban/CommentThread.tsx`

Context: No Sheet/Drawer primitive — implement as a fixed-position right panel (per `PiPlanModal.tsx` idiom). Markdown via `react-markdown` + `remark-gfm` + `rehype-highlight` (see `MarkdownPane.tsx`; wrap in a `markdown-preview` class). Drawer reads from `useKanbanStore().detail`.

- [ ] **Step 1: Create `CommentThread.tsx`**

```typescript
import { useState } from 'react';
import type { TaskComment } from '../../../../shared/kanban-types';
import { relativeTime } from './kanban-utils';

type Props = {
  comments: TaskComment[];
  onPost: (body: string) => void;
};

export function CommentThread({ comments, onPost }: Props): React.JSX.Element {
  const [draft, setDraft] = useState('');
  return (
    <div className="flex flex-col gap-2">
      {comments.length === 0 && (
        <p className="text-xs text-neutral-500">No comments yet.</p>
      )}
      {comments.map((c) => (
        <div key={c.id} className="rounded border border-neutral-800 bg-neutral-900 p-2 text-xs">
          <div className="mb-1 flex items-center gap-2 text-[10px] text-neutral-500">
            <span className="font-medium text-neutral-300">{c.author}</span>
            <span>{relativeTime(c.createdAt)}</span>
          </div>
          <p className="whitespace-pre-wrap text-neutral-200">{c.body}</p>
        </div>
      ))}
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const body = draft.trim();
            if (body) {
              onPost(body);
              setDraft('');
            }
          }
        }}
        placeholder="Comment… (Enter to post, Shift+Enter for newline)"
        rows={2}
        className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs outline-none focus:border-blue-500"
      />
    </div>
  );
}
```

- [ ] **Step 2: Create `KanbanDrawer.tsx`**

```typescript
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { X } from 'lucide-react';
import { useKanbanStore } from '../../store/kanban-store';
import { CommentThread } from './CommentThread';
import { relativeTime, formatDuration } from './kanban-utils';
import type { TaskStatus } from '../../../../shared/kanban-types';

const ACTIONS: { status: TaskStatus; label: string }[] = [
  { status: 'ready', label: '→ Ready' },
  { status: 'blocked', label: 'Block' },
  { status: 'todo', label: 'Unblock' },
  { status: 'done', label: 'Complete' },
  { status: 'archived', label: 'Archive' }
];

export function KanbanDrawer(): React.JSX.Element | null {
  const { detail, closeTask, updateTask, setStatus, addComment, addLink, removeLink } =
    useKanbanStore();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [assignee, setAssignee] = useState('');
  const [priority, setPriority] = useState(0);
  const [tenant, setTenant] = useState('');
  const [linkId, setLinkId] = useState('');

  useEffect(() => {
    if (detail) {
      setTitle(detail.task.title);
      setBody(detail.task.body);
      setAssignee(detail.task.assignee ?? '');
      setPriority(detail.task.priority);
      setTenant(detail.task.tenant ?? '');
    }
  }, [detail]);

  if (!detail) return null;
  const t = detail.task;
  const running = t.status === 'running';

  function save(): void {
    void updateTask(t.id, {
      title,
      body,
      assignee: assignee.trim() === '' ? null : assignee.trim(),
      priority,
      tenant: tenant.trim() === '' ? null : tenant.trim()
    });
  }

  return (
    <div className="fixed right-0 top-0 z-40 flex h-full w-[420px] flex-col border-l border-neutral-800 bg-neutral-900 shadow-2xl">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <span className="font-mono text-xs text-neutral-500">
          {t.id} · {t.status}
        </span>
        <button onClick={closeTask} className="rounded p-1 text-neutral-400 hover:bg-neutral-800">
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-3 text-xs">
        {/* Editable fields */}
        <div className="space-y-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={save}
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm font-medium outline-none focus:border-blue-500"
          />
          <div className="flex gap-2">
            <input
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              onBlur={save}
              placeholder="assignee"
              className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 outline-none focus:border-blue-500"
            />
            <input
              type="number"
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
              onBlur={save}
              title="priority"
              className="w-16 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 outline-none focus:border-blue-500"
            />
            <input
              value={tenant}
              onChange={(e) => setTenant(e.target.value)}
              onBlur={save}
              placeholder="tenant"
              className="w-24 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 outline-none focus:border-blue-500"
            />
          </div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onBlur={save}
            rows={5}
            placeholder="Body (markdown)…"
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 outline-none focus:border-blue-500"
          />
        </div>

        {/* Status actions */}
        <div className="flex flex-wrap gap-1.5">
          {ACTIONS.map((a) => (
            <button
              key={a.label}
              disabled={running}
              onClick={() => void setStatus(t.id, a.status)}
              className="rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {a.label}
            </button>
          ))}
        </div>
        {running && (
          <p className="text-[10px] text-amber-400">
            Running tasks are dispatcher-controlled; status actions are disabled.
          </p>
        )}

        {/* Result / body preview */}
        {t.result && (
          <section>
            <h3 className="mb-1 font-semibold text-neutral-400">Result</h3>
            <div className="markdown-preview rounded border border-neutral-800 bg-neutral-950 p-2">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {t.result}
              </ReactMarkdown>
            </div>
          </section>
        )}

        {/* Dependencies */}
        <section>
          <h3 className="mb-1 font-semibold text-neutral-400">Dependencies</h3>
          {detail.parents.length > 0 && (
            <div className="mb-1">
              <span className="text-[10px] text-neutral-500">Parents: </span>
              {detail.parents.map((p) => (
                <span
                  key={p.id}
                  className="mr-1 inline-flex items-center gap-1 rounded bg-neutral-800 px-1 font-mono text-[10px]"
                >
                  {p.id}
                  <button
                    onClick={() => void removeLink(p.id, t.id)}
                    className="text-neutral-500 hover:text-red-400"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {detail.children.length > 0 && (
            <div className="mb-1">
              <span className="text-[10px] text-neutral-500">Children: </span>
              {detail.children.map((c) => (
                <span
                  key={c.id}
                  className="mr-1 inline-flex items-center gap-1 rounded bg-neutral-800 px-1 font-mono text-[10px]"
                >
                  {c.id} ({c.status})
                  <button
                    onClick={() => void removeLink(t.id, c.id)}
                    className="text-neutral-500 hover:text-red-400"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="mt-1 flex gap-1">
            <input
              value={linkId}
              onChange={(e) => setLinkId(e.target.value)}
              placeholder="child task id"
              className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono outline-none focus:border-blue-500"
            />
            <button
              onClick={() => {
                const id = linkId.trim();
                if (id && id !== t.id) {
                  void addLink(t.id, id);
                  setLinkId('');
                }
              }}
              className="rounded border border-neutral-700 px-2 py-1 hover:bg-neutral-800"
            >
              Add child
            </button>
          </div>
        </section>

        {/* Run history */}
        <section>
          <h3 className="mb-1 font-semibold text-neutral-400">Runs</h3>
          {detail.runs.length === 0 && <p className="text-neutral-500">No runs yet.</p>}
          {detail.runs.map((r) => (
            <div key={r.id} className="mb-1 rounded border border-neutral-800 bg-neutral-950 p-2">
              <div className="flex items-center justify-between text-[10px] text-neutral-500">
                <span>
                  {r.profile ?? 'no-profile'} · {r.outcome ?? r.status}
                </span>
                <span>{formatDuration(r.startedAt, r.endedAt)}</span>
              </div>
              {r.summary && <p className="mt-1 text-neutral-300">{r.summary}</p>}
              {r.error && <p className="mt-1 text-red-400">{r.error}</p>}
            </div>
          ))}
        </section>

        {/* Comments */}
        <section>
          <h3 className="mb-1 font-semibold text-neutral-400">Comments</h3>
          <CommentThread
            comments={detail.comments}
            onPost={(b) => void addComment(t.id, b)}
          />
        </section>

        <p className="text-[10px] text-neutral-600">
          Created {relativeTime(t.createdAt)} · Updated {relativeTime(t.updatedAt)}
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2b: Verify typecheck:web now resolves**

Run: `npm run typecheck:web`
Expected: clean (KanbanBoard's `./KanbanDrawer` import now resolves).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/kanban/
git commit -m "feat(kanban): card drawer with edit, deps, runs, comments"
```

---

## Task 11: Renderer — App.tsx render branch, live subscription, command-palette entry

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/lib/commands.ts`

- [ ] **Step 1: Add the render branch**

In `src/renderer/src/App.tsx`, import the board near the other tab-view imports:
```typescript
import { KanbanBoard } from './components/kanban/KanbanBoard';
```
In the tab render switch (the `tab.type === 'pi' ? (...) :` chain, ~lines 772-778), add a branch before the final `PaneGrid` fallback:
```typescript
                ) : tab.type === 'kanban' ? (
                  <KanbanBoard />
```

- [ ] **Step 2: Add the live event subscription**

In `App.tsx`, near the existing `pi.onOpen` effect (~line 281), add:
```typescript
// Live kanban updates: any task_event → refetch board + open task
useEffect(() => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cleanup = window.fleet.kanban.onEvent(() => {
    if (timer) return; // simple coalescing within a 150ms window
    timer = setTimeout(() => {
      timer = null;
      const s = useKanbanStore.getState();
      void s.loadBoard();
      void s.refreshDetail();
    }, 150);
  });
  return () => {
    if (timer) clearTimeout(timer);
    cleanup();
  };
}, []);
```
Add the import:
```typescript
import { useKanbanStore } from './store/kanban-store';
```

- [ ] **Step 3: Add the command-palette entry**

In `src/renderer/src/lib/commands.ts`, add a command to the array returned by `createCommandRegistry()` (mirror the `new-tab` command shape):
```typescript
    {
      id: 'open-kanban',
      label: 'Open Kanban Board',
      category: 'Tabs',
      execute: () => useWorkspaceStore.getState().addKanbanTab(window.fleet.homeDir)
    },
```

- [ ] **Step 4: Verify typecheck + lint + build**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/lib/commands.ts
git commit -m "feat(kanban): render board tab, live event subscription, command-palette entry"
```

---

## Task 12: Full verification + manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npm rebuild better-sqlite3 >/dev/null 2>&1; npm test`
Expected: all pass (Phase 1's 41 kanban tests + the 3 new store tests + 1 new workspace-store test + the rest of the suite).

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: typecheck passes, electron-vite build succeeds.

- [ ] **Step 3: Manual smoke (document results in the commit or a learnings note)**

Run `npm run dev`, then:
1. Open the command palette → "Open Kanban Board" → a Kanban tab appears.
2. Click **New Task**, enter a title, Create → a card appears in **Todo**.
3. Open the card → drawer opens; edit title/body/assignee/priority, blur → persists (reopen to confirm).
4. Post a comment (Enter) → appears in the thread.
5. Add a child link by id → child chip appears; child-progress pill shows on the parent card.
6. Drag the card from Todo → Ready → it moves; drag onto **Running** → rejected (snaps back).
7. Click **Nudge** with a card in Ready that has an assignee → a run is attempted; since Rune isn't wired headlessly yet (rune#10/#11), expect a `spawn_failed` run in the drawer's Runs section (this is the expected Phase-2 outcome).
8. Confirm the board updates live (the run/status changes appear without manually reloading the tab).

- [ ] **Step 4: If any manual step reveals a bug, write a learnings note**

Per `CLAUDE.md`, document any mistake/fix in `docs/learnings/`.

---

## Deferred to later phases (intentional — not bugs)

- **Assignee dropdown from a worker-profile registry** → Phase 3 (free-text input for now).
- **Live worker log tail** in the drawer → later (no live Rune worker yet).
- **Attachments, ⚗ Decompose / ✨ Specify, board switcher, running-lane grouping** → Phase 5.
- **`fleet kanban` CLI** → Phase 4.
- **Stopping/cancelling a running task from the UI** → later (Running is dispatcher-owned; Phase 2 forbids manual moves involving Running).
- **Optimistic UI / incremental event application** → later; Phase 2 refetches the whole board on each event (coalesced), which is simple and correct at desktop scale.

---

## Self-Review (completed by plan author)

- **Spec coverage:** Board tab ✓ (Task 7/11), columns ✓ (Task 9), card ✓ (Task 9), drag-drop ✓ (Task 9, Running excluded by design), drawer with edit/deps/status-actions/comments/runs ✓ (Task 10), toolbar search/assignee/archived/nudge ✓ (Task 9), live event stream via EventBus-equivalent `onEvent` push ✓ (Task 3/6/11), IPC surface ✓ (Task 4/5/6). Deferred items explicitly listed and mapped to later phases.
- **Type consistency:** `BoardCard`, `TaskDetail`, `UpdateTaskFields` defined in Task 1-3 and consumed identically in IPC (Task 4-6), preload (Task 5), and renderer (Task 8-10). IPC request types (`KanbanUpdateTaskRequest` etc.) defined once in Task 4 and reused in preload + handlers. `window.fleet.kanban.updateTask` takes `{id, fields}` consistently across preload (Task 5) and renderer store (Task 8).
- **No placeholders:** every code step contains complete code; commands include expected output.
