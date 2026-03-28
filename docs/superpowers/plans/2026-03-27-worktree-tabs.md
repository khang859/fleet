# Worktree Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to create git worktree tabs from terminal tabs, with visual grouping, collapsible group headers, group-aware drag & drop, and full worktree lifecycle management.

**Architecture:** Extend the `Tab` type with optional group fields (`groupId`, `groupRole`, `worktreeBranch`, `worktreePath`). Add a `WorktreeService` in the main process wrapping `simple-git` worktree commands. The Sidebar derives group structure from tab metadata at render time — no separate group data structure. Group collapse state is a `Set<string>` in the workspace store.

**Tech Stack:** TypeScript, Electron IPC, simple-git, Zustand, React, Radix UI context menus, Tailwind CSS.

---

## File Structure

### New files
- `src/main/worktree-service.ts` — Git worktree create/remove/list operations

### Modified files
- `src/shared/types.ts` — Add group fields to `Tab` type
- `src/shared/ipc-channels.ts` — Add `WORKTREE_CREATE`, `WORKTREE_REMOVE` channels
- `src/shared/ipc-api.ts` — Add request/response types for worktree IPC
- `src/preload/index.ts` — Expose `worktree.create()` and `worktree.remove()` to renderer
- `src/main/ipc-handlers.ts` — Register worktree IPC handlers
- `src/renderer/src/store/workspace-store.ts` — Add group actions + `collapsedGroups` state
- `src/renderer/src/components/Sidebar.tsx` — Group header rendering, group-aware drag & drop, confirmation dialog
- `src/renderer/src/components/TabItem.tsx` — Indentation, accent bar, "Create Worktree" context menu item

---

### Task 1: Extend Tab type and add IPC channels

**Files:**
- Modify: `src/shared/types.ts:9-17`
- Modify: `src/shared/ipc-channels.ts:1-103`
- Modify: `src/shared/ipc-api.ts`

- [ ] **Step 1: Add group fields to Tab type**

In `src/shared/types.ts`, add optional fields to the `Tab` type:

```ts
export type Tab = {
  id: string;
  label: string;
  labelIsCustom: boolean;
  cwd: string;
  type?: 'terminal' | 'star-command' | 'crew' | 'file' | 'image' | 'images' | 'settings';
  avatarVariant?: string;
  splitRoot: PaneNode;
  // Worktree group fields
  groupId?: string;
  groupRole?: 'parent' | 'worktree';
  worktreeBranch?: string;
  worktreePath?: string;
};
```

- [ ] **Step 2: Add IPC channels**

In `src/shared/ipc-channels.ts`, add before the closing `} as const`:

```ts
  WORKTREE_CREATE: 'worktree:create',
  WORKTREE_REMOVE: 'worktree:remove',
```

- [ ] **Step 3: Add IPC payload types**

In `src/shared/ipc-api.ts`, add at the end of the file:

```ts
export type WorktreeCreateRequest = {
  repoPath: string;
};

export type WorktreeCreateResponse = {
  worktreePath: string;
  branchName: string;
};

export type WorktreeRemoveRequest = {
  worktreePath: string;
};
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (new fields are all optional, new types are unused but valid)

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/shared/ipc-channels.ts src/shared/ipc-api.ts
git commit -m "feat(worktree): add Tab group fields and IPC channel definitions"
```

---

### Task 2: Create WorktreeService

**Files:**
- Create: `src/main/worktree-service.ts`

- [ ] **Step 1: Create the worktree service**

Create `src/main/worktree-service.ts`:

