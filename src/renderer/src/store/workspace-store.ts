import { create } from 'zustand';
import type { Workspace, Tab, PaneNode, PaneLeaf } from '../../../shared/types';

function generateId(): string {
  return crypto.randomUUID();
}

function createLeaf(cwd: string): PaneLeaf {
  return { type: 'leaf', id: generateId(), cwd };
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

  // Tab actions
  addTab: (label: string, cwd: string) => string;
  closeTab: (tabId: string, serializedPanes?: Map<string, string>) => void;
  undoCloseTab: () => void;
  renameTab: (tabId: string, label: string) => void;
  setActiveTab: (tabId: string) => void;

  // Pane actions
  splitPane: (paneId: string, direction: 'horizontal' | 'vertical') => string;
  closePane: (paneId: string) => void;
  setActivePane: (paneId: string) => void;
  resizeSplit: (splitNodePath: number[], ratio: number) => void;

  // Workspace actions
  loadWorkspace: (workspace: Workspace) => void;
  setWorkspace: (workspace: Workspace) => void;

  // Helpers
  findTab: (tabId: string) => Tab | undefined;
  getAllPaneIds: () => string[];
};

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

  addTab: (label, cwd) => {
    const leaf = createLeaf(cwd);
    const tab: Tab = { id: generateId(), label, cwd, splitRoot: leaf };
    set((state) => ({
      workspace: {
        ...state.workspace,
        tabs: [...state.workspace.tabs, tab],
      },
      activeTabId: tab.id,
      activePaneId: leaf.id,
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
    }));
  },

  setActiveTab: (tabId) => {
    const tab = get().workspace.tabs.find((t) => t.id === tabId);
    if (tab) {
      const paneIds = collectPaneIds(tab.splitRoot);
      set({ activeTabId: tabId, activePaneId: paneIds[0] ?? null });
    }
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
      };
    });
  },

  setActivePane: (paneId) => set({ activePaneId: paneId }),

  resizeSplit: (_splitNodePath, _ratio) => {
    // Resize is handled by updating ratio at the given path in the split tree
    // Implementation deferred to the PaneGrid drag handler which has the path context
  },

  loadWorkspace: (workspace) => {
    const firstTab = workspace.tabs[0];
    const firstPane = firstTab ? collectPaneIds(firstTab.splitRoot)[0] : null;
    set({
      workspace,
      activeTabId: firstTab?.id ?? null,
      activePaneId: firstPane ?? null,
    });
  },

  setWorkspace: (workspace) => set({ workspace }),

  findTab: (tabId) => get().workspace.tabs.find((t) => t.id === tabId),

  getAllPaneIds: () => {
    return get().workspace.tabs.flatMap((tab) => collectPaneIds(tab.splitRoot));
  },
}));
