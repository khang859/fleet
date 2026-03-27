# Extensive Debug Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add dense, fine-grained debug logging across the entire Fleet app (main + renderer) with a unified renderer→main IPC bridge so all logs land in Winston log files.

**Architecture:** Renderer-side `createLogger` mirrors the main process API. In dev mode, logs go to both DevTools console and are batched over IPC to main's Winston for file persistence. In production, all renderer logging is no-op. Main process gets additional debug-level logging in key subsystems.

**Tech Stack:** Winston (existing), Electron IPC, TypeScript, Zustand stores

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/renderer/src/logger.ts` | Renderer logger module with IPC batching |
| Create | `src/renderer/src/__tests__/logger.test.ts` | Tests for renderer logger |
| Modify | `src/shared/ipc-channels.ts` | Add `LOG_BATCH` channel |
| Modify | `src/shared/ipc-api.ts` | Add `LogEntry` type |
| Modify | `src/preload/index.ts` | Expose `log.batch` bridge |
| Modify | `src/renderer/src/env.d.ts` | FleetApi type picks up new `log` property automatically |
| Modify | `src/main/ipc-handlers.ts` | Handle `LOG_BATCH` on main side |
| Modify | `src/renderer/src/store/workspace-store.ts` | Add logging to all store actions |
| Modify | `src/renderer/src/store/cwd-store.ts` | Add logging to setCwd/removeCwd |
| Modify | `src/renderer/src/store/notification-store.ts` | Add logging to setNotification/clearPane |
| Modify | `src/renderer/src/store/settings-store.ts` | Add logging to load/update |
| Modify | `src/renderer/src/components/Sidebar.tsx` | Add logging to drag-and-drop handlers |
| Modify | `src/renderer/src/components/TabItem.tsx` | Add logging to drag events |
| Modify | `src/renderer/src/components/PaneGrid.tsx` | Add logging to resize/layout |
| Modify | `src/renderer/src/hooks/use-terminal.ts` | Add logging to terminal lifecycle |
| Modify | `src/main/pty-manager.ts` | Add more debug logging |
| Modify | `src/main/ipc-handlers.ts` | Add IPC dispatch logging |
| Modify | `src/main/layout-store.ts` | Add logging to save/load |

---

### Task 1: Add LogEntry Type and IPC Channel

**Files:**
- Modify: `src/shared/ipc-api.ts`
- Modify: `src/shared/ipc-channels.ts`

- [ ] **Step 1: Add LogEntry type to ipc-api.ts**

Add at the end of `src/shared/ipc-api.ts`:

```typescript
export interface LogEntry {
  tag: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  meta?: Record<string, unknown>;
  timestamp: string;
}
```

- [ ] **Step 2: Add LOG_BATCH channel to ipc-channels.ts**

Add to the `IPC_CHANNELS` object in `src/shared/ipc-channels.ts`, after the existing entries:

```typescript
LOG_BATCH: 'log:batch'
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — no consumers of these new exports yet.

- [ ] **Step 4: Commit**

```bash
git add src/shared/ipc-api.ts src/shared/ipc-channels.ts
git commit -m "feat(logger): add LogEntry type and LOG_BATCH IPC channel"
```

---

### Task 2: Create Renderer Logger Module

**Files:**
- Create: `src/renderer/src/logger.ts`
- Create: `src/renderer/src/__tests__/logger.test.ts`

- [ ] **Step 1: Write tests for renderer logger**