```ts
import { simpleGit } from 'simple-git';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { createLogger } from './logger';

const log = createLogger('worktree');

function getHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
}

function getRepoName(repoPath: string): string {
  const parts = repoPath.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || 'repo';
}

export class WorktreeService {
  private getWorktreeBase(repoName: string): string {
    return join(getHomeDir(), '.fleet', 'worktrees', repoName);
  }

  async create(repoPath: string): Promise<{ worktreePath: string; branchName: string }> {
    const git = simpleGit({ baseDir: repoPath });
    const repoName = getRepoName(repoPath);
    const base = this.getWorktreeBase(repoName);
    await mkdir(base, { recursive: true });

    // Find next available worktree number
    const existing = await this.list(repoPath);
    const existingNames = new Set(existing.map((w) => w.branch));
    let n = 1;
    let branchName: string;
    do {
      branchName = `${repoName}-worktree-${n}`;
      n++;
    } while (existingNames.has(branchName));

    const worktreePath = join(base, branchName);
    log.info('creating worktree', { repoPath, worktreePath, branchName });

    await git.raw(['worktree', 'add', worktreePath, '-b', branchName]);

    return { worktreePath, branchName };
  }

  async remove(worktreePath: string): Promise<void> {
    // Find the main repo by navigating from worktree's .git file
    const git = simpleGit({ baseDir: worktreePath });
    const topLevel = (await git.raw(['rev-parse', '--show-toplevel'])).trim();

    // The main repo is referenced in the worktree's gitdir
    // Use git worktree remove from the worktree itself
    const mainGit = simpleGit({ baseDir: topLevel });

    try {
      log.info('removing worktree', { worktreePath });
      await mainGit.raw(['worktree', 'remove', worktreePath]);
    } catch (err) {
      log.warn('worktree remove failed, trying --force', {
        worktreePath,
        error: err instanceof Error ? err.message : String(err)
      });
      await mainGit.raw(['worktree', 'remove', '--force', worktreePath]);
    }

    // Clean up the branch too
    try {
      const branchName = worktreePath.split('/').pop();
      if (branchName) {
        await mainGit.raw(['branch', '-D', branchName]);
      }
    } catch {
      // Branch may already be deleted or not exist
    }
  }

  async list(repoPath: string): Promise<Array<{ path: string; branch: string }>> {
    const git = simpleGit({ baseDir: repoPath });
    const raw = await git.raw(['worktree', 'list', '--porcelain']);
    const worktrees: Array<{ path: string; branch: string }> = [];
    let currentPath = '';

    for (const line of raw.split('\n')) {
      if (line.startsWith('worktree ')) {
        currentPath = line.slice('worktree '.length);
      } else if (line.startsWith('branch ')) {
        const branch = line.slice('branch refs/heads/'.length);
        worktrees.push({ path: currentPath, branch });
      }
    }

    return worktrees;
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/worktree-service.ts
git commit -m "feat(worktree): add WorktreeService for git worktree lifecycle"
```

---

### Task 3: Wire IPC handlers and preload bridge

**Files:**
- Modify: `src/main/ipc-handlers.ts:63-77` (add worktreeService parameter)
- Modify: `src/main/ipc-handlers.ts` (add handlers at end of function)
- Modify: `src/preload/index.ts` (add worktree namespace)
- Modify: `src/main/index.ts` (instantiate WorktreeService and pass to registerIpcHandlers)

- [ ] **Step 1: Add WorktreeService to ipc-handlers parameter list**

In `src/main/ipc-handlers.ts`, add the import at the top:

```ts
import type { WorktreeService } from './worktree-service';
```

Add to the existing imports from `../shared/ipc-api`:

```ts
import type {
  // ...existing imports...
  WorktreeCreateRequest,
  WorktreeRemoveRequest
} from '../shared/ipc-api';
```

Add `worktreeService: WorktreeService` as the last parameter of `registerIpcHandlers`.

- [ ] **Step 2: Add worktree IPC handlers**

At the end of the `registerIpcHandlers` function body (before the closing `}`), add:

```ts
  // Worktree handlers
  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_CREATE,
    async (_event, req: WorktreeCreateRequest) => {
      return worktreeService.create(req.repoPath);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_REMOVE,
    async (_event, req: WorktreeRemoveRequest) => {
      return worktreeService.remove(req.worktreePath);
    }
  );
```

- [ ] **Step 3: Instantiate WorktreeService in main/index.ts**

In `src/main/index.ts`, add the import:

```ts
import { WorktreeService } from './worktree-service';
```

Find where `registerIpcHandlers` is called and instantiate `WorktreeService` before it:

```ts
const worktreeService = new WorktreeService();
```

Pass `worktreeService` as the last argument to `registerIpcHandlers(...)`.

- [ ] **Step 4: Add preload bridge**

In `src/preload/index.ts`, add the imports:

```ts
import type {
  // ...existing imports...
  WorktreeCreateRequest,
  WorktreeCreateResponse,
  WorktreeRemoveRequest
} from '../shared/ipc-api';
```

Add a `worktree` namespace to the `fleetApi` object (after the `git` namespace):

```ts
  worktree: {
    create: async (req: WorktreeCreateRequest): Promise<WorktreeCreateResponse> =>
      typedInvoke(IPC_CHANNELS.WORKTREE_CREATE, req),
    remove: async (req: WorktreeRemoveRequest): Promise<void> =>
      typedInvoke(IPC_CHANNELS.WORKTREE_REMOVE, req),
  },
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc-handlers.ts src/main/index.ts src/preload/index.ts
git commit -m "feat(worktree): wire IPC handlers and preload bridge"
```

