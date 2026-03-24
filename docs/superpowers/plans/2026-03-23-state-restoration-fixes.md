# State Restoration Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four state persistence bugs so Fleet correctly restores active tab/pane, split CWD, workspace switch CWDs, and undo-close CWD on every lifecycle event.

**Architecture:** All changes are surgical edits to existing files — no new files, no new abstractions. The shared `Workspace` type gains two optional fields; workspace-store gains two new imports and uses them in three action handlers; three save-path callers get the new fields; four workspace-switch callers add a pre-switch flush.

**Tech Stack:** Electron + React + TypeScript, Zustand (workspace-store, cwd-store), Vitest for tests.

---

## File Map

| File | What changes |
|------|-------------|
| `src/shared/types.ts` | Add `activeTabId?: string` and `activePaneId?: string` to `Workspace` |
| `src/renderer/src/store/workspace-store.ts` | Add 2 imports; fix `loadWorkspace`, `switchWorkspace`, `splitPane`, `closeTab` |
| `src/renderer/src/store/__tests__/workspace-store.test.ts` | New tests for all four fixes |
| `src/renderer/src/components/Sidebar.tsx` | Autosave adds new fields; `doSwitchWorkspace` and `commitNewWorkspace` flush before switching |
| `src/renderer/src/App.tsx` | `flushWorkspace` closure adds new fields to the active workspace snapshot |
| `src/renderer/src/components/WorkspacePicker.tsx` | `handleSaveCurrent`, `handleSwitchWorkspace`, `commitNewWorkspace` flush before switching |

---

## Task 1: Extend the `Workspace` type

**Files:**
- Modify: `src/shared/types.ts:1-36`

- [ ] **Step 1: Add the two optional fields**

Open `src/shared/types.ts`. The `Workspace` type currently is:
```ts
export type Workspace = {
  id: string;
  label: string;
  tabs: Tab[];
};
```

Change it to:
```ts
export type Workspace = {
  id: string;
  label: string;
  tabs: Tab[];
  activeTabId?: string;
  activePaneId?: string;
};
```

- [ ] **Step 2: Verify no type errors introduced**

```bash
npm run typecheck
```
Expected: passes (the new fields are optional, so all existing `Workspace` literals remain valid).

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat: add activeTabId and activePaneId to Workspace type"
```

---

## Task 2: Fix `loadWorkspace` and `switchWorkspace` to restore active tab/pane

**Files:**
- Modify: `src/renderer/src/store/workspace-store.ts:391-433`
- Test: `src/renderer/src/store/__tests__/workspace-store.test.ts`

The `useWorkspaceStore.setState()` API from Zustand lets tests directly prime store state. The existing tests in this file are the pattern to follow — they use `beforeEach` to reset state and call store actions directly.

- [ ] **Step 1: Write failing tests**

In `src/renderer/src/store/__tests__/workspace-store.test.ts`, add a new `describe` block after the existing ones:

```ts
describe('loadWorkspace — active tab/pane restoration', () => {
  it('restores the persisted activeTabId when it matches a real tab', () => {
    const ws: Workspace = {
      id: 'ws-x',
      label: 'X',
      activeTabId: 'tab-x2',
      tabs: [
        { id: 'tab-x1', label: 'A', labelIsCustom: false, cwd: '/', splitRoot: { type: 'leaf', id: 'pane-x1', cwd: '/' } },
        { id: 'tab-x2', label: 'B', labelIsCustom: false, cwd: '/', splitRoot: { type: 'leaf', id: 'pane-x2', cwd: '/' } },
      ]
    };
    useWorkspaceStore.getState().loadWorkspace(ws);
    expect(useWorkspaceStore.getState().activeTabId).toBe('tab-x2');
  });

  it('falls back to tabs[0] when persisted activeTabId is not found', () => {
    const ws: Workspace = {
      id: 'ws-x',
      label: 'X',
      activeTabId: 'tab-gone',
      tabs: [
        { id: 'tab-x1', label: 'A', labelIsCustom: false, cwd: '/', splitRoot: { type: 'leaf', id: 'pane-x1', cwd: '/' } },
      ]
    };
    useWorkspaceStore.getState().loadWorkspace(ws);
    expect(useWorkspaceStore.getState().activeTabId).toBe('tab-x1');
  });

  it('restores the persisted activePaneId when it is in the active tab', () => {
    const ws: Workspace = {
      id: 'ws-x',
      label: 'X',
      activeTabId: 'tab-x1',
      activePaneId: 'pane-x1',
      tabs: [
        { id: 'tab-x1', label: 'A', labelIsCustom: false, cwd: '/', splitRoot: { type: 'leaf', id: 'pane-x1', cwd: '/' } },
      ]
    };
    useWorkspaceStore.getState().loadWorkspace(ws);
    expect(useWorkspaceStore.getState().activePaneId).toBe('pane-x1');
  });

  it('falls back to first pane when persisted activePaneId is not in active tab', () => {
    const ws: Workspace = {
      id: 'ws-x',
      label: 'X',
      activePaneId: 'pane-gone',
      tabs: [
        { id: 'tab-x1', label: 'A', labelIsCustom: false, cwd: '/', splitRoot: { type: 'leaf', id: 'pane-x1', cwd: '/' } },
      ]
    };
    useWorkspaceStore.getState().loadWorkspace(ws);
    expect(useWorkspaceStore.getState().activePaneId).toBe('pane-x1');
  });
});