Create `src/renderer/src/__tests__/logger.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock import.meta.env.DEV — vitest sets it to true by default
// which matches our desired dev behavior

describe('renderer logger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Mock window.fleet.log.batch
    window.fleet = {
      ...window.fleet,
      log: { batch: vi.fn() }
    } as unknown as typeof window.fleet;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('createLogger returns an object with debug/info/warn/error methods', async () => {
    const { createLogger } = await import('../logger');
    const log = createLogger('test:tag');
    expect(typeof log.debug).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
  });

  it('outputs to console in dev mode', async () => {
    const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { createLogger } = await import('../logger');
    const log = createLogger('test:console');
    log.debug('hello', { key: 'value' });
    expect(consoleSpy).toHaveBeenCalled();
    const call = consoleSpy.mock.calls[0];
    expect(call[0]).toContain('[test:console]');
    expect(call[0]).toContain('hello');
    consoleSpy.mockRestore();
  });

  it('batches logs and flushes over IPC after interval', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { createLogger } = await import('../logger');
    const log = createLogger('test:batch');
    log.debug('msg1');
    log.debug('msg2');

    // Not flushed yet
    expect(window.fleet.log.batch).not.toHaveBeenCalled();

    // Advance past flush interval (100ms)
    vi.advanceTimersByTime(100);

    expect(window.fleet.log.batch).toHaveBeenCalledTimes(1);
    const entries = (window.fleet.log.batch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(entries).toHaveLength(2);
    expect(entries[0].tag).toBe('test:batch');
    expect(entries[0].message).toBe('msg1');
    expect(entries[1].message).toBe('msg2');

    vi.spyOn(console, 'debug').mockRestore();
  });

  it('flushes when queue reaches threshold', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { createLogger, FLUSH_SIZE_THRESHOLD } = await import('../logger');
    const log = createLogger('test:threshold');

    for (let i = 0; i < FLUSH_SIZE_THRESHOLD; i++) {
      log.debug(`msg-${i}`);
    }

    // Should have flushed immediately upon hitting threshold
    expect(window.fleet.log.batch).toHaveBeenCalledTimes(1);

    vi.spyOn(console, 'debug').mockRestore();
  });

  it('drops oldest entries when queue overflows', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { createLogger, MAX_QUEUE_SIZE } = await import('../logger');
    const log = createLogger('test:overflow');

    // Fill beyond max without flushing (mock batch to not actually clear)
    // We need to prevent the threshold flush by making threshold > max
    // Actually, threshold flushes will fire. Let's just verify the cap.
    // After MAX_QUEUE_SIZE + 10, earliest entries should be dropped.
    for (let i = 0; i < MAX_QUEUE_SIZE + 10; i++) {
      log.debug(`msg-${i}`);
    }

    // Multiple threshold flushes will have fired
    expect(window.fleet.log.batch).toHaveBeenCalled();

    vi.spyOn(console, 'debug').mockRestore();
    vi.spyOn(console, 'warn').mockRestore();
  });

  it('supports lazy metadata via function argument', async () => {
    const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { createLogger } = await import('../logger');
    const log = createLogger('test:lazy');
    const lazyFn = vi.fn(() => ({ computed: true }));
    log.debug('lazy test', lazyFn);
    expect(lazyFn).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/__tests__/logger.test.ts`
Expected: FAIL — `../logger` module doesn't exist yet.

- [ ] **Step 3: Implement renderer logger**

Create `src/renderer/src/logger.ts`:

```typescript
import type { LogEntry } from '../../../shared/ipc-api';

export const FLUSH_INTERVAL_MS = 100;
export const FLUSH_SIZE_THRESHOLD = 50;
export const MAX_QUEUE_SIZE = 200;

const isDev = import.meta.env.DEV;

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type MetaArg = Record<string, unknown> | (() => Record<string, unknown>);

export interface RendererLogger {
  debug: (message: string, meta?: MetaArg) => void;
  info: (message: string, meta?: MetaArg) => void;
  warn: (message: string, meta?: MetaArg) => void;
  error: (message: string, meta?: MetaArg) => void;
}

const CONSOLE_METHOD: Record<LogLevel, 'debug' | 'info' | 'warn' | 'error'> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error'
};

// --- Batch queue (module-level singleton) ---
let queue: LogEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

function flush(): void {
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  try {
    window.fleet.log.batch(batch);
  } catch {
    // IPC not available (tests, early init) — silently drop
  }
}

function ensureFlushTimer(): void {
  if (flushTimer !== null) return;
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
}

function enqueue(entry: LogEntry): void {
  if (queue.length >= MAX_QUEUE_SIZE) {
    // Drop oldest entries to prevent unbounded growth
    queue.splice(0, queue.length - MAX_QUEUE_SIZE + 1);
  }
  queue.push(entry);
  if (queue.length >= FLUSH_SIZE_THRESHOLD) {
    flush();
  }
}

function resolveMeta(meta?: MetaArg): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  if (typeof meta === 'function') return meta();
  // Shallow copy to prevent mutation after logging
  return { ...meta };
}

// --- No-op logger for production ---
const noop = (): void => {};
const noopLogger: RendererLogger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop
};

function createDevLogger(tag: string): RendererLogger {
  ensureFlushTimer();

  function log(level: LogLevel, message: string, meta?: MetaArg): void {
    const resolved = resolveMeta(meta);
    const timestamp = new Date().toISOString();

    // Console output (human-readable)
    const metaStr = resolved && Object.keys(resolved).length > 0
      ? ` ${JSON.stringify(resolved)}`
      : '';
    console[CONSOLE_METHOD[level]](
      `%c${timestamp.slice(11, 23)} [${tag}] ${level}: ${message}${metaStr}`,
      level === 'error' ? 'color: #f87171' :
      level === 'warn' ? 'color: #fbbf24' :
      level === 'debug' ? 'color: #9ca3af' :
      'color: #60a5fa'
    );

    // Enqueue for IPC batch
    enqueue({ tag, level, message, meta: resolved, timestamp });
  }

  return {
    debug: (message, meta?) => log('debug', message, meta),
    info: (message, meta?) => log('info', message, meta),
    warn: (message, meta?) => log('warn', message, meta),
    error: (message, meta?) => log('error', message, meta)
  };
}

export function createLogger(tag: string): RendererLogger {
  return isDev ? createDevLogger(tag) : noopLogger;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/__tests__/logger.test.ts`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/logger.ts src/renderer/src/__tests__/logger.test.ts
git commit -m "feat(logger): add renderer logger with IPC batching and dev-only output"
```

---

### Task 3: Wire IPC Bridge (Preload + Main Handler)

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/main/ipc-handlers.ts`

- [ ] **Step 1: Add log.batch to preload bridge**

In `src/preload/index.ts`, add the import for `LogEntry`:

```typescript
import type {
  // ... existing imports ...
  LogEntry
} from '../shared/ipc-api';
```

Then add to the `fleetApi` object, before the closing `};`:

```typescript
log: {
  batch: (entries: LogEntry[]): void => ipcRenderer.send(IPC_CHANNELS.LOG_BATCH, entries)
}
```

- [ ] **Step 2: Add LOG_BATCH handler in main ipc-handlers.ts**

In `src/main/ipc-handlers.ts`, add at the top of `registerIpcHandlers()` (after existing imports are used), add the `LogEntry` import:

```typescript
import type {
  // ... existing imports ...
  LogEntry
} from '../shared/ipc-api';
```

Then add the handler inside `registerIpcHandlers()`, after the existing `log` declaration and before the PTY handlers:

```typescript
// Renderer log bridge — receives batched log entries from renderer and writes to Winston
ipcMain.on(IPC_CHANNELS.LOG_BATCH, (_event, entries: LogEntry[]) => {
  for (const entry of entries) {
    const childLog = log.child({ tag: entry.tag });
    const meta = entry.meta ?? {};
    switch (entry.level) {
      case 'debug':
        childLog.debug(entry.message, meta);
        break;
      case 'info':
        childLog.info(entry.message, meta);
        break;
      case 'warn':
        childLog.warn(entry.message, meta);
        break;
      case 'error':
        childLog.error(entry.message, meta);
        break;
    }
  }
});
```

Note: The existing `log` variable in `ipc-handlers.ts` is `createLogger('ipc')`. The renderer bridge creates child loggers from `log` with the renderer-provided tag, so log file entries show the original renderer tag (e.g. `sidebar:dnd`) but are routed through the `ipc` parent.

Actually — to preserve the renderer tag accurately, use the root `logger` import instead:

```typescript
import { logger } from './logger';
```

And in the handler:

```typescript
ipcMain.on(IPC_CHANNELS.LOG_BATCH, (_event, entries: LogEntry[]) => {
  for (const entry of entries) {
    const childLog = logger.child({ tag: entry.tag });
    const meta = entry.meta ?? {};
    childLog[entry.level](entry.message, meta);
  }
});
```

