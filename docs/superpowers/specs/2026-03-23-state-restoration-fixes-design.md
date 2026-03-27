# State Restoration Fixes — Design Spec

**Date:** 2026-03-23
**Status:** Approved

## Overview

Four bugs in Fleet's state persistence and restoration, fixed with minimal surgical changes. No architectural changes.

---

## Fix 1 — Active tab and pane persistence

### Problem

`activeTabId` and `activePaneId` are transient Zustand state — not part of the `Workspace` type — so they are never persisted. Every launch restores to `tabs[0]` and `panes[0]` regardless of what was active when the app closed.

### Design

**`shared/types.ts`** — add two optional fields to `Workspace`:

```ts
export type Workspace = {
  id: string;
  label: string;
  tabs: Tab[];
  activeTabId?: string; // NEW
  activePaneId?: string; // NEW
};
```

**`layout-store.ts` (main process)** — uses `electron-store` which serializes arbitrary JSON. No schema validation strips unknown fields. No change needed; the new optional fields round-trip correctly.

**Save paths** — three places build a workspace snapshot before calling `layout.save`. All three need `activeTabId` and `activePaneId` from the current store state:

1. **Sidebar.tsx debounced autosave** — reads `useWorkspaceStore.getState()`, already builds `workspaceWithCwds`. Add fields:

```ts
const state = useWorkspaceStore.getState();
const workspaceWithCwds = {
  ...state.workspace,
  activeTabId: state.activeTabId ?? undefined,
  activePaneId: state.activePaneId ?? undefined,
  tabs: state.workspace.tabs.map(...)
};
```

2. **App.tsx `pagehide` / `visibilitychange` flush** — the `flushWorkspace` closure builds `activeWithContent`. Add the two fields:

```ts
const activeWithContent = {
  ...state.workspace,
  activeTabId: state.activeTabId ?? undefined,
  activePaneId: state.activePaneId ?? undefined,
  tabs: state.workspace.tabs.map((tab) => ({
    ...tab,
    splitRoot: injectLiveCwd(tab.splitRoot)
  }))
};
```

Background workspaces in the loop do not need `activeTabId`/`activePaneId` since those are only meaningful for the foreground workspace.

3. **WorkspacePicker.tsx `handleSaveCurrent`** — currently spreads `...workspace` (only the `Workspace` type fields). Must also include the store's transient fields. Note: `WorkspacePicker.commitNewWorkspace` does not call `handleSaveCurrent`; its pre-switch flush is handled by Fix 3 Part A, which includes these fields.

```ts
const state = useWorkspaceStore.getState();
const workspaceWithLiveCwds = {
  ...workspace,
  activeTabId: state.activeTabId ?? undefined,
  activePaneId: state.activePaneId ?? undefined,
  tabs: workspace.tabs.map(...)
};
```

**Restore paths** — both `loadWorkspace` and `switchWorkspace` in workspace-store need updating.

In `loadWorkspace`, the incoming `workspace` parameter comes directly from disk, so reading `workspace.activeTabId` / `workspace.activePaneId` is correct:

```ts
const migratedTabs = workspace.tabs.map((t) => ({ ...t, labelIsCustom: t.labelIsCustom ?? false }));
const migrated = { ...workspace, tabs: migratedTabs };

const restoredTab =
  (migrated.activeTabId ? migrated.tabs.find((t) => t.id === migrated.activeTabId) : undefined) ??
  migrated.tabs[0];

const paneIds = restoredTab ? collectPaneIds(restoredTab.splitRoot) : [];
const restoredPane =
  migrated.activePaneId && paneIds.includes(migrated.activePaneId)
    ? migrated.activePaneId
    : (paneIds[0] ?? null);

set({
  workspace: migrated,
  activeTabId: restoredTab?.id ?? null,
  activePaneId: restoredPane,
  isDirty: false
});
```

In `switchWorkspace`, the active workspace is resolved as `target = state.backgroundWorkspaces.get(ws.id) ?? ws` (in-memory takes precedence over the disk argument). Read active tab/pane from `migrated` (the merged result), not from the raw `ws` argument:

```ts
const target = state.backgroundWorkspaces.get(ws.id) ?? ws;
const migratedTabs = target.tabs.map((t) => ({ ...t, labelIsCustom: t.labelIsCustom ?? false }));
const migrated = { ...target, tabs: migratedTabs };

const restoredTab =
  (migrated.activeTabId ? migrated.tabs.find((t) => t.id === migrated.activeTabId) : undefined) ??
  migrated.tabs[0];

const paneIds = restoredTab ? collectPaneIds(restoredTab.splitRoot) : [];
const restoredPane =
  migrated.activePaneId && paneIds.includes(migrated.activePaneId)
    ? migrated.activePaneId
    : (paneIds[0] ?? null);
```

(`collectPaneIds` is already defined in workspace-store.ts; no new import needed.)

**Files changed:** `shared/types.ts`, `renderer/src/store/workspace-store.ts`, `renderer/src/components/Sidebar.tsx`, `renderer/src/App.tsx`, `renderer/src/components/WorkspacePicker.tsx`

---

## Fix 2 — Split pane inherits live CWD

### Problem

`splitPane()` creates the new leaf with `tab.cwd` (the tab's original creation-time CWD). If the user has `cd`'d elsewhere in the source pane, the split opens in the wrong directory.

### Design

In `splitPane()` (workspace-store), look up the live CWD from `cwd-store` before falling back to `tab.cwd`.

**New import required** in workspace-store.ts (`useCwdStore` is not currently imported there):

```ts
import { useCwdStore } from './cwd-store';
```

`cwd-store` maintains `cwds: Map<string, string>`. `removeCwd` exists in the store but is not called from the PTY exit handler, so the pane's CWD is still present in `cwd-store` at split time.

```ts
splitPane: (paneId, direction) => {
  const liveCwd = useCwdStore.getState().cwds.get(paneId);
  const tabCwd = get().workspace.tabs
    .find(t => collectPaneIds(t.splitRoot).includes(paneId))?.cwd ?? '/';
  const newLeaf = createLeaf(liveCwd ?? tabCwd);
  // ...rest unchanged
```

**Files changed:** `renderer/src/store/workspace-store.ts`

---

## Fix 3 — Workspace switch saves current workspace first

### Problem

When switching workspaces, `switchWorkspace()` stashes the current workspace in `backgroundWorkspaces` without injecting live CWDs.

Two distinct failure scenarios:

- **Crash after switch** (fixed by Part A): the old workspace on disk has stale CWDs
- **Switch-back within the same session** (fixed by Part B): the in-memory stash has stale CWDs, and `switchWorkspace` prefers the in-memory version over disk

### Design

**Part A — Flush to disk before switching** (fixes crash scenario)

All four call sites must flush the current workspace to disk before switching:

- `Sidebar.doSwitchWorkspace` — already `async`
- `Sidebar.commitNewWorkspace` — **must be made `async`**
- `WorkspacePicker.handleSwitchWorkspace` — **must be made `async`**
- `WorkspacePicker.commitNewWorkspace` — **must be made `async`**

The `useCallback` wrappers for functions that become async must update accordingly (e.g. `useCallback(async () => { ... }, [...])`).

Flush must happen before any `await` that reads from the store, to avoid state captured across an async gap. In `Sidebar.doSwitchWorkspace`, the flush goes at the very top — before the in-memory check and before the disk-load `await`:

```ts
const doSwitchWorkspace = useCallback(async (wsId: string) => {
  // 1. Flush current workspace FIRST — capture state before any async gap
  const state = useWorkspaceStore.getState();
  await window.fleet.layout.save({
    workspace: {
      ...state.workspace,
      activeTabId: state.activeTabId ?? undefined,
      activePaneId: state.activePaneId ?? undefined,
      tabs: state.workspace.tabs.map((tab) => ({
        ...tab,
        splitRoot: injectLiveCwd(tab.splitRoot)
      }))
    }
  });

  // 2. Resolve target (in-memory or disk) and switch
  const inMemory = state.backgroundWorkspaces.get(wsId);
  if (inMemory) {
    state.switchWorkspace(inMemory);
  } else {
    const loaded = await window.fleet.layout.load(wsId);
    if (loaded) useWorkspaceStore.getState().switchWorkspace(loaded);
  }
  // ...add default tab if workspace empty, unchanged
}, []);
```

The same flush-first pattern applies to the other three call sites (simpler, no two-branch structure).

**Part B — Inject live CWDs into the in-memory stash** (fixes within-session switch-back)

In `switchWorkspace()` (workspace-store), inject live CWDs and active state into the old workspace before storing in `backgroundWorkspaces`.

Two **new imports** required in workspace-store.ts (neither is currently imported):

```ts
import { useCwdStore } from './cwd-store'; // shared with Fix 2
import { injectLiveCwd } from '../lib/workspace-utils';
```

```ts
const oldWithCwds = {
  ...state.workspace,
  activeTabId: state.activeTabId ?? undefined,
  activePaneId: state.activePaneId ?? undefined,
  tabs: state.workspace.tabs.map((tab) => ({
    ...tab,
    splitRoot: injectLiveCwd(tab.splitRoot)
  }))
};
newBackground.set(state.workspace.id, oldWithCwds);
```

`injectLiveCwd` already exists in `renderer/src/lib/workspace-utils.ts` — no changes needed there.

**Files changed:** `renderer/src/store/workspace-store.ts`, `renderer/src/components/Sidebar.tsx`, `renderer/src/components/WorkspacePicker.tsx`

---

## Fix 4 — Undo-close restores at live CWD

### Problem

`closeTab()` stores `lastClosedTab.tab` with `splitRoot` CWDs from the last autosave. When undo is triggered, the restored PTY spawns at a stale directory.

### Design

In `closeTab()` (workspace-store), inject live CWDs into the closing tab's `splitRoot` before storing as `lastClosedTab`. The existing code uses `closedTab` as the variable name for the found tab — rename it to `rawTab` and create `closedTab` as the CWD-injected version:

```ts
closeTab: (tabId, serializedPanes) => {
  set((state) => {
    const tabIndex = state.workspace.tabs.findIndex(t => t.id === tabId);
    const rawTab = state.workspace.tabs[tabIndex];          // renamed from closedTab
    // Inject live CWDs so undo restores the PTY at the correct directory
    const closedTab = rawTab
      ? { ...rawTab, splitRoot: injectLiveCwd(rawTab.splitRoot) }
      : rawTab;
    const tabs = state.workspace.tabs.filter(t => t.id !== tabId);
    // ... rest of closeTab uses closedTab (now CWD-injected) unchanged
```

**Safety:** `removeCwd` exists in cwd-store but is never called from the PTY exit handler. The pane's CWD entry is therefore still present in `cwd-store` when `closeTab` is called, whether triggered by user action or PTY exit.

This requires the `injectLiveCwd` import already added for Fix 3 Part B.

This fix applies automatically to all close paths (sidebar button, right-click, PTY exit) — no changes needed at call sites.

**Files changed:** `renderer/src/store/workspace-store.ts`

---

## Import summary for workspace-store.ts

Two new imports are needed (neither currently exists in the file):

```ts
import { useCwdStore } from './cwd-store';
import { injectLiveCwd } from '../lib/workspace-utils';
```

---

## What is not changing

- Terminal scrollback is not persisted across restarts (by design — only undo-close carries scrollback)
- Background workspace autosave: background PTYs only save CWD drift on `pagehide`. Acceptable because on a crash all PTYs are dead.
- Split resize ratios: persisted correctly via the existing `isDirty` → autosave path
- File/image tab path validation on restore: out of scope
- `workspace-utils.ts`: no changes needed
- `layout-store.ts`: no changes needed (electron-store round-trips arbitrary JSON fields)
