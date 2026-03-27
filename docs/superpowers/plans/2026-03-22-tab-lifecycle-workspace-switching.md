# Tab Lifecycle: Preserve Tabs Across Workspace Switching

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tabs and their PTYs are never torn down when the user switches workspaces while the app is active; all workspaces restore on reopen.

**Architecture:** Evolve `useWorkspaceStore` to hold a `backgroundWorkspaces: Map<string, Workspace>` alongside the active `workspace`. Render all workspace tabs simultaneously (active = `display:block`, rest = `display:none`), exactly mirroring the existing tab-within-workspace pattern. No PTY kills on workspace switch — PTYs stay alive, xterm stays mounted. GC extends its allowlist to every pane ID across all loaded workspaces. App close serializes all workspaces; app open loads all saved workspaces.

**Tech Stack:** React, Zustand, xterm.js, TypeScript, Vitest

---

## File Map

| File                                                       | Change                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/renderer/src/store/workspace-store.ts`                | Add `backgroundWorkspaces`, `switchWorkspace`, `loadBackgroundWorkspaces`; extend `getAllPaneIds` |
| `src/renderer/src/App.tsx`                                 | Render all workspace tabs; fix GC, startup, pagehide flush, onExit handler                        |
| `src/renderer/src/components/WorkspacePicker.tsx`          | Remove PTY kill; use `switchWorkspace`                                                            |
| `src/renderer/src/components/Sidebar.tsx`                  | Remove confirm dialog + PTY kill; use `switchWorkspace`                                           |
| `src/renderer/src/store/__tests__/workspace-store.test.ts` | New: multi-workspace state tests                                                                  |

---

## Task 1: Extend workspace-store with multi-workspace state

**Files:**

- Modify: `src/renderer/src/store/workspace-store.ts`

### Background

Currently the store holds one `workspace: Workspace` at a time. `loadWorkspace` replaces it entirely, causing React to unmount all old tab components, destroying xterm instances.

The fix: add `backgroundWorkspaces: Map<string, Workspace>` that holds all non-active workspaces. A new `switchWorkspace(ws)` action moves the current workspace to background and activates the given one (preferring an already-loaded in-memory version over the passed `ws` to avoid using stale disk data when switching back).

### Changes

- [ ] **Step 1: Add `backgroundWorkspaces` to the store type and initial state**

In `WorkspaceStore` type (after `isDirty: boolean;`), add:

```ts
backgroundWorkspaces: Map<string, Workspace>;
```

In the initial state (`create<WorkspaceStore>((set, get) => ({`), add after `isDirty: false,`:

```ts
backgroundWorkspaces: new Map(),
```

- [ ] **Step 2: Add `switchWorkspace` and `loadBackgroundWorkspaces` to the type**

In the `WorkspaceStore` type, in the `// Workspace actions` section, add:

```ts
switchWorkspace: (ws: Workspace) => void;
loadBackgroundWorkspaces: (workspaces: Workspace[]) => void;
```

- [ ] **Step 3: Implement `switchWorkspace`**

Add this action implementation after `loadWorkspace`:

```ts
switchWorkspace: (ws) => {
  set((state) => {
    // Prefer in-memory version if we already have this workspace loaded
    const target = state.backgroundWorkspaces.get(ws.id) ?? ws;
    const migratedTabs = target.tabs.map((t) => ({
      ...t,
      labelIsCustom: t.labelIsCustom ?? false
    }));
    const migrated = { ...target, tabs: migratedTabs };
    const firstTab = migrated.tabs[0];
    const firstPane = firstTab ? collectPaneIds(firstTab.splitRoot)[0] : null;

    // Move current workspace to background; remove target from background
    const newBackground = new Map(state.backgroundWorkspaces);
    newBackground.set(state.workspace.id, state.workspace);
    newBackground.delete(migrated.id);

    return {
      workspace: migrated,
      backgroundWorkspaces: newBackground,
      activeTabId: firstTab?.id ?? null,
      activePaneId: firstPane ?? null,
      isDirty: false
    };
  });
},
```

- [ ] **Step 4: Implement `loadBackgroundWorkspaces`**

Add after `switchWorkspace`:

```ts
loadBackgroundWorkspaces: (workspaces) => {
  set((state) => {
    const newBackground = new Map(state.backgroundWorkspaces);
    for (const ws of workspaces) {
      // Don't overwrite already-loaded background workspaces or the active workspace
      if (!newBackground.has(ws.id) && ws.id !== state.workspace.id) {
        const migratedTabs = ws.tabs.map((t) => ({
          ...t,
          labelIsCustom: t.labelIsCustom ?? false
        }));
        newBackground.set(ws.id, { ...ws, tabs: migratedTabs });
      }
    }
    return { backgroundWorkspaces: newBackground };
  });
},
```

- [ ] **Step 5: Extend `getAllPaneIds` to include background workspaces**

Replace the existing `getAllPaneIds` implementation:

```ts
getAllPaneIds: () => {
  const state = get();
  const active = state.workspace.tabs.flatMap((tab) => collectPaneIds(tab.splitRoot));
  const background = Array.from(state.backgroundWorkspaces.values()).flatMap((ws) =>
    ws.tabs.flatMap((tab) => collectPaneIds(tab.splitRoot))
  );
  return [...active, ...background];
},
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
npm run typecheck
```

Expected: no errors in workspace-store.ts.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/store/workspace-store.ts
git commit -m "feat(store): add backgroundWorkspaces for multi-workspace tab preservation"
```

---

## Task 2: Update App.tsx — render all workspaces, fix GC, startup, flush, onExit

**Files:**

- Modify: `src/renderer/src/App.tsx`

### Changes

- [ ] **Step 1: Subscribe to `backgroundWorkspaces` in the component**

In the `useWorkspaceStore()` destructure at the top of `App()`, add `backgroundWorkspaces`:

```ts
const {
  workspace,
  backgroundWorkspaces,
  activeTabId,
  ...
} = useWorkspaceStore();
```

- [ ] **Step 2: Render background workspace tabs (display:none)**

In the main render area, the existing code renders `workspace.tabs.map(...)`. After that block (but inside the same `workspace.tabs.length > 0` check or as its own fragment), render all background workspace tabs:

Replace the outer condition block in `<main>`:

```tsx
{
  workspace.tabs.length > 0 || backgroundWorkspaces.size > 0 ? (
    <>
      {workspace.tabs.map((tab) => {
        const serializedPanes = restoredPanesRef.current.get(tab.id);
        return (
          <div
            key={tab.id}
            className="h-full w-full"
            style={{ display: tab.id === activeTabId ? 'block' : 'none' }}
          >
            {tab.type === 'star-command' ? (
              <StarCommandTab />
            ) : (
              <PaneGrid
                root={tab.splitRoot}
                activePaneId={tab.id === activeTabId ? activePaneId : null}
                onPaneFocus={(paneId) => {
                  setActivePane(paneId);
                  window.fleet.notifications.paneFocused({ paneId });
                  useNotificationStore.getState().clearPane(paneId);
                }}
                serializedPanes={serializedPanes}
                fontFamily={settings?.general.fontFamily}
                fontSize={settings?.general.fontSize}
              />
            )}
          </div>
        );
      })}
      {Array.from(backgroundWorkspaces.values()).flatMap((bgWs) =>
        bgWs.tabs.map((tab) => (
          <div key={tab.id} className="h-full w-full" style={{ display: 'none' }}>
            {tab.type !== 'star-command' && (
              <PaneGrid
                root={tab.splitRoot}
                activePaneId={null}
                onPaneFocus={() => {}}
                serializedPanes={undefined}
                fontFamily={settings?.general.fontFamily}
                fontSize={settings?.general.fontSize}
              />
            )}
          </div>
        ))
      )}
    </>
  ) : (
    <div className="flex items-center justify-center h-full text-neutral-600">
      No tabs open. Press Cmd+T to create one.
    </div>
  );
}
```

- [ ] **Step 3: Fix pagehide flush to save all workspaces**

Replace the `flushWorkspace` function inside the pagehide `useEffect`:

```ts
const flushWorkspace = (): void => {
  const state = useWorkspaceStore.getState();

  // Save active workspace with serialized content
  const activeWithContent = {
    ...state.workspace,
    tabs: state.workspace.tabs.map((tab) => ({
      ...tab,
      splitRoot: injectLiveCwd(injectSerializedContent(tab.splitRoot))
    }))
  };
  void window.fleet.layout.save({ workspace: activeWithContent });

  // Save background workspaces with serialized content (xterm still mounted)
  for (const bgWs of state.backgroundWorkspaces.values()) {
    const bgWithContent = {
      ...bgWs,
      tabs: bgWs.tabs.map((tab) => ({
        ...tab,
        splitRoot: injectLiveCwd(injectSerializedContent(tab.splitRoot))
      }))
    };
    void window.fleet.layout.save({ workspace: bgWithContent });
  }
};
```

- [ ] **Step 4: Fix startup to load all saved workspaces as background**

Replace the startup `useEffect` (the `initRef` one):

```ts
useEffect(() => {
  if (initRef.current) return;
  initRef.current = true;
  void window.fleet.layout.list().then(({ workspaces }) => {
    const defaultWs = workspaces.find((w) => w.id === 'default');
    const others = workspaces.filter((w) => w.id !== 'default');

    if (defaultWs && defaultWs.tabs.length > 0) {
      useWorkspaceStore.getState().loadWorkspace(defaultWs);
    } else if (workspace.tabs.length === 0) {
      addTab(undefined, window.fleet.homeDir);
    }

    // Load all other saved workspaces into background so their PTYs warm up
    if (others.length > 0) {
      useWorkspaceStore.getState().loadBackgroundWorkspaces(others);
    }
  });
}, []);
```

- [ ] **Step 5: Fix onExit handler to search background workspaces**

Replace the PTY exit `useEffect`:

```ts
useEffect(() => {
  const cleanup = window.fleet.pty.onExit(({ paneId }) => {
    clearCreatedPty(paneId);
    const state = useWorkspaceStore.getState();

    // Search active workspace first, then background workspaces
    let tab = state.workspace.tabs.find((t) => collectPaneIds(t.splitRoot).includes(paneId));
    const isBackground = !tab;
    if (!tab) {
      for (const bgWs of state.backgroundWorkspaces.values()) {
        tab = bgWs.tabs.find((t) => collectPaneIds(t.splitRoot).includes(paneId));
        if (tab) break;
      }
    }
    if (!tab) return;

    // Crew tabs: close silently
    if (tab.type === 'crew') {
      state.closeTab(tab.id);
      return;
    }

    // For background workspace tabs, just close the tab (no undo toast needed)
    if (isBackground) {
      state.closeTab(tab.id);
      return;
    }

    const paneIds = collectPaneIds(tab.splitRoot);
    if (paneIds.length === 1) {
      const serializedPanes = new Map<string, string>();
      for (const id of paneIds) {
        const content = serializePane(id);
        if (content) serializedPanes.set(id, content);
      }
      state.closeTab(tab.id, serializedPanes);
    } else {
      state.closePane(paneId);
    }
  });
  return () => {
    cleanup();
  };
}, []);
```

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat(app): render all workspace tabs simultaneously, fix GC and flush for multi-workspace"
```

---

## Task 3: Update WorkspacePicker — remove PTY kill, use switchWorkspace

**Files:**

- Modify: `src/renderer/src/components/WorkspacePicker.tsx`

### Changes

- [ ] **Step 1: Remove `clearCreatedPty` import (no longer needed)**

Remove `clearCreatedPty` from the import:

```ts
import { serializePane } from '../hooks/use-terminal';
```

(Keep `serializePane` — it's still used for `handleCloseTab`.)

- [ ] **Step 2: Rewrite `handleSwitchWorkspace` — no PTY kill**

Replace:

```ts
const handleSwitchWorkspace = async (ws: Workspace): Promise<void> => {
  // Save current workspace first
  const state = useWorkspaceStore.getState();
  const workspaceWithLiveCwds = {
    ...state.workspace,
    tabs: state.workspace.tabs.map((tab) => ({
      ...tab,
      splitRoot: injectLiveCwd(tab.splitRoot)
    }))
  };
  await window.fleet.layout.save({ workspace: workspaceWithLiveCwds });

  // Kill current PTYs
  const currentPaneIds = state.getAllPaneIds();
  for (const paneId of currentPaneIds) {
    window.fleet.pty.kill(paneId);
    clearCreatedPty(paneId);
  }

  loadWorkspace(ws);
  // Add a default tab if the loaded workspace is empty
  setTimeout(() => {
    const loaded = useWorkspaceStore.getState();
    if (loaded.workspace.tabs.length === 0) {
      loaded.addTab('Shell', window.fleet.homeDir);
    }
  }, 0);
};
```

With:

```ts
const handleSwitchWorkspace = (ws: Workspace): void => {
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

- [ ] **Step 3: Rewrite `commitNewWorkspace` — no PTY kill**

Replace:

```ts
// Kill current PTYs
const currentPaneIds = state.getAllPaneIds();
for (const paneId of currentPaneIds) {
  window.fleet.pty.kill(paneId);
  clearCreatedPty(paneId);
}

// Create fresh workspace
const newWs: Workspace = {
  id: crypto.randomUUID(),
  label: name,
  tabs: []
};
loadWorkspace(newWs);
```

With:

```ts
// Create fresh workspace and switch to it (old workspace moves to background)
const newWs: Workspace = {
  id: crypto.randomUUID(),
  label: name,
  tabs: []
};
useWorkspaceStore.getState().switchWorkspace(newWs);
```

Also remove the `await window.fleet.layout.save(...)` line at the top of `commitNewWorkspace` — the pagehide flush handles persistence, and the autosave in Sidebar handles the active workspace.

**NOTE:** After removing `clearCreatedPty`, remove the `clearCreatedPty` import if it's no longer used. Also check if `injectLiveCwd` is still used (`handleSaveCurrent` uses it) — keep it.

- [ ] **Step 4: Update `handleSwitchWorkspace` call sites**

The `onClick` for saved workspaces in the dropdown currently calls:

```ts
onClick={() => {
  void handleSwitchWorkspace(ws);
  setMenuOpen(false);
}}
```

Since `handleSwitchWorkspace` now calls `setMenuOpen(false)` internally, simplify to:

```ts
onClick={() => handleSwitchWorkspace(ws)}
```

And the `→` button further down in the current-workspace section:

```ts
onClick={() => {
  void handleSwitchWorkspace(ws);
}}
```

→

```ts
onClick={() => handleSwitchWorkspace(ws)}
```

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/WorkspacePicker.tsx
git commit -m "feat(workspace-picker): remove PTY teardown on workspace switch, use switchWorkspace"
```

---

## Task 4: Update Sidebar — remove confirm dialog and PTY kill, use switchWorkspace

**Files:**

- Modify: `src/renderer/src/components/Sidebar.tsx`

### Changes

- [ ] **Step 1: Remove `switchConfirmId` state and related imports**

Remove `clearCreatedPty` from the import line:

```ts
import { serializePane } from '../hooks/use-terminal';
```

Remove the `switchConfirmId` state declaration:

```ts
const [switchConfirmId, setSwitchConfirmId] = useState<string | null>(null);
```

- [ ] **Step 2: Rewrite `doSwitchWorkspace` and `handleSwitchWorkspace`**

Replace both functions:

```ts
const doSwitchWorkspace = useCallback(async (wsId: string) => {
  const state = useWorkspaceStore.getState();
  // Use in-memory version if already loaded (preserves live state)
  const inMemory = state.backgroundWorkspaces.get(wsId);
  if (inMemory) {
    state.switchWorkspace(inMemory);
  } else {
    const loaded = await window.fleet.layout.load(wsId);
    if (loaded) state.switchWorkspace(loaded);
  }
  // Add a default tab if workspace is empty
  setTimeout(() => {
    const s = useWorkspaceStore.getState();
    if (s.workspace.tabs.length === 0) {
      s.addTab(undefined, window.fleet.homeDir);
    }
  }, 0);
}, []);

const handleSwitchWorkspace = useCallback(
  (wsId: string) => {
    void doSwitchWorkspace(wsId);
  },
  [doSwitchWorkspace]
);
```

- [ ] **Step 3: Rewrite `commitNewWorkspace` — no PTY kill**

Replace the "Kill current PTYs" block:

```ts
// Kill current PTYs
const currentPaneIds = state.getAllPaneIds();
for (const paneId of currentPaneIds) {
  window.fleet.pty.kill(paneId);
  clearCreatedPty(paneId);
}

// Create fresh workspace
const newWs: Workspace = {
  id: crypto.randomUUID(),
  label: name,
  tabs: []
};
state.loadWorkspace(newWs);
```

With:

```ts
// Create fresh workspace and switch to it (old workspace moves to background)
const newWs: Workspace = {
  id: crypto.randomUUID(),
  label: name,
  tabs: []
};
state.switchWorkspace(newWs);
```

Also remove the `await window.fleet.layout.save({ workspace: state.workspace })` at the top of `commitNewWorkspace` — leave a comment explaining why it's not needed.

- [ ] **Step 4: Remove the confirm dialog from the render**

Remove the entire confirm-before-switch UI in the saved workspaces list. Replace:

```tsx
{switchConfirmId === ws.id ? (
  <div className="flex flex-col gap-1 px-2 py-2 bg-neutral-800 rounded-md text-xs">
    <span className="text-neutral-300">Switch? All terminals will close.</span>
    <div className="flex gap-2">
      <button ... onClick={() => { void doSwitchWorkspace(ws.id); }}>Yes</button>
      <button ... onClick={() => setSwitchConfirmId(null)}>Cancel</button>
    </div>
  </div>
) : deleteConfirmId === ws.id ? (
```

With just:

```tsx
{deleteConfirmId === ws.id ? (
```

(Remove the entire `switchConfirmId` branch.)

- [ ] **Step 5: Subscribe to `backgroundWorkspaces` for the store**

In the `useWorkspaceStore()` destructure in `Sidebar`, add `backgroundWorkspaces`:

```ts
const { workspace, backgroundWorkspaces, isDirty, ... } = useWorkspaceStore();
```

(Needed so `doSwitchWorkspace` can access it via `state.backgroundWorkspaces`.)

Actually `doSwitchWorkspace` calls `useWorkspaceStore.getState()` directly, so no hook subscription is needed. Skip this step.

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/Sidebar.tsx
git commit -m "feat(sidebar): remove workspace switch confirm dialog and PTY teardown"
```

---

## Task 5: Write tests for multi-workspace store

**Files:**

- Create: `src/renderer/src/store/__tests__/workspace-store.test.ts`

The test environment is Node (see `vitest.config.ts`). `window.fleet` is not available, so only test pure store logic.

- [ ] **Step 1: Create test file with mocks**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkspaceStore } from '../workspace-store';
import type { Workspace } from '../../../../shared/types';

// The store uses crypto.randomUUID() — available in Node 19+ and in jsdom
// Use a fixed workspace so we can assert on IDs

const WS_A: Workspace = {
  id: 'ws-a',
  label: 'Alpha',
  tabs: [
    {
      id: 'tab-a1',
      label: 'Shell',
      labelIsCustom: false,
      cwd: '/tmp',
      splitRoot: { type: 'leaf', id: 'pane-a1', cwd: '/tmp' }
    }
  ]
};

const WS_B: Workspace = {
  id: 'ws-b',
  label: 'Beta',
  tabs: [
    {
      id: 'tab-b1',
      label: 'Shell',
      labelIsCustom: false,
      cwd: '/home',
      splitRoot: { type: 'leaf', id: 'pane-b1', cwd: '/home' }
    }
  ]
};
```

- [ ] **Step 2: Reset store before each test**

```ts
beforeEach(() => {
  useWorkspaceStore.setState({
    workspace: WS_A,
    backgroundWorkspaces: new Map(),
    activeTabId: 'tab-a1',
    activePaneId: 'pane-a1',
    isDirty: false,
    lastClosedTab: null,
    recentFiles: []
  });
});
```

- [ ] **Step 3: Test `switchWorkspace` moves current to background**

```ts
describe('switchWorkspace', () => {
  it('moves active workspace to background and activates the new one', () => {
    useWorkspaceStore.getState().switchWorkspace(WS_B);
    const state = useWorkspaceStore.getState();
    expect(state.workspace.id).toBe('ws-b');
    expect(state.backgroundWorkspaces.has('ws-a')).toBe(true);
    expect(state.backgroundWorkspaces.has('ws-b')).toBe(false);
  });

  it('sets activeTabId and activePaneId to first pane of new workspace', () => {
    useWorkspaceStore.getState().switchWorkspace(WS_B);
    const state = useWorkspaceStore.getState();
    expect(state.activeTabId).toBe('tab-b1');
    expect(state.activePaneId).toBe('pane-b1');
  });

  it('prefers in-memory background workspace over provided ws argument', () => {
    // Pre-load a modified version of WS_B in background
    const modifiedB: Workspace = { ...WS_B, label: 'Beta Modified' };
    useWorkspaceStore.setState({
      backgroundWorkspaces: new Map([['ws-b', modifiedB]])
    });
    useWorkspaceStore.getState().switchWorkspace(WS_B);
    expect(useWorkspaceStore.getState().workspace.label).toBe('Beta Modified');
  });

  it('switching back restores the previously backgrounded workspace', () => {
    useWorkspaceStore.getState().switchWorkspace(WS_B);
    useWorkspaceStore.getState().switchWorkspace(WS_A);
    const state = useWorkspaceStore.getState();
    expect(state.workspace.id).toBe('ws-a');
    expect(state.backgroundWorkspaces.has('ws-b')).toBe(true);
    expect(state.backgroundWorkspaces.has('ws-a')).toBe(false);
  });
});
```

- [ ] **Step 4: Test `loadBackgroundWorkspaces`**

```ts
describe('loadBackgroundWorkspaces', () => {
  it('loads workspaces into background without affecting active workspace', () => {
    useWorkspaceStore.getState().loadBackgroundWorkspaces([WS_B]);
    const state = useWorkspaceStore.getState();
    expect(state.workspace.id).toBe('ws-a');
    expect(state.backgroundWorkspaces.has('ws-b')).toBe(true);
  });

  it('does not overwrite an already-loaded background workspace', () => {
    const modifiedB: Workspace = { ...WS_B, label: 'Already Loaded' };
    useWorkspaceStore.setState({
      backgroundWorkspaces: new Map([['ws-b', modifiedB]])
    });
    useWorkspaceStore.getState().loadBackgroundWorkspaces([WS_B]);
    expect(useWorkspaceStore.getState().backgroundWorkspaces.get('ws-b')?.label).toBe(
      'Already Loaded'
    );
  });

  it('does not load the active workspace as a background workspace', () => {
    useWorkspaceStore.getState().loadBackgroundWorkspaces([WS_A]);
    expect(useWorkspaceStore.getState().backgroundWorkspaces.has('ws-a')).toBe(false);
  });
});
```

- [ ] **Step 5: Test `getAllPaneIds` includes background pane IDs**

```ts
describe('getAllPaneIds', () => {
  it('returns only active pane IDs when no background workspaces', () => {
    const ids = useWorkspaceStore.getState().getAllPaneIds();
    expect(ids).toEqual(['pane-a1']);
  });

  it('includes background workspace pane IDs', () => {
    useWorkspaceStore.getState().loadBackgroundWorkspaces([WS_B]);
    const ids = useWorkspaceStore.getState().getAllPaneIds();
    expect(ids).toContain('pane-a1');
    expect(ids).toContain('pane-b1');
  });

  it('includes all background pane IDs after multiple workspace switches', () => {
    const WS_C: Workspace = {
      id: 'ws-c',
      label: 'Gamma',
      tabs: [
        {
          id: 'tab-c1',
          label: 'Shell',
          labelIsCustom: false,
          cwd: '/',
          splitRoot: { type: 'leaf', id: 'pane-c1', cwd: '/' }
        }
      ]
    };
    useWorkspaceStore.getState().switchWorkspace(WS_B);
    useWorkspaceStore.getState().switchWorkspace(WS_C);
    const ids = useWorkspaceStore.getState().getAllPaneIds();
    expect(ids).toContain('pane-a1'); // ws-a is background
    expect(ids).toContain('pane-b1'); // ws-b is background
    expect(ids).toContain('pane-c1'); // ws-c is active
  });
});
```

- [ ] **Step 6: Run tests**

```bash
npx vitest run src/renderer/src/store/__tests__/workspace-store.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/store/__tests__/workspace-store.test.ts
git commit -m "test(store): add multi-workspace switchWorkspace and getAllPaneIds tests"
```

---

## Task 6: Final verification

- [ ] **Step 1: Run full typecheck**

```bash
npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 2: Run lint**

```bash
npm run lint
```

Expected: 0 errors.

- [ ] **Step 3: Run all tests**

```bash
npx vitest run
```

Expected: all tests pass, no regressions.

- [ ] **Step 4: Commit if anything was fixed**

Only commit if lint/typecheck fixes were needed.

---

## Acceptance Criteria Checklist

- [ ] Switch between workspaces 3+ times — all tabs survive with their state intact (no PTY kill, no xterm dispose)
- [ ] Close and reopen app — all workspace tabs restore correctly (pagehide flush saves all workspaces)
- [ ] No regressions: tab creation, closing, navigation within a workspace still work
- [ ] GC does not kill background workspace PTYs (getAllPaneIds covers all workspaces)
- [ ] PTY exit in background workspace closes the tab correctly (onExit searches background workspaces)
