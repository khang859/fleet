# Kanban Phase 7 — Notifications & Attention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface kanban worker/scheduler events the user needs to act on, via a native OS notification and an unread-count badge on the Kanban tab.

**Architecture:** A pure classifier (`classifyKanbanEvent`) is the single source of truth shared by both surfaces. The main process taps the existing single `KanbanStore.onEvent` chokepoint and drives a testable `KanbanNotifier` (coalescing + click-to-deep-link). The renderer consumes the existing `KANBAN_EVENT` push to maintain a global unread badge, and handles a new `KANBAN_FOCUS_TASK` deep-link IPC.

**Tech Stack:** Electron (main `Notification`), React + zustand (renderer), TypeScript, electron-store (settings), vitest.

**Verification commands:** `npm run typecheck` (node + web), `npm run lint`, tests via `npx vitest run <file>`. The full lint baseline has many pre-existing failures in untouched files — only require that *changed/new* files are clean. `npm run build` does typecheck + electron-vite (no lint).

**Spec:** `docs/superpowers/specs/2026-05-31-kanban-phase7-notifications-design.md`

---

## File Structure

**Created:**
- `src/shared/kanban-notifications.ts` — `KanbanNotifyCategory` type, category list, `classifyKanbanEvent(kind)`, `kanbanNotifyChannel(kind, settings, channel)`. Pure; no Electron/DB/React deps.
- `src/shared/__tests__/kanban-notifications.test.ts` — classifier + channel-gate tests.
- `src/main/kanban/kanban-notifier.ts` — `KanbanNotifier` class: buffers notify-worthy events, coalesces within a batch window, builds single vs burst notification payloads, calls an injected `present` callback. Fully unit-testable.
- `src/main/__tests__/kanban-notifier.test.ts` — settings gate, coalescing, null-task skip, single vs burst body + click payload.

**Modified:**
- `src/shared/types.ts` — add `notifications` to `KanbanSettings`.
- `src/shared/constants.ts` — default `kanban.notifications` (all `{ os: true, badge: true }`).
- `src/main/settings-store.ts` — merge `kanban.notifications` in `get()` and `set()`.
- `src/shared/ipc-channels.ts` — add `KANBAN_FOCUS_TASK`.
- `src/preload/index.ts` — expose `kanban.onKanbanFocusTask`.
- `src/main/index.ts` — instantiate `KanbanNotifier`, call `enqueue` from `onEvent`, implement `present` (OS notification + click → focus + `KANBAN_FOCUS_TASK`).
- `src/renderer/src/store/kanban-store.ts` — `unreadCount`, `incrementUnread()`, `markSeen()`.
- `src/renderer/src/hooks/useKanbanAttention.ts` (created) — subscribes to `onEvent` (badge bump) + `onKanbanFocusTask` (deep-link), and clears unread when the Kanban tab becomes active. Mounted once in `App`.
- `src/renderer/src/App.tsx` — mount `useKanbanAttention()`.
- `src/renderer/src/components/TabItem.tsx` — add `countBadge?: number` prop + numeric pill.
- `src/renderer/src/components/Sidebar.tsx` — pass `countBadge` for the kanban tab.
- `src/renderer/src/components/settings/kanban/KanbanSection.tsx` — Notifications subsection (per-category badge/OS toggles).

---

## Task 1: Shared classifier + channel gate

