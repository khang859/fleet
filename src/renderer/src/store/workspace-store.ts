import { create } from 'zustand';
import type { Workspace, Tab, PaneNode, PaneLeaf } from '../../../shared/types';
import { useCwdStore } from './cwd-store';
import { injectLiveCwd, getFirstPaneLiveCwd } from '../lib/workspace-utils';
import { createLogger } from '../logger';

const logTabs = createLogger('sidebar:tabs');
const logLayout = createLogger('layout:state');

const RECENT_FILES_KEY = 'fleet:recent-files';
const MAX_RECENT_FILES = 20;

function loadRecentFiles(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_FILES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function saveRecentFiles(files: string[]): void {
  try {
    localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(files));
  } catch {
    // ignore storage errors
  }
}

const RECENT_FOLDERS_KEY = 'fleet:recent-folders';
const MAX_RECENT_FOLDERS = 10;

function loadRecentFolders(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_FOLDERS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function saveRecentFolders(folders: string[]): void {
  try {
    localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(folders));
  } catch {
    // ignore storage errors
  }
}

function generateId(): string {
  return crypto.randomUUID();
}

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.ico'
]);

function getFileExt(filePath: string): string {
  const idx = filePath.lastIndexOf('.');
  return idx >= 0 ? filePath.slice(idx).toLowerCase() : '';
}

function createLeaf(cwd: string): PaneLeaf {
  return { type: 'leaf', id: generateId(), cwd };
}

/** Ensure workspace has a pinned Images tab; mutates and returns the workspace */
function ensureImagesTab(workspace: Workspace): Workspace {
  if (workspace.tabs.some((t) => t.type === 'images')) return workspace;
  const cwd = workspace.tabs[0]?.cwd ?? '/';
  const imagesTab: Tab = {
    id: generateId(),
    label: 'Images',
    labelIsCustom: true,
    cwd,
    type: 'images',
    splitRoot: createLeaf(cwd)
  };
  return { ...workspace, tabs: [imagesTab, ...workspace.tabs] };
}

/** Ensure workspace has a pinned Annotate tab; mutates and returns the workspace */
function ensureAnnotateTab(workspace: Workspace): Workspace {
  if (workspace.tabs.some((t) => t.type === 'annotate')) return workspace;
  const cwd = workspace.tabs[0]?.cwd ?? '/';
  const annotateTab: Tab = {
    id: generateId(),
    label: 'Annotate',
    labelIsCustom: true,
    cwd,
    type: 'annotate',
    splitRoot: createLeaf(cwd)
  };
  // Insert after images tab if present, otherwise prepend
  const imagesIdx = workspace.tabs.findIndex((t) => t.type === 'images');
  const insertIdx = imagesIdx >= 0 ? imagesIdx + 1 : 0;
  const tabs = [...workspace.tabs];
  tabs.splice(insertIdx, 0, annotateTab);
  return { ...workspace, tabs };
}

/** Extract basename from a path for auto-labeling tabs */
export function cwdBasename(cwd: string): string {
  const parts = cwd.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || 'Shell';
}

type ClosedTabRecord = {
  tab: Tab;
  index: number;
  closedAt: number;
  serializedPanes: Map<string, string>;
};