This is cleaner since `childLog[entry.level]` works because `entry.level` is a union of valid Winston method names.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: PASS — no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/preload/index.ts src/main/ipc-handlers.ts
git commit -m "feat(logger): wire renderer→main IPC log bridge"
```

---

### Task 4: Add Debug Logging to Workspace Store

**Files:**
- Modify: `src/renderer/src/store/workspace-store.ts`

- [ ] **Step 1: Add logger import**

At the top of `src/renderer/src/store/workspace-store.ts`, add:

```typescript
import { createLogger } from '../logger';
```

Then after the imports, create loggers:

```typescript
const logTabs = createLogger('sidebar:tabs');
const logLayout = createLogger('layout:state');
```

- [ ] **Step 2: Add logging to tab actions**

Add debug logs to each store action. Here are the specific additions:

In `addTab`:
```typescript
addTab: (label, cwd) => {
  const resolvedLabel = label || cwdBasename(cwd);
  const leaf = createLeaf(cwd);
  const tab: Tab = {
    id: generateId(),
    label: resolvedLabel,
    labelIsCustom: !!label,
    cwd,
    splitRoot: leaf
  };
  logTabs.debug('addTab', { tabId: tab.id, label: resolvedLabel, cwd, paneId: leaf.id });
  set((state) => ({
```

In `closeTab`:
```typescript
closeTab: (tabId, serializedPanes) => {
  logTabs.debug('closeTab', { tabId });
  set((state) => {
```

In `undoCloseTab`:
```typescript
undoCloseTab: () => {
  logTabs.debug('undoCloseTab');
  set((state) => {
```

In `renameTab`:
```typescript
renameTab: (tabId, label) => {
  logTabs.debug('renameTab', { tabId, label });
  set((state) => ({
```

In `setActiveTab`:
```typescript
setActiveTab: (tabId) => {
  logTabs.debug('setActiveTab', { tabId });
  const tab = get().workspace.tabs.find((t) => t.id === tabId);
```

In `reorderTab`:
```typescript
reorderTab: (fromIndex, toIndex) => {
  logTabs.debug('reorderTab', { fromIndex, toIndex, tabCount: get().workspace.tabs.length });
  set((state) => {
    const tabs = [...state.workspace.tabs];
    if (fromIndex < 0 || fromIndex >= tabs.length) return state;
    if (toIndex < 0 || toIndex >= tabs.length) return state;
    if (fromIndex === toIndex) return state;
    const [moved] = tabs.splice(fromIndex, 1);
    tabs.splice(toIndex, 0, moved);
    logTabs.debug('reorderTab result', { movedTabId: moved.id, newOrder: tabs.map(t => t.id) });
    return {
```

In `splitPane`:
```typescript
splitPane: (paneId, direction) => {
  logLayout.debug('splitPane', { paneId, direction });
```

After `set(...)` and before `return newLeaf.id;`:
```typescript
  logLayout.debug('splitPane created', { newPaneId: newLeaf.id });
```

In `closePane`:
```typescript
closePane: (paneId) => {
  logLayout.debug('closePane', { paneId });
  set((state) => {
```

In `loadWorkspace`:
```typescript
loadWorkspace: (workspace) => {
  logLayout.debug('loadWorkspace', { id: workspace.id, label: workspace.label, tabCount: workspace.tabs.length });
```

In `switchWorkspace`:
```typescript
switchWorkspace: (ws) => {
  logLayout.debug('switchWorkspace', { targetId: ws.id, targetLabel: ws.label });
  set((state) => {
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/store/workspace-store.ts
git commit -m "feat(logger): add debug logging to workspace store actions"
```

---

### Task 5: Add Debug Logging to Sidebar Drag-and-Drop

**Files:**
- Modify: `src/renderer/src/components/Sidebar.tsx`
- Modify: `src/renderer/src/components/TabItem.tsx`

- [ ] **Step 1: Add logging to Sidebar.tsx drag handlers**

At the top of `src/renderer/src/components/Sidebar.tsx`, add:

```typescript
import { createLogger } from '../logger';
const logDnd = createLogger('sidebar:dnd');
```

Then update the drag handlers (around line 325):

In `handleDragStart`:
```typescript
const handleDragStart = useCallback((index: number) => {
  logDnd.debug('dragStart', { index, tabId: workspace.tabs[index]?.id });
  setDragIndex(index);
}, [workspace.tabs]);
```

In `handleDragOver`:
```typescript
const handleDragOver = useCallback(
  (e: React.DragEvent, index: number) => {
    if (dragIndex === null) return;
    const target = e.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const rect = target.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const position = e.clientY < midY ? 'above' : 'below';
    logDnd.debug('dragOver', { dragIndex, targetIndex: index, position, clientY: e.clientY, midY: Math.round(midY) });
    setDropTarget({ index, position });
  },
  [dragIndex]
);
```

In `handleDrop`:
```typescript
const handleDrop = useCallback(() => {
  if (dragIndex === null || !dropTarget) {
    logDnd.debug('drop cancelled', { dragIndex, dropTarget });
    return;
  }
  const toIndex = dropTarget.position === 'below' ? dropTarget.index + 1 : dropTarget.index;
  const adjustedTo = dragIndex < toIndex ? toIndex - 1 : toIndex;
  logDnd.debug('drop', {
    dragIndex,
    dropTarget,
    rawToIndex: toIndex,
    adjustedTo,
    willReorder: dragIndex !== adjustedTo
  });
  if (dragIndex !== adjustedTo) {
    reorderTab(dragIndex, adjustedTo);
  }
  setDragIndex(null);
  setDropTarget(null);
}, [dragIndex, dropTarget, reorderTab]);
```

In the `dragend` handler (useEffect around line 355):
```typescript
const handleDragEnd = (): void => {
  logDnd.debug('dragEnd', { hadDragIndex: dragIndex !== null });
  setDragIndex(null);
  setDropTarget(null);
};
```

- [ ] **Step 2: Add logging to TabItem.tsx drag events**

At the top of `src/renderer/src/components/TabItem.tsx`, add:

```typescript
import { createLogger } from '../logger';
const logDnd = createLogger('sidebar:dnd');
```

Update the draggable div's event handlers (around line 148):

```typescript
onDragStart={(e) => {
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(index));
  logDnd.debug('tabItem dragStart', { tabId: id, index, label });
  onDragStart(index);
}}
onDragOver={(e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  onDragOver(e, index);
}}
onDrop={(e) => {
  e.preventDefault();
  logDnd.debug('tabItem drop', { tabId: id, index, label });
  onDrop(index);
}}
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/Sidebar.tsx src/renderer/src/components/TabItem.tsx
git commit -m "feat(logger): add debug logging to sidebar drag-and-drop"
```

---

### Task 6: Add Debug Logging to Remaining Renderer Stores

**Files:**
- Modify: `src/renderer/src/store/cwd-store.ts`
- Modify: `src/renderer/src/store/notification-store.ts`
- Modify: `src/renderer/src/store/settings-store.ts`

- [ ] **Step 1: Add logging to cwd-store.ts**

```typescript
import { create } from 'zustand';
import { createLogger } from '../logger';

const log = createLogger('store:cwd');

type CwdStore = {
  cwds: Map<string, string>;
  setCwd: (paneId: string, cwd: string) => void;
  removeCwd: (paneId: string) => void;
};

export const useCwdStore = create<CwdStore>((set) => ({
  cwds: new Map(),
  setCwd: (paneId, cwd) => {
    log.debug('setCwd', { paneId, cwd });
    set((state) => {
      const next = new Map(state.cwds);
      next.set(paneId, cwd);
      return { cwds: next };
    });
  },
  removeCwd: (paneId) => {
    log.debug('removeCwd', { paneId });
    set((state) => {
      const next = new Map(state.cwds);
      next.delete(paneId);
      return { cwds: next };
    });
  }
}));

export function initCwdListener(): () => void {
  return window.fleet.pty.onCwd(({ paneId, cwd }) => {
    log.debug('onCwd IPC received', { paneId, cwd });
    useCwdStore.getState().setCwd(paneId, cwd);
  });
}
```

- [ ] **Step 2: Add logging to notification-store.ts**

Add at the top after existing imports:

```typescript
import { createLogger } from '../logger';
const log = createLogger('store:notifications');
```

In `setNotification`:
```typescript
setNotification: (record) => {
  log.debug('setNotification', { paneId: record.paneId, level: record.level });
  set((state) => {
```

In `clearPane`:
```typescript
clearPane: (paneId) => {
  log.debug('clearPane', { paneId });
  set((state) => {
```

- [ ] **Step 3: Add logging to settings-store.ts**

Add at the top after existing imports:

```typescript
import { createLogger } from '../logger';
const log = createLogger('store:settings');
```

In `loadSettings`:
```typescript
loadSettings: async () => {
  log.debug('loadSettings');
  const settings = await window.fleet.settings.get();
  log.debug('loadSettings complete', { fontFamily: settings.fontFamily, fontSize: settings.fontSize });
  set({ settings, isLoaded: true });
},
```

In `updateSettings`:
```typescript
updateSettings: async (partial) => {
  log.debug('updateSettings', { keys: Object.keys(partial) });
  await window.fleet.settings.set(partial);
  const settings = await window.fleet.settings.get();
  set({ settings });
},
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store/cwd-store.ts src/renderer/src/store/notification-store.ts src/renderer/src/store/settings-store.ts
git commit -m "feat(logger): add debug logging to cwd, notification, and settings stores"
```

---

### Task 7: Add Debug Logging to Terminal Lifecycle

**Files:**
- Modify: `src/renderer/src/hooks/use-terminal.ts`

- [ ] **Step 1: Add logger import**

At the top of `src/renderer/src/hooks/use-terminal.ts`, add:

```typescript
import { createLogger } from '../logger';
const log = createLogger('terminal:lifecycle');
```

- [ ] **Step 2: Add logging to key terminal events**

Add logging to these locations inside the file. Find each function/callback and add the log line at the top or relevant point:

In `createTerminal()` (around line 44):
```typescript
log.debug('createTerminal', { paneId, cwd });
```

After `term.open(container)` (around line 115):
```typescript
log.debug('xterm mounted', { paneId });
```

In the `registerPaneData` callback (around line 214):
```typescript
log.debug('registerPaneData', { paneId });
```

At the PTY create call (around line 237):
```typescript
log.debug('pty.create', { paneId, cwd });
```

At the PTY attach call (around line 231):
```typescript
log.debug('pty.attach', { paneId, bufferedBytes: result.data.length });
```

In the `debouncedPtyResize` callback (around line 360):
```typescript
log.debug('pty.resize', { paneId, cols, rows });
```

In the cleanup/dispose logic (around line 497):
```typescript
log.debug('terminal dispose', { paneId });
```

In the `fitPreservingScroll` function (around line 276):
```typescript
log.debug('fit', { paneId, cols: term.cols, rows: term.rows });
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/hooks/use-terminal.ts
git commit -m "feat(logger): add debug logging to terminal lifecycle"
```

---

### Task 8: Add Debug Logging to PaneGrid

**Files:**
- Modify: `src/renderer/src/components/PaneGrid.tsx`

- [ ] **Step 1: Add logger import and logging**

At the top of `src/renderer/src/components/PaneGrid.tsx`, add:

```typescript
import { createLogger } from '../logger';
const log = createLogger('layout:panes');
```

Add logging in the resize handle `onMouseDown` handler (around line 214):
```typescript
log.debug('resize start', { splitNodePath });
```

Add logging in the `onMouseMove` handler (around line 229):
```typescript
// Only log on significant ratio changes to avoid flooding
log.debug('resize', { splitNodePath, ratio: Math.round(ratio * 100) / 100 });
```

Actually, `onMouseMove` fires very frequently. Instead, log only on mouse up (resize complete). Find the `onMouseUp` handler and add:
```typescript
log.debug('resize complete', { splitNodePath });
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/PaneGrid.tsx
git commit -m "feat(logger): add debug logging to PaneGrid resize"
```

---

### Task 9: Enhance Main Process Debug Logging

**Files:**
- Modify: `src/main/pty-manager.ts`
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/main/layout-store.ts`

- [ ] **Step 1: Add more debug logging to pty-manager.ts**

The file already has a `log` instance. Add debug logs to these methods:

In `resize()`:
```typescript
resize(paneId: string, cols: number, rows: number): void {
  const entry = this.ptys.get(paneId);
  if (entry) {
    log.debug('resize', { paneId, cols, rows });
    entry.process.resize(cols, rows);
  }
}
```

In `kill()`:
```typescript
kill(paneId: string): void {
  const entry = this.ptys.get(paneId);
  if (entry) {
    log.debug('kill', { paneId, pid: entry.process.pid });
    entry.dataDisposable?.dispose();
```

In `resume()`:
```typescript
resume(paneId: string): void {
  const entry = this.ptys.get(paneId);
  if (entry) {
    log.debug('resume', { paneId });
    entry.paused = false;
```

In the data callback overflow path (around line 98-102):
```typescript
if (entry.outputBuffer.length > BUFFER_OVERFLOW_BYTES) {
  log.debug('backpressure pause', { paneId: opts.paneId, bufferBytes: entry.outputBuffer.length });
  entry.paused = true;
```

In `onExit` callback:
```typescript
entry.exitDisposable = entry.process.onExit(({ exitCode }) => {
  log.debug('exit', { paneId, exitCode, pid: entry.process.pid });
```

- [ ] **Step 2: Add IPC dispatch logging to ipc-handlers.ts**

Add a debug log at the start of every `ipcMain.handle` to trace incoming IPC calls. The most efficient approach: add logging to the high-value PTY and layout handlers. Add these at the top of their respective handlers:

In `PTY_CREATE` handler:
```typescript
log.debug('ipc:pty:create', { paneId: req.paneId, cwd: req.cwd });
```

In `PTY_KILL` handler:
```typescript
log.debug('ipc:pty:kill', { paneId });
```

In `LAYOUT_SAVE` handler:
```typescript
log.debug('ipc:layout:save', { workspaceId: req.workspace.id, tabCount: req.workspace.tabs.length });
```

In `LAYOUT_LOAD` handler:
```typescript
log.debug('ipc:layout:load', { workspaceId });
```

In `LAYOUT_LIST` handler:
```typescript
log.debug('ipc:layout:list');
```

In `LAYOUT_DELETE` handler:
```typescript
log.debug('ipc:layout:delete', { workspaceId });
```

- [ ] **Step 3: Add logging to layout-store.ts**

Add at the top of `src/main/layout-store.ts`:

```typescript
import { createLogger } from './logger';
const log = createLogger('layout:persistence');
```

In `save()`:
```typescript
save(workspace: Workspace): void {
  log.debug('save', { id: workspace.id, label: workspace.label, tabCount: workspace.tabs.length });
  const workspaces = this.store.get('workspaces', {});
```

In `load()`:
```typescript
load(workspaceId: string): Workspace | undefined {
  const workspaces = this.store.get('workspaces', {});
  const ws = workspaces[workspaceId];
  log.debug('load', { workspaceId, found: !!ws, tabCount: ws?.tabs.length });
  return ws;
}
```

In `delete()`:
```typescript
delete(workspaceId: string): void {
  log.debug('delete', { workspaceId });
  const workspaces = this.store.get('workspaces', {});
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/pty-manager.ts src/main/ipc-handlers.ts src/main/layout-store.ts
git commit -m "feat(logger): enhance main process debug logging for PTY, IPC, and layout"
```

---

### Task 10: Final Verification

- [ ] **Step 1: Run full typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: PASS (or only pre-existing warnings)

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: PASS — confirms renderer logger tree-shakes properly and IPC bridge compiles.

- [ ] **Step 5: Manual smoke test**

Start the app with `npm run dev` and:
1. Check terminal output for colored debug logs with tags
2. Open DevTools — verify renderer logs appear with `[tag]` formatting
3. Drag a sidebar tab — verify `sidebar:dnd` logs show in both console and DevTools
4. Check `~/.fleet/logs/fleet-*.log` — verify renderer logs appear alongside main process logs
5. Create/close/split panes — verify `layout:state` and `terminal:lifecycle` logs

- [ ] **Step 6: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "fix(logger): address any issues found during verification"
```
