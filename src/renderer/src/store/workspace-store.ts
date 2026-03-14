import { create } from 'zustand';
import type { Workspace, Tab, PaneNode, PaneLeaf } from '../../../shared/types';

function generateId(): string {
  return crypto.randomUUID();
}

function createLeaf(cwd: string): PaneLeaf {
  return { type: 'leaf', id: generateId(), cwd };
}

/** Extract basename from a path for auto-labeling tabs */
function cwdBasename(cwd: string): string {
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
  activeTabId: string | null;
  activePaneId: string | null;
  lastClosedTab: ClosedTabRecord | null;
  isDirty: boolean;

  // Tab actions
  addTab: (label: string | undefined, cwd: string) => string;
  closeTab: (tabId: string, serializedPanes?: Map<string, string>) => void;
  undoCloseTab: () => void;
  renameTab: (tabId: string, label: string) => void;
  setActiveTab: (tabId: string) => void;
  reorderTab: (fromIndex: number, toIndex: number) => void;

  // Pane actions
  splitPane: (paneId: string, direction: 'horizontal' | 'vertical') => string;
  closePane: (paneId: string) => void;
  setActivePane: (paneId: string) => void;
  resizeSplit: (splitNodePath: number[], ratio: number) => void;

  // Workspace actions
  loadWorkspace: (workspace: Workspace) => void;
  setWorkspace: (workspace: Workspace) => void;
  markClean: () => void;

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
      head === 1 ? updateRatioAtPath(node.children[1], rest, ratio) : node.children[1],
    ],
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

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  workspace: { id: 'default', label: 'Default', tabs: [] },
  activeTabId: null,
  activePaneId: null,
  lastClosedTab: null,
  isDirty: false,

  addTab: (label, cwd) => {
    const resolvedLabel = label || cwdBasename(cwd);
    const leaf = createLeaf(cwd);
    const tab: Tab = { id: generateId(), label: resolvedLabel, cwd, splitRoot: leaf };
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
    set((state) => {
      const tabIndex = state.workspace.tabs.findIndex((t) => t.id === tabId);
      const closedTab = state.workspace.tabs[tabIndex];
      const tabs = state.workspace.tabs.filter((t) => t.id !== tabId);
      const nextTab = tabs.length > 0 ? tabs[Math.min(tabIndex, tabs.length - 1)] : null;
      return {
        workspace: { ...state.workspace, tabs },
        activeTabId: nextTab?.id ?? null,
        activePaneId: nextTab ? collectPaneIds(nextTab.splitRoot)[0] ?? null : null,
        lastClosedTab: closedTab
          ? { tab: closedTab, index: tabIndex, closedAt: Date.now(), serializedPanes: serializedPanes ?? new Map() }
          : null,
        isDirty: true,
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
        isDirty: true,
      };
    });
  },

  renameTab: (tabId, label) => {
    set((state) => ({
      workspace: {
        ...state.workspace,
        tabs: state.workspace.tabs.map((t) =>
          t.id === tabId ? { ...t, label } : t,
        ),
      },
      isDirty: true,
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
        isDirty: true,
      };
    });
  },

  splitPane: (paneId, direction) => {
    const newLeaf = createLeaf(get().workspace.tabs.find((t) =>
      collectPaneIds(t.splitRoot).includes(paneId)
    )?.cwd ?? '/');

    function splitNode(node: PaneNode): PaneNode {
      if (node.type === 'leaf' && node.id === paneId) {
        return {
          type: 'split',
          direction,
          ratio: 0.5,
          children: [node, newLeaf],
        };
      }
      if (node.type === 'split') {
        return {
          ...node,
          children: [splitNode(node.children[0]), splitNode(node.children[1])],
        };
      }
      return node;
    }

    set((state) => ({
      workspace: {
        ...state.workspace,
        tabs: state.workspace.tabs.map((tab) => ({
          ...tab,
          splitRoot: splitNode(tab.splitRoot),
        })),
      },
      activePaneId: newLeaf.id,
      isDirty: true,
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
      const nextPaneId = currentTab
        ? collectPaneIds(currentTab.splitRoot)[0] ?? null
        : null;

      return {
        workspace: { ...state.workspace, tabs },
        activeTabId: currentTab?.id ?? tabs[0]?.id ?? null,
        activePaneId: nextPaneId,
        isDirty: true,
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
            return { ...tab, splitRoot: updateRatioAtPath(tab.splitRoot, splitNodePath, clampedRatio) };
          }),
        },
      };
    });
  },

  loadWorkspace: (workspace) => {
    const firstTab = workspace.tabs[0];
    const firstPane = firstTab ? collectPaneIds(firstTab.splitRoot)[0] : null;
    set({
      workspace,
      activeTabId: firstTab?.id ?? null,
      activePaneId: firstPane ?? null,
      isDirty: false,
    });
  },

  setWorkspace: (workspace) => set({ workspace }),

  markClean: () => set({ isDirty: false }),

  findTab: (tabId) => get().workspace.tabs.find((t) => t.id === tabId),

  getAllPaneIds: () => {
    return get().workspace.tabs.flatMap((tab) => collectPaneIds(tab.splitRoot));
  },
}));