type WorkspaceStore = {
  workspace: Workspace;
  backgroundWorkspaces: Map<string, Workspace>;
  activeTabId: string | null;
  activePaneId: string | null;
  lastClosedTab: ClosedTabRecord | null;
  isDirty: boolean;
  recentFiles: string[];
  recentFolders: string[];

  // Tab actions
  addTab: (label: string | undefined, cwd: string) => string;
  addPiTab: (cwd: string) => string;
  closeTab: (tabId: string, serializedPanes?: Map<string, string>) => void;
  undoCloseTab: () => void;
  renameTab: (tabId: string, label: string) => void;
  resetTabLabel: (tabId: string, liveCwd?: string) => void;
  setActiveTab: (tabId: string) => void;
  reorderTab: (fromIndex: number, toIndex: number) => void;

  // Worktree group actions
  collapsedGroups: Set<string>;
  worktreeCloseConfirm: { tabId: string; label: string } | null;
  setWorktreeCloseConfirm: (confirm: { tabId: string; label: string } | null) => void;
  createWorktreeGroup: (tabId: string, worktreePath: string, branchName: string, repoPath: string) => void;
  closeWorktreeTab: (tabId: string) => void;
  closeWorktreeGroup: (groupId: string) => void;
  toggleGroupCollapsed: (groupId: string) => void;
  reorderWithinGroup: (groupId: string, fromIndex: number, toIndex: number) => void;
  reorderGroup: (groupId: string, targetIndex: number) => void;
  renameWorktreeGroup: (groupId: string, label: string) => void;

  // Pane actions
  splitPane: (paneId: string, direction: 'horizontal' | 'vertical') => string;
  closePane: (paneId: string) => void;
  setActivePane: (paneId: string) => void;
  resizeSplit: (splitNodePath: number[], ratio: number) => void;
  renamePane: (paneId: string, label: string) => void;
  resetPaneLabel: (paneId: string) => void;

  // Workspace actions
  loadWorkspace: (workspace: Workspace) => void;
  switchWorkspace: (ws: Workspace) => void;
  loadBackgroundWorkspaces: (workspaces: Workspace[]) => void;
  removeBackgroundWorkspace: (workspaceId: string) => void;
  setWorkspace: (workspace: Workspace) => void;
  renameWorkspace: (label: string) => void;
  markClean: () => void;

  ensureImagesTab: () => void;

  // File/image pane helpers
  openFile: (filePath: string) => string;
  openFileInTab: (
    files: Array<{ path: string; paneType: 'file' | 'image' | 'markdown'; label: string }>
  ) => void;
  addRecentFile: (filePath: string) => void;
  addRecentFolder: (folderPath: string) => void;
  setFileDirty: (paneId: string, isDirty: boolean) => void;
  setPaneDirty: (paneId: string, dirty: boolean) => void;

  // Helpers
  findTab: (tabId: string) => Tab | undefined;
  getAllPaneIds: () => string[];
};

function updateRatioAtPath(node: PaneNode, path: number[], ratio: number): PaneNode {
  if (node.type === 'leaf') return node;
  if (path.length === 0) {
    return { ...node, ratio };
  }
  const [head, ...rest] = path;
  return {
    ...node,
    children: [
      head === 0 ? updateRatioAtPath(node.children[0], rest, ratio) : node.children[0],
      head === 1 ? updateRatioAtPath(node.children[1], rest, ratio) : node.children[1]
    ]
  };
}

function updateLeafInTree(
  node: PaneNode,
  paneId: string,
  updater: (leaf: PaneLeaf) => PaneLeaf
): PaneNode {
  if (node.type === 'leaf') {
    return node.id === paneId ? updater(node) : node;
  }
  return {
    ...node,
    children: [
      updateLeafInTree(node.children[0], paneId, updater),
      updateLeafInTree(node.children[1], paneId, updater)
    ]
  };
}

function removePaneFromTree(node: PaneNode, paneId: string): PaneNode | null {
  if (node.type === 'leaf') {
    return node.id === paneId ? null : node;
  }

  const [left, right] = node.children;
  if (left.type === 'leaf' && left.id === paneId) return right;
  if (right.type === 'leaf' && right.id === paneId) return left;

  const newLeft = removePaneFromTree(left, paneId);
  const newRight = removePaneFromTree(right, paneId);

  if (!newLeft) return newRight;
  if (!newRight) return newLeft;

  return { ...node, children: [newLeft, newRight] };
}

function getFirstLeafCwd(node: PaneNode): string | undefined {
  if (node.type === 'leaf') return node.cwd;
  return getFirstLeafCwd(node.children[0]) ?? getFirstLeafCwd(node.children[1]);
}

export function collectPaneIds(node: PaneNode): string[] {
  if (node.type === 'leaf') return [node.id];
  return [...collectPaneIds(node.children[0]), ...collectPaneIds(node.children[1])];
}

/** Special/pinned tabs that should not be auto-selected when normal tabs are closed */
const SPECIAL_TAB_TYPES = new Set(['images', 'annotate', 'settings']);

function isNormalTab(tab: Tab): boolean {
  return !SPECIAL_TAB_TYPES.has(tab.type ?? '');
}

/** Pick the best next tab after closing one — prefer normal tabs, fall back to null */
function pickNextTab(tabs: Tab[], closedIndex: number): Tab | null {
  const normalTabs = tabs.filter(isNormalTab);
  if (normalTabs.length > 0) {
    return normalTabs[Math.min(closedIndex, normalTabs.length - 1)] ?? normalTabs[0];
  }
  return null;
}