---

### Task 4: Add workspace store actions

**Files:**
- Modify: `src/renderer/src/store/workspace-store.ts`

- [ ] **Step 1: Add collapsedGroups state and group actions to the store type**

In `workspace-store.ts`, update the `WorkspaceStore` type to add after the `reorderTab` action:

```ts
  // Worktree group actions
  collapsedGroups: Set<string>;
  createWorktreeGroup: (tabId: string, worktreePath: string, branchName: string) => void;
  closeWorktreeTab: (tabId: string) => void;
  closeWorktreeGroup: (groupId: string) => void;
  toggleGroupCollapsed: (groupId: string) => void;
  reorderWithinGroup: (groupId: string, fromIndex: number, toIndex: number) => void;
  reorderGroup: (groupId: string, targetIndex: number) => void;
```

- [ ] **Step 2: Add initial state**

In the `create<WorkspaceStore>` call, add to the initial state:

```ts
  collapsedGroups: new Set(),
```

- [ ] **Step 3: Implement createWorktreeGroup action**

Add the action implementation:

```ts
  createWorktreeGroup: (tabId, worktreePath, branchName) => {
    const leaf = createLeaf(worktreePath);
    const groupId = generateId();

    set((state) => {
      const tabs = state.workspace.tabs.map((t) => {
        if (t.id !== tabId) return t;
        // If tab already has a groupId, reuse it (adding another worktree to existing group)
        return t.groupId
          ? t
          : { ...t, groupId, groupRole: 'parent' as const };
      });

      const parentTab = tabs.find((t) => t.id === tabId);
      const effectiveGroupId = parentTab?.groupId ?? groupId;

      // Re-apply groupId if parent already had one
      const finalTabs = parentTab?.groupId !== groupId
        ? tabs.map((t) => t.id === tabId ? { ...t, groupId: effectiveGroupId } : t)
        : tabs;

      const worktreeTab: Tab = {
        id: generateId(),
        label: branchName,
        labelIsCustom: true,
        cwd: worktreePath,
        splitRoot: leaf,
        groupId: effectiveGroupId,
        groupRole: 'worktree',
        worktreeBranch: branchName,
        worktreePath,
      };

      // Insert worktree tab right after the last tab in this group
      const parentIdx = finalTabs.findIndex((t) => t.id === tabId);
      let insertIdx = parentIdx + 1;
      while (insertIdx < finalTabs.length && finalTabs[insertIdx].groupId === effectiveGroupId) {
        insertIdx++;
      }
      const newTabs = [...finalTabs];
      newTabs.splice(insertIdx, 0, worktreeTab);

      // Expand the group if it was collapsed
      const newCollapsed = new Set(state.collapsedGroups);
      newCollapsed.delete(effectiveGroupId);

      return {
        workspace: { ...state.workspace, tabs: newTabs },
        activeTabId: worktreeTab.id,
        activePaneId: leaf.id,
        collapsedGroups: newCollapsed,
        isDirty: true,
      };
    });
  },
```

- [ ] **Step 4: Implement closeWorktreeTab action**

```ts
  closeWorktreeTab: (tabId) => {
    set((state) => {
      const tab = state.workspace.tabs.find((t) => t.id === tabId);
      if (!tab || tab.groupRole !== 'worktree') return state;

      const groupId = tab.groupId;
      let tabs = state.workspace.tabs.filter((t) => t.id !== tabId);

      // Check if this was the last worktree in the group
      if (groupId) {
        const remainingWorktrees = tabs.filter(
          (t) => t.groupId === groupId && t.groupRole === 'worktree'
        );
        if (remainingWorktrees.length === 0) {
          // Dissolve group: clear group fields from parent
          tabs = tabs.map((t) =>
            t.groupId === groupId
              ? { ...t, groupId: undefined, groupRole: undefined }
              : t
          );
        }
      }

      const tabIndex = state.workspace.tabs.findIndex((t) => t.id === tabId);
      const nextTab = tabs.length > 0 ? tabs[Math.min(tabIndex, tabs.length - 1)] : null;

      return {
        workspace: { ...state.workspace, tabs },
        activeTabId: nextTab?.id ?? null,
        activePaneId: nextTab ? (collectPaneIds(nextTab.splitRoot)[0] ?? null) : null,
        isDirty: true,
      };
    });
  },
```

- [ ] **Step 5: Implement closeWorktreeGroup action**