describe('switchWorkspace — active tab/pane restoration', () => {
  it('restores persisted activeTabId from in-memory background workspace (non-first tab)', () => {
    // WS_B has only one tab, so tab-b1 would be tabs[0] regardless.
    // Use a multi-tab variant with activeTabId pointing to the SECOND tab so
    // the old code (always picks tabs[0]) will fail this test.
    const wsBMulti: Workspace = {
      id: 'ws-b',
      label: 'Beta',
      activeTabId: 'tab-b2',
      tabs: [
        { id: 'tab-b1', label: 'A', labelIsCustom: false, cwd: '/', splitRoot: { type: 'leaf', id: 'pane-b1', cwd: '/' } },
        { id: 'tab-b2', label: 'B', labelIsCustom: false, cwd: '/', splitRoot: { type: 'leaf', id: 'pane-b2', cwd: '/' } },
      ]
    };
    useWorkspaceStore.setState({ backgroundWorkspaces: new Map([['ws-b', wsBMulti]]) });
    useWorkspaceStore.getState().switchWorkspace(WS_B);
    expect(useWorkspaceStore.getState().activeTabId).toBe('tab-b2');
  });

  it('stashes old workspace with current activeTabId into backgroundWorkspaces', () => {
    useWorkspaceStore.getState().switchWorkspace(WS_B);
    const stashed = useWorkspaceStore.getState().backgroundWorkspaces.get('ws-a');
    expect(stashed?.activeTabId).toBe('tab-a1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- --reporter=verbose 2>&1 | grep -E "(FAIL|PASS|✓|✗|×)" | head -30
```
Expected: the new tests fail (`activeTabId` not yet restored from workspace object).

- [ ] **Step 3: Fix `loadWorkspace` in workspace-store.ts**

Find the `loadWorkspace` action (around line 391). Replace its body:

```ts
loadWorkspace: (workspace) => {
  const migratedTabs = workspace.tabs.map((t) => ({
    ...t,
    labelIsCustom: t.labelIsCustom ?? false
  }));
  const migrated = { ...workspace, tabs: migratedTabs };

  const restoredTab = (migrated.activeTabId
    ? migrated.tabs.find((t) => t.id === migrated.activeTabId)
    : undefined) ?? migrated.tabs[0];

  const paneIds = restoredTab ? collectPaneIds(restoredTab.splitRoot) : [];
  const restoredPane =
    migrated.activePaneId && paneIds.includes(migrated.activePaneId)
      ? migrated.activePaneId
      : paneIds[0] ?? null;

  set({
    workspace: migrated,
    activeTabId: restoredTab?.id ?? null,
    activePaneId: restoredPane,
    isDirty: false
  });
},
```

- [ ] **Step 4: Fix `switchWorkspace` in workspace-store.ts**

Find `switchWorkspace` (around line 408). Replace its body:

```ts
switchWorkspace: (ws) => {
  set((state) => {
    const target = state.backgroundWorkspaces.get(ws.id) ?? ws;
    const migratedTabs = target.tabs.map((t) => ({
      ...t,
      labelIsCustom: t.labelIsCustom ?? false
    }));
    const migrated = { ...target, tabs: migratedTabs };

    const restoredTab = (migrated.activeTabId
      ? migrated.tabs.find((t) => t.id === migrated.activeTabId)
      : undefined) ?? migrated.tabs[0];

    const paneIds = restoredTab ? collectPaneIds(restoredTab.splitRoot) : [];
    const restoredPane =
      migrated.activePaneId && paneIds.includes(migrated.activePaneId)
        ? migrated.activePaneId
        : paneIds[0] ?? null;

    // Stash old workspace with current active tab/pane into background
    const newBackground = new Map(state.backgroundWorkspaces);
    newBackground.set(state.workspace.id, {
      ...state.workspace,
      activeTabId: state.activeTabId ?? undefined,
      activePaneId: state.activePaneId ?? undefined
    });
    newBackground.delete(migrated.id);

    return {
      workspace: migrated,
      backgroundWorkspaces: newBackground,
      activeTabId: restoredTab?.id ?? null,
      activePaneId: restoredPane,
      isDirty: false
    };
  });
},
```

Note: live CWD injection into the stash happens in Task 5 (Fix 3 Part B). This task only adds `activeTabId`/`activePaneId` stashing.

- [ ] **Step 5: Run new tests — verify they pass**

```bash
npm test -- --reporter=verbose 2>&1 | grep -E "(FAIL|PASS|✓|✗|×)" | head -30
```
Expected: all new tests pass; no existing tests broken.

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/store/workspace-store.ts src/renderer/src/store/__tests__/workspace-store.test.ts
git commit -m "fix: restore active tab and pane from persisted workspace state"
```

---

## Task 3: Include activeTabId/activePaneId in all save paths

**Files:**
- Modify: `src/renderer/src/components/Sidebar.tsx` (autosave effect, ~line 257)
- Modify: `src/renderer/src/App.tsx` (flushWorkspace closure, ~line 213)
- Modify: `src/renderer/src/components/WorkspacePicker.tsx` (handleSaveCurrent, ~line 61)

No new tests needed — this is pure save-path wiring. The workspace-store tests from Task 2 already verify the round-trip.

- [ ] **Step 1: Fix Sidebar.tsx autosave**

Find the debounced autosave effect in `Sidebar.tsx` (around line 257). It builds `workspaceWithCwds`. Add the two fields from the store state (note: the effect already calls `useWorkspaceStore.getState()` to read `state`):

```ts
const state = useWorkspaceStore.getState();
const workspaceWithCwds = {
  ...state.workspace,
  activeTabId: state.activeTabId ?? undefined,
  activePaneId: state.activePaneId ?? undefined,
  tabs: state.workspace.tabs.map((tab) => ({
    ...tab,
    splitRoot: injectLiveCwd(tab.splitRoot)
  }))
};
```

- [ ] **Step 2: Fix App.tsx pagehide flush**

Find the `flushWorkspace` closure in `App.tsx` (around line 213). It builds `activeWithContent`. Add the two fields:

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
The background workspace loop below does NOT get these fields — they are meaningless for workspaces not currently active.

- [ ] **Step 3: Fix WorkspacePicker.tsx handleSaveCurrent**

Find `handleSaveCurrent` in `WorkspacePicker.tsx` (around line 61). Add a `useWorkspaceStore.getState()` call to read the transient fields (the reactive `workspace` prop only has the `Workspace` type fields):

```ts
const handleSaveCurrent = async (): Promise<void> => {
  const state = useWorkspaceStore.getState();
  const workspaceWithLiveCwds = {
    ...workspace,
    activeTabId: state.activeTabId ?? undefined,
    activePaneId: state.activePaneId ?? undefined,
    tabs: workspace.tabs.map((tab) => ({
      ...tab,
      splitRoot: injectLiveCwd(tab.splitRoot)
    }))
  };
  await window.fleet.layout.save({ workspace: workspaceWithLiveCwds });
  setMenuOpen(false);
};
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/Sidebar.tsx src/renderer/src/App.tsx src/renderer/src/components/WorkspacePicker.tsx
git commit -m "fix: include activeTabId and activePaneId in all workspace save paths"
```

---

## Task 4: Fix splitPane to use live CWD

**Files:**
- Modify: `src/renderer/src/store/workspace-store.ts` (imports + `splitPane` action, ~line 309)
- Test: `src/renderer/src/store/__tests__/workspace-store.test.ts`

- [ ] **Step 1: Write failing test**

`useCwdStore` is a Zustand store. In the test file, import it and prime it directly, the same way `useWorkspaceStore.setState(...)` works:

```ts
import { useCwdStore } from '../cwd-store';
```

Add inside the test file:

```ts
describe('splitPane — live CWD', () => {
  it('uses the live CWD from cwd-store for the new pane', () => {
    // Prime cwd-store with a different CWD than what's in the tab
    useCwdStore.setState({ cwds: new Map([['pane-a1', '/live/path']]) });

    const newPaneId = useWorkspaceStore.getState().splitPane('pane-a1', 'horizontal');

    // Find the new leaf's CWD via collectPaneLeafs
    const tab = useWorkspaceStore.getState().workspace.tabs[0];
    const leaves = collectPaneLeafs(tab.splitRoot);
    const newLeaf = leaves.find((l) => l.id === newPaneId);
    expect(newLeaf?.cwd).toBe('/live/path');
  });

  it('falls back to tab.cwd when no live CWD in cwd-store', () => {
    useCwdStore.setState({ cwds: new Map() });

    const newPaneId = useWorkspaceStore.getState().splitPane('pane-a1', 'horizontal');

    const tab = useWorkspaceStore.getState().workspace.tabs[0];
    const leaves = collectPaneLeafs(tab.splitRoot);
    const newLeaf = leaves.find((l) => l.id === newPaneId);
    expect(newLeaf?.cwd).toBe('/tmp'); // WS_A's tab cwd
  });
});
```

Also add the import at the top of the test file:
```ts
import { collectPaneLeafs } from '../workspace-store';
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- --reporter=verbose 2>&1 | grep -E "splitPane" | head -10
```
Expected: both new splitPane tests fail (live CWD not yet used).

- [ ] **Step 3: Add imports to workspace-store.ts**

At the top of `src/renderer/src/store/workspace-store.ts`, add two new imports after the existing imports:

```ts
import { useCwdStore } from './cwd-store';
import { injectLiveCwd } from '../lib/workspace-utils';
```

- [ ] **Step 4: Fix splitPane**

Find `splitPane` (around line 309). Change the new leaf creation from:

```ts
const newLeaf = createLeaf(
  get().workspace.tabs.find((t) => collectPaneIds(t.splitRoot).includes(paneId))?.cwd ?? '/'
);
```

To:

```ts
const liveCwd = useCwdStore.getState().cwds.get(paneId);
const tabCwd =
  get().workspace.tabs.find((t) => collectPaneIds(t.splitRoot).includes(paneId))?.cwd ?? '/';
const newLeaf = createLeaf(liveCwd ?? tabCwd);
```

- [ ] **Step 5: Run tests — verify they pass**

```bash
npm test -- --reporter=verbose 2>&1 | grep -E "(FAIL|PASS|splitPane)" | head -20
```

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/store/workspace-store.ts src/renderer/src/store/__tests__/workspace-store.test.ts
git commit -m "fix: split pane inherits live CWD instead of tab's initial CWD"
```

---

## Task 5: Fix workspace switch — inject live CWDs into stash and flush to disk

**Files:**
- Modify: `src/renderer/src/store/workspace-store.ts` (`switchWorkspace`, ~line 408)
- Modify: `src/renderer/src/components/Sidebar.tsx` (`doSwitchWorkspace`, `commitNewWorkspace`)
- Modify: `src/renderer/src/components/WorkspacePicker.tsx` (`handleSwitchWorkspace`, `commitNewWorkspace`)
- Test: `src/renderer/src/store/__tests__/workspace-store.test.ts`

### Part A — Fix in-memory stash (workspace-store.ts)

- [ ] **Step 1: Write failing test for in-memory stash with live CWDs**

```ts
describe('switchWorkspace — stashes live CWDs', () => {
  it('injects live CWDs into the old workspace before stashing', () => {
    // Prime cwd-store with a live CWD for pane-a1
    useCwdStore.setState({ cwds: new Map([['pane-a1', '/live/a1']]) });

    useWorkspaceStore.getState().switchWorkspace(WS_B);

    const stashed = useWorkspaceStore.getState().backgroundWorkspaces.get('ws-a');
    const leaf = stashed?.tabs[0].splitRoot;
    expect(leaf?.type === 'leaf' ? leaf.cwd : null).toBe('/live/a1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- --reporter=verbose 2>&1 | grep -E "stashes live CWDs" | head -5
```

- [ ] **Step 3: Update switchWorkspace to inject live CWDs into stash**

> **Ordering note:** This step modifies `switchWorkspace` in workspace-store.ts. Apply this diff **against the Task 2 result** — not the original file. Task 2 fully rewrote the `switchWorkspace` body; this step only changes the stash block within that rewrite.

In `switchWorkspace` (workspace-store.ts), replace the stash line:

```ts
// OLD:
newBackground.set(state.workspace.id, {
  ...state.workspace,
  activeTabId: state.activeTabId ?? undefined,
  activePaneId: state.activePaneId ?? undefined
});
```

With:

```ts
// NEW:
newBackground.set(state.workspace.id, {
  ...state.workspace,
  activeTabId: state.activeTabId ?? undefined,
  activePaneId: state.activePaneId ?? undefined,
  tabs: state.workspace.tabs.map((tab) => ({
    ...tab,
    splitRoot: injectLiveCwd(tab.splitRoot)
  }))
});
```

(`injectLiveCwd` was imported in Task 4, Step 3.)

- [ ] **Step 4: Run test — verify it passes**

```bash
npm test -- --reporter=verbose 2>&1 | grep -E "(FAIL|PASS|stashes live)" | head -10
```

- [ ] **Step 5: Commit Part A**

```bash
git add src/renderer/src/store/workspace-store.ts src/renderer/src/store/__tests__/workspace-store.test.ts
git commit -m "fix: inject live CWDs into background workspace stash on switch"
```

### Part B — Flush to disk before switching (component call sites)

- [ ] **Step 6: Fix Sidebar.tsx doSwitchWorkspace**

Find `doSwitchWorkspace` in `Sidebar.tsx` (around line 225). It is already `async`. Replace its body entirely:

```ts
const doSwitchWorkspace = useCallback(async (wsId: string) => {
  // Flush current workspace with live CWDs BEFORE any async gap
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

  // Resolve target (in-memory or disk) and switch
  const inMemory = state.backgroundWorkspaces.get(wsId);
  if (inMemory) {
    state.switchWorkspace(inMemory);
  } else {
    const loaded = await window.fleet.layout.load(wsId);
    if (loaded) useWorkspaceStore.getState().switchWorkspace(loaded);
  }

  // Add a default tab if workspace is empty
  setTimeout(() => {
    const s = useWorkspaceStore.getState();
    if (s.workspace.tabs.length === 0) {
      s.addTab(undefined, window.fleet.homeDir);
    }
  }, 0);
}, []);
```

- [ ] **Step 7: Fix Sidebar.tsx commitNewWorkspace**

Find `commitNewWorkspace` in `Sidebar.tsx`. It is currently synchronous. Make it `async` and add the flush before the switch:

```ts
const commitNewWorkspace = useCallback(async () => {
  const name = newWsName.trim();
  setShowNewWsInput(false);
  setNewWsName('');
  if (!name) return;

  // Flush current workspace to disk before switching away
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

  const newWs: Workspace = {
    id: crypto.randomUUID(),
    label: name,
    tabs: []
  };
  useWorkspaceStore.getState().switchWorkspace(newWs);

  // Refresh workspace list immediately (don't wait for autosave)
  void window.fleet.layout.list().then((res) => {
    setSavedWorkspaces(res.workspaces.map((w) => ({ id: w.id, label: w.label })));
  });

  setTimeout(() => {
    useWorkspaceStore.getState().addTab(undefined, window.fleet.homeDir);
  }, 0);
}, [newWsName]);
```

**Required:** the `onKeyDown` and `onBlur` handlers that call `commitNewWorkspace` must be updated to `void commitNewWorkspace()`. TypeScript will error on an unawaited `Promise<void>` in event handlers — this is not optional.

- [ ] **Step 8: Fix WorkspacePicker.tsx handleSwitchWorkspace**

Find `handleSwitchWorkspace` in `WorkspacePicker.tsx` (around line 73). Make it `async` and add a flush before switching:

```ts
const handleSwitchWorkspace = async (ws: Workspace): Promise<void> => {
  // Flush current workspace to disk before switching away
  const storeState = useWorkspaceStore.getState();
  await window.fleet.layout.save({
    workspace: {
      ...storeState.workspace,
      activeTabId: storeState.activeTabId ?? undefined,
      activePaneId: storeState.activePaneId ?? undefined,
      tabs: storeState.workspace.tabs.map((tab) => ({
        ...tab,
        splitRoot: injectLiveCwd(tab.splitRoot)
      }))
    }
  });

  useWorkspaceStore.getState().switchWorkspace(ws);
  setMenuOpen(false);
  // Add a default tab if the workspace is empty
  setTimeout(() => {
    const loaded = useWorkspaceStore.getState();
    if (loaded.workspace.tabs.length === 0) {
      loaded.addTab('Shell', window.fleet.homeDir);
    }
  }, 0);
};
```

`WorkspacePicker.tsx` does not use `useCallback` for this function, so no callback wrapper needs updating. Also add the needed import at the top of the file (check if already present):

```ts
import { injectLiveCwd } from '../lib/workspace-utils';
```

- [ ] **Step 9: Fix WorkspacePicker.tsx commitNewWorkspace**

Find `commitNewWorkspace` (around line 41). Make it `async` and add a flush:

```ts
const commitNewWorkspace = async (): Promise<void> => {
  const name = newName.trim();
  setShowNameInput(false);
  setNewName('');
  if (!name) return;

  // Flush current workspace to disk before switching away
  const storeState = useWorkspaceStore.getState();
  await window.fleet.layout.save({
    workspace: {
      ...storeState.workspace,
      activeTabId: storeState.activeTabId ?? undefined,
      activePaneId: storeState.activePaneId ?? undefined,
      tabs: storeState.workspace.tabs.map((tab) => ({
        ...tab,
        splitRoot: injectLiveCwd(tab.splitRoot)
      }))
    }
  });

  const newWs: Workspace = {
    id: crypto.randomUUID(),
    label: name,
    tabs: []
  };
  useWorkspaceStore.getState().switchWorkspace(newWs);
  setTimeout(() => {
    useWorkspaceStore.getState().addTab('Shell', window.fleet.homeDir);
  }, 0);
};
```

**Required:** update `onKeyDown` (`Enter` key) and `onBlur` callers to `void commitNewWorkspace()`. TypeScript will error on an unawaited `Promise<void>` in event handler callbacks — these changes are not optional.

- [ ] **Step 10: Typecheck**

```bash
npm run typecheck
```

Fix any TypeScript errors (most likely `void` on unawaited async calls in event handlers).

- [ ] **Step 11: Run all tests**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 12: Commit**

```bash
git add src/renderer/src/components/Sidebar.tsx src/renderer/src/components/WorkspacePicker.tsx
git commit -m "fix: flush workspace to disk before switching workspaces"
```

---

## Task 6: Fix closeTab to inject live CWDs for undo-close

**Files:**
- Modify: `src/renderer/src/store/workspace-store.ts` (`closeTab` action, ~line 223)
- Test: `src/renderer/src/store/__tests__/workspace-store.test.ts`

- [ ] **Step 1: Write failing test**

```ts
describe('closeTab — live CWD for undo', () => {
  it('injects live CWD into lastClosedTab so undo restores at the correct directory', () => {
    // Prime live CWD for pane-a1 (different from the stored /tmp)
    useCwdStore.setState({ cwds: new Map([['pane-a1', '/live/undo-path']]) });

    useWorkspaceStore.getState().closeTab('tab-a1');

    const { lastClosedTab } = useWorkspaceStore.getState();
    const leaf = lastClosedTab?.tab.splitRoot;
    expect(leaf?.type === 'leaf' ? leaf.cwd : null).toBe('/live/undo-path');
  });

  it('keeps original CWD when no live CWD is in cwd-store', () => {
    useCwdStore.setState({ cwds: new Map() });

    useWorkspaceStore.getState().closeTab('tab-a1');

    const { lastClosedTab } = useWorkspaceStore.getState();
    const leaf = lastClosedTab?.tab.splitRoot;
    expect(leaf?.type === 'leaf' ? leaf.cwd : null).toBe('/tmp'); // WS_A tab's original CWD
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- --reporter=verbose 2>&1 | grep -E "closeTab.*live CWD" | head -5
```

- [ ] **Step 3: Fix closeTab in workspace-store.ts**

Find the `closeTab` action (around line 223). The current code has:
```ts
const tabIndex = state.workspace.tabs.findIndex((t) => t.id === tabId);
const closedTab = state.workspace.tabs[tabIndex];
```

Rename the variable and inject CWDs:
```ts
const tabIndex = state.workspace.tabs.findIndex((t) => t.id === tabId);
const rawTab = state.workspace.tabs[tabIndex];
// Inject live CWDs so undo-close restores the PTY at the correct directory
const closedTab = rawTab
  ? { ...rawTab, splitRoot: injectLiveCwd(rawTab.splitRoot) }
  : rawTab;
```

All remaining references to `closedTab` in the action body are unchanged — they now operate on the CWD-injected version.

(`injectLiveCwd` was imported in Task 4, Step 3.)

- [ ] **Step 4: Run tests — verify they pass**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/store/workspace-store.ts src/renderer/src/store/__tests__/workspace-store.test.ts
git commit -m "fix: inject live CWDs into closed tab so undo-close restores at correct directory"
```

---

## Task 7: Final verification

- [ ] **Step 1: Run full test suite**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 2: Run typecheck and lint**

```bash
npm run typecheck && npm run lint
```
Expected: no errors.

- [ ] **Step 3: Manual smoke test**

Launch the app in dev mode and verify:
1. Open two tabs, navigate to different directories in each, switch to the second tab, quit — reopen and confirm the second tab is restored as active
2. Open a terminal, `cd /tmp`, split the pane horizontally — confirm the new pane opens in `/tmp` not the original tab CWD
3. Open two workspaces, `cd` in one, switch workspaces — switch back and confirm the CWD was preserved
4. Open a tab, run some commands, close it, immediately undo — confirm the restored terminal is in the right directory