**Files:**
- Create: `src/shared/kanban-notifications.ts`
- Test: `src/shared/__tests__/kanban-notifications.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/__tests__/kanban-notifications.test.ts
import { describe, it, expect } from 'vitest';
import {
  classifyKanbanEvent,
  kanbanNotifyChannel,
  KANBAN_NOTIFY_CATEGORIES
} from '../kanban-notifications';

describe('classifyKanbanEvent', () => {
  it('maps source kinds to categories', () => {
    expect(classifyKanbanEvent('blocked')).toBe('blocked');
    expect(classifyKanbanEvent('gave_up')).toBe('failed');
    expect(classifyKanbanEvent('spawn_failed')).toBe('failed');
    expect(classifyKanbanEvent('completed')).toBe('completed');
    expect(classifyKanbanEvent('schedule_fired')).toBe('scheduleFired');
  });

  it('returns null for non-attention kinds', () => {
    for (const kind of ['comment', 'heartbeat', 'promoted', 'task_created', 'spawned', 'reclaimed']) {
      expect(classifyKanbanEvent(kind)).toBeNull();
    }
  });

  it('exposes all four categories', () => {
    expect([...KANBAN_NOTIFY_CATEGORIES].sort()).toEqual(
      ['blocked', 'completed', 'failed', 'scheduleFired'].sort()
    );
  });
});

describe('kanbanNotifyChannel', () => {
  const settings = {
    blocked: { os: true, badge: false },
    failed: { os: false, badge: true },
    completed: { os: true, badge: true },
    scheduleFired: { os: false, badge: false }
  };

  it('returns the channel flag for the classified category', () => {
    expect(kanbanNotifyChannel('blocked', settings, 'os')).toBe(true);
    expect(kanbanNotifyChannel('blocked', settings, 'badge')).toBe(false);
    expect(kanbanNotifyChannel('gave_up', settings, 'badge')).toBe(true);
    expect(kanbanNotifyChannel('schedule_fired', settings, 'os')).toBe(false);
  });

  it('returns false for unclassified kinds', () => {
    expect(kanbanNotifyChannel('heartbeat', settings, 'os')).toBe(false);
    expect(kanbanNotifyChannel('heartbeat', settings, 'badge')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/__tests__/kanban-notifications.test.ts`
Expected: FAIL — `Cannot find module '../kanban-notifications'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/shared/kanban-notifications.ts

/** Categories an attention-worthy kanban event maps to. Settings + badges key off these. */
export type KanbanNotifyCategory = 'blocked' | 'failed' | 'completed' | 'scheduleFired';

export const KANBAN_NOTIFY_CATEGORIES = [
  'blocked',
  'failed',
  'completed',
  'scheduleFired'
] as const satisfies readonly KanbanNotifyCategory[];

/** Per-category notification toggles, stored under KanbanSettings.notifications. */
export type KanbanNotifySettings = Record<KanbanNotifyCategory, { os: boolean; badge: boolean }>;

/** Maps a raw task_events kind to a notification category, or null if not attention-worthy. */
export function classifyKanbanEvent(kind: string): KanbanNotifyCategory | null {
  switch (kind) {
    case 'blocked':
      return 'blocked';
    case 'gave_up':
    case 'spawn_failed':
      return 'failed';
    case 'completed':
      return 'completed';
    case 'schedule_fired':
      return 'scheduleFired';
    default:
      return null;
  }
}

/** True if this event kind should surface on the given channel per settings. */
export function kanbanNotifyChannel(
  kind: string,
  settings: KanbanNotifySettings,
  channel: 'os' | 'badge'
): boolean {
  const category = classifyKanbanEvent(kind);
  return category != null && settings[category][channel];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/__tests__/kanban-notifications.test.ts`