```ts
  closeWorktreeGroup: (groupId) => {
    set((state) => {
      const groupTabs = state.workspace.tabs.filter((t) => t.groupId === groupId);
      const tabs = state.workspace.tabs.filter((t) => t.groupId !== groupId);
      const firstNonGroupIdx = state.workspace.tabs.findIndex((t) => t.groupId !== groupId);
      const nextTab = tabs.length > 0 ? tabs[Math.max(0, firstNonGroupIdx)] : null;

      // Clean up collapsed state
      const newCollapsed = new Set(state.collapsedGroups);
      newCollapsed.delete(groupId);

      return {
        workspace: { ...state.workspace, tabs },
        activeTabId: nextTab?.id ?? null,
        activePaneId: nextTab ? (collectPaneIds(nextTab.splitRoot)[0] ?? null) : null,
        collapsedGroups: newCollapsed,
        isDirty: true,
      };
    });

    // Return the group tabs so the caller can clean up worktrees
    return get().workspace.tabs; // Note: this returns the AFTER state
  },
```

- [ ] **Step 6: Implement toggleGroupCollapsed action**

```ts
  toggleGroupCollapsed: (groupId) => {
    set((state) => {
      const newCollapsed = new Set(state.collapsedGroups);
      if (newCollapsed.has(groupId)) {
        newCollapsed.delete(groupId);
      } else {
        newCollapsed.add(groupId);
      }
      return { collapsedGroups: newCollapsed, isDirty: true };
    });
  },
```

- [ ] **Step 7: Implement reorderWithinGroup action**

```ts
  reorderWithinGroup: (groupId, fromIndex, toIndex) => {
    set((state) => {
      const tabs = [...state.workspace.tabs];
      // Get indices of tabs in this group
      const groupIndices = tabs
        .map((t, i) => (t.groupId === groupId ? i : -1))
        .filter((i) => i !== -1);

      if (fromIndex < 0 || fromIndex >= groupIndices.length) return state;
      if (toIndex < 0 || toIndex >= groupIndices.length) return state;
      if (fromIndex === toIndex) return state;

      const realFrom = groupIndices[fromIndex];
      const realTo = groupIndices[toIndex];
      const [moved] = tabs.splice(realFrom, 1);
      const adjustedTo = realFrom < realTo ? realTo - 1 : realTo;
      tabs.splice(adjustedTo, 0, moved);

      return { workspace: { ...state.workspace, tabs }, isDirty: true };
    });
  },
```

- [ ] **Step 8: Implement reorderGroup action**

```ts
  reorderGroup: (groupId, targetIndex) => {
    set((state) => {
      const tabs = [...state.workspace.tabs];
      // Extract all tabs in this group
      const groupTabs = tabs.filter((t) => t.groupId === groupId);
      const otherTabs = tabs.filter((t) => t.groupId !== groupId);

      if (groupTabs.length === 0) return state;

      // Clamp target index
      const clampedTarget = Math.max(0, Math.min(targetIndex, otherTabs.length));

      // Insert group at target position
      const newTabs = [...otherTabs];
      newTabs.splice(clampedTarget, 0, ...groupTabs);

      return { workspace: { ...state.workspace, tabs: newTabs }, isDirty: true };
    });
  },
```

- [ ] **Step 9: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/renderer/src/store/workspace-store.ts
git commit -m "feat(worktree): add workspace store group actions and collapsed state"
```

---

### Task 5: Add "Create Worktree" to TabItem context menu

**Files:**
- Modify: `src/renderer/src/components/TabItem.tsx`

- [ ] **Step 1: Add new props to TabItemProps**

In `TabItem.tsx`, add to the `TabItemProps` type:

```ts
  /** Called when user selects "Create Worktree" from context menu */
  onCreateWorktree?: () => void;
  /** True if this tab is a worktree child (hides "Create Worktree" option) */
  isWorktreeChild?: boolean;
  /** True if this tab is a parent with worktree children */
  isWorktreeParent?: boolean;
  /** Branch name to show as subtitle for worktree tabs */
  worktreeBranch?: string;
  /** Indentation level (0 = normal, 1 = inside a group) */
  indentLevel?: number;
```

- [ ] **Step 2: Accept new props in component**

Update the `TabItem` function signature destructuring to include the new props:

```ts
  onCreateWorktree,
  isWorktreeChild,
  isWorktreeParent,
  worktreeBranch,
  indentLevel = 0,
