import { create } from 'zustand';
import type { Workspace, Tab, PaneNode, PaneLeaf } from '../../../shared/types';

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

  // Tab actions
  addTab: (label: string | undefined, cwd: string) => string;
  /** Add a tab for a crew PTY whose paneId was pre-determined by the main process. */
  addCrewTab: (paneId: string, label: string, cwd: string, avatarVariant?: string) => void;
  closeTab: (tabId: string, serializedPanes?: Map<string, string>) => void;
  undoCloseTab: () => void;
  renameTab: (tabId: string, label: string) => void;
  resetTabLabel: (tabId: string, liveCwd?: string) => void;
  setActiveTab: (tabId: string) => void;
  reorderTab: (fromIndex: number, toIndex: number) => void;

  // Pane actions
  splitPane: (paneId: string, direction: 'horizontal' | 'vertical') => string;
  closePane: (paneId: string) => void;
  setActivePane: (paneId: string) => void;
  resizeSplit: (splitNodePath: number[], ratio: number) => void;

  // Workspace actions
  loadWorkspace: (workspace: Workspace) => void;
  switchWorkspace: (ws: Workspace) => void;
  loadBackgroundWorkspaces: (workspaces: Workspace[]) => void;
  setWorkspace: (workspace: Workspace) => void;
  renameWorkspace: (label: string) => void;
  markClean: () => void;

  // File/image pane helpers
  openFile: (filePath: string) => string;
  openFileInTab: (
    files: Array<{ path: string; paneType: 'file' | 'image'; label: string }>
  ) => void;
  addRecentFile: (filePath: string) => void;
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

export function collectPaneIds(node: PaneNode): string[] {
  if (node.type === 'leaf') return [node.id];
  return [...collectPaneIds(node.children[0]), ...collectPaneIds(node.children[1])];
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
  lastClosedTab: null,
  isDirty: false,

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

  addCrewTab: (paneId, label, cwd, avatarVariant) => {
    const leaf: PaneLeaf = { type: 'leaf', id: paneId, cwd };
    const tab: Tab = {
      id: generateId(),
      label,
      labelIsCustom: true,
      cwd,
      type: 'crew',
      avatarVariant,
      splitRoot: leaf
    };
    set((state) => ({
      workspace: {
        ...state.workspace,
        tabs: [...state.workspace.tabs, tab]
      },
      isDirty: true
    }));
  },

  closeTab: (tabId, serializedPanes) => {
    set((state) => {
      const tabIndex = state.workspace.tabs.findIndex((t) => t.id === tabId);
      const closedTab = state.workspace.tabs[tabIndex];
      const tabs = state.workspace.tabs.filter((t) => t.id !== tabId);
      const nextTab = tabs.length > 0 ? tabs[Math.min(tabIndex, tabs.length - 1)] : null;
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
    const tab = get().workspace.tabs.find((t) => t.id === tabId);
    if (tab) {
      const paneIds = collectPaneIds(tab.splitRoot);
      set({ activeTabId: tabId, activePaneId: paneIds[0] ?? null });
    }
  },

  reorderTab: (fromIndex, toIndex) => {
    set((state) => {
      const tabs = [...state.workspace.tabs];
      if (fromIndex < 0 || fromIndex >= tabs.length) return state;
      if (toIndex < 0 || toIndex >= tabs.length) return state;
      if (fromIndex === toIndex) return state;
      const [moved] = tabs.splice(fromIndex, 1);
      tabs.splice(toIndex, 0, moved);
      return {
        workspace: { ...state.workspace, tabs },
        isDirty: true
      };
    });
  },

  splitPane: (paneId, direction) => {
    const newLeaf = createLeaf(
      get().workspace.tabs.find((t) => collectPaneIds(t.splitRoot).includes(paneId))?.cwd ?? '/'
    );

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

    return newLeaf.id;
  },

  closePane: (paneId) => {
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

      return {
        workspace: { ...state.workspace, tabs },
        activeTabId: currentTab?.id ?? tabs[0]?.id ?? null,
        activePaneId: nextPaneId,
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

  loadWorkspace: (workspace) => {
    // Backward compat: old saved workspaces may lack labelIsCustom
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
          type: file.paneType === 'image' ? 'image' : 'file',
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