Expected: PASS (3 + 2 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/shared/kanban-notifications.ts src/shared/__tests__/kanban-notifications.test.ts
git commit -m "feat(kanban): shared notification classifier + channel gate"
```

---

## Task 2: Settings type, defaults, and store merge

**Files:**
- Modify: `src/shared/types.ts` (`KanbanSettings`, around line 139-153)
- Modify: `src/shared/constants.ts` (kanban default, around line 83-92)
- Modify: `src/main/settings-store.ts` (kanban merge, `get()` line 33-42 and `set()` line 61-67)
- Test: `src/main/__tests__/settings-kanban-notifications.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// src/main/__tests__/settings-kanban-notifications.test.ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import { KANBAN_NOTIFY_CATEGORIES } from '../../shared/kanban-notifications';

describe('kanban notification defaults', () => {
  it('defines all four categories defaulting to os+badge on', () => {
    const n = DEFAULT_SETTINGS.kanban.notifications;
    for (const cat of KANBAN_NOTIFY_CATEGORIES) {
      expect(n[cat]).toEqual({ os: true, badge: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/settings-kanban-notifications.test.ts`
Expected: FAIL — `notifications` is undefined on `DEFAULT_SETTINGS.kanban`.

- [ ] **Step 3a: Add the type to `KanbanSettings`**

In `src/shared/types.ts`, add an import near the top (with the other `kanban-types` import on line 2):

```ts
import type { KanbanNotifySettings } from './kanban-notifications';
```

Then add a field to `KanbanSettings` (after `profiles: WorkerProfile[];`, before the closing `}` on line 153):

```ts
  profiles: WorkerProfile[];
  notifications: KanbanNotifySettings;
};
```

- [ ] **Step 3b: Add the default to `constants.ts`**

In `src/shared/constants.ts`, inside the `kanban:` default object, add a `notifications` key after `defaults: { ... }` (line 92):

```ts
    defaults: { workspaceKind: 'scratch', maxRuntimeSeconds: null },
    notifications: {
      blocked: { os: true, badge: true },
      failed: { os: true, badge: true },
      completed: { os: true, badge: true },
      scheduleFired: { os: true, badge: true }
    },
    profiles: [
```

- [ ] **Step 3c: Merge in `settings-store.ts`**

In `get()` (the `kanban:` block, after the `defaults:` merge line 37), add:

```ts
        defaults: { ...DEFAULT_SETTINGS.kanban.defaults, ...saved.kanban?.defaults },
        notifications: {
          ...DEFAULT_SETTINGS.kanban.notifications,
          ...saved.kanban?.notifications
        },
        profiles: (saved.kanban?.profiles ?? DEFAULT_SETTINGS.kanban.profiles).map((p) => ({
```

In `set()` (the `kanban:` block, after the `defaults:` merge line 65), add:

```ts
        defaults: { ...current.kanban.defaults, ...(partial.kanban?.defaults ?? {}) },
        notifications: {
          ...current.kanban.notifications,
          ...(partial.kanban?.notifications ?? {})
        },
        profiles: partial.kanban?.profiles ?? current.kanban.profiles
```

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run src/main/__tests__/settings-kanban-notifications.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/shared/constants.ts src/main/settings-store.ts src/main/__tests__/settings-kanban-notifications.test.ts
git commit -m "feat(kanban): add per-category notification settings"
```

---

## Task 3: KanbanNotifier (coalescing + payload builder)

**Files:**
- Create: `src/main/kanban/kanban-notifier.ts`
- Test: `src/main/__tests__/kanban-notifier.test.ts`

Behavior: `enqueue(event)` classifies, gates on the injected `isOsEnabled(category)`, resolves the task via injected `getTask`, and buffers an item. The first buffered item arms a `batchMs` timer; on fire (or manual `flush()`), it builds one payload and calls the injected `present`. Single item → body `"<Label>: <title>"`, payload `{ boardSlug, taskId }`. Burst → body `"N task updates: <counts>"`, payload `{ boardSlug }` of the highest-priority item (priority blocked > failed > completed > scheduleFired), no `taskId`. Items whose task no longer exists are skipped.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/__tests__/kanban-notifier.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KanbanNotifier } from '../kanban/kanban-notifier';
import type { TaskEvent } from '../../shared/kanban-types';
import type { KanbanNotifyCategory } from '../../shared/kanban-notifications';

function evt(kind: string, taskId = 't1'): TaskEvent {
  return { id: 1, taskId, runId: null, kind, payload: null, createdAt: 0 };
}

describe('KanbanNotifier', () => {
  let present: ReturnType<typeof vi.fn>;
  let tasks: Record<string, { title: string; boardId: string }>;
  let enabled: Record<KanbanNotifyCategory, boolean>;
  let notifier: KanbanNotifier;

  beforeEach(() => {
    vi.useFakeTimers();
    present = vi.fn();
    tasks = {
      t1: { title: 'Fix login', boardId: 'default' },
      t2: { title: 'Write docs', boardId: 'default' }
    };
    enabled = { blocked: true, failed: true, completed: true, scheduleFired: true };
    notifier = new KanbanNotifier({
      isOsEnabled: (c) => enabled[c],
      getTask: (id) => tasks[id] ?? null,
      present,
      batchMs: 500
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires a single notification deep-linking to the task', () => {
    notifier.enqueue(evt('blocked', 't1'));
    vi.advanceTimersByTime(500);
    expect(present).toHaveBeenCalledTimes(1);
    expect(present).toHaveBeenCalledWith({
      body: 'Blocked: Fix login',
      boardSlug: 'default',
      taskId: 't1'
    });
  });

  it('coalesces a burst into one notification with counts and no taskId', () => {
    notifier.enqueue(evt('completed', 't1'));
    notifier.enqueue(evt('completed', 't2'));
    notifier.enqueue(evt('blocked', 't1'));
    vi.advanceTimersByTime(500);
    expect(present).toHaveBeenCalledTimes(1);
    const arg = present.mock.calls[0][0];
    expect(arg.body).toBe('3 task updates: 1 blocked, 2 completed');
    expect(arg.boardSlug).toBe('default');
    expect(arg.taskId).toBeUndefined();
  });

  it('does not fire when the category OS toggle is off', () => {
    enabled.completed = false;
    notifier.enqueue(evt('completed', 't1'));
    vi.advanceTimersByTime(500);
    expect(present).not.toHaveBeenCalled();
  });

  it('ignores non-attention kinds', () => {
    notifier.enqueue(evt('heartbeat', 't1'));
    vi.advanceTimersByTime(500);
    expect(present).not.toHaveBeenCalled();
  });

  it('skips items whose task no longer exists', () => {
    notifier.enqueue(evt('completed', 'gone'));
    vi.advanceTimersByTime(500);
    expect(present).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/kanban-notifier.test.ts`
Expected: FAIL — `Cannot find module '../kanban/kanban-notifier'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/main/kanban/kanban-notifier.ts
import type { TaskEvent } from '../../shared/kanban-types';
import { classifyKanbanEvent, type KanbanNotifyCategory } from '../../shared/kanban-notifications';

export interface KanbanNotificationPayload {
  body: string;
  boardSlug: string;
  taskId?: string;
}

export interface KanbanNotifierDeps {
  /** Whether the category's OS notification toggle is on (read fresh each call). */
  isOsEnabled: (category: KanbanNotifyCategory) => boolean;
  /** Resolve a task's title + board, or null if it no longer exists. */
  getTask: (taskId: string) => { title: string; boardId: string } | null;
  /** Present one (possibly coalesced) notification. */
  present: (payload: KanbanNotificationPayload) => void;
  /** Coalescing window in ms (default 500). */
  batchMs?: number;
}

interface BufferItem {
  category: KanbanNotifyCategory;
  taskId: string;
  boardSlug: string;
  title: string;
}

const LABEL: Record<KanbanNotifyCategory, string> = {
  blocked: 'Blocked',
  failed: 'Failed',
  completed: 'Completed',
  scheduleFired: 'Scheduled'
};

const COUNT_WORD: Record<KanbanNotifyCategory, string> = {
  blocked: 'blocked',
  failed: 'failed',
  completed: 'completed',
  scheduleFired: 'scheduled'
};

// Highest priority first — drives burst click target + count ordering.
const PRIORITY: readonly KanbanNotifyCategory[] = ['blocked', 'failed', 'completed', 'scheduleFired'];

export class KanbanNotifier {
  private buffer: BufferItem[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly batchMs: number;

  constructor(private readonly deps: KanbanNotifierDeps) {
    this.batchMs = deps.batchMs ?? 500;
  }

  enqueue(event: TaskEvent): void {
    const category = classifyKanbanEvent(event.kind);
    if (!category) return;
    if (!this.deps.isOsEnabled(category)) return;
    const task = this.deps.getTask(event.taskId);
    if (!task) return;
    this.buffer.push({
      category,
      taskId: event.taskId,
      boardSlug: task.boardId,
      title: task.title
    });
    this.timer ??= setTimeout(() => this.flush(), this.batchMs);
  }

  /** Build and present one notification from the buffered items. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.buffer;
    this.buffer = [];
    if (batch.length === 0) return;

    if (batch.length === 1) {
      const item = batch[0];
      this.deps.present({
        body: `${LABEL[item.category]}: ${item.title}`,
        boardSlug: item.boardSlug,
        taskId: item.taskId
      });
      return;
    }

    // Burst: count per category in priority order; click target = highest-priority item.
    const parts: string[] = [];
    for (const cat of PRIORITY) {
      const n = batch.filter((b) => b.category === cat).length;
      if (n > 0) parts.push(`${n} ${COUNT_WORD[cat]}`);
    }
    const lead =
      PRIORITY.map((cat) => batch.find((b) => b.category === cat)).find((b) => b != null) ??
      batch[0];
    this.deps.present({
      body: `${batch.length} task updates: ${parts.join(', ')}`,
      boardSlug: lead.boardSlug
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/kanban-notifier.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-notifier.ts src/main/__tests__/kanban-notifier.test.ts
git commit -m "feat(kanban): KanbanNotifier coalescing + payload builder"
```

---

## Task 4: Deep-link IPC channel + preload binding

**Files:**
- Modify: `src/shared/ipc-channels.ts` (after `KANBAN_PREVIEW_SCHEDULE`, line 147)
- Modify: `src/preload/index.ts` (kanban object, near `onEvent` line 470)

- [ ] **Step 1: Add the channel constant**

In `src/shared/ipc-channels.ts`, add after the `KANBAN_PREVIEW_SCHEDULE` line (147):

```ts
  KANBAN_PREVIEW_SCHEDULE: 'kanban:preview-schedule',
  KANBAN_FOCUS_TASK: 'kanban:focus-task'
```

(Adjust the trailing comma: the previous last entry must end with a comma now.)

- [ ] **Step 2: Expose the preload listener**

In `src/preload/index.ts`, inside the `kanban` object right after the `onEvent` binding (line 470-471), add:

```ts
    onEvent: (callback: (event: TaskEvent) => void): Unsubscribe =>
      onChannel<TaskEvent>(IPC_CHANNELS.KANBAN_EVENT, callback),
    onKanbanFocusTask: (
      callback: (payload: { boardSlug: string; taskId?: string }) => void
    ): Unsubscribe =>
      onChannel<{ boardSlug: string; taskId?: string }>(IPC_CHANNELS.KANBAN_FOCUS_TASK, callback),
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (If the preload's exposed API has an explicit interface type that the renderer references, the new method appears on `window.fleet.kanban` automatically via the `typeof` inference used elsewhere; verify Task 7 compiles against it.)

- [ ] **Step 4: Commit**

```bash
git add src/shared/ipc-channels.ts src/preload/index.ts
git commit -m "feat(kanban): add KANBAN_FOCUS_TASK deep-link IPC"
```

---

## Task 5: Wire the notifier into the main process

**Files:**
- Modify: `src/main/index.ts` (kanban bootstrap, around line 750-766; imports at top)

- [ ] **Step 1: Add imports**

Near the other kanban imports in `src/main/index.ts`, add:

```ts
import { KanbanNotifier } from './kanban/kanban-notifier';
```

(`IPC_CHANNELS` is already imported in this file — confirm and reuse it.)

- [ ] **Step 2: Declare the notifier var before store creation**

Immediately before `const KANBAN_HOME = ...` (line 751), add:

```ts
  let kanbanNotifier: KanbanNotifier | null = null;
```

- [ ] **Step 3: Call enqueue from onEvent**

In the `KanbanStore` `onEvent` callback (line 753-759), add the notifier call after the existing forwarding:

```ts
    onEvent: (event) => {
      const w = mainWindow;
      if (w && !w.isDestroyed()) {
        w.webContents.send(IPC_CHANNELS.KANBAN_EVENT, event);
      }
      socketSupervisor?.broadcastKanbanEvent(event);
      kanbanNotifier?.enqueue(event);
    },
```

- [ ] **Step 4: Construct the notifier after the store**

Immediately after the `kanbanStore = new KanbanStore(...)` statement closes (after line 765), add:

```ts
  kanbanNotifier = new KanbanNotifier({
    isOsEnabled: (category) => settingsStore.get().kanban.notifications[category].os,
    getTask: (taskId) => {
      const t = kanbanStore?.getTask(taskId);
      return t ? { title: t.title, boardId: t.boardId } : null;
    },
    present: ({ body, boardSlug, taskId }) => {
      if (!Notification.isSupported()) return;
      const notif = new Notification({ title: 'Fleet — Kanban', body });
      notif.on('click', () => {
        mainWindow?.show();
        mainWindow?.focus();
        mainWindow?.webContents.send(IPC_CHANNELS.KANBAN_FOCUS_TASK, { boardSlug, taskId });
      });
      notif.show();
    }
  });
```

(`Notification` and `settingsStore` are already in scope in this file — `Notification` is imported on line 1, `settingsStore` is the module-level settings instance used by the existing pane-notification handler at line 591.)

- [ ] **Step 5: Verify build**

Run: `npm run typecheck`
Expected: no errors.
Run: `npm run build`
Expected: build succeeds (typecheck + electron-vite).

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(kanban): drive OS notifications from the event chokepoint"
```

---

## Task 6: Renderer kanban store unread state

**Files:**
- Modify: `src/renderer/src/store/kanban-store.ts` (state type + initial state + actions)
- Test: `src/renderer/src/store/__tests__/kanban-unread.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// src/renderer/src/store/__tests__/kanban-unread.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useKanbanStore } from '../kanban-store';

describe('kanban unread badge state', () => {
  beforeEach(() => {
    useKanbanStore.setState({ unreadCount: 0 });
  });

  it('increments and clears', () => {
    useKanbanStore.getState().incrementUnread();
    useKanbanStore.getState().incrementUnread();
    expect(useKanbanStore.getState().unreadCount).toBe(2);
    useKanbanStore.getState().markSeen();
    expect(useKanbanStore.getState().unreadCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/store/__tests__/kanban-unread.test.ts`
Expected: FAIL — `incrementUnread is not a function`.

- [ ] **Step 3: Add state + actions**

In `src/renderer/src/store/kanban-store.ts`, add to the `KanbanState` type (alongside the other fields near line 11-21):

```ts
  unreadCount: number;
  incrementUnread: () => void;
  markSeen: () => void;
```

In the `create<KanbanState>` initializer, add the initial value next to the other initial fields (e.g. after `loaded: false,`):

```ts
  unreadCount: 0,
```

And add the action implementations (anywhere among the action definitions, e.g. after `closeTask`):

```ts
  incrementUnread: () => set((s) => ({ unreadCount: s.unreadCount + 1 })),
  markSeen: () => set({ unreadCount: 0 }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/store/__tests__/kanban-unread.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store/kanban-store.ts src/renderer/src/store/__tests__/kanban-unread.test.ts
git commit -m "feat(kanban): renderer unread-count store state"
```

---

## Task 7: Renderer attention hook (badge bump, clear, deep-link)

**Files:**
- Create: `src/renderer/src/hooks/useKanbanAttention.ts`
- Modify: `src/renderer/src/App.tsx` (call the hook inside `App`)

This hook does three things: (1) on every kanban event, bump unread when the event is badge-worthy AND the Kanban tab is not active; (2) clear unread when the Kanban tab becomes active; (3) on a deep-link IPC, open/activate a Kanban tab, switch board, and open the task drawer. It reads fresh state via `getState()` inside callbacks to avoid stale closures.

- [ ] **Step 1: Write the hook**

```ts
// src/renderer/src/hooks/useKanbanAttention.ts
import { useEffect } from 'react';
import { classifyKanbanEvent } from '../../../shared/kanban-notifications';
import { useKanbanStore } from '../store/kanban-store';
import { useSettingsStore } from '../store/settings-store';
import { useWorkspaceStore } from '../store/workspace-store';

function isKanbanTabActive(): boolean {
  const ws = useWorkspaceStore.getState();
  const active = ws.workspace.tabs.find((t) => t.id === ws.activeTabId);
  return active?.type === 'kanban';
}

/** Wires kanban events to the unread badge + handles notification deep-links. Mount once. */
export function useKanbanAttention(): void {
  // 1 + 2: badge bump on events, clear when the kanban tab is the active tab.
  useEffect(() => {
    const off = window.fleet.kanban.onEvent((event) => {
      const category = classifyKanbanEvent(event.kind);
      if (!category) return;
      const settings = useSettingsStore.getState().settings;
      if (!settings?.kanban.notifications[category].badge) return;
      if (isKanbanTabActive()) return;
      useKanbanStore.getState().incrementUnread();
    });
    return off;
  }, []);

  // Clear unread whenever the active tab becomes a kanban tab.
  useEffect(() => {
    const unsub = useWorkspaceStore.subscribe((state, prev) => {
      if (state.activeTabId === prev.activeTabId) return;
      const active = state.workspace.tabs.find((t) => t.id === state.activeTabId);
      if (active?.type === 'kanban') {
        useKanbanStore.getState().markSeen();
      }
    });
    return unsub;
  }, []);

  // 3: deep-link from a clicked OS notification.
  useEffect(() => {
    const off = window.fleet.kanban.onKanbanFocusTask(({ boardSlug, taskId }) => {
      const ws = useWorkspaceStore.getState();
      const existing = ws.workspace.tabs.find((t) => t.type === 'kanban');
      if (existing) {
        ws.setActiveTab(existing.id);
      } else {
        ws.addKanbanTab('/');
      }
      const kanban = useKanbanStore.getState();
      const applyBoard =
        kanban.activeBoardSlug !== boardSlug
          ? kanban.switchBoard(boardSlug)
          : Promise.resolve();
      void applyBoard.then(() => {
        if (taskId) void useKanbanStore.getState().openTask(taskId);
      });
    });
    return off;
  }, []);
}
```

- [ ] **Step 2: Verify `useWorkspaceStore.subscribe` signature**

Run: `grep -n "subscribe" node_modules/zustand/index.d.ts | head`
Expected: zustand's `subscribe(listener: (state, prevState) => void)` is available (vanilla subscribe). If the store was created without `subscribeWithSelector`, the two-arg `(state, prev)` listener is still valid for the base `subscribe`. If typecheck complains, replace the subscribe block with a manual previous-value capture:

```ts
  useEffect(() => {
    let prevActive = useWorkspaceStore.getState().activeTabId;
    const unsub = useWorkspaceStore.subscribe((state) => {
      if (state.activeTabId === prevActive) return;
      prevActive = state.activeTabId;
      const active = state.workspace.tabs.find((t) => t.id === state.activeTabId);
      if (active?.type === 'kanban') useKanbanStore.getState().markSeen();
    });
    return unsub;
  }, []);
```

- [ ] **Step 3: Mount the hook in App**

In `src/renderer/src/App.tsx`, add the import near the other hook/store imports:

```ts
import { useKanbanAttention } from './hooks/useKanbanAttention';
```

Then call it once inside the `App` component body (near the top, alongside other top-level hooks, e.g. just after the existing `useState`/store hooks around line 86):

```ts
  useKanbanAttention();
```

- [ ] **Step 4: Verify build**

Run: `npm run typecheck`
Expected: no errors. (Confirm `window.fleet.kanban.onKanbanFocusTask` resolves; if the preload API type is hand-written rather than inferred, add the method to that interface.)
Run: `npm run build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/hooks/useKanbanAttention.ts src/renderer/src/App.tsx
git commit -m "feat(kanban): renderer attention hook — badge + deep-link"
```

---

## Task 8: Numeric tab badge

**Files:**
- Modify: `src/renderer/src/components/TabItem.tsx` (props + render)
- Modify: `src/renderer/src/components/Sidebar.tsx` (pass `countBadge` for kanban tab, around line 1192)

- [ ] **Step 1: Add the `countBadge` prop to TabItem**

In `src/renderer/src/components/TabItem.tsx`, add to `TabItemProps` (after `badge: NotificationLevel | null;` line 24):

```ts
  badge: NotificationLevel | null;
  /** Numeric unread count pill (e.g. Kanban tab). Rendered when > 0 and tab inactive. */
  countBadge?: number;
```

Add `countBadge` to the destructured params (after `badge,` line ~86):

```ts
  badge,
  countBadge,
```

Render the pill — add immediately after the existing dot-badge block (after line 232, before the `{icon && ...}` block):

```tsx
          {countBadge != null && countBadge > 0 && !isActive && (
            <span
              className="rounded-full flex-shrink-0 flex items-center justify-center bg-blue-500 text-white text-[10px] font-bold leading-none min-w-[16px] h-4 px-1"
              aria-label={`${countBadge} unread kanban notification${countBadge > 1 ? 's' : ''}`}
            >
              {countBadge > 99 ? '99+' : countBadge}
            </span>
          )}
```

- [ ] **Step 2: Pass the count from Sidebar**

In `src/renderer/src/components/Sidebar.tsx`, add the kanban store import near the other store imports (top of file):

```ts
import { useKanbanStore } from '../store/kanban-store';
```

Inside the `Sidebar` component body (near other store selectors), add:

```ts
  const kanbanUnread = useKanbanStore((s) => s.unreadCount);
```

In the `<TabItem ... />` usage (line 1192), add the prop after `badge={getTabBadge(paneIds)}` (line 1200):

```tsx
                  badge={getTabBadge(paneIds)}
                  countBadge={tab.type === 'kanban' ? kanbanUnread : undefined}
```

- [ ] **Step 3: Verify build**

Run: `npm run typecheck`
Expected: no errors.
Run: `npm run lint -- src/renderer/src/components/TabItem.tsx src/renderer/src/components/Sidebar.tsx`
Expected: no new errors in these files (pre-existing baseline errors elsewhere are acceptable).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/TabItem.tsx src/renderer/src/components/Sidebar.tsx
git commit -m "feat(kanban): numeric unread badge on the Kanban tab"
```

---

## Task 9: Settings UI — kanban notification toggles

**Files:**
- Modify: `src/renderer/src/components/settings/kanban/KanbanSection.tsx` (add a Notifications subsection)

- [ ] **Step 1: Read the file to confirm structure**

The component reads `const { settings, updateSettings } = useSettingsStore();` and renders `<h3>`-headed subsections (Dispatcher line 21, New-task defaults line 115, Worker profiles line 153) inside a wrapping container. Identify `const k = settings.kanban;` (or equivalent) used by existing subsections.

- [ ] **Step 2: Add the Notifications subsection**

Add module-scope constants near the top of `KanbanSection.tsx` (after imports):

```ts
import { KANBAN_NOTIFY_CATEGORIES, type KanbanNotifyCategory } from '../../../../../shared/kanban-notifications';

const KANBAN_NOTIFY_LABELS: Record<KanbanNotifyCategory, string> = {
  blocked: 'Blocked (needs you)',
  failed: 'Failed',
  completed: 'Completed',
  scheduleFired: 'Scheduled fired'
};
```

Add a new subsection in the returned JSX (place it after the "New-task defaults" subsection, before "Worker profiles"). Use `settings.kanban.notifications`:

```tsx
        <div>
          <h3 className="text-sm font-semibold text-neutral-300">Notifications</h3>
          <p className="text-xs text-neutral-500 mb-2">
            Surface worker and scheduler events as an OS notification and an unread badge on the
            Kanban tab.
          </p>
          <div className="grid grid-cols-3 gap-2 text-xs text-neutral-500 mb-1">
            <div>Event</div>
            <div className="text-center">Badge</div>
            <div className="text-center">OS</div>
          </div>
          {KANBAN_NOTIFY_CATEGORIES.map((cat) => (
            <div key={cat} className="grid grid-cols-3 gap-2 items-center">
              <div className="text-sm text-neutral-300">{KANBAN_NOTIFY_LABELS[cat]}</div>
              {(['badge', 'os'] as const).map((channel) => (
                <div key={channel} className="flex justify-center">
                  <input
                    type="checkbox"
                    checked={settings.kanban.notifications[cat][channel]}
                    onChange={(e) => {
                      void updateSettings({
                        kanban: {
                          ...settings.kanban,
                          notifications: {
                            ...settings.kanban.notifications,
                            [cat]: {
                              ...settings.kanban.notifications[cat],
                              [channel]: e.target.checked
                            }
                          }
                        }
                      });
                    }}
                    className="accent-blue-500"
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
```

- [ ] **Step 3: Verify build**

Run: `npm run typecheck`
Expected: no errors.
Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Manual verification checklist**

Build and run the app, then confirm:
- Block a task (or simulate a `blocked`/`completed` event): while on a non-Kanban tab, the Kanban tab shows a numeric badge and an OS notification appears.
- Click the OS notification: Fleet focuses, the Kanban tab opens/activates, the correct board is shown, and the task drawer opens.
- Open the Kanban tab: the badge clears to 0.
- In Settings → Kanban → Notifications, turn off `completed` badge + OS; trigger a completion and confirm no badge/notification for it.
- Trigger several events within ~0.5s and confirm a single coalesced OS notification ("N task updates: …").

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/settings/kanban/KanbanSection.tsx
git commit -m "feat(kanban): notification settings toggles in Kanban settings"
```

---

## Final Review

After all tasks, dispatch a final whole-feature code review covering: the classifier/settings as single source of truth (no drift between main and renderer), correct coalescing + deep-link payloads, badge increment/clear edge cases (event arriving while kanban tab active; multiple kanban tabs), and that no terminal-pane notification behavior changed. Then use superpowers:finishing-a-development-branch.