```

- [ ] **Step 3: Add indentation and accent bar**

Update the outer `div` className to add left padding based on `indentLevel`:

Replace the outer div's `className` wrapping to add conditional indentation:

```ts
          className={`
            group flex items-center gap-2 px-3 py-1.5 cursor-pointer rounded-md text-sm relative min-h-[44px] transition-colors
            ${indentLevel > 0 ? 'ml-4 border-l-2 border-l-teal-500/30' : ''}
            ${
              isActive
                ? `bg-neutral-700 text-white ${indentLevel > 0 ? '' : `border-l-2 ${activeBorderColor}`}`
                : `text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 ${indentLevel > 0 ? '' : 'border-l-2 border-transparent'}`
            }
          `}
```

- [ ] **Step 4: Show branch name as subtitle for worktree tabs**

In the subtitle section (the `<div className="truncate text-xs leading-tight text-neutral-500">` area), update to show branch name when available:

```ts
              <div className="truncate text-xs leading-tight text-neutral-500">
                {worktreeBranch ? (
                  <span className="text-teal-400/60">{worktreeBranch}</span>
                ) : freshness ? (
                  <span className={activity?.state === 'needs_me' ? 'text-amber-400' : ''}>
                    {freshness}
                  </span>
                ) : (
                  shortenPath(cwd)
                )}
              </div>
```

- [ ] **Step 5: Add "Create Worktree" context menu item**

In the `ContextMenu.Content`, add before the separator (before `<ContextMenu.Separator>`):

```ts
          {onCreateWorktree && !isWorktreeChild && (
            <>
              <ContextMenu.Separator className="my-1 h-px bg-neutral-700" />
              <ContextMenu.Item
                className="px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-neutral-700 hover:bg-neutral-700"
                onSelect={onCreateWorktree}
              >
                Create Worktree
              </ContextMenu.Item>
            </>
          )}
```

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/TabItem.tsx
git commit -m "feat(worktree): add Create Worktree context menu and group visual styling to TabItem"
```

---

### Task 6: Update Sidebar with group headers, grouping logic, and worktree creation flow

**Files:**
- Modify: `src/renderer/src/components/Sidebar.tsx`

- [ ] **Step 1: Add imports and group helper**

At the top of `Sidebar.tsx`, add the import for `ChevronRight`:

```ts
import { Settings, Terminal, ImageIcon, ChevronRight } from 'lucide-react';
```

Add a `GroupHeader` component before the `Sidebar` function:

```ts
function GroupHeader({
  label,
  tabCount,
  isCollapsed,
  onToggle,
  onDragStart,
  onDragOver,
  onDrop,
  isDragOver,
}: {
  label: string;
  tabCount: number;
  isCollapsed: boolean;
  onToggle: () => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  isDragOver: 'above' | 'below' | null;
}): React.JSX.Element {
  return (
    <div
      className="flex items-center gap-1.5 px-2 py-1 cursor-pointer rounded-md text-xs text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800/50 transition-colors relative select-none"
      onClick={onToggle}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', 'group');
        onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        onDragOver(e);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onDrop();
      }}
    >
      {isDragOver === 'above' && (
        <div className="absolute top-0 left-1 right-1 h-0.5 bg-blue-500 rounded-full -translate-y-0.5" />
      )}
      {isDragOver === 'below' && (
        <div className="absolute bottom-0 left-1 right-1 h-0.5 bg-blue-500 rounded-full translate-y-0.5" />
      )}
      <ChevronRight
        size={12}
        className={`transition-transform flex-shrink-0 ${isCollapsed ? '' : 'rotate-90'}`}
      />
      <span className="truncate font-medium">{label}</span>
      {isCollapsed && (
        <span className="ml-auto text-[10px] text-neutral-600">{tabCount} tabs</span>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add worktree store actions to useWorkspaceStore selector**

In the `Sidebar` component, update the `useWorkspaceStore` selector to include:

```ts
  const {
    workspace,
    activeTabId,
    activePaneId,
    setActiveTab,
    closeTab,
    renameTab,
    resetTabLabel,
    addTab,
    reorderTab,
    renameWorkspace,
    isDirty,
    markClean,
    collapsedGroups,
    toggleGroupCollapsed,
    createWorktreeGroup,
    closeWorktreeTab,
    closeWorktreeGroup,
    reorderWithinGroup,
    reorderGroup,
  } = useWorkspaceStore(
    useShallow((s) => ({
      workspace: s.workspace,
      activeTabId: s.activeTabId,
      activePaneId: s.activePaneId,
      setActiveTab: s.setActiveTab,
      closeTab: s.closeTab,
      renameTab: s.renameTab,
      resetTabLabel: s.resetTabLabel,
      addTab: s.addTab,
      reorderTab: s.reorderTab,
      renameWorkspace: s.renameWorkspace,
      isDirty: s.isDirty,
      markClean: s.markClean,
      collapsedGroups: s.collapsedGroups,
      toggleGroupCollapsed: s.toggleGroupCollapsed,
      createWorktreeGroup: s.createWorktreeGroup,
      closeWorktreeTab: s.closeWorktreeTab,
      closeWorktreeGroup: s.closeWorktreeGroup,
      reorderWithinGroup: s.reorderWithinGroup,
      reorderGroup: s.reorderGroup,
    }))
  );