export function collectPaneLeafs(node: PaneNode): PaneLeaf[] {
  if (node.type === 'leaf') return [node];
  return [...collectPaneLeafs(node.children[0]), ...collectPaneLeafs(node.children[1])];
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  workspace: { id: 'default', label: 'Default', tabs: [] },
  backgroundWorkspaces: new Map(),
  activeTabId: null,
  activePaneId: null,
  recentFiles: loadRecentFiles(),
  recentFolders: loadRecentFolders(),
  lastClosedTab: null,
  isDirty: false,
  collapsedGroups: new Set(),
  worktreeCloseConfirm: null,
  setWorktreeCloseConfirm: (confirm) => {
    set({ worktreeCloseConfirm: confirm });
  },

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

  addPiTab: (cwd) => {
    const leaf: PaneLeaf = { type: 'leaf', id: generateId(), cwd, paneType: 'pi' };
    const tab: Tab = {
      id: generateId(),
      label: 'Pi Agent',
      labelIsCustom: true,
      cwd,
      type: 'pi',
      splitRoot: leaf,
    };
    logTabs.debug('addPiTab', { tabId: tab.id, cwd, paneId: leaf.id });
    set((state) => ({
      workspace: {
        ...state.workspace,
        tabs: [...state.workspace.tabs, tab],
      },
      activeTabId: tab.id,
      activePaneId: leaf.id,
      isDirty: true,
    }));
    return leaf.id;
  },

  closeTab: (tabId, serializedPanes) => {
    logTabs.debug('closeTab', { tabId });
    set((state) => {
      const tabIndex = state.workspace.tabs.findIndex((t) => t.id === tabId);
      const rawTab = state.workspace.tabs[tabIndex];
      // Inject live CWDs so undo-close restores the PTY at the correct directory
      const closedTab = rawTab ? { ...rawTab, splitRoot: injectLiveCwd(rawTab.splitRoot) } : rawTab;
      const tabs = state.workspace.tabs.filter((t) => t.id !== tabId);
      const nextTab = pickNextTab(tabs, tabIndex);
      return {
        workspace: { ...state.workspace, tabs },
        activeTabId: nextTab?.id ?? null,
        activePaneId: nextTab ? (collectPaneIds(nextTab.splitRoot)[0] ?? null) : null,
        lastClosedTab: closedTab
          ? {
              tab: closedTab,
              index: tabIndex,
              closedAt: Date.now(),
              serializedPanes: serializedPanes ?? new Map<string, string>()
            }
          : null,
        isDirty: true
      };
    });
  },

  undoCloseTab: () => {
    logTabs.debug('undoCloseTab');
    set((state) => {
      if (!state.lastClosedTab) return state;
      const { tab, index } = state.lastClosedTab;
      const tabs = [...state.workspace.tabs];
      tabs.splice(Math.min(index, tabs.length), 0, tab);
      return {
        workspace: { ...state.workspace, tabs },
        activeTabId: tab.id,
        activePaneId: collectPaneIds(tab.splitRoot)[0] ?? null,
        lastClosedTab: null,
        isDirty: true
      };
    });
  },

  renameTab: (tabId, label) => {
    logTabs.debug('renameTab', { tabId, label });
    set((state) => ({
      workspace: {
        ...state.workspace,
        tabs: state.workspace.tabs.map((t) =>
          t.id === tabId ? { ...t, label, labelIsCustom: true } : t
        )
      },
      isDirty: true
    }));
  },

  resetTabLabel: (tabId, liveCwd) => {
    set((state) => ({
      workspace: {
        ...state.workspace,
        tabs: state.workspace.tabs.map((t) =>
          t.id === tabId ? { ...t, label: cwdBasename(liveCwd ?? t.cwd), labelIsCustom: false } : t
        )
      },
      isDirty: true
    }));
  },

  setActiveTab: (tabId) => {
    logTabs.debug('setActiveTab', { tabId });
    const tab = get().workspace.tabs.find((t) => t.id === tabId);
    if (tab) {
      const paneIds = collectPaneIds(tab.splitRoot);
      set({ activeTabId: tabId, activePaneId: paneIds[0] ?? null });
    }
  },

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
        workspace: { ...state.workspace, tabs },
        isDirty: true
      };
    });
  },

  createWorktreeGroup: (tabId, worktreePath, branchName, repoPath) => {
    const leaf = createLeaf(worktreePath);
    const newGroupId = generateId();

    set((state) => {
      const sourceTab = state.workspace.tabs.find((t) => t.id === tabId);
      if (!sourceTab) return state;

      // Reuse existing groupId if tab is already a parent, otherwise assign new one
      const effectiveGroupId = sourceTab.groupId ?? newGroupId;

      // Derive group label from the repo path (live CWD), not the stale tab cwd
      const groupLabel = sourceTab.groupLabel ?? cwdBasename(repoPath);

      const tabs = state.workspace.tabs.map((t) => {
        if (t.id !== tabId) return t;
        return t.groupId
          ? t
          : { ...t, groupId: effectiveGroupId, groupRole: 'parent' as const, groupLabel };
      });

      const worktreeTab: Tab = {
        id: generateId(),
        label: branchName,
        labelIsCustom: true,
        cwd: worktreePath,
        splitRoot: leaf,
        groupId: effectiveGroupId,
        groupRole: 'worktree',
        groupLabel,
        worktreeBranch: branchName,
        worktreePath,
      };

      // Insert worktree tab right after the last tab in this group
      const parentIdx = tabs.findIndex((t) => t.id === tabId);
      let insertIdx = parentIdx + 1;
      while (insertIdx < tabs.length && tabs[insertIdx].groupId === effectiveGroupId) {
        insertIdx++;
      }
      const newTabs = [...tabs];
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

  closeWorktreeTab: (tabId) => {
    set((state) => {
      const tab = state.workspace.tabs.find((t) => t.id === tabId);
      if (!tab?.groupId) return state;

      const tabIndex = state.workspace.tabs.findIndex((t) => t.id === tabId);
      // Inject live CWDs so undo-close restores the PTY at the correct directory
      const closedTab = { ...tab, splitRoot: injectLiveCwd(tab.splitRoot) };

      const groupId = tab.groupId;
      let tabs = state.workspace.tabs.filter((t) => t.id !== tabId);

      // Check if only one tab remains in the group — dissolve if so
      if (groupId) {
        const remainingGroupTabs = tabs.filter((t) => t.groupId === groupId);
        if (remainingGroupTabs.length <= 1) {
          tabs = tabs.map((t) =>
            t.groupId === groupId
              ? { ...t, groupId: undefined, groupRole: undefined }
              : t
          );
        }
      }

      const nextTab = pickNextTab(tabs, tabIndex);

      return {
        workspace: { ...state.workspace, tabs },
        activeTabId: nextTab?.id ?? null,
        activePaneId: nextTab ? (collectPaneIds(nextTab.splitRoot)[0] ?? null) : null,
        lastClosedTab: {
          tab: closedTab,
          index: tabIndex,
          closedAt: Date.now(),
          serializedPanes: new Map<string, string>(),
        },
        isDirty: true,
      };
    });
  },

  closeWorktreeGroup: (groupId) => {
    set((state) => {
      const tabs = state.workspace.tabs.filter((t) => t.groupId !== groupId);
      const nextTab = pickNextTab(tabs, 0);

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
  },

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

  reorderWithinGroup: (groupId, fromIndex, toIndex) => {
    set((state) => {
      const tabs = [...state.workspace.tabs];
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

  reorderGroup: (groupId, targetIndex) => {
    set((state) => {
      const tabs = [...state.workspace.tabs];
      const groupTabs = tabs.filter((t) => t.groupId === groupId);
      const otherTabs = tabs.filter((t) => t.groupId !== groupId);

      if (groupTabs.length === 0) return state;

      const clampedTarget = Math.max(0, Math.min(targetIndex, otherTabs.length));
      const newTabs = [...otherTabs];
      newTabs.splice(clampedTarget, 0, ...groupTabs);

      return { workspace: { ...state.workspace, tabs: newTabs }, isDirty: true };
    });
  },

  renameWorktreeGroup: (groupId, label) => {
    set((state) => ({
      workspace: {
        ...state.workspace,
        tabs: state.workspace.tabs.map((t) =>
          t.groupId === groupId ? { ...t, groupLabel: label } : t
        ),
      },
      isDirty: true,
    }));
  },

  splitPane: (paneId, direction) => {
    logLayout.debug('splitPane', { paneId, direction });
    const liveCwd = useCwdStore.getState().cwds.get(paneId);
    const tabCwd =
      get().workspace.tabs.find((t) => collectPaneIds(t.splitRoot).includes(paneId))?.cwd ?? '/';
    const newLeaf = createLeaf(liveCwd ?? tabCwd);

    function splitNode(node: PaneNode): PaneNode {
      if (node.type === 'leaf' && node.id === paneId) {
        return {
          type: 'split',
          direction,
          ratio: 0.5,
          children: [node, newLeaf]
        };
      }
      if (node.type === 'split') {
        return {
          ...node,
          children: [splitNode(node.children[0]), splitNode(node.children[1])]
        };
      }
      return node;
    }

    set((state) => ({
      workspace: {
        ...state.workspace,
        tabs: state.workspace.tabs.map((tab) => ({
          ...tab,
          splitRoot: splitNode(tab.splitRoot)
        }))
      },
      activePaneId: newLeaf.id,
      isDirty: true
    }));

    logLayout.debug('splitPane created', { newPaneId: newLeaf.id });
    return newLeaf.id;
  },

  closePane: (paneId) => {
    logLayout.debug('closePane', { paneId });
    set((state) => {
      const tabs = state.workspace.tabs
        .map((tab) => {
          const newRoot = removePaneFromTree(tab.splitRoot, paneId);
          if (!newRoot) return null;
          return { ...tab, splitRoot: newRoot };
        })
        .filter((t): t is Tab => t !== null);

      const currentTab = tabs.find((t) => t.id === state.activeTabId);
      const nextPaneId = currentTab ? (collectPaneIds(currentTab.splitRoot)[0] ?? null) : null;
      const fallbackTab = currentTab ?? pickNextTab(tabs, 0);

      return {
        workspace: { ...state.workspace, tabs },
        activeTabId: fallbackTab?.id ?? null,
        activePaneId: fallbackTab === currentTab ? nextPaneId : (fallbackTab ? (collectPaneIds(fallbackTab.splitRoot)[0] ?? null) : null),
        isDirty: true
      };
    });
  },

  setActivePane: (paneId) => set({ activePaneId: paneId }),

  resizeSplit: (splitNodePath, ratio) => {
    const clampedRatio = Math.max(0.15, Math.min(0.85, ratio));
    set((state) => {
      const activeTabId = state.activeTabId;
      if (!activeTabId) return state;
      return {
        workspace: {
          ...state.workspace,
          tabs: state.workspace.tabs.map((tab) => {
            if (tab.id !== activeTabId) return tab;
            return {
              ...tab,
              splitRoot: updateRatioAtPath(tab.splitRoot, splitNodePath, clampedRatio)
            };
          })
        }
      };
    });
  },

  renamePane: (paneId, label) => {
    set((state) => ({
      workspace: {
        ...state.workspace,
        tabs: state.workspace.tabs.map((tab) => ({
          ...tab,
          splitRoot: updateLeafInTree(tab.splitRoot, paneId, (leaf) => ({
            ...leaf,
            label,
            labelIsCustom: true
          }))
        }))
      },
      isDirty: true
    }));
  },

  resetPaneLabel: (paneId) => {
    set((state) => ({
      workspace: {
        ...state.workspace,
        tabs: state.workspace.tabs.map((tab) => ({
          ...tab,
          splitRoot: updateLeafInTree(tab.splitRoot, paneId, (leaf) => ({
            ...leaf,
            label: undefined,
            labelIsCustom: false
          }))
        }))
      },
      isDirty: true
    }));
  },

  loadWorkspace: (workspace) => {
    logLayout.debug('loadWorkspace', { id: workspace.id, label: workspace.label, tabCount: workspace.tabs.length });
    // Backward compat: old saved workspaces may lack labelIsCustom
    // Also sync tab cwd from first pane leaf (pane CWDs are always up-to-date)
    const migratedTabs = workspace.tabs.map((t) => {
      const firstLeafCwd = getFirstLeafCwd(t.splitRoot);
      return {
        ...t,
        labelIsCustom: t.labelIsCustom ?? false,
        cwd: firstLeafCwd ?? t.cwd,
      };
    });
    const migrated = ensureAnnotateTab(ensureImagesTab({ ...workspace, tabs: migratedTabs }));

    const restoredTab =
      (migrated.activeTabId
        ? migrated.tabs.find((t) => t.id === migrated.activeTabId)
        : undefined) ?? migrated.tabs.find((t) => t.type !== 'images' && t.type !== 'annotate') ?? migrated.tabs[0];

    const paneIds = restoredTab ? collectPaneIds(restoredTab.splitRoot) : [];
    const restoredPane =
      migrated.activePaneId && paneIds.includes(migrated.activePaneId)
        ? migrated.activePaneId
        : (paneIds[0] ?? null);

    const restoredCollapsed = new Set(migrated.collapsedGroups ?? []);

    set({
      workspace: migrated,
      activeTabId: restoredTab?.id ?? null,
      activePaneId: restoredPane,
      collapsedGroups: restoredCollapsed,
      isDirty: false
    });

    const folderCwd = workspace.tabs[0]?.cwd;
    if (folderCwd) {
      get().addRecentFolder(folderCwd);
    }
  },

  ensureImagesTab: () => {
    set((state) => {
      const updated = ensureImagesTab(state.workspace);
      if (updated === state.workspace) return state;
      return { workspace: updated, isDirty: true };
    });
  },

  switchWorkspace: (ws) => {
    logLayout.debug('switchWorkspace', { targetId: ws.id, targetLabel: ws.label });
    set((state) => {
      const target = state.backgroundWorkspaces.get(ws.id) ?? ws;
      const migratedTabs = target.tabs.map((t) => {
        const firstLeafCwd = getFirstLeafCwd(t.splitRoot);
        return {
          ...t,
          labelIsCustom: t.labelIsCustom ?? false,
          cwd: firstLeafCwd ?? t.cwd,
        };
      });
      const migrated = ensureAnnotateTab(ensureImagesTab({ ...target, tabs: migratedTabs }));

      const restoredTab =
        (migrated.activeTabId
          ? migrated.tabs.find((t) => t.id === migrated.activeTabId)
          : undefined) ?? migrated.tabs.find((t) => t.type !== 'images' && t.type !== 'annotate') ?? migrated.tabs[0];

      const paneIds = restoredTab ? collectPaneIds(restoredTab.splitRoot) : [];
      const restoredPane =
        migrated.activePaneId && paneIds.includes(migrated.activePaneId)
          ? migrated.activePaneId
          : (paneIds[0] ?? null);

      const restoredCollapsed = new Set(migrated.collapsedGroups ?? []);

      // Stash old workspace with current active tab/pane into background
      const newBackground = new Map(state.backgroundWorkspaces);
      newBackground.set(state.workspace.id, {
        ...state.workspace,
        activeTabId: state.activeTabId ?? undefined,
        activePaneId: state.activePaneId ?? undefined,
        tabs: state.workspace.tabs.map((tab) => {
          const liveCwd = getFirstPaneLiveCwd(tab.splitRoot);
          return {
            ...tab,
            cwd: liveCwd ?? tab.cwd,
            splitRoot: injectLiveCwd(tab.splitRoot),
          };
        })
      });
      newBackground.delete(migrated.id);

      return {
        workspace: migrated,
        backgroundWorkspaces: newBackground,
        activeTabId: restoredTab?.id ?? null,
        activePaneId: restoredPane,
        collapsedGroups: restoredCollapsed,
        isDirty: false
      };
    });

    const folderCwd = ws.tabs[0]?.cwd;
    if (folderCwd) {
      get().addRecentFolder(folderCwd);
    }
  },

  loadBackgroundWorkspaces: (workspaces) => {
    set((state) => {
      const newBackground = new Map(state.backgroundWorkspaces);
      for (const ws of workspaces) {
        // Don't overwrite already-loaded background workspaces or the active workspace
        if (!newBackground.has(ws.id) && ws.id !== state.workspace.id) {
          const migratedTabs = ws.tabs.map((t) => {
            const firstLeafCwd = getFirstLeafCwd(t.splitRoot);
            return {
              ...t,
              labelIsCustom: t.labelIsCustom ?? false,
              cwd: firstLeafCwd ?? t.cwd,
            };
          });
          newBackground.set(ws.id, { ...ws, tabs: migratedTabs });
        }
      }
      return { backgroundWorkspaces: newBackground };
    });
  },

  removeBackgroundWorkspace: (workspaceId) => {
    set((state) => {
      const newBackground = new Map(state.backgroundWorkspaces);
      newBackground.delete(workspaceId);
      return { backgroundWorkspaces: newBackground };
    });
  },

  setWorkspace: (workspace) => set({ workspace }),

  renameWorkspace: (label) => {
    set((state) => ({
      workspace: { ...state.workspace, label },
      isDirty: true
    }));
  },

  markClean: () => set({ isDirty: false }),

  setPaneDirty: (paneId, dirty) => {
    set((state) => ({
      workspace: {
        ...state.workspace,
        tabs: state.workspace.tabs.map((tab) => ({
          ...tab,
          splitRoot: updateLeafInTree(tab.splitRoot, paneId, (leaf) => ({
            ...leaf,
            isDirty: dirty
          }))
        }))
      }
    }));
  },

  openFile: (filePath) => {
    const ext = getFileExt(filePath);
    const paneType = IMAGE_EXTENSIONS.has(ext) ? 'image' : 'file';
    const tabType = paneType === 'image' ? 'image' : 'file';
    const fileName = filePath.split('/').pop() ?? filePath;
    const leaf: PaneLeaf = { type: 'leaf', id: generateId(), cwd: '/', paneType, filePath };
    const tab: Tab = {
      id: generateId(),
      label: fileName,
      labelIsCustom: true,
      cwd: '/',
      type: tabType,
      splitRoot: leaf
    };
    set((state) => ({
      workspace: { ...state.workspace, tabs: [...state.workspace.tabs, tab] },
      activeTabId: tab.id,
      activePaneId: leaf.id,
      isDirty: true
    }));
    get().addRecentFile(filePath);
    return leaf.id;
  },

  openFileInTab: (files) => {
    for (const file of files) {
      const state = get();
      // Dedup: check if file is already open in any tab
      const existingTab = state.workspace.tabs.find((tab) => {
        const findLeaf = (node: PaneNode): boolean => {
          if (node.type === 'leaf') return node.filePath === file.path;
          return findLeaf(node.children[0]) || findLeaf(node.children[1]);
        };
        return findLeaf(tab.splitRoot);
      });

      if (existingTab) {
        // Focus existing tab
        set({ activeTabId: existingTab.id, isDirty: true });
      } else {
        // Create new tab
        const leaf: PaneLeaf = {
          type: 'leaf',
          id: generateId(),
          cwd: '/',
          paneType: file.paneType,
          filePath: file.path
        };
        const tab: Tab = {
          id: generateId(),
          label: file.label,
          labelIsCustom: true,
          cwd: '/',
          type: file.paneType === 'image' ? 'image' : file.paneType === 'markdown' ? 'markdown' : 'file',
          splitRoot: leaf
        };
        set((s) => ({
          workspace: { ...s.workspace, tabs: [...s.workspace.tabs, tab] },
          activeTabId: tab.id,
          activePaneId: leaf.id,
          isDirty: true
        }));
      }
    }
  },

  addRecentFile: (filePath) => {
    set((state) => {
      const filtered = state.recentFiles.filter((f) => f !== filePath);
      const updated = [filePath, ...filtered].slice(0, MAX_RECENT_FILES);
      saveRecentFiles(updated);
      return { recentFiles: updated };
    });
  },

  addRecentFolder: (folderPath) => {
    set((state) => {
      const filtered = state.recentFolders.filter((f) => f !== folderPath);
      const updated = [folderPath, ...filtered].slice(0, MAX_RECENT_FOLDERS);
      saveRecentFolders(updated);
      return { recentFolders: updated };
    });
  },

  setFileDirty: (paneId, isDirty) => {
    set((state) => ({
      workspace: {
        ...state.workspace,
        tabs: state.workspace.tabs.map((tab) => ({
          ...tab,
          splitRoot: updateLeafInTree(tab.splitRoot, paneId, (leaf) => ({ ...leaf, isDirty }))
        }))
      }
    }));
  },

  findTab: (tabId) => get().workspace.tabs.find((t) => t.id === tabId),

  getAllPaneIds: () => {
    const state = get();
    const active = state.workspace.tabs.flatMap((tab) => collectPaneIds(tab.splitRoot));
    const background = Array.from(state.backgroundWorkspaces.values()).flatMap((ws) =>
      ws.tabs.flatMap((tab) => collectPaneIds(tab.splitRoot))
    );
    return [...active, ...background];
  }
}));

// Notify copilot of workspace changes + persist last active workspace for restart
let lastNotifiedWorkspaceId: string | null = null;
useWorkspaceStore.subscribe((state) => {
  const wsId = state.workspace.id;
  if (wsId !== lastNotifiedWorkspaceId) {
    lastNotifiedWorkspaceId = wsId;
    window.fleet.copilot?.notifyActiveWorkspace(wsId, state.workspace.label);
    try { localStorage.setItem('fleet:last-workspace-id', wsId); } catch { /* ignore */ }
  }
});