```

- [ ] **Step 3: Add worktree creation handler**

Add inside the `Sidebar` component, after the drag handlers:

```ts
  // --- Worktree creation ---
  const handleCreateWorktree = useCallback(
    async (tabId: string, cwd: string) => {
      try {
        const result = await window.fleet.worktree.create({ repoPath: cwd });
        createWorktreeGroup(tabId, result.worktreePath, result.branchName);
      } catch (err) {
        // TODO: show toast notification
        console.error('Failed to create worktree:', err);
      }
    },
    [createWorktreeGroup]
  );

  // Track which tabs are in git repos (for showing "Create Worktree" in context menu)
  const [gitRepoTabs, setGitRepoTabs] = useState<Set<string>>(new Set());

  useEffect(() => {
    const checkGitRepos = async (): Promise<void> => {
      const newSet = new Set<string>();
      for (const tab of workspace.tabs) {
        if (tab.type && tab.type !== 'terminal') continue;
        try {
          const result = await window.fleet.git.isRepo(tab.cwd);
          if (result.isRepo) newSet.add(tab.id);
        } catch {
          // ignore
        }
      }
      setGitRepoTabs(newSet);
    };
    void checkGitRepos();
  }, [workspace.tabs.length]);
```

- [ ] **Step 4: Add worktree group close confirmation state**

Add alongside the existing `fileCloseConfirm` state:

```ts
  const [worktreeGroupCloseConfirm, setWorktreeGroupCloseConfirm] = useState<{
    groupId: string;
    tabCount: number;
  } | null>(null);
```

- [ ] **Step 5: Update handleCloseTab for worktree tabs**

Update `handleCloseTab` to handle worktree parent tabs with confirmation:

```ts
  const handleCloseTab = useCallback(
    (tabId: string) => {
      const tab = workspace.tabs.find((t) => t.id === tabId);
      if (!tab) return;

      // Parent tab with worktree children: confirm before closing entire group
      if (tab.groupRole === 'parent' && tab.groupId) {
        const groupTabs = workspace.tabs.filter((t) => t.groupId === tab.groupId);
        if (groupTabs.length > 1) {
          setWorktreeGroupCloseConfirm({ groupId: tab.groupId, tabCount: groupTabs.length });
          return;
        }
      }

      // Worktree child tab: clean up worktree on disk
      if (tab.groupRole === 'worktree' && tab.worktreePath) {
        void window.fleet.worktree.remove({ worktreePath: tab.worktreePath });
        closeWorktreeTab(tabId);
        return;
      }

      // File tabs: check for dirty panes before closing
      if (tab.type === 'file') {
        const dirtyPaneId = getFirstDirtyPaneId(tab);
        if (dirtyPaneId) {
          const leaf = getFirstLeaf(tab);
          const filename = leaf?.filePath?.split('/').pop() ?? tab.label;
          setFileCloseConfirm({ tabId, label: filename, paneId: dirtyPaneId });
          return;
        }
      }
      doCloseTab(tabId);
    },
    [workspace.tabs, doCloseTab, closeWorktreeTab]
  );
```

- [ ] **Step 6: Update tab rendering to support groups**

Replace the regular tabs rendering block (the one that filters out star-command, crew, images, settings) with group-aware rendering. This is the section starting around line 865 with `{workspace.tabs.filter(...)`.

Replace it with:

```tsx
          {(() => {
            const regularTabs = workspace.tabs.filter(
              (t) =>
                t.type !== 'star-command' &&
                t.type !== 'crew' &&
                t.type !== 'images' &&
                t.type !== 'settings'
            );

            // Build render items: group headers + tabs
            const rendered: React.ReactNode[] = [];
            const seenGroups = new Set<string>();

            for (const tab of regularTabs) {
              // If tab is in a group, render group header first (once)
              if (tab.groupId && !seenGroups.has(tab.groupId)) {
                seenGroups.add(tab.groupId);
                const groupTabs = regularTabs.filter((t) => t.groupId === tab.groupId);
                const parentTab = groupTabs.find((t) => t.groupRole === 'parent');
                const isCollapsed = collapsedGroups.has(tab.groupId);
                const groupId = tab.groupId;

                rendered.push(
                  <GroupHeader
                    key={`group-${groupId}`}
                    label={parentTab?.label ?? 'Worktree Group'}
                    tabCount={groupTabs.length}
                    isCollapsed={isCollapsed}
                    onToggle={() => toggleGroupCollapsed(groupId)}
                    onDragStart={() => handleDragStart(realIndex(groupTabs[0].id))}
                    onDragOver={(e) => handleDragOver(e, realIndex(groupTabs[0].id))}
                    onDrop={() => handleDrop()}
                    isDragOver={
                      dropTarget?.index === realIndex(groupTabs[0].id)
                        ? dropTarget.position
                        : null
                    }
                  />
                );

                // If collapsed, skip rendering group tabs
                if (isCollapsed) continue;
              }

              // Skip grouped tabs if their group is collapsed
              if (tab.groupId && collapsedGroups.has(tab.groupId)) continue;

              // Skip if we already rendered this as part of a group scan
              // (the for loop hits grouped tabs individually, but we handle them after header)
              if (tab.groupId && seenGroups.has(tab.groupId) && tab !== regularTabs.find(
                (t) => t.groupId === tab.groupId
              )) {
                // This tab is part of a group we've already started rendering
                // Only skip if we need to re-find it below
              }

              const paneIds = collectPaneIds(tab.splitRoot);
              const isFile = tab.type === 'file' || tab.type === 'image';
              const idx = realIndex(tab.id);

              let displayCwd: string;
              let drivingPaneId: string | undefined;
              if (isFile) {
                const leafs = collectPaneLeafs(tab.splitRoot);
                const filePath = leafs[0]?.filePath ?? '';
                displayCwd = filePath ? filePath.split('/').slice(0, -1).join('/') || '/' : '/';
              } else {
                drivingPaneId =
                  tab.id === activeTabId && activePaneId && paneIds.includes(activePaneId)
                    ? activePaneId
                    : paneIds[0];
                displayCwd = tab.cwd;
              }

              const isFileDirty =
                isFile && collectPaneLeafs(tab.splitRoot).some((l) => l.isDirty === true);
              const displayLabel = isFile && isFileDirty ? tab.label + ' *' : tab.label;

              let icon: React.ReactNode;
              if (isFile) {
                const leafs2 = collectPaneLeafs(tab.splitRoot);
                const fileBasename = leafs2[0]?.filePath?.split('/').pop() ?? tab.label;
                icon =
                  tab.type === 'image' ? <ImageIcon size={14} /> : getFileIcon(fileBasename, 14);
              } else {
                icon = <Terminal size={14} />;
              }

              rendered.push(
                <TabItem
                  key={tab.id}
                  id={tab.id}
                  label={displayLabel}
                  labelIsCustom={tab.labelIsCustom ?? false}
                  cwd={displayCwd}
                  drivingPaneId={drivingPaneId}
                  isActive={tab.id === activeTabId}
                  badge={getTabBadge(paneIds)}
                  icon={icon}
                  disableReset={isFile}
                  index={idx}
                  onDragStart={handleDragStart}
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                  isDragOver={dropTarget?.index === idx ? dropTarget.position : null}
                  indentLevel={tab.groupId ? 1 : 0}
                  worktreeBranch={tab.worktreeBranch}
                  isWorktreeChild={tab.groupRole === 'worktree'}
                  isWorktreeParent={tab.groupRole === 'parent'}
                  onCreateWorktree={
                    !isFile && gitRepoTabs.has(tab.id) && tab.groupRole !== 'worktree'
                      ? () => void handleCreateWorktree(tab.id, tab.cwd)
                      : undefined
                  }
                  onClick={() => {
                    setActiveTab(tab.id);
                    if (!isFile) {
                      for (const paneId of paneIds) {
                        useNotificationStore.getState().clearPane(paneId);
                        window.fleet.notifications.paneFocused({ paneId });
                      }
                    }
                  }}
                  onClose={() => handleCloseTab(tab.id)}
                  onRename={(newLabel) => renameTab(tab.id, newLabel)}
                  onResetLabel={(liveCwd) => resetTabLabel(tab.id, liveCwd)}
                />
              );
            }

            return rendered;
          })()}
```

- [ ] **Step 7: Add worktree group close confirmation dialog**

Add a second `Dialog.Root` after the existing file close confirmation dialog (before the closing `</div>` of the Sidebar component):

```tsx
      {/* Worktree group close confirmation dialog */}
      <Dialog.Root
        open={!!worktreeGroupCloseConfirm}
        onOpenChange={(open) => {
          if (!open) setWorktreeGroupCloseConfirm(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/60 z-50" />
          <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl p-5 w-80 text-sm">
            <Dialog.Title className="text-base font-semibold text-white mb-1">
              Close worktree group?
            </Dialog.Title>
            <Dialog.Description className="text-neutral-400 mb-5 text-xs">
              This will close all {worktreeGroupCloseConfirm?.tabCount ?? 0} tabs in this group and
              remove their worktrees from disk.
            </Dialog.Description>
            <div className="flex justify-end gap-2">
              <button
                className="px-3 py-1.5 text-xs text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded transition-colors"
                onClick={() => setWorktreeGroupCloseConfirm(null)}
              >
                Cancel
              </button>
              <button
                className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors font-medium"
                onClick={() => {
                  if (!worktreeGroupCloseConfirm) return;
                  const { groupId } = worktreeGroupCloseConfirm;
                  // Remove worktrees from disk
                  const groupTabs = workspace.tabs.filter((t) => t.groupId === groupId);
                  for (const tab of groupTabs) {
                    if (tab.worktreePath) {
                      void window.fleet.worktree.remove({ worktreePath: tab.worktreePath });
                    }
                  }
                  closeWorktreeGroup(groupId);
                  setWorktreeGroupCloseConfirm(null);
                }}
              >
                Close All
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
```

- [ ] **Step 8: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 9: Run lint**

Run: `npm run lint`
Expected: PASS (or only pre-existing warnings)

- [ ] **Step 10: Commit**

```bash
git add src/renderer/src/components/Sidebar.tsx
git commit -m "feat(worktree): add group headers, worktree creation flow, and close confirmation to Sidebar"
```

---

### Task 7: Persist collapsedGroups in layout store

**Files:**
- Modify: `src/shared/types.ts` (add collapsedGroups to Workspace)
- Modify: `src/renderer/src/store/workspace-store.ts` (serialize/deserialize)

- [ ] **Step 1: Add collapsedGroups to Workspace type**

In `src/shared/types.ts`, update the `Workspace` type:

```ts
export type Workspace = {
  id: string;
  label: string;
  tabs: Tab[];
  activeTabId?: string;
  activePaneId?: string;
  collapsedGroups?: string[];
};
```

- [ ] **Step 2: Serialize collapsedGroups on save**

In `Sidebar.tsx`, find the auto-save debounce block where `workspaceWithCwds` is built (around line 453). Update to include `collapsedGroups`:

```ts
      const state = useWorkspaceStore.getState();
      const workspaceWithCwds = {
        ...state.workspace,
        activeTabId: state.activeTabId ?? undefined,
        activePaneId: state.activePaneId ?? undefined,
        collapsedGroups: Array.from(state.collapsedGroups),
        tabs: state.workspace.tabs
          .filter((tab) => tab.type !== 'settings')
          .map((tab) => ({
            ...tab,
            splitRoot: injectLiveCwd(tab.splitRoot)
          }))
      };
```

Do the same for the `doSwitchWorkspace` and `commitNewWorkspace` save calls — add `collapsedGroups: Array.from(useWorkspaceStore.getState().collapsedGroups)` to the workspace object.

- [ ] **Step 3: Deserialize collapsedGroups on load**

In `workspace-store.ts`, update `loadWorkspace` to restore collapsedGroups:

In the `loadWorkspace` action, after migrating tabs, add:

```ts
    const restoredCollapsed = new Set(workspace.collapsedGroups ?? []);
```

And update the `set()` call to include:

```ts
    set({
      workspace: migrated,
      activeTabId: restoredTab?.id ?? null,
      activePaneId: restoredPane,
      collapsedGroups: restoredCollapsed,
      isDirty: false
    });
```

Do the same in `switchWorkspace`.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/renderer/src/store/workspace-store.ts src/renderer/src/components/Sidebar.tsx
git commit -m "feat(worktree): persist collapsedGroups in workspace layout"
```

---

### Task 8: Build and verify

**Files:** None (verification only)

- [ ] **Step 1: Run full typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: PASS (or only pre-existing warnings)

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: PASS — full electron-vite build succeeds

- [ ] **Step 4: Commit any lint fixes**

If lint required fixes:

```bash
git add -A
git commit -m "fix(worktree): address lint errors"
```
